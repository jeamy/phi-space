// `--test-hooks CONFIG.json` (docs/rust-portierung.en.md, section 5): what test/support/service-fixture.ts needs of a server it
// cannot reach into. The identities, the policy and the limits of the case, one socket per peer, and a socket of its own
// for the hooks, unix only and never one the service listens on. Without the flag none of this exists.
//
// {"hooks": "/path.sock", "endpoints": [{"listen": "unix:/p", "peer": "peer-a"|null}], "identities": {"peer": {"principal": {...},
//  "roles": [...]}}, "policy": {"role": {"methods"?: [...], "types"?: [...]}}, "limits"?: {...}, "hostId"?, "authorityId"?,
//  "primaryEpoch"?, "maxPendingPerPrincipal"?, "maxPendingPerPeer"?, "maxCallsPerWindow"?, "wakeOnCommit"?, "maxFrameBytes"?,
//  "maxConnections"?, "maxInflightPerConnection"?, "idleMs"?, "gate"?: {"host", "port", "url", "token", "cacheMs"?, "handshakeMs"?,
//  "maxConnectionsPerPeer"?, "connectionsPerSecondPerPeer"?, "clockFile"?, "eventsFile"?, "keysFile"?, "gateHostId"?, "spaceKeys"?,
//  "enrollment"?, "controlAccess"?, "supervisor"?, "serviceClock"?, "grants"?: {"authorityId", "hostId", "seed", "publicKey"},
//  "runGates"?: {"authorityId", "peerId", "seed", "controller", "controllerKey"},
//  "membership"?: {"memberId", "spaceId", "authorityId", "peerId", "seed", "controller", "controllerKey"},
//  "spaceLifecycle"?: {"hostId", "authorityId", "peerId", "seed", "controller", "controllerKey"},
//  "delegation"?: {"authorityId", "controlSpaceId", "supervisor", "supervisorKey", "issuer", "grantKey", "policyFile"},
//  "boot"?: {"hostId", "authorityId", "external", "installed"}}}
//
// The gate's clock, its keys and its events are files, so a test can change them between two calls without a round trip.
//
// A hook is a frame with {"hook": ...}: setLimits {limits}, connections, clock {now}, state; on a gate also revalidate, peers,
// bootstrapEnroll, createEnroll, revokePeerKey, findKey, entries, controlState and writeAs, each with {now}.
use phi_host::auth::{PeerKey, Proving};
use phi_host::control::{self, Control, CreateEnroll, Enrolling, SpaceKeys, Supervisor, CONTROL_SPACE};
use phi_host::gate::{Gate, GateOptions, Keys, Netbird, Now};
use phi_json::{parse, Json};
use phi_service::{default_policy, Identity, Options, RolePolicy, Service};
use phi_wire::{Endpoint, Listen, ServeOptions};
use std::cell::Cell;
use std::rc::Rc;

fn seed_signer(seed: &str) -> Result<phi_host::auth::Signer, String> {
	let seed: [u8; 32] = phi_host::auth::base64(seed).try_into().map_err(|_| "a seed is 32 bytes")?;
	Ok(phi_host::auth::Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&seed)))
}
fn strings(v: &Json) -> Option<Vec<String>> { v.as_array().map(|a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect()) }

/// Sets the case up; the limits it names are for after the store has opened.
pub fn apply(file: &str, o: &mut Options, serving: &mut ServeOptions) -> Result<Option<Json>, String> {
	let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
	let c = parse(&text).map_err(|e| format!("{file}: {e}"))?;
	let hooks = c.get("hooks").and_then(Json::as_str).ok_or("the config names no hooks socket")?;
	serving.endpoints.clear();
	for e in c.get("endpoints").and_then(Json::as_array).ok_or("the config names no endpoints")? {
		let listen = Listen::parse(e.get("listen").and_then(Json::as_str).ok_or("an endpoint without listen")?)?;
		serving.endpoints.push(Endpoint { listen, peer: e.get("peer").and_then(Json::as_str).map(str::to_owned) });
	}
	o.identity.clear();
	for (peer, i) in c.get("identities").and_then(Json::as_object).ok_or("the config names no identities")?.iter() {
		let principal = i.get("principal").ok_or("an identity without principal")?.clone();
		o.identity.insert(peer.to_owned(), Identity { principal, roles: i.get("roles").and_then(strings).unwrap_or_default() });
	}
	o.policy = default_policy();
	if let Some(p) = c.get("policy").and_then(Json::as_object) {
		for (role, r) in p.iter() {
			o.policy.insert(role.to_owned(), RolePolicy { methods: r.get("methods").and_then(strings), types: r.get("types").and_then(strings) });
		}
	}
	let number = |k: &str| c.get(k).and_then(Json::as_f64);
	o.host_id = c.get("hostId").and_then(Json::as_str).map(str::to_owned);
	if let Some(a) = c.get("authorityId").and_then(Json::as_str) {
		o.authority_id = a.to_owned();
	}
	for (k, v) in [("primaryEpoch", &mut o.primary_epoch), ("maxPendingPerPrincipal", &mut o.max_pending_per_principal), ("maxPendingPerPeer", &mut o.max_pending_per_peer), ("maxCallsPerWindow", &mut o.max_calls_per_window)] {
		if let Some(n) = number(k) {
			*v = n;
		}
	}
	o.wake_on_commit = c.get("wakeOnCommit") == Some(&Json::Bool(true));
	for (k, v) in [("maxFrameBytes", &mut serving.max_frame_bytes), ("maxConnections", &mut serving.max_connections), ("maxInflightPerConnection", &mut serving.max_inflight_per_connection)] {
		if let Some(n) = number(k) {
			*v = n as usize;
		}
	}
	if let Some(n) = number("idleMs") {
		serving.idle_ms = n as u64;
	}
	let mut gate_clock = None;
	if let Some(g) = c.get("gate") {
		let (listen, front, now, authorize, guard) = gate(g, &o.policy)?;
		o.authorize = authorize;
		o.guard = guard;
		serving.gates.push((listen, front));
		gate_clock = g.get("serviceClock").filter(|v| **v == Json::Bool(true)).map(|_| now);
	}
	if let Some(now) = gate_clock {
		o.now = Box::new(move || now());
	}
	let clock: Rc<Cell<Option<f64>>> = Rc::default();
	let (real, held) = (std::mem::replace(&mut o.now, Box::new(|| 0.0)), clock.clone());
	o.now = Box::new(move || held.get().unwrap_or_else(&real));
	serving.hooks = Some((hooks.into(), Box::new(move |service, open, text| hook(service, open, &clock, text))));
	Ok(c.get("limits").cloned())
}

/// Keys as a file of `PeerKey` fields, read at each look.
struct FileKeys(String);
impl Keys for FileKeys {
	fn find(&self, _: &mut phi_store::Store, peer_id: &str, key_id: &str) -> Option<PeerKey> {
		let list = parse(&std::fs::read_to_string(&self.0).ok()?).ok()?;
		list.as_array()?.iter().filter_map(PeerKey::from_json).find(|k| k.peer_id == peer_id && k.key_id == key_id)
	}
}

type Gated = (Listen, Rc<dyn phi_wire::Front>, Now, Option<phi_service::Authorize>, Option<Rc<dyn phi_service::Guard>>);
fn gate(g: &Json, policy: &phi_service::Policy) -> Result<Gated, String> {
	let text = |k: &str| g.get(k).and_then(Json::as_str);
	let number = |k: &str| g.get(k).and_then(Json::as_f64);
	let flag = |k: &str| g.get(k) == Some(&Json::Bool(true));
	let now: Now = match text("clockFile") {
		None => Rc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after 1970").as_millis() as f64),
		Some(file) => {
			let (file, last) = (file.to_owned(), Cell::new(0.0));
			Rc::new(move || {
				if let Some(t) = std::fs::read_to_string(&file).ok().and_then(|t| t.trim().parse().ok()) {
					last.set(t);
				}
				last.get()
			})
		}
	};
	let directory = Netbird::new(text("url").ok_or("the gate names no url")?, text("token").unwrap_or(""), number("cacheMs"), Rc::clone(&now))?;
	let mut o = GateOptions::new(directory, Rc::clone(&now));
	o.revalidate_ms = 0;
	if let Some(n) = number("handshakeMs") {
		o.handshake_ms = n as u64;
	}
	if let Some(n) = number("maxConnectionsPerPeer") {
		o.max_per_peer = n as usize;
	}
	if let Some(n) = number("connectionsPerSecondPerPeer") {
		o.connections_per_second = n;
	}
	let log = |file: Option<&str>| -> Rc<dyn Fn(&Json)> {
		let file = file.map(str::to_owned);
		Rc::new(move |e| {
			use std::io::Write as _;
			if let Some(mut f) = file.as_ref().and_then(|f| std::fs::OpenOptions::new().append(true).create(true).open(f).ok()) {
				let _ = writeln!(f, "{}", e.to_json_text());
			}
		})
	};
	let events = log(text("eventsFile"));
	let on = |events: &Rc<dyn Fn(&Json)>| -> Box<dyn Fn(&Json)> {
		let events = Rc::clone(events);
		Box::new(move |e| events(e))
	};
	o.on_event = on(&events);
	if let Some(id) = text("gateHostId") {
		let keys: Option<Rc<dyn Keys>> = match text("keysFile") {
			Some(file) => Some(Rc::new(FileKeys(file.to_owned()))),
			None if flag("spaceKeys") => Some(Rc::new(SpaceKeys { now: Rc::clone(&o.now) })),
			None => None,
		};
		o.proving = keys.map(|k| (Proving::new(id), k));
	}
	if flag("enrollment") {
		o.enrolling = Some(Enrolling::new(on(&events)));
	}
	if flag("controlAccess") {
		o.control = Some(Control { supervisor: flag("supervisor").then(|| Supervisor { commands: None, jobs: Default::default(), on_event: on(&events), routing: None }) });
	}
	if let Some(g) = g.get("grants") {
		let part = |k: &str| g.get(k).and_then(Json::as_str).map(str::to_owned).ok_or(format!("grants without {k}"));
		let signer = seed_signer(&part("seed")?)?;
		o.rotating = Some(phi_host::rotation::Rotating::new(&part("authorityId")?, &part("hostId")?, signer, &part("publicKey")?));
	}
	if let Some(r) = g.get("runGates") {
		let part = |k: &str| r.get(k).and_then(Json::as_str).map(str::to_owned).ok_or(format!("runGates without {k}"));
		let signer = seed_signer(&part("seed")?)?;
		let jobs: phi_host::run_member::RunPreparer = Box::new(jobs_preparer);
		o.run_gates = Some(phi_host::run_member::RunGates { authority_id: part("authorityId")?, peer_id: part("peerId")?, signer, controller: phi_host::run_member::Pin { issuer: part("controller")?, algorithm: phi_host::auth::Algorithm::Ed25519, public_key: part("controllerKey")? }, preparers: [("jobs".to_owned(), jobs)].into_iter().collect(), assert_authority: Box::new(|_| Ok(())) });
	}
	let mut guard: Option<Rc<dyn phi_service::Guard>> = None;
	if let Some(b) = g.get("boot") {
		let part = |k: &str| b.get(k).and_then(Json::as_str).map(str::to_owned).ok_or(format!("boot without {k}"));
		let file = |k: &str| phi_host::register::SqliteRegister::open(std::path::Path::new(&part(k)?)).map_err(|e| e.to_string());
		let boot = Rc::new(phi_host::boot::BootGuard::new(&part("hostId")?, &part("authorityId")?, phi_host::boot::External::File(file("external")?), file("installed")?, Rc::clone(&o.now), 60_000.0));
		o.boot = Some(Rc::clone(&boot));
		guard = Some(boot);
	}
	let mut authorize = None;
	if let Some(d) = g.get("delegation") {
		let part = |k: &str| d.get(k).and_then(Json::as_str).map(str::to_owned).ok_or(format!("delegation without {k}"));
		let keys = o.proving.as_ref().map(|(_, k)| Rc::clone(k)).ok_or("delegation needs keys")?;
		let (authority, file) = (part("authorityId")?, part("policyFile")?);
		let held = authority.clone();
		let installed: Rc<dyn Fn() -> (String, f64)> = Rc::new(move || (held.clone(), std::fs::read_to_string(&file).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0.0)));
		let ed = phi_host::auth::Algorithm::Ed25519;
		let grants = phi_host::grants::GrantVerifier { authority_id: authority.clone(), issuer_host_id: part("issuer")?, public_key: part("grantKey")?, algorithm: ed, uncertainty_ms: 2000.0 };
		let verifier = phi_host::delegation::DelegationVerifier::new(phi_host::delegation::DelegationOptions { authority_id: authority, control_space_id: part("controlSpaceId")?, supervisor_peer_id: part("supervisor")?, supervisor: (ed, part("supervisorKey")?), keys, grants, policy: installed, rules: Rc::new(policy.clone()), uncertainty_ms: 2000.0 }).map_err(|e| e.message)?;
		o.delegation = Some(Rc::clone(&verifier));
		authorize = Some(phi_host::delegation::authorize(verifier, Rc::clone(&o.now)));
	}
	if let Some(m) = g.get("membership") {
		let part = |k: &str| m.get(k).and_then(Json::as_str).map(str::to_owned).ok_or(format!("membership without {k}"));
		let signer = seed_signer(&part("seed")?)?;
		let control = phi_host::run_member::Pin { issuer: part("controller")?, algorithm: phi_host::auth::Algorithm::Ed25519, public_key: part("controllerKey")? };
		o.lifecycle = Some(phi_host::membership::MemberLifecycle::new(&part("memberId")?, &part("spaceId")?, &part("authorityId")?, &part("peerId")?, signer, control, Box::new(|_| Ok(()))));
	}
	if let Some(m) = g.get("spaceLifecycle") {
		let part = |k: &str| m.get(k).and_then(Json::as_str).map(str::to_owned).ok_or(format!("spaceLifecycle without {k}"));
		let signer = seed_signer(&part("seed")?)?;
		let control = phi_host::run_member::Pin { issuer: part("controller")?, algorithm: phi_host::auth::Algorithm::Ed25519, public_key: part("controllerKey")? };
		let check = o.boot.clone();
		o.spaces = Some(phi_host::space_lifecycle::SpaceLifecycleService::new(&part("hostId")?, &part("authorityId")?, &part("peerId")?, signer, control, Box::new(move |_| check.as_ref().map_or(Ok(()), |b| b.assert_active()))));
	}
	let host = text("host").ok_or("the gate names no host")?;
	let front: Rc<dyn phi_wire::Front> = Gate::new(host, o)?;
	Ok((Listen::Tcp { host: host.to_owned(), port: number("port").unwrap_or(0.0) as u16 }, front, now, authorize, guard))
}

/// The test's run kind: two jobs per Member, idempotent.
fn jobs_preparer(service: &mut Service, run: &Json, space: &str) -> Result<(), phi_core::space::CoreError> {
	let id = run.get("runId").cloned().unwrap_or(Json::Null);
	service.commit_on(Some(space), |s, now| {
		for n in [1.0, 2.0] {
			let fields = phi_json::obj! { "runId" => id.clone(), "n" => n };
			let t = phi_core::space::Template::from_json(Some(&phi_json::obj! { "type" => "Job", "fields" => fields.clone() }))?;
			if s.list(now, &t, None, None, None)?.as_array().is_some_and(Vec::is_empty) {
				s.write(now, &phi_json::obj! { "type" => "Job", "fields" => fields }, None, Some(&Json::Number(phi_json::FOREVER)), None)?;
			}
		}
		Ok(())
	})
}

/// What a test does on the host itself, where the in-process test holds it.
fn control_hook(service: &mut Service, name: &str, line: &Json) -> String {
	let text = |k: &str| line.get(k).and_then(Json::as_str).unwrap_or("");
	let now = line.get("now").and_then(Json::as_f64).unwrap_or(0.0);
	let ttl = line.get("ttlMs").and_then(Json::as_f64);
	let scope = line.get("scope").and_then(strings).unwrap_or_default();
	if name == "jobsSpace" {
		let done = service.store.create_space(text("alias"), now, phi_store::system_random()).map_err(|e| phi_core::space::error("Error", e.to_string())).and_then(|r| r).and_then(|info| {
			let id = info.get("spaceId").and_then(Json::as_str).unwrap_or("").to_owned();
			let profiles = line.get("profiles").cloned();
			// host code, before a boot permit can name the Space
			match service.store.commit(Some(&id), now, |s| s.set_completion_profiles(now, profiles.as_ref())) {
				Ok(r) => r.map(|_| Json::String(id)),
				Err(e) => Err(phi_core::space::error("Error", e.to_string())),
			}
		});
		return match done {
			Ok(v) => phi_json::obj! { "ok" => true, "result" => v }.to_json_text(),
			Err(e) => phi_json::obj! { "ok" => false, "class" => e.class, "message" => e.message }.to_json_text(),
		};
	}
	if name == "spaceInfo" {
		let found = service.store.space_info(text("alias")).cloned();
		return phi_json::obj! { "ok" => true, "result" => found.unwrap_or(Json::Null) }.to_json_text();
	}
	if name == "jobs" {
		let done = service.store.reader(Some(text("space"))).and_then(|h| h.space.list(now, &phi_core::space::Template::from_json(Some(&phi_json::obj! { "type" => "Job" }))?, None, None, None));
		return match done {
			Ok(v) => phi_json::obj! { "ok" => true, "result" => v }.to_json_text(),
			Err(e) => phi_json::obj! { "ok" => false, "message" => e.message }.to_json_text(),
		};
	}
	let id = control::control_id(service, now);
	let result = id.and_then(|id| match name {
		"bootstrapEnroll" => control::bootstrap_enroll(service, now, text("tokenHash"), text("allowedPeerId"), ttl),
		"createEnroll" => control::create_enroll(service, now, &CreateEnroll { token_hash: text("tokenHash").to_owned(), role: text("role").to_owned(), allowed_peer_id: text("allowedPeerId").to_owned(), scope, ttl_ms: ttl }),
		"revokePeerKey" => control::revoke_peer_key(service, now, text("peerId"), text("keyId")).map(Json::Bool),
		"findKey" => Ok(service.store.reader(Some(CONTROL_SPACE))?.space.list(now, &phi_core::space::Template::from_json(Some(&phi_json::obj! { "type" => "PeerKey", "fields" => phi_json::obj! { "peerId" => text("peerId"), "keyId" => text("keyId") } }))?, None, None, None)?.as_array().and_then(|a| a.first()).and_then(|e| e.get("fields")).cloned().unwrap_or(Json::Null)),
		"entries" => service.store.reader(Some(CONTROL_SPACE))?.space.list(now, &phi_core::space::Template::from_json(line.get("template"))?, None, None, None),
		"controlState" => Ok(service.store.reader(Some(CONTROL_SPACE))?.space.state.to_json()),
		"writeAs" => service.commit_on(Some(&id), |s, _| s.write(now, line.get("entry").unwrap_or(&Json::Null), None, line.get("leaseMs"), line.get("owner"))),
		other => Err(phi_core::space::error("Error", format!("no hook {other}"))),
	});
	match result {
		Ok(v) => phi_json::obj! { "ok" => true, "result" => v }.to_json_text(),
		Err(e) => phi_json::obj! { "ok" => false, "class" => e.class, "message" => e.message }.to_json_text(),
	}
}

fn hook(service: &mut Service, open: usize, clock: &Cell<Option<f64>>, text: &str) -> String {
	let Ok(line) = parse(text) else { return r#"{"ok":false}"#.to_owned() };
	let result = match line.get("hook").and_then(Json::as_str) {
		Some("setLimits") => service.set_limits(line.get("limits").unwrap_or(&Json::Null)).map_err(|e| e.message),
		Some("connections") => Ok(Json::Number(open as f64)),
		Some("clock") => {
			clock.set(line.get("now").and_then(Json::as_f64));
			Ok(Json::Null)
		}
		Some("state") => match service.store.reader(None) {
			Ok(h) => Ok(h.space.state.to_json_without_claims()),
			Err(e) => Err(e.message),
		},
		Some(name) => return control_hook(service, name, &line),
		None => Err("no hook None".to_owned()),
	};
	match result {
		Ok(v) => phi_json::obj! { "ok" => true, "result" => v }.to_json_text(),
		Err(m) => phi_json::obj! { "ok" => false, "message" => m }.to_json_text(),
	}
}
