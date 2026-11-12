//! The wire adapter of the Root (src/federation-rpc.ts): each call to a Member carries an app-key proof, the original grant and a
//! signed delegation of this one call, and what a Member answers is checked against the request the journal bound before it counts.
//! A replicated Member whose installed target moved on by an adopted transition answers for the binding as its successor,
//! and only resolves it; a binding that is no longer installed at all is not resolved here.
use crate::auth::{seal_keyed, Signer};
use crate::remote::ControlClient;
use crate::router::Reprepared;
use phi_core::space::{error, CoreError};
use phi_json::{digest_json, num_of, obj, text, Json, Object};
use phi_wire::Local;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;

/// What a call came to.
#[derive(Debug, PartialEq)]
pub enum Failure {
	/// The line failed: nothing is known of the call.
	Transport(String),
	/// The Member answered with a refusal.
	Refused { code: String, message: String },
}
fn failed(e: CoreError) -> Failure { Failure::Refused { code: e.class.to_owned(), message: e.message } }

/// One proven line to a Member.
pub trait MemberLine {
	fn prove(&self) -> Local<Result<(), String>>;
	fn reply(&self, call: Json) -> Local<Result<Json, String>>;
}
impl MemberLine for Rc<ControlClient> {
	fn prove(&self) -> Local<Result<(), String>> {
		let line = Rc::clone(self);
		Box::pin(async move { ControlClient::prove(&line).await })
	}
	fn reply(&self, call: Json) -> Local<Result<Json, String>> {
		let line = Rc::clone(self);
		Box::pin(async move { ControlClient::reply(&line, &call).await })
	}
}

/// What the Root provides around the calls.
pub trait RootIo {
	type Line: MemberLine;
	/// `RoutingState`.
	fn state(&self) -> R<Json>;
	fn line(&self, member: &str) -> R<Self::Line>;
	fn lease(&self) -> Local<R<Json>>;
	fn grant(&self, principal: &Json) -> Local<R<Json>>;
	fn now(&self) -> f64;
	fn request_id(&self) -> String;
}

fn hash(v: &Json) -> R<String> { digest_json(v).map_err(|_| error("TypeError", "a value that cannot be hashed")) }
fn canonical(v: Option<&Json>) -> Option<String> { v.and_then(|v| v.canonical().ok()) }
fn members(state: &Json) -> Vec<&Json> { state.get("members").and_then(Json::as_object).map_or(vec![], |m| m.iter().map(|(_, v)| v).collect()) }
use phi_json::set;

/// `reference`: the original request a resolution, a poll or a cancel refers to.
pub fn reference(s: &Json) -> R<Json> {
	let principal = s.get("principal").cloned().unwrap_or(Json::Null);
	let args = s.get("args").and_then(Json::as_object).cloned().unwrap_or_default();
	let (method, domain) = phi_service::rpc_domain(text(s, "method").unwrap_or(""), &args, &principal);
	let (Some(request), Some(version)) = (text(s, "requestId").filter(|r| !r.is_empty()), s.get("policyVersion").filter(|v| v.as_f64().is_some_and(|v| v != 0.0))) else {
		return Err(error("Error", "origin claim needs persisted request/policy"));
	};
	let argument = hash(&obj! { "method" => method.as_str(), "args" => domain })?;
	Ok(obj! { "requestId" => request, "requestGeneration" => s.get("generation").cloned().unwrap_or(Json::Null), "method" => method, "argumentHash" => argument, "policyVersion" => version.clone() })
}

/// `receipt`.
pub fn receipt(s: &Json, outcome: &str, result: Option<Json>, evidence: Option<&str>) -> Json {
	let mut o = Object::new();
	for k in ["target", "principal", "method", "generation", "requestId", "argHash"] {
		o.insert(k, s.get(k).cloned().unwrap_or(Json::Null));
	}
	o.insert("outcome", outcome.into());
	if let Some(r) = result {
		o.insert("result", r);
	}
	if let Some(e) = evidence.filter(|e| !e.is_empty()) {
		o.insert("evidence", e.into());
	}
	Json::Object(o)
}

/// `checkedResolution`: an answer counts only for the request it names.
pub(crate) fn checked_resolution(s: &Json, v: &Json) -> R<Json> {
	let review = |why: &str| receipt(s, "needsReview", None, Some(why));
	let r = reference(s)?;
	if !matches!(v, Json::Object(_)) {
		return Ok(review("invalid resolution response"));
	}
	let state = text(v, "state").unwrap_or("");
	let target = s.get("target");
	let of = |k: &str| target.and_then(|t| t.get(k));
	if state == "notAdmitted" {
		let same = v.get("spaceId") == of("spaceId") && v.get("authorityId") == of("authorityId") && v.get("incarnation") == of("dataIncarnation") && v.get("primaryEpoch") == of("primaryEpoch")
			&& v.get("generation") == s.get("generation") && v.get("requestId") == s.get("requestId") && v.get("method") == r.get("method") && v.get("argumentHash") == r.get("argumentHash");
		return Ok(if same { receipt(s, "notAdmitted", None, None) } else { review("invalid current-epoch admission proof") });
	}
	if !["pending", "done", "cancelled"].contains(&state) || v.get("method") != r.get("method") {
		return Ok(review("invalid retained claim response"));
	}
	let truthy = |k: &str| phi_core::space::truthy(v.get(k));
	if truthy("resultExpired") || truthy("unknownOutcome") || truthy("restoredHistory") {
		return Ok(review("retained outcome unavailable"));
	}
	let failure = v.get("error").filter(|e| phi_core::space::truthy(Some(e)));
	let outcome = if failure.is_some() { "failed" } else { state };
	Ok(receipt(s, outcome, v.get("result").cloned(), failure.and_then(|e| text(e, "code"))))
}

/// The inline witness of `invoke`.
fn checked_witness(s: &Json, w: &Json) -> R<Json> {
	let r = reference(s)?;
	let null = Json::Null;
	let b = w.get("binding").unwrap_or(&null);
	let target = s.get("target").unwrap_or(&null);
	let same = text(w, "protocol") == Some("phi-spaces-claim-receipt-v1") && w.get("hostId") == target.get("hostId") && matches!(b, Json::Object(_)) && b.get("principal").is_some_and(|p| matches!(p, Json::Object(_)) && text(p, "peerId").is_some())
		&& b.get("spaceId") == target.get("spaceId") && b.get("authorityId") == target.get("authorityId") && b.get("dataIncarnation") == target.get("dataIncarnation") && b.get("primaryEpoch") == target.get("primaryEpoch")
		&& canonical(b.get("principal")) == canonical(s.get("principal")) && b.get("generation") == s.get("generation") && b.get("requestId") == s.get("requestId") && b.get("method") == r.get("method") && b.get("argumentHash") == r.get("argumentHash");
	if !same {
		return Ok(receipt(s, "needsReview", None, Some("inline claim binding mismatch")));
	}
	let resolution = w.get("resolution").unwrap_or(&null);
	if text(resolution, "state") == Some("notAdmitted") {
		return Ok(receipt(s, "needsReview", None, Some("effect replied without retained admission")));
	}
	checked_resolution(s, resolution)
}

/// `delegationForCall`, signed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn delegation_for_call(call: &Json, principal: &Json, lease: &Json, policy_version: &Json, space_id: &str, primary_epoch: &Json, grant: &Json, target_request: Option<&Json>, now: f64, replica_config_version: Option<&Json>, fresh_id: &str, signer: &Signer, key_id: &str) -> R<Json> {
	let null = Json::Null;
	let args = call.get("args").and_then(Json::as_object).cloned().unwrap_or_default();
	let (method, domain) = phi_service::rpc_domain(text(call, "method").unwrap_or(""), &args, principal);
	let request = call.get("request").filter(|r| !r.is_null());
	let l = lease.get("lease").unwrap_or(&null);
	let mut d = Object::new();
	d.insert("issuer", l.get("routerPeerId").cloned().unwrap_or(Json::Null));
	d.insert("routerLease", lease.clone());
	d.insert("principal", principal.clone());
	d.insert("targetSpace", space_id.into());
	d.insert("targetPrimaryEpoch", primary_epoch.clone());
	d.insert("operation", call.get("method").cloned().unwrap_or(Json::Null));
	d.insert("requestId", request.and_then(|r| r.get("requestId")).cloned().unwrap_or_else(|| fresh_id.into()));
	d.insert("requestGeneration", request.and_then(|r| r.get("generation")).cloned().unwrap_or_else(|| "non-mutating".into()));
	d.insert("argumentHash", hash(&obj! { "method" => method.as_str(), "args" => domain })?.into());
	if let Some(t) = target_request {
		d.insert("targetRequest", t.clone());
	}
	d.insert("policyVersion", policy_version.clone());
	if let Some(v) = replica_config_version {
		d.insert("targetReplicaConfigVersion", v.clone());
	}
	d.insert("issuedAt", now.into());
	let expires = (now + 60_000.0).min(num_of(l, "expiresAt").unwrap_or(f64::NAN)).min(grant.get("grant").and_then(|g| num_of(g, "expiresAt")).unwrap_or(f64::NAN));
	d.insert("expiresAt", expires.into());
	seal_keyed("delegation", Json::Object(d), "delegation", key_id, signer).ok_or_else(|| error("TypeError", "a value that cannot be signed"))
}

/// Methods that go without a delegation (`roundTrip`).
const NO_DELEGATION: [&str; 17] = ["challenge", "prove", "enroll", "enrollStatus", "grant", "keyLookup", "routerLease", "epochNotice", "routingPolicy", "membershipInstruction", "runGateInstruction", "spaceLifecycleInstruction", "workerAssignments", "capabilityHeartbeat", "replicaNotice", "entryDescribe", "entryChanges"];
const NEEDS_REFERENCE: [&str; 6] = ["pollOperation", "resolveOperation", "cancelOperation", "events", "txn", "lease"];

/// One Member's line with what each call there is bound to.
struct Remote<L> {
	line: L,
	principal: Json,
	space: String,
	policy_version: Json,
	primary_epoch: Json,
	reference: Option<Json>,
	replica_config_version: Option<Json>,
}

pub struct FederationRpc<I: RootIo> {
	pub io: I,
	pub signer: Rc<Signer>,
	pub key_id: String,
}

impl<I: RootIo> FederationRpc<I> {
	/// `bound`: the Member of a step's target binding. With `successor`, a replicated Member whose installed target moved
	/// on by an adopted transition (degrade: same host, higher epoch; promotion: another host) also answers for it: same
	/// Space, authority and data incarnation, installed epoch at least the bound one (v3 5.3.1). Such a Member only
	/// resolves the bound request; it never receives its effect.
	fn bound(&self, target: &Json, successor: bool) -> R<(String, bool)> {
		let state = self.io.state()?;
		let all = members(&state);
		let found = all.iter().find(|m| m.get("target").is_some_and(|t| t.get("spaceId") == target.get("spaceId") && t.get("hostId") == target.get("hostId")));
		if let Some(id) = found.filter(|m| canonical(m.get("target")) == canonical(Some(target))).and_then(|m| text(m, "id")) {
			return Ok((id.to_owned(), false));
		}
		let epoch = |t: &Json| t.get("primaryEpoch").and_then(Json::as_f64);
		let next = all.iter().filter(|_| successor).find(|m| {
			let t = m.get("target").unwrap_or(&Json::Null);
			m.get("replication").is_some_and(|r| !r.is_null()) && t.get("spaceId") == target.get("spaceId") && t.get("authorityId") == target.get("authorityId") && t.get("dataIncarnation") == target.get("dataIncarnation") && epoch(t).zip(epoch(target)).is_some_and(|(a, b)| a >= b)
		});
		next.and_then(|m| text(m, "id")).map(|id| (id.to_owned(), true)).ok_or_else(|| error("Error", "target binding no longer installed"))
	}
	fn member_of(&self, target: &Json) -> R<String> { self.bound(target, false).map(|(id, _)| id) }

	/// `remote`: a line, its key proven afresh.
	async fn remote(&self, id: &str, principal: &Json, policy_version: Option<&Json>, reference: Option<Json>) -> Result<Remote<I::Line>, Failure> { self.remote_at(id, principal, policy_version, reference, None).await }
	/// `remote` with the epoch of a bound request, where a successor decides it.
	async fn remote_at(&self, id: &str, principal: &Json, policy_version: Option<&Json>, reference: Option<Json>, bound_epoch: Option<Json>) -> Result<Remote<I::Line>, Failure> {
		let state = self.io.state().map_err(failed)?;
		let m = state.get("members").and_then(|t| t.get(id)).filter(|_| state.get("policy").is_some_and(|p| !p.is_null())).ok_or_else(|| Failure::Transport("Member or policy unavailable".into()))?;
		let target = m.get("target").cloned().unwrap_or(Json::Null);
		let installed = state.get("policy").and_then(|p| p.get("policyVersion")).cloned().unwrap_or(Json::Null);
		let policy_version = reference.as_ref().and_then(|r| r.get("policyVersion")).or(policy_version).cloned().unwrap_or(installed);
		let line = self.io.line(id).map_err(|e| Failure::Transport(e.message))?;
		line.prove().await.map_err(Failure::Transport)?;
		Ok(Remote { line, principal: principal.clone(), space: text(&target, "spaceId").unwrap_or("").to_owned(), policy_version, primary_epoch: bound_epoch.unwrap_or_else(|| target.get("primaryEpoch").cloned().unwrap_or(Json::Null)), reference, replica_config_version: m.get("replication").and_then(|r| r.get("replicaConfigVersion")).cloned() })
	}

	/// `send`: a call under a fresh grant and its own delegation; the reply whole.
	async fn send(&self, r: &Remote<I::Line>, mut call: Json) -> Result<Json, Failure> {
		let method = text(&call, "method").unwrap_or("").to_owned();
		let grant = self.io.grant(&r.principal).await.map_err(|e| Failure::Transport(e.message))?;
		let mut frame = call.get("frame").and_then(Json::as_object).cloned().unwrap_or_default();
		frame.insert("grant", grant.clone());
		if !NO_DELEGATION.contains(&method.as_str()) {
			let lease = self.io.lease().await.map_err(|e| Failure::Transport(e.message))?;
			let target = r.reference.as_ref().filter(|_| NEEDS_REFERENCE.contains(&method.as_str()));
			let d = delegation_for_call(&call, &r.principal, &lease, &r.policy_version, &r.space, &r.primary_epoch, &grant, target, self.io.now(), r.replica_config_version.as_ref(), &self.io.request_id(), &self.signer, &self.key_id).map_err(failed)?;
			frame.insert("delegation", d);
		}
		set(&mut call, "frame", frame);
		set(&mut call, "space", r.space.as_str());
		let reply = r.line.reply(call).await.map_err(Failure::Transport)?;
		if reply.get("ok") == Some(&Json::Bool(true)) {
			return Ok(reply);
		}
		let e = reply.get("error");
		match (e.and_then(|e| text(e, "code")), e.and_then(|e| text(e, "message"))) {
			(Some(code), Some(message)) => Err(Failure::Refused { code: code.to_owned(), message: message.to_owned() }),
			_ => Err(Failure::Transport("the reply is not a protocol reply".into())),
		}
	}
	async fn result(&self, r: &Remote<I::Line>, call: Json) -> Result<Json, Failure> { Ok(self.send(r, call).await?.get("result").cloned().unwrap_or(Json::Null)) }

	/// `step`: a step of a command under a fresh generation, or the transaction's own while that may still admit.
	pub async fn step(&self, id: &str, principal: &Json, method: &str, args: &Json, policy_version: Option<&Json>, origin: Option<&Json>) -> Result<Json, Failure> {
		let state = self.io.state().map_err(failed)?;
		let m = state.get("members").and_then(|t| t.get(id)).ok_or_else(|| Failure::Transport("Member missing".into()))?;
		let target = m.get("target").cloned().unwrap_or(Json::Null);
		let version = policy_version.cloned().unwrap_or_else(|| state.get("policy").and_then(|p| p.get("policyVersion")).cloned().unwrap_or(Json::Null));
		let plain = ["take", "read", "write"].contains(&method);
		let reference_of = origin.filter(|_| !plain).map(reference).transpose().map_err(failed)?;
		let reuse = origin.filter(|o| {
			let (b, txn, a) = (o.get("args"), o.get("result"), args);
			let id_of = txn.and_then(|t| t.get("id")).filter(|i| phi_core::space::truthy(Some(i)));
			let until = num_of(o, "generationAdmitUntil").filter(|u| phi_json::safe_integer(*u));
			text(o, "state") == Some("done") && o.get("policyVersion") == Some(&version) && text(o, "method") == Some("txn") && b.and_then(|b| text(b, "action")) == Some("begin") && id_of.is_some()
				&& ((plain && a.get("txn") == id_of) || (method == "txn" && matches!(text(a, "action"), Some("commit" | "abort")) && a.get("id") == id_of))
				&& canonical(o.get("target")) == canonical(Some(&target)) && canonical(o.get("principal")) == canonical(Some(principal)) && until.is_some_and(|u| u > self.io.now() + 2000.0)
		});
		let generation = match reuse {
			Some(o) => obj! { "generation" => o.get("generation").cloned().unwrap_or(Json::Null), "admitUntil" => o.get("generationAdmitUntil").cloned().unwrap_or(Json::Null) },
			None => {
				let r = self.remote(id, principal, None, None).await?;
				self.result(&r, obj! { "method" => "generation", "args" => Object::new() }).await?
			}
		};
		let mut o = Object::new();
		o.insert("target", target);
		o.insert("principal", principal.clone());
		if let Some(g) = generation.get("generation") {
			o.insert("generation", g.clone());
		}
		if let Some(u) = generation.get("admitUntil").filter(|u| u.as_f64().is_some_and(phi_json::safe_integer)) {
			o.insert("generationAdmitUntil", u.clone());
		}
		o.insert("method", method.into());
		o.insert("args", args.clone());
		o.insert("policyVersion", version);
		if let Some(r) = reference_of {
			o.insert("targetRequest", r);
		}
		Ok(Json::Object(o))
	}

	fn refusal(s: &Json, code: &str, resolving: bool) -> Option<Json> {
		match code {
			"NotCommitted" => Some(receipt(s, "failed", None, Some("NotCommitted"))),
			"ReplicaConfigPending" | "StalePolicyVersion" if !resolving => Some(receipt(s, "notAdmitted", None, Some(code))),
			// a subclass of PermissionError over there: its own name
			"StalePolicyVersion" | "RequestConflict" | "RequestExpired" | "ResultExpired" | "IncarnationChanged" | "TransactionError" | "CompletionViolation" => Some(receipt(s, "needsReview", None, Some(code))),
			"PermissionDenied" => Some(receipt(s, "needsReview", None, Some("PermissionError"))),
			_ => None,
		}
	}

	/// `info`: what the Member says it is, for the status of the Root.
	pub async fn hello(&self, id: &str, principal: &Json) -> Result<Json, Failure> {
		let r = self.remote(id, principal, None, None).await?;
		self.result(&r, obj! { "method" => "hello", "args" => obj! { "protocol" => 1.0 } }).await
	}

	/// `sendEpochNotice`: under a grant, without a delegation.
	pub async fn epoch_notice(&self, id: &str, principal: &Json, signed: &Json) -> Result<Json, Failure> {
		let r = self.remote(id, principal, None, None).await?;
		self.result(&r, obj! { "method" => "epochNotice", "args" => obj! { "signedNotice" => signed.clone() } }).await
	}

	/// `invoke`: the step's effect under its journalled identity. `Err`: nothing is known.
	#[allow(clippy::result_unit_err)]
	pub async fn invoke(&self, s: Json) -> Result<Json, ()> {
		let null = Json::Null;
		// a successor of the binding only resolves: the request may have reached the earlier primary
		if self.bound(s.get("target").unwrap_or(&null), true).map_err(|_| ())?.1 {
			return Box::pin(self.resolve(s)).await;
		}
		let id = self.member_of(s.get("target").unwrap_or(&null)).map_err(|_| ())?;
		let r = self.remote(&id, s.get("principal").unwrap_or(&null), s.get("policyVersion"), s.get("targetRequest").cloned()).await.map_err(|_| ())?;
		let target = s.get("target").unwrap_or(&null);
		let call = obj! { "method" => s.get("method").cloned().unwrap_or(Json::Null), "args" => s.get("args").cloned().unwrap_or(Json::Null),
			"request" => obj! { "generation" => s.get("generation").cloned().unwrap_or(Json::Null), "requestId" => s.get("requestId").cloned().unwrap_or(Json::Null) },
			"frame" => obj! { "authorityId" => target.get("authorityId").cloned().unwrap_or(Json::Null), "primaryEpoch" => target.get("primaryEpoch").cloned().unwrap_or(Json::Null), "claimReceipt" => true } };
		match self.send(&r, call).await {
			Ok(reply) => match reply.get("claimReceipt").filter(|w| phi_core::space::truthy(Some(w))) {
				Some(w) => checked_witness(&s, w).map_err(|_| ()),
				None => Box::pin(self.resolve(s.clone())).await,
			},
			Err(Failure::Refused { code, .. }) => Self::refusal(&s, &code, false).ok_or(()),
			Err(Failure::Transport(_)) => Err(()),
		}
	}

	/// `resolve`: what became of the request. `Err`: nothing is known.
	#[allow(clippy::result_unit_err)]
	pub async fn resolve(&self, s: Json) -> Result<Json, ()> {
		let null = Json::Null;
		// at a successor the delegation keeps the bound epoch: the Member decides the earlier request (v3 6.2)
		let (id, successor) = self.bound(s.get("target").unwrap_or(&null), true).map_err(|_| ())?;
		let reference_of = reference(&s).map_err(|_| ())?;
		let bound_epoch = successor.then(|| s.get("target").and_then(|t| t.get("primaryEpoch")).cloned().unwrap_or(Json::Null));
		let r = self.remote_at(&id, s.get("principal").unwrap_or(&null), s.get("policyVersion"), Some(reference_of.clone()), bound_epoch).await.map_err(|_| ())?;
		let targeted = obj! { "generation" => s.get("generation").cloned().unwrap_or(Json::Null), "requestId" => s.get("requestId").cloned().unwrap_or(Json::Null) };
		let asked = obj! { "method" => "resolveOperation", "args" => obj! { "targetRequest" => targeted.clone(), "method" => reference_of.get("method").cloned().unwrap_or(Json::Null), "argumentHash" => reference_of.get("argumentHash").cloned().unwrap_or(Json::Null), "primaryEpoch" => s.get("target").and_then(|t| t.get("primaryEpoch")).cloned().unwrap_or(Json::Null) } };
		let answer = match self.result(&r, asked).await {
			Err(Failure::Refused { code, .. }) if code == "UnsupportedMethod" => self.result(&r, obj! { "method" => "pollOperation", "args" => obj! { "targetRequest" => targeted, "waitMs" => 0.0 } }).await,
			other => other,
		};
		match answer {
			Ok(v) => checked_resolution(&s, &v).map_err(|_| ()),
			Err(Failure::Refused { code, .. }) => Self::refusal(&s, &code, true).ok_or(()),
			Err(Failure::Transport(_)) => Err(()),
		}
	}

	/// `reprepare`: a step refused before admission, under the current policy when only replica notices changed it.
	#[allow(clippy::result_unit_err)]
	pub async fn reprepare(&self, s: Json) -> Result<Reprepared, ()> {
		let state = self.io.state().map_err(|_| ())?;
		let current = state.get("policy").and_then(|p| p.get("policyVersion")).cloned().unwrap_or(Json::Null);
		let plain = matches!(text(&s, "method"), Some("take" | "read" | "write"));
		if !current.as_f64().is_some_and(|c| c != 0.0) || !s.get("policyVersion").and_then(Json::as_f64).is_some_and(|v| v != 0.0) || s.get("targetRequest").is_some() || !plain {
			return Ok(Reprepared::Refuse);
		}
		let Some((id, successor)) = s.get("target").and_then(|t| self.bound(t, true).ok()) else { return Ok(Reprepared::Refuse) };
		if s.get("policyVersion") == Some(&current) && !successor {
			return Ok(if text(&s, "evidence") == Some("ReplicaConfigPending") { Reprepared::Wait } else { Reprepared::Refuse });
		}
		// only when every policy version since the step's own came from an adopted replica notice
		let notices: Vec<f64> = state.get("noticePolicyVersions").and_then(Json::as_array).map_or(vec![], |v| v.iter().filter_map(Json::as_f64).collect());
		let (from, to) = (s.get("policyVersion").and_then(Json::as_f64).unwrap_or(0.0), current.as_f64().unwrap_or(0.0));
		let mut v = from + 1.0;
		while v <= to {
			if !notices.contains(&v) {
				return Ok(Reprepared::Refuse);
			}
			v += 1.0;
		}
		let null = Json::Null;
		self.step(&id, s.get("principal").unwrap_or(&null), text(&s, "method").unwrap_or(""), s.get("args").unwrap_or(&null), Some(&current), None).await.map(Reprepared::Spec).map_err(|_| ())
	}

	/// `snapshot`: every entry of a template on a Member, page by page.
	pub async fn snapshot(&self, id: &str, principal: &Json, template: &Json, txn: Option<&Json>) -> Result<Json, Failure> {
		let r = self.remote(id, principal, None, None).await?;
		let txn = txn.cloned().unwrap_or(Json::Null);
		let mut entries = vec![];
		let mut args = obj! { "template" => template.clone(), "cursor" => Json::Null, "txn" => txn.clone() };
		let (mut revision, mut first) = (Json::Null, true);
		loop {
			let page = self.result(&r, obj! { "method" => "readAll", "args" => args }).await?;
			if first {
				revision = page.get("rev").cloned().unwrap_or(Json::Null);
				first = false;
			}
			entries.extend(page.get("items").and_then(Json::as_array).cloned().unwrap_or_default());
			let Some(next) = page.get("next").filter(|n| phi_core::space::truthy(Some(n))) else { return Ok(obj! { "entries" => entries, "revision" => revision }) };
			args = obj! { "template" => template.clone(), "token" => page.get("token").cloned().unwrap_or(Json::Null), "cursor" => next.clone(), "txn" => txn.clone() };
		}
	}

	/// `events`: a registration's mailbox.
	pub async fn events(&self, id: &str, principal: &Json, registration: &Json) -> Result<Json, Failure> {
		let reference_of = reference(registration).map_err(failed)?;
		let r = self.remote(id, principal, registration.get("policyVersion"), Some(reference_of)).await?;
		let page = self.result(&r, obj! { "method" => "events", "args" => Object::new() }).await?;
		Ok(obj! { "epoch" => page.get("mailboxEpoch").cloned().unwrap_or(Json::Null), "events" => page.get("events").cloned().unwrap_or(Json::Null), "gap" => phi_core::space::truthy(page.get("gap")) })
	}

	/// `ack`.
	pub async fn ack(&self, id: &str, principal: &Json, epoch: &str, seq: f64) -> Result<(), Failure> {
		let r = self.remote(id, principal, None, None).await?;
		let generation = self.result(&r, obj! { "method" => "generation", "args" => Object::new() }).await?;
		let request = obj! { "generation" => generation.get("generation").cloned().unwrap_or(Json::Null), "requestId" => self.io.request_id() };
		self.result(&r, obj! { "method" => "ack", "request" => request, "args" => obj! { "mailboxEpoch" => epoch, "upTo" => seq } }).await.map(|_| ())
	}

	/// `txnActive`.
	pub async fn txn_active(&self, id: &str, principal: &Json, txn: &str, registration: Option<&Json>) -> Result<bool, Failure> {
		let reference_of = registration.map(reference).transpose().map_err(failed)?;
		let r = self.remote(id, principal, registration.and_then(|g| g.get("policyVersion")), reference_of).await?;
		let v = self.result(&r, obj! { "method" => "txn", "args" => obj! { "action" => "status", "id" => txn } }).await?;
		Ok(text(&v, "state") == Some("active"))
	}
}

