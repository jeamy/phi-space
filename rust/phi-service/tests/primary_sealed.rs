// R6b step 1 (docs/rust-portierung.en.md): the answers of a primary/sync primary whose batch was sealed and not
// confirmed. As in src/service.ts, the commit's held reply, every later call and every error answer `CommitSealed`
// (`sealedReply`), so that a client keeps resolving the same request (remote.ts `CommitSealedPending`); a commit too
// large for one journal entry is `ResourceExhausted` with the journal's message, and the store takes the next one.
use phi_json::{obj, parse, Json};
use phi_service::{sealed_reply, Conn, Options, Outcome, Service};
use phi_store::primary::{PrimaryOptions, SyncPeer};
use phi_store::sync::{JournalOptions, SyncError, SyncJournal};
use phi_store::{SpaceHost, SqliteLedger, Store, WriterOptions};
use std::sync::{Arc, Mutex};

const SPACE: &str = "sp-6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";

fn genesis() -> Json {
	obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "a", "standbyReplica" => "b", "durability" => "sync" }
}
/// A standby journal in this process; `cut` refuses every entry from then on.
struct Standby {
	journal: SyncJournal,
	cut: Arc<Mutex<bool>>,
}
impl SyncPeer for Standby {
	fn accept(&mut self, intent: &Json) -> Result<Json, SyncError> {
		if *self.cut.lock().unwrap() {
			return Err(SyncError::Blocked("the standby is cut off".into()));
		}
		self.journal.accept(intent, |_, _| Ok(()))
	}
}

fn done(o: Outcome) -> (String, u64) {
	match o {
		Outcome::Done { text, mark } => (text, mark),
		Outcome::Wait(_) => panic!("the call waits"),
	}
}

#[test]
fn a_sealed_unconfirmed_batch_answers_commit_sealed_from_then_on() {
	let d = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("primary-sealed");
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	let o = || JournalOptions { max_intent_bytes: Some(32_768.0), format: Some("own".into()), ..Default::default() };
	let cut = Arc::new(Mutex::new(false));
	let standby = Standby { journal: SyncJournal::open(&d.join("b.sqlite"), &genesis(), JournalOptions { self_id: Some("b".into()), ..o() }).unwrap(), cut: Arc::clone(&cut) };
	let journal = SyncJournal::open(&d.join("a.sqlite"), &genesis(), o()).unwrap();
	let p = PrimaryOptions { peer: Some(Box::new(standby)), assert_primary: Box::new(|| Ok(())), now: Box::new(|| 1_000.0) };
	let ledger = SqliteLedger::open_primary(&d.join("a.store.sqlite"), WriterOptions::default(), journal, p).unwrap();
	let gate = ledger.gate().cloned().unwrap();
	let mut n = 0;
	let store = Store::open(SpaceHost::sqlite(ledger), || {
		n += 1;
		phi_core::driver::seeded(&format!("sealed-{n}"))
	})
	.unwrap();
	let mut service = Service::new(store, Options::single_peer("p"));
	let conn = Conn { peer_id: Some("p".into()), identity: None, proof_key: None };
	let call = |service: &mut Service, text: &str| done(service.handle_text(text, &conn, 1_048_576.0));

	let (g, _) = call(&mut service, r#"{"method":"generation","args":{}}"#);
	let generation = parse(&g).unwrap().get("result").unwrap().get("generation").unwrap().as_str().unwrap().to_owned();
	let write = |id: &str, pad: usize| format!(r#"{{"method":"write","args":{{"entry":{{"type":"Task","fields":{{"pad":"{}"}}}}}},"request":{{"generation":"{generation}","requestId":"{id}"}}}}"#, "x".repeat(pad));
	let (w, _) = call(&mut service, &write("r1", 10));
	assert!(w.contains(r#""ok":true"#), "{w}");
	service.store.drain().unwrap();

	// too large for one entry: refused before it is published, with the journal's message; the store goes on
	let (big, _) = call(&mut service, &write("r2", 20_000));
	assert_eq!(parse(&big).unwrap().get("error").unwrap().get("code").and_then(Json::as_str), Some("ResourceExhausted"), "{big}");
	assert!(big.contains("primary/sync journal: the commit's rows"), "{big}");
	let (w, _) = call(&mut service, &write("r3", 10));
	assert!(w.contains(r#""ok":true"#), "{w}");
	service.store.drain().unwrap();

	// the standby is cut off: the next batch is sealed and not confirmed
	*cut.lock().unwrap() = true;
	let (held, mark) = call(&mut service, &write("r4", 10));
	assert!(held.contains(r#""ok":true"#), "the reply is held until its commit is durable: {held}");
	assert!(service.store.drain().is_err());
	assert!(service.store.durable() < mark, "the commit never becomes durable");
	let (revision, _) = gate.sealed().expect("the store names its candidate");
	assert_eq!(revision, gate.journal(|j| j.head_revision().unwrap()) as f64);
	// what the transport sends in place of the held reply, and what every later call gets
	let sealed = sealed_reply(revision);
	assert_eq!(sealed, format!(r#"{{"ok":false,"error":{{"code":"CommitSealed","message":"a commit of this Space is sealed but not confirmed (revision {revision}); the outcome is pending, poll or retry the same request"}}}}"#));
	assert_eq!(service.failed_reply(), sealed);
	assert_eq!(call(&mut service, &write("r4", 10)).0, sealed);
	assert_eq!(call(&mut service, r#"{"method":"count","args":{"template":{"type":"Task"}}}"#).0, sealed);
}
