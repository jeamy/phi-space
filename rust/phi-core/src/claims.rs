//! RPC claims and request generations (src/claims.ts): a request is identified by (principal, space, generation,
//! request id); its domain arguments are kept as a hash, its result until its retention ends. The functions run inside
//! the commit that performs the operation, so effect, claim and result are one write.
//!
//! Claims and generations stay the JSON records the TypeScript code writes. Historical (restored) claims, invalid
//! generations, negative claims and claims kept on the disk are not ported; `assert_ported` refuses spaces with them.
use crate::space::{bytes, error, js_cmp, Result, Space};
use crate::state::RpcState;
use hmac::{Hmac, Mac};
use phi_json::{digest_json, hex, obj, Json, Object, FOREVER};
use sha2::Sha256;

/// Records swept per commit at most.
const MAX_RECORDS: usize = 256;
/// What dropping one claim or generation may write.
const SWEEP_COST: f64 = 128.0;

fn type_error(m: &str) -> crate::space::CoreError { error("TypeError", m) }
fn str_of<'a>(v: &'a Json, k: &str) -> Option<&'a str> { v.get(k).and_then(Json::as_str) }
fn num_of(v: &Json, k: &str) -> Option<f64> { v.get(k).and_then(Json::as_f64) }

/// `checkPrincipal`.
fn check_principal(p: Option<&Json>) -> Result<()> {
	let fine = p.is_some_and(|p| str_of(p, "peerId").is_some_and(|id| !id.is_empty()) && p.get("agentId").is_none_or(|a| a.as_str().is_some()));
	if fine { Ok(()) } else { Err(type_error("principal needs a peerId")) }
}

/// `sign`: the generation text for a nonce and its record.
fn sign(key: &str, nonce: &str, rec: &Object) -> String {
	let mut bound = Object::new();
	bound.insert("nonce", nonce.into());
	for (k, v) in rec.iter() {
		bound.insert(k, v.clone());
	}
	let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("any key length");
	mac.update(Json::Object(bound).canonical().expect("finite").as_bytes());
	format!("{nonce}.{}", hex(&mac.finalize().into_bytes()))
}

/// What a request names: its principal, generation and id.
pub struct RequestRef<'a> {
	principal: Option<&'a Json>,
	generation: Option<&'a Json>,
	request_id: Option<&'a Json>,
}
impl<'a> RequestRef<'a> {
	pub fn of(r: Option<&'a Json>) -> Self {
		RequestRef { principal: r.and_then(|r| r.get("principal")), generation: r.and_then(|r| r.get("generation")), request_id: r.and_then(|r| r.get("requestId")) }
	}
	fn request_id(&self) -> String { self.request_id.map_or_else(|| "undefined".into(), crate::space::js_string) }
}

impl Space {
	fn rpc_mut(&mut self) -> &mut RpcState {
		let st = self.state.rpc.get_or_insert_with(|| RpcState {
			generations: Object::new(),
			claims: crate::state::Claims::default(),
			bytes: Some(0.0),
			reserved_bytes: None,
			signing_key: None,
			authority_id: None,
			// nothing in it can be due yet: what is added lowers sweepAt (dueAt), so no sweep runs for nothing
			sweep_at: Some(FOREVER),
			rest: Object::new(),
		});
		if st.bytes.is_none() {
			st.bytes = Some(bytes(&Json::Object(st.claims.entries())) + bytes(&Json::Object(st.generations.clone()))); // from before the tally
		}
		st
	}
	/// `claimBytes`: claims and generations by their running tally, with the reserved result bytes.
	pub(crate) fn claim_bytes(&self) -> f64 {
		let history = 0.0; // restored claims and invalid generations: not ported
		match &self.state.rpc {
			None => history,
			Some(r) => match r.bytes {
				None => history + bytes(&Json::Object(r.claims.entries())) + bytes(&Json::Object(r.generations.clone())),
				Some(b) => history + b + r.reserved_bytes.unwrap_or(0.0),
			},
		}
	}
	fn key_of(&self, r: &RequestRef) -> String {
		let parts = vec![
			r.principal.cloned().unwrap_or(Json::Null),
			self.state.space_id.as_deref().map_or(Json::Null, Json::from),
			r.generation.cloned().unwrap_or(Json::Null),
			r.request_id.cloned().unwrap_or(Json::Null),
		];
		Json::Array(parts).canonical().expect("finite")
	}
	/// Something becomes due for sweeping at `at`: the next sweep must not skip it.
	fn due_at(&mut self, at: f64) {
		let st = self.rpc_mut();
		if st.sweep_at.is_some_and(|s| at < s) {
			st.sweep_at = Some(at);
		}
	}

	/// A new generation for `principal`: it admits new request ids until `admitUntil`.
	pub fn issue_generation(&mut self, now: f64, principal: Option<&Json>, options: &Json) -> Result<Json> {
		self.assert_ported()?;
		check_principal(principal)?;
		self.sweep(now);
		if self.rpc_mut().signing_key.is_none() {
			let key = match options.get("key").and_then(Json::as_str) {
				Some(k) => k.to_owned(),
				None => hex(&self.random_bytes(32)),
			};
			self.rpc_mut().signing_key = Some(key);
		}
		let authority = options.get("authorityId").and_then(Json::as_str).map(str::to_owned).or_else(|| self.rpc_mut().authority_id.clone()).unwrap_or_else(|| "local".into());
		self.rpc_mut().authority_id = Some(authority.clone());
		let nonce = format!("g{}", hex(&self.random_bytes(16)));
		let lim = self.limits();
		let admit_until = now + lim.generation_admit_ms;
		let mut rec = Object::new();
		rec.insert("primaryEpoch", options.get("primaryEpoch").filter(|v| !v.is_null()).cloned().unwrap_or(Json::Number(1.0)));
		rec.insert("principal", principal.cloned().expect("checked"));
		rec.insert("incarnation", self.state.incarnation.as_deref().map_or(Json::Null, Json::from));
		rec.insert("issuedAt", Json::Number(now));
		rec.insert("admitUntil", Json::Number(admit_until));
		rec.insert("spaceId", self.state.space_id.as_deref().map_or(Json::Null, Json::from));
		rec.insert("authorityId", authority.as_str().into());
		let generation = sign(self.state.rpc.as_ref().and_then(|r| r.signing_key.as_deref()).expect("set above"), &nonce, &rec);
		let rec = Json::Object(rec);
		let added = bytes(&rec) + bytes(&Json::String(generation.clone())) + 2.0;
		if self.claim_bytes() + added > lim.max_claim_bytes {
			return Err(error("LimitError", "the generation exceeds maxClaimBytes"));
		}
		self.rpc_mut();
		self.generation_put(&generation, Some(rec));
		self.due_at(admit_until + 1.0);
		self.touch(now);
		*self.rpc_mut().bytes.as_mut().expect("tally") += added;
		Ok(obj! { "generation" => generation, "admitUntil" => admit_until })
	}

	/// Admit a mutating request inside its commit: a known claim is answered from storage, an unknown id is accepted
	/// while its generation admits.
	pub fn admit(&mut self, now: f64, request: Option<&Json>, method: &Json, args: &Json, deadline: &Json, result_bytes: f64) -> Result<Json> {
		self.assert_ported()?;
		let r = RequestRef::of(request);
		check_principal(r.principal)?;
		let id_fine = r.request_id.and_then(Json::as_str).is_some_and(|s| !s.is_empty());
		if !id_fine || r.generation.and_then(Json::as_str).is_none() {
			return Err(type_error("request needs a generation and a requestId"));
		}
		self.sweep(now);
		self.rpc_mut();
		let key = self.key_of(&r);
		let hash = digest_json(&obj! { "method" => method.clone(), "args" => args.clone() }).expect("finite");
		let keep = self.limits().claim_result_ms;
		if let Some(c) = self.state.rpc.as_ref().and_then(|st| st.claims.get(&key)) {
			let c = &c;
			if c.get("method") != Some(method) || str_of(c, "argHash") != Some(hash.as_str()) {
				return Err(error("RequestConflict", format!("request {} was used for different arguments", r.request_id())));
			}
			if str_of(c, "state") == Some("pending") {
				return Ok(obj! { "kind" => "pending", "key" => key.as_str(), "deadline" => c.get("deadline").cloned().unwrap_or(Json::Null) });
			}
			if c.get("resultExpired").is_some() || num_of(c, "decidedAt").is_some_and(|d| d + keep <= now) {
				return Err(error("ResultExpired", format!("request {} was decided; its result is no longer kept", r.request_id())));
			}
			return Ok(if str_of(c, "state") == Some("cancelled") {
				obj! { "kind" => "cancelled", "key" => key.as_str() }
			} else {
				obj! { "kind" => "done", "key" => key.as_str(), "result" => c.get("result").cloned().unwrap_or(Json::Null) }
			});
		}
		self.validate_generation(now, &r)?;
		let mut rec = Object::new();
		rec.insert("method", method.clone());
		rec.insert("argHash", hash.as_str().into());
		rec.insert("deadline", deadline.clone());
		rec.insert("state", "pending".into());
		rec.insert("generation", r.generation.cloned().expect("checked"));
		rec.insert("requestId", r.request_id.cloned().expect("checked"));
		rec.insert("principal", r.principal.cloned().expect("checked"));
		rec.insert("reservedResultBytes", Json::Number(result_bytes));
		let rec = Json::Object(rec);
		let added = bytes(&rec) + bytes(&Json::String(key.clone())) + 2.0;
		if self.claim_bytes() + added + result_bytes > self.limits().max_claim_bytes {
			return Err(error("LimitError", "the request and its reserved result exceed maxClaimBytes"));
		}
		self.claim_put(&key, Some(rec));
		self.touch(now);
		let st = self.rpc_mut();
		*st.bytes.as_mut().expect("tally") += added;
		st.reserved_bytes = Some(st.reserved_bytes.unwrap_or(0.0) + result_bytes);
		Ok(obj! { "kind" => "fresh", "key" => key.as_str(), "deadline" => deadline.clone() })
	}

	/// `validateGeneration`: the generation is known, bound to this space and incarnation, signed, the requester's, and
	/// still admits.
	fn validate_generation(&self, now: f64, r: &RequestRef) -> Result<&Json> {
		check_principal(r.principal)?;
		let expired = |m: String| error("RequestExpired", m);
		let Some(st) = &self.state.rpc else { return Err(expired("generation is unknown".into())) };
		let gen_text = r.generation.map_or_else(|| "undefined".into(), crate::space::js_string);
		let Some(g) = r.generation.and_then(Json::as_str).and_then(|id| st.generations.get(id)) else {
			return Err(expired(format!("generation {gen_text} is unknown or expired")));
		};
		let inc = self.state.incarnation.as_deref().map_or(Json::Null, Json::from);
		if g.get("incarnation") != Some(&inc) {
			return Err(error("IncarnationChanged", format!("generation {gen_text} belongs to an earlier incarnation of this space")));
		}
		let space = self.state.space_id.as_deref().map_or(Json::Null, Json::from);
		let generation = r.generation.and_then(Json::as_str).expect("found by it");
		let nonce = generation.split('.').next().unwrap_or("");
		let signed = st.signing_key.as_deref().zip(g.as_object()).is_some_and(|(key, rec)| generation == sign(key, nonce, rec));
		if g.get("spaceId") != Some(&space) || str_of(g, "authorityId") != st.authority_id.as_deref() || !signed {
			return Err(expired("the generation signature or binding is invalid".into()));
		}
		let same = g.get("principal").map(|p| p.canonical().ok()) == r.principal.map(|p| p.canonical().ok());
		if !same {
			return Err(expired(format!("generation {gen_text} was issued to another principal")));
		}
		if num_of(g, "admitUntil").is_none_or(|u| now > u) {
			return Err(expired(format!("generation {gen_text} no longer admits new requests")));
		}
		Ok(g)
	}

	/// Record the outcome in the commit that decides it. `result` absent: a done claim without a result field.
	pub(crate) fn decide(&mut self, now: f64, key: &str, state: &Json, result: Option<Json>, locked: bool, err: Option<Json>) -> Result<()> {
		let Some(c) = self.rpc_mut().claims.get(key) else { return Err(error("Error", format!("no claim {key}"))) };
		if str_of(&c, "state") != Some("pending") {
			return Ok(());
		}
		let done = state.as_str() == Some("done");
		let before = bytes(&c);
		let result_bytes = if done { result.as_ref().map_or(0.0, bytes) } else { 4.0 };
		let reserved = num_of(&c, "reservedResultBytes");
		if reserved.is_some_and(|r| result_bytes > r) {
			return Err(error("LimitError", "the result exceeds its admission reservation"));
		}
		let st = self.rpc_mut();
		st.reserved_bytes = Some((st.reserved_bytes.unwrap_or(0.0) - reserved.unwrap_or(0.0)).max(0.0));
		// claims are values: the decision replaces the record
		let Json::Object(mut next) = c else { unreachable!("claims are objects") };
		next.remove("reservedResultBytes");
		next.insert("state", state.clone());
		match (done, result) {
			(true, Some(v)) => next.insert("result", v),
			(true, None) => {
				next.remove("result"); // `result: undefined` is not written
			}
			(false, _) => next.insert("result", Json::Null),
		}
		next.insert("decidedAt", Json::Number(now));
		if done {
			if let Some(e) = err {
				next.insert("error", e);
			}
			if locked {
				next.insert("locked", Json::Bool(true));
			}
		}
		let next = Json::Object(next);
		let delta = bytes(&next) - before;
		self.claim_put(key, Some(next));
		let keep = self.limits().claim_result_ms;
		self.due_at(now + keep);
		*self.rpc_mut().bytes.as_mut().expect("tally") += delta;
		self.touch(now);
		Ok(())
	}

	/// `decide` as a line of the driver states it: `outcome` is `{state, result?, locked?, error?}`.
	pub fn decide_line(&mut self, now: f64, key: Option<&Json>, outcome: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let (Some(Json::String(key)), Some(o)) = (key, outcome) else { return Err(crate::space::not_ported("a decision without a key and an outcome")) };
		let state = o.get("state").cloned().unwrap_or(Json::Null);
		let truthy = |k: &str| crate::space::truthy(o.get(k));
		let err = o.get("error").filter(|_| truthy("error")).cloned();
		self.decide(now, key, &state, o.get("result").cloned(), truthy("locked"), err)?;
		Ok(Json::Null)
	}

	/// The current state of a known request. Changes nothing.
	pub fn lookup(&self, now: f64, request: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let r = RequestRef::of(request);
		let key = self.key_of(&r);
		let Some(c) = self.state.rpc.as_ref().and_then(|st| st.claims.get(&key)) else {
			return Err(error("RequestExpired", format!("request {} is unknown", r.request_id())));
		};
		let c = &c;
		let pending = str_of(c, "state") == Some("pending");
		let keep = self.limits().claim_result_ms;
		let expired = c.get("resultExpired").is_some() || (!pending && num_of(c, "decidedAt").is_some_and(|d| d + keep <= now));
		let mut o = Object::new();
		for k in ["state", "deadline", "method", "orphanedAfterRestore", "error"] {
			if let Some(v) = c.get(k) {
				o.insert(k, v.clone());
			}
		}
		if expired {
			o.insert("resultExpired", Json::Bool(true));
		} else if !pending {
			o.insert("result", c.get("result").cloned().unwrap_or(Json::Null));
			if c.get("locked").is_some() {
				o.insert("locked", Json::Bool(true));
			}
		}
		Ok(Json::Object(o))
	}

	/// `pendingClaims`: the open requests. Asked of the map on the disk, never enumerated: it holds them in memory.
	pub fn pending_claims(&self) -> Vec<(String, Json)> {
		let Some(st) = &self.state.rpc else { return vec![] };
		let held = match &st.claims {
			crate::state::Claims::Disk(d) => d.unindexed(),
			crate::state::Claims::Memory(m) => m.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect(),
		};
		held.into_iter().filter(|(_, c)| str_of(c, "state") == Some("pending")).collect()
	}

	/// `resolveAdmission`: what became of a request that may never have arrived. A known one answers as `lookup` does; a
	/// miss says only that this identity may be retried in this epoch.
	pub fn resolve_admission(&self, now: f64, request: Option<&Json>, method: &Json, hash: &Json, epoch: &Json) -> Result<Json> {
		self.assert_ported()?;
		let r = RequestRef::of(request);
		let hex64 = hash.as_str().is_some_and(|h| h.len() == 64 && h.bytes().all(|b| matches!(b, b'a'..=b'f' | b'0'..=b'9')));
		let fine_epoch = epoch.as_f64().is_some_and(|e| (0.0..=9_007_199_254_740_991.0).contains(&e) && e.trunc() == e);
		let named = r.request_id.and_then(Json::as_str).is_some_and(|s| !s.is_empty()) && method.as_str().is_some_and(|m| !m.is_empty());
		if !named || !hex64 || !fine_epoch {
			return Err(type_error("invalid admission resolution binding"));
		}
		let key = self.key_of(&r);
		if let Some(c) = self.state.rpc.as_ref().and_then(|st| st.claims.get(&key)) {
			if c.get("method") != Some(method) || c.get("argHash") != Some(hash) {
				return Err(error("RequestConflict", "resolution changed original method/arguments"));
			}
			return self.lookup(now, request);
		}
		let generation = self.validate_generation(now, &r)?;
		if generation.get("primaryEpoch") != Some(epoch) {
			return Err(error("IncarnationChanged", "missing request cannot be resolved across epochs or legacy generations"));
		}
		let of = |v: Option<&str>| v.map_or(Json::Null, Json::from);
		Ok(obj! {
			"state" => "notAdmitted",
			"spaceId" => of(self.state.space_id.as_deref()),
			"authorityId" => of(self.state.rpc.as_ref().and_then(|st| st.authority_id.as_deref())),
			"incarnation" => of(self.state.incarnation.as_deref()),
			"primaryEpoch" => epoch.clone(),
			"generation" => r.generation.cloned().unwrap_or(Json::Null),
			"requestId" => r.request_id.cloned().unwrap_or(Json::Null),
			"method" => method.clone(),
			"argumentHash" => hash.clone(),
		})
	}

	/// Cancels a pending request. A decided one stays as it is; the view says which.
	pub fn cancel_request(&mut self, now: f64, target: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.sweep(now);
		let r = RequestRef::of(target);
		let key = self.key_of(&r);
		let Some(c) = self.rpc_mut().claims.get(&key) else {
			return Err(error("RequestExpired", format!("request {} is unknown", r.request_id())));
		};
		if str_of(&c, "state") == Some("pending") {
			self.decide(now, &key, &"cancelled".into(), None, false, None)?;
		}
		self.lookup(now, target)
	}

	/// Retention: a decided result is kept `claimResultMs`, then only its hash, until its generation stops admitting;
	/// then the claim goes, and an unused closed generation with it. Bounded per commit. Claims on the disk are asked
	/// through their indexes (`due`, `nextAt`, `hasGroup`), never scanned.
	pub(crate) fn sweep(&mut self, now: f64) {
		let Some(st) = &self.state.rpc else { return };
		if st.sweep_at.is_some_and(|at| now < at) {
			return;
		}
		let keep = self.limits().claim_result_ms;
		let mut next = FOREVER;
		let admit_until = |g: Option<&Json>| g.and_then(|g| num_of(g, "admitUntil"));
		let pick = |c: &Json| {
			let g = str_of(c, "generation").and_then(|id| st.generations.get(id));
			str_of(c, "state") != Some("pending") && num_of(c, "decidedAt").is_some_and(|d| d + keep <= now) && (c.get("resultExpired").is_none() || admit_until(g).is_none_or(|u| u < now))
		};
		let eligible: Vec<String> = match &st.claims {
			crate::state::Claims::Disk(disk) => {
				// the store finds the due ones by its index; a claim whose result is gone waits for its generation, which
				// the loop over generations below accounts for
				let gens: Vec<String> = st.generations.keys().map(str::to_owned).collect();
				let closed: Vec<String> = st.generations.iter().filter(|(_, g)| num_of(g, "admitUntil").is_some_and(|u| u < now)).map(|(id, _)| id.to_owned()).collect();
				let due = disk.due(now - keep, MAX_RECORDS + 1, &closed, &gens, pick);
				if let Some(at) = disk.next_at(now - keep) {
					next = next.min(at + keep);
				}
				due
			}
			crate::state::Claims::Memory(claims) => {
				let mut eligible: Vec<String> = claims
					.iter()
					.filter(|(_, c)| {
						let g = str_of(c, "generation").and_then(|id| st.generations.get(id));
						let Some(decided) = num_of(c, "decidedAt").filter(|_| str_of(c, "state") != Some("pending")) else { return false };
						let gone = c.get("resultExpired").is_some();
						let due = if gone { admit_until(g).map_or(now, |u| u + 1.0) } else { decided + keep };
						if due > now {
							next = next.min(due);
							return false;
						}
						decided + keep <= now && (!gone || admit_until(g).is_none_or(|u| u < now))
					})
					.map(|(k, _)| k.to_owned())
					.collect();
				eligible.sort_by(|a, b| js_cmp(a, b));
				eligible
			}
		};
		let mut changed = false;
		let mut complete = eligible.len() <= MAX_RECORDS;
		for k in eligible.iter().take(MAX_RECORDS) {
			if !self.maintenance_step(SWEEP_COST, now, &format!("claim:{k}")) {
				complete = false;
				break;
			}
			let st = self.state.rpc.as_mut().expect("swept");
			let c = st.claims.get(k).expect("eligible");
			let mut kept = c.clone();
			if c.get("resultExpired").is_none() {
				let Json::Object(mut o) = c.clone() else { unreachable!() };
				o.remove("result");
				o.insert("resultExpired", Json::Bool(true));
				let o = Json::Object(o);
				st.bytes = Some(st.bytes.unwrap_or(0.0) + bytes(&o) - bytes(&c));
				kept = o.clone();
				self.claim_put(k, Some(o));
			}
			let st = self.state.rpc.as_mut().expect("swept");
			let g = str_of(&c, "generation").and_then(|id| st.generations.get(id));
			if admit_until(g).is_none_or(|u| u < now) {
				let gone = bytes(&kept) + bytes(&Json::String(k.clone())) + 2.0;
				st.bytes = Some(st.bytes.unwrap_or(0.0) - gone);
				self.claim_put(k, None);
			}
			changed = true;
		}
		let st = self.state.rpc.as_mut().expect("swept");
		st.rest.remove("sweepCursor"); // a field of earlier versions; no cursor is kept
		let used_in_memory: Option<std::collections::HashSet<String>> = st.claims.memory().map(|m| m.iter().filter_map(|(_, c)| str_of(c, "generation").map(str::to_owned)).collect());
		let gens: Vec<(String, f64)> = st.generations.iter().map(|(id, g)| (id.to_owned(), num_of(g, "admitUntil").unwrap_or(f64::NAN))).collect();
		let (mut removed, mut stopped) = (0, false);
		for (id, until) in gens {
			if until >= now {
				next = next.min(until + 1.0);
				continue;
			}
			let st = self.state.rpc.as_ref().expect("swept");
			let used = match (&used_in_memory, &st.claims) {
				(Some(set), _) => set.contains(&id),
				(None, crate::state::Claims::Disk(d)) => d.has_group(&id),
				(None, crate::state::Claims::Memory(_)) => unreachable!("a set for claims in memory"),
			};
			if used {
				continue;
			}
			if stopped || removed >= MAX_RECORDS || !self.maintenance_step(SWEEP_COST, now, &format!("generation:{id}")) {
				stopped = true;
				complete = false;
				continue;
			}
			let st = self.state.rpc.as_mut().expect("swept");
			let g = st.generations.get(&id).cloned().expect("listed");
			st.bytes = Some(st.bytes.unwrap_or(0.0) - bytes(&g) - bytes(&Json::String(id.clone())) - 2.0);
			self.generation_put(&id, None);
			removed += 1;
			changed = true;
		}
		self.state.rpc.as_mut().expect("swept").sweep_at = Some(if complete { (now + 1.0).max(next) } else { now });
		if changed {
			self.touch(now);
		}
	}

	/// `nextExpiry`'s part for claims: when the next sweep is due.
	pub(crate) fn claims_due(&self) -> Option<f64> {
		let st = self.state.rpc.as_ref()?;
		if let Some(at) = st.sweep_at {
			return Some(at);
		}
		let Some(claims) = st.claims.memory() else {
			return Some(0.0); // claims on the disk are never scanned: a sweep now sets sweepAt
		};
		let keep = self.limits().claim_result_ms;
		let mut min = f64::INFINITY;
		for (_, c) in claims.iter() {
			let Some(decided) = num_of(c, "decidedAt").filter(|_| str_of(c, "state") != Some("pending")) else { continue };
			let at = decided + keep;
			let g = str_of(c, "generation").and_then(|id| st.generations.get(id));
			min = min.min(if c.get("resultExpired").is_some() { at.max(g.and_then(|g| num_of(g, "admitUntil")).unwrap_or(0.0) + 1.0) } else { at });
		}
		let used: std::collections::HashSet<&str> = claims.iter().filter_map(|(_, c)| str_of(c, "generation")).collect();
		for (id, g) in st.generations.iter() {
			if !used.contains(id) {
				min = min.min(num_of(g, "admitUntil").unwrap_or(f64::NAN) + 1.0);
			}
		}
		Some(min)
	}
}
