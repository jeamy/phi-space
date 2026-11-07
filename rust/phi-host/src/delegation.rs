//! Double-signed, principal-bound delegation, the Member's side (src/delegation.ts). A router brings a call on a principal's
//! behalf: its own signature, the supervisor's lease, the principal's grant, each bound to the call. Epochs only go up, in a
//! document of their own, and a higher one fences the work older leases left waiting. Issuing leases is the control host's
//! (R6). A replicated Space takes its epoch from its replica configuration (its journal), and new work on it waits until the
//! router adopts that configuration (`ReplicaConfigPending`).
use phi_json::text;
use phi_core::space::permission as denied;
use crate::auth::{signature_holds, signed_by, Algorithm};
use crate::gate::Keys;
use crate::grants::{Bound, Decision, GrantVerifier};
use phi_core::claims::RequestRef;
use phi_core::space::{error, CoreError, Space};
use phi_json::{digest_json, obj, Json, FOREVER};
use phi_service::{rpc_domain, Authorization, Conn, Identity, Policy};
use phi_store::Store;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
const DOC: &str = "phi-spaces.delegation-epochs";
fn number(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }
fn positive(v: Option<&Json>) -> bool { v.and_then(Json::as_f64).is_some_and(|n| n.fract() == 0.0 && n > 0.0 && n <= FOREVER) }
fn safe(v: Option<&Json>) -> bool { v.and_then(Json::as_f64).is_some_and(phi_json::safe_integer) }
fn arg_hash(method: &str, args: &Json) -> R<String> { digest_json(&obj! { "method" => method, "args" => args.clone() }).map_err(|_| denied("a value that cannot be hashed")) }
fn same(a: Option<&Json>, b: Option<&Json>) -> bool { a.and_then(|x| x.canonical().ok()) == b.and_then(|x| x.canonical().ok()) }

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Epochs {
	router: f64,
	control: f64,
	policy: f64,
}

pub struct DelegationOptions {
	pub authority_id: String,
	pub control_space_id: String,
	pub supervisor_peer_id: String,
	pub supervisor: (Algorithm, String),
	pub keys: Rc<dyn Keys>,
	pub grants: GrantVerifier,
	/// The installed policy: its authority and version (a control host reads its own from the store).
	pub policy: InstalledPolicy,
	pub rules: Rc<Policy>,
	pub uncertainty_ms: f64,
	/// The replica configuration of a primary/sync Space by its ID (its journal's `replicaConfigVersion` and
	/// `primaryEpoch`); `None` for other Spaces.
	pub replica_config: Option<ReplicaConfig>,
}
/// The installed policy's authority and version, read with the store at hand.
pub type InstalledPolicy = Rc<dyn Fn(&Store) -> (String, f64)>;
/// A Space's replica configuration by its ID, `None` for a Space that is not replicated.
pub type ReplicaConfig = Rc<dyn Fn(&str) -> Option<Json>>;

pub struct DelegationVerifier {
	o: DelegationOptions,
	/// By epoch key: what the file says, and what this process added since.
	epochs: RefCell<HashMap<String, Epochs>>,
}

/// What a checked delegation allows one call.
struct Delegated {
	verifier: Rc<DelegationVerifier>,
	grant: Decision,
	rules: Rc<Policy>,
	principal: Json,
	transport: String,
	closed_waiter: bool,
	renewal: Option<Option<String>>,
	lease: (f64, f64),
	policy_version: f64,
	known: bool,
	fresh: bool,
	until: f64,
	key: String,
}

impl Authorization for Delegated {
	fn roles(&self) -> Vec<String> { self.grant.roles.clone() }
	fn principal(&self) -> Option<Json> { Some(self.principal.clone()) }
	fn valid_until(&self) -> f64 { self.until }
	fn can_execute_pending(&self, method: &str, type_name: Option<&str>) -> bool { self.grant.can_execute_pending(&self.rules, method, type_name) }
	fn check(&self, now: f64) -> Result<(), String> {
		self.grant.check(now)?;
		if now >= self.until { Err("delegation expired before decision".to_owned()) } else { Ok(()) }
	}
	fn transport_peer_id(&self) -> Option<String> { Some(self.transport.clone()) }
	fn renewal_waiter_id(&self) -> Option<Option<String>> { self.renewal.clone() }
	fn allow_closed_waiter(&self) -> bool { self.closed_waiter }
	fn router_epoch(&self) -> Option<f64> { Some(self.lease.0) }
	fn control_primary_epoch(&self) -> Option<f64> { Some(self.lease.1) }
	fn policy_version(&self) -> Option<f64> { Some(self.policy_version) }
	fn known_request(&self) -> bool { self.known }
	fn check_commit(&self) -> Result<(), String> {
		let e = self.verifier.epochs.borrow().get(&self.key).copied().unwrap_or_default();
		if e.router > self.lease.0 || e.control > self.lease.1 || (self.fresh && e.policy > self.policy_version) { Err("epoch changed before commit".to_owned()) } else { Ok(()) }
	}
}

/// Takes the authorization time from what a lease of an older epoch left waiting.
fn fence_pending(s: &mut Space, now: f64, e: Epochs) {
	let claim_of = |s: &Space, i: usize| -> Option<Json> {
		let w = &s.state.waiters[i];
		let claims = &s.state.rpc.as_ref()?.claims;
		match &w.claim_key {
			Some(k) => claims.get(k),
			None => claims.memory()?.iter().map(|(_, c)| c.clone()).find(|c| text(c, "method") == Some("wait") && text(c, "result") == Some(w.id.as_str())),
		}
	};
	for i in 0..s.state.waiters.len() {
		let Some(c) = claim_of(s, i) else { continue };
		let Some(router) = c.get("routerEpoch").and_then(Json::as_f64) else { continue };
		let control = c.get("controlPrimaryEpoch").and_then(Json::as_f64).unwrap_or(0.0);
		if (router < e.router || control < e.control) && s.state.waiters[i].authorized_until.unwrap_or(FOREVER) > now {
			s.state.waiters[i].authorized_until = Some(now);
			s.touch(now);
		}
	}
}

/// `authorize` of a control host so far: the caller's own grant. Delegated calls to it come with the Root (R6a).
pub fn grants_only(grants: GrantVerifier, rules: Rc<phi_service::Policy>, now: crate::gate::Now) -> phi_service::Authorize {
	Box::new(move |store, call, id, conn| {
		let decision = grants.check(call.get("frame").and_then(|f| f.get("grant")), id, &by_alias(store, call), Some(conn.proof_key.as_deref()), now()).map_err(denied)?;
		decision.check(now()).map_err(denied)?;
		Ok(Rc::new(Bound { decision, policy: Rc::clone(&rules) }) as Rc<dyn Authorization>)
	})
}

/// What a host asks of every call (`authorize` of src/runtime.ts): a router's delegation, or the caller's own grant.
pub fn authorize(verifier: Rc<DelegationVerifier>, now: crate::gate::Now) -> phi_service::Authorize {
	Box::new(move |store, call, id, conn| {
		let frame = call.get("frame");
		if frame.and_then(|f| f.get("delegation")).is_some() {
			return verifier.check(store, call, id, conn, now());
		}
		let decision = verifier.o.grants.check(frame.and_then(|f| f.get("grant")), id, &by_alias(store, call), Some(conn.proof_key.as_deref()), now()).map_err(denied)?;
		decision.check(now()).map_err(denied)?;
		Ok(Rc::new(Bound { decision, policy: Rc::clone(&verifier.o.rules) }) as Rc<dyn Authorization>)
	})
}

/// Decision S-D2: a grant's scope names aliases, so a direct call by Space ID is checked against the alias, as a delegated
/// call is (`aliasOf` in src/runtime.ts). A Space the registry does not know keeps its name and fails the scope as before.
fn by_alias<'a>(store: &phi_store::Store, call: &'a Json) -> std::borrow::Cow<'a, Json> {
	let Some(space) = call.get("space").and_then(Json::as_str) else { return std::borrow::Cow::Borrowed(call) };
	match store.space_info(space).and_then(|i| i.get("alias")).and_then(Json::as_str) {
		Some(alias) if alias != space => {
			let mut scoped = call.clone();
			if let Some(o) = scoped.as_object_mut() { o.insert("space".to_owned(), Json::from(alias)); }
			std::borrow::Cow::Owned(scoped)
		}
		_ => std::borrow::Cow::Borrowed(call),
	}
}

impl DelegationVerifier {
	pub fn new(o: DelegationOptions) -> R<Rc<DelegationVerifier>> {
		if !(0.0..=5000.0).contains(&o.uncertainty_ms) {
			return Err(denied("invalid clock uncertainty"));
		}
		Ok(Rc::new(DelegationVerifier { o, epochs: RefCell::default() }))
	}

	fn lifetime(&self, v: &Json, now: f64) -> R<()> {
		let (issued, expires) = (number(v, "issuedAt"), number(v, "expiresAt"));
		if !safe(v.get("issuedAt")) || !safe(v.get("expiresAt")) || expires <= issued || expires - issued > 60_000.0 || issued > now + self.o.uncertainty_ms || now + self.o.uncertainty_ms >= expires {
			return Err(denied("delegation or lease expired"));
		}
		Ok(())
	}

	fn supervisor(&self, kind: &str, v: &Json, t: &Json) -> R<()> {
		let (algorithm, key) = &self.o.supervisor;
		let good = signed_by(v, t, kind, &self.o.supervisor_peer_id, *algorithm, key);
		if good { Ok(()) } else { Err(denied("invalid supervisor signature")) }
	}

	fn epoch_key(&self, space: &str) -> R<String> { Json::Array(vec![self.o.authority_id.as_str().into(), space.into()]).canonical().map_err(|_| denied("no epoch key")) }

	fn epochs_of(&self, store: &Store, key: &str) -> R<Epochs> {
		if let Some(e) = self.epochs.borrow().get(key) {
			return Ok(*e);
		}
		let stored = store.stored_document(DOC, Some(key)).map_err(|e| error("Unavailable", e.to_string()))?;
		Ok(stored.map_or_else(Epochs::default, |d| Epochs { router: number(&d, "routerEpoch"), control: number(&d, "controlPrimaryEpoch"), policy: number(&d, "policyVersion") }))
	}

	/// The epochs go up, in one commit with the fence they bring.
	fn raise(&self, store: &mut Store, space: &str, key: &str, now: f64, up: impl FnOnce(Epochs) -> R<Epochs>) -> R<()> {
		let before = self.epochs_of(store, key)?;
		let e = up(before)?;
		let value = obj! { "routerEpoch" => e.router, "controlPrimaryEpoch" => e.control, "policyVersion" => e.policy }.to_json_text();
		let done = store.commit(Some(space), now, |s| {
			fence_pending(s, now, e);
			s.doc_writes.push((DOC.to_owned(), key.to_owned(), 1, value));
			Ok(())
		});
		done.map_err(|e| error("Unavailable", e.to_string()))??;
		self.epochs.borrow_mut().insert(key.to_owned(), e);
		Ok(())
	}

	/// `epochNotice`: the supervisor says what is current, before any router does.
	pub fn epoch_notice(&self, store: &mut Store, t: &Json, space: Option<&str>, now: f64) -> R<()> {
		let null = Json::Null;
		let n = t.get("notice").unwrap_or(&null);
		self.supervisor("epoch-notice", n, t)?;
		self.lifetime(n, now)?;
		if text(n, "authorityId") != Some(&self.o.authority_id) || text(n, "controlSpaceId") != Some(&self.o.control_space_id) || !positive(n.get("routerEpoch")) || !positive(n.get("controlPrimaryEpoch")) || !positive(n.get("policyVersion")) {
			return Err(denied("epoch notice binding mismatch"));
		}
		let wanted = space.unwrap_or("");
		let info = store.space_info(wanted).cloned().ok_or_else(|| denied("unknown epoch-notice space"))?;
		let id = text(&info, "spaceId").unwrap_or("").to_owned();
		let key = self.epoch_key(&id)?;
		self.raise(store, &id, &key, now, |e| Ok(Epochs { router: e.router.max(number(n, "routerEpoch")), control: e.control.max(number(n, "controlPrimaryEpoch")), policy: e.policy.max(number(n, "policyVersion")) }))
	}

	/// `check`: all of it binds this call on this connection, or it is refused.
	pub fn check(self: &Rc<Self>, store: &mut Store, call: &Json, transport: &Identity, conn: &Conn, now: f64) -> R<Rc<dyn Authorization>> {
		let null = Json::Null;
		let frame = call.get("frame");
		let t = frame.and_then(|f| f.get("delegation")).unwrap_or(&null);
		let d = t.get("delegation").unwrap_or(&null);
		let signed_lease = d.get("routerLease").unwrap_or(&null);
		let l = signed_lease.get("lease").unwrap_or(&null);
		let peer = conn.peer_id.as_deref();
		let key_id = text(t, "keyId");
		if d.is_null() || l.is_null() || conn.proof_key.is_none() || peer != text(&transport.principal, "peerId") || text(d, "issuer") != peer || text(d, "issuer") != text(l, "routerPeerId") || conn.proof_key.as_deref() != key_id || text(l, "routerKeyId") != key_id {
			return Err(denied("delegation requires its proven router connection"));
		}
		let peer = peer.unwrap_or("");
		let router = self.o.keys.find(store, peer, key_id.unwrap_or("")).filter(|k| k.active && k.roles.iter().any(|r| r == "router") && Some(k.algorithm.name()) == text(t, "algorithm"));
		let verified = router.is_some_and(|k| signature_holds(d, t, "delegation", k.algorithm, &k.public_key));
		if !verified {
			return Err(denied("invalid router signature/key"));
		}
		self.supervisor("router-lease", l, signed_lease)?;
		self.lifetime(l, now)?;
		self.lifetime(d, now)?;
		if text(l, "authorityId") != Some(&self.o.authority_id) || text(l, "controlSpaceId") != Some(&self.o.control_space_id) || !positive(l.get("routerEpoch")) || !positive(l.get("controlPrimaryEpoch")) || number(d, "expiresAt") > number(l, "expiresAt") {
			return Err(denied("lease authority/epochs mismatch"));
		}
		let wanted = call.get("space").and_then(Json::as_str);
		let info = store.space_info(wanted.unwrap_or("default")).cloned();
		let Some(info) = info.filter(|i| i.get("spaceId") == d.get("targetSpace")) else { return Err(denied("delegation audience mismatch")) };
		let space = text(&info, "spaceId").unwrap_or("").to_owned();
		let method = call.get("method").and_then(Json::as_str).unwrap_or("");
		let principal = d.get("principal").unwrap_or(&null);
		if text(d, "operation") != Some(method) || text(principal, "peerId").is_none_or(str::is_empty) || !positive(d.get("policyVersion")) {
			return Err(denied("delegation operation/principal mismatch"));
		}
		let empty = obj! {};
		let args = call.get("args").unwrap_or(&empty);
		let Some(fields) = args.as_object() else { return Err(denied("delegation request/hash mismatch")) };
		let (domain, domain_args) = rpc_domain(method, fields, principal);
		let request = call.get("request");
		if text(d, "argumentHash") != Some(arg_hash(&domain, &domain_args)?.as_str()) || request.is_some_and(|r| r.get("requestId") != d.get("requestId") || r.get("generation") != d.get("requestGeneration")) {
			return Err(denied("delegation request/hash mismatch"));
		}
		let s = &store.reader(Some(&space))?.space;
		let reference_of = |generation: Option<&Json>, id: Option<&Json>| obj! { "principal" => principal.clone(), "generation" => generation.cloned().unwrap_or(Json::Null), "requestId" => id.cloned().unwrap_or(Json::Null) };
		let claim = |r: &Json| s.state.rpc.as_ref().and_then(|c| c.claims.get(&s.key_of(&RequestRef::of(Some(r)))));
		let known = claim(&reference_of(d.get("requestGeneration"), d.get("requestId")));
		let policy_of = |c: &Json| c.get("policyVersion").and_then(Json::as_f64).unwrap_or(1.0);
		let (mut reference, mut missing) = (known.clone(), false);
		// a replicated Space takes its epoch from the replica configuration (journal); its document keeps the epoch it was
		// created with, transitions only change the configuration
		let replica = self.o.replica_config.as_ref().and_then(|f| f(&space));
		let current_epoch = replica.as_ref().and_then(|c| c.get("primaryEpoch")).and_then(Json::as_f64).or_else(|| s.state.rest.get("primaryEpoch").and_then(Json::as_f64)).unwrap_or(1.0);
		let target = d.get("targetRequest").filter(|t| !t.is_null());
		let action = args.get("action").and_then(Json::as_str);
		if let Some(tr) = target {
			let r = reference_of(tr.get("requestGeneration"), tr.get("requestId"));
			reference = claim(&r);
			missing = method == "resolveOperation" && reference.is_none();
			if missing {
				if d.get("policyVersion") != tr.get("policyVersion") || args.get("method") != tr.get("method") || args.get("argumentHash") != tr.get("argumentHash") || args.get("primaryEpoch") != d.get("targetPrimaryEpoch") {
					return Err(denied("missing resolution binding differs"));
				}
				// The same epoch is checked here; an earlier one is decided by the service (NotCommitted needs evidence).
				if d.get("targetPrimaryEpoch").and_then(Json::as_f64) == Some(current_epoch) {
					s.resolve_admission(now, Some(&r), tr.get("method").unwrap_or(&null), tr.get("argumentHash").unwrap_or(&null), d.get("targetPrimaryEpoch").unwrap_or(&null))?;
				} else {
					s.validate_generation(now, &RequestRef::of(Some(&r)))?;
				}
			}
			let bound = reference.as_ref().is_some_and(|c| c.get("method") == tr.get("method") && c.get("argHash") == tr.get("argumentHash") && Some(policy_of(c)) == tr.get("policyVersion").and_then(Json::as_f64) && d.get("policyVersion") == tr.get("policyVersion"));
			if !missing && !bound {
				return Err(denied("targetRequest does not name own bound claim"));
			}
			match method {
				"pollOperation" | "resolveOperation" | "cancelOperation" => {
					if method == "resolveOperation" && (args.get("method") != tr.get("method") || args.get("argumentHash") != tr.get("argumentHash") || args.get("primaryEpoch") != d.get("targetPrimaryEpoch")) {
						return Err(denied("wire resolution binding differs"));
					}
					let a = args.get("targetRequest");
					if !a.is_some_and(|a| a.get("generation") == r.get("generation") && a.get("requestId") == r.get("requestId")) {
						return Err(denied("wire targetRequest differs"));
					}
				}
				"txn" | "lease" => {
					let c = reference.as_ref().expect("bound above");
					let result = c.get("result").unwrap_or(&null);
					let id = args.get("id");
					let own_lease = method == "lease" && text(c, "method") == Some("wait") && id == Some(result);
					let own_txn = text(c, "method") == Some("wait") && (known.is_some() || id.and_then(Json::as_str).and_then(|i| s.state.txns.iter().find(|t| t.id == i)).and_then(|t| t.rest.get("originRequestKey")).and_then(Json::as_str) == Some(s.key_of(&RequestRef::of(Some(&r))).as_str()));
					let txn_of = result.get("txn").map(|t| t.get("id").unwrap_or(t)).or_else(|| result.get("id"));
					if !own_lease && !own_txn && (result.is_null() || id != txn_of) {
						return Err(denied("txn follow-up is not bound to target result"));
					}
				}
				"events" => {
					let c = reference.as_ref().expect("bound above");
					if text(c, "method") != Some("wait") || text(c, "result").is_none() {
						return Err(denied("events renewal must name own waiter registration"));
					}
				}
				_ => return Err(denied("targetRequest forbidden for this follow-up")),
			}
		} else if ["pollOperation", "resolveOperation", "cancelOperation"].contains(&method) || (method == "txn" && action != Some("begin")) || method == "lease" {
			return Err(denied("follow-up requires targetRequest"));
		}
		let target_epoch = number(d, "targetPrimaryEpoch");
		let pending = |c: &Json| error("ReplicaConfigPending", format!("replica configuration {} is not adopted by the router yet", c.get("replicaConfigVersion").and_then(Json::as_f64).map_or_else(|| "undefined".into(), phi_json::number_text)));
		let adopted = |c: &Json| d.get("targetReplicaConfigVersion") == c.get("replicaConfigVersion");
		// a router behind an adopted transition (older epoch, other configuration version) waits for the adoption: new
		// work is pending, not denied
		if let Some(c) = replica.as_ref().filter(|c| reference.is_none() && !missing && positive(d.get("targetPrimaryEpoch")) && target_epoch <= current_epoch && !adopted(c)) {
			return Err(pending(c));
		}
		let frame_epoch = frame.and_then(|f| f.get("primaryEpoch"));
		if !positive(d.get("targetPrimaryEpoch")) || frame_epoch.is_some_and(|e| e.as_f64() != Some(target_epoch)) || target_epoch > current_epoch || (target_epoch < current_epoch && reference.is_none() && !missing) {
			return Err(denied("target epoch does not match new or known request"));
		}
		// new work on a replicated Space needs the router to route under the local replica configuration; follow-ups of
		// operations admitted before the change continue under their original binding
		if let Some(c) = replica.as_ref().filter(|c| reference.is_none() && !adopted(c)) {
			return Err(pending(c));
		}
		let (authority, installed) = (self.o.policy)(store);
		if authority != self.o.authority_id || installed.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
			return Err(denied("new operation must use current installed policy"));
		}
		let version = number(d, "policyVersion");
		let fresh = reference.is_none() && !missing;
		if fresh && version != installed {
			return Err(error("StalePolicyVersion", "new operation must use current installed policy"));
		}
		if known.as_ref().is_some_and(|c| policy_of(c) != version) {
			return Err(denied("retry changed original policy"));
		}
		let closed_waiter = method == "lease" && action == Some("cancel") && reference.as_ref().is_some_and(|c| text(c, "method") == Some("wait"));
		let renewal = (method == "events" && target.is_some()).then(|| reference.as_ref().and_then(|c| text(c, "result")).map(str::to_owned));
		let known_request = reference.is_some();
		let token = frame.and_then(|f| f.get("grant"));
		let g = token.and_then(|t| t.get("grant"));
		let original_key = g.and_then(|g| text(g, "keyId")).filter(|k| !k.is_empty());
		if original_key.is_none() || !same(g.and_then(|g| g.get("principal")), Some(principal)) || !matches!(number(d, "expiresAt").partial_cmp(&g.map_or(f64::NAN, |g| number(g, "expiresAt"))), Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)) {
			return Err(denied("delegation must carry original principal grant"));
		}
		let original = self.o.keys.find(store, text(principal, "peerId").unwrap_or(""), original_key.unwrap_or("")).filter(|k| k.active).ok_or_else(|| denied("original principal key revoked"))?;
		let mut scoped = call.as_object().cloned().unwrap_or_default();
		scoped.insert("space", info.get("alias").cloned().unwrap_or(Json::Null));
		let grant = self.o.grants.check(token, &Identity { principal: principal.clone(), roles: original.roles }, &Json::Object(scoped), None, now).map_err(denied)?;
		let margin = self.o.uncertainty_ms;
		let until = grant.valid_until.min(number(d, "expiresAt") - margin).min(number(l, "expiresAt") - margin);
		let key = self.epoch_key(&space)?;
		let lease = (number(l, "routerEpoch"), number(l, "controlPrimaryEpoch"));
		self.raise(store, &space, &key, now, |e| {
			if lease.0 < e.router || lease.1 < e.control || (fresh && version < e.policy) {
				return Err(denied("delegation superseded by higher epoch/policy"));
			}
			Ok(Epochs { router: e.router.max(lease.0), control: e.control.max(lease.1), policy: e.policy.max(installed) })
		})?;
		Ok(Rc::new(Delegated { verifier: Rc::clone(self), grant, rules: Rc::clone(&self.o.rules), principal: principal.clone(), transport: peer.to_owned(), closed_waiter, renewal, lease, policy_version: version, known: known_request, fresh, until, key }))
	}
}
