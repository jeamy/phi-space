// R6b step 2: the replica transitions of src/replica-control.ts on files, with a register in a file and a fencing adapter that
// knows the proofs it gave. The standby is promoted behind a proof of the old primary, its permits follow and the old
// primary is fenced; the promoted primary degrades to single behind a proof of its standby and completes the candidate
// it sealed without one. A transition ID is bound to its transition, a repeat of a completed one changes nothing, and
// without a verified proof nothing moves.
use phi_host::register::SqliteRegister;
use phi_host::replica_notice::latest_notice;
use phi_host::replica_transitions::{degrade_to_single, promote, readmit_space, release_host_to_quarantine, Common, Excluded, Fencing, TR};
use phi_json::{obj, Json};
use phi_store::sync::{hash, own, JournalOptions, SyncJournal};
use phi_store::sync_store::SyncStoreFile;
use std::cell::RefCell;
use std::path::{Path, PathBuf};

const SPACE: &str = "sp-0d7f3a52-6c1e-4b8a-9f21-3e5a7c9b1d04";

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn genesis() -> Json {
	obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "a", "standbyReplica" => "b", "durability" => "sync" }
}
fn boot(host: &str, role: &str, epoch: f64, version: f64) -> Json {
	obj! { "hostId" => host, "state" => "active", "spaces" => obj! { SPACE => obj! { "state" => "active", "authorityId" => "authority", "dataIncarnation" => "1ed6e700", "role" => role, "primaryEpoch" => epoch, "replicaConfigVersion" => version, "durability" => "sync", "transitionId" => "setup" } } }
}
fn value(r: &SqliteRegister, key: &str) -> Json { r.get(key).unwrap().get("value").cloned().unwrap_or(Json::Null) }
fn text(v: &Json, k: &str) -> String { v.get(k).and_then(Json::as_str).unwrap_or("").to_owned() }

/// The fencing service as the transitions see it: a proof it gave verifies, any other does not.
struct Fence(RefCell<Vec<String>>);
impl Fencing for Fence {
	fn kind(&self) -> &str { "container" }
	fn fence(&self, host_id: &str, reason: &str) -> TR<Json> {
		let p = obj! { "hostId" => host_id, "kind" => "container", "observedAt" => 1.0, "restartLocked" => true, "evidence" => obj! { "reason" => reason } };
		self.0.borrow_mut().push(p.canonical().unwrap());
		Ok(p)
	}
	fn verify(&self, proof: &Json) -> TR<bool> { Ok(self.0.borrow().contains(&proof.canonical().unwrap())) }
	fn release(&self, _: &str) -> TR<()> { Ok(()) }
}

/// Entries sealed on a's journal and accepted by b's, the last one left a candidate on a only.
fn histories(d: &Path) -> (SyncJournal, SyncJournal) {
	let mut a = SyncJournal::open(&d.join("a.journal"), &genesis(), JournalOptions { self_id: Some("a".into()), format: Some("own".into()), ..Default::default() }).unwrap();
	let mut b = SyncJournal::open(&d.join("b.journal"), &genesis(), JournalOptions { self_id: Some("b".into()), format: Some("own".into()), ..Default::default() }).unwrap();
	for n in 0..4 {
		let head = a.head().unwrap();
		let batch = vec![obj! { "t" => "doc", "kind" => "phi-spaces.named-space", "key" => "k", "version" => 5.0, "value" => format!("{{\"n\":{n}}}") }];
		let value = obj! { "configHash" => a.config_hash(), "revision" => head.get("revision").and_then(Json::as_f64).unwrap() + 1.0, "batchHash" => hash(&Json::Array(batch.clone())), "previousHash" => text(&head, "hash") };
		let mut deltas = batch;
		deltas.push(own::marker_write(SPACE, &value));
		let i = a.seal(&deltas, 1_000.0).unwrap();
		if n < 3 {
			b.accept(&i, |_, _| Ok(())).unwrap();
			a.mark_applied(&i, false).unwrap();
		}
	}
	(a, b)
}

#[test]
fn promote_and_degrade_move_the_space_behind_verified_proofs() {
	let d = dir("replica-transitions");
	let register = SqliteRegister::open(&d.join("external.sqlite")).unwrap();
	let installed = SqliteRegister::open(&d.join("installed-b.sqlite")).unwrap();
	register.compare_and_set("boot:a", None, &boot("a", "primary", 1.0, 1.0)).unwrap();
	register.compare_and_set("boot:b", None, &boot("b", "standby", 1.0, 1.0)).unwrap();
	let (_a, mut b) = histories(&d);
	let mut storage = SyncStoreFile::open(&d.join("b.store")).unwrap();
	let fence = Fence(RefCell::new(vec![]));
	let mut o = Common { storage: &mut storage, journal: &mut b, register: &register, installed: Some(&installed), host_id: "b", data_incarnation: "1ed6e700", now: 2_000.0 };

	// a claim that was never fenced moves nothing
	let forged = obj! { "hostId" => "a", "kind" => "container", "observedAt" => 1.0, "restartLocked" => true };
	assert_eq!(promote(&mut o, "promote-0", 1.0, 1.0, &fence, &forged), Err("no verified fencing proof for a".into()));
	assert_eq!(text(&value(&register, "boot:a"), "state"), "active");
	// the refused transition stays open and blocks every other until it is abandoned
	let proof = fence.fence("a", "promote promote-1").unwrap();
	assert_eq!(promote(&mut o, "promote-1", 1.0, 1.0, &fence, &proof), Err("replica transition promote-0 is still open; resume or abandon it first".into()));
	o.journal.abandon_transition("promote-0").unwrap();
	// the wrong versions move nothing
	assert_eq!(promote(&mut o, "promote-1", 1.0, 2.0, &fence, &proof), Err("only the fixed synchronous standby of the expected configuration is promoted".into()));

	o.journal.abandon_transition("promote-1").unwrap();
	let r = promote(&mut o, "promote-2", 1.0, 1.0, &fence, &proof).unwrap();
	let c = r.get("config").unwrap();
	assert_eq!((text(c, "primaryReplica"), text(c, "standbyReplica")), ("b".into(), "a".into()));
	assert_eq!(c.get("primaryEpoch").and_then(Json::as_f64), Some(2.0));
	let a_boot = value(&register, "boot:a");
	assert_eq!(text(&a_boot, "state"), "fenced", "the old primary is fenced");
	assert_eq!(text(a_boot.get("spaces").unwrap().get(SPACE).unwrap(), "state"), "revoked");
	let b_permit = value(&register, "boot:b").get("spaces").unwrap().get(SPACE).cloned().unwrap();
	assert_eq!((text(&b_permit, "role"), b_permit.get("primaryEpoch").and_then(Json::as_f64)), ("primary".into(), Some(2.0)));
	assert_eq!(value(&installed, &format!("installed:b:{SPACE}")), b_permit, "the local installation follows");
	// the notice the new primary offers its control host
	let notice = latest_notice(o.journal, "1ed6e700").unwrap().expect("a completed transition has its notice");
	assert_eq!(notice, obj! { "authorityId" => "authority", "spaceId" => SPACE, "recoveryId" => "promote-2", "primaryReplica" => "b", "standbyReplica" => "a", "primaryEpoch" => 2.0, "replicaConfigVersion" => 2.0, "durability" => "sync", "dataIncarnation" => "1ed6e700" });
	// a completed transition repeated changes nothing; its ID is bound to it
	let version = register.get("boot:b").unwrap().get("version").cloned();
	assert_eq!(promote(&mut o, "promote-2", 1.0, 1.0, &fence, &proof).unwrap(), r);
	assert_eq!(register.get("boot:b").unwrap().get("version").cloned(), version);
	assert_eq!(degrade_to_single(&mut o, "promote-2", 2.0, 2.0, Excluded::Fenced(&fence, &proof)), Err("transition ID was used for another transition".into()));
	assert_eq!(o.journal.head_revision().unwrap(), 4, "three entries the standby held, and the promotion");

	// degradeToSingle behind a proof of the standby (a, fenced already)
	let standby = fence.fence("a", "degrade degrade-1").unwrap();
	let r = degrade_to_single(&mut o, "degrade-1", 2.0, 2.0, Excluded::Fenced(&fence, &standby)).unwrap();
	let c = r.get("config").unwrap();
	assert_eq!((text(c, "durability"), c.get("standbyReplica").cloned()), ("single".into(), Some(Json::Null)));
	assert_eq!((c.get("primaryEpoch").and_then(Json::as_f64), c.get("replicaConfigVersion").and_then(Json::as_f64)), (Some(3.0), Some(3.0)));
	let b_permit = value(&register, "boot:b").get("spaces").unwrap().get(SPACE).cloned().unwrap();
	assert_eq!((text(&b_permit, "durability"), b_permit.get("primaryEpoch").and_then(Json::as_f64)), ("single".into(), Some(3.0)));
	assert_eq!(o.journal.applied_revision().unwrap(), o.journal.head_revision().unwrap(), "nothing left unresolved");
	let notice = latest_notice(o.journal, "1ed6e700").unwrap().unwrap();
	assert_eq!((text(&notice, "recoveryId"), notice.get("standbyReplica").cloned(), text(&notice, "durability")), ("degrade-1".into(), Some(Json::Null), "single".into()));

	// the fenced old primary: released only into quarantine, and a Space of its own re-admitted once it is active again
	assert_eq!(text(&release_host_to_quarantine(&register, "a", "release-1", Some(&fence)).unwrap(), "state"), "quarantine");
	assert_eq!(release_host_to_quarantine(&register, "b", "release-2", None), Err("b is not fenced; release only leads into quarantine".into()));
	let mut a = value(&register, "boot:a");
	let local = obj! { "state" => "revoked", "authorityId" => "authority", "dataIncarnation" => "aa000001", "role" => "local", "transitionId" => "t1" };
	let mut spaces = a.get("spaces").and_then(Json::as_object).cloned().unwrap();
	spaces.insert("sp-local", local);
	a.as_object_mut().unwrap().insert("state", "active".into());
	a.as_object_mut().unwrap().insert("spaces", Json::Object(spaces));
	let version = register.get("boot:a").unwrap().get("version").and_then(Json::as_f64);
	register.compare_and_set("boot:a", version, &a).unwrap();
	assert_eq!(readmit_space(&register, "a", SPACE, "readmit-0", "1ed6e700"), Err("replicated Spaces return only through promote, degradeToSingle or setStandby".into()));
	assert_eq!(readmit_space(&register, "a", "sp-local", "readmit-0", "aa000002"), Err("permit of sp-local is not a revoked permit of incarnation aa000002".into()));
	let back = readmit_space(&register, "a", "sp-local", "readmit-1", "aa000001").unwrap();
	assert_eq!(text(back.get("spaces").unwrap().get("sp-local").unwrap(), "state"), "active");
	assert_eq!(readmit_space(&register, "a", "sp-local", "readmit-1", "aa000001").unwrap(), back, "once is enough");
}
