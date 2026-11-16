//! Model NPCs (`server/npc/minds.ts`, docs/modell-npcs.en.md): who plays a role, who is awake, and what an awake NPC
//! says. Everything lives in the world space:
//!   NpcOwner{npcId, owner}  leased: the process that plays the role (claimed under the NPC lock)
//!   NpcAwake{npcId}         the NPC answers with the model; woken under the NPC lock, at most `npc.max`
//!   NpcMemory{npcId, text}  what it remembers (≤ 4 KiB), written by its own NOTE lines
//! What an awake NPC says comes from the model process: `think` writes a Think and waits for its Thought.
use phi_json::{obj, Json};

use super::ClockCache;
use crate::j;
use crate::js;
use crate::settings::setting;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, tmpl, Error, Result, Space, FOREVER, HELD_WAIT_MS, NO_WAIT};
use crate::world_host::env_ms;

const MEMORY_MAX: usize = 4096;
const MAX_LINES: usize = 4;

pub fn npc_lock() -> Json { tmpl("Lock", obj! { "name" => "npc" }) }

/// `llmEnabled`: model calls only with SPACES_MMO_LLM=1.
pub fn llm_enabled() -> bool { std::env::var("SPACES_MMO_LLM").as_deref() == Ok("1") }

/// What a model NPC may type: the default and trade commands of a registered player that change something, with
/// their help texts (`NPC_COMMANDS`).
fn npc_commands() -> Vec<std::rc::Rc<crate::commands::Command>> {
	const SHOW_ONLY: [&str; 5] = ["look", "who", "inventory", "reputation", "channel"];
	crate::commands::table().0.iter().filter(|c| (c.module == "default" || c.module == "trade") && !c.hidden && c.locks.as_deref().is_none_or(str::is_empty) && !SHOW_ONLY.contains(&c.key.as_str())).cloned().collect()
}

/// Runs `body` holding the NPC lock in a transaction of its own (`locked`).
async fn lock_begin(space: &Space) -> Result<String> {
	let txn = space.create_transaction(15_000.0).await?;
	match space.take(&npc_lock(), 10_000.0, Some(&txn)).await {
		Ok(Some(_)) => Ok(txn),
		Ok(None) => { let _ = space.abort(&txn).await; Err(Error::Other("the npc lock stayed taken".into())) }
		Err(e) => { let _ = space.abort(&txn).await; Err(e) }
	}
}
async fn lock_end<T>(space: &Space, txn: &str, out: Result<T>) -> Result<T> {
	let done = async {
		let v = out?;
		space.write(&npc_lock(), Some(txn), FOREVER).await?;
		space.commit(txn).await?;
		Ok(v)
	}.await;
	if done.is_err() { let _ = space.abort(txn).await; }
	done
}

/// `claimRole`: the role for `owner` unless another process plays it (a held owner entry counts as taken).
pub async fn claim_role(space: &Space, npc_id: &str, owner: &str, lease_ms: f64) -> Result<Option<String>> {
	let txn = lock_begin(space).await?;
	let out: Result<Option<String>> = async {
		match space.read_existing(&tmpl("NpcOwner", obj! { "npcId" => npc_id }), Some(&txn), HELD_WAIT_MS).await {
			Ok(Some(_)) | Err(Error::StillHeld(_)) => return Ok(None),
			Ok(None) => {}
			Err(e) => return Err(e),
		}
		let e = space.write(&tmpl("NpcOwner", obj! { "npcId" => npc_id, "owner" => owner }), Some(&txn), lease_ms).await?;
		Ok(e.get("id").and_then(Json::as_str).map(str::to_owned))
	}.await;
	lock_end(space, &txn, out).await
}

/// `tryWake`: wakes an NPC for `for_world_ms` if fewer than `max` are awake; true when it is awake now.
pub async fn try_wake(space: &Space, clock: &ClockCache, npc_id: &str, max: f64, for_world_ms: f64) -> Result<bool> {
	let txn = lock_begin(space).await?;
	let out: Result<bool> = async {
		let now = clock.decay_now().await.unwrap_or_else(time_now);
		let awake: Vec<Json> = space.read_all(&obj! { "type" => "NpcAwake" }, Some(&txn)).await?.into_iter().filter(|e| j::n(fields(e), "untilWorldMs") > now).collect();
		if awake.iter().any(|e| j::s(fields(e), "npcId") == npc_id) { return Ok(true); }
		if awake.len() as f64 >= max { return Ok(false); }
		space.take_if_exists(&tmpl("NpcAwake", obj! { "npcId" => npc_id }), NO_WAIT, Some(&txn)).await?;
		space.write(&tmpl("NpcAwake", obj! { "npcId" => npc_id, "since" => now, "untilWorldMs" => now + for_world_ms }), Some(&txn), FOREVER).await?;
		Ok(true)
	}.await;
	lock_end(space, &txn, out).await
}

pub async fn is_awake(space: &Space, clock: &ClockCache, npc_id: &str) -> Result<bool> {
	let Some(e) = space.read_if_exists(&tmpl("NpcAwake", obj! { "npcId" => npc_id }), 1_000.0, None).await? else { return Ok(false) };
	Ok(j::n(fields(&e), "untilWorldMs") > clock.decay_now().await.unwrap_or_else(time_now))
}

/// `keepAwake`: another `for_world_ms` for an awake NPC.
pub async fn keep_awake(space: &Space, clock: &ClockCache, npc_id: &str, for_world_ms: f64) -> Result<()> {
	let txn = space.create_transaction(10_000.0).await?;
	let r: Result<()> = async {
		if let Some(e) = space.take_if_exists(&tmpl("NpcAwake", obj! { "npcId" => npc_id }), 1_000.0, Some(&txn)).await? {
			let mut f = fields(&e).clone();
			j::set(&mut f, "untilWorldMs", clock.decay_now().await.unwrap_or_else(time_now) + for_world_ms);
			space.write(&tmpl("NpcAwake", f), Some(&txn), FOREVER).await?;
		}
		space.commit(&txn).await
	}.await;
	if r.is_err() { let _ = space.abort(&txn).await; }
	r
}

/// `sleep`: puts the NPC to sleep (its errand is done, or it leaves).
pub async fn put_to_sleep(space: &Space, npc_id: &str) -> Result<()> {
	while space.take_if_exists(&tmpl("NpcAwake", obj! { "npcId" => npc_id }), NO_WAIT, None).await?.is_some() {}
	Ok(())
}

pub async fn memory_of(space: &Space, npc_id: &str) -> Result<String> {
	Ok(space.read_if_exists(&tmpl("NpcMemory", obj! { "npcId" => npc_id }), 1_000.0, None).await?.map(|e| j::s(fields(&e), "text").to_owned()).unwrap_or_default())
}

/// `remember`: a note added to the NPC's memory; the oldest notes go when it outgrows 4 KiB.
pub async fn remember(space: &Space, npc_id: &str, note: &str) -> Result<()> {
	let txn = space.create_transaction(10_000.0).await?;
	let r: Result<()> = async {
		let e = space.take_if_exists(&tmpl("NpcMemory", obj! { "npcId" => npc_id }), 1_000.0, Some(&txn)).await?;
		let old = e.as_ref().map(|e| j::s(fields(e), "text").to_owned()).unwrap_or_default();
		let mut text = js::trim(&format!("{old}\n{}", phi_spaces_client::cut_text(js::trim(note), 300))).to_owned();
		while text.encode_utf16().count() > MEMORY_MAX { text = match text.find('\n') { Some(i) => text[i + 1..].to_owned(), None => String::new() }; }
		space.write(&tmpl("NpcMemory", obj! { "npcId" => npc_id, "text" => text }), Some(&txn), FOREVER).await?;
		space.commit(&txn).await
	}.await;
	if r.is_err() { let _ = space.abort(&txn).await; }
	r
}

/// `Situation`: what an awake NPC is told.
#[derive(Default)]
pub struct Situation {
	pub room: String, pub people: Vec<String>, pub fire: Option<String>, pub event: String, pub heard: Vec<String>,
	pub me: Option<(f64, f64)>, pub carried: Option<Vec<String>>, pub things: Option<Vec<(String, f64, f64)>>, pub fire_at: Option<(f64, f64)>,
	pub exits: Option<Vec<String>>, pub offers: Option<Vec<String>>, pub board: Option<Vec<String>>, pub lang_en: bool,
}

/// `languageRule`.
pub fn language_rule(en: bool) -> String {
	format!("{} Only your words follow this: commands and the names of things stay exactly as the game writes them.", if en { "You speak English, whatever language you are spoken to in." } else { "You speak the language you are spoken to in, German or English; when in doubt, German." })
}

/// What one answer of an awake model NPC is.
pub enum Thought { Lines { lines: Vec<String>, note: Option<String> }, Off, Budget }

/// The role a `think` is for.
pub struct Mind<'a> { pub npc_id: &'a str, pub name: &'a str, pub persona: &'a str, pub budget_day: f64, pub world_id: &'a str }

/// `think`: one answer of an awake model NPC, its command lines and a note for its memory.
pub async fn think(space: &Space, clock: &ClockCache, npc: &Mind<'_>, s: &Situation, halt: &tokio::sync::watch::Receiver<bool>) -> Result<Thought> {
	if !llm_enabled() { return Ok(Thought::Off); }
	let all = setting(space, "npc.budgetDay").await?;
	let budget = if all < 0.0 { npc.budget_day } else { all };
	let cmds = npc_commands();
	let mut system: Vec<String> = vec![
		format!("You are {}, a character in the text game \"Leuchtfeuer\" (an archipelago in the fog; fires keep the fog away). {}", npc.name, npc.persona),
		format!("{} Briefly (one or two sentences), in character. You act only by typing game commands, one per line;", language_rule(s.lang_en)),
		"you may do everything a player may (say speaks, emote shows what you do in third person without your name):".into(),
	];
	for c in &cmds { system.push(format!("  {}", c.help)); }
	system.push("When someone asks you to do something, decide in character; if you do it, type the commands in order (e.g. walk, pick up, feed the fire, accept a trade) and say so briefly; if you cannot (you lack the thing, it is too far), say why. Use the names of things exactly as listed.".into());
	system.push("Never say you did something you did not type as a command in the same answer (\"I put wood on the fire\" needs the put command, and wood in your pack); the commands run first, and if one fails, your words are not said.".into());
	system.push(format!("Answer with at most {MAX_LINES} such lines. Then, if something is worth remembering for later, one line: NOTE: <what>"));
	let memory = memory_of(space, npc.npc_id).await?;
	let day = clock.clock().await.map(|c| format!("e{}:d{}", phi_json::number_text(j::n(&c, "epoch")), phi_json::number_text(crate::worldtime::calendar(crate::worldtime::world_at(&c, time_now())).0)));
	let mut user: Vec<String> = vec![
		format!("Memory: {}", if memory.is_empty() { "–" } else { &memory }),
		format!("Place: {}", s.room),
		format!("People here: {}", if s.people.is_empty() { "nobody".to_owned() } else { s.people.join(", ") }),
	];
	if let Some(f) = &s.fire { user.push(format!("The beacon: {f}{}", s.fire_at.map_or_else(String::new, |(x, y)| format!(" (at {},{})", phi_json::number_text(x), phi_json::number_text(y))))); }
	if let Some((x, y)) = s.me { user.push(format!("You stand at {},{} and carry: {}", phi_json::number_text(x), phi_json::number_text(y), s.carried.as_ref().filter(|c| !c.is_empty()).map_or_else(|| "nothing".to_owned(), |c| c.join(", ")))); }
	if let Some(t) = &s.things { user.push(format!("Things lying here: {}", if t.is_empty() { "none".to_owned() } else { t.iter().map(|(n, x, y)| format!("{n} at {},{}", phi_json::number_text(*x), phi_json::number_text(*y))).collect::<Vec<_>>().join("; ") })); }
	if let Some(e) = s.exits.as_ref().filter(|e| !e.is_empty()) { user.push(format!("Exits: {}", e.join(", "))); }
	if let Some(o) = s.offers.as_ref().filter(|o| !o.is_empty()) { user.push(format!("Offers to you: {}", o.join(" | "))); }
	if let Some(b) = &s.board { user.push(format!("Market board: {}", if b.is_empty() { "empty".to_owned() } else { b.join(" | ") })); }
	user.push(format!("Event: {}", s.event));
	user.push(format!("Heard: {}", s.heard.join(" | ")));
	let world_id = if npc.world_id.is_empty() { std::env::var("SPACES_MMO_WORLD").ok().filter(|x| !x.is_empty()).unwrap_or_else(|| "leuchtfeuer".into()) } else { npc.world_id.to_owned() };
	let mut t = obj! { "thinkId" => hex(&random_bytes(8)), "npcId" => npc.npc_id, "worldId" => world_id, "system" => system.join("\n"), "user" => user.join("\n"), "maxTokens" => 200.0, "perDay" => budget };
	if let Some(d) = day { j::set(&mut t, "day", d); }
	let text = ask(space, t, halt).await?;
	if *halt.borrow() { return Ok(Thought::Off); }
	let Some(text) = text else { return Ok(Thought::Budget) };
	let verbs: Vec<String> = cmds.iter().flat_map(|c| c.names().map(|v| v.to_lowercase()).collect::<Vec<_>>()).collect();
	let mut lines = Vec::new();
	let mut note = None;
	for raw in text.split('\n').map(js::trim).filter(|l| !l.is_empty()) {
		if let Some(m) = js::caps(&js::re(r"^NOTE:\s*(.+)$", "i"), raw) { note = m[1].clone(); continue; }
		let verb = raw.split_whitespace().next().unwrap_or("").to_lowercase();
		if verbs.contains(&verb) && lines.len() < MAX_LINES { lines.push(js::slice16(raw, 0, Some(300)).to_owned()); }
	}
	Ok(Thought::Lines { lines, note })
}

/// `ask`: a Think for the model process, then its Thought; None when none came in time. A request still untaken is
/// taken back.
async fn ask(space: &Space, t: Json, halt: &tokio::sync::watch::Receiver<bool>) -> Result<Option<String>> {
	let wait_ms = env_ms("SPACES_MMO_THINK_WAIT_MS", 90_000.0);
	let until = time_now() + wait_ms;
	let id = j::s(&t, "thinkId").to_owned();
	space.write(&tmpl("Think", t), None, wait_ms).await?;
	let out: Result<Option<String>> = async {
		while !*halt.borrow() {
			let left = until - time_now();
			if left <= 0.0 { break; }
			if let Some(e) = space.take(&tmpl("Thought", obj! { "thinkId" => id.as_str() }), left.min(2_000.0), None).await? { return Ok(j::so(fields(&e), "text").map(str::to_owned)); }
		}
		Ok(None)
	}.await;
	let _ = space.take_if_exists(&tmpl("Think", obj! { "thinkId" => id.as_str() }), NO_WAIT, None).await;
	out
}
