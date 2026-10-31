//! The `space` service, ported from src/service.ts and the part of src/client.ts it uses: one call in, one reply out, on a
//! store. No network here (phi-wire), and no waiting: a call that has to wait comes back as `Outcome::Wait`, and its
//! transport looks again with `resume` when a commit or the clock gives a reason. The identity comes from the connection,
//! never from the call. A reply may rest on commits still on their way to the disk: the transport sends it once
//! `Store::durable` has reached the `mark` it comes with (a reader sees what is committed, not only what is durable).
//!
//! Commit boundaries are those of the TypeScript client: every maintenance round is a commit of its own, a snapshot read
//! is none. Revisions and the change stream show them, so they are part of the contract.
mod background;

use phi_core::claims::RequestRef;
use phi_core::mailbox::principal_id;
use phi_core::snapshot::Snapshots;
use phi_core::space::{deadline_of, deep_equal, error, CoreError, Limits, Template, ANY};
use phi_core::Space;
use phi_json::{digest_json, obj, parse_repairing, Json, Object, FOREVER};
use phi_store::{Store, DEFAULT_ALIAS};
use std::collections::{HashMap, HashSet};

pub const PROTOCOL_VERSION: f64 = 1.0;
pub const METHODS: [&str; 20] = ["hello", "generation", "write", "read", "take", "pollOperation", "resolveOperation", "cancelOperation", "readAll", "count", "stats", "spaces", "txn", "lease", "changes", "wait", "notify", "events", "ack", "batch"];
const MUTATING: [&str; 10] = ["write", "read", "take", "cancelOperation", "txn", "lease", "wait", "notify", "ack", "batch"];
/// A long poll looks again at the latest after this long even without a commit (a decision that came without one).
const POLL_FALLBACK_MS: f64 = 1000.0;
/// A waiting call looks again at the first commit, then at most this often.
pub const POLL_GAP_MS: f64 = 25.0;
/// Without `wake_on_commit`: look again every 50 ms.
const SLEEP_MS: f64 = 50.0;
const NO_WAIT: f64 = 0.0;
pub const DEFAULT_MAX_FRAME_BYTES: f64 = phi_core::space::DEFAULT_LIMITS.max_frame_bytes;

type R<T> = Result<T, CoreError>;
fn bad(m: impl Into<String>) -> CoreError { error("Bad", m) }
fn denied(m: impl Into<String>) -> CoreError { error("Denied", m) }
fn too_small(required: f64) -> CoreError { error("ResponseBudgetTooSmall", format!("the next element needs {} bytes of budget", phi_json::number_text(required))) }

// ---- identity and rights

/// What a transport knows about a connection.
#[derive(Clone, Debug, Default)]
pub struct Conn {
	pub peer_id: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Identity {
	pub principal: Json,
	pub roles: Vec<String>,
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
	pub now: Box<dyn Fn() -> f64>,
	pub authority_id: String,
	pub primary_epoch: f64,
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
		Options { identity: HashMap::from([(peer.to_owned(), identity)]), policy: default_policy(), now: Box::new(now), authority_id: "local".into(), primary_epoch: 0.0, max_poll_ms: 25_000.0, max_pending_per_principal: 32.0, max_pending_per_peer: 128.0, max_calls_per_window: 1024.0, rate_window_ms: 1000.0, wake_on_commit: false }
	}
}

// ---- what a transport gets

/// A call that waits. `look` again with `Service::resume`.
pub struct Parked {
	c: Ctx,
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
pub fn rpc_domain(method: &str, a: &Object, principal: &Json) -> (String, Json) {
	let get = |k: &str| a.get(k);
	let txn = || or_null(get("txn"));
	match method {
		"write" => {
			let mut o = obj! { "entry" => or_null(get("entry")), "txn" => txn(), "lease" => domain_duration(get("leaseMs"), -1.0) };
			if let (Some(u), Json::Object(m)) = (get("unique"), &mut o) {
				m.insert("unique", u.clone());
			}
			("write".into(), o)
		}
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

fn process_figures(now: f64) -> Json {
	let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
	let fields: Vec<&str> = stat.rsplit(')').next().unwrap_or("").split_whitespace().collect();
	// clock ticks of user and system time; Linux gives processes 100 per second
	let ticks = |i: usize| fields.get(i).and_then(|f| f.parse::<f64>().ok()).unwrap_or(0.0);
	let rss = std::fs::read_to_string("/proc/self/statm").ok().and_then(|s| s.split_whitespace().nth(1).and_then(|p| p.parse::<f64>().ok())).unwrap_or(0.0) * 4096.0;
	obj! { "cpuMs" => (ticks(11) + ticks(12)) * 10.0, "rssBytes" => rss, "heapBytes" => rss, "at" => now }
}

pub struct Service {
	pub store: Store,
	o: Options,
	rates: HashMap<String, (f64, f64)>,
	rate_sweep_at: f64,
	/// Entry snapshots by Space (`None`: the default).
	snapshots: HashMap<Option<String>, Snapshots>,
}

impl Service {
	pub fn new(store: Store, mut o: Options) -> Service {
		o.max_poll_ms = o.max_poll_ms.min(25_000.0);
		Service { store, o, rates: HashMap::new(), rate_sweep_at: f64::NEG_INFINITY, snapshots: HashMap::new() }
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
		let bytes = text.len() as f64;
		if bytes > max_frame {
			return self.done(fail("ResourceExhausted", &format!("a call may take at most {} bytes", phi_json::number_text(max_frame)), None));
		}
		let Ok(call) = parse_repairing(text) else { return self.done(fail("BadRequest", "the call is not JSON", None)) };
		let mut response_frame = max_frame;
		match self.handle(&call, conn, max_frame, bytes, &mut response_frame) {
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
		let Some(id) = conn.peer_id.as_ref().and_then(|p| self.o.identity.get(p)).cloned() else {
			return Ok(HandledCall::Reply(fail("Unauthenticated", "the connection has no known identity", None)));
		};
		let peer = id.principal.get("peerId").and_then(Json::as_str).unwrap_or("").to_owned();
		self.rate(&peer)?;
		let grant = self.allowed(&id.roles, method)?;
		let frame = call.get("frame");
		if let Some(f) = frame {
			if !is_obj(Some(f)) {
				return Err(bad("frame must be an object"));
			}
			if f.get("authorityId").is_some_and(|a| a.as_str() != Some(self.o.authority_id.as_str())) {
				return Ok(HandledCall::Reply(fail("AuthorityMismatch", &format!("this host is authority {}", self.o.authority_id), None)));
			}
			let epoch = self.o.primary_epoch;
			if let Some(p) = f.get("primaryEpoch") {
				let earlier = method == "resolveOperation" && p.as_f64().is_some_and(|x| x.trunc() == x && x.abs() <= 9_007_199_254_740_991.0 && x < epoch);
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
		let limits = self.store.reader(space.as_deref())?.space.limits();
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
		let c = Ctx { principal: id.principal, roles: id.roles, request, space: call.get("space").and(space), as_, grant, frame_bytes, max_frame: transport_frame, claim };
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
		let (binding, resolution) = self.resolve_record(c, request, method, &hash.into(), &Json::Number(self.o.primary_epoch)).ok()?;
		if let Some(types) = resolution.get("result").filter(|r| is_obj(Some(r))).and_then(|r| r.get("types")).and_then(Json::as_array) {
			let types: Vec<String> = types.iter().filter_map(|t| t.as_str().map(str::to_owned)).collect();
			self.check_types(grant, Some(&types), "this retained result").ok()?;
		}
		let host_id = self.store.host_id()?;
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
		self.rates.insert(peer.to_owned(), (at, calls + 1.0));
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

	fn commit<T>(&mut self, c: &Ctx, op: impl FnOnce(&mut Space, f64) -> R<T>) -> R<T> { self.commit_on(c.space.as_deref(), op) }
	fn commit_on<T>(&mut self, space: Option<&str>, op: impl FnOnce(&mut Space, f64) -> R<T>) -> R<T> {
		let now = self.now();
		match self.store.commit(space, now, |s| op(s, now)) {
			Err(e) => Err(store_failed(e)),
			Ok(r) => r.map(|c| c.value),
		}
	}
	fn snap(&mut self, c: &Ctx) -> R<&mut Space> { self.snap_of(c.space.as_deref()) }
	fn snap_of(&mut self, space: Option<&str>) -> R<&mut Space> { Ok(&mut self.store.reader(space)?.space) }

	/// `maintain`: due work drained in separate bounded commits before a domain mutation is admitted.
	fn maintain(&mut self, c: &Ctx) -> R<()> {
		let now = self.now();
		loop {
			let prior = self.snap(c)?;
			if !prior.needs_maintenance(now)? {
				return Ok(());
			}
			let signature = prior.maintenance_signature();
			let (more, after) = self.commit(c, |s, now| {
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
		let request = c.request.clone();
		self.commit(c, |s, now| {
			let Some(request) = &request else { return run(s, now) };
			let lim = s.limits();
			let bound = if method == "cancelOperation" { retained_bound(&lim) + 4096.0 } else { 1024.0 };
			let key = match admitted(s, now, request, method, &args, FOREVER, bound)? {
				Admission::Replay(v) => return Ok(v),
				Admission::Fresh(k) => k,
			};
			let value = run(s, now)?;
			s.decide_line(now, Some(&key), Some(&obj! { "state" => "done", "result" => value.clone() }))?;
			Ok(value)
		})
	}

	fn write_call(&mut self, c: &Ctx, a: &Object) -> R<Json> {
		let (entry, type_, types) = entry_draft(a.get("entry"), "entry is required")?;
		let mut all = vec![type_.clone()];
		all.extend(types);
		self.check_types(&c.grant, Some(&all), &format!("type {type_}"))?;
		let unique = unique_of(a.get("unique"))?;
		let lease = duration(a.get("leaseMs"), "leaseMs", ANY)?;
		let transient = a.get("transient") == Some(&Json::Bool(true));
		let txn = or_null(a.get("txn"));
		let mut args = obj! { "entry" => entry.clone(), "txn" => txn.clone(), "lease" => lease };
		if let Json::Object(m) = &mut args {
			if let Some(u) = &unique {
				m.insert("unique", Json::Array(u.iter().map(|k| Json::from(k.as_str())).collect()));
			}
			if transient {
				m.insert("transient", Json::Bool(true));
			}
		}
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
				"primaryEpoch" => epoch.clone(),
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
		let v = s.lookup(now, Some(target))?;
		if v.get("state").and_then(Json::as_str) != Some("pending") || !s.needs_maintenance(now)? {
			return Ok(v);
		}
		self.commit(c, |s, now| {
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
		let (budget, as_) = (c.frame_bytes - 64.0, c.as_.clone());
		self.commit(c, |s, now| {
			let key = s.key_of(&RequestRef::of(Some(&request)));
			if s.state.rpc.as_ref().and_then(|r| r.claims.get(&key)).is_none() {
				let (mine, peer) = s.pending_counts(request.get("principal").expect("set by the service"));
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
			let ad = s.admit(now, Some(&request), &method.as_str().into(), &args, &Json::Number(until), bound)?;
			let kind = ad.get("kind").and_then(Json::as_str);
			let key = or_null(ad.get("key"));
			if kind == Some("pending") {
				s.settle(now)?;
				return s.lookup(now, Some(&request));
			}
			if kind == Some("fresh") {
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
		let c = p.c.clone();
		match &p.kind {
			Kind::Operation(t) | Kind::Poll(t) => {
				let t = t.clone();
				let v = self.poll_operation(&c, &t)?;
				if let Some(types) = v.get("result").filter(|r| is_obj(Some(r))).and_then(|r| r.get("types")).and_then(Json::as_array) {
					let grant = self.allowed(&c.roles, "pollOperation")?;
					let types: Vec<String> = types.iter().filter_map(|t| t.as_str().map(str::to_owned)).collect();
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
				let (principal, grant) = (c.principal.clone(), c.grant.clone());
				let page = self.commit(&c, |s, now| {
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
		let mut p = Box::new(Parked { c: c.clone(), kind, end });
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

	fn dispatch(&mut self, method: &str, a: &Object, c: &Ctx) -> R<Step> {
		let reply = |v: Json| Ok(Step::Reply(v));
		let as_ = c.as_.clone();
		match method {
			"hello" => self.hello(a, c).map(Step::Reply),
			"generation" => {
				let (now, authority, principal, epoch) = (self.now(), self.o.authority_id.clone(), c.principal.clone(), self.o.primary_epoch);
				let r = self.store.commit_keyed(c.space.as_deref(), now, |s, key| s.issue_generation(now, Some(&principal), &obj! { "key" => key, "authorityId" => authority.as_str(), "primaryEpoch" => epoch }));
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
				let deadline = match a.get("deadline") {
					None => None,
					d => Some(int(d, "deadline", 0.0)?),
				};
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
				if epoch > self.o.primary_epoch {
					return Err(error("IncarnationChanged", "resolution epoch is ahead of Member"));
				}
				let (_, view) = self.resolve_record(c, &t, &m.into(), &hash.into(), &Json::Number(epoch))?;
				if view.get("state").and_then(Json::as_str) == Some("notAdmitted") && epoch != self.o.primary_epoch {
					return Err(error("IncarnationChanged", "missing request requires current Member epoch"));
				}
				if let Some(types) = view.get("result").filter(|r| is_obj(Some(r))).and_then(|r| r.get("types")).and_then(Json::as_array) {
					let types: Vec<String> = types.iter().filter_map(|t| t.as_str().map(str::to_owned)).collect();
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
				reply(obj! { "stats" => s.stats(now)?, "rev" => s.revision()?, "streamId" => s.stream_id(), "process" => process_figures(now) })
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
				let cap = match a.get("maxBytes") {
					None => c.frame_bytes,
					v => int(v, "maxBytes", 1.0)?,
				};
				let end = self.now() + wait_ms;
				self.first_look(c, Kind::Changes { after, max_bytes: cap.min(c.frame_bytes - 21.0), stream_id: a.get("streamId").cloned() }, end)
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
				let deadline = match a.get("deadline") {
					None => None,
					d => Some(int(d, "deadline", 0.0)?),
				};
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
				let (request, consumer) = (c.request.clone().expect("a mutating call"), c.principal.clone());
				let id = self.mutate(c, "wait", Json::Object(w.clone()), |s, now| {
					w.insert("originRequestKey", s.key_of(&RequestRef::of(Some(&request))).into());
					w.insert("as", as_.clone());
					w.insert("consumer", consumer);
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
				let cap = match a.get("maxBytes") {
					None => c.frame_bytes,
					v => int(v, "maxBytes", 1.0)?,
				};
				o.insert("maxBytes", Json::Number(cap.min(c.frame_bytes - 21.0)));
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
		let find = |infos: Vec<Json>| infos.into_iter().find(|i| i.get("alias").and_then(Json::as_str) == Some(c.space.as_deref().unwrap_or(DEFAULT_ALIAS)) || (c.space.is_some() && i.get("spaceId").and_then(Json::as_str) == c.space.as_deref()));
		let mut info = find(self.store.spaces());
		if info.is_none() && c.space.is_none() {
			self.commit(c, |_, _| Ok(()))?; // an untouched session registers its default space on first use
			info = find(self.store.spaces());
		}
		let Some(info) = info else { return Err(error("UnknownSpaceError", format!("unknown space: {}", c.space.as_deref().unwrap_or("undefined")))) };
		let (poll, principal_pending, peer_pending, authority, epoch) = (self.o.max_poll_ms, self.o.max_pending_per_principal, self.o.max_pending_per_peer, self.o.authority_id.clone(), self.o.primary_epoch);
		let host_id = self.store.host_id().unwrap_or("").to_owned();
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
			let cap = match chain.get("maxBytes") {
				None => c.frame_bytes - 21.0,
				v => int(v, "chain.maxBytes", 1.0)?,
			};
			o.insert("maxBytes", Json::Number(cap.min(c.frame_bytes - 21.0)));
			return self.snap(c)?.read_chain(now, &tmpl, &Json::Object(o), Some(&as_));
		}
		let cap = match a.get("maxBytes") {
			None => c.frame_bytes,
			v => int(v, "maxBytes", 1.0)?,
		};
		let mut o = Object::new();
		o.insert("maxBytes", Json::Number(cap.min(c.frame_bytes - 21.0)));
		if a.get("token").is_some() {
			o.insert("token", str_of(a.get("token"), "token")?.into());
		}
		if a.get("limit").is_some() {
			o.insert("limit", Json::Number(int(a.get("limit"), "limit", 1.0)?));
		}
		o.insert("after", or_null(a.get("cursor")));
		o.insert("txn", or_null(a.get("txn")));
		if self.snap(c)?.state.space_id.is_none() {
			self.commit(c, |_, _| Ok(()))?;
		}
		let key = c.space.clone();
		let host = self.store.reader(c.space.as_deref())?;
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
				self.mutate(c, "txn.commit", obj! { "txn" => idj.clone() }, |s, now| s.commit_txn(now, Some(&idj), Some(&as_)))?;
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
				let expires = self.mutate(c, "lease.renew", obj! { "leaseId" => id.clone(), "ms" => ms }, |s, now| s.renew(now, Some(&id), Some(&Json::Number(ms)), Some(&as_)))?;
				Ok(obj! { "expires" => expires })
			}
			"cancel" => {
				self.mutate(c, "lease.cancel", obj! { "leaseId" => id.clone() }, |s, now| s.cancel(now, Some(&id), Some(&as_)))?;
				Ok(obj! { "state" => "cancelled" })
			}
			_ => Err(bad("action must be renew or cancel")),
		}
	}

	/// Every step needs the right its own call would need, with the same type checks.
	fn batch(&mut self, a: &Object, c: &Ctx) -> R<Json> {
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
					let (entry, type_, types) = entry_draft(x.get("entry"), "entry with fields is required")?;
					let mut all = vec![type_.clone()];
					all.extend(types);
					self.check_types(&g, Some(&all), &format!("type {type_}"))?;
					let unique = unique_of(x.get("unique"))?;
					let mut s = obj! { "op" => "write", "entry" => entry, "txn" => txn, "lease" => duration(x.get("leaseMs"), "leaseMs", ANY)? };
					if let Json::Object(m) = &mut s {
						if let Some(u) = unique {
							m.insert("unique", Json::Array(u.into_iter().map(Json::from).collect()));
						}
						if x.get("transient") == Some(&Json::Bool(true)) {
							m.insert("transient", Json::Bool(true));
						}
					}
					s
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
		let (request, as_) = (c.request.clone().expect("a mutating call"), c.as_.clone());
		self.commit(c, |s, now| {
			let lim = s.limits();
			let reads = ops.iter().filter(|o| matches!(o.get("op").and_then(Json::as_str), Some("take" | "read"))).count() as f64;
			let bound = 1024.0 * ops.len() as f64 + reads * retained_bound(&lim);
			let key = match admitted(s, now, &request, "batch", &args, FOREVER, bound)? {
				Admission::Replay(v) => return Ok(v),
				Admission::Fresh(k) => k,
			};
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

	fn error(&self, e: CoreError, response_frame: f64) -> String {
		let required = || e.message.split_whitespace().nth(4).and_then(|n| n.parse::<f64>().ok());
		let code = match e.class {
			"ResponseBudgetTooSmall" => {
				if required().is_some_and(|r| r > response_frame - 21.0) {
					return fail("ResourceExhausted", "the configured frame cannot hold the next whole element", None);
				}
				return fail("ResponseBudgetTooSmall", &e.message, required());
			}
			"Bad" => "BadRequest",
			"Denied" | "PermissionError" => "PermissionDenied",
			"UnsupportedProtocol" => "UnsupportedProtocol",
			"UnknownSpaceError" => "UnknownSpace",
			"RequestConflict" | "RequestExpired" | "ResultExpired" | "IncarnationChanged" | "NotCommitted" | "OperationCancelled" | "SnapshotExpired" | "RevisionAhead" | "CompletionViolation" | "MailboxEpochMismatch" | "InvalidAck" | "UniqueConflict" => e.class,
			"LimitError" | "ResourceExhausted" => "ResourceExhausted",
			"TransactionError" | "UnknownLeaseError" => "TransactionError",
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
	let ad = s.admit(now, Some(request), &method.into(), args, &Json::Number(deadline), bound)?;
	match ad.get("kind").and_then(Json::as_str) {
		Some("done") => Ok(Admission::Replay(or_null(ad.get("result")))),
		Some("cancelled") => Err(error("OperationCancelled", format!("request {} was cancelled", request.get("requestId").and_then(Json::as_str).unwrap_or("")))),
		_ => Ok(Admission::Fresh(or_null(ad.get("key")))),
	}
}

/// The checked parts of an entry draft: `{type, types?, fields}`, its type and its supertypes.
fn entry_draft(v: Option<&Json>, missing: &str) -> R<(Json, String, Vec<String>)> {
	if !is_obj(v) {
		return Err(bad(missing));
	}
	let v = v.expect("checked");
	let batch = missing != "entry is required";
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
