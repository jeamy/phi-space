// R6b step 2 (docs/rust-portierung.en.md): the signed replica transport (src/replica-transport.ts) on a real socket, held
// against TypeScript both ways. A Rust primary sends its entries to a TypeScript standby's listener, a TypeScript primary
// to a Rust standby's; the ACKs and the standby's head must be the journal's, a journal refusal must arrive as a signed
// refusal (`StandbyRefused`), and an unpinned key, a sender claiming another host, an answer for another host, a
// replayed or altered request must be refused by the other side as by TypeScript. The handler's own checks (stale,
// replayed, altered, a forged or rebound answer) are held in process as test/test-replica-transport.test.ts holds them.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_host::auth::Signer;
use phi_host::replica_transport::*;
use phi_json::{obj, parse, Json};
use phi_store::primary::SyncPeer;
use phi_store::sync::{hash, own, JournalOptions, SyncError, SyncJournal};
use std::cell::RefCell;
use std::collections::HashSet;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

const SPACE: &str = "sp-6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";
const LOCAL: &str = "127.0.0.1";
const INTERNAL: &str = r#"{"ok":false,"error":{"code":"Internal","message":"internal error"}}"#;

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn genesis() -> Json {
	obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "p", "standbyReplica" => "q", "durability" => "sync" }
}
fn now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64 }
fn num(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap() }
fn text<'a>(v: &'a Json, k: &str) -> &'a str { v.get(k).and_then(Json::as_str).unwrap() }
fn result(r: Json) -> Json {
	assert_eq!(r.get("ok"), Some(&Json::Bool(true)), "{}", r.to_json_text());
	r.get("result").cloned().unwrap_or(Json::Null)
}
fn error_name(r: &Json) -> String { text(r.get("error").unwrap(), "name").to_owned() }

/// A key file of `provisionFileSigner`, made by TypeScript; its pin and the Rust signer of it.
fn key(ts: &mut TsDriver, d: &Path, host: &str) -> (ReplicaPin, Signer, String) {
	let path = d.join(format!("{host}.json")).to_string_lossy().into_owned();
	let pin = result(ts.step(&obj! { "op" => "pin", "key" => path.as_str() }));
	let pin = ReplicaPin { host_id: host.into(), algorithm: phi_host::auth::Algorithm::Ed25519, public_key: text(&pin, "publicKey").into() };
	let (signer, _) = Signer::from_key_file(&parse(&std::fs::read_to_string(&path).unwrap()).unwrap()).unwrap();
	(pin, signer, path)
}
fn pin_json(p: &ReplicaPin) -> Json { obj! { "hostId" => p.host_id.as_str(), "algorithm" => "ed25519", "publicKey" => p.public_key.as_str() } }

/// The deltas of the next entry after `head`: one row and the marker that names it.
fn next_deltas(head: &Json, config_hash: &str, n: usize) -> Json {
	let batch = vec![obj! { "t" => "doc", "kind" => "phi-spaces.named-space", "key" => format!("k{}", n % 3), "version" => 5.0, "value" => format!("{{\"n\":{n}}}") }];
	let value = obj! { "configHash" => config_hash, "revision" => num(head, "revision") + 1.0, "batchHash" => hash(&Json::Array(batch.clone())), "previousHash" => text(head, "hash") };
	let mut deltas = batch;
	deltas.push(own::marker_write(SPACE, &value));
	Json::Array(deltas)
}
fn seal_next(j: &mut SyncJournal, n: usize) -> Json {
	let deltas = next_deltas(&j.head().unwrap(), &j.config_hash(), n);
	let i = j.seal(deltas.as_array().unwrap(), now()).unwrap();
	j.mark_applied(&i, false).unwrap();
	i
}
fn ack(i: &Json, config_hash: &str) -> Json { obj! { "revision" => num(i, "revision"), "hash" => text(i, "hash"), "configHash" => config_hash } }

fn peer(signer: Signer, self_id: &str, remote: ReplicaPin, port: u16) -> SignedReplicaPeer {
	SignedReplicaPeer { transport: Box::new(SocketTransport::new((LOCAL.into(), port), Some(LOCAL.parse().unwrap()))), signer, self_id: self_id.into(), remote, now: Box::new(now) }
}
/// A transport that keeps what it sent, to send it again.
struct Recording(SocketTransport, Arc<Mutex<Vec<String>>>);
impl Transport for Recording {
	fn request(&mut self, text: &str) -> Result<String, String> {
		self.1.lock().unwrap().push(text.to_owned());
		self.0.request(text)
	}
}

#[test]
fn a_rust_primary_sends_to_a_typescript_standby() {
	let d = dir("replica-transport-rust-primary");
	let mut ts = TsDriver::script("test/support/journal-driver.ts");
	let (pp, p_signer, _) = key(&mut ts, &d, "p");
	let (pq, _, q_key) = key(&mut ts, &d, "q");
	let (_, x_signer, _) = key(&mut ts, &d, "x");
	let o = || JournalOptions { format: Some("own".into()), ..Default::default() };
	let mut journal = SyncJournal::open(&d.join("p.sqlite"), &genesis(), JournalOptions { self_id: Some("p".into()), ..o() }).unwrap();
	result(ts.step(&obj! { "op" => "open", "name" => "q", "path" => d.join("q.sqlite").to_string_lossy().as_ref(), "genesis" => genesis(), "self" => "q", "format" => "own" }));
	let listen = |ts: &mut TsDriver, why: Json| num(&obj! { "port" => result(ts.step(&obj! { "op" => "listen", "name" => "q", "key" => q_key.as_str(), "self" => "q", "remotes" => Json::Array(vec![pin_json(&pp)]), "why" => why })) }, "port") as u16;
	let port = listen(&mut ts, Json::Null);

	let sent = Arc::new(Mutex::new(vec![]));
	let mut client = peer(p_signer, "p", pq.clone(), port);
	client.transport = Box::new(Recording(SocketTransport::new((LOCAL.into(), port), Some(LOCAL.parse().unwrap())), Arc::clone(&sent)));
	assert_eq!(num(&client.head().unwrap(), "revision"), 0.0);
	let config_hash = journal.config_hash();
	for n in 1..=12 {
		let i = seal_next(&mut journal, n);
		// the writer's way (`SyncPeer`) and the resolver's are the same call
		let a = if n % 2 == 0 { SyncPeer::accept(&mut client, &i).unwrap() } else { client.accept(&i).unwrap() };
		assert_eq!(a, ack(&i, &config_hash), "entry {n}");
	}
	let head = client.head().unwrap();
	assert_eq!(head, journal.head().unwrap(), "the standby's head is the primary's");

	// the journal's refusal is a signed answer: an entry out of order, one sent again with other content
	let skipped = { let mut i = journal.intent(3.0).unwrap().unwrap(); i.as_object_mut().unwrap().insert("revision", Json::Number(20.0)); i };
	match client.accept(&skipped) { Err(ReplicaError::Refused(m)) => assert!(m.starts_with("standby refused: "), "{m}"), r => panic!("{r:?}") }
	match SyncPeer::accept(&mut client, &skipped) { Err(SyncError::Blocked(m)) => assert!(m.starts_with("standby refused: "), "{m}"), r => panic!("{r:?}") }
	// the same entry again is idempotent
	assert_eq!(client.accept(&journal.intent(12.0).unwrap().unwrap()).unwrap(), ack(&journal.intent(12.0).unwrap().unwrap(), &config_hash));

	// a captured request sent again is refused before the journal sees it, as is an altered body
	let captured = sent.lock().unwrap()[1].clone();
	let mut raw = SocketTransport::new((LOCAL.into(), port), None);
	assert_eq!(raw.request(&captured).unwrap(), INTERNAL, "a replayed request");
	let mut altered = parse(&captured).unwrap();
	altered.as_object_mut().unwrap().insert("body", obj! { "x" => 1.0 });
	assert_eq!(raw.request(&altered.to_json_text()).unwrap(), INTERNAL, "an altered request");

	// an unpinned key, a sender claiming another host, a request for another replica: no authentic answer
	let unauth = Err(ReplicaError::Transport("unauthenticated replica response".into()));
	assert_eq!(peer(x_signer, "p", pq.clone(), port).head(), unauth);
	let (_, p2, _) = key(&mut ts, &d, "p");
	assert_eq!(peer(p2, "other", pq.clone(), port).head(), unauth);
	let (_, p3, _) = key(&mut ts, &d, "p");
	assert_eq!(peer(p3, "p", ReplicaPin { host_id: "elsewhere".into(), ..pq.clone() }, port).head(), unauth);

	// catch-up while the quarantine holds and while it does not
	let (_, p4, _) = key(&mut ts, &d, "p");
	let refusing = listen(&mut ts, "not in quarantine".into());
	let i13 = seal_next(&mut journal, 13);
	match peer(p4, "p", pq.clone(), refusing).catch_up(&i13) { Err(ReplicaError::Refused(m)) => assert_eq!(m, "standby refused: not in quarantine"), r => panic!("{r:?}") }
	assert_eq!(client.catch_up(&i13).unwrap(), ack(&i13, &config_hash));
	assert_eq!(client.head().unwrap(), journal.head().unwrap());
}

/// A Rust standby's listener on a thread of its own; `quarantine` is the refusal of catch-up, if any.
fn rust_listener(journal: Arc<Mutex<SyncJournal>>, signer: Signer, remotes: Vec<ReplicaPin>, peers: HashSet<IpAddr>, quarantine: Option<String>) -> u16 {
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
		tokio::task::LocalSet::new().block_on(&rt, async move {
			let l = tokio::net::TcpListener::bind((LOCAL, 0)).await.unwrap();
			tx.send(l.local_addr().unwrap().port()).unwrap();
			let handler = Rc::new(RefCell::new(ReplicaSyncHandler::new(signer, "q", remotes)));
			let handle: Handle = Rc::new(move |text| {
				let (handler, journal, quarantine) = (Rc::clone(&handler), Arc::clone(&journal), quarantine.clone());
				Box::pin(async move {
					let a = handler.borrow_mut().admit(&text, now())?;
					let out = journal_answer(&mut journal.lock().unwrap(), &a, |_, _| Ok(()), || quarantine.map_or(Ok(()), |w| Err(SyncError::Blocked(w))));
					Ok(handler.borrow().answer(&a, out))
				})
			});
			serve_replica(l, peers, handle).await
		});
	});
	rx.recv().unwrap()
}

#[test]
fn a_typescript_primary_sends_to_a_rust_standby() {
	let d = dir("replica-transport-ts-primary");
	let mut ts = TsDriver::script("test/support/journal-driver.ts");
	let (pp, _, p_key) = key(&mut ts, &d, "p");
	let (pq, q_signer, _) = key(&mut ts, &d, "q");
	let (_, _, x_key) = key(&mut ts, &d, "x");
	let journal = Arc::new(Mutex::new(SyncJournal::open(&d.join("q.sqlite"), &genesis(), JournalOptions { self_id: Some("q".into()), format: Some("own".into()), ..Default::default() }).unwrap()));
	let local: HashSet<IpAddr> = [LOCAL.parse().unwrap()].into();
	let port = rust_listener(Arc::clone(&journal), q_signer, vec![pp.clone()], local.clone(), None);
	result(ts.step(&obj! { "op" => "open", "name" => "p", "path" => d.join("p.sqlite").to_string_lossy().as_ref(), "genesis" => genesis(), "self" => "p", "format" => "own" }));
	let ts_peer = |ts: &mut TsDriver, name: &str, key: &str, self_id: &str, remote: &ReplicaPin, port: u16| {
		result(ts.step(&obj! { "op" => "peer", "peer" => name, "key" => key, "self" => self_id, "remote" => pin_json(remote), "port" => port as f64 }));
	};
	ts_peer(&mut ts, "q", &p_key, "p", &pq, port);
	let call = |ts: &mut TsDriver, peer: &str, method: &str, intent: &Json| ts.step(&obj! { "op" => "peerCall", "peer" => peer, "method" => method, "intent" => intent.clone() });
	assert_eq!(num(&result(call(&mut ts, "q", "head", &Json::Null)), "revision"), 0.0);
	for n in 1..=12 {
		let state = result(ts.step(&obj! { "op" => "state", "name" => "p" }));
		let deltas = next_deltas(state.get("head").unwrap(), text(&state, "configHash"), n);
		let i = result(ts.step(&obj! { "op" => "seal", "name" => "p", "deltas" => deltas, "validatedAt" => now() }));
		result(ts.step(&obj! { "op" => "markApplied", "name" => "p", "intent" => i.clone() }));
		assert_eq!(result(call(&mut ts, "q", "accept", &i)), ack(&i, text(&state, "configHash")), "entry {n}");
	}
	let head = result(ts.step(&obj! { "op" => "state", "name" => "p" })).get("head").cloned().unwrap();
	assert_eq!(journal.lock().unwrap().head().unwrap(), head, "the standby's head is the primary's");
	assert_eq!(result(call(&mut ts, "q", "head", &Json::Null)), head);

	// the journal's refusal reaches TypeScript as StandbyRefused with the journal's message
	let mut skipped = result(ts.step(&obj! { "op" => "intent", "name" => "p", "revision" => 3.0 }));
	skipped.as_object_mut().unwrap().insert("revision", Json::Number(20.0));
	let r = call(&mut ts, "q", "accept", &skipped);
	assert_eq!(error_name(&r), "StandbyRefused", "{}", r.to_json_text());
	let rust_says = journal.lock().unwrap().accept(&skipped, |_, _| Ok(())).unwrap_err().to_string();
	assert_eq!(text(r.get("error").unwrap(), "message"), format!("standby refused: {rust_says}"));

	// an unpinned key, a sender claiming another host, an answer for another host: refused by TypeScript's client
	ts_peer(&mut ts, "x", &x_key, "p", &pq, port);
	ts_peer(&mut ts, "other", &p_key, "other", &pq, port);
	ts_peer(&mut ts, "elsewhere", &p_key, "p", &ReplicaPin { host_id: "elsewhere".into(), ..pq.clone() }, port);
	for name in ["x", "other", "elsewhere"] {
		let r = call(&mut ts, name, "head", &Json::Null);
		assert_eq!(error_name(&r), "ReplicaTransportRefused", "{name}: {}", r.to_json_text());
		assert_eq!(text(r.get("error").unwrap(), "message"), "unauthenticated replica response");
	}
	// a connection from an address that is no peer's is closed unanswered
	let closed = rust_listener(Arc::clone(&journal), key(&mut ts, &d, "q").1, vec![pp.clone()], HashSet::new(), None);
	ts_peer(&mut ts, "closed", &p_key, "p", &pq, closed);
	let r = call(&mut ts, "closed", "head", &Json::Null);
	// (the line's own error, "connection lost" or a reset: no answer, signed or not)
	assert_eq!(error_name(&r), "Error", "{}", r.to_json_text());

	// catch-up while the quarantine holds and while it does not
	let refusing = rust_listener(Arc::clone(&journal), key(&mut ts, &d, "q").1, vec![pp.clone()], local, Some("not in quarantine".into()));
	ts_peer(&mut ts, "refusing", &p_key, "p", &pq, refusing);
	let state = result(ts.step(&obj! { "op" => "state", "name" => "p" }));
	let i = result(ts.step(&obj! { "op" => "seal", "name" => "p", "deltas" => next_deltas(state.get("head").unwrap(), text(&state, "configHash"), 13), "validatedAt" => now() }));
	let r = call(&mut ts, "refusing", "catchUp", &i);
	assert_eq!((error_name(&r).as_str(), text(r.get("error").unwrap(), "message")), ("StandbyRefused", "standby refused: not in quarantine"));
	assert_eq!(result(call(&mut ts, "q", "catchUp", &i)), ack(&i, text(&state, "configHash")));
	assert_eq!(journal.lock().unwrap().head_revision().unwrap(), 13);
}

/// The handler's own checks, in process (test/test-replica-transport.test.ts).
#[test]
fn the_handler_refuses_what_typescript_refuses() {
	let d = dir("replica-transport-handler");
	let seed = |b: u8| Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[b; 32]));
	let pin = |host: &str, b: u8| ReplicaPin { host_id: host.into(), algorithm: phi_host::auth::Algorithm::Ed25519, public_key: phi_host::auth::to_base64(ed25519_dalek::SigningKey::from_bytes(&[b; 32]).verifying_key().as_bytes()) };
	let journal = SyncJournal::open(&d.join("q.sqlite"), &genesis(), JournalOptions { self_id: Some("q".into()), ..Default::default() }).unwrap();
	let side = Arc::new(Mutex::new((ReplicaSyncHandler::new(seed(2), "q", vec![pin("p", 1)]), journal)));
	let clock = Arc::new(Mutex::new(1_000_000.0));
	let serve: Serve = {
		let (side, clock) = (Arc::clone(&side), Arc::clone(&clock));
		Arc::new(move |text: &str| {
			let (handler, journal) = &mut *side.lock().unwrap();
			let a = handler.admit(text, *clock.lock().unwrap())?;
			let out = journal_answer(journal, &a, |_, _| Ok(()), || Ok(()));
			Ok(handler.answer(&a, out))
		})
	};
	let sent = Arc::new(Mutex::new(vec![]));
	let client = |signer: Signer, self_id: &str, remote: ReplicaPin, relay: bool| {
		let c = Arc::clone(&clock);
		SignedReplicaPeer { transport: Box::new(Line { serve: Arc::clone(&serve), sent: Arc::clone(&sent), relay, first: None }), signer, self_id: self_id.into(), remote, now: Box::new(move || *c.lock().unwrap()) }
	};
	let last = || sent.lock().unwrap().last().unwrap().clone();
	assert_eq!(num(&client(seed(1), "p", pin("q", 2), false).head().unwrap(), "revision"), 0.0);
	// an unpinned key, a sender claiming another host, a request for another replica: refused before the journal
	let unauth = Err(ReplicaError::Transport("unauthenticated replica request".into()));
	assert_eq!(client(seed(3), "p", pin("q", 2), false).head(), unauth);
	assert_eq!(client(seed(1), "other", pin("q", 2), false).head(), unauth);
	assert_eq!(client(seed(1), "p", pin("elsewhere", 2), false).head(), unauth);
	// replay, an altered body, a stale timestamp
	client(seed(1), "p", pin("q", 2), false).head().unwrap();
	let captured = last();
	assert_eq!(serve(&captured), Err("replayed replica request".into()));
	let mut altered = parse(&captured).unwrap();
	altered.as_object_mut().unwrap().insert("body", obj! { "x" => 1.0 });
	assert_eq!(serve(&altered.to_json_text()), Err("stale or altered replica request".into()));
	*clock.lock().unwrap() = 2_000_000.0;
	assert_eq!(serve(&captured), Err("stale or altered replica request".into()), "a request from long ago");
	let mut late = client(seed(1), "p", pin("q", 2), false);
	late.now = Box::new(|| 1_000_000.0);
	assert_eq!(late.head(), Err(ReplicaError::Transport("stale or altered replica request".into())));
	assert!(client(seed(1), "p", pin("q", 2), false).head().is_ok(), "a fresh request at the new time");
	// an answer to one request given for another, and a forged answer
	let mut relay = client(seed(1), "p", pin("q", 2), true);
	relay.head().unwrap();
	assert_eq!(relay.head(), Err(ReplicaError::Transport("unauthenticated replica response".into())));
	let mut forged = client(seed(1), "p", pin("q", 2), false);
	forged.transport = Box::new(Forged);
	assert_eq!(forged.head(), Err(ReplicaError::Transport("unauthenticated replica response".into())));
	// a journal refusal is a signed answer
	match client(seed(1), "p", pin("q", 2), false).accept(&obj! { "version" => 1.0 }) { Err(ReplicaError::Refused(m)) => assert!(m.starts_with("standby refused: "), "{m}"), r => panic!("{r:?}") }
}

type Serve = Arc<dyn Fn(&str) -> Result<String, String> + Send + Sync>;
/// The line in process: every text kept; `relay` answers with the first answer it ever gave.
struct Line {
	serve: Serve,
	sent: Arc<Mutex<Vec<String>>>,
	relay: bool,
	first: Option<String>,
}
impl Transport for Line {
	fn request(&mut self, text: &str) -> Result<String, String> {
		self.sent.lock().unwrap().push(text.to_owned());
		let a = (self.serve)(text)?;
		Ok(if self.relay { self.first.get_or_insert(a).clone() } else { a })
	}
}
struct Forged;
impl Transport for Forged {
	fn request(&mut self, _: &str) -> Result<String, String> { Ok(r#"{"value":{"from":"q","to":"p","nonce":"00000000000000000000000000000000","method":"head","ok":true,"result":{"revision":99}},"signature":"AAAA"}"#.into()) }
}
