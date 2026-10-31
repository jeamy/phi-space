//! RunGates (src/core.ts; docs/betrieb-und-mobile-steuerung.en.md §6): per-run control state that the core enforces on every
//! take, so direct, waiting and host takes cannot bypass a pause. A take binds its transaction to the gate's revision. The
//! gates stay JSON in the document's rest, as a transaction's `runs` does.
use crate::space::{error, CoreError, Space};
use phi_json::{obj, Json, Object};

type Result<T> = std::result::Result<T, CoreError>;

const MAX_RUN_GATES: usize = 256;
const MAX_GATE_HISTORY: usize = 32;
const GATE_COST: f64 = 1024.0;
const SAFE: f64 = 9_007_199_254_740_991.0;

fn conflict(m: impl Into<String>) -> CoreError { error("RunGateConflict", m) }
fn exhausted(m: impl Into<String>) -> CoreError { error("ResourceExhausted", m) }
fn text<'a>(v: &'a Json, k: &str) -> Option<&'a str> { v.get(k).and_then(Json::as_str) }
fn number(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(0.0) }
fn safe(v: Option<&Json>) -> Option<f64> { v.and_then(Json::as_f64).filter(|n| n.fract() == 0.0 && n.abs() <= SAFE) }
/// `/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/`
fn valid_id(v: Option<&Json>) -> bool {
	v.and_then(Json::as_str).is_some_and(|s| {
		let b = s.as_bytes();
		!b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c))
	})
}
const STATES: [&str; 4] = ["preparing", "running", "paused", "stopped"];

fn valid_command(c: &Json) -> bool {
	let expect = c.get("expect");
	valid_id(c.get("runId")) && valid_id(c.get("commandId")) && safe(c.get("revision")).is_some_and(|r| r >= 1.0) && matches!(text(c, "kind"), Some("prepare" | "release" | "pause" | "resume" | "stop")) && c.get("recoveryId").is_none_or(|r| valid_id(Some(r))) && expect.is_none_or(|e| safe(e.get("revision")).is_some() && text(e, "state").is_some_and(|s| STATES.contains(&s)))
}

impl Space {
	fn gates(&self) -> Option<&Object> { self.state.rest.get("runGates").and_then(Json::as_object) }
	fn gate(&self, run: &str) -> Option<&Json> { self.gates()?.get(run) }
	fn gate_mut(&mut self, run: &str) -> Option<&mut Object> { self.state.rest.get_mut("runGates")?.as_object_mut()?.get_mut(run)?.as_object_mut() }
	fn profiles(&self) -> &[Json] { self.state.rest.get("completionProfiles").and_then(Json::as_array).map_or(&[], Vec::as_slice) }

	/// The run a gated task belongs to: `None` if the type is not gated, `Some(None)` if the gate field is missing.
	pub(crate) fn run_of(&self, types: &[String], fields: &Object) -> Option<Option<String>> {
		for p in self.profiles() {
			let Some(field) = text(p, "gateField") else { continue };
			if text(p, "taskType").is_some_and(|t| types.iter().any(|x| x == t)) {
				return Some(fields.get(field).and_then(Json::as_str).map(str::to_owned));
			}
		}
		None
	}

	pub(crate) fn takeable_run(&self, run: Option<&str>) -> bool {
		run.and_then(|r| self.gate(r)).is_some_and(|g| text(g, "state") == Some("running") && g.get("fence").is_none() && g.get("recovery").is_none())
	}

	pub(crate) fn assert_run_write(&self, type_: &str, supertypes: &[String], fields: &Object, txn: Option<&str>) -> Result<()> {
		let is = |t: &str| t == type_ || supertypes.iter().any(|x| x == t);
		for p in self.profiles() {
			let Some(field) = text(p, "gateField") else { continue };
			let run = fields.get(field).and_then(Json::as_str);
			let task = text(p, "taskType").unwrap_or("");
			if is(task) {
				let open = run.and_then(|r| self.gate(r)).is_some_and(|g| text(g, "state") == Some("preparing") && g.get("fence").is_none() && g.get("recovery").is_none());
				if !open {
					return Err(conflict(format!("{task} entries are written only while their run is preparing")));
				}
			}
			let result = p.get("resultTypes").and_then(Json::as_array).is_some_and(|l| l.iter().filter_map(Json::as_str).any(is));
			let bound = |r: &str, t: &str| self.state.txns.iter().find(|x| x.id == t).and_then(|x| x.rest.get("runs")).and_then(|b| b.get(r)).is_some();
			if result && !matches!((txn, run), (Some(t), Some(r)) if bound(r, t)) {
				return Err(error("CompletionViolation", format!("{type_} needs a transaction bound to its run")));
			}
		}
		Ok(())
	}

	pub(crate) fn check_run_bindings(&self, id: &str) -> Result<()> {
		let Some(runs) = self.state.txns.iter().find(|t| t.id == id).and_then(|t| t.rest.get("runs")).and_then(Json::as_object) else { return Ok(()) };
		for (run, revision) in runs.iter() {
			let fine = self.gate(run).is_some_and(|g| g.get("revision") == Some(revision) && text(g, "state") == Some("running"));
			if !fine {
				return Err(conflict(format!("run {run} changed while transaction {id} was bound to it")));
			}
		}
		Ok(())
	}

	/// The refusal of a lease that would outlast a barrier.
	pub(crate) fn check_run_renewal(&self, id: &str) -> Result<()> {
		let Some(runs) = self.state.txns.iter().find(|t| t.id == id).and_then(|t| t.rest.get("runs")).and_then(Json::as_object) else { return Ok(()) };
		for (run, _) in runs.iter() {
			let Some(g) = self.gate(run) else { continue };
			let doing = if g.get("recovery").is_some() {
				"under recovery"
			} else {
				match g.get("fence").map(|f| text(f, "kind")) {
					None => continue,
					Some(Some("pause")) => "pausing",
					Some(_) => "stopping",
				}
			};
			return Err(conflict(format!("run {run} is {doing}; bound transactions may finish but not extend their lease")));
		}
		Ok(())
	}

	fn bound_txns(&self, run: &str) -> usize { self.state.txns.iter().filter(|t| t.rest.get("runs").is_some_and(|b| b.get(run).is_some())).count() }

	fn record_gate(&mut self, run: &str, c: &Json, state: &str, now: f64) {
		let g = self.gate_mut(run).expect("the gate exists");
		let (revision, command, kind) = (c.get("revision").cloned().unwrap_or(Json::Null), c.get("commandId").cloned().unwrap_or(Json::Null), c.get("kind").cloned().unwrap_or(Json::Null));
		g.insert("revision", revision.clone());
		g.insert("commandId", command.clone());
		g.insert("kind", kind.clone());
		g.insert("state", state.into());
		g.insert("at", Json::Number(now));
		if let Some(Json::Array(h)) = g.get_mut("history") {
			h.push(obj! { "revision" => revision, "commandId" => command, "kind" => kind, "state" => state });
			if h.len() > MAX_GATE_HISTORY {
				let over = h.len() - MAX_GATE_HISTORY;
				h.drain(..over);
			}
		}
	}

	/// Ends a pause/stop barrier once no transaction is bound to the run any more.
	pub(crate) fn complete_fence(&mut self, run: &str, now: f64) {
		let Some(fence) = self.gate(run).and_then(|g| g.get("fence")).cloned() else { return };
		if self.bound_txns(run) > 0 {
			return;
		}
		let g = self.gate_mut(run).expect("just read");
		g.remove("fence");
		let state = if text(&fence, "kind") == Some("pause") { "paused" } else { "stopped" };
		self.record_gate(run, &fence, state, now);
		let g = self.gate_mut(run).expect("just read");
		if fence.get("recoveryId").is_some() && g.get("recovery").and_then(|r| r.get("id")) == fence.get("recoveryId") {
			g.remove("recovery");
			g.remove("historical");
		}
		self.touch(now);
	}

	fn gate_ack(&self, run: &str, c: &Json, state: &str, phase: &str) -> Json {
		let or_null = |v: Option<&Json>| v.filter(|x| !x.is_null()).cloned().unwrap_or(Json::Null);
		let authority = or_null(self.state.rest.get("acceptedAuthorityId").or_else(|| self.state.rest.get("membership").and_then(|m| m.get("authorityId"))));
		obj! {
			"runId" => run, "spaceId" => self.state.space_id.as_deref().map_or(Json::Null, Json::from), "incarnation" => self.state.incarnation.as_deref().map_or(Json::Null, Json::from), "authorityId" => authority,
			"revision" => or_null(c.get("revision")), "state" => state, "commandId" => or_null(c.get("commandId")), "kind" => or_null(c.get("kind")), "phase" => phase, "boundTxns" => self.bound_txns(run) as f64
		}
	}

	/// Every gate mutation is bounded metadata, charged like other maintenance.
	fn spend_gate(&mut self) -> Result<()> {
		if !self.can_charge(GATE_COST) {
			return Err(exhausted("the RunGate change exceeds the remaining commit budget"));
		}
		if self.overhead_bytes() + GATE_COST + self.entry_bytes() > self.limits().max_doc_bytes {
			return Err(exhausted("the RunGate change exceeds maxDocBytes"));
		}
		self.charge(GATE_COST)
	}

	/// `applyRunGate`: one controller command on a run's gate, trusted host code only. The same revision with the same command
	/// returns the stored confirmation. Pause and stop first fence the run and change the gate when no bound transaction is left.
	pub fn apply_run_gate(&mut self, now: f64, c: &Json) -> Result<Json> {
		if !valid_command(c) {
			return Err(error("IllegalArgumentError", "invalid RunGate command"));
		}
		self.assert_ported()?;
		self.settle(now)?;
		if !self.state.rest.contains_key("runGates") {
			self.state.rest.insert("runGates", Json::Object(Object::new()));
		}
		let (run, kind, command_id, revision) = (text(c, "runId").unwrap_or("").to_owned(), text(c, "kind").unwrap_or(""), text(c, "commandId").unwrap_or(""), number(c, "revision"));
		let recovery_id = c.get("recoveryId");
		let Some(g) = self.gate(&run).cloned() else {
			if kind != "prepare" && kind != "stop" {
				return Err(conflict(format!("run {run} has no gate on this Member")));
			}
			if kind == "prepare" && recovery_id.is_some() {
				return Err(conflict("a recovery decision cannot prepare a run"));
			}
			if kind == "prepare" && !self.profiles().iter().any(|p| p.get("gateField").is_some()) {
				return Err(conflict("this Space has no gated completion profile; a gate would not stop any take"));
			}
			if c.get("expect").is_some() {
				return Err(conflict(format!("run {run} has no gate on this Member, but the decision expected one")));
			}
			if self.gates().map_or(0, Object::len) >= MAX_RUN_GATES {
				return Err(exhausted(format!("at most {MAX_RUN_GATES} run gates per Space")));
			}
			self.spend_gate()?;
			let state = if kind == "prepare" { "preparing" } else { "stopped" };
			let fresh = obj! { "runId" => run.as_str(), "revision" => 0.0, "state" => state, "commandId" => command_id, "kind" => kind, "at" => now, "history" => Vec::<Json>::new() };
			if let Some(Json::Object(gates)) = self.state.rest.get_mut("runGates") {
				gates.insert(run.as_str(), fresh);
			}
			self.record_gate(&run, c, state, now);
			self.touch(now);
			return Ok(self.gate_ack(&run, c, state, "applied"));
		};
		let same = |x: &Json| text(x, "commandId") == Some(command_id) && text(x, "kind") == Some(kind);
		let other = || conflict(format!("revision {} of run {run} belongs to another command", phi_json::number_text(revision)));
		let recovery = g.get("recovery");
		if let Some(r) = recovery {
			if recovery_id.is_none() || recovery_id != r.get("id") {
				return Err(conflict(format!("run {run} is under recovery {}; only its decision applies", text(r, "id").unwrap_or(""))));
			}
		}
		if let Some(done) = g.get("history").and_then(Json::as_array).and_then(|h| h.iter().find(|x| number(x, "revision") == revision)) {
			if !same(done) {
				return Err(other());
			}
			return Ok(self.gate_ack(&run, c, text(done, "state").unwrap_or(""), "applied"));
		}
		let fence = g.get("fence");
		if let Some(f) = fence.filter(|f| number(f, "revision") == revision) {
			if !same(f) || f.get("recoveryId") != recovery_id {
				return Err(other());
			}
			self.complete_fence(&run, now);
			let after = self.gate(&run).expect("still there");
			let (state, phase) = (text(after, "state").unwrap_or("").to_owned(), if after.get("fence").is_some() { "fenced" } else { "applied" });
			return Ok(self.gate_ack(&run, c, &state, phase));
		}
		if recovery_id.is_some() && recovery.is_none() {
			return Err(conflict(format!("run {run} is not under recovery {}", recovery_id.and_then(Json::as_str).unwrap_or(""))));
		}
		let recovering = recovery.is_some();
		let state = text(&g, "state").unwrap_or("").to_owned();
		let mut fence = fence.cloned();
		if recovering {
			if let Some(e) = c.get("expect") {
				if number(&g, "revision") != number(e, "revision") || Some(state.as_str()) != text(e, "state") {
					return Err(conflict(format!("run {run} changed since the reviewed view ({state}/{}); review again", phi_json::number_text(number(&g, "revision")))));
				}
			}
			if let Some(f) = fence.take() {
				if self.bound_txns(&run) > 0 {
					return Err(conflict(format!("run {run} still has bound transactions under an unfinished {}", text(&f, "kind").unwrap_or(""))));
				}
				self.gate_mut(&run).expect("read above").remove("fence"); // an unfinished barrier of the old history: the reviewed decision replaces it
			}
		}
		let restored = g.get("restored");
		let top = number(&g, "revision").max(fence.as_ref().map_or(0.0, |f| number(f, "revision"))).max(restored.map_or(0.0, |r| number(r, "maxRevision")));
		if revision <= top {
			return Err(conflict(format!("revision {} of run {run} is older than the gate", phi_json::number_text(revision))));
		}
		if let Some(f) = &fence {
			return Err(conflict(format!("run {run} has an unfinished {} at revision {}", text(f, "kind").unwrap_or(""), phi_json::number_text(number(f, "revision")))));
		}
		if state == "stopped" && !(recovering && kind == "stop") {
			return Err(conflict(format!("run {run} is stopped")));
		}
		if recovering && restored.and_then(|r| text(r, "state")) == Some("stopped") && kind != "stop" {
			return Err(conflict(format!("run {run} was stopped in the restored history")));
		}
		// Under recovery a decision ends in paused or stopped; a resume follows only after that barrier.
		let from: &[&str] = match (recovering, kind) {
			(true, "pause") => &["running", "paused"],
			(true, "stop") => &["preparing", "running", "paused", "stopped"],
			(true, _) | (false, "prepare") => &[],
			(false, "release") => &["preparing"],
			(false, "resume") => &["paused"],
			(false, "pause") => &["running"],
			_ => &["preparing", "running", "paused"],
		};
		if !from.contains(&state.as_str()) {
			return Err(conflict(format!("cannot {kind} run {run} while it is {state}{}", if recovering { " under recovery" } else { "" })));
		}
		self.spend_gate()?;
		if kind == "release" || kind == "resume" {
			self.record_gate(&run, c, "running", now);
			self.touch(now);
			self.serve(now)?; // waiting takes may now match
			return Ok(self.gate_ack(&run, c, "running", "applied"));
		}
		if state != "running" {
			self.record_gate(&run, c, if kind == "pause" { "paused" } else { "stopped" }, now);
			if recovering {
				let g = self.gate_mut(&run).expect("read above");
				g.remove("recovery");
				g.remove("historical");
			}
			self.touch(now);
			let state = text(self.gate(&run).expect("read above"), "state").unwrap_or("").to_owned();
			return Ok(self.gate_ack(&run, c, &state, "applied"));
		}
		let mut f = obj! { "revision" => revision, "commandId" => command_id, "kind" => kind, "at" => now };
		if let (true, Some(id), Json::Object(o)) = (recovering, recovery_id, &mut f) {
			o.insert("recoveryId", id.clone());
		}
		self.gate_mut(&run).expect("read above").insert("fence", f);
		self.touch(now);
		self.complete_fence(&run, now);
		let after = self.gate(&run).expect("read above");
		let (state, phase) = (text(after, "state").unwrap_or("").to_owned(), if after.get("fence").is_some() { "fenced" } else { "applied" });
		Ok(self.gate_ack(&run, c, &state, phase))
	}

	/// `assertGatedProfilesKept`: every path that replaces completion profiles must keep the gates of unstopped runs.
	pub(crate) fn assert_gated_profiles_kept(&self, profiles: &[Json]) -> Result<()> {
		let active = self.gates().is_some_and(|g| g.iter().any(|(_, x)| text(x, "state") != Some("stopped")));
		let lost = self.profiles().iter().filter(|o| o.get("gateField").is_some()).any(|o| !profiles.iter().any(|p| p.get("taskType") == o.get("taskType") && p.get("gateField") == o.get("gateField")));
		if active && lost { Err(conflict("gated profiles cannot change while a run is not stopped")) } else { Ok(()) }
	}
}
