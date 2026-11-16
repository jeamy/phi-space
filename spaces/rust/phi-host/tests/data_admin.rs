// R6a: the trusted admin effects (src/data-admin.ts) against TypeScript (test/support/data-admin-driver.ts): seeded scripted
// Space states and admin commands on both sides, in memory and on a SQLite file (claims and historical claims on the disk).
// Every answer, the journal (as stored text) and the Space (canonical JSON) must be the same after every line.
// `PHI_DATA_ADMIN_STEPS` sets the length, `PHI_DATA_ADMIN_SEED` the seed.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::driver::seeded;
use phi_core::mailbox::principal_id;
use phi_core::space::{error, CoreError, Space, Template};
use phi_host::data_admin::{DataAdminController, JOURNAL};
use phi_json::{obj, Json, Object, FOREVER};
use phi_service::{Options, Service};
use phi_store::{system_random, Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, Synchronous};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
const SID: &str = "sp-00000000-0000-4000-8000-000000000001";
const INC: &str = "0a0b0c0d";

struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		self.0
	}
	fn below(&mut self, n: u64) -> u64 { self.next() % n }
	fn chance(&mut self, percent: u64) -> bool { self.below(100) < percent }
	fn pick<T: Clone>(&mut self, xs: &[T]) -> T { xs[self.below(xs.len() as u64) as usize].clone() }
}

#[derive(Default)]
struct Flags { calls: u64, deny_at: Option<u64>, refused: bool, no_authority: bool }

/// The Rust side of the driver's lines.
struct Side {
	service: Service,
	ctl: DataAdminController,
	clock: Rc<Cell<f64>>,
	flags: Rc<RefCell<Flags>>,
	gens: HashMap<String, String>,
	dir: PathBuf,
	resets: u64,
}

fn pid(p: &Json) -> Json { Json::String(principal_id(p)) }
fn arr(v: Option<&Json>) -> Vec<Json> { v.and_then(Json::as_array).cloned().unwrap_or_default() }

/// `resultOf` of the driver.
fn result_of(s: &Space, now: f64, spec: Option<&Json>, ids: &[String]) -> R<Json> {
	match spec {
		Some(Json::Object(o)) if o.contains_key("entry") => {
			let k = o.get("entry").and_then(Json::as_f64).unwrap_or(-1.0);
			let id = ids.get(k as usize).filter(|_| k >= 0.0).cloned().unwrap_or_else(|| "none".into());
			let found = s.list(now, &Template::from_json(Some(&obj! { "id" => id }))?, None, None, None)?;
			Ok(found.as_array().and_then(|a| a.first()).cloned().unwrap_or(Json::Null))
		}
		Some(Json::Object(o)) if o.contains_key("pid") => Ok(pid(o.get("pid").expect("checked"))),
		Some(v) => Ok(v.clone()),
		None => Ok(Json::Null),
	}
}

/// `seedSpace` of the driver.
fn seed_space(s: &mut Space, now: f64, d: &Json, gens: &HashMap<String, String>, issued: &mut HashMap<String, String>) -> R<()> {
	if let Some(p) = d.get("profiles") {
		let profiles: Vec<Json> = arr(Some(p)).into_iter().map(|t| obj! { "taskType" => t, "resultTypes" => Json::Array(vec!["Result".into()]), "equalFields" => Json::Array(vec!["n".into()]), "maxResultCount" => 1.0 }).collect();
		s.set_completion_profiles(now, Some(&Json::Array(profiles)))?;
	}
	for r in arr(d.get("regs")) {
		s.notify(now, &obj! { "type" => r.get("type").cloned().unwrap_or(Json::Null) }, None, &Json::Number(FOREVER), &Json::Null, &pid(r.get("target").unwrap_or(&Json::Null)), None, r.get("consumer"))?;
	}
	let mut ids = vec![];
	for w in arr(d.get("writes")) {
		let owner = w.get("owner").filter(|o| !o.is_null()).map(pid);
		let entry = obj! { "type" => w.get("type").cloned().unwrap_or(Json::Null), "fields" => w.get("fields").cloned().unwrap_or(Json::Null) };
		let lease = s.write(now, &entry, None, Some(&Json::Number(FOREVER)), owner.as_ref())?;
		ids.push(lease.get("id").and_then(Json::as_str).unwrap_or("").to_owned());
	}
	for c in arr(d.get("claims")) {
		let principal = c.get("principal").cloned().unwrap_or(Json::Null);
		let id = principal_id(&principal);
		let g = match issued.get(&id).or_else(|| gens.get(&id)) {
			Some(g) => g.clone(),
			None => {
				let g = s.issue_generation(now, Some(&principal), &obj! {})?.get("generation").and_then(Json::as_str).unwrap_or("").to_owned();
				issued.insert(id, g.clone());
				g
			}
		};
		let request = c.get("requestId").cloned().unwrap_or(Json::Null);
		let r = obj! { "principal" => principal, "generation" => g, "requestId" => request.clone() };
		let bound = c.get("bound").and_then(Json::as_f64).unwrap_or(8192.0);
		let a = s.admit(now, Some(&r), &"write".into(), &obj! { "r" => request }, &Json::Number(FOREVER), bound)?;
		if a.get("kind").and_then(Json::as_str) != Some("fresh") {
			continue;
		}
		let key = a.get("key").cloned().unwrap_or(Json::Null);
		match c.get("state").and_then(Json::as_str) {
			Some("done") => {
				let result = result_of(s, now, c.get("result"), &ids)?;
				s.decide_line(now, Some(&key), Some(&obj! { "state" => "done", "result" => result }))?;
			}
			Some("cancelled") => {
				s.decide_line(now, Some(&key), Some(&obj! { "state" => "cancelled" }))?;
			}
			_ => {}
		}
	}
	for m in arr(d.get("mail")) {
		let p = m.get("principal").cloned().unwrap_or(Json::Null);
		let mut event = obj! { "kind" => "waiter", "eventId" => m.get("eventId").cloned().unwrap_or(Json::Null), "seq" => 1.0, "target" => pid(&p), "handback" => Json::Null };
		if let Some(k) = m.get("entry") {
			let entry = result_of(s, now, Some(&obj! { "entry" => k.clone() }), &ids)?;
			event.as_object_mut().expect("an object").insert("entry", entry);
		}
		s.append_mail_line(now, Some(&p), Some(&event))?;
	}
	for r in arr(d.get("restored")) {
		let key = r.get("key").and_then(Json::as_str).unwrap_or("").to_owned();
		let result = result_of(s, now, r.get("result"), &ids)?;
		let rec = obj! { "method" => "write", "argHash" => "0".repeat(64), "deadline" => now, "state" => "done", "result" => result, "decidedAt" => now, "generation" => "g-old", "requestId" => key.as_str(), "principal" => r.get("principal").cloned().unwrap_or(Json::Null) };
		s.put_restored(&key, Some(rec));
	}
	for q in arr(d.get("reads")) {
		let tmpl = Template::from_json(Some(&obj! { "type" => q.get("type").cloned().unwrap_or(Json::Null) }))?;
		if q.get("list") == Some(&Json::Bool(true)) {
			s.list(now, &tmpl, None, None, None)?;
		} else {
			s.probe(now, &tmpl, None, q.get("take") == Some(&Json::Bool(true)), None)?;
		}
	}
	if let Some(w) = d.get("waiter") {
		let target = pid(w.get("principal").unwrap_or(&Json::Null));
		s.add_waiter(now, &obj! { "template" => obj! { "type" => "Never" }, "take" => false, "target" => target, "timeout" => w.get("timeout").cloned().unwrap_or(Json::Null) })?;
	}
	if let Some(t) = d.get("txn") {
		s.create_txn(now, t.get("lease"), None)?;
	}
	if let Some(i) = d.get("incarnation") {
		s.state.incarnation = i.as_str().map(str::to_owned);
	}
	match d.get("authority") {
		Some(Json::Null) => {
			s.state.rest.remove("acceptedAuthorityId");
		}
		Some(a) => s.state.rest.insert("acceptedAuthorityId", a.clone()),
		None => {}
	}
	if let Some(l) = d.get("limits") {
		s.set_limits(now, l)?;
	}
	Ok(())
}

impl Side {
	fn new(name: &str) -> Side {
		let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("data-admin-{name}"));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let clock = Rc::new(Cell::new(0.0));
		let flags = Rc::new(RefCell::new(Flags::default()));
		let f = flags.clone();
		let a = flags.clone();
		let c = clock.clone();
		let ctl = DataAdminController {
			authorize: Box::new(move |_, _, _| {
				let mut f = f.borrow_mut();
				f.calls += 1;
				if f.refused || f.deny_at == Some(f.calls) { Err(error("PermissionError", "scope revoked")) } else { Ok(()) }
			}),
			assert_authority: Box::new(move || if a.borrow().no_authority { Err(error("PermissionError", "not the authority")) } else { Ok(()) }),
			now: Box::new(move || c.get()),
		};
		let service = Service::new(Store::open(Ledger::Memory(MemoryLedger::default()), system_random).unwrap(), Options::single_peer("p"));
		Side { service, ctl, clock, flags, gens: HashMap::new(), dir, resets: 0 }
	}

	fn reset(&mut self, store: &str, seed: &str, now: f64) {
		self.resets += 1;
		let ledger = if store == "sqlite" {
			SpaceHost::sqlite(SqliteLedger::open(&self.dir.join(format!("s{}.sqlite", self.resets)), Synchronous::Normal).unwrap())
		} else {
			Ledger::Memory(MemoryLedger::default())
		};
		let mut options = Options::single_peer("p");
		let c = self.clock.clone();
		options.now = Box::new(move || c.get());
		self.service = Service::new(Store::open(ledger, system_random).unwrap(), options);
		self.service.store.create_space_as("jobs", Some((SID, INC)), now, seeded(seed), |_| Ok(())).unwrap().unwrap();
		self.service.store.drain().unwrap();
		self.gens.clear();
	}

	fn run(&mut self, l: &Json) -> R<Json> {
		let s = |k: &str| l.get(k).and_then(Json::as_str).unwrap_or("").to_owned();
		if let Some(n) = l.get("fill").and_then(Json::as_f64) {
			let mut last = Json::Null;
			for k in 0..n as u64 {
				last = self.ctl.execute(&mut self.service, &format!("{}-{k}", s("prefix")), "purgeTasks", SID, "admin", &obj! { "type" => "None" })?;
			}
			return Ok(last);
		}
		if let Some(d) = l.get("seed") {
			let mut issued = HashMap::new();
			let gens = self.gens.clone();
			self.service.commit_on(Some(SID), |sp, now| seed_space(sp, now, d, &gens, &mut issued))?;
			self.service.store.drain().unwrap();
			self.gens.extend(issued);
			return Ok(Json::Null);
		}
		let op = s("op");
		let input = l.get(if op == "purgeTasks" { "template" } else { "principal" }).cloned().unwrap_or(Json::Null);
		let kind = l.get("kind").and_then(Json::as_str).map_or(op.clone(), str::to_owned);
		match op.as_str() {
			"purgeTasks" | "deletePrincipal" => self.ctl.execute(&mut self.service, &s("id"), &kind, &s("spaceId"), &s("admin"), &input),
			"startDeletion" => self.ctl.start_deletion(&mut self.service, &s("id"), &s("spaceId"), &s("admin"), &input),
			_ => self.ctl.advance_deletion(&mut self.service, &s("id"), &s("spaceId"), &s("admin"), &input),
		}
	}

	/// The answer as the driver writes it.
	fn step(&mut self, l: &Json) -> Json {
		let now = l.get("now").and_then(Json::as_f64).unwrap_or(0.0);
		self.clock.set(now);
		if l.get("reset").is_some() {
			self.reset(l.get("store").and_then(Json::as_str).unwrap_or("memory"), l.get("seed").and_then(Json::as_str).unwrap_or(""), now);
		}
		*self.flags.borrow_mut() = Flags { calls: 0, deny_at: l.get("denyAt").and_then(Json::as_f64).map(|n| n as u64), refused: l.get("authorized") == Some(&Json::Bool(false)), no_authority: l.get("authority") == Some(&Json::Bool(false)) };
		let mut out = match if l.get("reset").is_some() { Ok(Json::Null) } else { self.run(l) } {
			Ok(r) => obj! { "ok" => true, "result" => r },
			Err(e) => obj! { "ok" => false, "error" => e.class, "message" => e.message },
		};
		let journal = self.service.store.stored_document(JOURNAL, Some(SID)).unwrap().unwrap_or(Json::Null);
		let host = self.service.store.reader(Some(SID)).unwrap();
		// the historical claims on the disk read in, as TypeScript's snapshot gives them
		let space = host.space.to_json_read();
		let rpc = |k: &str| space.get("rpc").and_then(|r| r.get(k)).cloned().unwrap_or(Json::Null);
		let (bytes, reserved) = (rpc("bytes"), rpc("reservedBytes"));
		let o = out.as_object_mut().expect("an object");
		o.insert("journal", journal);
		o.insert("space", space);
		o.insert("rpcBytes", bytes);
		o.insert("reservedBytes", reserved);
		out
	}
}

fn principals() -> Vec<Json> { vec![obj! { "peerId" => "alice" }, obj! { "peerId" => "bob" }, obj! { "peerId" => "alice", "agentId" => "a1" }, obj! { "peerId" => "carol" }] }

struct Walk { r: Rng, now: f64, serial: u64 }
impl Walk {
	fn principal(&mut self) -> Json { let p = principals(); self.r.pick(&p) }
	fn result_spec(&mut self, writes: usize) -> Json {
		match self.r.below(5) {
			0 | 1 if writes > 0 => obj! { "entry" => self.r.below(writes as u64) as f64 },
			2 => obj! { "pid" => self.principal() },
			3 => obj! { "nested" => Json::Array(vec![Json::String(principal_id(&self.principal()))]) },
			_ => obj! { "note" => "unrelated" },
		}
	}
	fn writes(&mut self, n: u64, owner: Option<Json>) -> Vec<Json> {
		(0..n).map(|_| {
			let ty = self.r.pick(&["Task", "Private", "Keep"]);
			let pad = self.r.pick(&[0, 10, 300, 1800]);
			let owner = owner.clone().unwrap_or_else(|| if self.r.chance(75) { self.principal() } else { Json::Null });
			obj! { "type" => ty, "fields" => obj! { "n" => self.r.below(4) as f64, "secret" => "x".repeat(pad) }, "owner" => owner }
		}).collect()
	}
	/// A read, a take or a list of one type.
	fn read(&mut self) -> Json {
		let ty = self.r.pick(&["Task", "Private", "Keep"]);
		match self.r.below(3) {
			0 => obj! { "type" => ty, "list" => true },
			1 => obj! { "type" => ty, "take" => true },
			_ => obj! { "type" => ty },
		}
	}
	/// A scripted state; `fenced`: only what TypeScript lets through under a deletion's fence or what unsticks one.
	fn seed(&mut self, fenced: bool) -> Json {
		let mut d = Object::new();
		if fenced {
			// what every other operation tries under a deletion's fence: each part alone, so each refusal shows
			match self.r.below(6) {
				0 => d.insert("writes", Json::Array(self.writes(1, None))),
				1 => {
					self.serial += 1;
					let state = self.r.pick(&["done", "pending", "cancelled"]);
					d.insert("claims", Json::Array(vec![obj! { "principal" => self.principal(), "requestId" => format!("r{}", self.serial), "state" => state, "result" => obj! { "note" => "x" } }]));
				}
				2 => {
					self.serial += 1;
					d.insert("mail", Json::Array(vec![obj! { "principal" => self.principal(), "eventId" => format!("m{}", self.serial) }]));
				}
				3 => d.insert("waiter", obj! { "principal" => self.principal(), "timeout" => 1000.0 }),
				4 => d.insert("reads", Json::Array(vec![self.read()])),
				_ => d.insert("txn", obj! { "lease" => 1000.0 }),
			}
		} else {
			if self.r.chance(20) {
				d.insert("profiles", self.r.pick(&[Json::Array(vec!["Task".into()]), Json::Array(vec!["Task".into(), "Private".into()]), Json::Array(vec!["Keep".into()])]));
			}
			if self.r.chance(25) {
				let regs: Vec<Json> = (0..1 + self.r.below(2)).map(|_| {
					let mut reg = obj! { "type" => self.r.pick(&["Task", "Private"]), "target" => self.principal() };
					if self.r.chance(40) {
						reg.as_object_mut().unwrap().insert("consumer", self.principal());
					}
					reg
				}).collect();
				d.insert("regs", Json::Array(regs));
			}
			let bulk = self.r.chance(5);
			let owner = bulk.then(|| self.principal());
			let n = if bulk { 40 + self.r.below(40) } else { self.r.below(5) };
			let writes = self.writes(n, owner.clone());
			let count = writes.len();
			if count > 0 {
				d.insert("writes", Json::Array(writes));
			}
			let claims = if bulk { 70 + self.r.below(60) } else if self.r.chance(40) { 1 + self.r.below(4) } else { 0 };
			let list: Vec<Json> = (0..claims).map(|_| {
				self.serial += 1;
				let p = owner.clone().filter(|_| self.r.chance(80)).unwrap_or_else(|| self.principal());
				let state = if self.r.chance(8) { "pending" } else { self.r.pick(&["done", "done", "done", "cancelled"]) };
				obj! { "principal" => p, "requestId" => format!("r{}", self.serial), "state" => state, "result" => self.result_spec(count) }
			}).collect();
			if !list.is_empty() {
				d.insert("claims", Json::Array(list));
			}
			if self.r.chance(30) {
				let mail: Vec<Json> = (0..1 + self.r.below(3)).map(|_| {
					self.serial += 1;
					let mut m = obj! { "principal" => self.principal(), "eventId" => format!("m{}", self.serial) };
					if count > 0 && self.r.chance(60) {
						m.as_object_mut().unwrap().insert("entry", Json::Number(self.r.below(count as u64) as f64));
					}
					m
				}).collect();
				d.insert("mail", Json::Array(mail));
			}
			let restored = if bulk { 66 + self.r.below(40) } else if self.r.chance(15) { 1 + self.r.below(3) } else { 0 };
			let list: Vec<Json> = (0..restored).map(|_| {
				self.serial += 1;
				let p = owner.clone().filter(|_| self.r.chance(80)).unwrap_or_else(|| self.principal());
				obj! { "key" => format!("h{:05}", self.serial), "principal" => p, "result" => self.result_spec(count) }
			}).collect();
			if !list.is_empty() {
				d.insert("restored", Json::Array(list));
			}
			if self.r.chance(15) {
				let reads: Vec<Json> = (0..1 + self.r.below(2)).map(|_| self.read()).collect();
				d.insert("reads", Json::Array(reads));
			}
			if self.r.chance(8) {
				let timeout = self.r.pick(&[1000.0, 3000.0, FOREVER]);
				d.insert("waiter", obj! { "principal" => self.principal(), "timeout" => timeout });
			}
			if self.r.chance(8) {
				// a transaction needs completion profiles
				d.insert("profiles", Json::Array(vec!["Task".into(), "Private".into()]));
				let lease = self.r.pick(&[1000.0, 3000.0, FOREVER]);
				d.insert("txn", obj! { "lease" => lease });
			}
		}
		if self.r.chance(5) {
			d.insert("incarnation", self.r.pick(&[INC, "restored-x"]).into());
		}
		if self.r.chance(5) {
			d.insert("authority", self.r.pick(&[Json::Null, "auth-b".into()]));
		}
		if self.r.chance(15) {
			let max = self.r.pick(&[2047.0, 2048.0, 2300.0, 2600.0, 3000.0, 4096.0, 8192.0, 196_608.0, 196_608.0]);
			d.insert("limits", obj! { "maxCommitBytes" => max });
		}
		Json::Object(d)
	}

	/// A command; `fence`: the deletion under way (its id and principal), if any.
	fn op(&mut self, fence: Option<(String, Json)>) -> Json {
		let r = &mut self.r;
		let ids = ["c1", "c2", "c3", "c4", "7", "12", "c1", "c2", "toString", &"a".repeat(128), &"a".repeat(129), "__proto__", "constructor", "-x", "ok.:_-1", ""];
		let mut id = if r.chance(85) { r.pick(&ids[..8]).to_owned() } else { r.pick(&ids).to_owned() };
		let space = if r.chance(88) { SID.to_owned() } else { r.pick(&["jobs".to_owned(), "sp-unknown".to_owned(), String::new(), "s".repeat(129)]) };
		let admin = if r.chance(88) { "admin".to_owned() } else { r.pick(&["root".to_owned(), String::new(), "y".repeat(129), "ä".repeat(128), "😀".repeat(64), "😀".repeat(65)]) };
		let invalid = [obj! { "peerId" => "" }, obj! { "peerId" => "a", "extra" => 1.0 }, obj! { "peerId" => "a", "agentId" => Json::Null }, "alice".into(), obj! { "peerId" => "p".repeat(129) }];
		let mut principal = if r.chance(90) { self.principal() } else { self.r.pick(&invalid) };
		let r = &mut self.r;
		let mut op = r.pick(&["purgeTasks", "purgeTasks", "deletePrincipal", "deletePrincipal", "startDeletion", "startDeletion", "advanceDeletion"]);
		if let Some((fid, fp)) = fence.filter(|_| r.chance(65)) {
			op = if r.chance(85) { "advanceDeletion" } else { "deletePrincipal" };
			id = fid;
			principal = fp;
		}
		let tmpl = r.pick(&[obj! { "type" => "Task" }, obj! { "type" => "Private" }, obj! { "type" => "Keep" }, obj! { "type" => "None" }, obj! { "type" => "Task", "fields" => obj! { "n" => 1.0 } }, Json::Null]);
		let mut l = obj! { "now" => self.now, "op" => op, "id" => id, "spaceId" => space, "admin" => admin };
		let o = l.as_object_mut().unwrap();
		if op == "purgeTasks" { o.insert("template", tmpl) } else { o.insert("principal", principal) }
		if r.chance(3) && (op == "purgeTasks" || op == "deletePrincipal") {
			o.insert("kind", "other".into());
		}
		if r.chance(4) {
			o.insert("authorized", false.into());
		}
		if r.chance(12) {
			o.insert("denyAt", Json::Number((1 + r.below(5)) as f64));
		}
		if r.chance(3) {
			o.insert("authority", false.into());
		}
		l
	}
}

fn compare(n: usize, line: &Json, rust: &Json, ts: &Json) {
	let at = |k: &str, v: &Json| v.get(k).cloned().unwrap_or(Json::Null);
	let short = |v: &Json| { let t = v.to_json_text(); t.chars().take(3000).collect::<String>() };
	for k in ["ok", "result", "error", "message", "rpcBytes", "reservedBytes"] {
		assert_eq!(at(k, rust).to_json_text(), at(k, ts).to_json_text(), "{k} at step {n}: {}", short(line));
	}
	assert_eq!(at("journal", rust).to_json_text(), at("journal", ts).to_json_text(), "journal at step {n}: {}", short(line));
	let (a, b) = (at("space", rust).canonical().unwrap(), at("space", ts).canonical().unwrap());
	if a != b {
		let pos = a.bytes().zip(b.bytes()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
		let from = pos.saturating_sub(300);
		panic!("space at step {n}: {}\nrust: …{}\nts:   …{}", short(line), &a[from..(pos + 300).min(a.len())], &b[from..(pos + 300).min(b.len())]);
	}
}

fn walk(store: &str) {
	let steps: u64 = std::env::var("PHI_DATA_ADMIN_STEPS").ok().and_then(|n| n.parse().ok()).unwrap_or(400);
	let seed: u64 = std::env::var("PHI_DATA_ADMIN_SEED").ok().and_then(|n| n.parse().ok()).unwrap_or(0x5eed_da7a_0001);
	let mut ts = TsDriver::script("test/support/data-admin-driver.ts");
	let mut rust = Side::new(store);
	let mut w = Walk { r: Rng(seed), now: 1_000_000.0, serial: 0 };
	let (mut completed, mut refused, mut fenced_steps) = (0, 0, 0);
	let mut episode = 0;
	let mut lines: Vec<Json> = vec![];
	let mut n = 0;
	let send = |l: Json, rust: &mut Side, ts: &mut TsDriver, n: &mut usize| -> Json {
		let a = rust.step(&l);
		let b = ts.step(&l);
		compare(*n, &l, &a, &b);
		*n += 1;
		a
	};
	// scripted: a bulk principal across many 64-row pages of claims and historical claims, with the default budget (the
	// 32-mutation cap) and with a small one (many short batches)
	for max in [196_608.0, 4096.0] {
		episode += 1;
		send(obj! { "reset" => true, "store" => store, "seed" => format!("bulk{episode}"), "now" => w.now }, &mut rust, &mut ts, &mut n);
		let bob = obj! { "peerId" => "bob" };
		let writes = w.writes(50, Some(bob.clone()));
		let claims: Vec<Json> = (0..140).map(|i| obj! { "principal" => if i % 5 == 0 { obj! { "peerId" => "carol" } } else { bob.clone() }, "requestId" => format!("b{i}"), "state" => "done", "result" => if i % 3 == 0 { obj! { "entry" => (i % 50) as f64 } } else { obj! { "note" => "x" } } }).collect();
		let restored: Vec<Json> = (0..90).map(|i| obj! { "key" => format!("h{i:03}"), "principal" => if i % 4 == 0 { obj! { "peerId" => "carol" } } else { bob.clone() }, "result" => obj! { "pid" => bob.clone() } }).collect();
		send(obj! { "now" => w.now, "seed" => obj! { "writes" => Json::Array(writes), "claims" => Json::Array(claims), "restored" => Json::Array(restored), "limits" => obj! { "maxCommitBytes" => max } } }, &mut rust, &mut ts, &mut n);
		let a = send(obj! { "now" => w.now, "op" => "deletePrincipal", "id" => "bulk", "spaceId" => SID, "admin" => "admin", "principal" => bob.clone() }, &mut rust, &mut ts, &mut n);
		assert_eq!(a.get("ok"), Some(&Json::Bool(true)), "the bulk deletion: {}", a.get("message").map(Json::to_json_text).unwrap_or_default());
		completed += 1;
	}
	let mut seen: std::collections::BTreeMap<String, usize> = Default::default();
	let mut fresh = true;
	for _ in 0..steps {
		w.now += (w.r.below(4) * 700) as f64;
		if fresh || w.r.chance(4) {
			episode += 1;
			send(obj! { "reset" => true, "store" => store, "seed" => format!("walk{episode}"), "now" => w.now }, &mut rust, &mut ts, &mut n);
			fresh = false;
			continue;
		}
		let state = rust.service.store.reader(Some(SID)).unwrap().space.to_json_read();
		let fence = state.get("adminMaintenance").and_then(|f| f.get("commandId")).and_then(Json::as_str).map(str::to_owned);
		let journal = rust.service.store.stored_document(JOURNAL, Some(SID)).unwrap();
		let fence = fence.and_then(|id| journal.as_ref().and_then(|j| j.get("commands")).and_then(|c| c.get(&id)).and_then(|c| c.get("principal")).map(|p| (id, p.clone())));
		fenced_steps += usize::from(fence.is_some());
		let l = if w.r.chance(1) {
			obj! { "now" => w.now, "fill" => w.r.pick(&[5.0, 20.0, 60.0, 130.0]), "prefix" => format!("f{}", w.r.below(3)) }
		} else if w.r.chance(if fence.is_some() { 40 } else { 30 }) {
			obj! { "now" => w.now, "seed" => w.seed(fence.is_some()) }
		} else {
			w.op(fence)
		};
		lines.push(l.clone());
		let a = send(l, &mut rust, &mut ts, &mut n);
		let what = match a.get("message").and_then(Json::as_str) {
			Some(m) => format!("{}: {}", a.get("error").and_then(Json::as_str).unwrap_or(""), m.chars().take(70).collect::<String>()),
			None => format!("ok {}", a.get("result").and_then(|r| r.get("phase")).and_then(Json::as_str).unwrap_or("")),
		};
		*seen.entry(what).or_default() += 1;
		if a.get("ok") == Some(&Json::Bool(false)) {
			refused += 1;
		} else if a.get("result").and_then(|r| r.get("kind")).and_then(Json::as_str) == Some("deletePrincipal") && a.get("result").and_then(|r| r.get("phase")).is_none_or(|p| p.as_str() == Some("completed")) {
			completed += 1;
		}
	}
	eprintln!("{store}: {n} lines\n{}", seen.iter().map(|(k, v)| format!("{v:5} {k}")).collect::<Vec<_>>().join("\n"));
	assert!(completed > 3 && refused > 10 && fenced_steps > 5, "the walk reached too little: {completed} deletions, {refused} refusals, {fenced_steps} fenced steps");
}

#[test]
fn in_memory() { walk("memory"); }

#[test]
fn on_sqlite() { walk("sqlite"); }
