// `--test-hooks CONFIG.json` (docs/rust-portierung.en.md, section 5): what test/support/service-fixture.ts needs of a server it
// cannot reach into. The identities, the policy and the limits of the case, one socket per peer, and a socket of its own
// for the hooks, unix only and never one the service listens on. Without the flag none of this exists.
//
// {"hooks": "/path.sock", "endpoints": [{"listen": "unix:/p", "peer": "peer-a"|null}], "identities": {"peer": {"principal": {...},
//  "roles": [...]}}, "policy": {"role": {"methods"?: [...], "types"?: [...]}}, "limits"?: {...}, "hostId"?, "authorityId"?,
//  "primaryEpoch"?, "maxPendingPerPrincipal"?, "maxPendingPerPeer"?, "maxCallsPerWindow"?, "wakeOnCommit"?, "maxFrameBytes"?,
//  "maxConnections"?, "maxInflightPerConnection"?, "idleMs"?, "gate"?: {"host", "port", "url", "token", "cacheMs"?, "handshakeMs"?,
//  "maxConnectionsPerPeer"?, "connectionsPerSecondPerPeer"?, "clockFile"?, "eventsFile"?, "keysFile"?, "gateHostId"?, "spaceKeys"?,
//  "enrollment"?, "controlAccess"?, "supervisor"?, "serviceClock"?, "grants"?: {"authorityId", "hostId", "seed", "publicKey"}}}
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
		let (listen, front, now) = gate(g)?;
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
	fn find(&self, _: &mut Service, peer_id: &str, key_id: &str) -> Option<PeerKey> {
		let list = parse(&std::fs::read_to_string(&self.0).ok()?).ok()?;
		list.as_array()?.iter().filter_map(PeerKey::from_json).find(|k| k.peer_id == peer_id && k.key_id == key_id)
	}
}

fn gate(g: &Json) -> Result<(Listen, Rc<dyn phi_wire::Front>, Now), String> {
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
		o.control = Some(Control { supervisor: flag("supervisor").then(|| Supervisor { on_event: on(&events) }) });
	}
	if let Some(g) = g.get("grants") {
		let part = |k: &str| g.get(k).and_then(Json::as_str).map(str::to_owned).ok_or(format!("grants without {k}"));
		let seed: [u8; 32] = phi_host::auth::base64(&part("seed")?).try_into().map_err(|_| "a seed is 32 bytes")?;
		let signer = phi_host::auth::Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&seed));
		o.rotating = Some(phi_host::rotation::Rotating::new(&part("authorityId")?, &part("hostId")?, signer, &part("publicKey")?));
	}
	let host = text("host").ok_or("the gate names no host")?;
	let front: Rc<dyn phi_wire::Front> = Gate::new(host, o)?;
	Ok((Listen::Tcp { host: host.to_owned(), port: number("port").unwrap_or(0.0) as u16 }, front, now))
}

/// What a test does on the host itself, where the in-process test holds it.
fn control_hook(service: &mut Service, name: &str, line: &Json) -> String {
	let text = |k: &str| line.get(k).and_then(Json::as_str).unwrap_or("");
	let now = line.get("now").and_then(Json::as_f64).unwrap_or(0.0);
	let ttl = line.get("ttlMs").and_then(Json::as_f64);
	let scope = line.get("scope").and_then(strings).unwrap_or_default();
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
		Some(name) if name != "state" => return control_hook(service, name, &line),
		other => Err(format!("no hook {other:?}")),
	};
	match result {
		Ok(v) => phi_json::obj! { "ok" => true, "result" => v }.to_json_text(),
		Err(m) => phi_json::obj! { "ok" => false, "message" => m }.to_json_text(),
	}
}
