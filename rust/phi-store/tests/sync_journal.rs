// R6b step 1 (docs/rust-portierung.en.md): the primary/sync journal, phi_store::sync::SyncJournal, held against PrimarySyncJournal
// (test/support/journal-driver.ts). A seeded walk drives a primary's journal and a standby's through both implementations,
// each on its own file: commits with their markers, bootstrap chunks, configuration entries, entries the standby accepts
// or catches up on, transition records, and faults on purpose (a changed hash, a marker that does not bind, a row that
// touches the marker, a gap, the wrong standby, a refused permit, an oversized entry, a full history, a changed genesis).
// Every answer is compared, and at the end every row of both files. The vector journals of test/vectors open as well.
//
// Steps: PHI_SYNC_WALK_STEPS (all walks together, default 3 000); one walk: PHI_SYNC_WALK_SEED.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_json::{obj, parse, Json};
use phi_store::sync::{config_of, hash, marker_of, own, JournalOptions, SyncError, SyncJournal};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
	let d = std::env::temp_dir().join(format!("phi-sync-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn answer(r: Result<Json, SyncError>) -> Json {
	match r { Ok(v) => obj! { "ok" => true, "result" => v }, Err(e) => obj! { "ok" => false, "error" => obj! { "name" => e.name(), "message" => e.message() } } }
}
fn canonical(v: &Json) -> String { v.canonical().unwrap() }
fn text(v: &Json, k: &str) -> String { v.get(k).and_then(Json::as_str).unwrap_or("").to_string() }
fn num(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }

/// Both implementations, each journal under the same name on its own file.
struct Pair { ts: TsDriver, rust: BTreeMap<String, SyncJournal>, dir_r: PathBuf, dir_t: PathBuf, seen: BTreeMap<String, usize>, steps: usize, seed: u64 }
impl Pair {
	fn rust_open(&mut self, q: &Json) -> Result<Json, SyncError> {
		let name = text(q, "name");
		self.rust.remove(&name);
		let o = JournalOptions { max_intent_bytes: q.get("maxIntentBytes").and_then(Json::as_f64), max_history_bytes: q.get("maxHistoryBytes").and_then(Json::as_f64), self_id: q.get("self").and_then(Json::as_str).map(String::from), format: q.get("format").and_then(Json::as_str).map(String::from) };
		let j = SyncJournal::open(&self.dir_r.join(format!("{name}.sqlite")), q.get("genesis").unwrap(), o)?;
		let head = j.head()?;
		self.rust.insert(name, j);
		Ok(head)
	}
	fn rust_step(&mut self, q: &Json) -> Result<Json, SyncError> {
		let op = text(q, "op");
		if op == "open" { return self.rust_open(q); }
		let name = text(q, "name");
		if op == "close" { self.rust.remove(&name); return Ok(Json::Null); }
		let j = self.rust.get_mut(&name).ok_or_else(|| SyncError::Blocked(format!("no journal {name}")))?;
		let g = |k: &str| q.get(k).cloned().unwrap_or(Json::Null);
		Ok(match op.as_str() {
			"seal" => j.seal(g("deltas").as_array().unwrap(), num(q, "validatedAt"))?,
			"sealBootstrap" => Json::Array(j.seal_bootstrap(&g("chunks").as_array().unwrap().iter().map(|c| c.as_array().unwrap().clone()).collect::<Vec<_>>(), &text(q, "storeHash"), num(q, "validatedAt"))?),
			"sealTransition" => j.seal_transition(&g("next"), &text(q, "reason"), &g("mark"), num(q, "validatedAt"))?,
			"accept" => j.accept(&g("intent"), |_, _| Ok(()))?,
			"acceptRefused" => { let why = text(q, "why"); j.accept(&g("intent"), |_, _| Err(SyncError::Blocked(why)))? }
			"catchUp" => { let why = q.get("why").and_then(Json::as_str).map(String::from); j.catch_up(&g("intent"), || why.map_or(Ok(()), |w| Err(SyncError::Blocked(w))))? }
			"begin" => j.begin_transition(&text(q, "id"), &g("record"))?,
			"abandon" => { j.abandon_transition(&text(q, "id"))?; Json::Null }
			"save" => { j.save_transition(&text(q, "id"), &g("record"))?; Json::Null }
			"transition" => j.transition(&text(q, "id"))?.unwrap_or(Json::Null),
			"markApplied" => { j.mark_applied(&g("intent"), q.get("recovered").and_then(Json::as_bool) == Some(true))?; Json::Null }
			"intent" => j.intent(num(q, "revision"))?.unwrap_or(Json::Null),
			"state" => {
				let open = Json::Array(j.open_transition_ids()?.into_iter().map(Json::String).collect());
				obj! { "head" => j.head()?, "applied" => j.applied_revision()? as f64, "config" => j.config(), "configHash" => j.config_hash(), "recoveredCommitted" => j.recovered_committed()?, "open" => open, "historyBytes" => j.history_bytes()? as f64, "format" => j.format().map_or(Json::Null, |f| Json::String(f.into())) }
			}
			other => panic!("unknown op {other}"),
		})
	}
	/// One operation through both; the answers must agree. The Rust answer, for the walk to continue from.
	fn both(&mut self, mut q: Json) -> Json {
		let op = text(&q, "op");
		*self.seen.entry(op.clone()).or_default() += 1;
		self.steps += 1;
		let r = answer(self.rust_step(&q));
		if op == "open" { let path = self.dir_t.join(format!("{}.sqlite", text(&q, "name"))).to_string_lossy().to_string(); q.as_object_mut().unwrap().insert("path", Json::String(path)); }
		let t = self.ts.step(&q);
		assert_eq!(canonical(&r), canonical(&t), "seed {} step {}: {}\nrust {}\nts   {}", self.seed, self.steps, q.to_json_text(), r.to_json_text(), t.to_json_text());
		if r.get("ok") == Some(&Json::Bool(true)) { *self.seen.entry(format!("{op} ok")).or_default() += 1; }
		r
	}
	fn rows(&mut self, name: &str) {
		let t = self.ts.step(&obj! { "op" => "rows", "name" => name });
		let db = rusqlite::Connection::open(self.dir_r.join(format!("{name}.sqlite"))).unwrap();
		let meta: Vec<Json> = db.prepare("SELECT key, value FROM sync_meta ORDER BY key").unwrap().query_map([], |r| Ok(obj! { "key" => r.get::<_, String>(0)?, "value" => r.get::<_, String>(1)? })).unwrap().map(Result::unwrap).collect();
		let intents: Vec<Json> = db.prepare("SELECT revision, hash, intent FROM sync_intents ORDER BY revision").unwrap().query_map([], |r| Ok(obj! { "revision" => r.get::<_, i64>(0)? as f64, "hash" => r.get::<_, String>(1)?, "intent" => r.get::<_, String>(2)? })).unwrap().map(Result::unwrap).collect();
		assert_eq!(canonical(&obj! { "meta" => Json::Array(meta), "intents" => Json::Array(intents) }), canonical(t.get("result").unwrap()), "seed {}: the rows of {name}", self.seed);
	}
}

const SPACE: &str = "sp-6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";
fn genesis(durability: &str) -> Json {
	obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "a", "standbyReplica" => if durability == "sync" { Json::String("b".into()) } else { Json::Null }, "durability" => durability }
}
fn row(rng: &mut Rng, n: usize, big: bool) -> Json {
	let value = if big { "x".repeat(9000 + rng.below(9000)) } else { format!("{{\"n\":{n}}}") };
	if rng.chance(0.6) { obj! { "t" => "doc", "kind" => "phi-spaces.named-space", "key" => format!("k{}", rng.below(4)), "version" => 5.0, "value" => value } }
	else { obj! { "t" => "part", "kind" => "phi-spaces.named-space", "key" => "k0", "part" => "entries", "id" => format!("e{n}"), "ord" => n as f64, "value" => value, "at" => Json::Null, "grp" => Json::Null, "flag" => Json::Null } }
}
fn marker_value(head: &Json, config_hash: &str, batch: &Json) -> Json {
	obj! { "configHash" => config_hash, "revision" => num(head, "revision") + 1.0, "batchHash" => hash(batch), "previousHash" => text(head, "hash") }
}
/// A next configuration: mostly a valid step, sometimes one the journal refuses.
fn next_config(rng: &mut Rng, c: &Json) -> Json {
	let mut n = c.as_object().unwrap().clone();
	let (epoch, version) = (num(c, "primaryEpoch"), num(c, "replicaConfigVersion"));
	n.insert("replicaConfigVersion", Json::Number(version + if rng.chance(0.9) { 1.0 } else { 2.0 }));
	let (p, s) = (text(c, "primaryReplica"), c.get("standbyReplica").and_then(Json::as_str).map(String::from));
	match rng.below(5) {
		0 => { n.insert("durability", Json::String("single".into())); n.insert("standbyReplica", Json::Null); n.insert("primaryEpoch", Json::Number(epoch + 1.0)); }
		1 => { n.insert("durability", Json::String("sync".into())); n.insert("standbyReplica", Json::String(if p == "a" { "b" } else { "a" }.into())); }
		2 if s.is_some() => { n.insert("primaryReplica", Json::String(s.clone().unwrap())); n.insert("standbyReplica", Json::String(p.clone())); n.insert("primaryEpoch", Json::Number(epoch + if rng.chance(0.85) { 1.0 } else { 0.0 })); }
		3 => { n.insert("primaryEpoch", Json::Number(epoch + 3.0)); }
		_ => {}
	}
	Json::Object(n)
}

fn walk(seed: u64, steps: usize) -> BTreeMap<String, usize> {
	let mut rng = Rng(seed);
	let (dir_r, dir_t) = (temp("r"), temp("t"));
	let mut pair = Pair { ts: TsDriver::script("test/support/journal-driver.ts"), rust: BTreeMap::new(), dir_r: dir_r.clone(), dir_t: dir_t.clone(), seen: BTreeMap::new(), steps: 0, seed };
	let start = if rng.chance(0.5) { "single" } else { "sync" };
	let g = genesis(start);
	let small = rng.chance(0.3);
	let bounds = |q: &mut Json| if small { let o = q.as_object_mut().unwrap(); o.insert("maxIntentBytes", Json::Number(32768.0)); o.insert("maxHistoryBytes", Json::Number(98304.0)); };
	// the primary's journal is bound by the store it drives; the standby's binds with the first entry it accepts
	let mut open_p = if rng.chance(0.9) { obj! { "op" => "open", "name" => "p", "genesis" => g.clone(), "format" => "own" } } else { obj! { "op" => "open", "name" => "p", "genesis" => g.clone() } };
	let mut open_s = obj! { "op" => "open", "name" => "s", "genesis" => g.clone(), "self" => "b" };
	bounds(&mut open_p);
	bounds(&mut open_s);
	pair.both(open_p.clone());
	pair.both(open_s.clone());
	let mut now = 1_767_225_600_000.0_f64;
	let mut n = 0usize;
	if start == "single" && rng.chance(0.5) {
		let chunks: Vec<Json> = (0..1 + rng.below(3)).map(|_| Json::Array((0..1 + rng.below(3)).map(|_| { n += 1; row(&mut rng, n, false) }).collect())).collect();
		let store_hash = hash(&Json::Array(chunks.clone()));
		let r = pair.both(obj! { "op" => "sealBootstrap", "name" => "p", "chunks" => Json::Array(chunks), "storeHash" => store_hash, "validatedAt" => now });
		if let Some(list) = r.get("result").and_then(Json::as_array) { if rng.chance(0.8) { for i in list.clone() { pair.both(obj! { "op" => "markApplied", "name" => "p", "intent" => i }); } } }
	}
	let ids = ["t-1", "t-2", "t-3"];
	for _ in 0..steps {
		now += 1.0 + rng.below(1000) as f64;
		let p = pair.rust.get("p").unwrap();
		let (head, config_hash, config) = (p.head().unwrap(), p.config_hash(), p.config());
		match rng.below(100) {
			0..=34 => {
				// a candidate left open is mostly applied first, as the host does once its batch is written
				let applied = pair.rust.get("p").unwrap().applied_revision().unwrap() as f64;
				if num(&head, "revision") > applied && rng.chance(0.7) {
					let i = pair.rust.get("p").unwrap().intent(num(&head, "revision")).unwrap().unwrap();
					pair.both(obj! { "op" => "markApplied", "name" => "p", "intent" => i });
				}
				let count = 1 + rng.below(3);
				let batch: Vec<Json> = (0..count).map(|_| { n += 1; let big = small && rng.chance(0.15); row(&mut rng, n, big) }).collect();
				let mut deltas = batch.clone();
				if rng.chance(0.03) { deltas.push(obj! { "t" => "meta", "key" => format!("sync-marker:{SPACE}"), "value" => "{}" }); }
				let mut value = marker_value(&head, &config_hash, &Json::Array(deltas.clone()));
				if rng.chance(0.04) { value.as_object_mut().unwrap().insert("revision", Json::Number(num(&head, "revision") + 2.0)); }
				deltas.push(own::marker_write(if rng.chance(0.02) { "sp-other" } else { SPACE }, &value));
				let r = pair.both(obj! { "op" => "seal", "name" => "p", "deltas" => Json::Array(deltas), "validatedAt" => if rng.chance(0.02) { -1.0 } else { now } });
				if let Some(i) = r.get("result").filter(|_| r.get("ok") == Some(&Json::Bool(true))) { if rng.chance(0.8) { pair.both(obj! { "op" => "markApplied", "name" => "p", "intent" => i.clone() }); } }
			}
			35..=54 => {
				// the standby takes the primary's next entry, or another one, sometimes altered
				let sh = num(&pair.rust.get("s").unwrap().head().unwrap(), "revision");
				let ph = num(&head, "revision");
				if ph < 1.0 { continue; }
				let rev = if rng.chance(0.8) { (sh + 1.0).min(ph) } else { 1.0 + rng.below(ph as usize) as f64 };
				let Some(mut i) = pair.rust.get("p").unwrap().intent(rev).unwrap() else { continue };
				match rng.below(20) {
					0 => { let at = num(&i, "validatedAt") + 1.0; i.as_object_mut().unwrap().insert("validatedAt", Json::Number(at)); }
					1 => { let mut c = i.get("config").unwrap().as_object().unwrap().clone(); c.insert("standbyReplica", Json::String("z".into())); i.as_object_mut().unwrap().insert("config", Json::Object(c)); }
					2 => { i.as_object_mut().unwrap().remove("batchHash"); }
					_ => {}
				}
				let op = match rng.below(10) { 0 => "acceptRefused", 1 | 2 => "catchUp", _ => "accept" };
				let mut q = obj! { "op" => op, "name" => "s", "intent" => i.clone() };
				if op == "acceptRefused" || (op == "catchUp" && rng.chance(0.2)) { q.as_object_mut().unwrap().insert("why", Json::String("not in quarantine".into())); }
				let r = pair.both(q);
				if r.get("ok") == Some(&Json::Bool(true)) && rng.chance(0.3) { pair.both(obj! { "op" => "markApplied", "name" => "s", "intent" => i }); }
			}
			55..=64 => {
				let next = next_config(&mut rng, &config);
				let value = obj! { "configHash" => config_of(&next).map(|c| hash(&c)).unwrap_or_default(), "revision" => num(&head, "revision") + 1.0, "batchHash" => hash(&Json::Array(vec![])), "previousHash" => text(&head, "hash") };
				let reason = if rng.chance(0.03) { "bad reason!".to_string() } else { ids[rng.below(3)].to_string() };
				let r = pair.both(obj! { "op" => "sealTransition", "name" => "p", "next" => next, "reason" => reason, "mark" => own::marker_write(SPACE, &value), "validatedAt" => now });
				if let Some(i) = r.get("result").filter(|_| r.get("ok") == Some(&Json::Bool(true))) { if rng.chance(0.8) { pair.both(obj! { "op" => "markApplied", "name" => "p", "intent" => i.clone() }); } }
			}
			65..=74 => {
				let id = ids[rng.below(3)];
				let phase = ["started", "locallyCommitted", "completed", "completed", "completed"][rng.below(5)];
				let q = match rng.below(4) {
					0 => {
						// a transition mostly ends soon: completed, or abandoned while it sealed nothing
						pair.both(obj! { "op" => "begin", "name" => "p", "id" => id, "record" => obj! { "kind" => "promote", "phase" => "started" } });
						if rng.chance(0.5) { obj! { "op" => "save", "name" => "p", "id" => id, "record" => obj! { "kind" => "promote", "phase" => "completed" } } } else { obj! { "op" => "abandon", "name" => "p", "id" => id } }
					}
					1 => obj! { "op" => "abandon", "name" => "p", "id" => id },
					2 => obj! { "op" => "save", "name" => "p", "id" => if rng.chance(0.05) { "-bad" } else { id }, "record" => obj! { "kind" => "promote", "phase" => phase } },
					_ => obj! { "op" => "transition", "name" => "p", "id" => id },
				};
				pair.both(q);
			}
			75..=82 => {
				// a mark that does not follow, or a candidate left open and applied later
				let name = if rng.chance(0.7) { "p" } else { "s" };
				let jh = num(&pair.rust.get(name).unwrap().head().unwrap(), "revision");
				if jh < 1.0 { continue; }
				let Some(mut i) = pair.rust.get(name).unwrap().intent(1.0 + rng.below(jh as usize) as f64).unwrap() else { continue };
				if rng.chance(0.1) { i.as_object_mut().unwrap().insert("hash", Json::String("00".repeat(32))); }
				pair.both(obj! { "op" => "markApplied", "name" => name, "intent" => i, "recovered" => rng.chance(0.3) });
			}
			83..=88 => {
				// reopen: the chain is checked entry by entry; sometimes with another genesis, which is refused
				let name = if rng.chance(0.5) { "p" } else { "s" };
				let mut q = if name == "p" { open_p.clone() } else { open_s.clone() };
				pair.both(obj! { "op" => "close", "name" => name });
				if rng.chance(0.1) {
					let mut other = q.clone();
					other.as_object_mut().unwrap().insert("genesis", genesis(if start == "sync" { "single" } else { "sync" }));
					pair.both(other);
				}
				pair.both(q.clone());
				q.as_object_mut().unwrap().remove("path");
			}
			89..=94 => { let name = if rng.chance(0.5) { "p" } else { "s" }; pair.both(obj! { "op" => "state", "name" => name }); }
			_ => {
				let name = if rng.chance(0.5) { "p" } else { "s" };
				let rev = [0.0, 1.0, 2.0, 1.5, num(&head, "revision"), num(&head, "revision") + 1.0][rng.below(6)];
				pair.both(obj! { "op" => "intent", "name" => name, "revision" => rev });
			}
		}
	}
	pair.both(obj! { "op" => "state", "name" => "p" });
	pair.both(obj! { "op" => "state", "name" => "s" });
	pair.rows("p");
	pair.rows("s");
	let seen = pair.seen.clone();
	drop(pair);
	let _ = std::fs::remove_dir_all(dir_r);
	let _ = std::fs::remove_dir_all(dir_t);
	seen
}

#[test]
fn the_journal_answers_as_typescript_does() {
	let total: usize = std::env::var("PHI_SYNC_WALK_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(3000);
	let seeds: Vec<u64> = match std::env::var("PHI_SYNC_WALK_SEED").ok().and_then(|s| s.parse().ok()) { Some(s) => vec![s], None => (1..=8).collect() };
	let mut seen: BTreeMap<String, usize> = BTreeMap::new();
	for s in &seeds { for (k, v) in walk(*s, total / seeds.len()) { *seen.entry(k).or_default() += v; } }
	eprintln!("journal walk: {seen:?}");
	for op in ["seal", "accept", "catchUp", "sealTransition", "markApplied", "begin", "open"] { assert!(seen.get(&format!("{op} ok")).copied().unwrap_or(0) > 0, "the walk reached a {op} that succeeds"); }
}

/// The journals of test/vectors (written by TypeScript) open in Rust and say what journal.expected.json says.
#[test]
fn the_vector_journals_open() {
	let dir = temp("vec");
	let expected = parse(&std::fs::read_to_string("../../test/vectors/journal.expected.json").unwrap()).unwrap();
	let g = obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "replica-a", "standbyReplica" => Json::Null, "durability" => "single" };
	for (file, side, me) in [("primary.journal", "primary", "replica-a"), ("standby.journal", "standby", "replica-b")] {
		let path: &Path = &dir.join(format!("{file}.sqlite"));
		rusqlite::Connection::open(path).unwrap().execute_batch(&std::fs::read_to_string(format!("../../test/vectors/{file}.sql")).unwrap()).unwrap();
		let j = SyncJournal::open(path, &g, JournalOptions { self_id: Some(me.into()), ..Default::default() }).unwrap();
		let want = expected.get(side).unwrap();
		assert_eq!(canonical(&j.head().unwrap()), canonical(want.get("head").unwrap()), "{side} head");
		assert_eq!(canonical(&j.config()), canonical(want.get("config").unwrap()), "{side} config");
		let versions: Vec<f64> = (1..=j.head_revision().unwrap()).map(|r| num(&j.intent(r as f64).unwrap().unwrap(), "version")).collect();
		assert_eq!(Json::Array(versions.into_iter().map(Json::Number).collect()), *want.get("versions").unwrap(), "{side} versions");
		if side == "primary" { assert_eq!(j.applied_revision().unwrap() as f64, num(want, "applied")); }
		// every stored marker binds its entry
		for r in 1..=j.head_revision().unwrap() {
			let i = j.intent(r as f64).unwrap().unwrap();
			let (value, _) = own::marker_of(i.get("deltas").unwrap().as_array().unwrap().last().unwrap(), SPACE).unwrap();
			assert_eq!(canonical(&value), canonical(&marker_of(&i)));
		}
	}
	let _ = std::fs::remove_dir_all(dir);
}
