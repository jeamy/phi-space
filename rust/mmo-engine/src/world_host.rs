//! The world worker as a process (`server/world-host.ts`, R8.3): loads the world into the space, serves the characters'
//! intents oldest first in lanes, runs the world's dates (`engine/schedule.ts`, `engine/worldevents.ts`), delivers what
//! leaves its region (handovers, couriers), and keeps the space tidy (lapsed guests, NPC packs, the cells of characters
//! that went offline). It holds no state of its own: a worker that dies loses at most the command it was running.
//! Everything runs on one thread (`tokio` current-thread with a `LocalSet`), as the TypeScript process does.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use phi_json::{obj, Json};
use phi_spaces_client::{await_work, connect_space, ConnectOptions, Opts};
use tokio::sync::{watch, Notify};

use crate::execute::Worker;
use crate::fire::key_text;
use crate::j;
use crate::loader::{ensure_tokens, load_into_space, LoadOptions};
use crate::model::actor_token;
use crate::occupancy::online_ids;
use crate::regions::{region_world, regions_of};
use crate::source::{hex, random_bytes, time_now};
use crate::space::{by_id, fields, tmpl, Error, Result, Space, FOREVER, HELD_WAIT_MS, NO_WAIT};
use crate::transfer::{carry_waiting, Carrier};
use crate::worker::run_job;
use crate::worldtime::{calendar, next_at_hour, world_at};

/// `envMs`: a positive number of milliseconds from the environment, else the default.
pub fn env_ms(name: &str, fallback: f64) -> f64 { std::env::var(name).ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0).unwrap_or(fallback) }

fn env(name: &str) -> String { std::env::var(name).unwrap_or_default() }

/// `loadDotEnv`: spaces-mmo/.env, values already in the environment win.
pub fn load_dot_env(root: &std::path::Path) {
	let Ok(text) = std::fs::read_to_string(root.join(".env")) else { return };
	let comment = regex::Regex::new(r"\s+#.*$").unwrap();
	for raw in text.lines() {
		let line = raw.trim();
		if line.is_empty() || line.starts_with('#') { continue; }
		let Some(eq) = line.find('=').filter(|i| *i > 0) else { continue };
		let key = line[..eq].trim();
		let val = comment.replace(&line[eq + 1..], "");
		let val = val.trim();
		let val = val.strip_prefix(['"', '\'']).unwrap_or(val);
		let val = val.strip_suffix(['"', '\'']).unwrap_or(val);
		if std::env::var_os(key).is_none() { std::env::set_var(key, val); }
	}
}

// ---- dates in world time (engine/schedule.ts, engine/worldevents.ts)

/// `ClockGuard`: a host clock that jumps back, or forward by more than the tolerance between two looks, stops new
/// world-time events for a while.
pub struct ClockGuard { last: Option<f64>, hold_until: f64, tolerance_ms: f64, hold_ms: f64 }

impl ClockGuard {
	pub fn new(tolerance_ms: f64) -> Self { Self { last: None, hold_until: 0.0, tolerance_ms, hold_ms: 10_000.0 } }
	/// May events be served at real time `now`?
	pub fn ok(&mut self, now: f64) -> bool {
		let last = self.last.replace(now);
		if let Some(last) = last {
			if now < last - 2_000.0 || now - last > self.tolerance_ms {
				let what = if now < last { format!("went back {} ms", last - now) } else { format!("jumped {} ms ahead", now - last) };
				eprintln!("[world] clock alarm: the host's clock {what}; no world-time events for {} ms", self.hold_ms);
				self.hold_until = now + self.hold_ms;
			}
		}
		now >= self.hold_until
	}
}

/// `EVENT_LEASE_MS`.
const EVENT_LEASE_MS: f64 = 5.0 * 60_000.0;
/// `MIN_TICK_REAL_MS`.
const MIN_TICK_REAL_MS: f64 = 100.0;
/// `REAL_FLOOR_MS`.
fn real_floor(job: &str) -> f64 {
	if env("SPACES_MMO_TICK_FLOORS") == "0" { return 0.0; }
	match job { "fire" | "garden" => 5_000.0, "sweep" | "market" => 15_000.0, _ => 0.0 }
}

/// `msUntilWorld`.
fn ms_until_world(clock: &Json, due: f64, real_now: f64) -> f64 {
	let left = due - world_at(clock, real_now);
	if left <= 0.0 { 0.0 } else if j::b(clock, "paused") { f64::INFINITY } else { (left / j::n(clock, "rate")).ceil() }
}

/// What the world worker's schedules run with.
pub struct Jobs { pub space: Space, pub w: Json, pub msg_lease_ms: f64 }

/// `runSchedules` with `SCHEDULE_HANDLERS` and `tickHandler(runs)`: serves every due date; the real milliseconds until
/// the next one (at most `max_wait_ms`).
pub async fn run_schedules(jobs: &Jobs, guard: &mut ClockGuard, txn_ms: f64, max_wait_ms: f64) -> Result<f64> {
	let space = &jobs.space;
	let Some(clock_entry) = space.peek(&obj! { "type" => "WorldClock" }, None).await? else { return Ok(max_wait_ms) };
	let clock = fields(&clock_entry).clone();
	if !guard.ok(real_now()) { return Ok(max_wait_ms); }
	let mut next = max_wait_ms;
	for e in space.read_all(&obj! { "type" => "WorldSchedule" }, None).await? {
		let s = fields(&e).clone();
		let kind = j::s(&s, "kind");
		if !matches!(kind, "evening" | "tick") || j::at(&s, "clockEpoch") != j::at(&clock, "epoch") { continue; }
		let due = j::n(&s, "dueWorldMs");
		let wait = ms_until_world(&clock, due, real_now());
		if wait > 0.0 { next = next.min(wait); continue; }
		let txn = space.create_transaction(txn_ms).await?;
		// None: another worker serves it; Some(ms): how soon to look again
		let served: Result<Option<f64>> = async {
			if space.take_if_exists(&by_id("WorldSchedule", &e), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(None); }
			let world_ms = world_at(&clock, real_now());
			if kind == "evening" {
				if let Err(err) = evening(space, &txn, &clock, &s).await {
					eprintln!("[world] schedule {}: {err}", j::s(&s, "scheduleId"));
					let _ = space.abort(&txn).await;
					return Ok(Some(1000.0));
				}
			}
			let after = if j::s(&s, "missed") == "coalesce" { due.max(world_ms) } else { due };
			let next_due = if kind == "evening" { next_at_hour(after, j::number(j::at(j::at(&s, "payload"), "hour"))) } else {
				let p = j::at(&s, "payload");
				after + j::number(j::at(p, "everyMs")).max(MIN_TICK_REAL_MS.max(real_floor(&key_text(j::at(p, "job")))) * j::n(&clock, "rate"))
			};
			let mut f = j::object(&s);
			f.insert("dueWorldMs", Json::from(next_due));
			space.write(&tmpl("WorldSchedule", Json::Object(f)), Some(&txn), FOREVER).await?;
			space.commit(&txn).await?;
			if kind == "tick" {
				let job = key_text(j::at(j::at(&s, "payload"), "job"));
				let t0 = std::time::Instant::now();
				if let Err(err) = run_job(space, &jobs.w, &job, jobs.msg_lease_ms).await { eprintln!("[world] schedule {}: {err}", j::s(&s, "scheduleId")); }
				if t0.elapsed() > Duration::from_secs(10) { eprintln!("[world] job {job} took {} s", t0.elapsed().as_secs()); }
			}
			Ok(Some(20.0))
		}.await;
		match served {
			Ok(None) => { space.abort(&txn).await?; }
			Ok(Some(ms)) => { next = next.min(ms); }
			Err(err) => { let _ = space.abort(&txn).await; return Err(err); }
		}
	}
	Ok(next.max(20.0))
}

/// The `evening` handler: an event `evening:e<epoch>:d<day>` once per world day and clock epoch.
async fn evening(space: &Space, txn: &str, clock: &Json, s: &Json) -> Result<()> {
	let due = j::n(s, "dueWorldMs");
	let day = calendar(due).0;
	let epoch = j::at(clock, "epoch").clone();
	let event_id = format!("evening:e{}:d{}", key_text(&epoch), phi_json::number_text(day));
	if space.peek(&tmpl("WorldEvent", obj! { "eventId" => event_id.as_str() }), Some(txn)).await?.is_some() { return Ok(()); }
	space.write(&tmpl("WorldEvent", obj! { "eventId" => event_id.as_str(), "kind" => "evening", "worldMs" => due, "epoch" => epoch, "day" => day }), Some(txn), EVENT_LEASE_MS).await?;
	Ok(())
}

fn real_now() -> f64 { time_now() }

// ---- keeping the space tidy

/// `sweepSpots`: the cells of characters that went offline.
pub async fn sweep_spots(space: &Space) -> Result<usize> {
	let live = online_ids(space).await?;
	let mut n = 0;
	for e in space.read_all(&obj! { "type" => "Spot" }, None).await? {
		if !live.contains(&key_text(j::at(fields(&e), "charId"))) && space.take_if_exists(&by_id("Spot", &e), NO_WAIT, None).await?.is_some() { n += 1; }
	}
	Ok(n)
}

/// `cleanup`: the characters of lapsed guest accounts, with what they carried, their cell, their contributions to the
/// fires (in every region), how they travelled and their deeds (in every region).
pub async fn cleanup(space: &Space, all: &[Space]) -> Result<()> {
	for c in space.read_all(&tmpl("Character", obj! { "guest" => true }), None).await? {
		let ch = fields(&c).clone();
		match space.read_existing(&tmpl("Account", obj! { "accountId" => j::at(&ch, "accountId").clone() }), None, HELD_WAIT_MS).await {
			Ok(Some(_)) | Err(Error::StillHeld(_)) => continue,
			Ok(None) => {}
			Err(e) => return Err(e),
		}
		let char_id = key_text(j::at(&ch, "charId"));
		space.take_if_exists(&by_id("Character", &c), NO_WAIT, None).await?;
		space.take_if_exists(&actor_token(&char_id), NO_WAIT, None).await?;
		for ty in ["Item", "Spot", "Contribution", "Travel"] {
			let key = if ty == "Item" { obj! { "location" => char_id.as_str() } } else { obj! { "charId" => char_id.as_str() } };
			let spaces: Vec<&Space> = if ty == "Contribution" { all.iter().collect() } else { vec![space] };
			for s in spaces { for e in s.read_all(&tmpl(ty, key.clone()), None).await? { s.take_if_exists(&by_id(ty, &e), NO_WAIT, None).await?; } }
		}
		for s in all { for e in s.read_all(&tmpl("Deed", obj! { "accountId" => j::at(&ch, "accountId").clone() }), None).await? { s.take_if_exists(&by_id("Deed", &e), NO_WAIT, None).await?; } }
	}
	Ok(())
}

/// `spoil`: what an NPC carries beyond `packMax` of one kind (coins beyond `coinMax`) goes, at most `budget` a round.
pub async fn spoil(space: &Space, w: &Json, mut budget: i64) -> Result<()> {
	let pack_max = env("SPACES_MMO_NPC_PACK_MAX").parse::<f64>().unwrap_or(24.0);
	let coin_max = env("SPACES_MMO_NPC_COIN_MAX").parse::<f64>().unwrap_or(50.0);
	let currency = key_text(j::at(w, "currency"));
	for ch in space.read_all(&obj! { "type" => "Character" }, None).await? {
		let id = key_text(j::at(fields(&ch), "charId"));
		if !id.starts_with("npc-") { continue; }
		let mut kinds: Vec<(String, Vec<Json>)> = Vec::new();
		for e in space.read_all(&tmpl("Item", obj! { "location" => id.as_str() }), None).await? {
			let proto = key_text(j::at(fields(&e), "proto"));
			match kinds.iter_mut().find(|(p, _)| *p == proto) { Some(k) => k.1.push(e), None => kinds.push((proto, vec![e])) }
		}
		for (proto, ids) in kinds {
			let keep = if proto == currency { coin_max } else { pack_max };
			let keep = if keep.is_nan() { 0 } else { keep.max(0.0) as usize };
			for e in ids.iter().skip(keep) {
				budget -= 1;
				if budget < 0 { return Ok(()); }
				space.take_if_exists(&by_id("Item", e), NO_WAIT, None).await?;
			}
		}
	}
	Ok(())
}

// ---- the Process entry (server/space.ts announce)

fn host_facts() -> Json {
	let name = std::env::var("SPACES_MMO_HOST_NAME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| std::fs::read_to_string("/proc/sys/kernel/hostname").map(|s| s.trim().to_owned()).unwrap_or_else(|_| "unknown".into()));
	let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
	let cpu = cpuinfo.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split_once(':')).map(|(_, v)| v.split_whitespace().collect::<Vec<_>>().join(" ")).unwrap_or_else(|| "unknown CPU".into());
	let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
	let mem_kib = std::fs::read_to_string("/proc/meminfo").ok().and_then(|m| m.lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<f64>().ok())).unwrap_or(0.0);
	let arch = match std::env::consts::ARCH { "x86_64" => "x64", "aarch64" => "arm64", a => a };
	let os = match std::env::consts::OS { "linux" => "Linux", "macos" => "Darwin", o => o };
	obj! { "name" => name, "cpu" => cpu, "cores" => cores, "memGiB" => (mem_kib / 1_048_576.0 * 10.0).round() / 10.0, "platform" => format!("{os} {arch}"), "startedAt" => time_now() }
}

/// `announce`: a Process entry for this process while it runs, its lease renewed every 10 s.
pub fn announce(space: Space, role: &str, halt: watch::Receiver<bool>) -> tokio::task::JoinHandle<()> {
	let mut info = j::object(&host_facts());
	info.insert("procId", Json::from(hex(&random_bytes(6))));
	info.insert("role", Json::from(role));
	info.insert("pid", Json::from(std::process::id() as f64));
	let entry = obj! { "type" => "Process", "fields" => Json::Object(info) };
	tokio::task::spawn_local(async move {
		let mut halt = halt;
		let mut lease: Option<String> = None;
		loop {
			if let Some(l) = &lease { if space.remote().renew(l, 30_000.0, &Opts::default()).await.is_err() { lease = None; } }
			if lease.is_none() { if let Ok(r) = space.write(&entry, None, 30_000.0).await { lease = r.get("id").and_then(Json::as_str).map(str::to_owned); } }
			tokio::select! { _ = tokio::time::sleep(Duration::from_secs(10)) => {}, _ = halt.wait_for(|h| *h) => break }
		}
		if let Some(l) = lease { let _ = space.remote().cancel(&l, &Opts::default()).await; }
	})
}

// ---- the process

/// Where the world worker runs and what it loads.
pub struct HostOptions { pub root: PathBuf, pub space: String, pub world: String, pub region: String }

impl HostOptions {
	pub fn from_env(root: PathBuf) -> Self {
		let space = std::env::var("SPACES_MMO_SPACE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "unix:/tmp/spaces-mmo-world.sock".into());
		let world = std::env::var("SPACES_MMO_WORLD").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "leuchtfeuer".into());
		Self { root, space, world, region: env("SPACES_MMO_REGION") }
	}
}

fn connect(address: &str) -> Result<Space> {
	let (remote, _t) = connect_space(address, ConnectOptions::default()).map_err(Error::Other)?;
	Ok(Space::new(remote))
}

/// `regionAddresses`: SPACES_MMO_REGIONS "west=tcp:…,nord=unix:…" (every region the world has), or without it the one
/// space for the whole world.
fn region_addresses(w: &Json, whole: &str) -> Result<Vec<(String, String)>> {
	let raw = env("SPACES_MMO_REGIONS");
	if raw.trim().is_empty() { return Ok(vec![(crate::regions::WHOLE.to_owned(), whole.to_owned())]); }
	let mut out: Vec<(String, String)> = Vec::new();
	for part in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
		let Some(i) = part.find('=').filter(|i| *i >= 1) else { return Err(Error::Other(format!("SPACES_MMO_REGIONS: \"{part}\" is not region=address"))) };
		let (k, v) = (part[..i].to_owned(), part[i + 1..].to_owned());
		match out.iter_mut().find(|(x, _)| *x == k) { Some(slot) => slot.1 = v, None => out.push((k, v)) }
	}
	for g in regions_of(w) { let id = j::s(&g, "regionId"); if !out.iter().any(|(k, _)| k == id) { return Err(Error::Other(format!("SPACES_MMO_REGIONS names no address for the region {id}"))); } }
	Ok(out)
}

/// Starts the world worker and runs it until `halt` turns true (`startWorld` and its close).
pub async fn run_world(o: HostOptions, ready: impl FnOnce(), halt: watch::Receiver<bool>) -> Result<()> {
	let full = crate::world::load_world(&o.root, &o.world)?;
	let region = o.region.clone();
	let w = if region.is_empty() { full.clone() } else { region_world(&full, &region)? };
	let space = connect(&o.space)?;
	let msg_lease_ms = env_ms("SPACES_MMO_MSG_LEASE_MS", 2.0 * 60_000.0);
	let txn_ms = env_ms("SPACES_MMO_TXN_MS", 15_000.0);
	let slow_ms = env("SPACES_MMO_SLOW_MS").parse::<f64>().unwrap_or(0.0);
	// the other regions: to deliver what leaves this one, and so the loader spawns nothing that is there already
	let mut others: Vec<(String, Space)> = Vec::new();
	if !region.is_empty() { for (id, address) in region_addresses(&full, "")? { if id != region { others.push((id, connect(&address)?)); } } }
	let loaded = load_into_space(&space, &w, LoadOptions { replace: false, txn_ms: None, elsewhere: (!region.is_empty()).then(|| others.iter().map(|(_, s)| s.clone()).collect()) }).await?;
	let proc = announce(space.clone(), "world", halt.clone());
	if loaded.loaded { println!("[world] loaded {} version {}{}", j::s(&w, "id"), phi_json::number_text(j::n(&w, "version")), if loaded.spawned.is_empty() { String::new() } else { format!(", placed {}", loaded.spawned.join(", ")) }); }
	if let Err(e) = crate::commands::epoch::epoch_tick(&space, &w, msg_lease_ms).await { eprintln!("[world] epoch count {e}"); }
	let tokens = ensure_tokens(&space).await?;
	if tokens > 0.0 { println!("[world] wrote {} missing tokens", phi_json::number_text(tokens)); }

	let takes_intents = env("SPACES_MMO_WORLD_INTENTS") != "0";
	let batching = env("SPACES_MMO_BATCH") != "0" && space.supports("batch").await;
	let mirror = (batching && takes_intents && env("SPACES_MMO_MIRROR") != "0").then(|| Rc::new(crate::mirror::Mirror::new(space.remote().clone())));
	if let Some(m) = &mirror {
		m.fresh().await?;
		let (m, halt) = (m.clone(), halt.clone());
		tokio::task::spawn_local(async move { m.follow(halt, 20_000.0).await });
	}
	let worker = Rc::new(Worker { space: space.clone(), w: Rc::new(w.clone()), msg_lease_ms, txn_ms, mirror, elsewhere: others.clone(), batch: batching });
	ready();

	let mut tasks: Vec<tokio::task::JoinHandle<()>> = vec![proc];
	// the intents: up to LANES characters at once, each one's commands in order, the one waiting longest first
	if takes_intents {
		let lanes = env_ms("SPACES_MMO_WORLD_LANES", 16.0).floor().max(1.0) as usize;
		let (space, worker, mut halt) = (space.clone(), worker.clone(), halt.clone());
		tasks.push(tokio::task::spawn_local(async move {
			let busy: Rc<RefCell<HashSet<String>>> = Rc::default();
			let held: Rc<RefCell<HashMap<String, f64>>> = Rc::default();
			let done = Rc::new(Notify::new());
			while !*halt.borrow() {
				let r: Result<()> = async {
					let free = lanes.saturating_sub(busy.borrow().len());
					if free == 0 { tokio::select! { _ = done.notified() => {}, _ = halt.wait_for(|h| *h) => {} } return Ok(()); }
					let pending = space.read_limit(&obj! { "type" => "Intent" }, (free * 4).max(8), None).await?;
					if pending.is_empty() && busy.borrow().is_empty() { await_work(space.remote(), &obj! { "type" => "Intent" }, 20_000.0, Some(halt.clone())).await?; return Ok(()); }
					let now = real_now();
					let mut chars: Vec<(String, f64, String)> = Vec::new();
					for p in &pending {
						let id = key_text(j::at(fields(p), "charId"));
						if busy.borrow().contains(&id) || chars.iter().any(|(c, _, _)| *c == id) || held.borrow().get(&id).copied().unwrap_or(0.0) > now { continue; }
						chars.push((id, j::n(fields(p), "at"), key_text(j::at(fields(p), "line"))));
						if chars.len() >= free { break; }
					}
					for (id, typed, line) in &chars {
						busy.borrow_mut().insert(id.clone());
						let (worker, busy, held, done, id, typed, line) = (worker.clone(), busy.clone(), held.clone(), done.clone(), id.clone(), *typed, line.clone());
						tokio::task::spawn_local(async move {
							let r = serve(&worker, &id, slow_ms, typed, &line).await;
							if r == "held" { held.borrow_mut().insert(id.clone(), real_now() + 20.0); } else { held.borrow_mut().remove(&id); }
							busy.borrow_mut().remove(&id);
							done.notify_one();
						});
					}
					if chars.is_empty() { tokio::select! { _ = done.notified() => {}, _ = tokio::time::sleep(Duration::from_millis(if busy.borrow().is_empty() { 20 } else { 50 })) => {} } }
					Ok(())
				}.await;
				if let Err(e) = r { if *halt.borrow() { break; } eprintln!("[world] intent loop: {e}"); tokio::time::sleep(Duration::from_secs(1)).await; }
			}
			while !busy.borrow().is_empty() { tokio::select! { _ = done.notified() => {}, _ = tokio::time::sleep(Duration::from_millis(100)) => {} } }
		}));
	}
	// the world's dates: whichever worker takes a due one serves it, once
	{
		let jobs = Jobs { space: space.clone(), w: w.clone(), msg_lease_ms };
		let mut halt = halt.clone();
		tasks.push(tokio::task::spawn_local(async move {
			let mut guard = ClockGuard::new(env_ms("SPACES_MMO_CLOCK_TOLERANCE_MS", 5.0 * 60_000.0));
			while !*halt.borrow() {
				let wait = match run_schedules(&jobs, &mut guard, txn_ms, 1000.0).await { Ok(ms) => ms, Err(e) => { if !*halt.borrow() { eprintln!("[world] schedules: {e}"); } 1000.0 } };
				tokio::select! { _ = tokio::time::sleep(Duration::from_millis(wait.clamp(0.0, 1e9) as u64)) => {}, _ = halt.wait_for(|h| *h) => {} }
			}
		}));
	}
	// what leaves this region: characters on a ferry (handover.rs) and things for a chest elsewhere (courier.rs)
	if !region.is_empty() {
		for carrier in [Carrier::Handover, Carrier::Courier] {
			let (space, others, full, mut halt) = (space.plain(), others.iter().map(|(k, s)| (k.clone(), s.plain())).collect::<Vec<_>>(), full.clone(), halt.clone());
			tasks.push(tokio::task::spawn_local(async move {
				let name = if carrier == Carrier::Handover { "handover" } else { "courier" };
				while !*halt.borrow() {
					match carry_waiting(&space, &others, carrier, &full).await {
						Ok(0) => { if let Err(e) = await_work(space.remote(), &obj! { "type" => carrier.entry_type() }, 20_000.0, Some(halt.clone())).await { eprintln!("[{name}] {e}"); tokio::time::sleep(Duration::from_secs(1)).await; } }
						Ok(_) => {}
						Err(e) => { if *halt.borrow() { break; } eprintln!("[{name}] {e}"); tokio::select! { _ = tokio::time::sleep(Duration::from_secs(1)) => {}, _ = halt.wait_for(|h| *h) => {} } }
					}
				}
			}));
		}
	}
	// the sweeps on their periods
	let all: Vec<Space> = std::iter::once(space.clone()).chain(others.iter().map(|(_, s)| s.clone())).collect();
	let every = |name: &str, ms: f64| Duration::from_millis(env_ms(name, ms) as u64);
	{
		let (space, all, mut halt, period) = (space.clone(), all.clone(), halt.clone(), every("SPACES_MMO_CLEANUP_MS", 60_000.0));
		tasks.push(tokio::task::spawn_local(async move { loop { tokio::select! { _ = tokio::time::sleep(period) => {}, _ = halt.wait_for(|h| *h) => break } if let Err(e) = cleanup(&space, &all).await { eprintln!("[world] cleanup: {e}"); } } }));
	}
	{
		let (space, w, mut halt, period) = (space.clone(), w.clone(), halt.clone(), every("SPACES_MMO_NPC_PACK_MS", 10.0 * 60_000.0));
		tasks.push(tokio::task::spawn_local(async move { loop { tokio::select! { _ = tokio::time::sleep(period) => {}, _ = halt.wait_for(|h| *h) => break } if let Err(e) = spoil(&space, &w, 500).await { eprintln!("[world] npc packs: {e}"); } } }));
	}
	{
		let (space, mut halt, period) = (space.clone(), halt.clone(), every("SPACES_MMO_SPOT_SWEEP_MS", 30_000.0));
		tasks.push(tokio::task::spawn_local(async move { loop { tokio::select! { _ = tokio::time::sleep(period) => {}, _ = halt.wait_for(|h| *h) => break } if let Err(e) = sweep_spots(&space).await { eprintln!("[world] spots: {e}"); } } }));
	}
	for t in tasks { let _ = t.await; }
	Ok(())
}

/// One character's oldest intent (`serve` of the world host): a refusal is told (Worker::serve), a command too large
/// for one commit is told as such, any other failure leaves the intent for another try a moment later.
async fn serve(worker: &Worker, char_id: &str, slow_ms: f64, typed: f64, line: &str) -> &'static str {
	let t0 = real_now();
	let r = match worker.serve(char_id).await { Ok(r) => r, Err(e) => format!("failed: {e}") };
	if r == "held" { return "held"; }
	if let Some(why) = r.strip_prefix("failed: ") {
		if regex::Regex::new(r"could write \d+ bytes; the limit is").unwrap().is_match(why) {
			eprintln!("[world] command too large: {char_id} {why}");
			if let Ok(Some(a)) = worker.space.peek(&tmpl("Character", obj! { "charId" => char_id }), None).await { worker.refuse(fields(&a), "Das ist zu viel auf einmal. Versuch es mit einer kleineren Menge.").await; }
			return "ran";
		}
		eprintln!("[world] command failed: {why}");
		tokio::time::sleep(Duration::from_millis(500)).await;
	}
	// the intent served may be a later one than the one looked at (`typed`): only a hint, as in TypeScript
	let now = real_now();
	if slow_ms > 0.0 && now - typed > slow_ms { eprintln!("[world] slow: {char_id} \"{}\" {} ms after it was typed, {} ms to run", crate::js::slice16(line, 0, Some(40)), now - typed, now - t0); }
	"ran"
}
