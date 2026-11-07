//! The Rust client behind the TypeScript client suites (docs/rust-portierung.en.md, section 5 and R8.1):
//! `test/support/client-under-test.ts` starts this program when PHI_SPACES_CLIENT_CMD names it and forwards every
//! RemoteSpace method as one JSON line on stdin; the answer is one line on stdout. A transport can be a real socket of
//! this crate or a relay: each request text is asked of the test (`{"ask":n,"transport":t,"text":…}`) and the test's own
//! Transport answers (`{"answer":n,"ok":true,"text":…}`), so the suites' lossy, late and refusing transports drive the
//! Rust retry, identity and poll logic unchanged. The pauses between retries can be relayed the same way.
use phi_json::{obj, parse, Json};
use phi_spaces_client::{
	await_work, parse_target, peek, read_existing, take_all, take_existing, Error, LocalFuture, Options, Opts, RemoteSpace, RequestRef, SocketOptions, SocketTransport, Transport, ANY,
};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::rc::Rc;
use tokio::sync::{mpsc, oneshot};

type Answer = oneshot::Sender<Result<String, String>>;

#[derive(Default)]
struct Asks {
	next: Cell<u64>,
	open: RefCell<HashMap<u64, Answer>>,
}

fn out(line: Json) {
	let mut o = std::io::stdout().lock();
	let _ = writeln!(o, "{}", line.to_json_text());
	let _ = o.flush();
}

impl Asks {
	async fn ask(&self, mut question: Json) -> Result<String, String> {
		let n = self.next.get() + 1;
		self.next.set(n);
		let (tx, rx) = oneshot::channel();
		self.open.borrow_mut().insert(n, tx);
		if let Some(o) = question.as_object_mut() {
			o.insert("ask", Json::Number(n as f64));
		}
		out(question);
		rx.await.unwrap_or_else(|_| Err("the test went away".to_owned()))
	}
}

struct Relay {
	id: u64,
	asks: Rc<Asks>,
}

impl Transport for Relay {
	fn request(&self, text: String) -> LocalFuture<'_, Result<String, String>> { Box::pin(self.asks.ask(obj! { "transport" => self.id as f64, "text" => text })) }
}

/// A space of the driver and, when the test sets the clock, that clock.
type Held = (Rc<RemoteSpace>, Option<Rc<Cell<f64>>>);

#[derive(Default)]
struct Driver {
	asks: Rc<Asks>,
	next: Cell<u64>,
	transports: RefCell<HashMap<u64, Rc<dyn Transport>>>,
	sockets: RefCell<HashMap<u64, Rc<SocketTransport>>>,
	spaces: RefCell<HashMap<u64, Held>>,
}

fn error_json(e: &Error) -> Json {
	match e {
		Error::Remote { code, message, required_bytes } => {
			let mut j = obj! { "kind" => "Remote", "code" => code.as_str(), "message" => message.as_str() };
			if let (Some(r), Some(o)) = (required_bytes, j.as_object_mut()) {
				o.insert("requiredBytes", Json::Number(*r));
			}
			j
		}
		Error::OutcomeUnknown { request, why, sealed } => obj! { "kind" => if *sealed { "CommitSealedPending" } else { "OutcomeUnknown" }, "request" => request.to_json(), "why" => why.as_str() },
		Error::Transport(m) => obj! { "kind" => "Transport", "message" => m.as_str() },
		Error::Unsupported(m) => obj! { "kind" => "Unsupported", "message" => m.as_str() },
		Error::StillHeld(m) => obj! { "kind" => "StillHeld", "message" => m.as_str() },
	}
}

fn bad(m: impl Into<String>) -> Error { Error::remote("BadRequest", m) }
fn arg(args: &[Json], i: usize) -> Json { args.get(i).cloned().unwrap_or(Json::Null) }
fn num(v: &Json, default: f64) -> f64 { v.as_f64().unwrap_or(default) }
fn opt_num(v: &Json, k: &str) -> Option<f64> { v.get(k).and_then(Json::as_f64) }
fn opt_str(v: &Json, k: &str) -> Option<String> { v.get(k).and_then(Json::as_str).map(str::to_owned) }
/// A TypeScript duration: a number, or absent for the method's default.
fn duration(v: &Json, default: f64) -> f64 { v.as_f64().unwrap_or(default) }

/// The options object of a TypeScript call (`Req`, `OpOptions`).
fn opts(v: &Json) -> Opts {
	Opts {
		request: v.get("request").and_then(RequestRef::of),
		txn: opt_str(v, "txn"),
		deadline: opt_num(v, "deadline"),
		unique: v.get("unique").filter(|u| !u.is_null()).cloned(),
		transient: v.get("transient").and_then(Json::as_bool) == Some(true),
		once: v.get("once").is_some_and(|o| !o.is_null()),
	}
}

fn request_of(v: &Json) -> Result<RequestRef, Error> { RequestRef::of(v).ok_or_else(|| bad("a request is {generation, requestId}")) }

async fn call(space: &RemoteSpace, method: &str, a: &[Json]) -> Result<Json, Error> {
	let o = |i: usize| opts(&arg(a, i));
	let txn = |v: &Json| v.as_str().map(str::to_owned);
	Ok(match method {
		"info" => space.info().await?,
		"counters" => obj! { "retries" => space.counters.retries.get() as f64, "unknown" => space.counters.unknown.get() as f64 },
		"write" => space.write(&arg(a, 0), txn(&arg(a, 1)).as_deref(), duration(&arg(a, 2), ANY), &o(3)).await?,
		"batch" => space.batch(arg(a, 0).as_array().map_or(&[][..], Vec::as_slice), &o(1)).await?,
		"read" => space.read(&arg(a, 0), num(&arg(a, 1), 0.0), &o(2)).await?,
		"readIfExists" => space.read_if_exists(&arg(a, 0), num(&arg(a, 1), 0.0), &o(2)).await?,
		"take" => space.take(&arg(a, 0), num(&arg(a, 1), 0.0), &o(2)).await?,
		"takeIfExists" => space.take_if_exists(&arg(a, 0), num(&arg(a, 1), 0.0), &o(2)).await?,
		"probe" => {
			let (entry, locked) = space.probe(&arg(a, 0), num(&arg(a, 1), 0.0), arg(a, 2).get("take").and_then(Json::as_bool) == Some(true), &o(2)).await?;
			obj! { "entry" => entry, "locked" => locked }
		}
		"pollOperation" => space.poll_operation(&request_of(&arg(a, 0))?, num(&arg(a, 1), 0.0)).await?,
		"cancelOperation" => space.cancel_operation(&request_of(&arg(a, 0))?, &o(1)).await?,
		"notify" => {
			let x = arg(a, 1);
			space.notify(&arg(a, 0), &x.get("target").cloned().unwrap_or(Json::Null), opt_str(&x, "txn").as_deref(), opt_num(&x, "lease").unwrap_or(ANY), x.get("handback"), &opts(&x)).await?
		}
		"wait" => {
			let x = arg(a, 1);
			let take = x.get("take").and_then(Json::as_bool).unwrap_or(true);
			let target = x.get("target").cloned().unwrap_or(Json::Null);
			space.wait(&arg(a, 0), take, &target, opt_num(&x, "timeout").unwrap_or(0.0), opt_num(&x, "txnLeaseMs").unwrap_or(ANY), x.get("handback"), &opts(&x)).await?
		}
		"events" => space.events(&(if arg(a, 0).is_null() { obj! {} } else { arg(a, 0) })).await?,
		"ack" => space.ack(arg(a, 0).as_str().unwrap_or(""), num(&arg(a, 1), 0.0), &o(2)).await?,
		"readChain" => space.read_chain(&arg(a, 0), &(if arg(a, 1).is_null() { obj! {} } else { arg(a, 1) })).await?,
		"readPage" => {
			let x = arg(a, 1);
			space.read_page(&arg(a, 0), opt_num(&x, "maxBytes"), opt_str(&x, "after").as_deref(), opt_str(&x, "token").as_deref(), opt_str(&x, "txn").as_deref(), opt_num(&x, "limit")).await?
		}
		"readAll" => {
			let x = arg(a, 1);
			let limit = match x.get("limit") {
				None | Some(Json::Null) => None,
				Some(l) => Some(l.as_f64().ok_or_else(|| bad("limit must be a positive integer"))?),
			};
			Json::Array(space.read_all(&arg(a, 0), limit, opt_str(&x, "txn").as_deref()).await?)
		}
		"changes" => {
			let x = arg(a, 1);
			space.changes(num(&arg(a, 0), 0.0), opt_num(&x, "maxBytes"), opt_num(&x, "waitMs"), opt_str(&x, "streamId").as_deref()).await?
		}
		"count" => Json::Number(space.count(&arg(a, 0), txn(&arg(a, 1)).as_deref()).await?),
		"stats" => space.stats().await?,
		"statsWithRevision" => space.stats_with_revision().await?,
		"spaces" => space.spaces().await?,
		"requestGeneration" => space.request_generation().await?,
		"createTransaction" => space.create_transaction(duration(&arg(a, 0), ANY), &o(1)).await?,
		"commit" => space.commit(arg(a, 0).as_str().unwrap_or(""), &o(1)).await.map(|_| Json::Null)?,
		"abort" => space.abort(arg(a, 0).as_str().unwrap_or(""), &o(1)).await.map(|_| Json::Null)?,
		"renew" => Json::Number(space.renew(arg(a, 0).as_str().unwrap_or(""), num(&arg(a, 1), 0.0), &o(2)).await?),
		"cancel" => space.cancel(arg(a, 0).as_str().unwrap_or(""), &o(1)).await.map(|_| Json::Null)?,
		// the helpers of src/space-client.ts, the space is the first argument there
		"readExisting" => read_existing(space, &arg(a, 0), num(&arg(a, 1), 0.0), opt_str(&arg(a, 2), "txn").as_deref()).await?,
		"takeExisting" => take_existing(space, &arg(a, 0), num(&arg(a, 1), 0.0), opt_str(&arg(a, 2), "txn").as_deref()).await?,
		"peek" => peek(space, &arg(a, 0), opt_str(&arg(a, 1), "txn").as_deref()).await?,
		"takeAll" => Json::Number(take_all(space, &arg(a, 0), opt_str(&arg(a, 1), "txn").as_deref()).await? as f64),
		"awaitWork" => Json::Bool(await_work(space, &arg(a, 0), num(&arg(a, 1), 0.0), None).await?),
		other => return Err(Error::Unsupported(format!("the Rust client has no method {other}"))),
	})
}

impl Driver {
	fn id(&self) -> u64 {
		let n = self.next.get() + 1;
		self.next.set(n);
		n
	}

	fn space_options(&self, sid: u64, o: &Json) -> (Options, Option<Rc<Cell<f64>>>) {
		let mut opt = Options { space: opt_str(o, "space"), max_client_wait_ms: opt_num(o, "maxClientWaitMs"), ..Options::default() };
		if let Some(n) = opt_num(o, "attempts") {
			opt.attempts = n as u32;
		}
		if let Some(n) = opt_num(o, "backoffMs") {
			opt.backoff_ms = n;
		}
		if let Some(n) = opt_num(o, "maxBackoffMs") {
			opt.max_backoff_ms = n;
		}
		if let Some(n) = opt_num(o, "callTimeoutMs") {
			opt.call_timeout_ms = n;
		}
		if let Some(n) = opt_num(o, "generationMarginMs") {
			opt.generation_margin_ms = n;
		}
		if o.get("sleep").and_then(Json::as_str) == Some("relay") {
			let asks = Rc::clone(&self.asks);
			opt.sleep = Rc::new(move |ms: f64| {
				let asks = Rc::clone(&asks);
				Box::pin(async move {
					let _ = asks.ask(obj! { "sleep" => ms, "space" => sid as f64 }).await;
				}) as LocalFuture<'static, ()>
			});
		}
		let clock = opt_num(o, "now").map(|n| Rc::new(Cell::new(n)));
		if let Some(c) = &clock {
			let c = Rc::clone(c);
			opt.now = Rc::new(move || c.get());
		}
		(opt, clock)
	}

	async fn run(self: Rc<Self>, m: Json) -> Result<Json, Error> {
		match m.get("op").and_then(Json::as_str).unwrap_or("") {
			"newRelay" => {
				let id = self.id();
				self.transports.borrow_mut().insert(id, Rc::new(Relay { id, asks: Rc::clone(&self.asks) }));
				Ok(obj! { "transport" => id as f64 })
			}
			"newSocket" => {
				let target = parse_target(m.get("target").and_then(Json::as_str).unwrap_or("")).map_err(bad)?;
				let mut so = SocketOptions { request_timeout_ms: opt_num(&m, "requestTimeoutMs").map(|n| n as u64), ..SocketOptions::default() };
				if let Some(n) = opt_num(&m, "connectTimeoutMs") {
					so.connect_timeout_ms = n as u64;
				}
				if let Some(n) = opt_num(&m, "maxFrameBytes") {
					so.max_frame_bytes = n as usize;
				}
				let id = self.id();
				let s = Rc::new(SocketTransport::new(target, so));
				self.sockets.borrow_mut().insert(id, Rc::clone(&s));
				self.transports.borrow_mut().insert(id, s);
				Ok(obj! { "transport" => id as f64 })
			}
			"request" => {
				let t = self.transports.borrow().get(&(num(m.get("transport").unwrap_or(&Json::Null), 0.0) as u64)).cloned().ok_or_else(|| bad("no such transport"))?;
				let text = m.get("text").and_then(Json::as_str).unwrap_or("").to_owned();
				t.request(text).await.map(Json::from).map_err(Error::Transport)
			}
			"closeTransport" => {
				let id = num(m.get("transport").unwrap_or(&Json::Null), 0.0) as u64;
				if let Some(s) = self.sockets.borrow_mut().remove(&id) {
					s.close();
				}
				self.transports.borrow_mut().remove(&id);
				Ok(Json::Null)
			}
			"newSpace" => {
				let t = self.transports.borrow().get(&(num(m.get("transport").unwrap_or(&Json::Null), 0.0) as u64)).cloned().ok_or_else(|| bad("no such transport"))?;
				let id = self.id();
				let (o, clock) = self.space_options(id, m.get("options").unwrap_or(&Json::Null));
				self.spaces.borrow_mut().insert(id, (Rc::new(RemoteSpace::new(t, o)), clock));
				Ok(obj! { "space" => id as f64 })
			}
			"call" => {
				let (space, clock) = self.spaces.borrow().get(&(num(m.get("space").unwrap_or(&Json::Null), 0.0) as u64)).cloned().ok_or_else(|| bad("no such space"))?;
				if let (Some(c), Some(n)) = (clock, opt_num(&m, "now")) {
					c.set(n);
				}
				let args = m.get("args").and_then(Json::as_array).cloned().unwrap_or_default();
				call(&space, m.get("method").and_then(Json::as_str).unwrap_or(""), &args).await
			}
			"dropSpace" => {
				self.spaces.borrow_mut().remove(&(num(m.get("space").unwrap_or(&Json::Null), 0.0) as u64));
				Ok(Json::Null)
			}
			other => Err(Error::Unsupported(format!("the driver has no op {other}"))),
		}
	}
}

fn main() {
	let (tx, mut rx) = mpsc::unbounded_channel::<String>();
	std::thread::spawn(move || {
		for line in std::io::stdin().lock().lines() {
			let Ok(line) = line else { break };
			if tx.send(line).is_err() {
				break;
			}
		}
	});
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime");
	let local = tokio::task::LocalSet::new();
	local.block_on(&rt, async move {
		let driver = Rc::new(Driver::default());
		out(obj! { "ready" => true });
		while let Some(line) = rx.recv().await {
			let Ok(m) = parse(&line) else {
				out(obj! { "id" => Json::Null, "ok" => false, "error" => obj! { "kind" => "Remote", "code" => "BadRequest", "message" => "not a JSON line" } });
				continue;
			};
			if let Some(n) = m.get("answer").and_then(Json::as_f64) {
				let waiter = driver.asks.open.borrow_mut().remove(&(n as u64));
				if let Some(w) = waiter {
					let got = if m.get("ok").and_then(Json::as_bool) == Some(true) {
						Ok(m.get("text").and_then(Json::as_str).unwrap_or("").to_owned())
					} else {
						Err(m.get("message").and_then(Json::as_str).unwrap_or("the transport failed").to_owned())
					};
					let _ = w.send(got);
				}
				continue;
			}
			let id = m.get("id").cloned().unwrap_or(Json::Null);
			let d = Rc::clone(&driver);
			tokio::task::spawn_local(async move {
				out(match d.run(m).await {
					Ok(r) => obj! { "id" => id, "ok" => true, "result" => r },
					Err(e) => obj! { "id" => id, "ok" => false, "error" => error_json(&e) },
				});
			});
		}
	});
}
