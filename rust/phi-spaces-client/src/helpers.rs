//! src/space-client.ts: the address notation, a connected client, and the small helpers every project built on
//! phi-spaces wrote for itself: telling a missing entry from a held one, waiting for work without holding anything,
//! keeping a transaction alive, and taking every match.
use crate::error::Error;
use crate::remote::{Options, Opts, RemoteSpace, NO_WAIT};
use crate::socket::{SocketOptions, SocketTransport, Target};
use phi_json::Json;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// `unix:/path`, `tcp:host:port`, or a bare path (a unix socket).
pub fn parse_target(spec: &str) -> Result<Target, String> {
	if let Some(rest) = spec.strip_prefix("tcp:") {
		let bad = || format!("a tcp address is tcp:host:port, not {spec}");
		let (host, port) = rest.rsplit_once(':').ok_or_else(bad)?;
		if host.is_empty() || host.contains(':') || port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
			return Err(bad());
		}
		return Ok(Target::Tcp { host: host.to_owned(), port: port.parse().map_err(|_| bad())? });
	}
	let path = spec.strip_prefix("unix:").unwrap_or(spec);
	if path.is_empty() {
		return Err(format!("an address is unix:/path or tcp:host:port, not {spec}"));
	}
	Ok(Target::Unix(PathBuf::from(path)))
}

/// The options of [`connect_space`]: one call may take `call_timeout_ms`; the rest are those of RemoteSpace.
#[derive(Clone)]
pub struct ConnectOptions {
	pub call_timeout_ms: f64,
	pub connect_timeout_ms: u64,
	pub attempts: u32,
	pub remote: Options,
}

impl Default for ConnectOptions {
	fn default() -> Self { ConnectOptions { call_timeout_ms: 30_000.0, connect_timeout_ms: 5_000, attempts: 3, remote: Options::default() } }
}

/// A client of the space at `spec` (parse_target). A blocking wait must stay below `call_timeout_ms`, or it ends as
/// "outcome unknown". `close()` of the transport frees the connection.
pub fn connect_space(spec: &str, o: ConnectOptions) -> Result<(Rc<RemoteSpace>, Rc<SocketTransport>), String> {
	let transport = Rc::new(SocketTransport::new(
		parse_target(spec)?,
		SocketOptions { connect_timeout_ms: o.connect_timeout_ms, request_timeout_ms: Some(o.call_timeout_ms as u64 + 5_000), ..SocketOptions::default() },
	));
	let remote = Options { call_timeout_ms: o.call_timeout_ms, attempts: o.attempts, ..o.remote };
	Ok((Rc::new(RemoteSpace::new(transport.clone(), remote)), transport))
}

fn txn_opts(txn: Option<&str>) -> Opts { Opts { txn: txn.map(str::to_owned), ..Opts::default() } }

async fn existing(space: &RemoteSpace, tmpl: &Json, wait_ms: f64, txn: Option<&str>, take: bool) -> Result<Json, Error> {
	let o = txn_opts(txn);
	let (entry, locked) = match space.probe(tmpl, wait_ms, take, &o).await {
		Ok(p) => p,
		Err(Error::Unsupported(_)) => (if take { space.take_if_exists(tmpl, wait_ms, &o).await? } else { space.read_if_exists(tmpl, wait_ms, &o).await? }, false),
		Err(e) => return Err(e),
	};
	if entry.is_null() && locked {
		let what = tmpl.get("type").map_or_else(|| "an entry".to_owned(), |t| t.as_str().map_or_else(|| t.to_json_text(), str::to_owned));
		return Err(Error::StillHeld(format!("{what} stayed held for {} ms", phi_json::number_text(wait_ms))));
	}
	Ok(entry)
}

/// read_if_exists that tells a missing entry from a held one: null means gone. A null that came only because matches
/// stayed held for `wait_ms` is StillHeld instead. Without probe (a space older than read.locked) a null counts as gone.
pub async fn read_existing(space: &RemoteSpace, tmpl: &Json, wait_ms: f64, txn: Option<&str>) -> Result<Json, Error> { existing(space, tmpl, wait_ms, txn, false).await }
/// take_if_exists with the same distinction (see read_existing).
pub async fn take_existing(space: &RemoteSpace, tmpl: &Json, wait_ms: f64, txn: Option<&str>) -> Result<Json, Error> { existing(space, tmpl, wait_ms, txn, true).await }

/// The first entry `tmpl` matches as the space stands now, or null: a snapshot read that holds nothing.
pub async fn peek(space: &RemoteSpace, tmpl: &Json, txn: Option<&str>) -> Result<Json, Error> {
	Ok(space.read_all(tmpl, Some(1.0), txn.filter(|t| !t.is_empty())).await?.into_iter().next().unwrap_or(Json::Null))
}

/// Takes every entry `tmpl` matches now, one take each, and says how many. Held matches are left alone.
pub async fn take_all(space: &RemoteSpace, tmpl: &Json, txn: Option<&str>) -> Result<u64, Error> {
	let o = txn_opts(txn.filter(|t| !t.is_empty()));
	let mut n = 0;
	while !space.take(tmpl, NO_WAIT, &o).await?.is_null() {
		n += 1;
	}
	Ok(n)
}

/// Waits until an entry of `tmpl` is there, holding nothing: one blocking read without a transaction. True when one is
/// there; false when the wait ran out or `halt` turned true (the read is then left to the space, which drops it at its
/// deadline).
pub async fn await_work(space: &RemoteSpace, tmpl: &Json, wait_ms: f64, halt: Option<watch::Receiver<bool>>) -> Result<bool, Error> {
	let read = async { Ok(!space.read(tmpl, wait_ms, &Opts::default()).await?.is_null()) };
	let Some(mut halt) = halt else { return read.await };
	if *halt.borrow() {
		return Ok(false);
	}
	tokio::select! {
		r = read => r,
		_ = halt.wait_for(|h| *h) => Ok(false),
	}
}

/// Renews a lease every third of `lease_ms` (at least every second) while long work runs in it, so a process that dies
/// lets it lapse within `lease_ms`. Stops when dropped or with `stop`.
pub struct KeepAlive(Option<JoinHandle<()>>);

impl KeepAlive {
	pub fn stop(mut self) {
		if let Some(h) = self.0.take() {
			h.abort();
		}
	}
}

impl Drop for KeepAlive {
	fn drop(&mut self) {
		if let Some(h) = self.0.take() {
			h.abort();
		}
	}
}

/// See [`KeepAlive`]. Each renewal runs on its own; a failed one is ignored, as in TypeScript. Needs a LocalSet.
pub fn keep_alive(space: Rc<RemoteSpace>, lease: &str, lease_ms: f64) -> KeepAlive {
	let every = Duration::from_millis(((lease_ms / 3.0).floor() as u64).max(1000));
	let lease = lease.to_owned();
	KeepAlive(Some(tokio::task::spawn_local(async move {
		let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
		loop {
			tick.tick().await;
			let (s, l) = (Rc::clone(&space), lease.clone());
			tokio::task::spawn_local(async move {
				let _ = s.renew(&l, lease_ms, &Opts::default()).await;
			});
		}
	})))
}

/// The first `max` UTF-16 units of `text`, without half a surrogate pair at the cut.
pub fn cut_text(text: &str, max: usize) -> &str {
	let mut units = 0;
	for (i, c) in text.char_indices() {
		if units + c.len_utf16() > max {
			return &text[..i];
		}
		units += c.len_utf16();
	}
	text
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::{LocalFuture, Transport};
	use phi_json::{obj, parse};
	use std::cell::RefCell;

	/// A host that answers hello, generation and lease at once, and a read after `read_ms` (None: never).
	struct Script {
		methods: RefCell<Vec<(String, Json)>>,
		read_ms: Option<u64>,
	}

	impl Transport for Script {
		fn request(&self, text: String) -> LocalFuture<'_, Result<String, String>> {
			Box::pin(async move {
				let call = parse(&text).map_err(|e| e.to_string())?;
				let method = call.get("method").and_then(Json::as_str).unwrap_or("").to_owned();
				self.methods.borrow_mut().push((method.clone(), call.get("args").cloned().unwrap_or(Json::Null)));
				let result = match method.as_str() {
					"hello" => obj! { "principal" => "p", "features" => Json::Array(vec![Json::from("read.locked")]), "limits" => obj! { "maxFrameBytes" => 262_144.0 } },
					"generation" => obj! { "generation" => "g1", "admitUntil" => 9e15 },
					"lease" => obj! { "expires" => 1.0 },
					"read" => match self.read_ms {
						Some(ms) => {
							tokio::time::sleep(Duration::from_millis(ms)).await;
							obj! { "state" => "done", "entry" => obj! { "type" => "Work", "fields" => obj! {} } }
						}
						None => std::future::pending().await,
					},
					other => return Err(format!("unscripted {other}")),
				};
				Ok(obj! { "ok" => true, "result" => result }.to_json_text())
			})
		}
	}

	fn space(read_ms: Option<u64>) -> (Rc<Script>, Rc<RemoteSpace>) {
		let s = Rc::new(Script { methods: RefCell::new(Vec::new()), read_ms });
		(Rc::clone(&s), Rc::new(RemoteSpace::new(s, Options::default())))
	}

	fn run<F: std::future::Future<Output = ()>>(f: F) {
		let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
		tokio::task::LocalSet::new().block_on(&rt, f);
	}

	#[test]
	fn keep_alive_renews_every_third_until_stopped_or_dropped() {
		run(async {
			let renewals = |s: &Script| s.methods.borrow().iter().filter(|(m, a)| m == "lease" && a.get("action").and_then(Json::as_str) == Some("renew")).map(|(_, a)| a.clone()).collect::<Vec<_>>();
			let (s, r) = space(None);
			let k = keep_alive(Rc::clone(&r), "txn-1", 3000.0); // every 1000 ms
			tokio::time::sleep(Duration::from_millis(900)).await;
			assert!(renewals(&s).is_empty(), "nothing before the first third");
			tokio::time::sleep(Duration::from_millis(1250)).await;
			let got = renewals(&s);
			assert_eq!(got.len(), 2, "at 1000 and 2000 ms: {got:?}");
			assert!(got.iter().all(|a| a.get("id").and_then(Json::as_str) == Some("txn-1") && a.get("ms").and_then(Json::as_f64) == Some(3000.0)));
			k.stop();
			tokio::time::sleep(Duration::from_millis(1200)).await;
			assert_eq!(renewals(&s).len(), 2, "nothing after stop");
			let (s2, r2) = space(None);
			drop(keep_alive(r2, "txn-2", 3000.0));
			tokio::time::sleep(Duration::from_millis(1200)).await;
			assert!(renewals(&s2).is_empty(), "nothing after drop");
		});
	}

	#[test]
	fn await_work_true_for_work_false_after_a_halt() {
		run(async {
			let tmpl = obj! { "type" => "Work" };
			let (s, r) = space(Some(20));
			assert!(await_work(&r, &tmpl, 1000.0, None).await.unwrap(), "an entry is there");
			assert!(s.methods.borrow().iter().any(|(m, a)| m == "read" && a.get("txn") == Some(&Json::Null)), "a read without a transaction, nothing taken");
			let (tx, rx) = watch::channel(true);
			let (s, r) = space(None);
			assert!(!await_work(&r, &tmpl, 60_000.0, Some(rx)).await.unwrap(), "halted before: false at once");
			assert!(!s.methods.borrow().iter().any(|(m, _)| m == "read"), "and no read was sent");
			drop(tx);
			let (tx, rx) = watch::channel(false);
			let (_, r) = space(None);
			let halt = async move {
				tokio::time::sleep(Duration::from_millis(30)).await;
				tx.send(true).unwrap();
				tx
			};
			let (got, _tx) = tokio::join!(await_work(&r, &tmpl, 60_000.0, Some(rx)), halt);
			assert!(!got.unwrap(), "halted while the read waits: false");
		});
	}

	#[test]
	fn connect_space_hands_its_timeouts_on() {
		let (r, t) = connect_space("unix:/nowhere.sock", ConnectOptions { call_timeout_ms: 1_000.0, attempts: 7, ..ConnectOptions::default() }).unwrap();
		assert_eq!(t.options().request_timeout_ms, Some(6_000), "a call's time plus 5 s");
		assert_eq!(t.options().connect_timeout_ms, 5_000);
		assert_eq!((r.options().attempts, r.options().call_timeout_ms), (7, 1_000.0));
		let (r, t) = connect_space("tcp:127.0.0.1:3600", ConnectOptions::default()).unwrap();
		assert_eq!((r.options().attempts, r.options().call_timeout_ms, t.options().request_timeout_ms), (3, 30_000.0, Some(35_000)));
		assert!(connect_space("tcp:nohost", ConnectOptions::default()).is_err());
	}

	#[test]
	fn targets_as_in_typescript() {
		assert_eq!(parse_target("unix:/tmp/a.sock"), Ok(Target::Unix("/tmp/a.sock".into())));
		assert_eq!(parse_target("/tmp/b.sock"), Ok(Target::Unix("/tmp/b.sock".into())));
		assert_eq!(parse_target("tcp:127.0.0.1:3600"), Ok(Target::Tcp { host: "127.0.0.1".into(), port: 3600 }));
		assert!(parse_target("tcp:host").unwrap_err().contains("tcp:host:port"));
		assert!(parse_target("unix:").unwrap_err().contains("unix:/path"));
	}

	#[test]
	fn cut_keeps_whole_pairs() {
		assert_eq!(cut_text("abc", 2), "ab");
		assert_eq!(cut_text("a😀b", 2), "a");
		assert_eq!(cut_text("a😀b", 3), "a😀");
		assert_eq!(cut_text("ab", 5), "ab");
	}

	/// Answers hello and keeps every frame it was sent.
	struct Frames(RefCell<Vec<Json>>);
	impl Transport for Frames {
		fn request(&self, text: String) -> LocalFuture<'_, Result<String, String>> {
			Box::pin(async move {
				self.0.borrow_mut().push(parse(&text).map_err(|e| e.to_string())?);
				Ok(obj! { "ok" => true, "result" => obj! { "principal" => "p", "features" => Json::Array(vec![]), "limits" => obj! { "maxFrameBytes" => 262_144.0 } } }.to_json_text())
			})
		}
	}

	#[test]
	fn an_agent_goes_on_every_call_as_frame_agent() {
		run(async {
			let t = Rc::new(Frames(RefCell::new(vec![])));
			let r = RemoteSpace::new(t.clone() as Rc<dyn Transport>, Options { agent: Some("agent-1".to_owned()), ..Options::default() });
			r.info().await.unwrap();
			let sent = t.0.borrow()[0].clone();
			assert_eq!(sent.get("frame").and_then(|f| f.get("agent")).and_then(Json::as_str), Some("agent-1"), "{}", sent.to_json_text());
			let t2 = Rc::new(Frames(RefCell::new(vec![])));
			RemoteSpace::new(t2.clone() as Rc<dyn Transport>, Options::default()).info().await.unwrap();
			assert!(t2.0.borrow()[0].get("frame").is_none(), "no agent, no frame");
		});
	}
}
