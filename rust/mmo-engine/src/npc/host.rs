//! `startNpcs` of `server/npc-host.ts`: every role of the world (or of SPACES_MMO_NPCS) claimed with a lease and played
//! by its script while this process holds it; with SPACES_MMO_REGION only while its NPC stands in this region's space.
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;

use phi_json::Json;
use phi_spaces_client::Opts;
use tokio::sync::{watch, Notify};

use super::minds::claim_role;
use super::scripts::Script;
use super::{present_at, ClockCache, Npc, Session, SESSION_LEASE_MS};
use crate::j;
use crate::room_growth::spatial_world;
use crate::source::{hex, random_bytes};
use crate::space::{tmpl, Result, Space};
use crate::world_host::{announce, connect, env_ms};

const ARRIVAL_LOOK_MS: f64 = 3_000.0;

fn role_lease_ms() -> f64 { env_ms("SPACES_MMO_NPC_ROLE_LEASE_MS", 60_000.0) }

async fn here(space: &Space, char_id: &str) -> Option<bool> {
	match space.peek(&tmpl("Character", phi_json::obj! { "charId" => char_id }), None).await { Ok(e) => Some(e.is_some()), Err(_) => None }
}

/// `atPlan`: false while the role's plan says away (the figure leaves with a word and comes back when it says present).
async fn at_plan(n: &Npc, clock: &ClockCache) -> Result<bool> {
	let def = n.def();
	let Some(plan) = j::opt(&def, "plan").filter(|p| p.as_object().is_some()) else { return Ok(true) };
	if j::truthy(j::at(&def, "wanderer")) { return Ok(true); }
	let Some(at) = clock.now().await else { return Ok(true) };
	let want = present_at(plan, at);
	if want && !n.is_online() { n.set_online(true).await?; } else if !want && n.is_online() { n.act("emote geht nach Hause.").await?; n.set_online(false).await?; }
	Ok(want)
}

/// One role, claimed again and again until the process stops.
async fn play(n: Rc<Npc>, full: Rc<Json>, regional: bool, owner: Rc<String>, world_clock: Rc<ClockCache>, ready: Rc<dyn Fn()>) {
	let space = n.space.clone();
	let def0 = n.def();
	let npc_id = j::s(&def0, "npcId").to_owned();
	while !n.halted() {
		if regional && here(&space, &n.char_id).await != Some(true) { ready(); n.sleep(ARRIVAL_LOOK_MS).await; continue; }
		let Some(mut script) = Script::of(j::s(&def0, "script")) else { ready(); return };
		let role = match claim_role(&space, &npc_id, &owner, role_lease_ms()).await { Ok(Some(r)) => r, _ => { ready(); n.sleep(role_lease_ms() / 2.0).await; continue; } };
		let lost = Rc::new(Cell::new(false));
		let gone = Rc::new(Cell::new(false));
		n.session.keep(&space).await;
		ready();
		let beat = {
			let (space, session, lost, gone, role, char_id, mut halt) = (space.clone(), n.session.clone(), lost.clone(), gone.clone(), role.clone(), n.char_id.clone(), n.halt.clone());
			let every = SESSION_LEASE_MS.min(role_lease_ms()) / 2.0;
			tokio::task::spawn_local(async move {
				loop {
					tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_millis(every as u64)) => {}, _ = halt.wait_for(|h| *h) => return }
					if regional && here(&space, &char_id).await == Some(false) { gone.set(true); return; }
					session.keep(&space).await;
					if space.remote().renew(&role, role_lease_ms(), &Opts::default()).await.is_err() { lost.set(true); }
				}
			})
		};
		while !n.halted() && !lost.get() && !gone.get() {
			let r: Result<()> = async {
				let w = spatial_world(&space, &full).await?;
				let def = j::a(&w, "npcs").iter().find(|d| j::s(d, "npcId") == npc_id).cloned().unwrap_or_else(|| def0.clone());
				*n.world.borrow_mut() = Rc::new(w);
				*n.def.borrow_mut() = def;
				if at_plan(&n, &world_clock).await? { script.round(&n).await } else { n.sleep(n.pace(5_000.0, 200.0)).await; Ok(()) }
			}.await;
			if let Err(e) = r { if !n.halted() { eprintln!("[npc] {npc_id}: {e}"); n.sleep(1000.0).await; } }
		}
		beat.abort();
		n.session.cancel(&space).await;
		let _ = space.remote().cancel(&role, &Opts::default()).await;
	}
}

/// Starts every role and runs them until `halt` turns true; `ready` once each role has its session or found its owner.
pub async fn run_npcs(root: PathBuf, ready: impl FnOnce(), halt: watch::Receiver<bool>) -> Result<()> {
	let address = std::env::var("SPACES_MMO_SPACE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "unix:/tmp/spaces-mmo-world.sock".into());
	let world = std::env::var("SPACES_MMO_WORLD").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "leuchtfeuer".into());
	let full = Rc::new(crate::world::load_world(&root, &world)?);
	let space = connect(&address)?;
	let owner = Rc::new(format!("npc-proc-{}", hex(&random_bytes(4))));
	let world_clock = Rc::new(ClockCache::new(space.clone(), Some(j::s(&full, "id").to_owned())));
	let clock = Rc::new(ClockCache::new(space.clone(), None));
	let only: Vec<String> = std::env::var("SPACES_MMO_NPCS").unwrap_or_default().split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
	let regional = std::env::var("SPACES_MMO_REGION").is_ok_and(|r| !r.is_empty());
	let waiting = Rc::new(Cell::new(0usize));
	let all_ready = Rc::new(Notify::new());
	let mut runs = Vec::new();
	for def in j::a(&full, "npcs") {
		let npc_id = j::s(def, "npcId");
		if !only.is_empty() && !only.iter().any(|o| o == npc_id) { continue; }
		if Script::of(j::s(def, "script")).is_none() { eprintln!("[npc] {npc_id}: unknown script {}", j::s(def, "script")); continue; }
		let char_id = format!("npc-{npc_id}");
		let online = !j::truthy(j::at(def, "wanderer")) && !j::truthy(j::at(def, "settler")) && !j::truthy(j::at(def, "villager"));
		let session = Rc::new(Session { char_id: char_id.clone(), regional, online: Cell::new(online), lease: RefCell::new(None) });
		let n = Rc::new(Npc { def: RefCell::new(def.clone()), world: RefCell::new(full.clone()), char_id, space: space.clone(), halt: halt.clone(), session, clock: clock.clone(), boarding: RefCell::new(None) });
		waiting.set(waiting.get() + 1);
		let done = Rc::new(Cell::new(false));
		let signal: Rc<dyn Fn()> = { let (waiting, all_ready, done) = (waiting.clone(), all_ready.clone(), done.clone()); Rc::new(move || { if !done.replace(true) { waiting.set(waiting.get() - 1); if waiting.get() == 0 { all_ready.notify_one(); } } }) };
		runs.push(tokio::task::spawn_local(play(n, full.clone(), regional, owner.clone(), world_clock.clone(), signal)));
	}
	if waiting.get() > 0 {
		let mut h = halt.clone();
		tokio::select! { _ = all_ready.notified() => {}, _ = h.wait_for(|x| *x) => {} }
	}
	let proc = announce(space.clone(), "npc", halt.clone());
	ready();
	for r in runs { let _ = r.await; }
	let _ = proc.await;
	Ok(())
}
