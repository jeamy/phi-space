// `--control CONFIG.json`: a control host, what `startConfiguredFederation` makes of a config of mode "control". What this host does
// not carry yet is refused at the start, never ignored: `syncSpaces` and the register's ssh and socket lines. It takes what a
// Member takes, from itself: delegated calls on its own Spaces and its signed instructions. Its `recovery` section is the
// private endpoint with the control host's receipt.
use crate::{fail, stopping};
use crate::member::{address_of, boot_guard, clock, config_of, entry_exported, entry_replication, entry_tasks, field, follow_changes, follow_installed_change, sync_context, followed_authority, key_of, member_instructions, netbird, open_store, own_peer, private_recovery, register_client, serve_gate, set_group_roles};
use phi_host::alerts::ControlCommands;
use phi_host::control::AsyncCommands;
use phi_host::auth::{Algorithm, Proving};
use phi_host::boot::BootGuard;
use phi_host::root::{MemberEnd, Root, RootConfig};
use phi_host::capability::Capabilities;
use phi_host::control::{align_control_replica, key_fingerprint, Control, Enrolling, Routing, SpaceKeys, Supervisor, CONTROL_SPACE};
use phi_host::sync_space::{start, Started, SyncSpace, SyncSpaceConfig};
use phi_host::control_host::ControlHost;
use phi_host::delegation::{authorize, DelegationOptions, DelegationVerifier, ReplicaConfig};
use phi_host::run_member::Pin;
use phi_host::gate::{Gate, GateOptions, Keys, Now};
use phi_host::grants::GrantVerifier;
use phi_host::rotation::Rotating;
use phi_json::Json;
use phi_service::{space_epoch, Options};
use std::cell::RefCell;
use std::rc::Rc;

const REFUSED: [&str; 3] = ["syncSpaces", "registerSshTarget", "registerReadSocket"];

pub fn run(config: &str, store: &str) {
	let mut c = config_of(config, "control", "this host runs as a control host", &REFUSED);
	let main = main_sync(&c, store);
	let host_id = field(&c, "hostId");
	if host_id != field(&c, "controlHostId") {
		fail("configured control host or space identity disagrees with provisioned state");
	}
	let now = clock();
	// a primary/sync main store: not its primary, or in quarantine, the host only listens as its replica; its primary
	// recovers the store under the journal and serves it, every Space in it following the control Space's configuration
	let runtime = stopping::runtime();
	let main = main.map(|m| {
		let cx = sync_context(&c, &now);
		let primary = tokio::task::LocalSet::new().block_on(&runtime, async {
			let probe = phi_store::sync::SyncJournal::open(&m.dir.join("journal.sqlite"), &m.genesis, Default::default()).map_err(|e| e.to_string())?;
			let primary = probe.config().get("primaryReplica").and_then(Json::as_str).map(str::to_owned);
			drop(probe);
			let boot = cx.register.get(&format!("boot:{host_id}")).await?;
			Ok::<_, String>(primary.as_deref() == Some(host_id) && boot.get("value").and_then(|v| v.get("state")).and_then(Json::as_str) != Some("quarantine"))
		});
		if !primary.unwrap_or_else(|e| fail(e)) {
			listen_as_replica(&runtime, m, cx);
		}
		let local = tokio::task::LocalSet::new();
		let sp = local.block_on(&runtime, SyncSpace::open(m, cx, false)).unwrap_or_else(|e| fail(e));
		match local.block_on(&runtime, start(&sp)) {
			Ok(Started::Served(store)) => (sp, *store),
			Ok(_) => fail("BootBlocked: the main store's sealed candidate is not resolved"),
			Err(e) => fail(format!("BootBlocked: {e}")),
		}
	});
	let (main, mut opened) = match main {
		Some((sp, store)) => (Some(sp), store),
		None => (None, open_store(store)),
	};
	// control promotion: a recorded change of the control host is followed before anything else is read of the config
	follow_installed_change(&mut c, &runtime);
	let (host_id, peer_id, control_space) = (field(&c, "hostId"), field(&c, "peerId"), field(&c, "controlSpaceId"));
	let (authority_id, control_key) = followed_authority(&c);
	let (authority_id, control_key) = (authority_id.as_str(), control_key.as_str());
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
	if let Some(sp) = &main {
		// every Space of the main store is admitted only as the primary of the journal's configuration (`replicaConfig`)
		for info in opened.spaces() {
			let sp = Rc::clone(sp);
			guard.replica.borrow_mut().insert(field(&info, "spaceId").to_owned(), Box::new(move || sp.config_now()));
		}
		// v3 5.3.1 step 6: the policy step of the last control transition, before grants, leases or the Root exist
		if let Some(t) = tokio::task::LocalSet::new().block_on(&runtime, sp.last_transition()) {
			let (next, before) = (t.get("config").cloned().unwrap_or(Json::Null), t.get("previous").cloned().unwrap_or(Json::Null));
			let pick = |v: &Json, keys: &[&str]| Json::Object(keys.iter().map(|k| (*k, v.get(k).cloned().unwrap_or(Json::Null))).collect());
			let mut step = pick(&next, &["primaryEpoch", "replicaConfigVersion", "primaryReplica"]);
			step.as_object_mut().unwrap().insert("transitionId", t.get("transitionId").cloned().unwrap_or(Json::Null));
			align_control_replica(&mut opened, now(), control_space, authority_id, &step, &pick(&before, &["primaryEpoch", "primaryReplica"])).unwrap_or_else(|e| fail(format!("{}: {}", e.class, e.message)));
			opened.drain().unwrap_or_else(|e| fail(e));
		}
	}
	let directory = netbird(&c, &now);
	let listen = c.get("listen").unwrap_or_else(|| fail("the config has no listen"));
	let (listen_host, listen_port) = address_of(listen);
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
	// epochForSpace: every Space of a primary/sync main store at the journal's epoch, any other at its own; the journal's
	// evidence makes an unknown request of an earlier epoch NotCommitted (mainPromotionProof)
	let main_epoch = main.clone();
	options.epoch_for_space = Some(Rc::new(move |store, space| space_epoch(store, space, &|_| main_epoch.as_ref().map(|sp| sp.primary_epoch()))));
	if let Some(sp) = main.clone() {
		options.promotion_proof = Some(Rc::new(move |_, request_epoch| sp.promotion_proof(request_epoch)));
	}
	let grants = GrantVerifier { authority_id: authority_id.to_owned(), issuer_host_id: host_id.to_owned(), public_key: control_key.to_owned(), algorithm, uncertainty_ms: 2000.0 };
	let routing = Rc::new(RefCell::new(None));
	let keys: Rc<dyn Keys> = Rc::new(SpaceKeys { now: Rc::clone(&now) });
	// a router's delegated calls on this host's own Spaces: this host is their supervisor, its policy the one it signs,
	// a Space of a primary/sync main store at the journal's configuration (`verifierFor(host, mainReplica)`)
	let installed = Routing { control_space: control_space.to_owned(), authority_id: authority_id.to_owned(), state: Rc::clone(&routing) };
	let replica_config: ReplicaConfig = {
		let guard = Rc::clone(&guard);
		Rc::new(move |id| guard.replica.borrow().get(id).map(|config| config()))
	};
	let verifier = DelegationVerifier::new(DelegationOptions { authority_id: authority_id.to_owned(), control_space_id: control_space.to_owned(), supervisor_peer_id: peer_id.to_owned(), supervisor: (algorithm, control_key.to_owned()), keys: Rc::clone(&keys), grants: grants.clone(), policy: Rc::new(move |store| installed.installed(store)), rules: Rc::new(options.policy.clone()), uncertainty_ms: 2000.0, replica_config: Some(replica_config) }).unwrap_or_else(|e| fail(e.message));
	options.authorize = Some(authorize(Rc::clone(&verifier), Rc::clone(&now)));
	options.guard = Some(Rc::clone(&guard) as _);

	let mut o = GateOptions::new(directory, Rc::clone(&now));
	set_group_roles(&mut o, &c);
	o.proving = Some((Proving::new(host_id), keys));
	o.delegation = Some(verifier);
	// what a Member takes, from this host to itself
	member_instructions(&c, &mut o, (host_id, authority_id, peer_id), Pin { issuer: peer_id.to_owned(), algorithm, public_key: control_key.to_owned() }, &guard);
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
	o.control_host = Some(ControlHost { peer_id: peer_id.to_owned(), control_space: control_space.to_owned(), signer: key_of(&c, "keyFile").0, public_key: control_key.to_owned(), grants, hosts, now: Rc::clone(&now), control_epoch: main.as_ref().map(|sp| {
		let sp = Rc::clone(sp);
		Rc::new(move || sp.config_now().get("primaryEpoch").and_then(Json::as_f64).unwrap_or(1.0)) as Rc<dyn Fn() -> f64>
	}) });
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
	tasks.extend(follow_changes(&c));
	let _held = main;
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
		control: ControlHost { peer_id: peer_id.to_owned(), control_space: control_space.to_owned(), signer: control, public_key: control_key.to_owned(), grants, hosts: Default::default(), now: Rc::clone(now), control_epoch: None },
		guard: Rc::clone(guard), now: Rc::clone(now), routing: Rc::clone(routing),
		admin: r.get("adminPeer").filter(|_| r.get("allowMembershipCommands") == Some(&Json::Bool(true))).map(|a| (field(a, "peerId").to_owned(), field(a, "address").to_owned())),
		directory: Rc::clone(&o.directory), group_roles: o.group_roles.clone(), control_signer: Rc::new(key_of(c, "keyFile").0),
		status_interval_ms: interval as u64, takeover,
	}
}

/// `mainSync`: the configuration of the journal the host's main store `store` runs under.
fn main_sync(c: &Json, store: &str) -> Option<SyncSpaceConfig> {
	let m = c.get("mainSync").filter(|m| !m.is_null())?;
	let mut o = m.as_object().cloned().unwrap_or_default();
	o.insert("alias", Json::from("control-main"));
	o.insert("spaceId", m.get("genesis").and_then(|g| g.get("spaceId")).cloned().unwrap_or(Json::Null));
	let mut config = SyncSpaceConfig::from_json(&Json::Object(o)).unwrap_or_else(|e| fail(e));
	config.store = Some(store.into());
	Some(config)
}

/// A main store this host is not the primary of, or a host in quarantine: only the journal and its replica listener, for
/// setStandby's catch-up and the promotion's materialization, until the host is stopped.
fn listen_as_replica(runtime: &tokio::runtime::Runtime, m: SyncSpaceConfig, cx: Rc<phi_host::sync_space::SyncContext>) -> ! {
	tokio::task::LocalSet::new().block_on(runtime, async {
		let stop = stopping::signalled();
		let sp = SyncSpace::open(m, cx, true).await.unwrap_or_else(|e| fail(e));
		println!("{}", phi_json::obj! { "mainReplicaListening" => true, "head" => sp.head().await }.to_json_text());
		stop.await;
		sp.close();
	});
	std::process::exit(0)
}
