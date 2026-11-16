//! Scripts of the npc process (`server/npc/scripts.ts`). A script is one round of an NPC's life: it reads the world,
//! types at most a few commands (`Npc::act` waits until each is taken) and sleeps; the host calls it again and again.
use std::collections::{HashMap, HashSet};

use phi_json::{obj, Json};

use super::economy::{self, Gaertnerin, Haendler, Handwerker, Huter, Plauderer, Sammler};
use super::minds::{self, llm_enabled, Mind, Situation, Thought};
use super::requests::{gather, request_of, unclear, Request};
use super::settlers::{Bauhelfer, Dorfbewohner, Siedler};
use super::{pick, Npc};
use crate::fire::{burn_text, fog_of};
use crate::j;
use crate::js::{self, JsRegex};
use crate::settings::setting;
use crate::source::{random_int, time_now};
use crate::space::{fields, tmpl, Result, FOREVER, NO_WAIT};

/// How long a model role stays awake after something woke it or spoke to it, in world time.
const AWAKE_WORLD_MS: f64 = 5.0 * 60_000.0;

/// The NPC's character, or None while the world has not created it yet.
pub async fn self_of(n: &Npc) -> Result<Option<Json>> { Ok(n.space.peek(&tmpl("Character", obj! { "charId" => n.char_id.as_str() }), None).await?.map(|e| fields(&e).clone())) }

/// Said by a person, not by an NPC.
pub fn by_person(m: &Json) -> bool { !j::s(m, "fromId").starts_with("npc-") }

/// `newHeard`: what others said in the NPC's room since the last call, by message id; the first call takes what was
/// said since the role started here.
pub struct Heard { known: Option<HashSet<String>>, started: f64 }
impl Heard {
	pub fn new() -> Self { Self { known: None, started: time_now() - 2_000.0 } }
	pub async fn since(&mut self, n: &Npc, me: &Json) -> Result<Vec<Json>> {
		let all = n.space.read_all(&tmpl("Msg", obj! { "room" => j::at(me, "room").clone(), "to" => "*", "kind" => "say" }), None).await?;
		let id = |e: &Json| j::s(e, "id").to_owned();
		let fresh: Vec<&Json> = match &self.known { Some(k) => all.iter().filter(|e| !k.contains(&id(e))).collect(), None => all.iter().filter(|e| j::n(fields(e), "at") >= self.started).collect() };
		let out: Vec<Json> = fresh.into_iter().map(|e| fields(e).clone()).filter(|m| j::at(m, "from") != j::at(me, "name")).collect();
		self.known = Some(all.iter().map(id).collect());
		Ok(out)
	}
}
impl Default for Heard { fn default() -> Self { Self::new() } }

/// `newWorldEvents`: the kinds of the world events that appeared since the last call.
#[derive(Default)]
pub struct WorldEvents { known: Option<HashSet<String>> }
impl WorldEvents {
	pub async fn fresh(&mut self, n: &Npc) -> Result<Vec<String>> {
		let all = n.space.read_all(&obj! { "type" => "WorldEvent" }, None).await?;
		let key = |e: &Json| crate::fire::key_text(j::at(fields(e), "eventId"));
		let fresh: Vec<String> = match &self.known { Some(k) => all.iter().filter(|e| !k.contains(&key(e))).map(|e| crate::fire::key_text(j::at(fields(e), "kind"))).collect(), None => vec![] };
		self.known = Some(all.iter().map(key).collect());
		Ok(fresh)
	}
}

/// `humansIn`: online characters of players in a room (not NPCs), by name.
pub async fn humans_in(n: &Npc, room: &str) -> Result<Vec<String>> {
	let live: HashSet<String> = n.space.read_all(&obj! { "type" => "Session" }, None).await?.iter().map(|s| crate::fire::key_text(j::at(fields(s), "charId"))).collect();
	Ok(n.space.read_all(&tmpl("Character", obj! { "room" => room }), None).await?.iter().map(fields).filter(|c| { let id = j::s(c, "charId"); live.contains(id) && !id.starts_with("npc-") }).map(|c| j::s(c, "name").to_owned()).collect())
}
async fn room_name(n: &Npc, room: &str) -> Result<String> {
	Ok(n.space.peek(&tmpl("Room", obj! { "roomId" => room }), None).await?.map_or_else(|| room.to_owned(), |e| crate::fire::key_text(j::at(fields(&e), "name"))))
}
/// `dozeLine`: "Ines flickt ein Netz." → "flickt ein Netz.".
fn doze_line(name: &str, lines: &[Json], i: usize) -> String {
	let l = lines.get(i).and_then(Json::as_str).map_or_else(|| format!("{name} döst."), str::to_owned);
	JsRegex::new(&format!("^{name}\\s+"), "").map_or(l.clone(), |r| r.replace(&l, ""))
}
async fn npc_max(n: &Npc) -> Result<f64> { setting(&n.space, "npc.max").await }
fn the_text(m: &Json) -> String {
	let from = j::s(m, "from");
	let t = j::s(m, "text");
	t.strip_prefix(&format!("{from}: ")).unwrap_or(t).to_owned()
}
fn mind<'a>(n: &'a Npc, def: &'a Json, name: &'a str, w: &'a Json) -> Mind<'a> {
	let m = j::at(def, "model");
	Mind { npc_id: j::s(def, "npcId"), name, persona: j::s(m, "persona"), budget_day: j::n(m, "budgetDay"), world_id: { let _ = n; j::s(w, "id") } }
}

/// What a model NPC needs to act like a player (`surroundings`).
async fn surroundings(n: &Npc, me: &Json, s: &mut Situation) -> Result<()> {
	let w = n.w();
	let room = j::s(me, "room");
	s.carried = Some(n.space.read_all(&tmpl("Item", obj! { "location" => j::at(me, "charId").clone() }), None).await?.iter().map(|e| crate::fire::key_text(j::at(fields(e), "name"))).collect());
	s.things = Some(n.space.read_all(&tmpl("Item", obj! { "location" => room }), None).await?.iter().map(|e| { let f = fields(e); (crate::fire::key_text(j::at(f, "name")), j::n(f, "x"), j::n(f, "y")) }).collect());
	s.exits = Some(n.space.read_all(&tmpl("Exit", obj! { "location" => room }), None).await?.iter().map(|e| j::s(fields(e), "name").to_owned()).collect());
	s.offers = Some(n.space.read_all(&tmpl("Offer", obj! { "to" => j::at(me, "charId").clone() }), None).await?.iter().map(|e| {
		let o = fields(e);
		let gives: Vec<&str> = j::strs(j::a(o, "giveNames"));
		let want = j::a(o, "want");
		let wants = if want.is_empty() { " as a gift".to_owned() } else { format!(" for {}", want.iter().map(|w| format!("{}× {}", phi_json::number_text(j::n(w, "count")), j::s(w, "name"))).collect::<Vec<_>>().join(", ")) };
		let from = j::s(o, "fromName");
		format!("{from} offers {}{wants} (accept {from} / decline {from})", gives.join(", "))
	}).collect());
	if j::a(j::at(&w, "market"), "rooms").iter().any(|r| r.as_str() == Some(room)) {
		let mut l: Vec<Json> = n.space.read_all(&tmpl("Listing", obj! { "room" => room }), None).await?.iter().map(|e| fields(e).clone()).collect();
		l.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")).then_with(|| js::locale_compare(j::s(a, "listingId"), j::s(b, "listingId"))));
		s.board = Some(l.iter().enumerate().map(|(i, x)| { let c = j::no(x, "count").unwrap_or(1.0); format!("{}: {}{} for {} by {}", i + 1, if c > 1.0 { format!("{}× ", phi_json::number_text(c)) } else { String::new() }, j::s(x, "itemName"), phi_json::number_text(j::n(x, "price")), j::s(x, "sellerName")) }).collect());
	}
	s.me = Some((j::n(me, "x"), j::n(me, "y")));
	Ok(())
}

/// `actThenSay`: a model's lines: the commands first, then the words, and the words only when every command went
/// through; else it says that it did not work out.
async fn act_then_say(n: &Npc, lines: &[String]) -> Result<()> {
	let talk = |l: &str| js::re(r"^(say|sag|sage|emote|pose|geste|channel|kanal)\b", "i").test(l);
	let refusals = || async { Ok::<_, crate::space::Error>(n.space.read_all(&tmpl("Msg", obj! { "to" => n.char_id.as_str(), "kind" => "error" }), None).await?.len()) };
	let mut failed = false;
	for line in lines.iter().filter(|l| !talk(l)) {
		let before = refusals().await?;
		n.act(line).await?;
		if refusals().await? > before { failed = true; break; }
	}
	if failed { return n.act("say Hm, das klappt gerade nicht.").await; }
	for line in lines.iter().filter(|l| talk(l)) { n.act(line).await?; }
	Ok(())
}

/// `doRequests`: requests by name the script carries out (gather wood, feed the fire); the messages it answered.
async fn do_requests(n: &Npc, me: &Json, heard: &[Json]) -> Result<Vec<usize>> {
	let mut done = Vec::new();
	for (i, x) in heard.iter().enumerate() {
		let ask = request_of(&the_text(x), j::s(me, "name"));
		let count = match ask { Some(Request::Gather(k)) => k, Some(Request::Feed) => 0.0, _ => continue };
		gather(n, j::s(me, "charId"), j::s(x, "from"), count).await?;
		done.push(i);
	}
	Ok(done)
}

/// The beacon keeper (`waerter`): watches its fire, who comes and what is said; as a model role it answers with the
/// model while awake, else it says the script lines of Phase 2.
#[derive(Default)]
pub struct Waerter { state: Option<&'static str>, last_doze: Option<f64>, pensive: bool, budget_said: bool, heard: Heard, events: WorldEvents, present: Option<HashSet<String>>, offered: Option<HashSet<String>>, greeted: HashMap<String, f64> }

impl Waerter {
	async fn round(&mut self, n: &Npc) -> Result<()> {
		let Some(me) = self_of(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let w = n.w();
		let def = n.def();
		let wnow = n.now().await;
		let last_doze = *self.last_doze.get_or_insert(wnow);
		let mut events: Vec<String> = Vec::new();
		let beacon = j::a(&w, "beacons").iter().find(|b| j::at(b, "beaconId") == j::at(&def, "beacon")).cloned();
		let mut fire_text = None;
		if let Some(b) = &beacon {
			let f = crate::fire::flame_of(&n.space, j::s(b, "beaconId"), None).await?;
			let now = n.clock.now().await.unwrap_or(0.0);
			let piece = economy::min_fuel(&w) * n.clock.patience();
			let next = match &f { None => "out", Some(f) if j::n(f, "until") <= now => "out", Some(f) if j::n(f, "until") - now < piece * 1.5 => "low", _ => "ok" };
			if let Some(s) = self.state { if s != next { events.push(match next { "low" => "fire.low", "out" => "fire.out", _ => "fire.ok" }.into()); } }
			self.state = Some(next);
			fire_text = Some(burn_text(f.as_ref(), now));
		}
		let said = self.heard.since(n, &me).await?;
		let from_people: Vec<Json> = said.into_iter().filter(by_person).collect();
		let name = j::s(&me, "name").to_owned();
		if from_people.iter().any(|m| j::s(m, "text").to_lowercase().contains(&name.to_lowercase())) { events.push("spoken".into()); }
		let room = j::s(&me, "room").to_owned();
		let people = humans_in(n, &room).await?;
		if let Some(p) = &self.present { if people.iter().any(|x| !p.contains(x)) { events.push("person.enters".into()); } }
		self.present = Some(people.iter().cloned().collect());
		let offers: Vec<String> = n.space.read_all(&tmpl("Offer", obj! { "to" => j::at(&me, "charId").clone() }), None).await?.iter().map(|e| j::s(e, "id").to_owned()).collect();
		if let Some(o) = &self.offered { if offers.iter().any(|id| !o.contains(id)) { events.push("offer".into()); } }
		for kind in self.events.fresh(n).await? { events.push(kind); }
		self.offered = Some(offers.into_iter().collect());
		let m = j::at(&def, "model");
		if m.as_object().is_some() && llm_enabled() {
			let npc_id = j::s(&def, "npcId").to_owned();
			let wake_on: Vec<&str> = j::strs(j::a(m, "wake"));
			let wakes: Vec<String> = events.iter().filter(|e| wake_on.contains(&e.as_str()) || *e == "fire.ok").cloned().collect();
			let awake = minds::is_awake(&n.space, &n.clock, &npc_id).await?;
			let asked = do_requests(n, &me, &from_people).await?;
			if !asked.is_empty() && (0..from_people.len()).all(|i| asked.contains(&i)) {
				let _ = minds::keep_awake(&n.space, &n.clock, &npc_id, AWAKE_WORLD_MS).await;
				n.sleep(n.pace(3_000.0, 100.0)).await;
				return Ok(());
			}
			let rest: Vec<String> = from_people.iter().enumerate().filter(|(i, _)| !asked.contains(i)).map(|(_, x)| j::s(x, "text").to_owned()).collect();
			if !wakes.is_empty() || (awake && !rest.is_empty()) {
				if !awake && !minds::try_wake(&n.space, &n.clock, &npc_id, npc_max(n).await?, AWAKE_WORLD_MS).await? {
					if !self.pensive { self.pensive = true; n.act("emote ist in Gedanken.").await?; }
				} else {
					self.pensive = false;
					minds::keep_awake(&n.space, &n.clock, &npc_id, AWAKE_WORLD_MS).await?;
					let mut s = Situation { room: room_name(n, &room).await?, people: people.clone(), fire: fire_text.clone(), fire_at: beacon.as_ref().map(|b| (j::n(b, "x"), j::n(b, "y"))), event: if wakes.is_empty() { "talk".into() } else { wakes.join(", ") }, lang_en: from_people.last().is_some_and(|x| j::so(x, "lang").is_some()), heard: rest, ..Situation::default() };
					surroundings(n, &me, &mut s).await?;
					let r = minds::think(&n.space, &n.clock, &mind(n, &def, &name, &w), &s, &n.halt).await?;
					if n.halted() { return Ok(()); }
					match r {
						Thought::Budget => { if !self.budget_said { self.budget_said = true; n.act(&format!("emote {}", doze_line(&name, j::a(m, "dozing"), 0))).await?; } }
						Thought::Off => {}
						Thought::Lines { lines, note } => { self.budget_said = false; act_then_say(n, &lines).await?; if let Some(t) = note { minds::remember(&n.space, &npc_id, &t).await?; } }
					}
				}
			} else if !awake && !people.is_empty() && wnow - last_doze > 3.0 * 60_000.0 {
				self.last_doze = Some(wnow);
				let dozing = j::a(m, "dozing");
				n.act(&format!("emote {}", doze_line(&name, dozing, random_int(0.0, dozing.len().max(1) as f64) as usize))).await?;
			}
			n.sleep(n.pace(3_000.0, 100.0)).await;
			return Ok(());
		}
		// no model: the script of Phase 2
		let has = |e: &str| events.iter().any(|x| x == e);
		if has("fire.low") { n.act("say Das Feuer wird schwach – bringt Treibholz!").await?; }
		else if has("fire.out") { n.act("say Das Feuer ist aus! Ohne Licht frisst uns der Nebel.").await?; }
		else if has("fire.ok") { n.act("say Danke! So brennt es wieder.").await?; }
		else if has("evening") && !people.is_empty() { n.act("say Der Abend kommt: wer kann, bringe Holz für die Nacht.").await?; }
		let done = do_requests(n, &me, &from_people).await?;
		for (i, x) in from_people.iter().enumerate() {
			if done.contains(&i) { continue; }
			let from = j::s(x, "from").to_owned();
			if request_of(&the_text(x), &name).is_some_and(|a| a != Request::Greet) { n.act(&format!("say {}", unclear(&from))).await?; continue; }
			if !js::re(r"\b(hallo|hi|moin|hello|servus)\b", "i").test(j::s(x, "text")) { continue; }
			if wnow - self.greeted.get(&from).copied().unwrap_or(f64::NEG_INFINITY) < 10.0 * 60_000.0 { continue; }
			self.greeted.insert(from.clone(), wnow);
			n.act(&format!("say Willkommen am Feuer, {from}!")).await?;
		}
		n.sleep(n.pace(3_000.0, 100.0)).await;
		Ok(())
	}
}

/// A wanderer: away until its event (a room in dense fog for two game minutes), then it appears, at most once per its
/// cooldown; it speaks when people are there and goes when nobody spoke to it for its stay, or nobody is there.
#[derive(Default)]
pub struct Wanderer { dense_since: f64, last_spoken: f64, alone_since: f64, heard: Heard }

impl Wanderer {
	async fn round(&mut self, n: &Npc) -> Result<()> {
		let def = n.def();
		let wd = j::at(&def, "wanderer").clone();
		let now = n.now().await;
		let Some(me) = self_of(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let w = n.w();
		let npc_id = j::s(&def, "npcId").to_owned();
		let name = j::s(&me, "name").to_owned();
		if !n.is_online() {
			let dense = fog_of(&n.space, j::s(&def, "room")).await? >= j::n(j::at(&w, "fog"), "max");
			self.dense_since = if dense { if self.dense_since != 0.0 { self.dense_since } else { now } } else { 0.0 };
			let visit = n.space.peek(&tmpl("NpcVisit", obj! { "npcId" => npc_id.as_str() }), None).await?;
			let cool = visit.as_ref().is_none_or(|v| j::no(fields(v), "untilWorldMs").unwrap_or(0.0) <= now);
			if self.dense_since != 0.0 && now - self.dense_since >= 2.0 * 60_000.0 && cool {
				if let Some(v) = &visit { n.space.take_if_exists(&obj! { "type" => "NpcVisit", "id" => j::at(v, "id").clone() }, NO_WAIT, None).await?; }
				n.space.write(&tmpl("NpcVisit", obj! { "npcId" => npc_id.as_str(), "at" => now, "untilWorldMs" => now + j::n(&wd, "cooldownMs") }), None, FOREVER).await?;
				n.set_online(true).await?;
				self.last_spoken = now;
				self.alone_since = 0.0;
				self.heard.since(n, &me).await?; // what was said before he came is not for him
				if !humans_in(n, j::s(&def, "room")).await?.is_empty() { speak(n, &name, j::s(&wd, "event"), vec![], false).await?; }
			}
			n.sleep(n.pace(10_000.0, 100.0)).await;
			return Ok(());
		}
		let said: Vec<Json> = self.heard.since(n, &me).await?.into_iter().filter(by_person).collect();
		if said.iter().any(|x| js::re("fremd", "i").test(j::s(x, "text")) || j::s(x, "text").to_lowercase().contains(&name.to_lowercase())) {
			self.last_spoken = now;
			speak(n, &name, "spoken", said.iter().map(|x| j::s(x, "text").to_owned()).collect(), said.last().is_some_and(|x| j::so(x, "lang").is_some())).await?;
		}
		let people = humans_in(n, j::s(&me, "room")).await?;
		self.alone_since = if !people.is_empty() { 0.0 } else if self.alone_since != 0.0 { self.alone_since } else { now };
		if now - self.last_spoken >= j::n(&wd, "stayMs") || (self.alone_since != 0.0 && now - self.alone_since >= 2.0 * 60_000.0) {
			if !people.is_empty() { n.act("emote verschwindet im Nebel.").await?; }
			if j::at(&def, "model").as_object().is_some() { minds::put_to_sleep(&n.space, &npc_id).await?; }
			n.set_online(false).await?;
		}
		n.sleep(n.pace(3_000.0, 100.0)).await;
		Ok(())
	}
}

/// A wanderer's words: the model while it can be woken, else its script line.
async fn speak(n: &Npc, name: &str, event: &str, heard: Vec<String>, en: bool) -> Result<()> {
	let def = n.def();
	let w = n.w();
	let npc_id = j::s(&def, "npcId").to_owned();
	if j::at(&def, "model").as_object().is_some() && llm_enabled() && minds::try_wake(&n.space, &n.clock, &npc_id, npc_max(n).await?, AWAKE_WORLD_MS).await? {
		let me = self_of(n).await?;
		let room = me.as_ref().map_or_else(|| j::s(&def, "room").to_owned(), |m| j::s(m, "room").to_owned());
		let mut s = Situation { room: room_name(n, &room).await?, people: humans_in(n, &room).await?, event: event.to_owned(), heard, lang_en: en, ..Situation::default() };
		if let Some(me) = &me { surroundings(n, me, &mut s).await?; }
		let r = minds::think(&n.space, &n.clock, &mind(n, &def, name, &w), &s, &n.halt).await?;
		if n.halted() { return Ok(()); }
		if let Thought::Lines { lines, note } = r {
			act_then_say(n, &lines).await?;
			if let Some(t) = note { minds::remember(&n.space, &npc_id, &t).await?; }
			return Ok(());
		}
	}
	n.act(if event == "spoken" { "say Licht … wo brennt das nächste Licht?" } else { "say Wo geht es hier aus dem Nebel?" }).await
}

/// The ferryman: walks to the exit of his room that leads to another room of his route, takes it, rests, and goes back.
async fn faehrmann(n: &Npc) -> Result<()> {
	let Some(me) = self_of(n).await? else { n.sleep(1000.0).await; return Ok(()) };
	let def = n.def();
	let exits: Vec<Json> = n.space.read_all(&tmpl("Exit", obj! { "location" => j::at(&me, "room").clone() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	let route: Vec<&str> = j::strs(j::a(&def, "route"));
	let room = j::s(&me, "room");
	let exit = exits.iter().find(|x| route.contains(&j::s(x, "destination")) && j::s(x, "destination") != room).or(if route.is_empty() { exits.first() } else { None });
	let Some(exit) = exit else { n.sleep(n.pace(30_000.0, 50.0)).await; return Ok(()) };
	n.act(&format!("move {} {}", phi_json::number_text(j::n(exit, "x")), phi_json::number_text(j::n(exit, "y")))).await?;
	let after = self_of(n).await?;
	n.sleep(if after.is_some_and(|a| j::s(&a, "room") != room) { n.pace(30_000.0, 50.0) } else { n.pace(15_000.0, 50.0) }).await;
	Ok(())
}

/// A script with its state (`scriptFor`): a fresh one per claim.
pub enum Script { Waerter(Box<Waerter>), Faehrmann, Wanderer(Box<Wanderer>), Sammler(Box<Sammler>), Huter(Box<Huter>), Haendler(Box<Haendler>), Handwerker(Box<Handwerker>), Plauderer(Box<Plauderer>), Gaertnerin(Box<Gaertnerin>), Siedler(Box<Siedler>), Bauhelfer(Box<Bauhelfer>), Dorfbewohner(Box<Dorfbewohner>) }

impl Script {
	/// `scriptFor`: a fresh instance of the named script, or None.
	pub fn of(name: &str) -> Option<Script> {
		Some(match name {
			"waerter" => Script::Waerter(Box::default()),
			"faehrmann" => Script::Faehrmann,
			"wanderer" => Script::Wanderer(Box::default()),
			"sammler" => Script::Sammler(Box::default()),
			"huter" => Script::Huter(Box::default()),
			"haendler" => Script::Haendler(Box::default()),
			"handwerker" => Script::Handwerker(Box::default()),
			"plauderer" => Script::Plauderer(Box::default()),
			"gaertnerin" => Script::Gaertnerin(Box::default()),
			"siedler" => Script::Siedler(Box::default()),
			"bauhelfer" => Script::Bauhelfer(Box::default()),
			"dorfbewohner" => Script::Dorfbewohner(Box::default()),
			_ => return None,
		})
	}
	/// One round.
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		match self {
			Script::Waerter(s) => s.round(n).await,
			Script::Faehrmann => faehrmann(n).await,
			Script::Wanderer(s) => s.round(n).await,
			Script::Sammler(s) => s.round(n).await,
			Script::Huter(s) => s.round(n).await,
			Script::Haendler(s) => s.round(n).await,
			Script::Handwerker(s) => s.round(n).await,
			Script::Plauderer(s) => s.round(n).await,
			Script::Gaertnerin(s) => s.round(n).await,
			Script::Siedler(s) => s.round(n).await,
			Script::Bauhelfer(s) => s.round(n).await,
			Script::Dorfbewohner(s) => s.round(n).await,
		}
	}
}

/// `pick` of a definition's lines.
pub fn pick_line(def: &Json) -> Option<String> { pick(j::a(def, "lines")).and_then(|l| l.as_str().map(str::to_owned)) }
