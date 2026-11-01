// `--control CONFIG.json`: a control host, what `startConfiguredFederation` makes of a config of mode "control". What this host does
// not carry yet is refused at the start, never ignored: a root, replication and recovery (R6b).
use crate::fail;
use crate::member::{clock, field, register_client};
use phi_host::auth::{Proving, Signer};
use phi_host::boot::{BootGuard, External};
use phi_host::capability::Capabilities;
use phi_host::control::{key_fingerprint, Control, Enrolling, SpaceKeys, Supervisor, CONTROL_SPACE};
use phi_host::control_host::ControlHost;
use phi_host::delegation::grants_only;
use phi_host::gate::{default_group_roles, Gate, GateOptions, Keys, Netbird};
use phi_host::grants::GrantVerifier;
use phi_host::register::SqliteRegister;
use phi_host::rotation::Rotating;
use phi_host::tls::private_file;
use phi_json::{parse, Json};
use phi_service::{Options, Service};
use phi_store::{system_random, SpaceHost, SqliteLedger, Store, Synchronous};
use phi_wire::{serve, Listen, ServeOptions};
use std::path::Path;
use std::rc::Rc;
use tokio::signal::unix::{signal, SignalKind};

const REFUSED: [&str; 10] = ["root", "syncSpaces", "entryReplication", "recovery", "recoveryAdmin", "registerSshTarget", "registerReadSocket", "membership", "runGates", "spaceLifecycle"];

pub fn run(config: &str, store: &str) {
	let bytes = private_file(Path::new(config)).unwrap_or_else(|e| fail(e));
	let c = parse(&String::from_utf8_lossy(&bytes)).unwrap_or_else(|e| fail(format!("{config}: {e}")));
	if field(&c, "mode") != "control" {
		fail("this host runs as a control host");
	}
	if let Some(k) = REFUSED.iter().find(|k| c.get(k).is_some_and(|v| !v.is_null())) {
		fail(format!("{k} is not served by this host"));
	}
	let (host_id, peer_id, authority_id, control_space) = (field(&c, "hostId"), field(&c, "peerId"), field(&c, "authorityId"), field(&c, "controlSpaceId"));
	if host_id != field(&c, "controlHostId") {
		fail("configured control host or space identity disagrees with provisioned state");
	}
	let now = clock();
	let opened = Store::open(SpaceHost::sqlite(SqliteLedger::open(Path::new(store), Synchronous::Full).unwrap_or_else(|e| fail(e))), system_random).unwrap_or_else(|e| fail(e));
	if opened.registry().and_then(|r| r.get("aliases")?.get(CONTROL_SPACE)?.as_str()) != Some(control_space) {
		fail("configured control host or space identity disagrees with provisioned state");
	}
	let control = c.get("control").unwrap_or_else(|| fail("the config has no control"));
	let control_key = field(control, "publicKey");
	let key_of = || {
		let text = private_file(Path::new(field(&c, "keyFile"))).unwrap_or_else(|e| fail(e));
		Signer::from_key_file(&parse(&String::from_utf8_lossy(&text)).unwrap_or_else(|e| fail(e))).unwrap_or_else(|e| fail(e))
	};
	let (signer, key_id) = key_of();
	if phi_host::run_member::algorithm_name(signer.algorithm()) != field(control, "algorithm") || key_fingerprint(control_key) != key_id {
		fail("provisioned control signer disagrees with installed authority");
	}
	let algorithm = signer.algorithm();
	let register = c.get("registerTls").unwrap_or_else(|| fail("configure exactly one independent register endpoint"));
	let client = register_client(register);
	let access = format!("access:{authority_id}");
	let installed = SqliteRegister::open(Path::new(field(&c, "installedRegisterFile"))).unwrap_or_else(|e| fail(e));
	let mut guard = BootGuard::new(host_id, authority_id, External::Tls(Box::new(register_client(register))), installed, Rc::clone(&now), 60_000.0);
	guard.authority = Some((control_space.to_owned(), host_id.to_owned(), control_key.to_owned()));
	if guard.control_changed(control_space).unwrap_or_else(|e| fail(e)) {
		fail("the control host changed; this host follows no such change");
	}
	let guard = Rc::new(guard);
	let management = c.get("management").unwrap_or_else(|| fail("the config has no management"));
	let token = String::from_utf8_lossy(&private_file(Path::new(field(management, "tokenFile"))).unwrap_or_else(|e| fail(e))).trim().to_owned();
	let directory = Netbird::new(field(management, "url"), &token, None, Rc::clone(&now)).unwrap_or_else(|e| fail(e));
	let listen = c.get("listen").unwrap_or_else(|| fail("the config has no listen"));
	let (listen_host, listen_port) = (field(listen, "host"), listen.get("port").and_then(Json::as_f64).unwrap_or(0.0) as u16);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap_or_else(|e| fail(e));
	let own = tokio::task::LocalSet::new().block_on(&runtime, async {
		guard.admit_at_start(&opened.spaces()).await?;
		guard.refresh(vec![]).await;
		guard.assert_active().map_err(|e| e.message)?;
		// A-only rights after a recovery stay with a host that carries recovery
		if client.get(&access).await.map_err(|e| e.to_string())?.get("value").is_some_and(|v| v.get("aOnlyAllowed") != Some(&Json::Bool(true))) {
			return Err("an access policy of a recovery is not served by this host".to_owned());
		}
		directory.refresh().await?;
		directory.lookup(listen_host).await
	});
	if own.unwrap_or_else(|e| fail(e)).is_none_or(|p| p.id != peer_id) {
		fail("listen address does not belong to the provisioned NetBird peer");
	}

	let mut options = Options::single_peer(peer_id);
	options.identity.clear();
	options.host_id = Some(host_id.to_owned());
	options.authority_id = authority_id.to_owned();
	let grants = GrantVerifier { authority_id: authority_id.to_owned(), issuer_host_id: host_id.to_owned(), public_key: control_key.to_owned(), algorithm, uncertainty_ms: 2000.0 };
	options.authorize = Some(grants_only(grants.clone(), Rc::new(options.policy.clone()), Rc::clone(&now)));
	options.guard = Some(Rc::clone(&guard) as _);

	let mut o = GateOptions::new(directory, Rc::clone(&now));
	if let Some(g) = c.get("groupRoles").and_then(Json::as_object) {
		o.group_roles = g.iter().map(|(k, v)| (k.to_owned(), v.as_array().map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect()))).collect();
	} else {
		o.group_roles = default_group_roles();
		o.group_roles.insert("space-hosts".into(), ["member", "host", "router"].map(String::from).to_vec());
	}
	let keys: Rc<dyn Keys> = Rc::new(SpaceKeys { now: Rc::clone(&now) });
	o.proving = Some((Proving::new(host_id), keys));
	o.enrolling = Some(Enrolling::new(Box::new(|_| ())));
	o.control = Some(Control { supervisor: Some(Supervisor { on_event: Box::new(|_| ()) }) });
	o.rotating = Some(Rotating::new(authority_id, host_id, signer, control_key));
	let capabilities = c.get("capabilities").filter(|k| !k.is_null());
	let hosts = capabilities.and_then(|k| k.get("hostBindings")).and_then(Json::as_object).map_or_else(Default::default, |b| b.iter().filter_map(|(k, v)| Some((k.to_owned(), v.as_str()?.to_owned()))).collect());
	o.control_host = Some(ControlHost { peer_id: peer_id.to_owned(), control_space: control_space.to_owned(), signer: key_of().0, grants, hosts, now: Rc::clone(&now) });
	if let Some(k) = capabilities {
		let names = |key: &str| k.get(key).and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect::<Vec<_>>());
		let mut spaces = names("dataSpaces");
		spaces.push(control_space.to_owned());
		o.capabilities = Some(Rc::new(Capabilities { host_id: host_id.to_owned(), tools: names("tools"), models: names("models"), data_spaces: spaces, client: None }));
	}
	o.boot = Some(guard);
	let gate = Gate::new(listen_host, o).unwrap_or_else(|e| fail(e));

	let mut service = Service::new(opened, options);
	service.start_background().unwrap_or_else(|e| fail(e.message));
	service.store.drain().unwrap_or_else(|e| fail(e));
	let mut serving = ServeOptions::new(Listen::Tcp { host: listen_host.to_owned(), port: 0 }, peer_id);
	serving.endpoints.clear();
	serving.gates.push((Listen::Tcp { host: listen_host.to_owned(), port: listen_port }, gate));
	let served = runtime.block_on(async {
		let mut term = signal(SignalKind::terminate()).unwrap_or_else(|e| fail(e));
		let mut int = signal(SignalKind::interrupt()).unwrap_or_else(|e| fail(e));
		let stop = async move {
			tokio::select! {
				_ = term.recv() => {}
				_ = int.recv() => {}
			}
		};
		serve(service, serving, |address: Vec<String>| println!("[phi-spaces] control ready on {}", address[0]), stop).await
	});
	match served {
		Ok(service) => service.store.close(),
		Err(e) => fail(e),
	}
}
