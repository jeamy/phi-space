//! The town hall (`server/engine/commands/townhall.ts`): where one stands in a settlement, the settlers decide by vote:
//! closing or opening it, zones, the warehouse's tax, the demolition of a building, or plain words.
use phi_json::{obj, Json, Object};

use super::build::{dist_to, plan_of, Rect};
use super::settlement::{huts_in, rank_of, settlement_in};
use crate::clock::decay_now_of;
use crate::context::{msg, room_of, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::room_growth::rows;
use crate::source::{hex, random_bytes};
use crate::space::{fields, not_understood, refuse, tmpl, Result, Space, FOREVER};

/// `hallIn`.
pub async fn hall_in(space: &Space, w: &Json, room: &str, txn: Option<&str>) -> Result<bool> {
	let Some(t) = j::opt(w, "townhall") else { return Ok(false) };
	Ok(space.count(&tmpl("Building", obj! { "room" => room, "plan" => j::at(t, "plan").clone() }), txn).await? > 0.0)
}

fn is_in(p: (f64, f64), r: &Json) -> bool { p.0 >= j::n(r, "x") && p.1 >= j::n(r, "y") && p.0 < j::n(r, "x") + j::n(r, "w") && p.1 < j::n(r, "y") + j::n(r, "h") }

/// `zoneRefusal`: why the room's zones forbid `cells` (`green`: a bed or a green plan, which a green zone admits).
pub async fn zone_refusal(c: &Ctx, room: &str, cells: &[(f64, f64)], green: bool) -> Result<Option<String>> {
	if j::opt(c.w(), "townhall").is_none() { return Ok(None); }
	for e in c.space.read_all(&tmpl("Zone", obj! { "room" => room }), None).await? {
		let z = fields(&e);
		if j::s(z, "kind") == "gruen" && green { continue; }
		if cells.iter().any(|p| is_in(*p, z)) { return Ok(Some(if j::s(z, "kind") == "weg" { "Dort liegt ein Wegerecht; das bleibt frei." } else { "Das ist Grünzone; dort gehen nur Beete und Parks." }.into())); }
	}
	Ok(None)
}

/// `zonesLine`.
pub async fn zones_line(space: &Space, room: &str) -> Result<String> {
	let n = |z: &Json, k: &str| crate::fire::key_text(j::at(z, k));
	Ok(space.read_all(&tmpl("Zone", obj! { "room" => room }), None).await?.iter().map(|e| { let z = fields(e); format!("{} {}×{} ab Feld {}, {}", if j::s(z, "kind") == "weg" { "Wegerecht" } else { "Grünzone" }, n(z, "w"), n(z, "h"), n(z, "x"), n(z, "y")) }).collect::<Vec<_>>().join("; "))
}

fn what(kind: &str) -> Option<&'static str> { match kind { "zu" => Some("die Siedlung schließen"), "offen" => Some("die Siedlung öffnen"), "gruen" => Some("eine Grünzone"), "weg" => Some("ein Wegerecht"), "frei" => Some("die Zonen aufheben"), _ => None } }
/// `said`: a motion as it is told.
fn said(m: &Json) -> String {
	let n = |v: &Json, k: &str| key_text(j::at(v, k));
	if let Some(t) = j::opt(m, "target") { return format!("den Abriss der {} von {}", n(t, "name"), n(t, "ownerName")); }
	if j::s(m, "kind") == "steuer" { return format!("die Steuer auf {} Münzen je Stück aus dem Lager setzen", n(m, "tax")); }
	if let Some(w) = what(j::s(m, "kind")) { return format!("{w}{}", j::opt(m, "zone").map_or_else(String::new, |z| format!(" ({}×{} ab Feld {}, {})", n(z, "w"), n(z, "h"), n(z, "x"), n(z, "y")))); }
	format!("„{}“", n(m, "text"))
}
fn zone_word(word: &str) -> Option<&'static str> { match word { "grünzone" | "gruenzone" | "greenzone" => Some("gruen"), "wegerecht" | "right of way" => Some("weg"), "zone frei" => Some("frei"), _ => None } }
fn yes(votes: &[Json]) -> usize { votes.iter().filter(|v| j::truthy(j::at(v, "yes"))).count() }
fn no(votes: &[Json]) -> usize { votes.len() - yes(votes) }
async fn votes_on(space: &Space, motion_id: &Json) -> Result<Vec<Json>> { Ok(space.read_all(&tmpl("Vote", obj! { "motionId" => motion_id.clone() }), None).await?.iter().map(|e| fields(e).clone()).collect()) }

/// `ofSettler`: the settlement here for a settler of it.
async fn of_settler(c: &Ctx, doing: &str) -> Result<Json> {
	let Some(s) = settlement_in(&c.space, c.room(), c.txn()).await? else { return refuse("Hier ist keine Siedlung.") };
	if rank_of(&s, &huts_in(&c.space, c.w(), j::s(&s, "room"), c.txn()).await?, c.account.as_ref()) != "siedler" { return refuse(format!("{doing} dürfen die Siedler von {}.", key_text(j::at(&s, "name")))); }
	Ok(s)
}

/// `zoneAt`: the area of a zone around the actor, cut at the room's edge; "frei" is the actor's own cell.
async fn zone_at(c: &Ctx, kind: &str, radius: f64) -> Result<Json> {
	let (x, y) = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	if kind == "frei" { return Ok(obj! { "x" => x, "y" => y, "w" => 1.0, "h" => 1.0 }); }
	let ground = rows(j::at(&room_of(c, None).await?, "ground"));
	let right = (ground.first().map_or(0, |r| js::len16(r)) as f64 - 1.0).min(x + radius);
	let bottom = (ground.len() as f64 - 1.0).min(y + radius);
	let (left, top) = (0f64.max(x - radius), 0f64.max(y - radius));
	Ok(obj! { "x" => left, "y" => top, "w" => right - left + 1.0, "h" => bottom - top + 1.0 })
}

/// `holdsGoods`: what a settlement laid in is not an estate of the owner's.
pub async fn holds_goods(space: &Space, w: &Json, b: &Json) -> Result<bool> {
	Ok(plan_of(w, j::s(b, "plan")).is_some_and(|p| j::truthy(j::at(p, "store"))) && space.count(&tmpl("Item", obj! { "location" => j::at(b, "buildId").clone() }), None).await? > 0.0)
}

/// `condemned`: the one building beside the actor that a vote may take down.
async fn condemned(c: &Ctx, room: &str, hall: &str) -> Result<Json> {
	let at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let beside: Vec<Json> = c.space.read_all(&tmpl("Building", obj! { "room" => room }), c.txn()).await?.iter().map(|e| fields(e).clone()).filter(|b| dist_to(at, Rect::of(b)) <= 1.0).collect();
	if beside.is_empty() { return refuse("Stell dich neben den Bau, über dessen Abriss abgestimmt werden soll."); }
	if beside.len() > 1 { return refuse(format!("Hier stehen mehrere Bauten nebeneinander ({}); stell dich so, dass nur einer neben dir steht.", beside.iter().map(|b| key_text(j::at(b, "name"))).collect::<Vec<_>>().join(", "))); }
	let b = &beside[0];
	if j::s(b, "plan") == hall { return refuse("Das Rathaus reißt kein Beschluss ab."); }
	if holds_goods(&c.space, c.w(), b).await? { return refuse("Im Lager liegt noch, was der Siedlung gehört. Erst wenn es leer ist, lässt sich darüber abstimmen."); }
	Ok(obj! { "buildId" => j::at(b, "buildId").clone(), "name" => j::at(b, "name").clone(), "ownerName" => j::at(b, "ownerName").clone() })
}

/// `antrag`.
pub async fn antrag(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(d) = j::opt(c.w(), "townhall").cloned() else { return refuse("In dieser Welt gibt es keine Rathäuser.") };
	let text = js::re(r"\s+", "g").replace(js::trim(arg), " ");
	let me = c.char_id().to_owned();
	let open = c.space.peek(&tmpl("Motion", obj! { "room" => c.room() }), c.txn()).await?;
	if text.is_empty() {
		let Some(open) = open else { return msg(c, &me, "info", "Hier läuft kein Antrag.", MsgOpts::default()).await };
		let m = fields(&open).clone();
		let votes = votes_on(&c.space, j::at(&m, "motionId")).await?;
		return msg(c, &me, "info", &format!("{} beantragt: {}. Bisher {} dafür, {} dagegen.", key_text(j::at(&m, "byName")), said(&m), yes(&votes), no(&votes)), MsgOpts::default()).await;
	}
	let word = text.to_lowercase();
	let zone = zone_word(&word);
	let plan = j::s(&d, "plan").to_owned();
	let halls: Vec<Json> = c.space.read_all(&tmpl("Building", obj! { "room" => c.room(), "plan" => plan.as_str() }), c.txn()).await?.iter().map(|e| fields(e).clone()).collect();
	let down = js::re(r"^(?:abriss|abreißen|abreissen|demolish)$", "").test(&word);
	if (zone.is_some() || down) && halls.is_empty() { return refuse(format!("{} ein Rathaus; hier steht keines.", if zone.is_some() { "Zonen setzt" } else { "Einen Abriss beschließt" })); }
	let at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	if zone.is_none() && !down && !halls.iter().any(|b| dist_to(at, Rect::of(b)) <= 1.0) { return refuse(format!("Anträge stellt man direkt neben {}.", plan_of(c.w(), &plan).and_then(|p| j::so(p, "dative")).unwrap_or("einem Rathaus"))); }
	let s = of_settler(c, "Anträge stellen").await?;
	let taxed = js::caps(&js::re(r"^steuer\s+(\d+)$", "i"), &text).map(|m| js::to_number(m[1].as_deref().unwrap_or("")));
	if taxed.is_some_and(|t| t > j::n(&d, "maxTax")) { return refuse(format!("Mehr als {} Münzen je Stück trägt kein Lager.", key_text(j::at(&d, "maxTax")))); }
	if open.is_some() { return refuse("Hier läuft schon ein Antrag; erst wenn er entschieden ist, kommt der nächste."); }
	let target = if down { Some(condemned(c, j::s(&s, "room"), &plan).await?) } else { None };
	let kind = if down { "abriss" } else if taxed.is_some() { "steuer" } else if let Some(z) = zone { z } else if js::re(r"^(?:zu|schließen|schliessen|close)$", "i").test(&text) { "zu" } else if js::re(r"^(?:offen|auf|öffnen|oeffnen|open)$", "i").test(&text) { "offen" } else { "text" };
	if kind == "text" && js::len16(&text) > 120 { return not_understood("Ein Antrag hat höchstens 120 Zeichen."); }
	if (kind == "zu" || kind == "offen") && j::b(&s, "closed") == (kind == "zu") { return refuse(format!("{} ist schon {}.", key_text(j::at(&s, "name")), if j::b(&s, "closed") { "geschlossen" } else { "offen" })); }
	let mut m = Object::new();
	m.insert("motionId", Json::from(hex(&random_bytes(6))));
	m.insert("room", j::at(&s, "room").clone());
	m.insert("settlementId", j::at(&s, "settlementId").clone());
	m.insert("settlementName", j::at(&s, "name").clone());
	m.insert("by", c.account.as_ref().map_or(Json::Null, |a| j::at(a, "accountId").clone()));
	m.insert("byName", j::at(&c.actor, "name").clone());
	m.insert("kind", Json::from(kind));
	m.insert("text", Json::from(if kind == "text" { text.as_str() } else { "" }));
	m.insert("endsWorldMs", Json::from(decay_now_of(&c.space, c.txn()).await? + j::n(&d, "voteWorldMs")));
	if let Some(z) = zone { m.insert("zone", zone_at(c, z, j::n(&d, "zoneRadius")).await?); }
	if let Some(t) = taxed { m.insert("tax", Json::from(t)); }
	if let Some(t) = target { m.insert("target", t); }
	let m = Json::Object(m);
	match c.space.write_unique(&tmpl("Motion", m.clone()), c.txn(), FOREVER, &["room"]).await {
		Err(e) if e.to_string().contains("unique entry already exists") => return refuse("Hier läuft schon ein Antrag; erst wenn er entschieden ist, kommt der nächste."),
		Err(e) => return Err(e),
		Ok(_) => {}
	}
	c.space.write(&tmpl("Vote", obj! { "motionId" => j::at(&m, "motionId").clone(), "accountId" => j::at(&m, "by").clone(), "yes" => true }), c.txn(), FOREVER).await?;
	msg(c, "*", "world", &format!("{} beantragt im Rathaus von {}: {}. Die Siedler stimmen einen Tag lang ab („stimme ja“ oder „stimme nein“).", key_text(j::at(&c.actor, "name")), key_text(j::at(&s, "name")), said(&m)), MsgOpts::default()).await
}

/// `stimme`.
pub async fn stimme(c: &mut Ctx, arg: &str) -> Result<()> {
	let w = js::trim(arg).to_lowercase();
	let ja = js::re(r"^(?:ja|yes|dafür|dafuer)$", "").test(&w);
	let nein = js::re(r"^(?:nein|no|dagegen)$", "").test(&w);
	if !ja && !nein { return not_understood("So stimmst du ab: stimme ja, oder stimme nein."); }
	let s = of_settler(c, "Abstimmen").await?;
	let Some(e) = c.space.peek(&tmpl("Motion", obj! { "room" => j::at(&s, "room").clone() }), c.txn()).await? else { return refuse("Hier läuft kein Antrag.") };
	let motion_id = j::at(fields(&e), "motionId").clone();
	let account_id = c.account.as_ref().map_or(Json::Null, |a| j::at(a, "accountId").clone());
	let mine = obj! { "motionId" => motion_id.clone(), "accountId" => account_id.clone(), "yes" => ja };
	c.space.take_if_exists(&tmpl("Vote", obj! { "motionId" => motion_id.clone(), "accountId" => account_id.clone() }), 5_000.0, c.txn()).await?;
	c.space.write(&tmpl("Vote", mine.clone()), c.txn(), FOREVER).await?;
	let mut votes: Vec<Json> = votes_on(&c.space, &motion_id).await?.into_iter().filter(|v| j::at(v, "accountId") != &account_id).collect();
	votes.push(mine);
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("Deine Stimme zählt: {}. Bisher {} dafür, {} dagegen.", if ja { "dafür" } else { "dagegen" }, yes(&votes), no(&votes)), MsgOpts::default()).await
}
