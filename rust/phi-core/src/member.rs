//! Member admission (src/member-admission.ts): the same rules for local workers and network clients. A Member that is not
//! serving refuses new work, a draining one finishes what it holds inside a bounded allowance. The membership stays JSON in
//! the document's rest, as a transaction's `completion` does.
use phi_json::text;
use crate::space::routing;
use crate::space::{error, CoreError, Space};
use crate::state::TxnRec;
use phi_json::{digest_json, obj, Json};

type Result<T> = std::result::Result<T, CoreError>;

fn drained(m: impl Into<String>) -> CoreError { error("MemberDrained", m) }
fn number(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }
fn names(v: Option<&Json>) -> Vec<String> { v.and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect()) }
fn sorted(mut v: Vec<String>) -> Vec<String> {
	v.sort_by(|a, b| phi_json::utf16_cmp(a, b));
	v
}

/// `hrw`: rendezvous hashing; the member whose hash of `[value, member]` is the highest.
pub fn hrw(value: &Json, ids: &[String]) -> Result<String> {
	if ids.is_empty() {
		return Err(routing("empty HRW set"));
	}
	let hash = |id: &String| digest_json(&Json::Array(vec![value.clone(), id.as_str().into()])).map_err(|_| routing("a value that has no canonical form"));
	let mut all = ids.iter().map(|i| Ok((hash(i)?, i))).collect::<Result<Vec<(String, &String)>>>()?;
	all.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
	Ok(all[0].1.clone())
}

/// `ruleFor`: the rule of a type; a type without one lives on the default Member.
pub fn rule_for(policy: &Json, type_: &str) -> Json {
	let found = policy.get("rules").and_then(Json::as_array).and_then(|r| r.iter().find(|x| text(x, "type") == Some(type_)));
	found.cloned().unwrap_or_else(|| obj! { "type" => type_, "mode" => "local", "member" => policy.get("default").and_then(|d| d.get("member")).cloned().unwrap_or(Json::Null) })
}

/// `declaredSupertypes`: sorted and without repeats.
pub fn declared_supertypes(policy: &Json, type_: &str, stack: &[String]) -> Result<Vec<String>> {
	if stack.iter().any(|t| t == type_) {
		return Err(routing("cyclic type hierarchy"));
	}
	let rule = policy.get("rules").and_then(Json::as_array).and_then(|r| r.iter().find(|x| text(x, "type") == Some(type_)));
	let mut below = stack.to_vec();
	below.push(type_.to_owned());
	let mut out = vec![];
	for parent in names(rule.and_then(|r| r.get("supertypes"))) {
		let above = declared_supertypes(policy, &parent, &below)?;
		out.push(parent);
		out.extend(above);
	}
	let mut out = sorted(out);
	out.dedup();
	Ok(out)
}

const STOPPED: [&str; 5] = ["adding", "removing", "detached", "recoveryBlocked", "profileFrozen"];
pub(crate) const NOT_SERVING: [&str; 4] = ["adding", "removing", "detached", "recoveryBlocked"];

impl Space {
	pub(crate) fn membership(&self) -> Option<&Json> { self.state.rest.get("membership").filter(|m| !m.is_null()) }
	/// `s.membership?.state ?? "local"`.
	pub fn member_state_or_local(&self) -> &str { self.member_state().unwrap_or("local") }
	pub(crate) fn member_state(&self) -> Option<&str> { self.membership().and_then(|m| text(m, "state")) }
	pub(crate) fn draining(&self) -> bool { self.member_state() == Some("draining") }

	pub fn assert_member_admission(&self, method: &str) -> Result<()> {
		match self.member_state() {
			Some(state) if STOPPED.contains(&state) && !["ack", "cancelOperation", "txn.abort"].contains(&method) => Err(drained(format!("Member admission is {state}"))),
			_ => Ok(()),
		}
	}

	pub(crate) fn initialize_member_txn(&self, t: &mut TxnRec, now: f64) -> Result<()> {
		let Some(a) = self.membership() else { return Ok(()) };
		self.assert_member_admission("txn.begin")?;
		let until = t.expires.min(now + 60_000.0);
		t.rest.insert("completion", obj! { "admissionVersion" => a.get("admissionVersion").cloned().unwrap_or(Json::Null), "until" => until, "remainingBytes" => 65536.0, "remainingCount" => 8.0, "preBoundary" => text(a, "state") == Some("active") });
		if self.draining() {
			t.expires = t.expires.min(until);
		}
		Ok(())
	}

	/// `assertMemberWrite` of a draft that may still prove malformed: such a draft is the later checks' to refuse.
	pub(crate) fn assert_member_write_draft(&self, entry: &Json, supertypes: &[String], txn: Option<&str>, now: f64) -> Result<()> {
		let empty = phi_json::Object::new();
		let type_ = text(entry, "type").unwrap_or("");
		let fields = entry.get("fields").and_then(Json::as_object).unwrap_or(&empty);
		self.assert_member_write(entry, type_, supertypes, fields, txn, now)
	}

	/// `assertMemberWrite`: `txn` as the call named it.
	pub fn assert_member_write(&self, entry: &Json, type_: &str, types: &[String], fields: &phi_json::Object, txn: Option<&str>, now: f64) -> Result<()> {
		self.assert_member_admission("write")?;
		let Some(a) = self.membership() else { return Ok(()) };
		let Some(p) = a.get("policy").filter(|p| !p.is_null()) else { return Err(routing("Member policy is not installed")) };
		let rule = rule_for(p, type_);
		let parents = declared_supertypes(p, type_, &[])?;
		if sorted(types.iter().filter(|t| *t != type_).cloned().collect()) != parents {
			return Err(routing("managed writes need complete declared supertypes"));
		}
		let member_id = text(a, "memberId").unwrap_or("");
		let members = names(rule.get("members"));
		let by = rule.get("by");
		let target = match (text(&rule, "mode"), text(&rule, "variant")) {
			(Some("local"), _) | (Some("sync"), Some("primary")) => text(&rule, "member").map(str::to_owned),
			(Some("expand"), _) if by.and_then(Json::as_str) == Some("type") => Some(hrw(&type_of(&rule), &members)?),
			(Some("expand"), _) if by.is_some_and(|b| b.as_object().is_some()) => {
				let field = by.and_then(|b| text(b, "field")).unwrap_or("");
				if entry.get("fields").is_none_or(Json::is_null) {
					return Err(error("TypeError", "Cannot convert undefined or null to object"));
				}
				let value = fields.get(field).ok_or_else(|| routing("HRW field absent"))?;
				Some(hrw(value, &members)?)
			}
			(Some("expand"), _) => {
				if !members.iter().any(|m| m == member_id) || (txn.is_none_or(str::is_empty) && !self.router_permit) {
					return Err(routing("selection write needs proven Router placement"));
				}
				None
			}
			_ => return Err(routing("unsupported replicated mode")),
		};
		if target.is_some_and(|t| t != member_id) {
			return Err(routing("entry belongs to another Member"));
		}
		if self.draining() {
			let profiles = p.get("completionProfiles").and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
			if profiles.iter().any(|f| text(f, "taskType") == Some(type_)) {
				return Err(drained("draining Member admits no new Task writes"));
			}
			let t = txn.and_then(|id| self.state.txns.iter().find(|t| t.id == id));
			let c = t.and_then(|t| t.rest.get("completion"));
			let (Some(t), Some(c)) = (t, c) else { return Err(drained("no bounded completion allowance")) };
			if now >= number(c, "until") || number(c, "remainingCount") < 1.0 || entry.to_json_text().len() as f64 > number(c, "remainingBytes") {
				return Err(drained("no bounded completion allowance"));
			}
			if c.get("preBoundary") != Some(&Json::Bool(true)) {
				let tasks = t.rest.get("takenTasks").and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
				let equal = |f: &Json, task: &Json| {
					names(f.get("equalFields")).iter().all(|k| matches!((task.get("fields").and_then(|x| x.get(k)), fields.get(k)), (Some(x), Some(y)) if x.canonical().ok() == y.canonical().ok()))
				};
				let valid = profiles.iter().any(|f| tasks.iter().any(|task| names(task.get("types")).iter().any(|x| Some(x.as_str()) == text(f, "taskType")) && names(f.get("resultTypes")).iter().any(|r| r == type_) && equal(f, task)));
				if !valid {
					return Err(drained("new draining transaction may write only bound results"));
				}
			}
		}
		Ok(())
	}

	pub(crate) fn charge_member_write(&mut self, entry: &Json, txn: Option<&str>) {
		if !self.draining() {
			return;
		}
		let size = entry.to_json_text().len() as f64;
		let Some(c) = txn.and_then(|id| self.state.txns.iter_mut().find(|t| t.id == id)).and_then(|t| t.rest.get_mut("completion")).and_then(Json::as_object_mut) else { return };
		let (bytes, count) = (c.get("remainingBytes").and_then(Json::as_f64).unwrap_or(0.0), c.get("remainingCount").and_then(Json::as_f64).unwrap_or(0.0));
		c.insert("remainingBytes", Json::Number(bytes - size));
		c.insert("remainingCount", Json::Number(count - 1.0));
	}

	pub(crate) fn assert_member_take(&mut self, types: &[String], txn: Option<&str>, now: f64) -> Result<()> {
		if self.membership().is_none() {
			return Ok(());
		}
		self.assert_member_admission("take")?;
		let Some(id) = txn.filter(|t| !t.is_empty() && self.draining()) else { return Ok(()) };
		let at = self.state.txns.iter().position(|t| t.id == id).expect("taken under an open transaction");
		let t = &self.state.txns[at];
		let c = t.rest.get("completion");
		if c.and_then(|c| c.get("preBoundary")) == Some(&Json::Bool(true)) {
			return Ok(());
		}
		let a = self.membership().expect("looked at above");
		let profile = a.get("policy").and_then(|p| p.get("completionProfiles")).and_then(Json::as_array).and_then(|l| l.iter().find(|f| text(f, "taskType").is_some_and(|x| types.iter().any(|y| y == x))));
		let Some(f) = profile.cloned() else { return Err(drained("draining task take has no completion profile")) };
		if t.rest.get("takenTasks").and_then(Json::as_array).is_some_and(|l| !l.is_empty()) {
			return Err(drained("one completion task per draining transaction"));
		}
		let Some(c) = c.cloned() else { return Err(drained("transaction has no completion allowance")) };
		let until = number(&c, "until").min(now + number(&f, "maxLeaseMs"));
		let mut next = c.as_object().cloned().unwrap_or_default();
		next.insert("until", Json::Number(until));
		next.insert("remainingBytes", Json::Number(number(&c, "remainingBytes").min(number(&f, "maxResultBytes"))));
		next.insert("remainingCount", Json::Number(number(&c, "remainingCount").min(number(&f, "maxResultCount"))));
		let t = &mut self.state.txns[at];
		t.rest.insert("completion", Json::Object(next));
		t.expires = t.expires.min(until);
		Ok(())
	}

	pub(crate) fn assert_member_renew(&self, id: &str, expires: f64) -> Result<()> {
		if self.membership().is_none() {
			return Ok(());
		}
		self.assert_member_admission("lease.renew")?;
		if !self.draining() {
			return Ok(());
		}
		if let Some(t) = self.state.txns.iter().find(|t| t.id == id) {
			return match t.rest.get("completion") {
				Some(c) if expires <= number(c, "until") => Ok(()),
				_ => Err(drained("draining leases cannot extend completion boundary")),
			};
		}
		// Entry, subscription and wait leases may only be shortened while draining.
		let s = &self.state;
		let current = s.entries.iter().find(|e| e.id == id).map(|e| e.expires).or_else(|| s.regs.iter().find(|r| r.id == id).map(|r| r.expires)).or_else(|| s.waiters.iter().find(|w| w.id == id).map(|w| w.deadline));
		if current.is_none_or(|c| expires > c) { Err(drained("draining leases cannot be extended")) } else { Ok(()) }
	}

	pub(crate) fn has_completion_profile(&self, types: &[String]) -> bool {
		let profiles = self.membership().and_then(|a| a.get("policy")).and_then(|p| p.get("completionProfiles")).and_then(Json::as_array);
		profiles.is_some_and(|l| l.iter().any(|f| text(f, "taskType").is_some_and(|x| types.iter().any(|y| y == x))))
	}

	/// `closeRegistrationsForRemoval`: every subscription ends for a Member that goes.
	pub fn close_registrations_for_removal(&mut self, now: f64) -> Result<()> {
		while !self.state.regs.is_empty() {
			let r = &mut self.state.regs[0];
			r.seq += 1.0;
			let event = obj! { "kind" => "registrationClosed", "eventId" => r.id.as_str(), "seq" => r.seq, "handback" => r.handback.clone(), "target" => r.target.clone(), "reason" => "removing" };
			let consumer = r.consumer.clone();
			self.queue_event(now, event, consumer.as_ref(), true)?;
			self.state.regs.remove(0);
		}
		self.touch(now);
		Ok(())
	}

	/// What is reserved for the bounded completions of open transactions.
	pub(crate) fn completion_bytes(&self) -> f64 { self.state.txns.iter().filter_map(|t| t.rest.get("completion")?.get("remainingBytes")?.as_f64()).sum() }
}

fn type_of(rule: &Json) -> Json { rule.get("type").cloned().unwrap_or(Json::Null) }
