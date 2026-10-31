// `--test-hooks CONFIG.json` (docs/rust-portierung.md, section 5): what test/support/service-fixture.ts needs of a server it
// cannot reach into. The identities, the policy and the limits of the case, one socket per peer, and a socket of its own
// for the hooks, unix only and never one the service listens on. Without the flag none of this exists.
//
// {"hooks": "/path.sock", "endpoints": [{"listen": "unix:/p", "peer": "peer-a"|null}], "identities": {"peer": {"principal": {...},
//  "roles": [...]}}, "policy": {"role": {"methods"?: [...], "types"?: [...]}}, "limits"?: {...}, "hostId"?, "authorityId"?,
//  "primaryEpoch"?, "maxPendingPerPrincipal"?, "maxPendingPerPeer"?, "maxCallsPerWindow"?, "wakeOnCommit"?, "maxFrameBytes"?,
//  "maxConnections"?, "maxInflightPerConnection"?, "idleMs"?}
//
// A hook is a frame with {"hook": ...}: setLimits {limits}, connections, clock {now}, state.
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
	let clock: Rc<Cell<Option<f64>>> = Rc::default();
	let (real, held) = (std::mem::replace(&mut o.now, Box::new(|| 0.0)), clock.clone());
	o.now = Box::new(move || held.get().unwrap_or_else(&real));
	serving.hooks = Some((hooks.into(), Box::new(move |service, open, text| hook(service, open, &clock, text))));
	Ok(c.get("limits").cloned())
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
		other => Err(format!("no hook {other:?}")),
	};
	match result {
		Ok(v) => phi_json::obj! { "ok" => true, "result" => v }.to_json_text(),
		Err(m) => phi_json::obj! { "ok" => false, "message" => m }.to_json_text(),
	}
}
