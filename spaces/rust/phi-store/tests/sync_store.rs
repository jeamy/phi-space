// R6b step 1 (docs/rust-portierung.en.md): the own store under a primary/sync journal, phi_store::sync_store, held against
// OwnSyncStore and the store side of src/primary-sync.ts (test/support/journal-driver.ts). A seeded walk keeps a primary's
// journal and store and a standby's on both sides: a store bootstrapped in chunks, commits sealed and resolved (with the
// standby confirming under sync durability), entries the standby takes, its history materialized, configuration
// changes, a candidate completed under a fencing proof, and faults on purpose (rows written past the journal, a stray
// marker, a refused permit, a candidate left open). Every answer is compared, and at the end the rows of all four files
// and the digests of both stores.
//
// Steps: PHI_SYNC_STORE_STEPS (all walks together, default 2 000); one walk: PHI_SYNC_STORE_SEED.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_json::{obj, Json};
use phi_store::sync::{config_of, hash, own, JournalOptions, SyncError, SyncJournal};
use phi_store::sync_store::*;
use std::collections::BTreeMap;
use std::path::PathBuf;

struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
		let mut z = self.0;
		z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
		z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
		z ^ (z >> 31)
	}
	fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
	fn chance(&mut self, p: f64) -> bool { ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p }
}
fn temp(tag: &str) -> PathBuf {
	let d = std::env::temp_dir().join(format!("phi-syncstore-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn answer(r: Result<Json, SyncError>) -> Json {
	match r { Ok(v) => obj! { "ok" => true, "result" => v }, Err(e) => obj! { "ok" => false, "error" => obj! { "name" => e.name(), "message" => e.message() } } }
}
fn canonical(v: &Json) -> String { v.canonical().unwrap() }
fn text(v: &Json, k: &str) -> String { v.get(k).and_then(Json::as_str).unwrap_or("").to_string() }
fn num(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }
fn refuse(why: Option<String>) -> impl Fn() -> Result<(), SyncError> { move || why.clone().map_or(Ok(()), |w| Err(SyncError::Blocked(w))) }

const SPACE: &str = "sp-6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";

struct Pair { ts: TsDriver, journals: BTreeMap<String, SyncJournal>, stores: BTreeMap<String, SyncStoreFile>, dir_r: PathBuf, dir_t: PathBuf, seen: BTreeMap<String, usize>, steps: usize, seed: u64 }
impl Pair {
	fn rust(&mut self, q: &Json) -> Result<Json, SyncError> {
		let op = text(q, "op");
		let (name, st) = (text(q, "name"), text(q, "store"));
		let g = |k: &str| q.get(k).cloned().unwrap_or(Json::Null);
		let why = q.get("why").and_then(Json::as_str).map(String::from);
		Ok(match op.as_str() {
			"open" => {
				self.journals.remove(&name);
				let o = JournalOptions { self_id: q.get("self").and_then(Json::as_str).map(String::from), format: q.get("format").and_then(Json::as_str).map(String::from), ..Default::default() };
				let j = SyncJournal::open(&self.dir_r.join(format!("{name}.sqlite")), &g("genesis"), o)?;
				let h = j.head()?;
				self.journals.insert(name, j);
				h
			}
			"storeOpen" => { self.stores.remove(&st); self.stores.insert(st.clone(), SyncStoreFile::open(&self.dir_r.join(format!("{st}.store.sqlite"))).map_err(SyncError::Blocked)?); Json::Null }
			"storeClose" => { self.stores.remove(&st); Json::Null }
			"storeCommit" => { self.stores.get_mut(&st).unwrap().commit(g("deltas").as_array().unwrap())?; Json::Null }
			"marker" => self.stores.get(&st).unwrap().marker(&text(q, "spaceId"))?.unwrap_or(Json::Null),
			"capture" => Json::String(self.stores.get(&st).unwrap().capture()?.1),
			"seal" => self.journals.get_mut(&name).unwrap().seal(g("deltas").as_array().unwrap(), num(q, "validatedAt"))?,
			"accept" => self.journals.get_mut(&name).unwrap().accept(&g("intent"), |_, _| Ok(()))?,
			"catchUp" => self.journals.get_mut(&name).unwrap().catch_up(&g("intent"), || Ok(()))?,
			"state" => {
				let j = self.journals.get_mut(&name).unwrap();
				let open = Json::Array(j.open_transition_ids()?.into_iter().map(Json::String).collect());
				obj! { "head" => j.head()?, "applied" => j.applied_revision()? as f64, "config" => j.config(), "configHash" => j.config_hash(), "recoveredCommitted" => j.recovered_committed()?, "open" => open, "historyBytes" => j.history_bytes()? as f64, "format" => j.format().map_or(Json::Null, |f| Json::String(f.into())) }
			}
			_ => {
				let mut store = self.stores.remove(&st).unwrap();
				let mut journal = self.journals.remove(&name).unwrap();
				let mut peer_journal = q.get("peer").and_then(Json::as_str).map(|p| (p.to_string(), self.journals.remove(p).unwrap()));
				let has_peer = peer_journal.is_some();
				let r = {
				let mut accept = |i: &Json| peer_journal.as_mut().unwrap().1.accept(i, |_, _| Ok(()));
				let peer: Option<Peer<'_>> = if has_peer { Some(&mut accept) } else { None };
				match op.as_str() {
					"bootstrap" => bootstrap_primary_sync(&mut store, &mut journal, num(q, "now"), q.get("chunkBytes").and_then(Json::as_f64).map(|c| c as usize)),
					"materialize" => { let a = refuse(why.clone()); materialize_sync_history(&mut store, &mut journal, why.as_ref().map(|_| &a as &dyn Fn() -> Result<(), SyncError>)).map(|_| Json::Null) }
					"recover" => recover_primary_sync(&mut store, &mut journal, peer, &refuse(why)).map(|_| Json::Null),
					"recoverSealed" => recover_sealed_without_standby(&mut store, &mut journal, &refuse(why)).map(|r| r.map_or(Json::Null, Json::Number)),
					"transitionApply" => apply_config_transition(&mut store, &mut journal, &g("next"), &text(q, "reason"), peer, &refuse(why), num(q, "now")),
					other => panic!("unknown op {other}"),
				}
				};
				if let Some((p, j)) = peer_journal { self.journals.insert(p, j); }
				self.journals.insert(name, journal);
				self.stores.insert(st, store);
				r?
			}
		})
	}
	fn both(&mut self, mut q: Json) -> Json {
		let op = text(&q, "op");
		*self.seen.entry(op.clone()).or_default() += 1;
		self.steps += 1;
		let r = answer(self.rust(&q));
		let o = q.as_object_mut().unwrap();
		if op == "open" { let p = self.dir_t.join(format!("{}.sqlite", text(&Json::Object(o.clone()), "name"))).to_string_lossy().to_string(); o.insert("path", Json::String(p)); }
		if op == "storeOpen" { let p = self.dir_t.join(format!("{}.store.sqlite", text(&Json::Object(o.clone()), "store"))).to_string_lossy().to_string(); o.insert("path", Json::String(p)); }
		let t = self.ts.step(&q);
		assert_eq!(canonical(&r), canonical(&t), "seed {} step {}: {}\nrust {}\nts   {}", self.seed, self.steps, q.to_json_text(), r.to_json_text(), t.to_json_text());
		if r.get("ok") == Some(&Json::Bool(true)) { *self.seen.entry(format!("{op} ok")).or_default() += 1; }
		r
	}
	/// The rows of a store file on both sides agree (the commit sequence too: both counted the same commits).
	fn store_rows(&mut self, st: &str) {
		let t = self.ts.step(&obj! { "op" => "storeRows", "store" => st });
		let db = rusqlite::Connection::open(self.dir_r.join(format!("{st}.store.sqlite"))).unwrap();
		let rows = |sql: &str, n: usize| -> Vec<Json> {
			let mut s = db.prepare(sql).unwrap();
			let names: Vec<String> = s.column_names().iter().map(|c| c.to_string()).collect();
			s.query_map([], |r| { let mut o = phi_json::Object::new(); for (i, c) in names.iter().enumerate().take(n) { o.insert(c.clone(), match r.get_ref(i)? { rusqlite::types::ValueRef::Null => Json::Null, rusqlite::types::ValueRef::Integer(x) => Json::Number(x as f64), rusqlite::types::ValueRef::Real(x) => Json::Number(x), rusqlite::types::ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into()), rusqlite::types::ValueRef::Blob(_) => Json::Null }); } Ok(Json::Object(o)) }).unwrap().map(Result::unwrap).collect()
		};
		let got = obj! { "documents" => Json::Array(rows("SELECT kind, key, version, value FROM documents ORDER BY kind, key", 4)), "parts" => Json::Array(rows("SELECT kind, key, part, id, ord, value, at, grp, flag FROM parts ORDER BY kind, key, part, id", 9)), "meta" => Json::Array(rows("SELECT key, value FROM store_meta ORDER BY key", 2)) };
		// the store's own identity (its format and creation stamp) may differ between the files; everything else must not
		let strip = |v: &Json| { let mut v = v.clone(); if let Some(m) = v.as_object_mut().and_then(|o| o.get_mut("meta")).and_then(Json::as_array_mut) { m.retain(|r| r.get("key").and_then(Json::as_str).is_some_and(|k| k.starts_with("sync-marker:") || k == "commit_seq")); } v };
		assert_eq!(canonical(&strip(&got)), canonical(&strip(t.get("result").unwrap())), "seed {}: the rows of store {st}", self.seed);
	}
}

fn genesis(durability: &str) -> Json {
	obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "a", "standbyReplica" => if durability == "sync" { Json::String("b".into()) } else { Json::Null }, "durability" => durability }
}
fn row(rng: &mut Rng, n: usize) -> Json {
	let kind = "phi-spaces.named-space";
	match rng.below(10) {
		0..=4 => obj! { "t" => "doc", "kind" => kind, "key" => format!("k{}", rng.below(4)), "version" => 5.0, "value" => format!("{{\"n\":{n}}}") },
		5..=7 => obj! { "t" => "part", "kind" => kind, "key" => format!("k{}", rng.below(3)), "part" => "entries", "id" => format!("e{}", rng.below(12)), "ord" => n as f64, "value" => format!("{{\"n\":{n}}}"), "at" => if rng.chance(0.3) { Json::Number(1_767_225_600_000.0 + n as f64) } else { Json::Null }, "grp" => if rng.chance(0.2) { Json::String("g".into()) } else { Json::Null }, "flag" => if rng.chance(0.2) { Json::Number(1.0) } else { Json::Null } },
		8 => obj! { "t" => "partDel", "kind" => kind, "key" => "k0", "part" => "entries", "id" => format!("e{}", rng.below(12)) },
		_ => obj! { "t" => "retire", "kind" => kind, "key" => format!("k{}", rng.below(4)) },
	}
}
fn next_config(rng: &mut Rng, c: &Json) -> Json {
	let mut n = c.as_object().unwrap().clone();
	n.insert("replicaConfigVersion", Json::Number(num(c, "replicaConfigVersion") + 1.0));
	let (p, s) = (text(c, "primaryReplica"), c.get("standbyReplica").and_then(Json::as_str).map(String::from));
	match rng.below(3) {
		0 => { n.insert("durability", Json::String("single".into())); n.insert("standbyReplica", Json::Null); n.insert("primaryEpoch", Json::Number(num(c, "primaryEpoch") + 1.0)); }
		1 if p == "a" => { n.insert("durability", Json::String("sync".into())); n.insert("standbyReplica", Json::String("b".into())); }
		_ if s.is_some() => { n.insert("standbyReplica", Json::String(s.unwrap())); }
		_ => {}
	}
	Json::Object(n)
}

fn walk(seed: u64, steps: usize) -> BTreeMap<String, usize> {
	let mut rng = Rng(seed);
	let (dir_r, dir_t) = (temp("r"), temp("t"));
	let mut pair = Pair { ts: TsDriver::script("test/support/journal-driver.ts"), journals: BTreeMap::new(), stores: BTreeMap::new(), dir_r: dir_r.clone(), dir_t: dir_t.clone(), seen: BTreeMap::new(), steps: 0, seed };
	let g = genesis("single");
	pair.both(obj! { "op" => "open", "name" => "p", "genesis" => g.clone(), "format" => "own" });
	pair.both(obj! { "op" => "open", "name" => "s", "genesis" => g.clone(), "self" => "b" });
	pair.both(obj! { "op" => "storeOpen", "store" => "P" });
	pair.both(obj! { "op" => "storeOpen", "store" => "S" });
	let mut n = 0usize;
	let mut now = 1_767_225_600_000.0_f64;
	// a store with data, brought under the journal in chunks; sometimes changed between sealing and its markers
	for _ in 0..rng.below(30) { n += 1; let d = vec![row(&mut rng, n)]; pair.both(obj! { "op" => "storeCommit", "store" => "P", "deltas" => Json::Array(d) }); }
	let chunk = [None, Some(200.0), Some(600.0)][rng.below(3)];
	let mut q = obj! { "op" => "bootstrap", "store" => "P", "name" => "p", "now" => now };
	if let Some(c) = chunk { q.as_object_mut().unwrap().insert("chunkBytes", Json::Number(c)); }
	pair.both(q.clone());
	if rng.chance(0.1) { n += 1; let d = vec![row(&mut rng, n)]; pair.both(obj! { "op" => "storeCommit", "store" => "P", "deltas" => Json::Array(d) }); }
	pair.both(q);
	// what setStandby does: the standby catches up, then confirms the configuration that makes it the sync standby
	if rng.chance(0.85) {
		let ph = num(&pair.journals.get("p").unwrap().head().unwrap(), "revision") as usize;
		for r in 1..=ph { let i = pair.journals.get("p").unwrap().intent(r as f64).unwrap().unwrap(); pair.both(obj! { "op" => "catchUp", "name" => "s", "intent" => i }); }
		let mut next = pair.journals.get("p").unwrap().config().as_object().unwrap().clone();
		next.insert("standbyReplica", Json::String("b".into()));
		next.insert("durability", Json::String("sync".into()));
		next.insert("replicaConfigVersion", Json::Number(2.0));
		pair.both(obj! { "op" => "transitionApply", "store" => "P", "name" => "p", "next" => Json::Object(next), "reason" => "standby-1", "peer" => "s", "now" => now });
	}
	// edges the walk rarely meets, on a journal and stores of their own: a replica store with data of its own, and a
	// marker that looks like an interrupted apply but does not bind the journal's prefix
	if num(&pair.journals.get("p").unwrap().head().unwrap(), "revision") >= 1.0 {
		pair.both(obj! { "op" => "open", "name" => "e", "genesis" => g.clone(), "self" => "b" });
		let first = pair.journals.get("p").unwrap().intent(1.0).unwrap().unwrap();
		pair.both(obj! { "op" => "catchUp", "name" => "e", "intent" => first.clone() });
		pair.both(obj! { "op" => "storeOpen", "store" => "E" });
		n += 1;
		let stray = row(&mut rng, n);
		pair.both(obj! { "op" => "storeCommit", "store" => "E", "deltas" => Json::Array(vec![stray]) });
		pair.both(obj! { "op" => "materialize", "store" => "E", "name" => "e" });
		pair.both(obj! { "op" => "storeOpen", "store" => "F" });
		let looks = obj! { "configHash" => "x", "revision" => 1.0, "batchHash" => text(&first, "batchHash"), "previousHash" => "z" };
		pair.both(obj! { "op" => "storeCommit", "store" => "F", "deltas" => Json::Array(vec![own::marker_write(SPACE, &looks)]) });
		pair.both(obj! { "op" => "materialize", "store" => "F", "name" => "e" });
		pair.both(obj! { "op" => "storeClose", "store" => "E" });
		pair.both(obj! { "op" => "storeClose", "store" => "F" });
	}
	for _ in 0..steps {
		now += 1.0 + rng.below(100) as f64;
		let p = pair.journals.get("p").unwrap();
		let (head, config, config_hash) = (p.head().unwrap(), p.config(), p.config_hash());
		let sync = config.get("durability").and_then(Json::as_str) != Some("single");
		let peer = if sync && config.get("standbyReplica").and_then(Json::as_str) == Some("b") { Some("s") } else { None };
		match rng.below(100) {
			0..=39 => {
				// a commit: sealed, then resolved (the standby confirming under sync), as a primary's host does
				let count = 1 + rng.below(3);
				let batch: Vec<Json> = (0..count).map(|_| { n += 1; row(&mut rng, n) }).collect();
				let value = obj! { "configHash" => config_hash.as_str(), "revision" => num(&head, "revision") + 1.0, "batchHash" => hash(&Json::Array(batch.clone())), "previousHash" => text(&head, "hash") };
				let mut deltas = batch;
				deltas.push(own::marker_write(SPACE, &value));
				pair.both(obj! { "op" => "seal", "name" => "p", "deltas" => Json::Array(deltas), "validatedAt" => now });
				if rng.chance(0.85) {
					let mut q = obj! { "op" => "recover", "store" => "P", "name" => "p" };
					if let Some(pe) = peer.filter(|_| rng.chance(0.9)) { q.as_object_mut().unwrap().insert("peer", Json::String(pe.into())); }
					if rng.chance(0.05) { q.as_object_mut().unwrap().insert("why", Json::String("fenced".into())); }
					pair.both(q);
				}
			}
			40..=59 => {
				// the standby takes what it misses, in order
				let sh = num(&pair.journals.get("s").unwrap().head().unwrap(), "revision");
				if sh >= num(&head, "revision") { continue; }
				let i = pair.journals.get("p").unwrap().intent(sh + 1.0).unwrap().unwrap();
				let op = if rng.chance(0.5) { "catchUp" } else { "accept" };
				pair.both(obj! { "op" => op, "name" => "s", "intent" => i });
			}
			60..=69 => {
				let mut q = obj! { "op" => "materialize", "store" => "S", "name" => "s" };
				if rng.chance(0.05) { q.as_object_mut().unwrap().insert("why", Json::String("not a replica".into())); }
				pair.both(q);
			}
			70..=79 => {
				let next = next_config(&mut rng, &config);
				let joins = next.get("standbyReplica").and_then(Json::as_str) == Some("b") && config_of(&next).is_ok();
				let mut q = obj! { "op" => "transitionApply", "store" => "P", "name" => "p", "next" => next, "reason" => format!("t-{}", rng.below(1000)), "now" => now };
				if joins && rng.chance(0.85) { q.as_object_mut().unwrap().insert("peer", Json::String("s".into())); }
				if rng.chance(0.05) { q.as_object_mut().unwrap().insert("why", Json::String("not primary".into())); }
				pair.both(q);
			}
			80..=84 => { let mut q = obj! { "op" => "recoverSealed", "store" => "P", "name" => "p" }; if rng.chance(0.2) { q.as_object_mut().unwrap().insert("why", Json::String("no fencing proof".into())); } pair.both(q); }
			85 if rng.chance(0.3) => {
				// rows written past the journal, or a stray marker: what the checks of the data prefix must see
				let target = if rng.chance(0.5) { "P" } else { "S" };
				n += 1;
				let d = if rng.chance(0.5) { row(&mut rng, n) } else { own::marker_write(SPACE, &obj! { "configHash" => "x", "revision" => 1.0, "batchHash" => "y", "previousHash" => "z" }) };
				pair.both(obj! { "op" => "storeCommit", "store" => target, "deltas" => Json::Array(vec![d]) });
			}
			85..=93 => { let st = if rng.chance(0.5) { "P" } else { "S" }; pair.both(obj! { "op" => "capture", "store" => st }); pair.both(obj! { "op" => "marker", "store" => st, "spaceId" => SPACE }); }
			_ => { let name = if rng.chance(0.5) { "p" } else { "s" }; pair.both(obj! { "op" => "state", "name" => name }); }
		}
	}
	pair.both(obj! { "op" => "materialize", "store" => "S", "name" => "s" });
	for st in ["P", "S"] { pair.both(obj! { "op" => "capture", "store" => st }); pair.store_rows(st); }
	let seen = pair.seen.clone();
	drop(pair);
	let _ = std::fs::remove_dir_all(dir_r);
	let _ = std::fs::remove_dir_all(dir_t);
	seen
}

#[test]
fn the_store_side_answers_as_typescript_does() {
	let total: usize = std::env::var("PHI_SYNC_STORE_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(2000);
	let seeds: Vec<u64> = match std::env::var("PHI_SYNC_STORE_SEED").ok().and_then(|s| s.parse().ok()) { Some(s) => vec![s], None => (1..=8).collect() };
	let mut seen: BTreeMap<String, usize> = BTreeMap::new();
	for s in &seeds { for (k, v) in walk(*s, total / seeds.len()) { *seen.entry(k).or_default() += v; } }
	eprintln!("store walk: {seen:?}");
	for op in ["bootstrap", "seal", "recover", "materialize", "transitionApply", "accept", "catchUp"] { assert!(seen.get(&format!("{op} ok")).copied().unwrap_or(0) > 0, "the walk reached a {op} that succeeds"); }
	assert!(seen.get("materialize").copied().unwrap_or(0) > seen.get("materialize ok").copied().unwrap_or(0), "the walk reached a refused materialization");
}
