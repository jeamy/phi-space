// R6b step 5: entry replication (phi_service::entry) against src/entry-replication*.ts. Three replicas of one
// configuration, each on its own store file, take seeded random calls: local changes of two lww types and a set type,
// retries, erasures, imports of each other's changes (now and then changed on purpose), the pull stream with its peer
// vectors, the snapshot transfer, maintenance and compaction, and restarts. test/support/entry-driver.ts runs every call
// on its directory, the Rust controller on a copy of the same files; every answer agrees, and in the end every row of
// every file. Then each side opens the other's files and the walk goes on, so each reads what the other wrote.
//
//   PHI_ENTRY_WALK_STEPS (default 1500), PHI_ENTRY_WALK_SEED (default 1; that walk must reach the states listed at the
//   end), PHI_ENTRY_TRACE=1 prints the calls.
use phi_core::driver::seeded;
use phi_json::{obj, parse, Json, Object};
use phi_service::entry::{EntryError, EntryOptions, EntryReplication, ER};
use phi_store::{SpaceHost, SqliteLedger, Store, Synchronous};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::rc::Rc;

const NAMES: [&str; 3] = ["a", "b", "c"];
const LIMITS: (f64, f64) = (49152.0, 32768.0);
const RETENTION: f64 = 20_000.0;
/// The grace after an entry's deadline before compaction judges it expired (`ENTRY_EXPIRY_GRACE_MS`).
const ENTRY_GRACE: f64 = 60_000.0;

struct Ts {
	child: Child,
	input: ChildStdin,
	output: BufReader<ChildStdout>,
}
impl Ts {
	fn start() -> Ts {
		let root = format!("{}/../..", env!("CARGO_MANIFEST_DIR"));
		let mut child = Command::new("node").args(["--experimental-strip-types", "--no-warnings", "test/support/entry-driver.ts"]).current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("node must be on PATH");
		let input = child.stdin.take().unwrap();
		let output = BufReader::new(child.stdout.take().unwrap());
		Ts { child, input, output }
	}
	fn step(&mut self, line: &Json) -> Json {
		writeln!(self.input, "{}", line.to_json_text()).unwrap();
		self.input.flush().unwrap();
		let mut text = String::new();
		self.output.read_line(&mut text).unwrap();
		parse(text.trim_end()).unwrap_or_else(|e| panic!("the driver answered {text:?}: {e}"))
	}
}
impl Drop for Ts {
	fn drop(&mut self) { let _ = self.child.kill(); }
}

struct Replica {
	store: Option<Store>,
	controller: EntryReplication,
}
struct Rust {
	dir: PathBuf,
	clock: Rc<Cell<f64>>,
	active: Rc<Cell<bool>>,
	uncertainty: Rc<Cell<f64>>,
	replicas: BTreeMap<String, Replica>,
}
fn config(name: &str) -> Json {
	let members: Vec<Json> = NAMES.iter().map(|r| obj! { "replicaId" => *r, "incarnation" => format!("i-{r}") }).collect();
	let rules = vec![obj! { "type" => "Sensor", "variant" => "lww", "keyFields" => vec![Json::from("sensorId")] }, obj! { "type" => "Pair", "variant" => "lww", "keyFields" => vec![Json::from("a"), Json::from("b")] }, obj! { "type" => "Tag", "variant" => "set" }];
	obj! { "spaceId" => "board", "authorityId" => "authority", "replicaId" => name, "incarnation" => format!("i-{name}"), "members" => members, "rules" => rules }
}
impl Rust {
	fn open(&self, name: &str) -> Replica {
		let ledger = SpaceHost::sqlite(SqliteLedger::open(&self.dir.join(format!("{name}.sqlite")), Synchronous::Full).unwrap());
		let store = Store::open(ledger, || seeded("rust-store")).unwrap();
		let active = Rc::clone(&self.active);
		let (clock, unc) = (Rc::clone(&self.clock), Rc::clone(&self.uncertainty));
		let controller = EntryReplication::new(EntryOptions {
			config: config(name),
			space: None,
			check: Rc::new(move |_| if active.get() { Ok(()) } else { Err(EntryError::Other { class: "BootBlocked".into(), message: "entry replica Space is not admitted".into() }) }),
			now: Rc::new(move || clock.get()),
			clock_uncertainty_ms: Rc::new(move || unc.get()),
			random: seeded(""),
			max_history_bytes: Some(LIMITS.0),
			max_batch_bytes: Some(LIMITS.1),
			request_retention_ms: Some(RETENTION),
		})
		.unwrap();
		Replica { store: Some(store), controller }
	}
	fn close(&mut self) {
		for (_, r) in std::mem::take(&mut self.replicas) {
			r.store.unwrap().close();
		}
	}
}

fn arg(a: &[Json], i: usize) -> Option<&Json> { a.get(i) }
fn call(c: &EntryReplication, st: &mut Store, method: &str, a: &[Json]) -> ER<Json> {
	let none = Json::Null;
	let at = |i: usize| a.get(i).unwrap_or(&none);
	match method {
		"mutate" => c.mutate(st, at(0), at(1)),
		"importChanges" => c.import_changes(st, at(0)),
		"changeForRequest" => c.change_for_request(st, at(0).as_str().unwrap_or("")),
		"read" => c.read(st).map(Json::Array),
		"changes" => c.changes(st, arg(a, 0), arg(a, 1)),
		"snapshot" => c.snapshot(st),
		"installSnapshot" => c.install_snapshot(st, at(0)),
		"startSnapshot" => c.start_snapshot(st, arg(a, 0)),
		"snapshotPage" => c.snapshot_page(arg(a, 0), arg(a, 1)),
		"beginSnapshotImport" => c.begin_snapshot_import(st, at(0)),
		"snapshotImportStatus" => c.snapshot_import_status(st, arg(a, 0)),
		"importSnapshotPage" => c.import_snapshot_page(st, arg(a, 0), at(1)),
		"finishSnapshotImport" => c.finish_snapshot_import(st, arg(a, 0)),
		"abortSnapshotImport" => c.abort_snapshot_import(st, arg(a, 0)),
		"changeIdsOwnedBy" => c.change_ids_owned_by(st, at(0)),
		"erasePrincipal" => c.erase_principal(st, at(0), at(1), at(2)),
		"erasureStatus" => c.erasure_status(st),
		"completeErasure" => c.complete_erasure(st, at(0)),
		"startSnapshotMaintenance" => c.start_snapshot_maintenance(st, at(0), arg(a, 1)),
		"startCompaction" => c.start_compaction(st, at(0), arg(a, 1)),
		"snapshotMaintenanceStatus" => c.snapshot_maintenance_status(st),
		"advanceSnapshotMaintenance" => c.advance_snapshot_maintenance(st, at(0)),
		"abortSnapshotMaintenance" => c.abort_snapshot_maintenance(st, at(0)),
		"forgetSnapshotReceipt" => c.forget_snapshot_receipt(st, arg(a, 0)),
		"recordPeerVector" => c.record_peer_vector(st, at(0)),
		"compactionStatus" => c.compaction_status(st),
		"compact" => c.compact(st, at(0)),
		"describeStream" => c.describe_stream(st),
		"streamChanges" => c.stream_changes(st, arg(a, 0), arg(a, 1)),
		"startStreamImport" => c.start_stream_import(st, at(0), arg(a, 1)),
		"streamImportStatus" => c.stream_import_status(st, at(0)),
		"importStreamPage" => c.import_stream_page(st, at(0)),
		_ => panic!("no method {method}"),
	}
}
fn answer(r: ER<Json>) -> Json {
	match r {
		Ok(v) => obj! { "ok" => true, "result" => v },
		Err(e) => {
			let mut o = obj! { "ok" => false, "error" => e.class(), "message" => e.message() };
			if let EntryError::Cursor(c) = e {
				o.as_object_mut().unwrap().insert("cursor", Json::Number(c));
			}
			o
		}
	}
}

struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		self.0
	}
	fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
	fn chance(&mut self, p: f64) -> bool { ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p }
	fn pick<T: Clone>(&mut self, xs: &[T]) -> T { xs[self.below(xs.len())].clone() }
}

/// What the walk learned from the answers (the same on both sides).
#[derive(Default)]
struct Known {
	/// Changes each replica made or holds, for imports elsewhere.
	events: Vec<Json>,
	/// The visible entries of each replica, as it last read them.
	visible: BTreeMap<String, Vec<Json>>,
	/// Mutations by replica and request ID, to retry them.
	requests: BTreeMap<(String, String), (f64, Json)>,
	/// Stream identities by replica.
	sources: BTreeMap<String, Json>,
	/// Pages a stream answered, by source replica.
	pages: Vec<(String, Json)>,
	/// Exported snapshots: source, manifest, the pages fetched so far.
	exports: Vec<(String, Json)>,
	/// Snapshot pages fetched, by snapshot ID.
	snapshot_pages: BTreeMap<String, Vec<Json>>,
	/// Snapshot IDs some replica began to import, with that replica.
	imports: Vec<(String, String)>,
	/// Maintenance request IDs by replica.
	maintenance: BTreeMap<String, String>,
	/// v1 snapshots.
	snapshots: Vec<Json>,
}

struct Walk {
	rng: Rng,
	now: f64,
	n: usize,
	known: Known,
	seen: BTreeMap<String, usize>,
	trace: bool,
	/// The last phase: a lowered peer vector (the peer is regressed for good, which blocks compaction) and changes forged
	/// with another sequence or request ID.
	hostile: bool,
	ts: Ts,
	rust: Rust,
}
impl Walk {
	fn owner(&mut self) -> Json {
		let p = self.rng.pick(&["p1", "p2", "p3"]);
		if self.rng.chance(0.15) { obj! { "peerId" => p, "agentId" => "agent" } } else { obj! { "peerId" => p } }
	}
	fn expires(&mut self) -> Json {
		match self.rng.below(10) {
			0 => Json::Number(self.now + 1.0 + self.rng.below(90_000) as f64),
			1 => Json::Number((self.now - 500.0).max(0.0)),
			_ => Json::Null,
		}
	}
	fn fields(&mut self, type_: &str) -> Json {
		let mut f = match type_ {
			"Sensor" => obj! { "sensorId" => self.rng.pick(&["s1", "s2", "s3", "s4"]), "v" => self.rng.below(100) as f64 },
			"Pair" => obj! { "a" => self.rng.below(2) as f64, "b" => self.rng.pick(&["x", "y"]), "n" => self.rng.below(9) as f64 },
			_ => obj! { "tag" => self.rng.pick(&["t1", "t2", "t3", "t4", "t5"]) },
		};
		if self.rng.chance(0.03) {
			f.as_object_mut().unwrap().insert("big", Json::String("x".repeat(if self.rng.chance(0.5) { 9000 } else { 70_000 })));
		}
		if self.rng.chance(0.02) {
			f.as_object_mut().unwrap().remove(if type_ == "Sensor" { "sensorId" } else { "a" });
		}
		f
	}
	fn visible(&self, r: &str, type_: &str) -> Vec<Json> { self.known.visible.get(r).map_or(vec![], |v| v.iter().filter(|e| e.get("type").and_then(Json::as_str) == Some(type_)).cloned().collect()) }
	fn mutation(&mut self, r: &str) -> Json {
		let type_ = self.rng.pick(&["Sensor", "Pair", "Tag", "Tag"]);
		let owner = self.owner();
		match (type_, self.rng.below(10)) {
			(_, 0) if self.rng.chance(0.3) => obj! { "kind" => "erase", "principal" => self.owner(), "owner" => obj! { "peerId" => "admin" } },
			("Tag", 1..=3) => {
				let seen = self.visible(r, "Tag");
				let mut tags: Vec<Json> = seen.iter().filter(|_| self.rng.chance(0.5)).map(|e| e.get("id").cloned().unwrap()).collect();
				if tags.is_empty() || self.rng.chance(0.1) {
					tags.push(self.known.events.get(self.rng.below(self.known.events.len().max(1))).map_or(Json::from("[\"a\",\"i-a\",1]"), |e| Json::String(id_of(e))));
				}
				if self.rng.chance(0.03) {
					tags.push(Json::from("[\"z\",\"i-z\",1]"));
				}
				obj! { "kind" => "remove", "type" => "Tag", "tags" => tags, "owner" => owner }
			}
			("Tag", 4..=5) => match self.visible(r, "Tag").first().cloned() {
				Some(v) if self.rng.chance(0.9) => obj! { "kind" => "renew", "type" => "Tag", "tag" => v.get("id").cloned().unwrap(), "fields" => v.get("fields").cloned().unwrap(), "owner" => v.get("owner").cloned().unwrap(), "expiresAt" => self.expires() },
				_ => obj! { "kind" => "renew", "type" => "Tag", "tag" => "[\"a\",\"i-a\",1]", "fields" => self.fields("Tag"), "owner" => owner, "expiresAt" => Json::Null },
			},
			("Tag", 6) if self.rng.chance(0.2) => obj! { "kind" => "put", "type" => "Tag", "fields" => self.fields("Tag"), "owner" => owner, "expiresAt" => Json::Null },
			("Tag", _) => obj! { "kind" => "add", "type" => "Tag", "fields" => self.fields("Tag"), "owner" => owner, "expiresAt" => self.expires() },
			(t, 1..=2) => obj! { "kind" => "delete", "type" => t, "fields" => self.fields(t), "owner" => owner },
			(t, _) => obj! { "kind" => "put", "type" => t, "fields" => self.fields(t), "owner" => owner, "expiresAt" => self.expires() },
		}
	}
	/// One call on both sides; the answers must agree.
	fn call(&mut self, r: &str, method: &str, args: Vec<Json>) -> Json {
		self.n += 1;
		let seed = format!("s{}", self.n);
		let active = !self.rng.chance(0.01);
		let uncertainty = if self.rng.chance(0.01) { 6000.0 } else { 0.0 };
		let line = obj! { "op" => "call", "replica" => r, "method" => method, "args" => args.clone(), "now" => self.now, "seed" => seed.as_str(), "active" => active, "uncertainty" => uncertainty };
		if self.trace {
			eprintln!("{}", line.to_json_text());
		}
		let want = self.ts.step(&line);
		if self.trace {
			eprintln!("  -> {}", want.to_json_text().chars().take(400).collect::<String>());
		}
		self.rust.clock.set(self.now);
		self.rust.active.set(active);
		self.rust.uncertainty.set(uncertainty);
		let rep = self.rust.replicas.get_mut(r).unwrap();
		rep.controller.set_random(seeded(&seed));
		let got = answer(call(&rep.controller, rep.store.as_mut().unwrap(), method, &args));
		assert_eq!(got.canonical().unwrap(), want.canonical().unwrap(), "step {} {}\n  Rust:       {}\n  TypeScript: {}", self.n, line.to_json_text(), got.to_json_text(), want.to_json_text());
		let outcome = if want.get("ok") == Some(&Json::Bool(true)) { "ok".to_owned() } else { format!("{}: {}", want.get("error").and_then(Json::as_str).unwrap_or(""), want.get("message").and_then(Json::as_str).unwrap_or("").chars().take(60).collect::<String>()) };
		*self.seen.entry(format!("{method} {outcome}")).or_default() += 1;
		// what the answers show of the states reached
		if let Some(v) = Self::ok(&want) {
			let mut note = |k: &str| *self.seen.entry(k.to_owned()).or_default() += 1;
			if v.get("positions").is_some() {
				note(&format!("{method} positions"));
			}
			if v.get("events").and_then(Json::as_array).is_some_and(|e| e.iter().any(|e| e.get("mutation").and_then(|m| m.get("kind")).and_then(Json::as_str) == Some("redacted"))) {
				note(&format!("{method} redacted"));
			}
			if method == "startStreamImport" && args.len() > 1 && v.get("cursor").and_then(Json::as_f64).is_some_and(|c| c > 0.0) {
				note("startStreamImport seeded");
			}
			if method == "importStreamPage" && v.get("added").and_then(Json::as_f64).is_some_and(|a| a > 0.0) {
				note("importStreamPage added");
			}
		}
		want
	}
	fn ok(a: &Json) -> Option<&Json> { if a.get("ok") == Some(&Json::Bool(true)) { a.get("result") } else { None } }
	fn other(&mut self, r: &str) -> String { loop { let o = self.rng.pick(&NAMES); if o != r { return o.to_owned(); } } }

	fn step(&mut self) {
		self.now += match self.rng.below(20) {
			0 => 70_000.0,
			1 => 0.0,
			2 if self.rng.chance(0.1) => -6000.0,
			_ => self.rng.below(1500) as f64,
		};
		self.now = self.now.max(1.0);
		let r = self.rng.pick(&NAMES).to_owned();
		match self.rng.below(33) {
			0..=6 => {
				// a retry only within the retention of own changes: once its change is compacted away, a request ID used
				// anew is a new change, and the replicas that still hold the old one refuse it for good (as in TypeScript)
				let (rid, m) = match self.known.requests.iter().filter(|((x, _), (at, _))| *x == r && self.now - at < RETENTION).map(|((_, k), v)| (k.clone(), v.clone())).collect::<Vec<_>>() {
					old if !old.is_empty() && self.rng.chance(0.1) => {
						let (k, (at, v)) = self.rng.pick(&old);
						(k, if self.now - at > 3000.0 || self.rng.chance(0.5) { v } else { self.mutation(&r) })
					}
					_ => (format!("r{}", self.n), self.mutation(&r)),
				};
				let a = self.call(&r, "mutate", vec![Json::from(rid.as_str()), m.clone()]);
				let at = self.known.requests.get(&(r.clone(), rid.clone())).map_or(self.now, |(at, _)| *at);
				self.known.requests.insert((r.clone(), rid), (at, m));
				if let Some(e) = Self::ok(&a) {
					self.known.events.push(e.clone());
				}
			}
			7 => {
				let a = self.call(&r, "read", vec![]);
				if let Some(v) = Self::ok(&a).and_then(Json::as_array) {
					self.known.visible.insert(r.clone(), v.clone());
				}
			}
			8..=9 => {
				// changes of others, as a peer would send them, now and then changed on purpose
				let mut batch: Vec<Json> = (0..1 + self.rng.below(4)).filter_map(|_| self.known.events.get(self.rng.below(self.known.events.len().max(1))).cloned()).collect();
				if let Some(e) = batch.first_mut().filter(|_| self.rng.chance(0.15)) {
					let o = e.as_object_mut().unwrap();
					// a changed sequence or request ID passes where the original is not held yet, and poisons that replica for
					// good (the original then arrives as a reused ID): only in the last phase
					match self.rng.below(if self.hostile { 5 } else { 3 }) {
						0 => o.insert("argumentHash", Json::from("0".repeat(64))),
						1 => o.insert("originReplicaId", Json::from("z")),
						2 => o.insert("clock", obj! { "physical" => self.now + 120_000.0, "logical" => 0.0 }),
						3 => o.insert("requestId", Json::from("other")),
						_ => o.insert("seq", Json::Number(o.get("seq").and_then(Json::as_f64).unwrap_or(1.0) + 1.0)),
					}
				}
				self.call(&r, "importChanges", vec![Json::Array(batch)]);
				// a change its origin holds, its content altered and hashed anew: the same ID for another change
				let held = self.known.events.get(self.rng.below(self.known.events.len().max(1))).cloned().filter(|e| e.get("mutation").and_then(|m| m.get("fields")).is_some());
				if let Some(mut e) = held.filter(|_| self.rng.chance(0.3)) {
					let origin = e.get("originReplicaId").and_then(Json::as_str).unwrap().to_owned();
					let o = e.as_object_mut().unwrap();
					let mut m = o.get("mutation").cloned().unwrap();
					m.as_object_mut().unwrap().get_mut("fields").unwrap().as_object_mut().unwrap().insert("altered", Json::Bool(true));
					o.insert("argumentHash", Json::String(phi_json::digest_json(&m).unwrap()));
					o.insert("mutation", m);
					self.call(&origin, "importChanges", vec![Json::Array(vec![e])]);
				}
			}
			10..=14 => self.pump(&r),
			15 => {
				let a = self.call(&r, "snapshot", vec![]);
				if let Some(s) = Self::ok(&a) {
					self.known.snapshots.push(s.clone());
				}
				if let Some(s) = self.known.snapshots.last().cloned() {
					let o = self.other(&r);
					self.call(&o, "installSnapshot", vec![s]);
				}
			}
			16 => self.transfer(&r),
			17..=18 => self.transfer_burst(&r),
			19 => self.maintain(&r),
			20 => self.maintain_burst(&r),
			21 => {
				let rid = Json::from(format!("c{}", self.n).as_str());
				self.call(&r, "compactionStatus", vec![]);
				let a = self.call(&r, "compact", vec![rid]);
				if Self::ok(&a).and_then(|x| x.get("dropped")).and_then(Json::as_f64).is_some_and(|d| d > 0.0) {
					*self.seen.entry("compact dropped".into()).or_default() += 1;
				}
			}
			22 => {
				let p = self.owner();
				let m = self.rng.below(4);
				match m {
					0 => {
						self.call(&r, "erasePrincipal", vec![Json::from(format!("e{}", self.n).as_str()), p, obj! { "peerId" => "admin" }]);
					}
					1 => {
						self.call(&r, "erasureStatus", vec![]);
					}
					2 => {
						self.call(&r, "completeErasure", vec![Json::from(format!("x{}", self.n).as_str())]);
					}
					_ => {
						self.call(&r, "changeIdsOwnedBy", vec![p]);
					}
				}
			}
			23 => {
				let after = Json::Number(self.rng.below(6) as f64);
				let budget = self.rng.pick(&[Json::Null, Json::Number(256.0), Json::Number(2048.0), Json::Number(300_000.0)]);
				let args = if budget.is_null() { vec![after] } else { vec![after, budget] };
				self.call(&r, "changes", args);
			}
			24 => {
				let rid = self.known.requests.keys().filter(|(x, _)| *x == r).map(|(_, k)| k.clone()).next_back().unwrap_or_else(|| "none".into());
				self.call(&r, "changeForRequest", vec![Json::from(rid.as_str())]);
			}
			26 => {
				// the same lww key on two replicas at the same moment, neither having seen the other: equal clocks, the
				// replica ID decides; both changes reach a third replica, which reads the winner
				let (x, y) = (r.clone(), self.other(&r));
				let z = NAMES.iter().find(|n| **n != x && **n != y).unwrap().to_string();
				let key = self.rng.pick(&["s1", "s2", "s3", "s4"]);
				let mut made = vec![];
				for (who, v) in [(&x, 1.0), (&y, 2.0)] {
					let m = obj! { "kind" => "put", "type" => "Sensor", "fields" => obj! { "sensorId" => key, "v" => v }, "owner" => obj! { "peerId" => "p1" }, "expiresAt" => Json::Null };
					let rid = Json::from(format!("r{}", self.n).as_str());
					let a = self.call(who, "mutate", vec![rid.clone(), m]);
					// the same request at once with other arguments: a conflict, not a second change
					if Self::ok(&a).is_some() && who == &x {
						let other = obj! { "kind" => "put", "type" => "Sensor", "fields" => obj! { "sensorId" => key, "v" => 9.0 }, "owner" => obj! { "peerId" => "p1" }, "expiresAt" => Json::Null };
						self.call(who, "mutate", vec![rid, other]);
					}
					made.extend(Self::ok(&a).cloned());
				}
				self.call(&z, "importChanges", vec![Json::Array(made.clone())]);
				self.call(&x, "importChanges", vec![Json::Array(made)]);
				for who in [&z, &x] {
					let a = self.call(who, "read", vec![]);
					if let Some(v) = Self::ok(&a).and_then(Json::as_array) {
						self.known.visible.insert(who.to_string(), v.clone());
					}
				}
			}
			27 => {
				// a tag added on one replica, its owner erased there, and the tag renewed on another that has not seen the
				// erase yet: the renewal is later than the erase, and only the fixpoint redacts it with its tag
				let (x, y) = (r.clone(), self.other(&r));
				let owner = obj! { "peerId" => "p9" };
				let fields = obj! { "tag" => "t9" };
				let add = obj! { "kind" => "add", "type" => "Tag", "fields" => fields.clone(), "owner" => owner.clone(), "expiresAt" => Json::Null };
				let a = self.call(&x, "mutate", vec![Json::from(format!("r{}", self.n).as_str()), add]);
				let Some(added) = Self::ok(&a).cloned() else { return };
				self.call(&y, "importChanges", vec![Json::Array(vec![added.clone()])]);
				self.call(&x, "erasePrincipal", vec![Json::from(format!("e{}", self.n).as_str()), owner.clone(), obj! { "peerId" => "admin" }]);
				let renew = obj! { "kind" => "renew", "type" => "Tag", "tag" => id_of(&added), "fields" => fields, "owner" => owner, "expiresAt" => Json::Null };
				let a = self.call(&y, "mutate", vec![Json::from(format!("r{}", self.n).as_str()), renew]);
				if let Some(renewed) = Self::ok(&a).cloned() {
					self.known.events.push(renewed.clone());
					self.call(&x, "importChanges", vec![Json::Array(vec![renewed])]);
					let a = self.call(&x, "changes", vec![Json::Number(0.0), Json::Number(256.0 * 1024.0)]);
					if Self::ok(&a).and_then(|c| c.get("events")).and_then(Json::as_array).is_some_and(|e| e.iter().any(|e| e.get("mutation").and_then(|m| m.get("was")).and_then(Json::as_str) == Some("renew"))) {
						*self.seen.entry("renewal redacted with its tag".into()).or_default() += 1;
					}
					self.call(&x, "erasureStatus", vec![]);
				}
			}
			28 if self.rng.chance(0.3) => self.settle(),
			25 if self.rng.chance(0.3) => {
				self.rust.replicas.get_mut(&r).unwrap().store.take().unwrap().close();
				let fresh = self.rust.open(&r);
				self.rust.replicas.insert(r.clone(), fresh);
				assert_eq!(self.ts.step(&obj! { "op" => "reopen", "replica" => r.as_str() }), obj! { "ok" => true, "result" => Json::Null });
			}
			_ => {
				let o = self.other(&r);
				self.pump(&o);
			}
		}
	}
	/// One round of the pull stream from another replica into `r`.
	fn pump(&mut self, r: &str) {
		let src = self.other(r);
		self.pump_from(r, &src, false);
	}
	/// Every stream drained into every replica, the clock past the retention of own changes, every vector recorded
	/// anew, and a compaction on each replica: what a quiet federation reaches.
	fn settle(&mut self) {
		for dst in NAMES {
			for src in NAMES.iter().filter(|s| **s != dst) {
				for _ in 0..8 {
					if !self.pump_from(dst, src, true) {
						break;
					}
				}
			}
		}
		self.now += RETENTION + ENTRY_GRACE;
		for dst in NAMES {
			for src in NAMES.iter().filter(|s| **s != dst) {
				self.pump_from(dst, src, true);
			}
		}
		for r in NAMES {
			let a = self.call(r, "compact", vec![Json::from(format!("c{}", self.n).as_str())]);
			if Self::ok(&a).and_then(|x| x.get("dropped")).and_then(Json::as_f64).is_some_and(|d| d > 0.0) {
				*self.seen.entry("compact dropped".into()).or_default() += 1;
			}
		}
	}
	/// A peer that advertises less than it did before is regressed for good: compaction stays blocked.
	fn regress(&mut self, r: &str, src: &str) {
		let d = self.call(src, "describeStream", vec![]);
		let Some(mut d) = Self::ok(&d).cloned() else { return };
		self.call(r, "recordPeerVector", vec![d.clone()]);
		let v = d.as_object_mut().unwrap().get_mut("vector").unwrap().as_object_mut().unwrap();
		let keys: Vec<String> = v.keys().map(str::to_owned).collect();
		for k in keys {
			v.insert(k, Json::Number(0.0));
		}
		self.call(r, "recordPeerVector", vec![d]);
		self.call(r, "startCompaction", vec![Json::from(format!("m{}", self.n).as_str())]);
	}
	/// One round of `src`'s stream into `r`; whether more is waiting.
	fn pump_from(&mut self, r: &str, src: &str, record: bool) -> bool {
		let src = src.to_owned();
		let d = self.call(&src, "describeStream", vec![]);
		let Some(d) = Self::ok(&d).cloned() else { return false };
		let source = d.get("source").cloned().unwrap();
		self.known.sources.insert(src.clone(), source.clone());
		if record || self.rng.chance(0.6) {
			let mut d = d.clone();
			if self.hostile && self.rng.chance(0.05) {
				let v = d.as_object_mut().unwrap().get_mut("vector").unwrap().as_object_mut().unwrap();
				let k = v.keys().next().unwrap().to_owned();
				v.insert(k, Json::Number(0.0));
			}
			self.call(r, "recordPeerVector", vec![d]);
		}
		let seed = self.known.imports.iter().filter(|(x, _)| x == r).map(|(_, s)| s.clone()).next_back().filter(|_| self.rng.chance(0.2));
		let args = match seed {
			Some(s) => vec![source.clone(), Json::from(s.as_str())],
			None => vec![source.clone()],
		};
		let cp = self.call(r, "startStreamImport", args);
		let cursor = Self::ok(&cp).and_then(|c| c.get("cursor")).and_then(Json::as_f64).unwrap_or(0.0);
		let at = if self.rng.chance(0.1) { (cursor - 1.0).max(0.0) } else { cursor };
		let budget = self.rng.pick(&[Json::Null, Json::Number(1024.0), Json::Number(2048.0), Json::Number(8192.0)]);
		let args = if budget.is_null() { vec![Json::Number(at)] } else { vec![Json::Number(at), budget] };
		let page = self.call(&src, "streamChanges", args);
		let Some(page) = Self::ok(&page).cloned() else { return false };
		for e in page.get("events").and_then(Json::as_array).into_iter().flatten() {
			self.known.events.push(e.clone());
		}
		self.known.pages.push((src.clone(), page.clone()));
		let page = match self.rng.below(20) {
			0 => self.known.pages.iter().filter(|(s, _)| *s == src).map(|(_, p)| p.clone()).next().unwrap_or(page),
			1 => {
				let mut p = page;
				p.as_object_mut().unwrap().insert("next", Json::Number(9999.0));
				p
			}
			_ => page,
		};
		let more = page.get("more") == Some(&Json::Bool(true));
		let a = self.call(r, "importStreamPage", vec![page]);
		if self.rng.chance(0.2) {
			self.call(r, "streamImportStatus", vec![source]);
		}
		more && Self::ok(&a).is_some()
	}
	/// A step of a snapshot transfer from another replica into `r`.
	fn transfer(&mut self, r: &str) {
		let src = self.other(r);
		match self.rng.below(6) {
			0 => {
				let budget = self.rng.pick(&[Json::Null, Json::Number(1024.0), Json::Number(4096.0)]);
				let a = self.call(&src, "startSnapshot", if budget.is_null() { vec![] } else { vec![budget] });
				if let Some(m) = Self::ok(&a) {
					self.known.exports.push((src.clone(), m.clone()));
				}
			}
			1 => {
				if let Some((s, m)) = self.known.exports.iter().rev().find(|(s, _)| *s != r).cloned() {
					let id = m.get("id").cloned().unwrap();
					let count = m.get("pageCount").and_then(Json::as_f64).unwrap_or(1.0) as usize;
					let have = self.known.snapshot_pages.get(id.as_str().unwrap()).map_or(0, Vec::len);
					let a = self.call(&s, "snapshotPage", vec![id.clone(), Json::Number((have.min(count.saturating_sub(1))) as f64)]);
					if let Some(p) = Self::ok(&a) {
						let list = self.known.snapshot_pages.entry(id.as_str().unwrap().to_owned()).or_default();
						if !list.iter().any(|x| x == p) {
							list.push(p.clone());
						}
					}
					let _ = s;
				}
			}
			2 => {
				if let Some((s, m)) = self.known.exports.iter().rev().find(|(s, _)| s != r).cloned() {
					let _ = s;
					let a = self.call(r, "beginSnapshotImport", vec![m.clone()]);
					if Self::ok(&a).is_some() {
						self.known.imports.push((r.to_owned(), m.get("id").and_then(Json::as_str).unwrap().to_owned()));
					}
				}
			}
			3 => {
				if let Some((_, id)) = self.known.imports.iter().rev().find(|(x, _)| x == r).cloned() {
					let pages = self.known.snapshot_pages.get(&id).cloned().unwrap_or_default();
					if let Some(p) = pages.get(self.rng.below(pages.len().max(1))).cloned() {
						self.call(r, "importSnapshotPage", vec![Json::from(id.as_str()), p]);
					} else {
						self.call(r, "snapshotImportStatus", vec![Json::from(id.as_str())]);
					}
				}
			}
			4 => {
				if let Some((_, id)) = self.known.imports.iter().rev().find(|(x, _)| x == r).cloned() {
					let m = if self.rng.chance(0.8) { "finishSnapshotImport" } else { "abortSnapshotImport" };
					self.call(r, m, vec![Json::from(id.as_str())]);
				}
			}
			_ => {
				if let Some((_, id)) = self.known.imports.iter().find(|(x, _)| x == r).cloned() {
					self.call(r, "forgetSnapshotReceipt", vec![Json::from(id.as_str())]);
				}
			}
		}
	}
	/// A whole snapshot transfer from another replica into `r` at one moment, now and then left unfinished.
	fn transfer_burst(&mut self, r: &str) {
		// an import left receiving blocks every other: most bursts clear what this replica left
		if self.rng.chance(0.7) {
			let open: Vec<String> = self.known.imports.iter().filter(|(x, _)| x == r).map(|(_, s)| s.clone()).collect();
			for id in open.iter().rev().take(3) {
				for _ in 0..40 {
					let a = self.call(r, "abortSnapshotImport", vec![Json::from(id.as_str())]);
					if Self::ok(&a).is_none_or(|t| t.get("phase").and_then(Json::as_str) == Some("aborted")) {
						break;
					}
				}
			}
		}
		let src = self.other(r);
		let budget = self.rng.pick(&[Json::Null, Json::Number(1024.0), Json::Number(4096.0)]);
		let a = self.call(&src, "startSnapshot", if budget.is_null() { vec![] } else { vec![budget] });
		let Some(m) = Self::ok(&a).cloned() else { return };
		self.known.exports.push((src.clone(), m.clone()));
		let id = m.get("id").cloned().unwrap();
		let a = self.call(r, "beginSnapshotImport", vec![m.clone()]);
		if Self::ok(&a).is_none() {
			return;
		}
		self.known.imports.push((r.to_owned(), id.as_str().unwrap().to_owned()));
		let count = m.get("pageCount").and_then(Json::as_f64).unwrap_or(1.0) as usize;
		let stop = if self.rng.chance(0.2) { self.rng.below(count + 1) } else { count };
		let mut fetched: Vec<Json> = vec![];
		for i in 0..stop {
			let p = self.call(&src, "snapshotPage", vec![id.clone(), Json::Number(i as f64)]);
			let Some(p) = Self::ok(&p).cloned() else { return };
			fetched.push(p.clone());
			self.known.snapshot_pages.entry(id.as_str().unwrap().to_owned()).or_default().push(p.clone());
			let page = match self.rng.below(25) {
				0 if i > 0 => fetched[self.rng.below(i)].clone(),
				2 if i > 0 => {
					let mut x = fetched[self.rng.below(i)].clone();
					x.as_object_mut().unwrap().insert("previousHash", Json::from("f".repeat(64)));
					x
				}
				1 => {
					let mut x = p.clone();
					x.as_object_mut().unwrap().insert("offset", Json::Number(99.0));
					x
				}
				_ => p,
			};
			let a = self.call(r, "importSnapshotPage", vec![id.clone(), page]);
			if Self::ok(&a).is_none() && self.rng.chance(0.5) {
				break;
			}
		}
		if self.rng.chance(0.3) {
			self.call(r, "snapshotImportStatus", vec![id.clone()]);
		}
		match self.rng.below(10) {
			0 => {
				for _ in 0..1 + stop {
					self.call(r, "abortSnapshotImport", vec![id.clone()]);
				}
			}
			1 => {}
			_ => {
				let a = self.call(r, "finishSnapshotImport", vec![id.clone()]);
				if Self::ok(&a).is_some() && self.rng.chance(0.5) {
					let source = self.known.sources.get(&src).cloned();
					if let Some(source) = source {
						self.call(r, "startStreamImport", vec![source, id]);
					}
				}
			}
		}
	}
	/// A maintenance or compaction generation run to its end (or aborted) at one moment.
	fn maintain_burst(&mut self, r: &str) {
		let rid = format!("m{}", self.n);
		let method = if self.rng.chance(0.6) { "startCompaction" } else { "startSnapshotMaintenance" };
		let a = self.call(r, method, vec![Json::from(rid.as_str())]);
		if Self::ok(&a).is_none() {
			return;
		}
		self.known.maintenance.insert(r.to_owned(), rid.clone());
		let abort_at = if self.rng.chance(0.15) { Some(self.rng.below(4)) } else { None };
		for i in 0..200 {
			if abort_at == Some(i) {
				for _ in 0..50 {
					let a = self.call(r, "abortSnapshotMaintenance", vec![Json::from(rid.as_str())]);
					if Self::ok(&a).is_none_or(Json::is_null) {
						break;
					}
				}
				return;
			}
			let a = self.call(r, "advanceSnapshotMaintenance", vec![Json::from(rid.as_str())]);
			match Self::ok(&a) {
				Some(j) if j.get("phase").and_then(Json::as_str) == Some("completed") => {
					*self.seen.entry(format!("{method} completed")).or_default() += 1;
					return;
				}
				Some(_) => {}
				None => return,
			}
		}
	}
	fn maintain(&mut self, r: &str) {
		let current = self.known.maintenance.get(r).cloned();
		match (self.rng.below(6), current) {
			(0, _) | (_, None) => {
				let rid = format!("m{}", self.n);
				let method = if self.rng.chance(0.5) { "startCompaction" } else { "startSnapshotMaintenance" };
				let budget = self.rng.pick(&[Json::Null, Json::Number(2048.0)]);
				let mut args = vec![Json::from(rid.as_str())];
				if !budget.is_null() {
					args.push(budget);
				}
				let a = self.call(r, method, args);
				if Self::ok(&a).is_some() {
					self.known.maintenance.insert(r.to_owned(), rid);
				}
			}
			(1, Some(rid)) => {
				self.call(r, "abortSnapshotMaintenance", vec![Json::from(rid.as_str())]);
			}
			(2, _) => {
				self.call(r, "snapshotMaintenanceStatus", vec![]);
			}
			(_, Some(rid)) => {
				self.call(r, "advanceSnapshotMaintenance", vec![Json::from(rid.as_str())]);
			}
		}
	}
	fn rows(dir: &Path) -> BTreeMap<String, String> {
		let mut out = BTreeMap::new();
		for name in NAMES {
			let l = SqliteLedger::open(&dir.join(format!("{name}.sqlite")), Synchronous::Full).unwrap();
			for (kind, key) in l.documents().unwrap() {
				let d = l.document(&kind, key.as_deref()).unwrap().unwrap();
				out.insert(format!("{name} {kind} {}", key.unwrap_or_default()), format!("v{} {}", d.version, d.value.canonical().unwrap()));
			}
			l.close();
		}
		out
	}
}
fn id_of(e: &Json) -> String { phi_service::entry::entry_change_id(e) }

fn dirs(seed: u64) -> (PathBuf, PathBuf) {
	let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("entry-walk-{seed}"));
	let _ = std::fs::remove_dir_all(&base);
	let (ts, rust) = (base.join("ts"), base.join("rust"));
	std::fs::create_dir_all(&ts).unwrap();
	std::fs::create_dir_all(&rust).unwrap();
	(ts, rust)
}
fn copy_dir(from: &Path, to: &Path) {
	for name in NAMES {
		for ext in ["sqlite", "sqlite-wal", "sqlite-shm"] {
			let f = from.join(format!("{name}.{ext}"));
			if f.exists() {
				std::fs::copy(&f, to.join(format!("{name}.{ext}"))).unwrap();
			}
		}
	}
}

#[test]
fn random_entry_replication_agrees_with_typescript() {
	let steps: usize = std::env::var("PHI_ENTRY_WALK_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(1500);
	let seed: u64 = std::env::var("PHI_ENTRY_WALK_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
	let (ts_dir, rust_dir) = dirs(seed);
	let mut ts = Ts::start();
	let open = |dir: &Path, setup: bool| obj! { "op" => "open", "dir" => dir.to_str().unwrap(), "now" => 1000.0, "replicas" => NAMES.iter().map(|n| Json::from(*n)).collect::<Vec<_>>(), "limits" => obj! { "maxHistoryBytes" => LIMITS.0, "maxBatchBytes" => LIMITS.1 }, "retention" => RETENTION, "setup" => setup };
	assert_eq!(ts.step(&open(&ts_dir, true)), obj! { "ok" => true, "result" => Json::Null });
	assert_eq!(ts.step(&obj! { "op" => "close" }), obj! { "ok" => true, "result" => Json::Null });
	copy_dir(&ts_dir, &rust_dir);
	assert_eq!(ts.step(&open(&ts_dir, false)), obj! { "ok" => true, "result" => Json::Null });
	let rust = Rust { dir: rust_dir.clone(), clock: Rc::new(Cell::new(1000.0)), active: Rc::new(Cell::new(true)), uncertainty: Rc::new(Cell::new(0.0)), replicas: BTreeMap::new() };
	let mut w = Walk { rng: Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1), now: 1000.0, n: 0, known: Known::default(), seen: BTreeMap::new(), hostile: false, trace: std::env::var("PHI_ENTRY_TRACE").is_ok(), ts, rust };
	for name in NAMES {
		let r = w.rust.open(name);
		w.rust.replicas.insert(name.to_owned(), r);
	}
	for _ in 0..steps {
		w.step();
	}
	// every row of every file
	assert_eq!(w.ts.step(&obj! { "op" => "close" }), obj! { "ok" => true, "result" => Json::Null });
	w.rust.close();
	let (a, b) = (Walk::rows(&ts_dir), Walk::rows(&rust_dir));
	for (k, v) in &a {
		assert_eq!(b.get(k), Some(v), "row {k}");
	}
	assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>(), "the same rows");
	// each side on the other's files
	assert_eq!(w.ts.step(&open(&rust_dir, false)), obj! { "ok" => true, "result" => Json::Null });
	w.rust.dir = ts_dir.clone();
	for name in NAMES {
		let r = w.rust.open(name);
		w.rust.replicas.insert(name.to_owned(), r);
	}
	w.hostile = true;
	w.regress("a", "b");
	for _ in 0..steps / 4 {
		w.step();
	}
	assert_eq!(w.ts.step(&obj! { "op" => "close" }), obj! { "ok" => true, "result" => Json::Null });
	w.rust.close();
	let (a, b) = (Walk::rows(&rust_dir), Walk::rows(&ts_dir));
	assert_eq!(a, b, "the rows after the handover");
	let mut report = Object::new();
	for (k, v) in &w.seen {
		report.insert(k.as_str(), Json::Number(*v as f64));
	}
	eprintln!("{} calls; outcomes: {}", w.n, Json::Object(report).to_json_text());
	// the states the walk of the default seed and length reaches (an outcome's key is cut at 60 characters of its message);
	// other seeds explore, and may miss one of the rarer ones
	let must = [
		"mutate ok", "mutate RequestConflict: replication request changed arguments", "mutate ResourceExhausted: replica history is full",
		"importChanges ReplicationConflict: immutable change ID reused", "importChanges ReplicationConflict: changed mutation argument hash",
		"importStreamPage added", "importStreamPage EntryStreamCursorConflict", "streamChanges positions", "streamChanges redacted", "startStreamImport seeded",
		"finishSnapshotImport ok", "abortSnapshotImport ok", "importSnapshotPage ReplicationConflict: duplicate page changed content", "snapshotPage SnapshotExpired",
		"compact dropped", "startCompaction completed", "startSnapshotMaintenance completed", "startCompaction ReplicationConflict: compaction blocked: member ",
		"erasePrincipal ok", "completeErasure ok", "renewal redacted with its tag",
	];
	let missing: Vec<&&str> = must.iter().filter(|k| !w.seen.keys().any(|s| s.starts_with(**k))).collect();
	assert!(missing.is_empty() || steps < 1500 || seed != 1, "the walk reached no {missing:?}");
}
