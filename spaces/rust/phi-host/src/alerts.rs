//! The read-only views of the supervisor (src/alerts.ts): alerts derived from the runs, the worker assignments and the hosts'
//! reports, and the audit of the commands. Alerts are hints, never proof of a state. The texts are German as in TypeScript; both
//! change together.
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
use phi_json::js_slice as cut;

/// `appliedWorkers`: the newest report per host of the Capability entries of the control Space, with its age.
pub fn applied_workers(s: &Space, now: f64) -> R<Vec<(String, f64, Json)>> {
	let mut out: Vec<(String, f64, Json)> = vec![];
	for e in listed(s, now, "Capability")? {
		let Some(f) = e.get("fields") else { continue };
		let (Some(host), Some(w)) = (text(f, "hostId"), f.get("metrics").and_then(|m| m.get("workers")).filter(|w| w.as_object().is_some() || w.as_array().is_some())) else { continue };
		let at = number_of(f.get("at"));
		match out.iter_mut().find(|(h, _, _)| h == host) {
			Some(held) if held.1 < at => *held = (host.to_owned(), at, w.clone()),
			Some(_) => {}
			None => out.push((host.to_owned(), at, w.clone())),
		}
	}
	Ok(out)
}

/// `Number(x)` of a field that holds a number (anything else is NaN here; TypeScript's reports carry numbers).
fn number_of(v: Option<&Json>) -> f64 { v.and_then(Json::as_f64).unwrap_or(f64::NAN) }
/// `${n}` of a JavaScript number.
fn js(n: f64) -> String { if n.is_nan() { "NaN".into() } else { phi_json::number_text(n) } }
/// `Math.round`.
fn round(x: f64) -> f64 { (x + 0.5).floor() }
/// JavaScript truthiness.
use phi_json::truthy;

/// `collectAlerts`: `runs` are the newest run views (`RunController.list(200)`), `assignments` the desired worker
/// assignments (`WorkerAssignments.list().assignments`).
pub fn collect_alerts_with(s: &Space, now: f64, runs: &[Json], assignments: &[Json]) -> R<Json> {
	let mut out: Vec<(bool, String, Json)> = vec![];
	let mut push = |critical: bool, key: String, source: &str, subject: &str, message: String| {
		out.push((critical, key.clone(), obj! { "key" => key, "severity" => if critical { "critical" } else { "warning" }, "source" => source, "subject" => subject, "message" => message }));
	};
	for r in runs {
		let subject = string(r.get("runId"));
		let state = text(r, "state").unwrap_or("");
		let recovery = || r.get("recovery").and_then(|q| text(q, "id")).unwrap_or("?").to_owned();
		let pending = r.get("pending").filter(|p| !p.is_null());
		match state {
			"pauseIncomplete" => {
				let missing: Vec<String> = pending.and_then(|p| p.get("missing")).and_then(Json::as_array).map_or(vec![], |m| m.iter().map(|x| string(Some(x))).collect());
				let list = missing.join(", ");
				push(true, format!("run:{subject}:pauseIncomplete"), "run", &subject, format!("Pause unvollständig, fehlende ACKs: {}", if list.is_empty() { "?" } else { &list }));
			}
			"needsReview" => push(true, format!("run:{subject}:needsReview"), "run", &subject, format!("Recovery {} wartet auf eine Admin-Entscheidung", recovery())),
			"reconciling" => push(false, format!("run:{subject}:reconciling"), "run", &subject, format!("Recovery {} sammelt Member-Stände", recovery())),
			_ => {}
		}
		if let Some(p) = pending {
			let errors = p.get("errors").and_then(Json::as_object).map_or(vec![], |e| e.iter().map(|(m, x)| format!("{m}: {}", string(Some(x)))).collect::<Vec<_>>());
			if !errors.is_empty() && state != "pauseIncomplete" {
				let revision = js(number_of(p.get("revision")));
				push(false, format!("run:{subject}:errors:{revision}"), "run", &subject, format!("{} r{revision}: {}", string(p.get("kind")), cut(&errors.join("; "), MAX_ERROR)));
			}
		}
	}
	let stale = STALE_MS;
	let applied = applied_workers(s, now)?;
	for a in assignments {
		let subject = string(a.get("assignmentId"));
		let host = string(a.get("hostId"));
		let report = applied.iter().find(|(h, _, _)| *h == host);
		let state = report.and_then(|(_, _, w)| w.get("assignments")).and_then(|x| x.get(&subject));
		if number_of(a.get("count")) > 0.0 && report.is_none_or(|(_, at, _)| now - at > stale) {
			let since = report.map_or_else(|| "jeher".to_owned(), |(_, at, _)| format!("{} s", js(round((now - at) / 1000.0))));
			push(false, format!("worker:{subject}:stale"), "worker", &subject, format!("Host {host} meldet seit {since} nichts; das beweist nicht, dass Worker beendet sind"));
			continue;
		}
		let Some((_, _, workers)) = report else { continue };
		if truthy(workers.get("blocked")) {
			push(true, format!("worker:{host}:blocked"), "worker", &host, string(workers.get("blocked")));
		}
		let generation = number_of(a.get("generation"));
		if truthy(state.and_then(|x| x.get("rejected"))) {
			push(true, format!("worker:{subject}:rejected"), "worker", &subject, string(state.and_then(|x| x.get("rejected"))));
		} else if number_of(workers.get("generation")) < generation {
			push(false, format!("worker:{subject}:pending:{}", js(generation)), "worker", &subject, format!("Änderung (Generation {}) von Host {host} noch nicht übernommen", js(generation)));
		}
		if truthy(state.and_then(|x| x.get("errors"))) && truthy(state.and_then(|x| x.get("lastError"))) {
			let errors = state.and_then(|x| x.get("errors")).map_or(String::new(), |e| e.as_f64().map_or_else(|| string(Some(e)), js));
			push(false, format!("worker:{subject}:error"), "worker", &subject, format!("{errors} Fehler, zuletzt: {}", string(state.and_then(|x| x.get("lastError")))));
		}
	}
	let mut seen: Vec<String> = vec![];
	for e in listed(s, now, "Capability")? {
		let Some(f) = e.get("fields") else { continue };
		let host = string(f.get("hostId"));
		if seen.contains(&host) {
			continue;
		}
		seen.push(host.clone());
		let mut alert = |key: String, message: String| push(false, key, "host", &host, message);
		if let Some(error) = f.get("metrics").and_then(|m| m.get("workers")).and_then(|w| text(w, "fetchError")) {
			alert(format!("host:{host}:fetch"), format!("Zuweisungen nicht abrufbar: {error}"));
		}
		let age = now - num_of(f, "at").unwrap_or(f64::NAN);
		if age > STALE_MS {
			alert(format!("host:{host}:stale"), format!("letzter Heartbeat vor {} s", (age / 1000.0 + 0.5).floor()));
		}
	}
	// critical first, then by key in code units (a stable sort, as TypeScript's)
	out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.encode_utf16().cmp(b.1.encode_utf16())));
	Ok(Json::Array(out.into_iter().map(|(_, _, a)| a).collect()))
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
		let sources = if kind == "listAlerts" { self.root.as_ref().map_or(Ok((vec![], vec![])), |r| r.alert_sources()) } else { Ok((vec![], vec![])) };
		let done = sources.and_then(|(runs, assigned)| owner.with(|service| {
			let id = control_id(service, now)?;
			service.commit_on(Some(&id), |s, _| if kind == "listAlerts" { collect_alerts_with(s, now, &runs, &assigned) } else { audit_log(s, now, limit_of(args)) })
		}));
		Box::pin(async move { done.map_err(|e| e.message) })
	}
}
