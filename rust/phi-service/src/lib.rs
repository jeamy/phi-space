//! The `space` service, ported from src/service.ts and the part of src/client.ts it uses: one call in, one reply out, on a
//! store. No network here (phi-wire), and no waiting: a call that has to wait comes back as `Outcome::Wait`, and its
//! transport looks again with `resume` when a commit or the clock gives a reason. The identity comes from the connection,
//! never from the call. A reply may rest on commits still on their way to the disk: the transport sends it once
//! `Store::durable` has reached the `mark` it comes with (a reader sees what is committed, not only what is durable).
//!
//! Commit boundaries are those of the TypeScript client: every maintenance round is a commit of its own, a snapshot read
//! is none. Revisions and the change stream show them, so they are part of the contract.
mod background;
pub mod entry;

use phi_core::claims::RequestRef;
use phi_core::mailbox::principal_id;
use phi_core::snapshot::Snapshots;
use phi_core::space::{deadline_of, deep_equal, error, too_small, CoreError, Limits, Template, ANY};
use phi_core::Space;
use phi_json::{digest_json, obj, parse_repairing, Json, Object, FOREVER};
use phi_store::{Store, DEFAULT_ALIAS};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

pub const PROTOCOL_VERSION: f64 = 1.0;
pub const METHODS: [&str; 20] = ["hello", "generation", "write", "read", "take", "pollOperation", "resolveOperation", "cancelOperation", "readAll", "count", "stats", "spaces", "txn", "lease", "changes", "wait", "notify", "events", "ack", "batch"];
const MUTATING: [&str; 10] = ["write", "read", "take", "cancelOperation", "txn", "lease", "wait", "notify", "ack", "batch"];
/// A long poll looks again at the latest after this long even without a commit (a decision that came without one).
const POLL_FALLBACK_MS: f64 = 1000.0;
/// After a look, a waiting call looks no sooner than this however busy the Space is. TypeScript keeps 25 ms because a look
/// is dear there; here a look is a lookup, and at 25 ms a commit that means nothing to the call made the one that serves it
/// wait (the steps of `spaces-mmo` under load: p50 22 ms against 11 ms).
const POLL_GAP_MS: f64 = 2.0;
/// Without `wake_on_commit`: look again every 50 ms.
const SLEEP_MS: f64 = 50.0;
const NO_WAIT: f64 = 0.0;
pub const DEFAULT_MAX_FRAME_BYTES: f64 = phi_core::space::DEFAULT_LIMITS.max_frame_bytes;

type R<T> = Result<T, CoreError>;
fn bad(m: impl Into<String>) -> CoreError { error("Bad", m) }
fn denied(m: impl Into<String>) -> CoreError { error("Denied", m) }

// ---- identity and rights

fn check(auth: &Option<Rc<dyn Authorization>>, now: f64) -> R<()> {
	match auth {
		Some(a) => a.check(now).map_err(|m| error("PermissionError", m)),
		None => Ok(()),
	}
}
/// Whether `authorize_pending` would give a waiter of `request` a new authorization time.
fn renews_pending(s: &Space, request: &Json, a: &dyn Authorization) -> bool {
	let key = s.key_of(&RequestRef::of(Some(request)));
	s.state.waiters.iter().any(|w| w.claim_key.as_deref() == Some(key.as_str()) && w.authorized_until != Some(a.valid_until()) && pending_allowed(w, a))
}
fn pending_allowed(w: &phi_core::state::WaiterRec, a: &dyn Authorization) -> bool {
	a.can_execute_pending(if w.take { "take" } else { "read" }, w.template.get("type").and_then(Json::as_str))
}
fn authorize_pending(s: &mut Space, now: f64, request: &Json, auth: &Option<Rc<dyn Authorization>>) -> R<()> {
	let Some(a) = auth else { return Ok(()) };
	let key = s.key_of(&RequestRef::of(Some(request)));
	for i in 0..s.state.waiters.len() {
		let w = &s.state.waiters[i];
		if w.claim_key.as_deref() == Some(key.as_str()) && pending_allowed(w, a.as_ref()) {
			claim_metadata(s, &key, auth)?;
			s.state.waiters[i].authorized_until = Some(a.valid_until());
			s.touch(now);
		}
	}
	Ok(())
}
fn guarded(guard: &Option<Rc<dyn Guard>>, s: &Space) -> R<()> {
	if let Some(g) = guard {
		g.host()?;
		g.space(s)?;
	}
	Ok(())
}
/// What opening a commit asks of a host's decision (`doc` of src/client.ts), maintenance included.
fn host_checked(s: &mut Space, auth: &Option<Rc<dyn Authorization>>) -> R<()> {
	if let Some(a) = auth {
		a.check_commit().map_err(|m| error("PermissionError", m))?;
	}
	s.router_permit = auth.as_ref().is_some_and(|a| a.router_epoch().is_some_and(|e| e != 0.0));
	Ok(())
}
/// `claimMetadata`: who brought the request, for the checks of later calls on it.
fn claim_metadata(s: &mut Space, key: &str, auth: &Option<Rc<dyn Authorization>>) -> R<()> {
	let Some(a) = auth else { return Ok(()) };
	s.set_metadata(key, &[("policyVersion", a.policy_version().map(Json::Number)), ("transportPeerId", a.transport_peer_id().map(Json::String)), ("routerEpoch", a.router_epoch().map(Json::Number)), ("controlPrimaryEpoch", a.control_primary_epoch().map(Json::Number))])
}
fn check_transaction_rights(s: &Space, txn: &str, auth: &Option<Rc<dyn Authorization>>) -> R<()> {
	let Some(a) = auth else { return Ok(()) };
	for e in &s.state.entries {
		let uses = [(e.written_under.as_deref() == Some(txn), "write"), (e.taken_by.as_deref() == Some(txn), "take"), (e.read_by.iter().any(|t| t == txn), "read")];
		for (_, method) in uses.iter().filter(|(on, _)| *on) {
			if !e.types.iter().any(|t| a.can_execute_pending(method, Some(t))) {
				return Err(error("PermissionError", format!("current grant cannot {method} transaction entry {}", e.id)));
			}
		}
	}
	Ok(())
}
fn check_renewal(s: &Space, id: &str, auth: &Option<Rc<dyn Authorization>>) -> R<()> {
	let Some(a) = auth else { return Ok(()) };
	if s.state.txns.iter().any(|t| t.id == id) { check_transaction_rights(s, id, auth)?; }
	let entry = s.state.entries.iter().find(|e| e.id == id).is_some_and(|e| !e.types.iter().any(|t| a.can_execute_pending("write", Some(t))));
	let reg = s.state.regs.iter().find(|r| r.id == id).is_some_and(|r| !a.can_execute_pending("notify", r.template.get("type").and_then(Json::as_str)));
	let waiter = s.state.waiters.iter().find(|w| w.id == id).is_some_and(|w| !pending_allowed(w, a.as_ref()));
	if entry || reg || waiter { return Err(error("PermissionError", "current grant cannot renew the original lease operation")); }
	Ok(())
}

/// What a transport knows about a connection.
#[derive(Clone, Debug)]
pub struct Conn {
	pub peer_id: Option<String>,
	/// What the host in front of the transport made of the connection (`IdentityAdapter`); without it the static table.
	pub identity: Option<Identity>,
	/// The key the connection proved.
	pub proof_key: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Identity {
	pub principal: Json,
	pub roles: Vec<String>,
}
/// What a host decided about one call (`DecisionAuthorization` of src/service.ts): it narrows the roles and rules what may
/// still run on the caller's behalf.
pub trait Authorization {
	fn roles(&self) -> Vec<String>;
	fn principal(&self) -> Option<Json> { None }
	fn valid_until(&self) -> f64;
	fn can_execute_pending(&self, method: &str, type_name: Option<&str>) -> bool;
	/// Again inside each commit: the right may have ended since the call came in.
	fn check(&self, now: f64) -> Result<(), String>;
	/// The peer that carried the call, where that is not the principal's (a router).
	fn transport_peer_id(&self) -> Option<String> { None }
	/// `Some`: only this waiter is renewed by the call, or none.
	fn renewal_waiter_id(&self) -> Option<Option<String>> { None }
	fn allow_closed_waiter(&self) -> bool { false }
	fn router_epoch(&self) -> Option<f64> { None }
	fn control_primary_epoch(&self) -> Option<f64> { None }
	fn policy_version(&self) -> Option<f64> { None }
	/// The call continues a request this host knows.
	fn known_request(&self) -> bool { false }
	/// Inside each commit, with what only the host keeps (`checkTx`).
	fn check_commit(&self) -> Result<(), String> { Ok(()) }
}
pub(crate) type EpochForSpace = Rc<dyn Fn(&mut Store, Option<&str>) -> f64>;
/// The Space by name and the epoch of the request; the evidence with its `hash`.
pub(crate) type PromotionProof = Rc<dyn Fn(Option<&str>, f64) -> Option<Json>>;
pub type Authorize = Box<dyn Fn(&mut Store, &Json, &Identity, &Conn) -> Result<Rc<dyn Authorization>, CoreError>>;

/// What a host demands of everything served (`installBootGuard`): of the host, and of each Space read or committed.
pub trait Guard {
	fn host(&self) -> R<()>;
	fn space(&self, s: &Space) -> R<()>;
}

/// A role allows a set of methods (`None`: all), optionally only for entries of some types.
#[derive(Clone, Debug)]
pub struct RolePolicy {
	pub methods: Option<Vec<String>>,
	pub types: Option<Vec<String>>,
}
pub type Policy = HashMap<String, RolePolicy>;

pub fn default_policy() -> Policy {
	let list = |m: &[&str]| Some(m.iter().map(|s| s.to_string()).collect());
	let role = |methods| RolePolicy { methods, types: None };
	let all = role(list(&METHODS));
	HashMap::from([
		("admin".to_owned(), role(None)),
		("host".to_owned(), all.clone()),
		("member".to_owned(), all),
		("resolution".to_owned(), role(list(&["hello", "pollOperation", "resolveOperation", "cancelOperation", "txn", "lease"]))),
		("observer".to_owned(), role(list(&["hello", "generation", "read", "pollOperation", "resolveOperation", "cancelOperation", "readAll", "count", "stats", "spaces", "changes", "notify", "events", "ack"]))),
		("unpaired".to_owned(), role(list(&["hello", "generation"]))),
	])
}

/// The types a call may touch: `None` every type.
type Grant = Option<HashSet<String>>;

pub struct Options {
	pub identity: HashMap<String, Identity>,
	pub policy: Policy,
	/// A host's check of each call; `None` for the standalone service.
	pub authorize: Option<Authorize>,
	pub guard: Option<Rc<dyn Guard>>,
	pub now: Box<dyn Fn() -> f64>,
	/// The host's id where it is not the registry's.
	pub host_id: Option<String>,
	pub authority_id: String,
	pub primary_epoch: f64,
	/// `epochForSpace`: the primary epoch of a Space by its name, where it is not `primary_epoch` for all (a federation
	/// host: [`space_epoch`]).
	pub epoch_for_space: Option<EpochForSpace>,
	/// v3 6.2: evidence that every writer of epochs after the request's is fenced and this primary holds their complete
	/// history (`promotion_evidence` of its journal); `None` when it cannot be shown. Without it an unknown older request
	/// stays IncarnationChanged (needsReview), never NotCommitted.
	pub promotion_proof: Option<PromotionProof>,
	pub max_poll_ms: f64,
	pub max_pending_per_principal: f64,
	pub max_pending_per_peer: f64,
	pub max_calls_per_window: f64,
	pub rate_window_ms: f64,
	/// Long polls end at the commit that serves them instead of looking every 50 ms.
	pub wake_on_commit: bool,
}
impl Options {
	/// Every connection is `peer`, with the member role (the standalone service).
	pub fn single_peer(peer: &str) -> Options {
		let identity = Identity { principal: obj! { "peerId" => peer }, roles: vec!["member".into()] };
		let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after 1970").as_millis() as f64;
		Options { identity: HashMap::from([(peer.to_owned(), identity)]), policy: default_policy(), authorize: None, guard: None, now: Box::new(now), host_id: None, authority_id: "local".into(), primary_epoch: 0.0, epoch_for_space: None, promotion_proof: None, max_poll_ms: 25_000.0, max_pending_per_principal: 32.0, max_pending_per_peer: 128.0, max_calls_per_window: 1024.0, rate_window_ms: 1000.0, wake_on_commit: false }
	}
}

// ---- what a transport gets

/// A call that waits. `look` again with `Service::resume`.
pub struct Parked {
	c: Rc<Ctx>,
	kind: Kind,
	end: f64,
}
enum Kind {
	/// A read or take whose answer is the end of its own poll.
	Operation(Json),
	Poll(Json),
	Changes { after: f64, max_bytes: f64, stream_id: Option<Json> },
	Events { o: Object },
}
impl Parked {
	/// How long the transport may sleep at most before it looks again, whatever commits.
	pub fn sleep_ms(&self, now: f64, wake_on_commit: bool) -> f64 {
		let left = (self.end - now).max(1.0);
		let most = if !wake_on_commit { left.min(SLEEP_MS) } else if matches!(self.kind, Kind::Operation(_) | Kind::Poll(_)) { left.min(POLL_FALLBACK_MS) } else { left };
		most.max(1.0)
	}
	/// After a look, the next comes no sooner than this however busy the Space is.
	pub fn gap_ms(&self) -> f64 { if matches!(self.kind, Kind::Changes { .. }) { 0.0 } else { POLL_GAP_MS } }
}
pub enum Outcome {
	/// The reply's text, to send once the store's durable count has reached `mark`.
	Done { text: String, mark: u64 },
	Wait(Box<Parked>),
}

/// What every step of a call needs of it.
#[derive(Clone)]
struct Ctx {
	principal: Json,
	roles: Vec<String>,
	request: Option<Json>,
	/// `None`: the default Space.
	space: Option<String>,
	/// Who acts (`principalId`).
	as_: Json,
	grant: Grant,
	auth: Option<Rc<dyn Authorization>>,
	frame_bytes: f64,
	/// The frame the transport allows, for the reply's last check.
	max_frame: f64,
	claim: Option<(Grant, Json)>,
}

fn is_obj(v: Option<&Json>) -> bool { matches!(v, Some(Json::Object(_))) }
fn str_of(v: Option<&Json>, what: &str) -> R<String> {
	match v {
		Some(Json::String(s)) if !s.is_empty() => Ok(s.clone()),
		_ => Err(bad(format!("{what} must be a non-empty string"))),
	}
}
fn int(v: Option<&Json>, what: &str, min: f64) -> R<f64> {
	match v {
		Some(Json::Number(x)) if x.is_finite() && x.trunc() == *x && *x >= min => Ok(*x),
		_ => Err(bad(format!("{what} must be an integer >= {}", phi_json::number_text(min)))),
	}
}
fn opt_int(v: Option<&Json>, what: &str, min: f64) -> R<Option<f64>> {
	match v {
		None | Some(Json::Null) => Ok(None),
		v => int(v, what, min).map(Some),
	}
}
/// A checked template: the value as it came (a null one for none) and its reading.
fn template(v: Option<&Json>) -> R<(Json, Template)> {
	let Some(v) = v.filter(|v| !v.is_null()) else { return Ok((Json::Null, Template::Any)) };
	let Json::Object(o) = v else { return Err(bad("template must be an object or null")) };
	if o.get("type").is_some_and(|t| !t.is_null() && t.as_str().is_none()) {
		return Err(bad("template.type must be a string"));
	}
	if o.get("fields").is_some_and(|f| !matches!(f, Json::Object(_))) {
		return Err(bad("template.fields must be an object"));
	}
	if o.get("id").is_some_and(|t| !t.is_null() && t.as_str().is_none()) {
		return Err(bad("template.id must be a string"));
	}
	Ok((v.clone(), Template::from_json(Some(v))?))
}
fn template_type(v: &Json) -> Option<Vec<String>> { v.get("type").and_then(Json::as_str).filter(|t| !t.is_empty()).map(|t| vec![t.to_owned()]) }
/// A lease or timeout in ms, or "forever".
fn duration(v: Option<&Json>, what: &str, dflt: f64) -> R<f64> {
	match v {
		None | Some(Json::Null) => Ok(dflt),
		Some(Json::String(s)) if s == "forever" => Ok(FOREVER),
		v => int(v, what, 0.0),
	}
}
fn string_list(v: &Json, message: &str) -> R<Vec<String>> {
	match v {
		Json::Array(a) if a.iter().all(|t| t.as_str().is_some()) => Ok(a.iter().map(|t| t.as_str().expect("checked").to_owned()).collect()),
		_ => Err(bad(message)),
	}
}
/// The principal key: `peer/agent` or `peer`.
fn principal_key(p: &Json) -> String {
	let peer = p.get("peerId").and_then(Json::as_str).unwrap_or("");
	match p.get("agentId").and_then(Json::as_str).filter(|a| !a.is_empty()) {
		Some(a) => format!("{peer}/{a}"),
		None => peer.to_owned(),
	}
}
fn fail(code: &str, message: &str, required: Option<f64>) -> String {
	let mut e = obj! { "code" => code, "message" => message };
	if let (Some(r), Json::Object(o)) = (required, &mut e) {
		o.insert("requiredBytes", Json::Number(r));
	}
	obj! { "ok" => false, "error" => e }.to_json_text()
}
/// The last check of any reply, a refusal too.
fn carried(text: String, max_frame: f64) -> String { if text.len() as f64 > max_frame { fail("ResourceExhausted", "the transport frame cannot carry this response", None) } else { text } }
/// A primary/sync commit was sealed and not confirmed (src/service.ts `sealedReply`): the caller keeps resolving the same
/// request, its outcome may be in the sealed candidate.
pub fn sealed_reply(revision: f64) -> String {
	fail("CommitSealed", &format!("a commit of this Space is sealed but not confirmed (revision {}); the outcome is pending, poll or retry the same request", phi_json::number_text(revision)), None)
}
fn store_failed(e: phi_store::StoreError) -> CoreError { error("StoreFailed", e.to_string()) }
/// `rpcDomain`'s durations: absent the default, null -1.
fn domain_duration(v: Option<&Json>, d: f64) -> Json {
	match v {
		None => Json::Number(d),
		Some(Json::Null) => Json::Number(-1.0),
		Some(Json::String(s)) if s == "forever" => Json::Number(FOREVER),
		Some(v) => v.clone(),
	}
}
fn or_null(v: Option<&Json>) -> Json { v.cloned().unwrap_or(Json::Null) }
/// A transaction as the core takes it: null is none.
fn some(txn: &Json) -> Option<&Json> { Some(txn).filter(|t| !t.is_null()) }

/// `rpcDomain`: the method and arguments a request's claim is kept under.
/// One step as `batch` hands it to the space, which claims the steps as they are.
fn batch_step(x: &Json) -> Json {
	let txn = or_null(x.get("txn"));
	match x.get("op").and_then(Json::as_str) {
		Some("begin") => obj! { "op" => "begin", "lease" => domain_duration(x.get("leaseMs"), -1.0) },
		Some(op @ ("commit" | "abort")) => obj! { "op" => op, "txn" => txn },
		Some("write") => {
			let e = x.get("entry");
			let mut entry = obj! { "type" => or_null(e.and_then(|e| e.get("type"))), "fields" => or_null(e.and_then(|e| e.get("fields"))) };
			if let (Some(t), Json::Object(m)) = (e.and_then(|e| e.get("types")), &mut entry) {
				m.insert("types", t.clone());
			}
			let mut o = obj! { "op" => "write", "entry" => entry, "txn" => txn, "lease" => domain_duration(x.get("leaseMs"), -1.0) };
			if let (Some(u), Json::Object(m)) = (x.get("unique"), &mut o) {
				m.insert("unique", u.clone());
			}
			o
		}
		op => obj! { "op" => op.map_or(Json::Null, Json::from), "template" => or_null(x.get("template")), "txn" => txn },
	}
}

pub fn rpc_domain(method: &str, a: &Object, principal: &Json) -> (String, Json) {
	let get = |k: &str| a.get(k);
	let txn = || or_null(get("txn"));
	match method {
		"write" => {
			let mut o = obj! { "entry" => or_null(get("entry")), "txn" => txn(), "lease" => domain_duration(get("leaseMs"), -1.0) };
			if let (Some(u), Json::Object(m)) = (get("unique"), &mut o) {
				m.insert("unique", u.clone());
			}
			if let (Some(Json::Bool(true)), Json::Object(m)) = (get("transient"), &mut o) {
				m.insert("transient", Json::Bool(true));
			}
			("write".into(), o)
		}
		"batch" => ("batch".into(), Json::Array(get("ops").and_then(Json::as_array).map(|ops| ops.iter().map(batch_step).collect()).unwrap_or_default())),
		"read" | "take" => {
			let name = format!("{method}{}", if get("ifExists") == Some(&Json::Bool(true)) { "IfExists" } else { "" });
			(name, obj! { "tmpl" => or_null(get("template")), "timeout" => domain_duration(get("timeoutMs"), 0.0), "deadline" => or_null(get("deadline")), "txn" => txn() })
		}
		"txn" if get("action").and_then(Json::as_str) == Some("begin") => ("txn.begin".into(), obj! { "lease" => domain_duration(get("leaseMs"), -1.0) }),
		"txn" => (format!("txn.{}", get("action").and_then(Json::as_str).unwrap_or("")), obj! { "txn" => or_null(get("id")) }),
		"lease" if get("action").and_then(Json::as_str) == Some("renew") => ("lease.renew".into(), obj! { "leaseId" => or_null(get("id")), "ms" => domain_duration(get("ms"), -1.0) }),
		"lease" => ("lease.cancel".into(), obj! { "leaseId" => or_null(get("id")) }),
		"cancelOperation" => {
			let t = get("targetRequest");
			let target = obj! { "generation" => or_null(t.and_then(|t| t.get("generation"))), "requestId" => or_null(t.and_then(|t| t.get("requestId"))), "principal" => principal.clone() };
			(method.into(), obj! { "target" => target })
		}
		"notify" => (method.into(), obj! { "tmpl" => or_null(get("template")), "txn" => txn(), "lease" => domain_duration(get("leaseMs"), -1.0), "handback" => or_null(get("handback")), "target" => principal_id(principal) }),
		"wait" => {
			let mut o = Object::new();
			o.insert("template", or_null(get("template")));
			if let Some(d) = get("deadline") {
				o.insert("deadline", d.clone());
			}
			o.insert("take", Json::Bool(get("take") != Some(&Json::Bool(false))));
			o.insert("target", principal_id(principal).into());
			o.insert("timeout", domain_duration(get("timeoutMs"), 0.0));
			o.insert("txnLeaseMs", domain_duration(get("txnLeaseMs"), -1.0));
			o.insert("handback", or_null(get("handback")));
			(method.into(), Json::Object(o))
		}
		"ack" => (method.into(), obj! { "mailboxEpoch" => or_null(get("mailboxEpoch")), "upTo" => or_null(get("upTo")), "principal" => principal.clone() }),
		_ => (method.into(), Json::Object(a.clone())),
	}
}

/// The figures of the process that serves the space (src/service.ts `stats`; a dashboard draws them over time).
/// `heapBytes` is the resident size: the allocator keeps no count of its own (Node's `heapUsed` has no counterpart).
fn process_figures() -> Json {
	let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
	let fields: Vec<&str> = stat.rsplit(')').next().unwrap_or("").split_whitespace().collect();
	// clock ticks of user and system time; USER_HZ, what Linux counts them in for processes, is 100 on every architecture
	let ticks = |i: usize| fields.get(i).and_then(|f| f.parse::<f64>().ok()).unwrap_or(0.0);
	// VmRSS is given in kB, whatever the page size
	let rss = std::fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find_map(|l| l.strip_prefix("VmRSS:").and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<f64>().ok()))).unwrap_or(0.0) * 1024.0;
	// the wall clock, as Date.now(): the figures are the process's, not the space's (whose clock a test may set)
	obj! { "cpuMs" => (ticks(11) + ticks(12)) * 10.0, "rssBytes" => rss, "heapBytes" => rss, "at" => phi_json::wall_ms() }
}

pub struct Service {
	pub store: Store,
	o: Options,
	rates: HashMap<String, (f64, f64)>,
	rate_sweep_at: f64,
	/// Entry snapshots by Space (`None`: the default).
	snapshots: HashMap<Option<String>, Snapshots>,
	/// The provisioned entry replication of one Space: its merge types bypass the core (`SpaceServiceOptions.merge`).
	pub merge: Option<Merge>,
}

/// The entry replication of one Space and the names it is called by.
pub struct Merge {
	pub controller: entry::EntryReplication,
	/// The Space's alias and id: a call names one of them, or none for the default alias.
	pub alias: String,
	pub space_id: String,
}
impl Merge {
	fn serves(&self, space: Option<&str>) -> bool { space.unwrap_or(DEFAULT_ALIAS) == self.alias || space == Some(self.space_id.as_str()) }
}
/// A refusal of the controller as the service answers it.
/// `epochForSpace` of a federation host (src/runtime.ts): the Space's replica configuration (its journal) where it has
/// one, else its own (a restore sets it), else 1; 0 for a Space this store does not hold.
pub fn space_epoch(store: &mut Store, space: Option<&str>, replica: &dyn Fn(&str) -> Option<f64>) -> f64 {
	let Some(id) = store.space_info(space.unwrap_or(DEFAULT_ALIAS)).and_then(|i| i.get("spaceId")).and_then(Json::as_str).map(str::to_owned) else { return 0.0 };
	if let Some(e) = replica(&id) {
		return e;
	}
	store.reader(Some(&id)).ok().and_then(|h| h.space.state.rest.get("primaryEpoch").and_then(Json::as_f64)).unwrap_or(1.0)
}
pub(crate) fn entry_error(e: entry::EntryError) -> CoreError {
	use entry::EntryError as E;
	match e {
		E::Conflict(m) => error("IllegalArgumentError", m),
		E::Clock(m) => error("ResourceExhausted", format!("replication clock: {m}")),
		E::Exhausted(m) => error("ResourceExhausted", m),
		E::Request(m) => error("RequestConflict", m),
		E::Expired(m) => error("SnapshotExpired", m),
		other => error("EntryReplicationError", other.message()),
	}
}

impl Service {
	pub fn new(store: Store, mut o: Options) -> Service {
		o.max_poll_ms = o.max_poll_ms.min(25_000.0);
		Service { store, o, rates: HashMap::new(), rate_sweep_at: f64::NEG_INFINITY, snapshots: HashMap::new(), merge: None }
	}
	pub fn options(&self) -> &Options { &self.o }
	/// Quotas for the default Space (`PhiSpaces.setLimits`: host code).
	pub fn set_limits(&mut self, l: &Json) -> Result<Json, CoreError> {
		let now = self.now();
		match self.store.commit(None, now, |s| s.set_limits(now, l)) {
			Err(e) => Err(store_failed(e)),
			Ok(r) => r.map(|c| c.value),
		}
	}
	pub fn now(&self) -> f64 { (self.o.now)() }

	/// Decode, check the frame size, dispatch, encode. `max_frame`: what the transport carries.
	pub fn handle_text(&mut self, text: &str, conn: &Conn, max_frame: f64) -> Outcome {
		let call = parse_repairing(text).ok();
		self.handle_call(call.as_ref(), text.len() as f64, conn, max_frame)
	}
	/// `handle_text` of a frame already parsed: `call` is `None` when it is not JSON, `bytes` its length on the wire.
	pub fn handle_call(&mut self, call: Option<&Json>, bytes: f64, conn: &Conn, max_frame: f64) -> Outcome {
		if bytes > max_frame {
			return self.done(fail("ResourceExhausted", &format!("a call may take at most {} bytes", phi_json::number_text(max_frame)), None));
		}
		let Some(call) = call else { return self.done(fail("BadRequest", "the call is not JSON", None)) };
		let mut response_frame = max_frame;
		match self.handle(call, conn, max_frame, bytes, &mut response_frame) {
			Ok(HandledCall::Reply(text)) => self.done(carried(text, max_frame)),
			Ok(HandledCall::Wait(p)) => Outcome::Wait(p),
			Err(e) => {
				let text = self.error(e, response_frame);
				self.done(carried(text, max_frame))
			}
		}
	}
	fn done(&self, text: String) -> Outcome { Outcome::Done { text, mark: self.store.handed() } }

	/// Looks again at a waiting call: its reply, or `Err` with the call to look at later.
	pub fn resume(&mut self, mut p: Box<Parked>) -> Result<(String, u64), Box<Parked>> {
		let text = match self.look(&mut p) {
			Ok(None) => return Err(p),
			Ok(Some(result)) => self.finish(&p.c, result),
			Err(e) => Err(e),
		};
		let text = text.unwrap_or_else(|e| self.error(e, p.c.frame_bytes));
		Ok((carried(text, p.c.max_frame), self.store.handed()))
	}

	fn handle(&mut self, call: &Json, conn: &Conn, transport_frame: f64, raw_bytes: f64, response_frame: &mut f64) -> R<HandledCall> {
		let Some(method) = call.as_object().and_then(|_| call.get("method")).and_then(Json::as_str) else { return Err(bad("a call is an object with a method")) };
		if !METHODS.contains(&method) {
			return Ok(HandledCall::Reply(fail("UnsupportedMethod", &format!("unknown method {method}"), None)));
		}
		let empty = Object::new();
		let args = match call.get("args") {
			None => &empty,
			Some(Json::Object(a)) => a,
			Some(_) => return Err(bad("args must be an object")),
		};
		let Some(mut id) = conn.identity.clone().or_else(|| conn.peer_id.as_ref().and_then(|p| self.o.identity.get(p)).cloned()) else {
			return Ok(HandledCall::Reply(fail("Unauthenticated", "the connection has no known identity", None)));
		};
		// primary/sync: a commit of this store is sealed but not confirmed; every call waits for its resolution
		if let Some((revision, _)) = self.store.sealed_candidate() {
			return Ok(HandledCall::Reply(sealed_reply(revision)));
		}
		let peer = id.principal.get("peerId").and_then(Json::as_str).unwrap_or("").to_owned();
		self.rate(&peer)?;
		let auth = match &self.o.authorize {
			None => None,
			Some(f) => Some(f(&mut self.store, call, &id, conn)?),
		};
		if let Some(a) = &auth {
			id.roles = a.roles();
			if let Some(p) = a.principal() { id.principal = p; }
		}
		// a local agent host acts for one of its conversations (frame.agent, docs/m1-mobile.en.md)
		if let Some(agent) = call.get("frame").filter(|f| is_obj(Some(f))).and_then(|f| f.get("agent")) {
			let valid = agent.as_str().filter(|a| (1..=128).contains(&a.chars().count()) && a.chars().all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c)));
			let Some(agent) = valid else { return Err(bad("frame.agent must be 1 to 128 characters of A-Z a-z 0-9 _ . : -")) };
			if !id.roles.iter().any(|r| r == "agentHost") || id.principal.get("agentId").is_some() {
				return Err(denied("only a local agent host may act for an agent".to_owned()));
			}
			id.principal = obj! { "peerId" => id.principal.get("peerId").cloned().unwrap_or(Json::Null), "agentId" => agent };
			id.roles.retain(|r| r != "agentHost");
		}
		let grant = self.allowed(&id.roles, method)?;
		let frame = call.get("frame");
		if let Some(f) = frame {
			if !is_obj(Some(f)) {
				return Err(bad("frame must be an object"));
			}
			if f.get("authorityId").is_some_and(|a| a.as_str() != Some(self.o.authority_id.as_str())) {
				return Ok(HandledCall::Reply(fail("AuthorityMismatch", &format!("this host is authority {}", self.o.authority_id), None)));
			}
			let epoch = match self.o.epoch_for_space.clone() {
				None => self.o.primary_epoch,
				Some(e) => {
					let space = match call.get("space") {
						None => None,
						v => Some(str_of(v, "space")?),
					};
					e(&mut self.store, space.as_deref())
				}
			};
			if let Some(p) = f.get("primaryEpoch") {
				let earlier = (method == "resolveOperation" || auth.as_ref().is_some_and(|a| a.known_request())) && p.as_f64().is_some_and(|x| x.trunc() == x && x.abs() <= 9_007_199_254_740_991.0 && x < epoch);
				if p.as_f64() != Some(epoch) && !earlier {
					return Ok(HandledCall::Reply(fail("StaleEpoch", &format!("the primary epoch is {}", phi_json::number_text(epoch)), None)));
				}
			}
		}
		let mut request = None;
		if MUTATING.contains(&method) && !(method == "txn" && args.get("action").and_then(Json::as_str) == Some("status")) {
			let r = call.get("request");
			if !is_obj(r) {
				return Err(bad(format!("{method} needs a request {{generation, requestId}}")));
			}
			let r = r.expect("checked");
			let generation = str_of(r.get("generation"), "request.generation")?;
			let request_id = str_of(r.get("requestId"), "request.requestId")?;
			request = Some(obj! { "principal" => id.principal.clone(), "generation" => generation, "requestId" => request_id });
		}
		let space = match call.get("space") {
			None => None,
			v => Some(str_of(v, "space")?),
		};
		let space = space.filter(|s| s != DEFAULT_ALIAS);
		let limits = self.snap_of(space.as_deref())?.limits();
		let frame_bytes = transport_frame.min(limits.max_frame_bytes);
		*response_frame = frame_bytes;
		if raw_bytes > frame_bytes {
			return Err(error("ResourceExhausted", "the request exceeds the space frame limit"));
		}
		let receipt = frame.and_then(|f| f.get("claimReceipt"));
		if receipt.is_some_and(|c| !matches!(c, Json::Bool(_))) {
			return Err(bad("claimReceipt must be boolean"));
		}
		let mut claim = None;
		if receipt == Some(&Json::Bool(true)) {
			if request.is_none() {
				return Err(bad("claim receipt requires an original effect request"));
			}
			let domain = rpc_domain(method, args, &id.principal);
			claim = Some((self.allowed(&id.roles, "resolveOperation")?, Json::Array(vec![domain.0.into(), domain.1])));
		}
		let as_ = Json::String(principal_id(&id.principal));
		let c = Ctx { principal: id.principal, roles: id.roles, request, space, as_, grant, auth, frame_bytes, max_frame: transport_frame, claim };
		match self.dispatch(method, args, &c)? {
			Step::Reply(result) => self.finish(&c, result).map(HandledCall::Reply),
			Step::Wait(p) => Ok(HandledCall::Wait(p)),
		}
	}

	/// The reply of a finished call, with its receipt if it asked for one; both frame limits checked.
	fn finish(&mut self, c: &Ctx, result: Json) -> R<String> {
		let mut reply = obj! { "ok" => true, "result" => result };
		if let (Some((grant, domain)), Some(request)) = (&c.claim, &c.request) {
			if let Some(receipt) = self.receipt(c, grant, domain, request) {
				if let Json::Object(o) = &mut reply {
					o.insert("claimReceipt", receipt);
				}
			}
		}
		let text = reply.to_json_text();
		if text.len() as f64 > c.frame_bytes {
			return Err(error("ResourceExhausted", "the configured frame cannot carry the result; use a compatible transport frame"));
		}
		Ok(text)
	}
	/// The full retained-claim check, not an acknowledgement inferred from the result; absent when it cannot be made (the
	/// effect may be committed already, so a failure here never fails the call).
	fn receipt(&mut self, c: &Ctx, grant: &Grant, domain: &Json, request: &Json) -> Option<Json> {
		let (method, args) = (domain.as_array()?.first()?, domain.as_array()?.get(1)?);
		let hash = digest_json(&obj! { "method" => method.clone(), "args" => args.clone() }).ok()?;
		let epoch = self.epoch(c.space.as_deref());
		let (binding, resolution) = self.resolve_record(c, request, method, &hash.into(), &Json::Number(epoch)).ok()?;
		if let Some(types) = retained_types(&resolution) {
			self.check_types(grant, Some(&types), "this retained result").ok()?;
		}
		let host_id = self.o.host_id.as_deref().or(self.store.host_id())?;
		Some(obj! { "protocol" => "phi-spaces-claim-receipt-v1", "hostId" => host_id, "binding" => binding, "resolution" => resolution })
	}

	fn rate(&mut self, peer: &str) -> R<()> {
		let (now, window) = (self.now(), self.o.rate_window_ms);
		let mut r = self.rates.get(peer).copied();
		if r.is_some_and(|(at, _)| at + window <= now) {
			self.rates.remove(peer);
			r = None;
		}
		if r.is_none() && (now >= self.rate_sweep_at || self.rates.len() >= 10_000) {
			self.rates.retain(|_, (at, _)| *at + window > now);
			self.rate_sweep_at = now + window;
		}
		if r.is_none() && self.rates.len() >= 10_000 {
			return Err(error("ResourceExhausted", "the rate table is full"));
		}
		let (at, calls) = r.unwrap_or((now, 0.0));
		match self.rates.get_mut(peer) {
			Some(slot) => slot.1 = calls + 1.0,
			None => {
				self.rates.insert(peer.to_owned(), (at, calls + 1.0));
			}
		}
		if calls + 1.0 > self.o.max_calls_per_window {
			return Err(error("ResourceExhausted", "the peer exceeded its call rate"));
		}
		Ok(())
	}

	/// The union of what the roles allow for this method.
	fn allowed(&self, roles: &[String], method: &str) -> R<Grant> {
		let mut types: Grant = Some(HashSet::new());
		let mut any = false;
		for name in roles {
			let Some(r) = self.o.policy.get(name) else { continue };
			if r.methods.as_ref().is_some_and(|m| !m.iter().any(|x| x == method)) {
				continue;
			}
			any = true;
			match (&r.types, &mut types) {
				(None, t) => *t = None,
				(Some(list), Some(t)) => t.extend(list.iter().cloned()),
				_ => {}
			}
		}
		if any { Ok(types) } else { Err(denied(format!("{method} is not allowed for your roles"))) }
	}
	fn check_types(&self, grant: &Grant, types: Option<&[String]>, what: &str) -> R<()> {
		let Some(g) = grant else { return Ok(()) };
		if types.is_some_and(|t| t.iter().any(|x| g.contains(x))) { Ok(()) } else { Err(denied(format!("{what} is outside the types your roles allow"))) }
	}
	fn check_template(&self, c: &Ctx, t: &Json, what: &str) -> R<()> { self.check_types(&c.grant, template_type(t).as_deref(), what) }
	fn check_consumer(&self, v: Option<&Json>, c: &Ctx) -> R<()> {
		match v {
			Some(v) if !is_obj(Some(v)) || principal_id(v) != principal_id(&c.principal) => Err(denied("a consumer must be your authenticated principal")),
			_ => Ok(()),
		}
	}

	// ---- commits and reads (src/client.ts)

	/// A commit on the caller's behalf: its authorization is checked inside it.
	fn commit<T>(&mut self, c: &Ctx, op: impl FnOnce(&mut Space, f64) -> R<T>) -> R<T> {
		let auth = c.auth.clone();
		self.commit_on(c.space.as_deref(), |s, now| {
			host_checked(s, &auth)?;
			check(&auth, now)?;
			op(s, now)
		})
	}
	pub fn commit_on<T>(&mut self, space: Option<&str>, op: impl FnOnce(&mut Space, f64) -> R<T>) -> R<T> {
		let now = self.now();
		let guard = self.o.guard.clone();
		match self.store.commit(space, now, |s| {
			guarded(&guard, s)?;
			op(s, now)
		}) {
			Err(e) => Err(store_failed(e)),
			Ok(r) => r.map(|c| c.value),
		}
	}
	/// A named Space and what `op` sets in it, in one commit, under the boot guard: a Space no permit names yet is refused.
	pub fn create_space_with(&mut self, alias: &str, random: phi_core::space::Random, op: impl FnOnce(&mut Space, f64) -> R<()>) -> R<Json> {
		let now = self.now();
		let guard = self.o.guard.clone();
		self.store.create_space_with(alias, now, random, |s| {
			guarded(&guard, s)?;
			op(s, now)
		}).map_err(store_failed)?
	}
	/// The delete step of a Space's lifecycle, under the boot guard; `op` decides.
	pub fn delete_space<T>(&mut self, id: &str, op: impl FnOnce(&mut Space, f64) -> R<T>) -> R<T> {
		let now = self.now();
		let guard = self.o.guard.clone();
		match self.store.delete_space(id, now, |s| {
			guarded(&guard, s)?;
			op(s, now)
		}) {
			Err(e) => Err(store_failed(e)),
			Ok(r) => r.map(|c| c.value),
		}
	}
	/// `epochForSpace`, or the one epoch of all.
	fn epoch(&mut self, space: Option<&str>) -> f64 {
		match self.o.epoch_for_space.clone() {
			Some(e) => e(&mut self.store, space),
			None => self.o.primary_epoch,
		}
	}
	fn snap(&mut self, c: &Ctx) -> R<&mut Space> { self.snap_of(c.space.as_deref()) }
	fn snap_of(&mut self, space: Option<&str>) -> R<&mut Space> {
		let guard = self.o.guard.clone();
		let host = self.store.reader(space)?;
		guarded(&guard, &host.space)?;
		Ok(&mut host.space)
	}

	/// `maintain`: due work drained in separate bounded commits before a domain mutation is admitted.
	fn maintain(&mut self, c: &Ctx) -> R<()> {
		let now = self.now();
		loop {
			let prior = self.snap(c)?;
			if !prior.needs_maintenance(now)? {
				return Ok(());
			}
			let signature = prior.maintenance_signature();
			let auth = c.auth.clone();
			let (more, after) = self.commit_on(c.space.as_deref(), |s, now| {
				host_checked(s, &auth)?;
				s.settle(now)?;
				Ok((s.needs_maintenance(now)?, s.maintenance_signature()))
			})?;
			if more && after == signature {
				return Err(error("ResourceExhausted", "a maintenance item cannot fit the configured commit budget"));
			}
		}
	}

	/// An immediate mutation under a request identity: claim check, effect and stored result in one commit.
	fn mutate(&mut self, c: &Ctx, method: &str, args: Json, run: impl FnOnce(&mut Space, f64) -> R<Json>) -> R<Json> {
		self.maintain(c)?;
		let (request, auth) = (c.request.clone(), c.auth.clone());
		self.commit(c, |s, now| {
			let Some(request) = &request else { return run(s, now) };
			let lim = s.limits();
			let bound = if method == "cancelOperation" { retained_bound(&lim) + 4096.0 } else { 1024.0 };
			let key = match admitted(s, now, request, method, &args, FOREVER, bound)? {
				Admission::Replay(v) => return Ok(v),
				Admission::Fresh(k) => k,
			};
			claim_metadata(s, key.as_str().unwrap_or(""), &auth)?;
			let value = run(s, now)?;
			s.decide_line(now, Some(&key), Some(&obj! { "state" => "done", "result" => value.clone() }))?;
			Ok(value)
		})
	}

	/// The entry and `unique` of a write, the entry's types inside the grant.
	fn write_draft(&self, grant: &Grant, entry: Option<&Json>, unique: Option<&Json>, batch: bool) -> R<(Json, Option<Vec<String>>)> {
		let (entry, type_, types) = entry_draft(entry, batch)?;
		let mut all = vec![type_.clone()];
		all.extend(types);
		self.check_types(grant, Some(&all), &format!("type {type_}"))?;
		Ok((entry, unique_of(unique)?))
	}
	fn write_call(&mut self, c: &Ctx, a: &Object) -> R<Json> {
		let (entry, unique) = self.write_draft(&c.grant, a.get("entry"), a.get("unique"), false)?;
		let lease = duration(a.get("leaseMs"), "leaseMs", ANY)?;
		let transient = a.get("transient") == Some(&Json::Bool(true));
		let txn = or_null(a.get("txn"));
		let args = write_options(obj! { "entry" => entry.clone(), "txn" => txn.clone(), "lease" => lease }, unique.as_deref(), transient);
		let as_ = c.as_.clone();
		self.mutate(c, "write", args, |s, now| write_in(s, now, &entry, &txn, lease, unique.as_deref(), transient, &as_))
	}

	/// `resolveOperationRecord`: the original claim and its space binding, read in one commit.
	fn resolve_record(&mut self, c: &Ctx, target: &Json, method: &Json, hash: &Json, epoch: &Json) -> R<(Json, Json)> {
		let authority = self.o.authority_id.clone();
		let (binding, resolution) = self.commit(c, |s, now| {
			let of = |v: Option<&str>| v.map_or(Json::Null, Json::from);
			let binding = obj! {
				"spaceId" => of(s.state.space_id.as_deref()),
				"authorityId" => authority.as_str(),
				"dataIncarnation" => of(s.state.incarnation.as_deref()),
				"primaryEpoch" => s.state.rest.get("primaryEpoch").filter(|e| !e.is_null()).cloned().unwrap_or_else(|| epoch.clone()),
				"principal" => or_null(target.get("principal")),
				"generation" => or_null(target.get("generation")),
				"requestId" => or_null(target.get("requestId")),
				"method" => method.clone(),
				"argumentHash" => hash.clone(),
			};
			Ok((binding, s.resolve_admission(now, Some(target), method, hash, epoch)?))
		})?;
		if resolution.get("state").and_then(Json::as_str) == Some("pending") {
			return Ok((binding, self.poll_operation(c, target)?));
		}
		Ok((binding, resolution))
	}

	/// State of a known request, read without a commit unless something is due.
	fn poll_operation(&mut self, c: &Ctx, target: &Json) -> R<Json> {
		let now = self.now();
		let s = self.snap(c)?;
		s.claim_failure(); // a look before answered for itself
		let v = s.lookup(now, Some(target))?;
		if let Some(m) = s.claim_failure() {
			return Err(error("Error", m)); // the claims could not be read: no answer from what they seemed to say
		}
		if v.get("state").and_then(Json::as_str) != Some("pending") {
			return Ok(v);
		}
		if !s.needs_maintenance(now)? && !c.auth.as_ref().is_some_and(|a| renews_pending(s, target, a.as_ref())) {
			check(&c.auth, now)?;
			return Ok(v);
		}
		let auth = c.auth.clone();
		self.commit(c, |s, now| {
			authorize_pending(s, now, target, &auth)?;
			s.settle(now)?;
			s.lookup(now, Some(target))
		})
	}

	/// Admit, probe and persist pending work before acknowledging it.
	fn begin_operation(&mut self, c: &Ctx, parsed: &(Json, Template), timeout: f64, txn: &Json, deadline: Option<f64>, (take, if_exists): (bool, bool)) -> R<Json> {
		let method = format!("{}{}", if take { "take" } else { "read" }, if if_exists { "IfExists" } else { "" });
		let (tmpl, t) = parsed;
		let args = obj! { "tmpl" => tmpl.clone(), "timeout" => timeout, "deadline" => deadline.map_or(Json::Null, Json::Number), "txn" => txn.clone() };
		self.maintain(c)?;
		let request = c.request.clone().expect("a mutating call");
		let (max_pending, max_peer) = (self.o.max_pending_per_principal, self.o.max_pending_per_peer);
		let (budget, as_, auth) = (c.frame_bytes - 64.0, c.as_.clone(), c.auth.clone());
		self.commit(c, |s, now| {
			let key = s.key_of(&RequestRef::of(Some(&request)));
			if s.state.rpc.as_ref().and_then(|r| r.claims.get(&key)).is_none() {
				s.assert_member_admission(&method)?;
				let transport = auth.as_ref().and_then(|a| a.transport_peer_id());
				let (mine, peer) = s.pending_counts(request.get("principal").expect("set by the service"), transport.as_deref());
				if mine as f64 >= max_pending {
					return Err(error("ResourceExhausted", "too many pending operations for this principal"));
				}
				if peer as f64 >= max_peer {
					return Err(error("ResourceExhausted", "too many pending operations for this peer"));
				}
			}
			let bound = retained_bound(&s.limits());
			let until = match deadline {
				Some(d) => d,
				None => deadline_of(now, Some(&Json::Number(timeout)))?,
			};
			let ad = s.admit(now, Some(&request), &method.as_str().into(), &args.json_copy(), &Json::Number(until), bound)?;
			let kind = ad.get("kind").and_then(Json::as_str);
			let key = or_null(ad.get("key"));
			if kind == Some("pending") {
				authorize_pending(s, now, &request, &auth)?;
				s.settle(now)?;
				return s.lookup(now, Some(&request));
			}
			if kind == Some("fresh") {
				claim_metadata(s, key.as_str().unwrap_or(""), &auth)?;
				if deadline.is_some_and(|d| d < now) {
					s.decide_line(now, Some(&key), Some(&obj! { "state" => "done", "result" => Json::Null }))?;
					return s.lookup(now, Some(&request));
				}
				let p = s.probe(now, t, some(txn), take, Some(&as_))?;
				let status = p.get("status").and_then(Json::as_str);
				let miss = status != Some("found") && (until <= now || (if_exists && status == Some("none")));
				if status == Some("found") || miss {
					let result = or_null(p.get("entry"));
					let bytes = result.to_json_text().len() as f64;
					if bytes > budget {
						return Err(too_small(bytes));
					}
					let mut outcome = obj! { "state" => "done", "result" => result };
					if let (Some("locked"), Json::Object(o)) = (status, &mut outcome) {
						o.insert("locked", Json::Bool(true));
					}
					s.decide_line(now, Some(&key), Some(&outcome))?;
				} else {
					s.park(now, key.as_str().expect("an admitted key"), tmpl, take, txn, until, if_exists, Some(&as_))?;
					authorize_pending(s, now, &request, &auth)?;
				}
			}
			s.lookup(now, Some(&request))
		})
	}

	fn operation_reply(view: Json) -> R<Json> {
		if view.get("resultExpired").is_some() {
			return Err(error("ResultExpired", "the stored result has expired"));
		}
		if let Some(e) = view.get("error").filter(|e| !e.is_null()) {
			let m = e.get("message").and_then(Json::as_str).unwrap_or("").to_owned();
			return Err(if e.get("code").and_then(Json::as_str) == Some("CompletionViolation") { error("CompletionViolation", m) } else { error("TransactionError", m) });
		}
		let state = view.get("state").and_then(Json::as_str);
		if state == Some("cancelled") {
			return Err(error("OperationCancelled", "the operation was cancelled"));
		}
		if state == Some("done") {
			let mut o = obj! { "state" => "done", "entry" => or_null(view.get("result")) };
			if let (Some(true), Json::Object(m)) = (view.get("locked").map(|l| !l.is_null()), &mut o) {
				m.insert("locked", Json::Bool(true));
			}
			return Ok(o);
		}
		Ok(obj! { "state" => "pending", "deadline" => or_null(view.get("deadline")) })
	}

	/// One look of a waiting call: its result, or `None` to wait on.
	fn look(&mut self, p: &mut Parked) -> R<Option<Json>> {
		let now = self.now();
		let c = Rc::clone(&p.c);
		match &p.kind {
			Kind::Operation(t) | Kind::Poll(t) => {
				let t = t.clone();
				let v = self.poll_operation(&c, &t)?;
				if let Some(types) = retained_types(&v) {
					let grant = self.allowed(&c.roles, "pollOperation")?;
					self.check_types(&grant, Some(&types), "this retained result")?;
				}
				if v.get("state").and_then(Json::as_str) == Some("pending") && now < p.end {
					return Ok(None);
				}
				if matches!(p.kind, Kind::Operation(_)) { Self::operation_reply(v).map(Some) } else { Ok(Some(v)) }
			}
			Kind::Changes { after, max_bytes, stream_id } => {
				let (after, max_bytes, stream_id) = (*after, *max_bytes, stream_id.clone());
				let o = obj! { "maxBytes" => max_bytes };
				let r = match self.snap(&c)?.changes(Some(&Json::Number(after)), &o) {
					Ok(r) => r,
					Err(e) if e.class == "SnapshotExpired" => return Ok(Some(obj! { "resync" => true, "reason" => "history dropped" })),
					Err(e) if e.class == "RevisionAhead" => return Ok(Some(obj! { "resync" => true, "reason" => "ahead of this stream" })),
					Err(e) => return Err(e),
				};
				if stream_id.is_some() && stream_id.as_ref() != r.get("streamId") {
					return Ok(Some(obj! { "resync" => true, "reason" => "another stream", "streamId" => or_null(r.get("streamId")) }));
				}
				let some = r.get("batches").and_then(Json::as_array).is_some_and(|b| !b.is_empty());
				if some || now >= p.end { Ok(Some(r)) } else { Ok(None) }
			}
			Kind::Events { o } => {
				let o = Json::Object(o.clone());
				self.maintain(&c)?;
				let (principal, grant, auth) = (c.principal.clone(), c.grant.clone(), c.auth.clone());
				let page = self.commit(&c, |s, now| {
					if let Some(a) = &auth {
						let wanted = phi_json::canonical_key(&principal);
						for i in 0..s.state.waiters.len() {
							let w = &s.state.waiters[i];
							let chosen = a.renewal_waiter_id().is_none_or(|only| only.as_deref() == Some(w.id.as_str()));
							if chosen && w.consumer.as_ref().is_some_and(|p| phi_json::canonical_key(p) == wanted) && a.can_execute_pending(if w.take { "take" } else { "read" }, w.template.get("type").and_then(Json::as_str)) {
								s.state.waiters[i].authorized_until = Some(a.valid_until());
								s.touch(now);
							}
						}
					}
					s.settle(now)?;
					let page = s.mailbox_page(now, Some(&principal), &o)?;
					if let (Some(g), Some(items)) = (&grant, page.get("events").and_then(Json::as_array)) {
						for item in items {
							if let Some(entry) = item.get("event").and_then(|e| e.get("entry")).filter(|e| !e.is_null()) {
								let types = entry.get("types").and_then(Json::as_array).cloned().unwrap_or_default();
								if !types.iter().any(|t| t.as_str().is_some_and(|t| g.contains(t))) {
									return Err(denied("this mailbox event is outside the types your roles allow"));
								}
							}
						}
					}
					Ok(page)
				})?;
				let some = page.get("events").and_then(Json::as_array).is_some_and(|e| !e.is_empty());
				let gap = page.get("gap").is_some_and(|g| !matches!(g, Json::Null | Json::Bool(false)));
				if some || gap || now >= p.end { Ok(Some(page)) } else { Ok(None) }
			}
		}
	}
	/// The first look of a call that may wait.
	fn first_look(&mut self, c: &Ctx, kind: Kind, end: f64) -> R<Step> {
		let mut p = Box::new(Parked { c: Rc::new(c.clone()), kind, end });
		Ok(match self.look(&mut p)? {
			Some(result) => Step::Reply(result),
			None => Step::Wait(p),
		})
	}

	fn target(&self, v: Option<&Json>, c: &Ctx) -> R<Json> {
		if !is_obj(v) {
			return Err(bad("targetRequest is required"));
		}
		let v = v.expect("checked");
		let generation = str_of(v.get("generation"), "targetRequest.generation")?;
		let request_id = str_of(v.get("requestId"), "targetRequest.requestId")?;
		Ok(obj! { "principal" => c.principal.clone(), "generation" => generation, "requestId" => request_id })
	}

	/// Calls on a merge type of the replicated Space go to its controller (`mergeCall`); `None` for everything else.
	/// Reads see the converging view and are marked `replicated`; exclusive operations are refused.
	fn merge_call(&mut self, method: &str, a: &Object, c: &Ctx) -> R<Option<Json>> {
		let Some(m) = self.merge.as_ref().filter(|m| m.serves(c.space.as_deref())) else { return Ok(None) };
		let rule = |t: Option<&Json>| t.and_then(Json::as_str).and_then(|t| m.controller.rule(t)).cloned();
		let refuse = |what: &str| Err(error("MergeTypeNotExclusive", format!("{what} is not available for merge types (lww/set)")));
		let view = |v: &Json| obj! { "id" => v.get("id").cloned().unwrap(), "type" => v.get("type").cloned().unwrap(), "types" => vec![v.get("type").cloned().unwrap()], "fields" => v.get("fields").cloned().unwrap(), "owner" => v.get("owner").cloned().unwrap(), "expires" => v.get("expiresAt").and_then(Json::as_f64).unwrap_or(FOREVER), "replicated" => true };
		let txn = |a: &Object| a.get("txn").is_some_and(|t| !t.is_null());
		let request_hash = |c: &Ctx| c.request.as_ref().map(|r| entry::change_request_hash(&c.principal, r.get("generation").and_then(Json::as_str).unwrap_or(""), r.get("requestId").and_then(Json::as_str).unwrap_or("")));
		let owner = || c.principal.clone();
		let now = self.now();
		let expires_at = |ms: f64| if ms == ANY || ms >= FOREVER { Json::Null } else { Json::Number(now + ms) };
		match method {
			"write" => {
				let Some(entry) = a.get("entry").filter(|e| is_obj(Some(e))) else { return Ok(None) };
				let Some(r) = rule(entry.get("type")) else { return Ok(None) };
				let type_ = r.get("type").and_then(Json::as_str).unwrap_or("").to_owned();
				if !is_obj(entry.get("fields")) {
					return Err(bad("entry.fields must be an object"));
				}
				if entry.get("types").is_some() {
					return Err(bad("a merge type takes no supertypes"));
				}
				if txn(a) {
					return refuse("a transaction");
				}
				self.check_types(&c.grant, Some(std::slice::from_ref(&type_)), &format!("type {type_}"))?;
				let Some(change_request) = request_hash(c) else { return Err(bad("a merge write needs a request ID")) };
				let ms = duration(a.get("leaseMs"), "leaseMs", ANY)?;
				let expires = expires_at(ms);
				let kind = if r.get("variant").and_then(Json::as_str) == Some("lww") { "put" } else { "add" };
				let m = self.merge.as_ref().unwrap();
				let change = m.controller.mutate(&mut self.store, &Json::String(change_request), &obj! { "kind" => kind, "type" => type_.as_str(), "fields" => entry.get("fields").cloned().unwrap(), "owner" => owner(), "expiresAt" => expires.clone() }).map_err(entry_error)?;
				Ok(Some(obj! { "id" => entry::entry_change_id(&change), "expires" => expires.as_f64().unwrap_or(FOREVER), "replicated" => true }))
			}
			"read" | "take" | "readAll" | "count" | "wait" => {
				let (t, _) = template(a.get("template"))?;
				let Some(_) = rule(t.get("type")) else { return Ok(None) };
				if method == "take" || method == "wait" {
					return refuse(method);
				}
				if txn(a) {
					return refuse("a transaction");
				}
				let type_ = t.get("type").and_then(Json::as_str).unwrap_or("").to_owned();
				self.check_types(&c.grant, Some(std::slice::from_ref(&type_)), "this template")?;
				let m = self.merge.as_ref().unwrap();
				let fields = t.get("fields").and_then(Json::as_object).cloned().unwrap_or_default();
				let found: Vec<Json> = m.controller.read(&self.store).map_err(entry_error)?.into_iter().filter(|v| {
					v.get("type") == t.get("type") && fields.iter().all(|(k, x)| v.get("fields").and_then(|f| f.get(k)).is_some_and(|f| deep_equal(f, x)))
				}).collect();
				let stream = format!("merge:{}", m.controller.document_key);
				Ok(Some(match method {
					"read" => obj! { "state" => "done", "entry" => found.first().map_or(Json::Null, view), "replicated" => true },
					"count" => obj! { "value" => found.len() as f64, "rev" => 0.0, "streamId" => stream, "replicated" => true },
					_ => obj! { "items" => found.iter().take(100).map(view).collect::<Vec<_>>(), "next" => Json::Null, "rev" => 0.0, "streamId" => stream, "replicated" => true },
				}))
			}
			"lease" if a.get("id").and_then(Json::as_str).is_some_and(|i| i.starts_with('[')) => {
				// the lease of a merge entry is its visible version: cancel deletes it (lww: tombstone, set: remove of the
				// tag), renew writes a new version with the new deadline (lww: put, set: renew); only its owner may do either
				let action = str_of(a.get("action"), "action")?;
				let id = a.get("id").and_then(Json::as_str).unwrap().to_owned();
				if action != "renew" && action != "cancel" {
					return Err(bad("action must be renew or cancel"));
				}
				let Some(change_request) = request_hash(c) else { return Err(bad("a merge lease change needs a request ID")) };
				let m = self.merge.as_ref().unwrap();
				// a retried request answers from its stored change (the entry it changed may no longer be visible)
				let prior = m.controller.change_for_request(&self.store, &change_request).map_err(entry_error)?;
				if !prior.is_null() {
					let pm = prior.get("mutation").cloned().unwrap_or(Json::Null);
					let kind = pm.get("kind").and_then(Json::as_str).unwrap_or("");
					let target = match kind {
						"remove" => pm.get("tags").and_then(Json::as_array).and_then(|t| t.first()).and_then(Json::as_str).map(str::to_owned),
						"renew" => pm.get("tag").and_then(Json::as_str).map(str::to_owned),
						_ => None,
					};
					if action == "cancel" && (kind == "delete" || kind == "remove" && target.as_deref() == Some(id.as_str())) {
						return Ok(Some(obj! { "state" => "cancelled", "replicated" => true }));
					}
					if action == "renew" && (kind == "put" || kind == "renew" && target.as_deref() == Some(id.as_str())) {
						return Ok(Some(obj! { "expires" => pm.get("expiresAt").and_then(Json::as_f64).unwrap_or(FOREVER), "id" => entry::entry_change_id(&prior), "replicated" => true }));
					}
					return Err(error("RequestConflict", "the request ID was used for another merge change"));
				}
				let visible = m.controller.read(&self.store).map_err(entry_error)?.into_iter().find(|x| x.get("id").and_then(Json::as_str) == Some(id.as_str()));
				let r = visible.as_ref().and_then(|v| rule(v.get("type")));
				let (Some(v), Some(r)) = (visible, r) else { return Err(error("UnknownLeaseError", format!("no visible merge entry {id}"))) };
				let type_ = v.get("type").and_then(Json::as_str).unwrap_or("").to_owned();
				self.check_types(&c.grant, Some(std::slice::from_ref(&type_)), &format!("type {type_}"))?;
				if v.get("owner").map(Json::key_text) != Some(c.principal.key_text()) {
					return Err(error("PermissionError", "only the owner may change the lease of a merge entry"));
				}
				let lww = r.get("variant").and_then(Json::as_str) == Some("lww");
				let fields = v.get("fields").cloned().unwrap();
				if action == "cancel" {
					let change = if lww { obj! { "kind" => "delete", "type" => type_.as_str(), "fields" => fields, "owner" => owner() } } else { obj! { "kind" => "remove", "type" => type_.as_str(), "tags" => vec![Json::String(id.clone())], "owner" => owner() } };
					m.controller.mutate(&mut self.store, &Json::String(change_request), &change).map_err(entry_error)?;
					return Ok(Some(obj! { "state" => "cancelled", "replicated" => true }));
				}
				let ms = duration(a.get("ms"), "ms", ANY)?;
				let expires = expires_at(ms);
				let change = if lww { obj! { "kind" => "put", "type" => type_.as_str(), "fields" => fields, "owner" => owner(), "expiresAt" => expires.clone() } } else { obj! { "kind" => "renew", "type" => type_.as_str(), "tag" => id.as_str(), "fields" => fields, "owner" => owner(), "expiresAt" => expires.clone() } };
				let change = m.controller.mutate(&mut self.store, &Json::String(change_request), &change).map_err(entry_error)?;
				Ok(Some(obj! { "expires" => expires.as_f64().unwrap_or(FOREVER), "id" => entry::entry_change_id(&change), "replicated" => true }))
			}
			_ => Ok(None),
		}
	}

	fn dispatch(&mut self, method: &str, a: &Object, c: &Ctx) -> R<Step> {
		if let Some(merged) = self.merge_call(method, a, c)? {
			return Ok(Step::Reply(merged));
		}
		let reply = |v: Json| Ok(Step::Reply(v));
		let as_ = c.as_.clone();
		match method {
			"hello" => self.hello(a, c).map(Step::Reply),
			"generation" => {
				let epoch = self.epoch(c.space.as_deref());
				let (now, authority, principal) = (self.now(), self.o.authority_id.clone(), c.principal.clone());
				let (auth, guard) = (c.auth.clone(), self.o.guard.clone());
				let r = self.store.commit_keyed(c.space.as_deref(), now, |s, key| guarded(&guard, s).and_then(|()| host_checked(s, &auth)).and_then(|()| check(&auth, now)).and_then(|()| s.issue_generation(now, Some(&principal), &obj! { "key" => key, "authorityId" => authority.as_str(), "primaryEpoch" => epoch })));
				reply(r.map_err(store_failed)??.value)
			}
			"write" => self.write_call(c, a).map(Step::Reply),
			"read" | "take" => {
				let parsed = template(a.get("template"))?;
				if c.grant.is_some() {
					self.check_template(c, &parsed.0, "this template")?;
				}
				let timeout = duration(a.get("timeoutMs"), "timeoutMs", NO_WAIT)?;
				let wait_ms = opt_int(a.get("waitMs"), "waitMs", 0.0)?.unwrap_or(self.o.max_poll_ms).min(self.o.max_poll_ms);
				let deadline = deadline_arg(a.get("deadline"))?;
				let view = self.begin_operation(c, &parsed, timeout, &or_null(a.get("txn")), deadline, (method == "take", a.get("ifExists") == Some(&Json::Bool(true))))?;
				if view.get("state").and_then(Json::as_str) == Some("pending") && wait_ms > 0.0 {
					let request = c.request.clone().expect("a mutating call");
					let end = self.now() + wait_ms;
					return self.first_look(c, Kind::Operation(request), end);
				}
				Self::operation_reply(view).map(Step::Reply)
			}
			"pollOperation" => {
				let t = self.target(a.get("targetRequest"), c)?;
				let wait_ms = opt_int(a.get("waitMs"), "waitMs", 0.0)?.unwrap_or(0.0).min(self.o.max_poll_ms);
				let end = self.now() + wait_ms;
				self.first_look(c, Kind::Poll(t), end)
			}
			"resolveOperation" => {
				let t = self.target(a.get("targetRequest"), c)?;
				let m = str_of(a.get("method"), "method")?;
				let hash = str_of(a.get("argumentHash"), "argumentHash")?;
				let epoch = int(a.get("primaryEpoch"), "primaryEpoch", 0.0)?;
				let current = self.epoch(c.space.as_deref());
				if epoch > current {
					return Err(error("IncarnationChanged", "resolution epoch is ahead of Member"));
				}
				let (method, hash) = (Json::from(m), Json::from(hash));
				let miss = match self.resolve_record(c, &t, &method, &hash, &Json::Number(epoch)) {
					Ok((_, v)) if v.get("state").and_then(Json::as_str) == Some("notAdmitted") && epoch != current => Err(error("IncarnationChanged", "missing request requires current Member epoch")),
					Err(e) if e.class != "IncarnationChanged" => return Err(e),
					other => other.map(|(_, v)| v),
				};
				let view = match miss {
					Ok(v) => v,
					// an unknown request of an earlier epoch: NotCommitted with a durable negative claim, only with promotion evidence
					Err(miss) => {
						let Some(proof) = self.o.promotion_proof.clone().filter(|_| epoch < current).and_then(|f| f(c.space.as_deref(), epoch)) else { return Err(miss) };
						let proof_hash = proof.get("hash").cloned().unwrap_or(Json::Null);
						self.commit(c, |s, now| s.decide_not_committed(now, Some(&t), &method, &hash, &Json::Number(epoch), &Json::Number(current), &proof_hash))?
					}
				};
				if let Some(types) = retained_types(&view) {
					self.check_types(&c.grant, Some(&types), "this retained result")?;
				}
				reply(view)
			}
			"cancelOperation" => {
				let t = self.target(a.get("targetRequest"), c)?;
				let args = obj! { "target" => t.clone() };
				self.mutate(c, "cancelOperation", args, |s, now| s.cancel_request(now, Some(&t))).map(Step::Reply)
			}
			"readAll" => self.read_all(a, c).map(Step::Reply),
			"count" => {
				let (tmpl, t) = template(a.get("template"))?;
				if c.grant.is_some() {
					self.check_template(c, &tmpl, "this template")?;
				}
				let now = self.now();
				let txn = a.get("txn").filter(|t| !t.is_null());
				let s = self.snap(c)?;
				reply(obj! { "value" => s.count(now, &t, txn, Some(&as_))?, "rev" => s.revision()?, "streamId" => s.stream_id() })
			}
			"stats" => {
				if c.grant.is_some() {
					return Err(denied("aggregate stats need a role without type restrictions"));
				}
				let now = self.now();
				let s = self.snap(c)?;
				reply(obj! { "stats" => s.stats(now)?, "rev" => s.revision()?, "streamId" => s.stream_id(), "process" => process_figures() })
			}
			"batch" => self.batch(a, c).map(Step::Reply),
			"spaces" => {
				if c.grant.is_some() {
					return Err(denied("listing spaces needs a role without type restrictions"));
				}
				let list = self.store.spaces().iter().map(|i| obj! { "spaceId" => or_null(i.get("spaceId")), "alias" => or_null(i.get("alias")), "createdAt" => or_null(i.get("createdAt")) }).collect();
				reply(Json::Array(list))
			}
			"txn" => self.txn(a, c).map(Step::Reply),
			"lease" => self.lease(a, c).map(Step::Reply),
			"changes" => {
				if c.grant.is_some() {
					return Err(denied("the change stream carries every type; it needs a role without type limits"));
				}
				let after = int(a.get("afterRev"), "afterRev", 0.0)?;
				let wait_ms = opt_int(a.get("waitMs"), "waitMs", 0.0)?.unwrap_or(0.0).min(self.o.max_poll_ms);
				let cap = reply_cap(a.get("maxBytes"), "maxBytes", c.frame_bytes)?;
				let end = self.now() + wait_ms;
				self.first_look(c, Kind::Changes { after, max_bytes: cap, stream_id: a.get("streamId").cloned() }, end)
			}
			"notify" => {
				let (tmpl, _) = template(a.get("template"))?;
				self.check_types(&c.grant, template_type(&tmpl).as_deref(), "this subscription")?;
				self.check_consumer(a.get("consumer"), c)?;
				let lease = duration(a.get("leaseMs"), "leaseMs", ANY)?;
				let (txn, handback) = (or_null(a.get("txn")), or_null(a.get("handback")));
				let args = obj! { "tmpl" => tmpl.clone(), "target" => as_.clone(), "txn" => txn.clone(), "lease" => lease, "handback" => handback.clone() };
				let consumer = c.principal.clone();
				self.mutate(c, "notify", args, |s, now| s.notify(now, &tmpl, some(&txn), &Json::Number(lease), &handback, &as_, Some(&as_), Some(&consumer))).map(Step::Reply)
			}
			"wait" => {
				let (tmpl, _) = template(a.get("template"))?;
				self.check_types(&c.grant, template_type(&tmpl).as_deref(), "this wait")?;
				self.check_consumer(a.get("consumer"), c)?;
				if a.get("take").is_some_and(|t| !matches!(t, Json::Bool(_))) {
					return Err(bad("take must be boolean"));
				}
				let take = a.get("take") != Some(&Json::Bool(false));
				let g = self.allowed(&c.roles, if take { "take" } else { "read" })?;
				self.check_types(&g, template_type(&tmpl).as_deref(), "this wait operation")?;
				let timeout = duration(a.get("timeoutMs"), "timeoutMs", NO_WAIT)?;
				let deadline = deadline_arg(a.get("deadline"))?;
				let txn_lease = duration(a.get("txnLeaseMs"), "txnLeaseMs", ANY)?;
				let handback = or_null(a.get("handback"));
				let mut w = Object::new();
				if let Some(d) = deadline {
					w.insert("deadline", Json::Number(d));
				}
				w.insert("template", tmpl);
				w.insert("take", Json::Bool(take));
				w.insert("target", as_.clone());
				w.insert("timeout", Json::Number(timeout));
				w.insert("txnLeaseMs", Json::Number(txn_lease));
				w.insert("handback", handback);
				let (request, consumer, until) = (c.request.clone().expect("a mutating call"), c.principal.clone(), c.auth.as_ref().map(|a| a.valid_until()));
				let id = self.mutate(c, "wait", Json::Object(w.clone()), |s, now| {
					w.insert("originRequestKey", s.key_of(&RequestRef::of(Some(&request))).into());
					w.insert("as", as_.clone());
					w.insert("consumer", consumer);
					if let Some(u) = until { w.insert("authorizedUntil", Json::Number(u)); }
					s.add_waiter(now, &Json::Object(w))
				})?;
				reply(obj! { "id" => id })
			}
			"events" => {
				self.check_consumer(a.get("consumer"), c)?;
				let wait_ms = opt_int(a.get("waitMs"), "waitMs", 0.0)?.unwrap_or(0.0).min(self.o.max_poll_ms);
				let end = self.now() + wait_ms;
				let mut o = Object::new();
				if a.get("mailboxEpoch").is_some() {
					o.insert("mailboxEpoch", str_of(a.get("mailboxEpoch"), "mailboxEpoch")?.into());
				}
				if let Some(after) = opt_int(a.get("after"), "after", 0.0)? {
					o.insert("after", Json::Number(after));
				}
				let cap = reply_cap(a.get("maxBytes"), "maxBytes", c.frame_bytes)?;
				o.insert("maxBytes", Json::Number(cap));
				self.first_look(c, Kind::Events { o }, end)
			}
			"ack" => {
				self.check_consumer(a.get("consumer"), c)?;
				let (epoch, up_to) = (str_of(a.get("mailboxEpoch"), "mailboxEpoch")?, int(a.get("upTo"), "upTo", 0.0)?);
				let principal = c.principal.clone();
				let args = obj! { "mailboxEpoch" => epoch.as_str(), "upTo" => up_to, "principal" => principal.clone() };
				self.mutate(c, "ack", args, |s, _| s.ack_mailbox(Some(&principal), Some(&epoch.as_str().into()), Some(&Json::Number(up_to)))).map(Step::Reply)
			}
			_ => Err(bad(format!("{method} is not implemented"))),
		}
	}

	fn hello(&mut self, a: &Object, c: &Ctx) -> R<Json> {
		if a.get("protocol") != Some(&Json::Number(PROTOCOL_VERSION)) {
			return Err(error("UnsupportedProtocol", "this host speaks protocol 1"));
		}
		let name = c.space.as_deref().unwrap_or(DEFAULT_ALIAS);
		let mut info = self.store.space_info(name).cloned();
		if info.is_none() && c.space.is_none() {
			self.commit_on(c.space.as_deref(), |_, _| Ok(()))?; // an untouched session registers its default space on first use
			info = self.store.space_info(name).cloned();
		}
		let Some(info) = info else { return Err(error("UnknownSpaceError", format!("unknown space: {}", c.space.as_deref().unwrap_or("undefined")))) };
		let epoch = self.epoch(info.get("spaceId").and_then(Json::as_str));
		let (poll, principal_pending, peer_pending, authority) = (self.o.max_poll_ms, self.o.max_pending_per_principal, self.o.max_pending_per_peer, self.o.authority_id.clone());
		let host_id = self.o.host_id.as_deref().or(self.store.host_id()).unwrap_or("").to_owned();
		let s = self.snap(c)?;
		let lim = s.limits();
		let features: Vec<Json> = METHODS.iter().copied().chain(["write.unique", "write.transient", "read.chain", "read.locked"]).map(Json::from).collect();
		Ok(obj! {
			"protocol" => PROTOCOL_VERSION,
			"hostId" => host_id,
			"spaceId" => or_null(info.get("spaceId")),
			"alias" => or_null(info.get("alias")),
			"incarnation" => or_null(info.get("incarnation")),
			"streamId" => s.stream_id(),
			"rev" => s.revision()?,
			"authorityId" => authority,
			"primaryEpoch" => epoch,
			"role" => "single",
			"principal" => principal_key(&c.principal),
			"roles" => Json::Array(c.roles.iter().map(|r| Json::from(r.as_str())).collect()),
			"features" => Json::Array(features),
			"limits" => obj! {
				"maxFrameBytes" => lim.max_frame_bytes.min(c.frame_bytes),
				"maxCommitBytes" => lim.max_commit_bytes,
				"maxEventBytes" => lim.max_event_bytes,
				"maxEntryBytes" => lim.max_entry_bytes,
				"maxPollMs" => poll,
				"maxPendingPerPrincipal" => principal_pending,
				"maxPendingPerPeer" => peer_pending,
			},
			"capabilities" => obj! { "snapshotPagination" => true, "mailboxes" => true, "completionProfiles" => true, "transactions" => true, "blockingTake" => true, "mode" => "single" },
		})
	}

	fn read_all(&mut self, a: &Object, c: &Ctx) -> R<Json> {
		let (tmpl, _) = template(a.get("template"))?;
		if c.grant.is_some() {
			self.check_template(c, &tmpl, "this template")?;
		}
		let now = self.now();
		let as_ = c.as_.clone();
		if let Some(chain) = a.get("chain") {
			let fine = is_obj(Some(chain)) && a.get("txn").is_none_or(Json::is_null) && a.get("token").is_none() && a.get("cursor").is_none();
			if !fine {
				return Err(bad("invalid chain read"));
			}
			let mut o = Object::new();
			if let Some(h) = chain.get("head") {
				let (head, _) = template(Some(h))?;
				if c.grant.is_some() {
					self.check_types(&c.grant, template_type(&head).as_deref(), "this chain head")?;
				}
				o.insert("head", head);
			}
			match chain.get("cursor") {
				None => {}
				Some(Json::String(s)) => o.insert("cursor", s.as_str().into()),
				v => o.insert("cursor", str_of(v, "chain.cursor")?.into()),
			}
			if chain.get("nextField").is_some() {
				o.insert("nextField", str_of(chain.get("nextField"), "chain.nextField")?.into());
			}
			o.insert("limit", Json::Number(match chain.get("limit") {
				None => 100.0,
				v => int(v, "chain.limit", 1.0)?,
			}));
			let cap = reply_cap(chain.get("maxBytes"), "chain.maxBytes", c.frame_bytes)?;
			o.insert("maxBytes", Json::Number(cap));
			return self.snap(c)?.read_chain(now, &tmpl, &Json::Object(o), Some(&as_));
		}
		let cap = reply_cap(a.get("maxBytes"), "maxBytes", c.frame_bytes)?;
		let mut o = Object::new();
		o.insert("maxBytes", Json::Number(cap));
		if a.get("token").is_some() {
			o.insert("token", str_of(a.get("token"), "token")?.into());
		}
		if a.get("limit").is_some() {
			o.insert("limit", Json::Number(int(a.get("limit"), "limit", 1.0)?));
		}
		o.insert("after", or_null(a.get("cursor")));
		o.insert("txn", or_null(a.get("txn")));
		if self.snap(c)?.state.space_id.is_none() {
			self.commit_on(c.space.as_deref(), |_, _| Ok(()))?;
			self.snap_of(c.space.as_deref())?; // the guard again, on the Space the commit just registered
		}
		let host = self.store.reader(c.space.as_deref())?;
		// by the Space, not by the name of this call: alias and id share their pages
		let key = host.space.state.space_id.clone();
		self.snapshots.entry(key).or_default().page(&mut host.space, now, &tmpl, &Json::Object(o), Some(&as_))
	}

	fn txn(&mut self, a: &Object, c: &Ctx) -> R<Json> {
		let action = str_of(a.get("action"), "action")?;
		let as_ = c.as_.clone();
		if action == "begin" {
			let lease = duration(a.get("leaseMs"), "leaseMs", ANY)?;
			return self.mutate(c, "txn.begin", obj! { "lease" => lease }, |s, now| s.create_txn(now, Some(&Json::Number(lease)), Some(&as_)));
		}
		let id = str_of(a.get("id"), "id")?;
		let idj = Json::from(id.as_str());
		match action.as_str() {
			"status" => self.commit(c, |s, now| {
				s.settle(now)?;
				let t = s.state.txns.iter().find(|t| t.id == id);
				if t.is_some_and(|t| t.owner != as_) {
					return Err(error("PermissionError", "another principal's transaction"));
				}
				Ok(t.map_or(obj! { "state" => "inactive" }, |t| obj! { "state" => "active", "expires" => t.expires }))
			}),
			"commit" => {
				let auth = c.auth.clone();
				self.mutate(c, "txn.commit", obj! { "txn" => idj.clone() }, |s, now| {
					check_transaction_rights(s, &id, &auth)?;
					s.commit_txn(now, Some(&idj), Some(&as_))
				})?;
				Ok(obj! { "state" => "committed" })
			}
			"abort" => {
				self.mutate(c, "txn.abort", obj! { "txn" => idj.clone() }, |s, now| s.abort_txn(now, Some(&idj), Some(&as_)))?;
				Ok(obj! { "state" => "aborted" })
			}
			_ => Err(bad("action must be begin, commit or abort")),
		}
	}

	fn lease(&mut self, a: &Object, c: &Ctx) -> R<Json> {
		let action = str_of(a.get("action"), "action")?;
		let id: Json = str_of(a.get("id"), "id")?.into();
		let as_ = c.as_.clone();
		match action.as_str() {
			"renew" => {
				let ms = duration(a.get("ms"), "ms", ANY)?;
				let auth = c.auth.clone();
				let expires = self.mutate(c, "lease.renew", obj! { "leaseId" => id.clone(), "ms" => ms }, |s, now| {
					check_renewal(s, id.as_str().expect("a string"), &auth)?;
					s.renew(now, Some(&id), Some(&Json::Number(ms)), Some(&as_))
				})?;
				Ok(obj! { "expires" => expires })
			}
			"cancel" => {
				let closed = c.auth.as_ref().is_some_and(|a| a.allow_closed_waiter());
				self.mutate(c, "lease.cancel", obj! { "leaseId" => id.clone() }, |s, now| match s.cancel(now, Some(&id), Some(&as_)) {
					Err(e) if closed && e.class == "UnknownLeaseError" => Ok(Json::Null),
					other => other,
				})?;
				Ok(obj! { "state" => "cancelled" })
			}
			_ => Err(bad("action must be renew or cancel")),
		}
	}

	/// Every step needs the right its own call would need, with the same type checks.
	fn batch(&mut self, a: &Object, c: &Ctx) -> R<Json> {
		if self.merge.as_ref().is_some_and(|m| m.serves(c.space.as_deref())) {
			return Err(bad("batch is not offered on a space with merged entry types (each write is merged on its own)"));
		}
		let list = a.get("ops").and_then(Json::as_array).filter(|l| (1..=64).contains(&l.len())).ok_or_else(|| bad("ops must be 1 to 64 steps"))?;
		let mut ops = vec![];
		for x in list {
			let Some(op) = x.as_object().and_then(|_| x.get("op")).and_then(Json::as_str) else { return Err(bad("a step is an object with an op")) };
			let txn = match x.get("txn").filter(|t| !t.is_null()) {
				None => Json::Null,
				v => str_of(v, "txn")?.into(),
			};
			ops.push(match op {
				"begin" => {
					self.allowed(&c.roles, "txn")?;
					obj! { "op" => "begin", "lease" => duration(x.get("leaseMs"), "leaseMs", ANY)? }
				}
				"commit" | "abort" => {
					self.allowed(&c.roles, "txn")?;
					if txn.is_null() {
						return Err(bad(format!("{op} needs a txn")));
					}
					obj! { "op" => op, "txn" => txn }
				}
				"write" => {
					let g = self.allowed(&c.roles, "write")?;
					let (entry, unique) = self.write_draft(&g, x.get("entry"), x.get("unique"), true)?;
					let step = obj! { "op" => "write", "entry" => entry, "txn" => txn, "lease" => duration(x.get("leaseMs"), "leaseMs", ANY)? };
					write_options(step, unique.as_deref(), x.get("transient") == Some(&Json::Bool(true)))
				}
				"take" | "read" => {
					let g = self.allowed(&c.roles, op)?;
					let (t, _) = template(x.get("template"))?;
					if g.is_some() {
						self.check_types(&g, template_type(&t).as_deref(), "this template")?;
					}
					obj! { "op" => op, "template" => t, "txn" => txn }
				}
				other => return Err(bad(format!("unknown batch step {other}"))),
			});
		}
		self.maintain(c)?;
		let args = Json::Array(ops.clone());
		let (request, as_, auth) = (c.request.clone().expect("a mutating call"), c.as_.clone(), c.auth.clone());
		self.commit(c, |s, now| {
			let lim = s.limits();
			let reads = ops.iter().filter(|o| matches!(o.get("op").and_then(Json::as_str), Some("take" | "read"))).count() as f64;
			let bound = 1024.0 * ops.len() as f64 + reads * retained_bound(&lim);
			let key = match admitted(s, now, &request, "batch", &args, FOREVER, bound)? {
				Admission::Replay(v) => return Ok(v),
				Admission::Fresh(k) => k,
			};
			claim_metadata(s, key.as_str().unwrap_or(""), &auth)?;
			let mut begun: Option<Json> = None;
			let txn_of = |t: Option<&Json>, begun: &Option<Json>| match t.filter(|t| !t.is_null()) {
				Some(Json::String(d)) if d == "$" => begun.clone().ok_or_else(|| error("IllegalArgumentError", "txn \"$\" needs a begin earlier in the batch")),
				Some(t) => Ok(t.clone()),
				None => Ok(Json::Null),
			};
			let mut results = vec![];
			for x in &ops {
				match x.get("op").and_then(Json::as_str) {
					Some("begin") => {
						let l = s.create_txn(now, x.get("lease"), Some(&as_))?;
						begun = l.get("id").cloned();
						results.push(l);
					}
					Some("write") => {
						let unique: Option<Vec<String>> = x.get("unique").and_then(Json::as_array).map(|u| u.iter().filter_map(|k| k.as_str().map(str::to_owned)).collect());
						let lease = x.get("lease").and_then(Json::as_f64).unwrap_or(ANY);
						let t = txn_of(x.get("txn"), &begun)?;
						results.push(write_in(s, now, x.get("entry").expect("set above"), &t, lease, unique.as_deref(), x.get("transient").is_some(), &as_)?);
					}
					Some(op @ ("take" | "read")) => {
						let t = txn_of(x.get("txn"), &begun)?;
						let p = s.probe(now, &Template::from_json(x.get("template"))?, some(&t), op == "take", Some(&as_))?;
						let mut r = obj! { "entry" => or_null(p.get("entry")) };
						if let (Some("locked"), Json::Object(o)) = (p.get("status").and_then(Json::as_str), &mut r) {
							o.insert("locked", Json::Bool(true));
						}
						results.push(r);
					}
					Some("commit") => {
						s.commit_txn(now, Some(&txn_of(x.get("txn"), &begun)?), Some(&as_))?;
						results.push(Json::Null);
					}
					_ => {
						s.abort_txn(now, Some(&txn_of(x.get("txn"), &begun)?), Some(&as_))?;
						results.push(Json::Null);
					}
				}
			}
			let plain = Json::Array(results);
			s.decide_line(now, Some(&key), Some(&obj! { "state" => "done", "result" => plain.clone() }))?;
			Ok(plain)
		})
	}

	// ---- errors

	/// What a reply held for a commit that will not become durable answers: `CommitSealed` while a primary's sealed
	/// candidate is unresolved, otherwise an internal error.
	pub fn failed_reply(&self) -> String {
		match self.store.sealed_candidate() {
			Some((revision, _)) => sealed_reply(revision),
			None => fail("Internal", "internal error", None),
		}
	}

	fn error(&self, e: CoreError, response_frame: f64) -> String {
		if let Some((revision, _)) = self.store.sealed_candidate() {
			return sealed_reply(revision);
		}
		let code = match e.class {
			"SyncJournalFull" => return fail("ResourceExhausted", &format!("primary/sync journal: {}", e.message), None),
			"ResponseBudgetTooSmall" => {
				if e.required.is_some_and(|r| r > response_frame - 21.0) {
					return fail("ResourceExhausted", "the configured frame cannot hold the next whole element", None);
				}
				return fail("ResponseBudgetTooSmall", &e.message, e.required);
			}
			"Bad" => "BadRequest",
			"Denied" | "PermissionError" => "PermissionDenied",
			"UnsupportedProtocol" => "UnsupportedProtocol",
			"UnknownSpaceError" => "UnknownSpace",
			"RequestConflict" | "RequestExpired" | "ResultExpired" | "IncarnationChanged" | "NotCommitted" | "OperationCancelled" | "SnapshotExpired" | "RevisionAhead" | "CompletionViolation" | "MailboxEpochMismatch" | "InvalidAck" | "UniqueConflict" => e.class,
			"LimitError" | "ResourceExhausted" => "ResourceExhausted",
			"ReplicaConfigPending" => "ReplicaConfigPending",
			"StalePolicyVersion" => "StalePolicyVersion",
			"RoutingConflict" => "RoutingConflict",
			"MemberDrained" => "MemberDrained",
			"TransactionError" | "UnknownLeaseError" | "RunGateConflict" => "TransactionError",
			"MergeTypeNotExclusive" => "MergeTypeNotExclusive",
			"IllegalArgumentError" | "TypeError" => "BadRequest",
			_ => {
				// unclassified errors stay on this host: their text can name local paths and internal identifiers
				eprintln!("phi-spaces service: internal error: {e}");
				return fail("Internal", "internal error", None);
			}
		};
		fail(code, &e.message, None)
	}
}

enum HandledCall {
	Reply(String),
	Wait(Box<Parked>),
}
enum Step {
	Reply(Json),
	Wait(Box<Parked>),
}
enum Admission {
	Replay(Json),
	Fresh(Json),
}

/// What a read's stored result may take at most.
fn retained_bound(l: &Limits) -> f64 { l.max_entry_bytes + 4.0 * l.max_type_chars * l.max_types + 4096.0 }

/// `claims.admit` in a commit that runs at once: the stored answer of a replay, or the fresh key.
fn admitted(s: &mut Space, now: f64, request: &Json, method: &str, args: &Json, deadline: f64, bound: f64) -> R<Admission> {
	let key = s.key_of(&RequestRef::of(Some(request)));
	if s.state.rpc.as_ref().and_then(|r| r.claims.get(&key)).is_none() {
		s.assert_member_admission(method)?;
	}
	// `json_copy` is the JSON round trip of the arguments (a non-finite number becomes null), not a clone
	let ad = s.admit(now, Some(request), &method.into(), &args.json_copy(), &Json::Number(deadline), bound)?;
	match ad.get("kind").and_then(Json::as_str) {
		Some("done") => Ok(Admission::Replay(or_null(ad.get("result")))),
		Some("cancelled") => Err(error("OperationCancelled", format!("request {} was cancelled", request.get("requestId").and_then(Json::as_str).unwrap_or("")))),
		_ => Ok(Admission::Fresh(or_null(ad.get("key")))),
	}
}

/// The checked parts of an entry draft: `{type, types?, fields}`, its type and its supertypes.
fn entry_draft(v: Option<&Json>, batch: bool) -> R<(Json, String, Vec<String>)> {
	let missing = if batch { "entry with fields is required" } else { "entry is required" };
	let Some(v) = v.filter(|v| is_obj(Some(v))) else { return Err(bad(missing)) };
	if batch && !is_obj(v.get("fields")) {
		return Err(bad(missing));
	}
	let type_ = str_of(v.get("type"), "entry.type")?;
	let types = v.get("types").map(|t| string_list(t, "entry.types must be strings")).transpose()?;
	if !is_obj(v.get("fields")) {
		return Err(bad("entry.fields must be an object"));
	}
	let mut o = Object::new();
	o.insert("type", type_.as_str().into());
	if let Some(t) = v.get("types").filter(|_| types.is_some()) {
		o.insert("types", t.clone());
	}
	o.insert("fields", or_null(v.get("fields")));
	Ok((Json::Object(o), type_, types.unwrap_or_default()))
}
/// A write's optional arguments on `args`.
fn write_options(mut args: Json, unique: Option<&[String]>, transient: bool) -> Json {
	if let Json::Object(m) = &mut args {
		if let Some(u) = unique {
			m.insert("unique", Json::Array(u.iter().map(|k| Json::from(k.as_str())).collect()));
		}
		if transient {
			m.insert("transient", Json::Bool(true));
		}
	}
	args
}
/// The types of a retained result, when it has them.
fn retained_types(view: &Json) -> Option<Vec<String>> {
	let types = view.get("result").filter(|r| is_obj(Some(r)))?.get("types")?.as_array()?;
	Some(types.iter().filter_map(|t| t.as_str().map(str::to_owned)).collect())
}
/// A `maxBytes` argument, inside what the reply frame leaves.
fn reply_cap(v: Option<&Json>, what: &str, frame: f64) -> R<f64> {
	let cap = match v {
		None => frame,
		v => int(v, what, 1.0)?,
	};
	Ok(cap.min(frame - 21.0))
}
fn deadline_arg(v: Option<&Json>) -> R<Option<f64>> { v.map(|d| int(Some(d), "deadline", 0.0)).transpose() }
fn unique_of(v: Option<&Json>) -> R<Option<Vec<String>>> { v.map(|u| string_list(u, "unique must be field names")).transpose() }

/// `writeIn`.
#[allow(clippy::too_many_arguments)]
fn write_in(s: &mut Space, now: f64, entry: &Json, txn: &Json, lease: f64, unique: Option<&[String]>, transient: bool, as_: &Json) -> R<Json> {
	if transient {
		if unique.is_some() {
			return Err(error("IllegalArgumentError", "a transient write cannot be unique"));
		}
		return s.announce(now, entry, some(txn), Some(as_));
	}
	if let Some(keys) = unique {
		let fields = entry.get("fields").and_then(Json::as_object).expect("a checked draft");
		if keys.is_empty() || keys.iter().any(|k| fields.get(k).is_none()) {
			return Err(error("IllegalArgumentError", "unique needs existing field names"));
		}
		s.settle(now)?;
		let type_ = entry.get("type").and_then(Json::as_str);
		let null = Json::Null;
		if s.state.entries.iter().any(|e| Some(e.type_.as_str()) == type_ && keys.iter().all(|k| deep_equal(e.fields.get(k).unwrap_or(&null), fields.get(k).expect("checked")))) {
			return Err(error("UniqueConflict", "unique entry already exists"));
		}
	}
	s.write(now, entry, some(txn), Some(&Json::Number(lease)), Some(as_))
}
