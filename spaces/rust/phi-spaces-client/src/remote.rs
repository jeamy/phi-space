//! `RemoteSpace` of src/remote.ts: the SpaceLike contract over a [`Transport`], speaking the `space` service.
//!
//! Every call is sent as one text; a transport failure repeats the very same text (same request identity, same
//! arguments), `ok:false` replies are answers and never repeated. After the attempts are used up a mutating or blocking
//! call ends as [`Error::OutcomeUnknown`] with its request, which the caller can poll, retry or cancel. Two clocks, as in
//! TypeScript: the injected wall clock (`now`) only for the admission of generations, the monotonic one for
//! `max_client_wait_ms` and the poll times.
use crate::error::{Error, RequestRef};
use crate::{LocalFuture, Transport};
use phi_json::{obj, parse, Json};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;
use tokio::sync::{Mutex, OnceCell};
use tokio::time::Instant;

pub const PROTOCOL_VERSION: f64 = 1.0;
/// `core.FOREVER` (Number.MAX_SAFE_INTEGER): travels as the string "forever".
pub const FOREVER: f64 = phi_json::FOREVER;
/// `core.ANY`: the space picks the duration; travels as null.
pub const ANY: f64 = -1.0;
pub const NO_WAIT: f64 = 0.0;

/// core durations on the wire.
pub fn lease_arg(ms: f64) -> Json {
	if ms == FOREVER {
		Json::from("forever")
	} else if ms == ANY {
		Json::Null
	} else {
		Json::Number(ms)
	}
}

use phi_json::wall_ms;

/// A number in [0, 1) from the system's random bytes, as Math.random gives one.
pub(crate) fn random_unit() -> f64 {
	let mut b = [0u8; 8];
	getrandom::getrandom(&mut b).expect("the system gives random bytes");
	(u64::from_be_bytes(b) >> 11) as f64 / (1u64 << 53) as f64
}

fn base36(mut n: u64) -> String {
	const D: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
	if n == 0 {
		return "0".to_owned();
	}
	let mut out = Vec::new();
	while n > 0 {
		out.push(D[(n % 36) as usize]);
		n /= 36;
	}
	out.reverse();
	String::from_utf8(out).unwrap_or_default()
}

/// `q<ms base36><8 random base36>`, the request ids of the TypeScript client.
fn default_request_id() -> String {
	let mut tail = String::new();
	for _ in 0..8 {
		tail.push_str(&base36((random_unit() * 36.0) as u64));
	}
	format!("q{}{tail}", base36(wall_ms() as u64))
}

pub(crate) type SleepFn = Rc<dyn Fn(f64) -> LocalFuture<'static, ()>>;

#[derive(Clone)]
pub struct Options {
	/// Stable space id or alias; None: the default space.
	pub space: Option<String>,
	/// Transport attempts per call; pause before the n-th retry: min(backoff_ms * 2^(n-1), max_backoff_ms) * (1 + random).
	pub attempts: u32,
	pub backoff_ms: f64,
	pub max_backoff_ms: f64,
	/// One transport round trip may take this long (a poll of 25 s plus margin).
	pub call_timeout_ms: f64,
	/// The caller stops waiting for a blocking call after this long: OutcomeUnknown. None: no limit.
	pub max_client_wait_ms: Option<f64>,
	/// The part of a generation's admission time that must remain to start a call under it.
	pub generation_margin_ms: f64,
	pub now: Rc<dyn Fn() -> f64>,
	pub sleep: SleepFn,
	pub random: Rc<dyn Fn() -> f64>,
	pub new_request_id: Rc<dyn Fn() -> String>,
	/// The agent this client acts for, as `frame.agent` on every call (src/remote.ts `agent`): only a connection with
	/// the agentHost role may (the agent host of a phone, docs/m1-mobile.en.md); the space then sees the principal
	/// {peerId, agentId}.
	pub agent: Option<String>,
}

impl Default for Options {
	fn default() -> Self {
		Options {
			space: None,
			attempts: 5,
			backoff_ms: 100.0,
			max_backoff_ms: 2_000.0,
			call_timeout_ms: 35_000.0,
			max_client_wait_ms: None,
			generation_margin_ms: 5_000.0,
			now: Rc::new(wall_ms),
			sleep: Rc::new(|ms: f64| Box::pin(tokio::time::sleep(Duration::from_secs_f64(ms.max(0.0) / 1000.0))) as LocalFuture<'static, ()>),
			random: Rc::new(random_unit),
			new_request_id: Rc::new(default_request_id),
			agent: None,
		}
	}
}

/// Options of one call. `request`: a durable caller keeps its own identity; `once` stands for the local hook of the
/// TypeScript options, which a remote call refuses.
#[derive(Debug, Clone, Default)]
pub struct Opts {
	pub request: Option<RequestRef>,
	pub txn: Option<String>,
	pub deadline: Option<f64>,
	pub unique: Option<Json>,
	pub transient: bool,
	pub once: bool,
}

/// What the link cost so far: transport attempts repeated with the same identity, and calls given up as OutcomeUnknown.
#[derive(Debug, Default)]
pub struct Counters {
	pub retries: Cell<u64>,
	pub unknown: Cell<u64>,
}

pub struct RemoteSpace {
	t: Rc<dyn Transport>,
	o: Options,
	hello: OnceCell<Json>,
	frame_limit: Cell<usize>,
	gen: RefCell<Option<(String, f64)>>,
	gen_fetches: Cell<u64>,
	gen_lock: Mutex<()>,
	pub counters: Counters,
}

fn txn_arg(txn: Option<&str>) -> Json { txn.map_or(Json::Null, Json::from) }

fn insert(o: &mut Json, k: &str, v: Json) {
	if let Some(m) = o.as_object_mut() {
		m.insert(k, v);
	}
}

impl RemoteSpace {
	pub fn new(transport: Rc<dyn Transport>, o: Options) -> RemoteSpace {
		RemoteSpace {
			t: transport,
			o,
			hello: OnceCell::new(),
			frame_limit: Cell::new(crate::DEFAULT_MAX_FRAME_BYTES),
			gen: RefCell::new(None),
			gen_fetches: Cell::new(0),
			gen_lock: Mutex::new(()),
			counters: Counters::default(),
		}
	}

	pub fn options(&self) -> &Options { &self.o }

	/// The server's answer to `hello`: identity of the space, limits, features. Asked once; a failure is asked again.
	pub async fn info(&self) -> Result<Json, Error> {
		let h = self
			.hello
			.get_or_try_init(|| async {
				let r = self.send(obj! { "method" => "hello", "args" => obj! { "protocol" => PROTOCOL_VERSION } }, None, None).await?;
				if let Some(n) = r.get("limits").and_then(|l| l.get("maxFrameBytes")).and_then(Json::as_f64) {
					self.frame_limit.set(n as usize);
				}
				Ok::<Json, Error>(r)
			})
			.await?;
		Ok(h.clone())
	}

	async fn has_feature(&self, name: &str) -> Result<bool, Error> {
		Ok(self.info().await?.get("features").and_then(Json::as_array).is_some_and(|f| f.iter().any(|x| x.as_str() == Some(name))))
	}

	// ---- transport with identity-preserving retries

	fn left_ms(end: Option<Instant>) -> Option<f64> { end.map(|e| e.saturating_duration_since(Instant::now()).as_secs_f64() * 1000.0) }

	async fn round_trip(&self, text: &str, end: Option<Instant>) -> Result<Json, Error> {
		let limit = self.frame_limit.get(); // not read from `hello`: the retries of `hello` itself must not wait for it
		if text.len() > limit {
			return Err(Error::remote("ResourceExhausted", format!("a call may take at most {limit} bytes")));
		}
		let budget = Self::left_ms(end).map_or(self.o.call_timeout_ms, |l| l.min(self.o.call_timeout_ms)).max(1.0);
		let raw = match tokio::time::timeout(Duration::from_secs_f64(budget / 1000.0), self.t.request(text.to_owned())).await {
			Err(_) => return Err(Error::Transport("the call timed out".to_owned())),
			Ok(Err(e)) => return Err(Error::Transport(e)),
			Ok(Ok(raw)) => raw,
		};
		let reply = parse(&raw).ok().filter(|r| match r.get("ok").and_then(Json::as_bool) {
			Some(true) => r.as_object().is_some_and(|o| o.contains_key("result")),
			Some(false) => r.get("error").and_then(|e| e.get("code")).and_then(Json::as_str).is_some(),
			None => false,
		});
		reply.ok_or_else(|| Error::Transport("the reply is not a protocol reply".to_owned()))
	}

	/// Send `call`; a transport failure repeats the very same text. `ok:false` replies throw. Returns the result.
	/// `exhausted`: the request and the reason that turn "attempts used up" into OutcomeUnknown.
	async fn send(&self, mut call: Json, exhausted: Option<(&RequestRef, &str)>, end: Option<Instant>) -> Result<Json, Error> {
		if let Some(space) = &self.o.space {
			insert(&mut call, "space", Json::from(space.as_str()));
		}
		let method = call.get("method").and_then(Json::as_str).unwrap_or("");
		if let Some(agent) = self.o.agent.as_deref().filter(|_| !["challenge", "prove", "enroll", "enrollStatus"].contains(&method)) {
			let mut frame = call.get("frame").filter(|f| f.as_object().is_some()).cloned().unwrap_or_else(|| Json::Object(Default::default()));
			insert(&mut frame, "agent", Json::from(agent));
			insert(&mut call, "frame", frame);
		}
		let target = call.get("request").or_else(|| call.get("args").and_then(|a| a.get("targetRequest"))).and_then(RequestRef::of);
		let text = call.to_json_text();
		let passed = || end.is_some_and(|e| Instant::now() >= e);
		let mut last = Error::Transport("the client stopped waiting".to_owned());
		for n in 0..self.o.attempts {
			if passed() {
				break;
			}
			if n > 0 {
				self.counters.retries.set(self.counters.retries.get() + 1);
				let pause = (self.o.backoff_ms * 2f64.powi(n as i32 - 1)).min(self.o.max_backoff_ms) * (1.0 + (self.o.random)());
				(self.o.sleep)(Self::left_ms(end).map_or(pause, |l| pause.min(l.max(0.0)))).await;
			}
			if passed() {
				break;
			}
			match self.round_trip(&text, end).await {
				Ok(r) => {
					if r.get("ok").and_then(Json::as_bool) == Some(true) {
						return Ok(r.get("result").cloned().unwrap_or(Json::Null));
					}
					let e = r.get("error").cloned().unwrap_or(Json::Null);
					let code = e.get("code").and_then(Json::as_str).unwrap_or("Internal").to_owned();
					let message = e.get("message").and_then(Json::as_str).unwrap_or("").to_owned();
					if code == "CommitSealed" {
						if let Some(request) = &target {
							return Err(Error::OutcomeUnknown { request: request.clone(), why: message, sealed: true });
						}
					}
					return Err(Error::Remote { code, message, required_bytes: e.get("requiredBytes").and_then(Json::as_f64) });
				}
				Err(e @ Error::Transport(_)) => last = e,
				Err(e) => return Err(e),
			}
		}
		match exhausted {
			Some((request, why)) => {
				self.counters.unknown.set(self.counters.unknown.get() + 1);
				Err(Error::OutcomeUnknown { request: request.clone(), why: why.to_owned(), sealed: false })
			}
			None => Err(last),
		}
	}

	async fn raw_call(&self, method: &str, args: Json) -> Result<Json, Error> { self.send(obj! { "method" => method, "args" => args }, None, None).await }

	/// A new generation, asked of the host directly.
	pub async fn request_generation(&self) -> Result<Json, Error> { self.raw_call("generation", obj! {}).await }

	// ---- request identity

	/// A generation to start new requests under; renewed shortly before its admission ends. Callers that wait while one
	/// is fetched take that one.
	async fn generation(&self) -> Result<String, Error> {
		let valid = |g: &Option<(String, f64)>| g.as_ref().filter(|(_, until)| until - (self.o.now)() > self.o.generation_margin_ms).map(|(g, _)| g.clone());
		if let Some(g) = valid(&self.gen.borrow()) {
			return Ok(g);
		}
		let fetches = self.gen_fetches.get();
		let _one = self.gen_lock.lock().await;
		if self.gen_fetches.get() != fetches {
			if let Some((g, _)) = self.gen.borrow().as_ref() {
				return Ok(g.clone());
			}
		}
		let r = self.raw_call("generation", obj! {}).await?;
		let g = r.get("generation").and_then(Json::as_str).unwrap_or("").to_owned();
		*self.gen.borrow_mut() = Some((g.clone(), r.get("admitUntil").and_then(Json::as_f64).unwrap_or(0.0)));
		self.gen_fetches.set(fetches + 1);
		Ok(g)
	}

	async fn identity(&self, request: Option<&RequestRef>) -> Result<RequestRef, Error> {
		self.info().await?;
		if let Some(r) = request {
			return Ok(r.clone()); // a durable caller keeps its own
		}
		Ok(RequestRef { generation: self.generation().await?, request_id: (self.o.new_request_id)() })
	}

	async fn mutate(&self, method: &str, args: Json, o: &Opts) -> Result<Json, Error> {
		let request = self.identity(o.request.as_ref()).await?;
		self.send(obj! { "method" => method, "request" => request.to_json(), "args" => args }, Some((&request, "the transport kept failing")), None).await
	}

	// ---- SpaceLike

	pub async fn write(&self, entry: &Json, txn: Option<&str>, lease: f64, o: &Opts) -> Result<Json, Error> {
		if o.unique.is_some() && !self.has_feature("write.unique").await? {
			return Err(Error::Unsupported("server does not support atomic unique writes".to_owned()));
		}
		if o.transient && !self.has_feature("write.transient").await? {
			return Err(Error::Unsupported("server does not support transient writes".to_owned()));
		}
		let mut args = obj! { "entry" => entry.clone(), "txn" => txn_arg(txn), "leaseMs" => lease_arg(lease) };
		if let Some(u) = &o.unique {
			insert(&mut args, "unique", u.clone());
		}
		if o.transient {
			insert(&mut args, "transient", Json::Bool(true));
		}
		self.mutate("write", args, o).await
	}

	/// Several steps in one call and one commit: all happen, or none. `ops` in the form of PhiSpaces.batch
	/// (`{op, entry, template, txn, lease, unique, transient}`).
	pub async fn batch(&self, ops: &[Json], o: &Opts) -> Result<Json, Error> {
		if !self.has_feature("batch").await? {
			return Err(Error::Unsupported("server does not support batch".to_owned()));
		}
		let lease = |x: &Json| lease_arg(x.get("lease").and_then(Json::as_f64).unwrap_or(ANY));
		let txn = |x: &Json| x.get("txn").cloned().unwrap_or(Json::Null);
		let wire: Vec<Json> = ops
			.iter()
			.map(|x| {
				let op = x.get("op").and_then(Json::as_str).unwrap_or("");
				match op {
					"begin" => obj! { "op" => "begin", "leaseMs" => lease(x) },
					"write" => {
						let mut w = obj! { "op" => "write" };
						if let Some(e) = x.get("entry") {
							insert(&mut w, "entry", e.clone());
						}
						insert(&mut w, "txn", txn(x));
						insert(&mut w, "leaseMs", lease(x));
						if let Some(u) = x.get("unique").filter(|u| !matches!(u, Json::Null | Json::Bool(false))) {
							insert(&mut w, "unique", u.clone());
						}
						if x.get("transient").and_then(Json::as_bool) == Some(true) {
							insert(&mut w, "transient", Json::Bool(true));
						}
						w
					}
					"take" | "read" => {
						let mut w = obj! { "op" => op };
						if let Some(t) = x.get("template") {
							insert(&mut w, "template", t.clone());
						}
						insert(&mut w, "txn", txn(x));
						w
					}
					_ => obj! { "op" => op, "txn" => txn(x) },
				}
			})
			.collect();
		self.mutate("batch", obj! { "ops" => wire }, o).await
	}

	pub async fn read(&self, tmpl: &Json, timeout: f64, o: &Opts) -> Result<Json, Error> { Ok(self.blocking("read", tmpl, timeout, o, false).await?.0) }
	pub async fn read_if_exists(&self, tmpl: &Json, timeout: f64, o: &Opts) -> Result<Json, Error> { Ok(self.blocking("read", tmpl, timeout, o, true).await?.0) }
	pub async fn take(&self, tmpl: &Json, timeout: f64, o: &Opts) -> Result<Json, Error> { Ok(self.blocking("take", tmpl, timeout, o, false).await?.0) }
	pub async fn take_if_exists(&self, tmpl: &Json, timeout: f64, o: &Opts) -> Result<Json, Error> { Ok(self.blocking("take", tmpl, timeout, o, true).await?.0) }
	/// A read_if_exists/take_if_exists that also reports a miss caused only by entries locked in other transactions.
	pub async fn probe(&self, tmpl: &Json, timeout: f64, take: bool, o: &Opts) -> Result<(Json, bool), Error> {
		if !self.has_feature("read.locked").await? {
			return Err(Error::Unsupported("server does not report locked misses".to_owned()));
		}
		self.blocking(if take { "take" } else { "read" }, tmpl, timeout, o, true).await
	}

	fn poll_ms(end: Option<Instant>) -> f64 { Self::left_ms(end).map_or(25_000.0, |l| l.floor().clamp(1.0, 25_000.0)) }

	/// A sealed, unconfirmed commit: wait a little, then the caller sends the very same call again.
	async fn sealed_wait(&self, e: Error, end: Option<Instant>) -> Result<(), Error> {
		let passed = end.is_some_and(|e| Instant::now() >= e);
		if !matches!(e, Error::OutcomeUnknown { sealed: true, .. }) || passed {
			return Err(e);
		}
		(self.o.sleep)(Self::left_ms(end).map_or(1000.0, |l| l.clamp(1.0, 1000.0))).await;
		Ok(())
	}

	async fn blocking(&self, method: &str, tmpl: &Json, timeout: f64, o: &Opts, if_exists: bool) -> Result<(Json, bool), Error> {
		if o.once {
			return Err(Error::remote("BadRequest", "`once` is a local hook: a remote call keeps its outcome under its request identity instead"));
		}
		let request = self.identity(o.request.as_ref()).await?;
		let started = Instant::now();
		let end = self.o.max_client_wait_ms.map(|ms| started + Duration::from_secs_f64(ms.max(0.0) / 1000.0));
		let mut args = obj! { "template" => tmpl.clone(), "timeoutMs" => lease_arg(timeout) };
		if let Some(d) = o.deadline {
			insert(&mut args, "deadline", Json::Number(d));
		}
		insert(&mut args, "txn", txn_arg(o.txn.as_deref()));
		insert(&mut args, "ifExists", Json::Bool(if_exists));
		insert(&mut args, "waitMs", Json::Number(Self::poll_ms(end)));
		let call = obj! { "method" => method, "request" => request.to_json(), "args" => args };
		let once = || async {
			match self.send(call.clone(), Some((&request, "the client stopped waiting; resolve the same request")), end).await {
				Ok(r) => Ok(r),
				Err(e) => self.sealed_wait(e, end).await.map(|_| obj! { "state" => "sealed" }),
			}
		};
		let mut r = once().await?;
		loop {
			match r.get("state").and_then(Json::as_str) {
				Some("done") => return Ok((r.get("entry").cloned().unwrap_or(Json::Null), r.get("locked").and_then(Json::as_bool) == Some(true))),
				Some("sealed") => {
					r = once().await?;
					continue;
				}
				_ => {}
			}
			if self.o.max_client_wait_ms.is_some_and(|ms| started.elapsed().as_secs_f64() * 1000.0 >= ms) {
				return Err(Error::OutcomeUnknown { request, why: "the client stopped waiting; the operation continues on the host".to_owned(), sealed: false });
			}
			let poll = obj! { "method" => "pollOperation", "args" => obj! { "targetRequest" => request.to_json(), "waitMs" => Self::poll_ms(end) } };
			let view = match self.send(poll, Some((&request, "the client stopped waiting while polling")), end).await {
				Ok(v) => v,
				Err(e) => {
					self.sealed_wait(e, end).await?;
					r = obj! { "state" => "sealed" };
					continue;
				}
			};
			if view.get("resultExpired").and_then(Json::as_bool) == Some(true) {
				return Err(Error::remote("ResultExpired", "the operation's retained result expired"));
			}
			if view.get("unknownOutcome").and_then(Json::as_bool) == Some(true) {
				return Err(Error::OutcomeUnknown { request, why: "restored history cannot establish the original outcome".to_owned(), sealed: false });
			}
			if let Some(e) = view.get("error").filter(|e| !e.is_null()) {
				return Err(Error::Remote {
					code: e.get("code").and_then(Json::as_str).unwrap_or("Internal").to_owned(),
					message: e.get("message").and_then(Json::as_str).unwrap_or("").to_owned(),
					required_bytes: e.get("requiredBytes").and_then(Json::as_f64),
				});
			}
			match view.get("state").and_then(Json::as_str) {
				Some("cancelled") => return Err(Error::remote("OperationCancelled", format!("request {} was cancelled", request.request_id))),
				Some("done") => return Ok((view.get("result").cloned().unwrap_or(Json::Null), view.get("locked").and_then(Json::as_bool) == Some(true))),
				_ => r = obj! { "state" => "pending" },
			}
		}
	}

	/// The state of a request of this client, e.g. after OutcomeUnknown.
	pub async fn poll_operation(&self, request: &RequestRef, wait_ms: f64) -> Result<Json, Error> {
		self.info().await?;
		self.send(obj! { "method" => "pollOperation", "args" => obj! { "targetRequest" => request.to_json(), "waitMs" => wait_ms } }, None, None).await
	}
	/// Cancel a pending request (a decided one stays as it is; the answer says which).
	pub async fn cancel_operation(&self, request: &RequestRef, o: &Opts) -> Result<Json, Error> { self.mutate("cancelOperation", obj! { "targetRequest" => request.to_json() }, o).await }

	async fn check_own_target(&self, target: &Json) -> Result<(), Error> {
		if target.as_str() == Some("self") {
			return Ok(());
		}
		let principal = self.info().await?.get("principal").cloned().unwrap_or(Json::Null);
		if *target != principal {
			return Err(Error::remote("BadRequest", "remote events target the own principal mailbox; use target: self"));
		}
		Ok(())
	}

	pub async fn notify(&self, tmpl: &Json, target: &Json, txn: Option<&str>, lease: f64, handback: Option<&Json>, o: &Opts) -> Result<Json, Error> {
		self.check_own_target(target).await?;
		self.mutate("notify", obj! { "template" => tmpl.clone(), "txn" => txn_arg(txn), "leaseMs" => lease_arg(lease), "handback" => handback.cloned().unwrap_or(Json::Null) }, o).await
	}
	/// Returns the id of the registration.
	#[allow(clippy::too_many_arguments)]
	pub async fn wait(&self, tmpl: &Json, take: bool, target: &Json, timeout: f64, txn_lease_ms: f64, handback: Option<&Json>, o: &Opts) -> Result<Json, Error> {
		self.check_own_target(target).await?;
		let r = self
			.mutate(
				"wait",
				obj! { "template" => tmpl.clone(), "take" => take, "timeoutMs" => lease_arg(timeout), "txnLeaseMs" => lease_arg(txn_lease_ms), "handback" => handback.cloned().unwrap_or(Json::Null) },
				o,
			)
			.await?;
		Ok(r.get("id").cloned().unwrap_or(Json::Null))
	}

	/// `o`: `{mailboxEpoch, after, maxBytes, waitMs}`, each optional.
	pub async fn events(&self, o: &Json) -> Result<Json, Error> {
		self.info().await?;
		self.send(obj! { "method" => "events", "args" => o.clone() }, None, None).await
	}
	pub async fn ack(&self, mailbox_epoch: &str, up_to: f64, o: &Opts) -> Result<Json, Error> { self.mutate("ack", obj! { "mailboxEpoch" => mailbox_epoch, "upTo" => up_to }, o).await }

	pub async fn read_chain(&self, tmpl: &Json, o: &Json) -> Result<Json, Error> {
		if !self.has_feature("read.chain").await? {
			return Err(Error::Unsupported("server does not support linked-entry pages".to_owned()));
		}
		self.send(obj! { "method" => "readAll", "args" => obj! { "template" => tmpl.clone(), "chain" => o.clone() } }, None, None).await
	}
	pub async fn read_page(&self, tmpl: &Json, max_bytes: Option<f64>, after: Option<&str>, token: Option<&str>, txn: Option<&str>, limit: Option<f64>) -> Result<Json, Error> {
		self.info().await?;
		let mut args = obj! { "template" => tmpl.clone() };
		if let Some(m) = max_bytes {
			insert(&mut args, "maxBytes", Json::Number(m));
		}
		if let Some(t) = token {
			insert(&mut args, "token", Json::from(t));
		}
		if let Some(l) = limit {
			insert(&mut args, "limit", Json::Number(l));
		}
		insert(&mut args, "cursor", after.map_or(Json::Null, Json::from));
		insert(&mut args, "txn", txn_arg(txn));
		self.send(obj! { "method" => "readAll", "args" => args }, None, None).await
	}
	/// All entries, or the first `limit`, fetched page by page.
	pub async fn read_all(&self, tmpl: &Json, limit: Option<f64>, txn: Option<&str>) -> Result<Vec<Json>, Error> {
		let max = limit.unwrap_or(FOREVER);
		if max.trunc() != max || max < 1.0 {
			return Err(Error::remote("BadRequest", "limit must be a positive integer"));
		}
		let mut out: Vec<Json> = Vec::new();
		let mut after: Option<String> = None;
		loop {
			// the limit goes along (a server that does not know it lists everything; the cut below still holds)
			let p = self.read_page(tmpl, None, after.as_deref(), None, txn, limit.map(|_| max)).await?;
			out.extend(p.get("items").and_then(Json::as_array).cloned().unwrap_or_default());
			after = p.get("next").and_then(Json::as_str).map(str::to_owned);
			if after.is_none() || out.len() as f64 >= max {
				break;
			}
		}
		out.truncate(max.min(out.len() as f64) as usize);
		Ok(out)
	}
	pub async fn changes(&self, after_rev: f64, max_bytes: Option<f64>, wait_ms: Option<f64>, stream_id: Option<&str>) -> Result<Json, Error> {
		self.info().await?;
		let mut args = obj! { "afterRev" => after_rev };
		if let Some(m) = max_bytes {
			insert(&mut args, "maxBytes", Json::Number(m));
		}
		if let Some(w) = wait_ms {
			insert(&mut args, "waitMs", Json::Number(w));
		}
		if let Some(s) = stream_id {
			insert(&mut args, "streamId", Json::from(s));
		}
		let r = self.send(obj! { "method" => "changes", "args" => args }, None, None).await?;
		if r.get("resync").and_then(Json::as_bool) == Some(true) {
			return Err(Error::remote("SnapshotExpired", r.get("reason").and_then(Json::as_str).unwrap_or("read the pages again")));
		}
		Ok(r)
	}
	pub async fn count(&self, tmpl: &Json, txn: Option<&str>) -> Result<f64, Error> {
		self.info().await?;
		let r = self.send(obj! { "method" => "count", "args" => obj! { "template" => tmpl.clone(), "txn" => txn_arg(txn) } }, None, None).await?;
		Ok(r.get("value").and_then(Json::as_f64).unwrap_or(0.0))
	}
	pub async fn stats(&self) -> Result<Json, Error> { Ok(self.stats_with_revision().await?.get("stats").cloned().unwrap_or(Json::Null)) }
	/// The stats with the revision they were read at, and the serving process's CPU time and memory where the server has them.
	pub async fn stats_with_revision(&self) -> Result<Json, Error> {
		self.info().await?;
		self.send(obj! { "method" => "stats" }, None, None).await
	}
	/// The spaces of the service (alias, id, creation).
	pub async fn spaces(&self) -> Result<Json, Error> { self.send(obj! { "method" => "spaces" }, None, None).await }
	pub async fn create_transaction(&self, lease: f64, o: &Opts) -> Result<Json, Error> { self.mutate("txn", obj! { "action" => "begin", "leaseMs" => lease_arg(lease) }, o).await }
	pub async fn commit(&self, txn: &str, o: &Opts) -> Result<(), Error> { self.mutate("txn", obj! { "action" => "commit", "id" => txn }, o).await.map(|_| ()) }
	pub async fn abort(&self, txn: &str, o: &Opts) -> Result<(), Error> { self.mutate("txn", obj! { "action" => "abort", "id" => txn }, o).await.map(|_| ()) }
	/// The new expiry.
	pub async fn renew(&self, lease_id: &str, ms: f64, o: &Opts) -> Result<f64, Error> {
		let r = self.mutate("lease", obj! { "action" => "renew", "id" => lease_id, "ms" => lease_arg(ms) }, o).await?;
		Ok(r.get("expires").and_then(Json::as_f64).unwrap_or(0.0))
	}
	pub async fn cancel(&self, lease_id: &str, o: &Opts) -> Result<(), Error> { self.mutate("lease", obj! { "action" => "cancel", "id" => lease_id }, o).await.map(|_| ()) }
}
