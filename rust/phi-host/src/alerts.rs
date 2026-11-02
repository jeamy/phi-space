//! The read-only views of the supervisor (src/alerts.ts): alerts derived from the hosts' reports and the audit of the commands. Alerts
//! are hints, never proof of a state. Runs and workers are not on a configured control host, so neither is here.
use crate::control::{control_id, AsyncCommands};
use phi_core::space::{CoreError, Space, Template};
use phi_json::{num_of, obj, text, Json};
use phi_wire::{Local, Owner};
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
/// `CAPABILITY_LEASE_MS`: a report older than this counts as missing.
const STALE_MS: f64 = 120_000.0;
const MAX_ERROR: usize = 300;

fn listed(s: &Space, now: f64, kind: &str) -> R<Vec<Json>> {
	let found = s.list(now, &Template::from_json(Some(&obj! { "type" => kind }))?, None, None, None)?;
	Ok(found.as_array().cloned().unwrap_or_default())
}
fn string(v: Option<&Json>) -> String {
	match v {
		Some(Json::String(t)) => t.clone(),
		Some(Json::Null) | None => String::new(),
		Some(x) => x.to_json_text(),
	}
}
/// `slice(0, n)` of a JavaScript string.
fn cut(t: &str, n: usize) -> String { String::from_utf16_lossy(&t.encode_utf16().take(n).collect::<Vec<_>>()) }

/// `collectAlerts` as far as a configured host goes: what the hosts report.
pub fn collect_alerts(s: &Space, now: f64) -> R<Json> {
	let mut out: Vec<(String, Json)> = vec![];
	let mut seen: Vec<String> = vec![];
	for e in listed(s, now, "Capability")? {
		let Some(f) = e.get("fields") else { continue };
		let host = string(f.get("hostId"));
		if seen.contains(&host) {
			continue;
		}
		seen.push(host.clone());
		let mut alert = |key: String, message: String| out.push((key.clone(), obj! { "key" => key, "severity" => "warning", "source" => "host", "subject" => host.as_str(), "message" => message }));
		if let Some(error) = f.get("metrics").and_then(|m| m.get("workers")).and_then(|w| text(w, "fetchError")) {
			alert(format!("host:{host}:fetch"), format!("Zuweisungen nicht abrufbar: {error}"));
		}
		let age = now - num_of(f, "at").unwrap_or(f64::NAN);
		if age > STALE_MS {
			alert(format!("host:{host}:stale"), format!("letzter Heartbeat vor {} s", (age / 1000.0 + 0.5).floor()));
		}
	}
	out.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
	Ok(Json::Array(out.into_iter().map(|(_, a)| a).collect()))
}

/// `auditLog`: who asked what, when, with which outcome; without the payloads.
pub fn audit_log(s: &Space, now: f64, limit: f64) -> R<Json> {
	let mut rows = vec![];
	for e in listed(s, now, "Result")? {
		let Some(f) = e.get("fields") else { continue };
		let at = num_of(f, "at").unwrap_or(f64::NAN);
		let mut row = obj! { "commandId" => string(f.get("commandId")), "kind" => string(f.get("kind")), "state" => string(f.get("state")), "requestedBy" => string(f.get("requestedBy")), "at" => at };
		let error = [f.get("error"), f.get("result").and_then(|r| r.get("error"))].into_iter().flatten().find(|x| phi_core::space::truthy(Some(x)));
		if let (Some(x), Json::Object(o)) = (error, &mut row) {
			o.insert("error", cut(&string(Some(x)), MAX_ERROR).into());
		}
		rows.push((at, row));
	}
	rows.sort_by(|a, b| b.0.total_cmp(&a.0));
	let keep = limit.clamp(1.0, 500.0);
	if keep.is_nan() {
		return Ok(Json::Array(vec![]));
	}
	Ok(Json::Array(rows.into_iter().take(keep as usize).map(|(_, r)| r).collect()))
}

/// `Number(a.limit ?? 100)`.
fn limit_of(args: &Json) -> f64 {
	match args.get("limit") {
		None | Some(Json::Null) => 100.0,
		Some(Json::Number(n)) => *n,
		Some(Json::String(t)) => t.trim().parse().unwrap_or(f64::NAN),
		Some(_) => f64::NAN,
	}
}

/// The asynchronous commands of a control host: the views, and what its Root brings.
pub struct ControlCommands {
	kinds: Vec<&'static str>,
	root: Option<Rc<dyn AsyncCommands>>,
	now: crate::gate::Now,
}
impl ControlCommands {
	pub fn new(root: Option<Rc<dyn AsyncCommands>>, now: crate::gate::Now) -> ControlCommands {
		let mut kinds = vec!["listAlerts", "auditLog"];
		kinds.extend(root.iter().flat_map(|r| r.kinds().iter().copied()));
		ControlCommands { kinds, root, now }
	}
}
impl AsyncCommands for ControlCommands {
	fn kinds(&self) -> &[&'static str] { &self.kinds }
	fn run(&self, owner: Owner, kind: &str, command_id: &str, args: &Json, requested_by: &str) -> Local<Result<Json, String>> {
		if kind != "listAlerts" && kind != "auditLog" {
			if let Some(root) = &self.root {
				return root.run(owner, kind, command_id, args, requested_by);
			}
		}
		let now = (self.now)();
		let done = owner.with(|service| {
			let id = control_id(service, now)?;
			service.commit_on(Some(&id), |s, _| if kind == "listAlerts" { collect_alerts(s, now) } else { audit_log(s, now, limit_of(args)) })
		});
		Box::pin(async move { done.map_err(|e| e.message) })
	}
}
