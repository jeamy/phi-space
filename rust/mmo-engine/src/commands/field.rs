//! Fields (`server/engine/commands/field.ts`): one entry over a larger area on Plot cells, one crop at a time, sown with
//! seed and work points (`bestelle`) and brought in within its window, a work point each (`ernte` at the field, through
//! garden.rs); crop rotation tires the soil; `field_tick` (in the garden job) moves a field on when its date comes.
use phi_json::{obj, Json};

use super::build::{besides, cells, free_cells, give_back, human, light_for, no_article, plural, refusal, release_light, take_near, use_light, Rect, SITE_REACH};
use super::epoch::need_epoch;
use super::food::sated_factor;
use super::garden::grow_factor;
use super::settlement::need_rank;
use crate::clock::{decay_now_of, frozen_until, patience_of, world_now_of};
use crate::context::{inventory, msg, msg_transient, room_of, Ctx, MsgOpts};
use crate::fire::{fog_of, key_text};
use crate::j;
use crate::js;
use crate::settings::work_rest_ms;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn stage_name(s: &str) -> &'static str { match s { "brach" => "brach", "saat" => "wird bestellt", "waechst" => "wächst", "reif" => "reif", _ => "überreif" } }
fn field_def(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "fields") { Some(d) => Ok(d.clone()), None => refuse("In dieser Welt gibt es keine Äcker.") } }
/// `cropOf`.
pub fn crop_of<'a>(d: &'a Json, key: &Json) -> Option<&'a Json> { j::a(d, "crops").iter().find(|x| j::at(x, "key") == key) }
fn crop_named<'a>(d: &'a Json, said: &str) -> Option<&'a Json> {
	let n = no_article(&js::lower(js::trim(said)));
	j::a(d, "crops").iter().find(|x| j::s(x, "key") == n || js::lower(&txt(j::at(x, "name"))) == n || j::a(x, "aliases").iter().any(|a| a.as_str() == Some(n.as_str())))
}
/// `fieldName`.
pub fn field_name(f: &Json) -> String { format!("Acker von {}", txt(j::at(f, "ownerName"))) }
fn mine(c: &Ctx, f: &Json) -> bool { c.account.as_ref().is_some_and(|a| j::at(a, "accountId") == j::at(f, "accountId")) }
fn may_work(c: &Ctx, f: &Json) -> bool { mine(c, f) || j::b(f, "open") }
fn hours(ms: f64) -> String {
	let h = js::round(ms / 3_600_000.0);
	if h >= 1.0 { format!("{} {}", nt(h), if h == 1.0 { "Stunde" } else { "Stunden" }) } else { format!("{} Minuten", nt(1f64.max(js::round(ms / 60_000.0)))) }
}
fn crop_name(d: &Json, f: &Json) -> String { crop_of(d, j::at(f, "crop")).map_or_else(|| txt(j::at(f, "crop")), |x| txt(j::at(x, "name"))) }
fn proto_name(w: &Json, key: &str) -> String { j::by(j::a(w, "prototypes"), "key", key).map_or_else(|| key.to_owned(), |p| txt(j::at(p, "name"))) }

/// `soilFor`: how often the crop's group came in a row (a rest heals it) and the yield's factor.
pub fn soil_for(d: &Json, f: &Json, crop: &Json, now: f64) -> (f64, f64) {
	let tired = if j::at(f, "lastGroup") == j::at(crop, "group") && now - j::n(f, "lastHarvestWorldMs") < j::n(d, "fallowWorldMs") { j::n(f, "tired") + 1.0 } else { 0.0 };
	let t = j::a(d, "tired");
	let i = tired.min(t.len() as f64 - 1.0);
	(tired, if i >= 0.0 { t.get(i as usize).and_then(Json::as_f64).unwrap_or(1.0) } else { 1.0 })
}
/// `harvestOf`: what the whole harvest gives.
pub fn harvest_of(crop: &Json, cells: f64, factor: f64) -> Json { Json::Array(j::a(crop, "yields").iter().map(|y| obj! { "proto" => j::at(y, "proto").clone(), "count" => (cells * j::n(y, "perCell") * factor).floor() }).collect()) }
/// `shareOf`: the share of work point `i` of `need`; the shares add up to `total`.
pub fn share_of(total: f64, need: f64, i: f64) -> f64 { ((total * (i + 1.0)) / need).floor() - ((total * i) / need).floor() }

/// `fieldNear`: the field within SITE_REACH, taken in the transaction; None when there is none near.
async fn field_near(c: &Ctx) -> Result<Option<Json>> {
	match take_near(c, "Field", "fieldId", SITE_REACH, &|_| true).await? {
		Ok(f) => Ok(Some(f)),
		Err(true) => not_understood("Geh näher an den Acker heran (höchstens zwei Schritte entfernt)."),
		Err(false) => Ok(None),
	}
}
async fn field_here(c: &Ctx) -> Result<Json> {
	match field_near(c).await? { Some(f) => Ok(f), None => not_understood("Hier ist kein Acker. „flur anlegen“ legt eine an (mit einem Spaten, im Licht eines Feuers).") }
}
async fn write_field(c: &Ctx, f: &Json) -> Result<()> { c.space.write(&tmpl("Field", f.clone()), c.txn(), FOREVER).await?; Ok(()) }

/// `tire`: a work point costs the figure a rest, as at a site; refuses while it rests.
async fn tire(c: &Ctx, now: f64) -> Result<()> {
	let rest = c.space.peek(&tmpl("WorkRest", obj! { "charId" => c.char_id() }), None).await?;
	let until = rest.as_ref().map_or(0.0, |e| j::n(fields(e), "untilWorldMs"));
	if until > now { return refuse(format!("Du bist noch müde von der letzten Arbeit; in etwa {} Minuten wieder.", nt(1f64.max(js::round((until - now) / 60_000.0))))); }
	if let Some(r) = &rest { c.space.take_if_exists(&obj! { "id" => j::at(r, "id").clone() }, NO_WAIT, c.txn()).await?; }
	let ms = work_rest_ms(&c.space).await? / sated_factor(c, now).await?;
	c.space.write(&tmpl("WorkRest", obj! { "charId" => c.char_id(), "untilWorldMs" => now + ms }), c.txn(), FOREVER).await?;
	Ok(())
}
/// `credit`: counts a work point; NPCs and automata give at most half of them.
fn credit(c: &Ctx, f: &mut Json) -> Result<()> {
	if !human(c) {
		if j::n(f, "other") >= (j::n(f, "workNeed") / 2.0).floor() { return refuse("Diesen Acker bestellen Menschen; Helfer haben ihren Teil schon getan."); }
		let o = j::n(f, "other") + 1.0;
		j::set(f, "other", o);
	} else { let h = j::n(f, "human") + 1.0; j::set(f, "human", h); }
	let name = txt(j::at(&c.actor, "name"));
	let mut by = j::object(j::at(f, "by"));
	let k = by.get(&name).and_then(Json::as_f64).unwrap_or(0.0) + 1.0;
	by.insert(name, Json::from(k));
	j::set(f, "by", Json::Object(by));
	Ok(())
}
fn fresh(f: &Json) -> Json { let mut g = f.clone(); for (k, v) in [("work", Json::from(0.0)), ("workNeed", Json::from(0.0)), ("human", Json::from(0.0)), ("other", Json::from(0.0)), ("by", obj! {})] { j::set(&mut g, k, v); } g }
fn helpers(f: &Json) -> String {
	let mut by: Vec<(String, f64)> = j::entries(j::at(f, "by")).map(|(n, k)| (n.to_owned(), j::number(k))).collect();
	by.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
	by.iter().map(|(n, k)| format!("{n} ({})", nt(*k))).collect::<Vec<_>>().join(", ")
}

fn describe(d: &Json, f: &Json, now: f64) -> String {
	let crop = crop_name(d, f);
	let tired = j::n(f, "tired");
	let soil = if j::b(f, "lastGroup") && tired > 0.0 { format!("; der Boden ist müde ({}× {} hintereinander)", nt(tired + 1.0), txt(j::at(f, "lastGroup"))) } else if j::b(f, "lastGroup") { format!("; zuletzt {}", txt(j::at(f, "lastGroup"))) } else { String::new() };
	let stage = j::s(f, "stage");
	let what = match stage {
		"brach" => "liegt brach".to_owned(),
		"saat" => format!("wird mit {crop} bestellt: {}/{} Saatgut, {}/{} Arbeit", txt(j::at(f, "seeds")), txt(j::at(f, "seedNeed")), txt(j::at(f, "work")), txt(j::at(f, "workNeed"))),
		"waechst" => format!("{crop} wächst, reif in etwa {}", hours(j::n(f, "dueWorldMs") - now)),
		_ => format!("{crop} ist {}: Ernte {}/{}{}", stage_name(stage), txt(j::at(f, "work")), txt(j::at(f, "workNeed")), if stage == "spaet" { ", jeder Anteil verliert schon".to_owned() } else { format!(", noch etwa {}", hours(j::n(f, "dueWorldMs") - now)) }),
	};
	let grazed = if j::b(f, "grazed") && stage != "brach" { format!("; Rehe haben daran gefressen ({}×)", txt(j::at(f, "grazed"))) } else { String::new() };
	let dunged = if j::b(f, "dunged") && stage != "brach" { "; gedüngt" } else { "" };
	format!("{} ({}×{}{}{}): {what}{soil}{grazed}{dunged}.", field_name(f), txt(j::at(f, "w")), txt(j::at(f, "h")), if j::b(f, "open") { ", offen für alle" } else { "" }, if j::b(f, "fenced") { ", eingezäunt" } else { "" })
}

/// `around`: the rectangles that cover the cell, the one with its corner there first, then those shifted by the fewest.
pub fn around(x: f64, y: f64, w: f64, h: f64) -> Vec<Rect> {
	let mut out = Vec::new();
	let mut dy = 0.0;
	while dy < h { let mut dx = 0.0; while dx < w { out.push(Rect { x: x - dx, y: y - dy, w, h }); dx += 1.0; } dy += 1.0; }
	out.sort_by(|a, b| ((x - a.x) + (y - a.y)).partial_cmp(&((x - b.x) + (y - b.y))).unwrap_or(std::cmp::Ordering::Equal));
	out
}

/// `stake`: a field beside the actor (or at x y), on Plot cells in the light of a fire.
async fn stake(c: &mut Ctx, at: &str) -> Result<()> {
	let d = field_def(c)?;
	let Some(account) = c.account.clone().filter(|a| !j::b(a, "guest")) else { return refuse("Gäste helfen auf offenen Äckern mit, legen aber keine an; registriere dich dafür.") };
	if !human(c) { return refuse("Äcker legen nur Menschen an."); }
	need_epoch(c, j::no(&d, "epoch"), "Ein neuer Acker").await?;
	need_rank(c, "siedler", "Äcker anlegen").await?;
	if let Some(g) = j::opt(c.w(), "garden").cloned() {
		let spade = j::s(&g, "spade").to_owned();
		if !inventory(c).await?.iter().any(|i| j::s(fields(i), "proto") == spade) { return refuse(format!("Einen Acker bricht man mit einem Spaten um („craft {}“).", j::by(j::a(c.w(), "prototypes"), "key", &spade).map_or_else(|| spade.clone(), |p| js::lower(&txt(j::at(p, "name")))))); }
	}
	let max = j::n(&d, "maxFields");
	if c.space.count(&tmpl("Field", obj! { "accountId" => j::at(&account, "accountId").clone() }), None).await? >= max { return refuse(format!("Mehr als {} bestellt niemand allein.", plural(max, "Acker", "Äcker"))); }
	let points = j::n(&d, "points");
	let light = match light_for(c, points).await? { Ok(l) => l, Err(why) => return refuse(why.replacen("gebaut wird", "gepflügt wird", 1).replacen("Bau", "Acker", 1)) };
	let room = room_of(c, None).await?;
	let (fw, fh) = (j::n(&d, "w"), j::n(&d, "h"));
	let m = js::caps(&js::re(r"^(\d+)\s+(\d+)$", ""), js::trim(at));
	let cell = m.map(|m| (js::to_number(m[1].as_deref().unwrap_or("")), js::to_number(m[2].as_deref().unwrap_or(""))));
	let tries = match cell { Some((x, y)) if !(x == j::n(&c.actor, "x") && y == j::n(&c.actor, "y")) => around(x, y, fw, fh), _ => besides(c, fw, fh) };
	let (mut rect, mut why) = (None, String::new());
	for r in tries { match refusal(c, &room, r, false, true).await? { None => { rect = Some(r); break; } Some(n) => if why.is_empty() { why = n; } } }
	let Some(rect) = rect else { return refuse(format!("Hier passt kein Acker hin ({}×{}): {why}", nt(fw), nt(fh))) };
	let field_id = format!("field-{}", hex(&random_bytes(6)));
	let now = world_now_of(&c.space, c.txn()).await?;
	let room_id = j::s(&room, "roomId").to_owned();
	for p in cells(rect) {
		match c.space.write_unique(&tmpl("Plot", obj! { "room" => room_id.as_str(), "x" => p.0, "y" => p.1, "of" => field_id.as_str() }), c.txn(), FOREVER, &["room", "x", "y"]).await {
			Err(e) if e.to_string().contains("unique entry already exists") => return refuse("Dort hat gerade jemand anderes umgebrochen."),
			Err(e) => return Err(e),
			Ok(_) => {}
		}
	}
	use_light(c, &light, points).await?;
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(&d, "keepWorldMs");
	let f = obj! { "fieldId" => field_id.as_str(), "room" => room_id.as_str(), "x" => rect.x, "y" => rect.y, "w" => rect.w, "h" => rect.h, "owner" => c.char_id(), "ownerName" => j::at(&c.actor, "name").clone(), "accountId" => j::at(&account, "accountId").clone(), "beaconId" => light.beacon_id.as_str(), "points" => points,
		"stage" => "brach", "crop" => Json::Null, "seeds" => 0.0, "seedNeed" => 0.0, "work" => 0.0, "workNeed" => 0.0, "yields" => Json::Array(vec![]), "soil" => 1.0, "by" => obj! {}, "human" => 0.0, "other" => 0.0, "lastGroup" => Json::Null, "tired" => 0.0, "lastHarvestWorldMs" => 0.0,
		"dueWorldMs" => FOREVER, "untilWorldMs" => until, "at" => now };
	write_field(c, &f).await?;
	let crops = j::a(&d, "crops").iter().map(|x| txt(j::at(x, "name"))).collect::<Vec<_>>().join(", ");
	msg(c, "*", "info", &format!("{} bricht einen Acker um ({}×{}). „bestelle <frucht>“ sät darauf: {crops}.", txt(j::at(&c.actor, "name")), nt(rect.w), nt(rect.h)), MsgOpts::default()).await
}

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"flur" => flur(c, arg).await,
		"bestelle" => bestelle(c, arg).await,
		"dünge" => duenge(c).await,
		k => Err(Error::Other(format!("unported: field/{k}"))),
	}
}

async fn flur(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = field_def(c)?;
	let parts: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let word = parts.first().cloned().unwrap_or_default();
	let rest = parts.get(1..).unwrap_or(&[]).to_vec();
	let re = |p: &'static str| js::re(p, "i");
	if re(r"^(?:anlegen|neu|new|umbrechen|\d+)$").test(&word) { let at = if js::re(r"^\d+$", "").test(&word) { arg.to_owned() } else { rest.join(" ") }; return stake(c, &at).await; }
	let me = txt(j::at(&c.actor, "name"));
	if re(r"^(?:offen|öffnen|oeffnen|open|zu|schließen|schliessen|close)$").test(&word) {
		let f = field_here(c).await?;
		if !mine(c, &f) { return refuse(format!("Das ist der {}; öffnen und schließen darf nur, wer ihn angelegt hat.", field_name(&f))); }
		let open = re(r"^(?:offen|öffnen|oeffnen|open)$").test(&word);
		let g = if open { let mut g = f.clone(); j::set(&mut g, "open", true); g } else { j::without(&f, "open") };
		write_field(c, &g).await?;
		return msg(c, "*", "info", &if open { format!("{me} öffnet den Acker: säen und ernten darf jetzt jeder, und jeder behält seinen Anteil.") } else { format!("{me} schließt den Acker wieder für Fremde.") }, MsgOpts::default()).await;
	}
	if re(r"^(?:aufgeben|weg|remove)$").test(&word) {
		let f = field_here(c).await?;
		if !mine(c, &f) { return refuse(format!("Das ist der {}; aufgeben kann ihn nur, wer ihn angelegt hat.", field_name(&f))); }
		let txn = c.txn().unwrap_or("").to_owned();
		free_cells(&c.space, &txn, j::s(&f, "room"), j::at(&f, "fieldId")).await?;
		release_light(&c.space, &txn, j::at(&f, "beaconId"), j::n(&f, "points")).await?;
		return msg(c, "*", "info", &format!("{me} gibt den Acker auf; dort wächst wieder Gras."), MsgOpts::default()).await;
	}
	// "flur ansehen x y": the one field at that cell, else all of the room
	let at: Option<(f64, f64)> = if re(r"^(?:ansehen|look)$").test(&word) { match (rest.first(), rest.get(1)) { (Some(x), Some(y)) => Some((js::to_number(x), js::to_number(y))), _ => None } } else { None };
	let one = |f: &Json| at.is_none_or(|(x, y)| x >= j::n(f, "x") && y >= j::n(f, "y") && x < j::n(f, "x") + j::n(f, "w") && y < j::n(f, "y") + j::n(f, "h"));
	let all: Vec<Json> = c.space.read_all(&tmpl("Field", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|f| one(f)).collect();
	let mine_id = c.char_id().to_owned();
	if all.is_empty() { return msg(c, &mine_id, "info", "Hier ist kein Acker. Mit einem Spaten bricht „flur anlegen“ eine um (im Licht eines Feuers).", MsgOpts::default()).await; }
	let now = world_now_of(&c.space, c.txn()).await?;
	msg(c, &mine_id, "look", &all.iter().map(|f| describe(&d, f, now)).collect::<Vec<_>>().join("\n"), MsgOpts::default()).await
}

/// `bestelle`.
pub async fn bestelle(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = field_def(c)?;
	let said = js::re(r"^(?:mit\s+)?", "i").replace(js::trim(arg), "");
	let mut f = field_here(c).await?;
	if !may_work(c, &f) { return refuse(format!("Das ist der {}; bestellen darf ihn, wer ihn angelegt hat (oder jeder, wenn er offen ist).", field_name(&f))); }
	let now = world_now_of(&c.space, c.txn()).await?;
	let stage = j::s(&f, "stage").to_owned();
	if stage == "brach" {
		if !mine(c, &f) { return refuse("Was auf dem Acker wächst, wählt, wer sie angelegt hat."); }
		let Some(crop) = (if said.is_empty() { None } else { crop_named(&d, &said) }).cloned() else {
			let all = j::a(&d, "crops").iter().map(|x| format!("{} (Saatgut: {})", txt(j::at(x, "name")), proto_name(c.w(), j::s(x, "seed")))).collect::<Vec<_>>().join(", ");
			return not_understood(format!("Was säst du? {all}. Zum Beispiel: bestelle {}", j::a(&d, "crops").first().map_or_else(String::new, |x| js::lower(&txt(j::at(x, "name"))))));
		};
		let n = j::n(&f, "w") * j::n(&f, "h");
		f = fresh(&f);
		j::set(&mut f, "stage", "saat");
		j::set(&mut f, "crop", j::at(&crop, "key").clone());
		j::set(&mut f, "seeds", 0.0);
		j::set(&mut f, "seedNeed", (n / j::n(&d, "seedPerCells")).ceil());
		j::set(&mut f, "workNeed", (n / j::n(&d, "sowPerCells")).ceil());
	} else if stage != "saat" {
		return refuse(if stage == "waechst" { format!("Auf dem Acker wächst schon {}.", crop_name(&d, &f)) } else { format!("Der Acker ist {}; jetzt wird geerntet („ernte“).", stage_name(&stage)) });
	} else if !said.is_empty() && crop_named(&d, &said).map(|x| j::at(x, "key")) != Some(j::at(&f, "crop")) {
		return refuse(format!("Der Acker wird schon mit {} bestellt.", crop_name(&d, &f)));
	}
	let crop = crop_of(&d, j::at(&f, "crop")).cloned().unwrap_or(Json::Null);
	let seed_proto = txt(j::at(&crop, "seed"));
	// seed: what one carries of it, up to what is still missing
	let missing = 0f64.max(j::n(&f, "seedNeed") - j::n(&f, "seeds")) as usize;
	let seed: Vec<Json> = inventory(c).await?.into_iter().map(|i| fields(&i).clone()).filter(|i| j::s(i, "proto") == seed_proto && !j::b(i, "variety")).take(missing).collect();
	let me = c.char_id().to_owned();
	for it in &seed {
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(it, "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{} ist gerade nicht greifbar; bitte noch einmal.", txt(j::at(it, "name")))); }
	}
	let seeds = j::n(&f, "seeds") + seed.len() as f64;
	j::set(&mut f, "seeds", seeds);
	// a work point, unless the figure rests (bringing seed needs no rest)
	let mut worked = false;
	if j::n(&f, "work") < j::n(&f, "workNeed") {
		let r: Result<()> = async { tire(c, now).await?; credit(c, &mut f) }.await;
		match r {
			Ok(()) => { let w = j::n(&f, "work") + 1.0; j::set(&mut f, "work", w); worked = true; }
			Err(e) => if seed.is_empty() || !e.is_command() { return Err(e); },
		}
	}
	let seed_name = proto_name(c.w(), &seed_proto);
	if seed.is_empty() && !worked { return refuse(if j::n(&f, "seeds") < j::n(&f, "seedNeed") { format!("Es fehlt Saatgut: {} {seed_name}.", nt(j::n(&f, "seedNeed") - j::n(&f, "seeds"))) } else { "Die Arbeit ist getan.".to_owned() }); }
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(&d, "keepWorldMs");
	j::set(&mut f, "untilWorldMs", until);
	let done = j::n(&f, "seeds") >= j::n(&f, "seedNeed") && j::n(&f, "work") >= j::n(&f, "workNeed");
	if done {
		let (tired, factor) = soil_for(&d, &f, &crop, now);
		let helpers = helpers(&f);
		let fog = fog_of(&c.space, j::s(&f, "room")).await?;
		let mut g = fresh(&f);
		j::set(&mut g, "stage", "waechst");
		j::set(&mut g, "grazed", 0.0);
		j::set(&mut g, "soil", factor);
		j::set(&mut g, "tired", tired);
		j::set(&mut g, "yields", harvest_of(&crop, j::n(&f, "w") * j::n(&f, "h"), factor));
		j::set(&mut g, "dueWorldMs", now + j::n(&crop, "growWorldMs") * grow_factor(fog, false));
		write_field(c, &g).await?;
		return msg(c, "*", "world", &format!("Der {} ist mit {} bestellt ({helpers}). Reif in etwa {}{}.", field_name(&g), txt(j::at(&crop, "name")), hours(j::n(&g, "dueWorldMs") - now), if tired != 0.0 { "; der Boden ist müde und gibt weniger" } else { "" }), MsgOpts::default()).await;
	}
	write_field(c, &f).await?;
	let mut missing: Vec<String> = Vec::new();
	if j::n(&f, "seeds") < j::n(&f, "seedNeed") { missing.push(format!("{} {seed_name}", nt(j::n(&f, "seedNeed") - j::n(&f, "seeds")))); }
	if j::n(&f, "work") < j::n(&f, "workNeed") { missing.push(format!("{} Arbeit", nt(j::n(&f, "workNeed") - j::n(&f, "work")))); }
	msg(c, "*", "emote", &format!("{} {} den Acker{}; es fehlen noch {}.", txt(j::at(&c.actor, "name")), if worked { "pflügt" } else { "bringt Saatgut für" }, if seed.is_empty() { String::new() } else { format!(" ({} {seed_name})", seed.len()) }, missing.join(", ")), MsgOpts::default()).await
}

/// `harvestField`: `ernte` at a field: one work point and its share of the yield; the last brings the field in. False
/// when no field is near.
pub async fn harvest_field(c: &mut Ctx) -> Result<bool> {
	let Some(d) = j::opt(c.w(), "fields").cloned() else { return Ok(false) };
	let Some(mut f) = field_near(c).await? else { return Ok(false) };
	if !may_work(c, &f) { return refuse(format!("Das ist der {}; ernten darf ihn, wer ihn angelegt hat (oder jeder, wenn er offen ist).", field_name(&f))); }
	let crop = crop_of(&d, j::at(&f, "crop")).cloned();
	let now = world_now_of(&c.space, c.txn()).await?;
	let stage = j::s(&f, "stage").to_owned();
	if stage != "reif" && stage != "spaet" {
		return refuse(match stage.as_str() {
			"waechst" => format!("{} ist noch nicht reif; in etwa {}.", crop.as_ref().map_or_else(|| "Die Frucht".to_owned(), |x| txt(j::at(x, "name"))), hours(j::n(&f, "dueWorldMs") - now)),
			"saat" => "Der Acker wird erst bestellt („bestelle“).".to_owned(),
			_ => "Auf dem Acker wächst nichts; er liegt brach.".to_owned(),
		});
	}
	tire(c, now).await?;
	credit(c, &mut f)?;
	let i = j::n(&f, "work");
	j::set(&mut f, "work", i + 1.0);
	let late = stage == "spaet";
	let need = j::n(&f, "workNeed");
	let share: Vec<(String, f64)> = j::a(&f, "yields").iter().map(|y| { let n = share_of(j::n(y, "count"), need, i); (txt(j::at(y, "proto")), if late { n - js::round(n * j::n(&d, "lateLoss")) } else { n }) }).collect();
	let got = give_back(c, &share).await?;
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(&d, "keepWorldMs");
	j::set(&mut f, "untilWorldMs", until);
	let crop_word = crop.as_ref().map_or_else(|| "Ernte".to_owned(), |x| txt(j::at(x, "name")));
	if j::n(&f, "work") >= need {
		let helpers = helpers(&f);
		let mut g = fresh(&f);
		for (k, v) in [("stage", Json::from("brach")), ("crop", Json::Null), ("seeds", Json::from(0.0)), ("seedNeed", Json::from(0.0)), ("yields", Json::Array(vec![])), ("soil", Json::from(1.0)), ("dunged", Json::Bool(false)), ("lastGroup", crop.as_ref().map_or(Json::Null, |x| j::at(x, "group").clone())), ("lastHarvestWorldMs", Json::from(now)), ("dueWorldMs", Json::from(FOREVER))] { j::set(&mut g, k, v); }
		write_field(c, &g).await?;
		msg(c, "*", "world", &format!("Die {crop_word} des {} ist eingebracht! Geerntet haben {helpers}.", field_name(&f).replacen("Acker", "Ackers", 1)), MsgOpts::default()).await?;
	} else {
		write_field(c, &f).await?;
		msg(c, "*", "emote", &format!("{} erntet auf dem Acker ({}/{}): {}.", txt(j::at(&c.actor, "name")), txt(j::at(&f, "work")), txt(j::at(&f, "workNeed")), if got.is_empty() { "nichts mehr".to_owned() } else { got.join(", ") }), MsgOpts::default()).await?;
	}
	Ok(true)
}

/// `sowOnField`: `pflanze` of a field's crop sows at a field in this room, else says where it grows; false when `said`
/// is no crop.
pub async fn sow_on_field(c: &mut Ctx, said: &str) -> Result<bool> {
	let Some(d) = j::opt(c.w(), "fields").cloned() else { return Ok(false) };
	let w = c.world.clone();
	let seed_name = |x: &Json| proto_name(&w, j::s(x, "seed"));
	let Some(crop) = crop_named(&d, said).or_else(|| j::a(&d, "crops").iter().find(|x| js::lower(&seed_name(x)) == said)).cloned() else { return Ok(false) };
	if c.space.count(&tmpl("Field", obj! { "room" => c.room() }), None).await? != 0.0 { bestelle(c, j::s(&crop, "key")).await?; return Ok(true); }
	refuse(format!("{} wächst nicht im Beet, sondern auf einem Acker. Neben deinem Acker sät „bestelle {}“ ({}× {} als Saatgut). Einen Acker legt „flur anlegen“ an, mit einem Spaten, sobald die Insel ein Dorf ist.", txt(j::at(&crop, "name")), txt(j::at(&crop, "key")), nt((j::n(&d, "w") * j::n(&d, "h") / j::n(&d, "seedPerCells")).ceil()), seed_name(&crop)))
}

/// `dünge`: fertiliser on a growing field raises its harvest, once a crop.
async fn duenge(c: &mut Ctx) -> Result<()> {
	let d = field_def(c)?;
	let Some(dung) = j::opt(&d, "dung").cloned() else { return refuse("In dieser Welt düngt man nicht.") };
	let f = field_here(c).await?;
	if !may_work(c, &f) { return refuse(format!("Das ist der {}; düngen darf ihn, wer ihn angelegt hat (oder jeder, wenn er offen ist).", field_name(&f))); }
	let crop = crop_of(&d, j::at(&f, "crop")).map(|x| txt(j::at(x, "name")));
	match j::s(&f, "stage") {
		"waechst" => {}
		"brach" => return refuse("Auf dem Acker wächst nichts; gedüngt wird, während eine Frucht wächst."),
		"saat" => return refuse("Der Acker wird erst bestellt; gedüngt wird, wenn die Frucht wächst."),
		_ => return refuse(format!("{} ist schon reif; jetzt wird geerntet.", crop.clone().unwrap_or_else(|| "Die Frucht".into()))),
	}
	if j::b(&f, "dunged") { return refuse(format!("Der {} ist für diese Frucht schon gedüngt.", field_name(&f))); }
	let proto = txt(j::at(&dung, "proto"));
	let name = proto_name(c.w(), &proto);
	let count = j::n(&dung, "count");
	let have: Vec<Json> = inventory(c).await?.into_iter().map(|i| fields(&i).clone()).filter(|i| j::s(i, "proto") == proto).take(count.max(0.0) as usize).collect();
	if (have.len() as f64) < count { return refuse(format!("Zum Düngen brauchst du {} {name}; du trägst {}.", nt(count), have.len())); }
	let me = c.char_id().to_owned();
	for it in &have {
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(it, "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{} ist gerade nicht greifbar; bitte noch einmal.", txt(j::at(it, "name")))); }
	}
	let mut g = f.clone();
	j::set(&mut g, "dunged", true);
	let factor = j::n(&dung, "factor");
	j::set(&mut g, "yields", Json::Array(j::a(&f, "yields").iter().map(|y| { let mut y = y.clone(); let n = (j::n(&y, "count") * factor).ceil(); j::set(&mut y, "count", n); y }).collect()));
	write_field(c, &g).await?;
	msg(c, "*", "emote", &format!("{} streut {} {name} über den Acker; {} wird es danken.", txt(j::at(&c.actor, "name")), nt(count), crop.unwrap_or_else(|| "die Frucht".into())), MsgOpts::default()).await
}

async fn tell(space: &Space, lease_ms: f64, room: &str, text: &str, txn: &str) -> Result<()> {
	let m = obj! { "room" => room, "to" => "*", "kind" => "world", "text" => text, "from" => "", "at" => time_now() };
	space.write_with(&obj! { "type" => "Msg", "fields" => m }, Some(txn), lease_ms, msg_transient(space, "*", "world").await).await?;
	Ok(())
}

/// `fieldTick`: the fields whose date has come move on (in the garden job); one nobody worked for its time goes back to
/// grass. How many were written.
pub async fn field_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<f64> {
	let Some(d) = j::opt(w, "fields") else { return Ok(0.0) };
	let now = world_now_of(space, None).await?;
	let kept = decay_now_of(space, None).await?;
	let patient = patience_of(space, None).await?;
	let winter = frozen_until(space, now).await?;
	let mut written = 0.0;
	for e in space.read_all(&obj! { "type" => "Field" }, None).await? {
		let f0 = fields(&e);
		if j::n(f0, "dueWorldMs") > now && j::n(f0, "untilWorldMs") > kept { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(t) = space.take_if_exists(&tmpl("Field", obj! { "fieldId" => j::at(f0, "fieldId").clone() }), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
			let f = fields(&t).clone();
			let crop = crop_of(d, j::at(&f, "crop")).map_or_else(|| "Die Frucht".to_owned(), |x| txt(j::at(x, "name")));
			let room = j::s(&f, "room").to_owned();
			let with = |pairs: Vec<(&str, Json)>| { let mut g = f.clone(); for (k, v) in pairs { j::set(&mut g, k, v); } g };
			let stage = j::s(&f, "stage");
			if j::n(&f, "untilWorldMs") <= kept {
				free_cells(space, &txn, &room, j::at(&f, "fieldId")).await?;
				release_light(space, &txn, j::at(&f, "beaconId"), j::n(&f, "points")).await?;
				tell(space, lease_ms, &room, &format!("Der {} ist verwildert; dort wächst wieder Gras.", field_name(&f)), &txn).await?;
			} else if let Some(winter) = winter.filter(|_| stage != "brach") {
				space.write(&tmpl("Field", with(vec![("dueWorldMs", Json::from(winter))])), Some(&txn), FOREVER).await?; // it stands still until the spring
			} else if stage == "waechst" {
				let need = (j::n(&f, "w") * j::n(&f, "h") / j::n(d, "harvestPerCells")).ceil();
				space.write(&tmpl("Field", with(vec![("stage", Json::from("reif")), ("workNeed", Json::from(need)), ("dueWorldMs", Json::from(now + j::n(d, "windowWorldMs") * patient))])), Some(&txn), FOREVER).await?;
				tell(space, lease_ms, &room, &format!("{crop} auf dem {} ist reif: {} Hände-Stunden Ernte („ernte“ am Acker){}.", field_name(&f), nt(need), if j::b(&f, "open") { ", jeder darf mithelfen" } else { "" }), &txn).await?;
			} else if stage == "reif" {
				space.write(&tmpl("Field", with(vec![("stage", Json::from("spaet")), ("dueWorldMs", Json::from(now + j::n(d, "windowWorldMs") * patient))])), Some(&txn), FOREVER).await?;
				tell(space, lease_ms, &room, &format!("{crop} auf dem {} ist überreif; was jetzt noch geerntet wird, ist weniger.", field_name(&f)), &txn).await?;
			} else if stage == "spaet" {
				let mut g = fresh(&f);
				for (k, v) in [("stage", Json::from("brach")), ("crop", Json::Null), ("seeds", Json::from(0.0)), ("seedNeed", Json::from(0.0)), ("yields", Json::Array(vec![])), ("soil", Json::from(1.0)), ("dunged", Json::Bool(false)), ("lastGroup", crop_of(d, j::at(&f, "crop")).map_or(Json::Null, |x| j::at(x, "group").clone())), ("lastHarvestWorldMs", Json::from(now)), ("dueWorldMs", Json::from(FOREVER))] { j::set(&mut g, k, v); }
				space.write(&tmpl("Field", g), Some(&txn), FOREVER).await?;
				tell(space, lease_ms, &room, &format!("{crop} auf dem {} ist verdorben; der Acker liegt wieder brach.", field_name(&f)), &txn).await?;
			} else {
				space.write(&tmpl("Field", with(vec![("dueWorldMs", Json::from(FOREVER))])), Some(&txn), FOREVER).await?;
			}
			Ok(true)
		}.await;
		match r {
			Ok(true) => { space.commit(&txn).await?; written += 1.0; }
			Ok(false) => space.abort(&txn).await?,
			Err(e) => { let _ = space.abort(&txn).await; return Err(e); }
		}
	}
	Ok(written)
}
