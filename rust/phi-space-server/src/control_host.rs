// `--control CONFIG.json`: a control host, what `startConfiguredFederation` makes of a config of mode "control". What this host does
// not carry yet is refused at the start, never ignored: replication and following a control host change (R6b). Its `recovery`
// section is the private endpoint with the control host's receipt.
use crate::{fail, stopping};
use crate::member::{address_of, boot_guard, clock, config_of, entry_exported, entry_replication, entry_tasks, field, followed_authority, key_of, netbird, open_store, own_peer, private_recovery, register_client, serve_gate, set_group_roles};
use phi_host::alerts::ControlCommands;
use phi_host::control::AsyncCommands;
use phi_host::auth::{Algorithm, Proving};
use phi_host::boot::BootGuard;
use phi_host::root::{MemberEnd, Root, RootConfig};
use phi_host::capability::Capabilities;
use phi_host::control::{key_fingerprint, Control, Enrolling, Routing, SpaceKeys, Supervisor, CONTROL_SPACE};
use phi_host::control_host::ControlHost;
use phi_host::delegation::grants_only;
use phi_host::gate::{Gate, GateOptions, Keys, Now};
use phi_host::grants::GrantVerifier;
use phi_host::rotation::Rotating;
use phi_json::Json;
use phi_service::Options;
use std::cell::RefCell;
use std::rc::Rc;

const REFUSED: [&str; 7] = ["syncSpaces", "recoveryAdmin", "registerSshTarget", "registerReadSocket", "membership", "runGates", "spaceLifecycle"];

pub fn run(config: &str, store: &str) {
	let c = config_of(config, "control", "this host runs as a control host", &REFUSED);
	let (host_id, peer_id, control_space) = (field(&c, "hostId"), field(&c, "peerId"), field(&c, "controlSpaceId"));
	let (authority_id, control_key) = followed_authority(&c);
	let (authority_id, control_key) = (authority_id.as_str(), control_key.as_str());
	if host_id != field(&c, "controlHostId") {
		fail("configured control host or space identity disagrees with provisioned state");
	}
	let now = clock();
	let mut opened = open_store(store);
	if opened.registry().and_then(|r| r.get("aliases")?.get(CONTROL_SPACE)?.as_str()) != Some(control_space) {
		fail("configured control host or space identity disagrees with provisioned state");
	}
	let control = c.get("control").unwrap_or_else(|| fail("the config has no control"));
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
	options.primary_epoch = 1.0;
	let grants = GrantVerifier { authority_id: authority_id.to_owned(), issuer_host_id: host_id.to_owned(), public_key: control_key.to_owned(), algorithm, uncertainty_ms: 2000.0 };
	options.authorize = Some(grants_only(grants.clone(), Rc::new(options.policy.clone()), Rc::clone(&now)));
	options.guard = Some(Rc::clone(&guard) as _);

	let mut o = GateOptions::new(directory, Rc::clone(&now));
	set_group_roles(&mut o, &c);
	let routing = Rc::new(RefCell::new(None));
	let keys: Rc<dyn Keys> = Rc::new(SpaceKeys { now: Rc::clone(&now) });
	o.proving = Some((Proving::new(host_id), keys));
	o.enrolling = Some(Enrolling::new(Box::new(|_| ())));
	o.control = Some(Control { supervisor: Some(Supervisor { on_event: Box::new(|_| ()), commands: None, jobs: Default::default(), routing: Some(Routing { control_space: control_space.to_owned(), authority_id: authority_id.to_owned(), state: Rc::clone(&routing) }) }) });
	let mut rotating = Rotating::new(authority_id, host_id, signer, control_key);
	// configured-runtime's allowAOnly. A recovery writes the policy under the new authority before that authority runs,
	// so what stood at the start stands while this host runs. Without a policy, a control Space restored under a new
	// authority (`restore.kind` "control", which stays once completed) allows no A-only grant, any other does.
	let restored_control = opened.reader(Some(CONTROL_SPACE)).ok().and_then(|h| h.space.state.rest.get("restore").and_then(|r| r.get("kind")).and_then(Json::as_str).map(str::to_owned)).as_deref() == Some("control");
	rotating.allow_a_only = match access_policy {
		Some(p) => Some(p.get("authorityId").and_then(Json::as_str) == Some(authority_id) && p.get("aOnlyAllowed") == Some(&Json::Bool(true))),
		None => restored_control.then_some(false),
	};
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
	let mut held: Option<Rc<dyn AsyncCommands>> = None;
	if let Some(r) = c.get("root").filter(|r| !r.is_null()) {
		let root = root_of(&c, r, control_key, listen_host, &guard, &now, algorithm, (&routing, &o));
		let found = Root::check_start(&root, &mut opened).unwrap_or_else(|e| fail(e));
		let root = Root::new(root, found).unwrap_or_else(|e| fail(e.message));
		held = Some(Rc::new(Rc::clone(&root)));
		o.root = Some(root);
	}
	if let Some(s) = o.control.as_mut().and_then(|c| c.supervisor.as_mut()) {
		s.commands = Some(Rc::new(ControlCommands::new(held, Rc::clone(&now))));
	}
	// lww/set: the provisioned entry replication of one Space; its merge types bypass the core
	let entry = entry_replication(&c, &opened, authority_id, &guard, &now);
	o.entry_export = entry_exported(entry.as_ref());
	let boot = Rc::clone(&guard);
	o.boot = Some(guard);
	let gate = Gate::new(listen_host, o).unwrap_or_else(|e| fail(e));

	let mut tasks: Vec<Box<dyn FnOnce(phi_wire::Owner) -> phi_wire::Local<()>>> = private_recovery(&c, "control", authority_id, control_key).into_iter().collect();
	let merge = entry.map(|e| entry_tasks(e, &boot, &now, &mut tasks));
	serve_gate(&runtime, opened, options, gate, peer_id, (listen_host, listen_port), "control", tasks, merge);
}

/// `root` of the config: what is not carried yet stops the start.
#[allow(clippy::too_many_arguments)]
fn root_of(c: &Json, r: &Json, control_key: &str, listen_host: &str, guard: &Rc<BootGuard>, now: &Now, algorithm: Algorithm, (routing, o): (&Rc<RefCell<Option<Json>>>, &GateOptions)) -> RootConfig {
	let interval = r.get("statusIntervalMs").filter(|v| !v.is_null()).map_or(Some(10_000.0), Json::as_f64).filter(|v| v.fract() == 0.0 && (1000.0..=15_000.0).contains(v)).unwrap_or_else(|| fail("Root status interval must be 1000..15000 ms"));
	let takeover = (r.get("takeover") == Some(&Json::Bool(true))).then(|| r.get("takeoverWaitMs").and_then(Json::as_f64).unwrap_or(90_000.0));
	let members = r.get("members").and_then(Json::as_object).filter(|m| m.len() <= 32).unwrap_or_else(|| fail("incomplete native Root configuration"));
	if field(r, "id").is_empty() || members.iter().any(|(_, m)| m.get("replicas").is_some_and(|x| !x.is_null())) {
		fail("incomplete native Root configuration, or replicas, which are not served by this host");
	}
	let (router, key_id) = key_of(r, "keyFile");
	let (_, host_key_id) = key_of(r, "hostKeyFile");
	let (grant_signer, _) = key_of(c, "keyFile");
	let (control, _) = key_of(c, "keyFile");
	let line_key = r.clone();
	let ends = members.iter().map(|(id, m)| {
		let (host, port) = address_of(m.get("address").unwrap_or_else(|| fail("incomplete native Root configuration")));
		let algorithm = Algorithm::parse(field(m, "algorithm")).unwrap_or_else(|| fail("invalid Member key algorithm"));
		(id.to_owned(), MemberEnd { host: host.to_owned(), port, peer_id: field(m, "peerId").to_owned(), key_id: field(m, "keyId").to_owned(), algorithm, public_key: field(m, "publicKey").to_owned(), target: m.get("target").cloned().unwrap_or_else(|| fail("incomplete native Root configuration")) })
	}).collect();
	let (peer_id, control_space, host_id, authority) = (field(c, "peerId"), field(c, "controlSpaceId"), field(c, "hostId"), field(c, "authorityId"));
	let grants = GrantVerifier { authority_id: authority.to_owned(), issuer_host_id: host_id.to_owned(), public_key: control_key.to_owned(), algorithm, uncertainty_ms: 2000.0 };
	RootConfig {
		id: field(r, "id").to_owned(), peer_id: peer_id.to_owned(), authority_id: authority.to_owned(), host_id: host_id.to_owned(), control_space: control_space.to_owned(), own_address: listen_host.to_owned(),
		lease_file: field(r, "leaseFile").into(), partitions: r.get("journalPartitions").and_then(Json::as_f64).unwrap_or(f64::NAN),
		router_key: (Rc::new(router), key_id), host_key_id, members: ends, line_signer: Box::new(move || key_of(&line_key, "keyFile").0), grant_signer: Rc::new(grant_signer),
		control: ControlHost { peer_id: peer_id.to_owned(), control_space: control_space.to_owned(), signer: control, public_key: control_key.to_owned(), grants, hosts: Default::default(), now: Rc::clone(now) },
		guard: Rc::clone(guard), now: Rc::clone(now), routing: Rc::clone(routing),
		admin: r.get("adminPeer").filter(|_| r.get("allowMembershipCommands") == Some(&Json::Bool(true))).map(|a| (field(a, "peerId").to_owned(), field(a, "address").to_owned())),
		directory: Rc::clone(&o.directory), group_roles: o.group_roles.clone(), control_signer: Rc::new(key_of(c, "keyFile").0),
		status_interval_ms: interval as u64, takeover,
	}
}
