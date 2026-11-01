// `--member CONFIG.json`: a federation Member, what `startConfiguredFederation` (src/configured-runtime.ts) makes of a config of
// mode "member". What this host does not carry yet is refused at the start, never ignored: a root, primary/sync Spaces, entry
// replication and recovery stay on TypeScript hosts (R6).
use crate::{fail, stopping};
use phi_host::auth::{Algorithm, Proving, Signer};
use phi_host::boot::{BootGuard, External};
use phi_host::capability::Capabilities;
use phi_host::delegation::{authorize, DelegationOptions, DelegationVerifier};
use phi_host::gate::{default_group_roles, Gate, GateOptions, Netbird, Now, PeerInfo};
use phi_host::grants::GrantVerifier;
use phi_host::membership::{verify_federation_policy, MemberLifecycle};
use phi_host::register::{RegisterClient, SqliteRegister};
use phi_host::remote::{ControlClient, RemoteKeys};
use phi_host::run_member::{tasks_preparer, Pin, RunGates};
use phi_host::space_lifecycle::SpaceLifecycleService;
use phi_core::space::error;
use phi_host::tls::{private_file, TlsIdentity};
use phi_json::{parse, Json};
use phi_service::{Options, Service};
use phi_store::{system_random, SpaceHost, SqliteLedger, Store, Synchronous};
use phi_wire::{serve, Listen, ServeOptions};
use std::path::Path;
use std::rc::Rc;

const REFUSED: [&str; 7] = ["root", "syncSpaces", "entryReplication", "recovery", "recoveryAdmin", "registerSshTarget", "registerReadSocket"];

pub(crate) fn field<'a>(v: &'a Json, k: &str) -> &'a str { v.get(k).and_then(Json::as_str).unwrap_or_else(|| fail(format!("the config has no {k}"))) }

/// A config file of this mode; what this host does not carry is refused.
pub(crate) fn config_of(config: &str, mode: &str, other: &str, refused: &[&str]) -> Json {
	let bytes = private_file(Path::new(config)).unwrap_or_else(|e| fail(e));
	let c = parse(&String::from_utf8_lossy(&bytes)).unwrap_or_else(|e| fail(format!("{config}: {e}")));
	if field(&c, "mode") != mode {
		fail(other);
	}
	if let Some(k) = refused.iter().find(|k| c.get(k).is_some_and(|v| !v.is_null())) {
		fail(format!("{k} is not served by this host"));
	}
	c
}

/// `{host, port}` of a section.
pub(crate) fn address_of(v: &Json) -> (&str, u16) { (field(v, "host"), v.get("port").and_then(Json::as_f64).unwrap_or(0.0) as u16) }

/// A key file the config names, and its key id.
pub(crate) fn key_of(c: &Json, name: &str) -> (Signer, String) {
	let text = private_file(Path::new(field(c, name))).unwrap_or_else(|e| fail(e));
	let json = parse(&String::from_utf8_lossy(&text)).unwrap_or_else(|e| fail(e));
	Signer::from_key_file(&json).unwrap_or_else(|e| fail(e))
}

pub(crate) fn open_store(store: &str) -> Store {
	Store::open(SpaceHost::sqlite(SqliteLedger::open(Path::new(store), Synchronous::Full).unwrap_or_else(|e| fail(e))), system_random).unwrap_or_else(|e| fail(e))
}

/// The guard of the Space this host follows, refusing a host that changed.
pub(crate) fn boot_guard(c: &Json, host_id: &str, authority_id: &str, control_space: &str, control_host: &str, control_key: &str, now: &Now) -> Rc<BootGuard> {
	let register = c.get("registerTls").unwrap_or_else(|| fail("configure exactly one independent register endpoint"));
	let installed = SqliteRegister::open(Path::new(field(c, "installedRegisterFile"))).unwrap_or_else(|e| fail(e));
	let mut guard = BootGuard::new(host_id, authority_id, External::Tls(Box::new(register_client(register))), installed, Rc::clone(now), 60_000.0);
	guard.authority = Some((control_space.to_owned(), control_host.to_owned(), control_key.to_owned()));
	if guard.control_changed(control_space).unwrap_or_else(|e| fail(e)) {
		fail("the control host changed; this host follows no such change");
	}
	Rc::new(guard)
}

pub(crate) fn netbird(c: &Json, now: &Now) -> Rc<Netbird> {
	let management = c.get("management").unwrap_or_else(|| fail("the config has no management"));
	let token = String::from_utf8_lossy(&private_file(Path::new(field(management, "tokenFile"))).unwrap_or_else(|e| fail(e))).trim().to_owned();
	Netbird::new(field(management, "url"), &token, None, Rc::clone(now)).unwrap_or_else(|e| fail(e))
}

pub(crate) fn own_peer(own: Option<PeerInfo>, peer_id: &str) {
	if own.is_none_or(|p| p.id != peer_id) {
		fail("listen address does not belong to the provisioned NetBird peer");
	}
}

/// `groupRoles` of the config, or the deployment's default.
pub(crate) fn set_group_roles(o: &mut GateOptions, c: &Json) {
	if let Some(g) = c.get("groupRoles").and_then(Json::as_object) {
		o.group_roles = g.iter().map(|(k, v)| (k.to_owned(), v.as_array().map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect()))).collect();
	} else {
		o.group_roles = default_group_roles();
		o.group_roles.insert("space-hosts".into(), ["member", "host", "router"].map(String::from).to_vec());
	}
}

/// Serves `gate` until the host is stopped, then closes the store.
pub(crate) fn serve_gate(runtime: &tokio::runtime::Runtime, opened: Store, options: Options, gate: Rc<Gate>, peer_id: &str, (host, port): (&str, u16), name: &str) {
	let mut service = Service::new(opened, options);
	service.start_background().unwrap_or_else(|e| fail(e.message));
	service.store.drain().unwrap_or_else(|e| fail(e));
	let mut serving = ServeOptions::new(Listen::Tcp { host: host.to_owned(), port: 0 }, peer_id);
	serving.endpoints.clear();
	serving.gates.push((Listen::Tcp { host: host.to_owned(), port }, gate));
	let served = runtime.block_on(async {
		let stop = stopping::stop();
		serve(service, serving, |address: Vec<String>| println!("[phi-spaces] {name} ready on {}", address[0]), stop).await
	});
	match served {
		Ok(service) => service.store.close(),
		Err(e) => fail(e),
	}
}

pub(crate) fn clock() -> Now { Rc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after 1970").as_millis() as f64) }

pub(crate) fn register_client(r: &Json) -> RegisterClient {
	let identity = TlsIdentity { ca_file: field(r, "caFile").into(), cert_file: field(r, "certFile").into(), key_file: field(r, "keyFile").into() };
	RegisterClient::new(RegisterClient { identity, host: field(r, "host").into(), port: r.get("port").and_then(Json::as_f64).unwrap_or(0.0) as u16, server_name: r.get("serverName").and_then(Json::as_str).map(str::to_owned), timeout_ms: r.get("timeoutMs").and_then(Json::as_f64).unwrap_or(6000.0) as u64, batch_reads: r.get("batchReads") == Some(&Json::Bool(true)), unix_path: r.get("unixPath").and_then(Json::as_str).map(str::to_owned) }).unwrap_or_else(|e| fail(e))
}

pub fn run(config: &str, store: &str) {
	let c = config_of(config, "member", "this host runs as a member; a control host stays on TypeScript", &REFUSED);
	let now = clock();
	let (host_id, peer_id, authority_id) = (field(&c, "hostId"), field(&c, "peerId"), field(&c, "authorityId"));
	let (control_host, control_space) = (field(&c, "controlHostId"), field(&c, "controlSpaceId"));
	let control = c.get("control").unwrap_or_else(|| fail("the config has no control"));
	let control_key = field(control, "publicKey");
	if field(control, "algorithm") != "ed25519" && field(control, "algorithm") != "ecdsa-p256" {
		fail("invalid control algorithm");
	}
	let algorithm = Algorithm::parse(field(control, "algorithm")).expect("checked");
	let listen = c.get("listen").unwrap_or_else(|| fail("the config has no listen"));
	let (listen_host, listen_port) = address_of(listen);
	let guard = boot_guard(&c, host_id, authority_id, control_space, control_host, control_key, &now);
	let opened = open_store(store);
	let directory = netbird(&c, &now);
	let runtime = stopping::runtime();
	let address = c.get("control").and_then(|x| x.get("address")).unwrap_or_else(|| fail("the config has no control address"));
	let peers = tokio::task::LocalSet::new().block_on(&runtime, async {
		guard.admit_at_start(&opened.spaces()).await?;
		guard.refresh(vec![]).await;
		guard.assert_active().map_err(|e| e.message)?;
		directory.refresh().await?;
		Ok::<_, String>((directory.lookup(listen_host).await?, directory.lookup(field(address, "host")).await?))
	});
	let (own, control_peer) = peers.unwrap_or_else(|e| fail(e));
	own_peer(own, peer_id);
	let supervisor = control_peer.unwrap_or_else(|| fail("control peer unavailable in provisioned directory")).id;

	let mut options = Options::single_peer(peer_id);
	options.identity.clear();
	options.host_id = Some(host_id.to_owned());
	options.authority_id = authority_id.to_owned();
	options.primary_epoch = 1.0;
	let (signer, key_id) = key_of(&c, "keyFile");
	let client = Rc::new(ControlClient::new((field(address, "host").to_owned(), address_of(address).1), listen_host, peer_id, control_host, signer, &key_id));
	let keys = Rc::new(RemoteKeys::new(Rc::clone(&client), Rc::clone(&now)));

	let policy_keys = Rc::clone(&keys);
	let pin = Pin { issuer: "".into(), algorithm, public_key: control_key.to_owned() };
	let authority_of = authority_id.to_owned();
	// the signature of the policy is checked at each use; the supervisor's name comes with the token
	let policy: Rc<dyn Fn() -> (String, f64)> = Rc::new(move || {
		let token = policy_keys.policy.borrow().clone();
		let issuer = token.as_ref().and_then(|t| t.get("issuer")).and_then(Json::as_str).unwrap_or("").to_owned();
		let checked = token.and_then(|t| verify_federation_policy(&t, &authority_of, &Pin { issuer, ..pin.clone() }).ok());
		checked.map_or((String::new(), 0.0), |p| (authority_of.clone(), p.get("policyVersion").and_then(Json::as_f64).unwrap_or(0.0)))
	});
	let grants = GrantVerifier { authority_id: authority_id.to_owned(), issuer_host_id: control_host.to_owned(), public_key: control_key.to_owned(), algorithm, uncertainty_ms: 2000.0 };
	let verifier = DelegationVerifier::new(DelegationOptions { authority_id: authority_id.to_owned(), control_space_id: control_space.to_owned(), supervisor_peer_id: supervisor.clone(), supervisor: (algorithm, control_key.to_owned()), keys: Rc::clone(&keys) as _, grants, policy, rules: Rc::new(options.policy.clone()), uncertainty_ms: 2000.0 }).unwrap_or_else(|e| fail(e.message));
	let (checked, held) = (authorize(Rc::clone(&verifier), Rc::clone(&now)), Rc::clone(&keys));
	options.authorize = Some(Box::new(move |store, call, identity, conn| {
		if let Some(why) = held.policy_failed.borrow().clone() {
			return Err(error("PermissionError", why));
		}
		checked(store, call, identity, conn)
	}));
	options.guard = Some(Rc::clone(&guard) as _);

	let mut o = GateOptions::new(directory, Rc::clone(&now));
	set_group_roles(&mut o, &c);
	o.proving = Some((Proving::new(host_id), Rc::clone(&keys) as _));
	o.delegation = Some(verifier);
	let o_boot = Rc::clone(&guard);
	o.boot = Some(guard);
	o.remote_keys = Some(keys);
	if let Some(m) = c.get("membership").filter(|m| !m.is_null()) {
		let (signer, _) = key_of(&c, "keyFile");
		let check = o.boot.clone().expect("set above");
		let pin = Pin { issuer: supervisor.clone(), algorithm, public_key: control_key.to_owned() };
		o.lifecycle = Some(MemberLifecycle::new(field(m, "memberId"), field(m, "spaceId"), authority_id, peer_id, signer, pin, Box::new(move |_| check.assert_active())));
	}
	if let Some(k) = c.get("capabilities").filter(|k| !k.is_null()) {
		let names = |key: &str| k.get(key).and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect::<Vec<_>>());
		let (tools, models) = (names("tools"), names("models"));
		if tools.iter().chain(&models).any(|n| n.is_empty() || n.len() > 128) || host_id.len() > 128 {
			fail("invalid capability report");
		}
		o.capabilities = Some(Rc::new(Capabilities { host_id: host_id.to_owned(), tools, models, data_spaces: names("dataSpaces"), client: Some(Rc::clone(&client)) }));
	}
	let pin = Pin { issuer: supervisor.clone(), algorithm, public_key: control_key.to_owned() };
	let assert_host = || -> phi_host::run_member::AuthorityCheck {
		let check = o_boot.clone();
		Box::new(move |_| check.assert_active())
	};
	if c.get("runGates") == Some(&Json::Bool(true)) {
		let tasks: phi_host::run_member::RunPreparer = Box::new(tasks_preparer);
		o.run_gates = Some(RunGates { authority_id: authority_id.to_owned(), peer_id: peer_id.to_owned(), signer: key_of(&c, "keyFile").0, controller: pin.clone(), preparers: [("tasks".to_owned(), tasks)].into_iter().collect(), assert_authority: assert_host() });
	}
	if c.get("spaceLifecycle") == Some(&Json::Bool(true)) {
		o.spaces = Some(SpaceLifecycleService::new(host_id, authority_id, peer_id, key_of(&c, "keyFile").0, pin, assert_host()));
	}
	let gate = Gate::new(listen_host, o).unwrap_or_else(|e| fail(e));
	serve_gate(&runtime, opened, options, gate, peer_id, (listen_host, listen_port), "member");
}
