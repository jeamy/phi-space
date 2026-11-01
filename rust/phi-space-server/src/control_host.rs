// `--control CONFIG.json`: a control host, what `startConfiguredFederation` makes of a config of mode "control". What this host does
// not carry yet is refused at the start, never ignored: a root, replication and recovery (R6b).
use crate::{fail, stopping};
use crate::member::{address_of, boot_guard, clock, config_of, field, key_of, netbird, open_store, own_peer, register_client, serve_gate, set_group_roles};
use phi_host::auth::Proving;
use phi_host::capability::Capabilities;
use phi_host::control::{key_fingerprint, Control, Enrolling, Routing, SpaceKeys, Supervisor, CONTROL_SPACE};
use phi_host::control_host::ControlHost;
use phi_host::delegation::grants_only;
use phi_host::gate::{Gate, GateOptions, Keys};
use phi_host::grants::GrantVerifier;
use phi_host::rotation::Rotating;
use phi_json::Json;
use phi_service::Options;
use std::rc::Rc;

const REFUSED: [&str; 10] = ["root", "syncSpaces", "entryReplication", "recovery", "recoveryAdmin", "registerSshTarget", "registerReadSocket", "membership", "runGates", "spaceLifecycle"];

pub fn run(config: &str, store: &str) {
	let c = config_of(config, "control", "this host runs as a control host", &REFUSED);
	let (host_id, peer_id, authority_id, control_space) = (field(&c, "hostId"), field(&c, "peerId"), field(&c, "authorityId"), field(&c, "controlSpaceId"));
	if host_id != field(&c, "controlHostId") {
		fail("configured control host or space identity disagrees with provisioned state");
	}
	let now = clock();
	let opened = open_store(store);
	if opened.registry().and_then(|r| r.get("aliases")?.get(CONTROL_SPACE)?.as_str()) != Some(control_space) {
		fail("configured control host or space identity disagrees with provisioned state");
	}
	let control = c.get("control").unwrap_or_else(|| fail("the config has no control"));
	let control_key = field(control, "publicKey");
	let (signer, key_id) = key_of(&c, "keyFile");
	if signer.algorithm().name() != field(control, "algorithm") || key_fingerprint(control_key) != key_id {
		fail("provisioned control signer disagrees with installed authority");
	}
	let algorithm = signer.algorithm();
	let register = c.get("registerTls").unwrap_or_else(|| fail("configure exactly one independent register endpoint"));
	let client = register_client(register);
	let access = format!("access:{authority_id}");
	let guard = boot_guard(&c, host_id, authority_id, control_space, host_id, control_key, &now);
	let directory = netbird(&c, &now);
	let listen = c.get("listen").unwrap_or_else(|| fail("the config has no listen"));
	let (listen_host, listen_port) = address_of(listen);
	let runtime = stopping::runtime();
	let own = tokio::task::LocalSet::new().block_on(&runtime, async {
		guard.admit_at_start(&opened.spaces()).await?;
		guard.refresh(vec![]).await;
		guard.assert_active().map_err(|e| e.message)?;
		let policy = client.get(&access).await.map_err(|e| e.to_string())?.get("value").cloned();
		directory.refresh().await?;
		Ok::<_, String>((directory.lookup(listen_host).await?, policy))
	});
	let (own, access_policy) = own.unwrap_or_else(|e| fail(e));
	own_peer(own, peer_id);

	let mut options = Options::single_peer(peer_id);
	options.identity.clear();
	options.host_id = Some(host_id.to_owned());
	options.authority_id = authority_id.to_owned();
	let grants = GrantVerifier { authority_id: authority_id.to_owned(), issuer_host_id: host_id.to_owned(), public_key: control_key.to_owned(), algorithm, uncertainty_ms: 2000.0 };
	options.authorize = Some(grants_only(grants.clone(), Rc::new(options.policy.clone()), Rc::clone(&now)));
	options.guard = Some(Rc::clone(&guard) as _);

	let mut o = GateOptions::new(directory, Rc::clone(&now));
	set_group_roles(&mut o, &c);
	let keys: Rc<dyn Keys> = Rc::new(SpaceKeys { now: Rc::clone(&now) });
	o.proving = Some((Proving::new(host_id), keys));
	o.enrolling = Some(Enrolling::new(Box::new(|_| ())));
	o.control = Some(Control { supervisor: Some(Supervisor { on_event: Box::new(|_| ()), routing: Some(Routing { control_space: control_space.to_owned(), authority_id: authority_id.to_owned(), state: Default::default() }) }) });
	let mut rotating = Rotating::new(authority_id, host_id, signer, control_key);
	// configured-runtime's allowAOnly. A recovery writes the policy under the new authority before that authority runs,
	// so what stood at the start stands while this host runs. Without a policy TS asks the control Space's restore; a Space
	// under a restore does not open in this core at all.
	rotating.allow_a_only = access_policy.map(|p| p.get("authorityId").and_then(Json::as_str) == Some(authority_id) && p.get("aOnlyAllowed") == Some(&Json::Bool(true)));
	o.rotating = Some(rotating);
	let capabilities = c.get("capabilities").filter(|k| !k.is_null());
	let hosts = capabilities.and_then(|k| k.get("hostBindings")).and_then(Json::as_object).map_or_else(Default::default, |b| b.iter().filter_map(|(k, v)| Some((k.to_owned(), v.as_str()?.to_owned()))).collect());
	o.control_host = Some(ControlHost { peer_id: peer_id.to_owned(), control_space: control_space.to_owned(), signer: key_of(&c, "keyFile").0, public_key: control_key.to_owned(), grants, hosts, now: Rc::clone(&now) });
	if let Some(k) = capabilities {
		let names = |key: &str| k.get(key).and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect::<Vec<_>>());
		let mut spaces = names("dataSpaces");
		spaces.push(control_space.to_owned());
		o.capabilities = Some(Rc::new(Capabilities { host_id: host_id.to_owned(), tools: names("tools"), models: names("models"), data_spaces: spaces, client: None }));
	}
	o.boot = Some(guard);
	let gate = Gate::new(listen_host, o).unwrap_or_else(|e| fail(e));

	serve_gate(&runtime, opened, options, gate, peer_id, (listen_host, listen_port), "control");
}
