//! Settlements (`server/engine/commands/settlement.ts`): enough huts of more than one owner in a room may found a
//! settlement, a name, members and rules on one entry per room; it lasts while its huts do.
use phi_json::{obj, Json};

use super::townhall::{hall_in, zones_line};
use crate::clock::decay_now_of;
use crate::context::{msg, msg_transient, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Result, Space, FOREVER, NO_WAIT};

/// `settlementIn`.
pub async fn settlement_in(space: &Space, room: &str, txn: Option<&str>) -> Result<Option<Json>> {
	Ok(space.peek(&tmpl("Settlement", obj! { "room" => room }), txn).await?.map(|e| fields(&e).clone()))
}

/// `hutsIn`: the huts of a room (the settlement's plan).
pub async fn huts_in(space: &Space, w: &Json, room: &str, txn: Option<&str>) -> Result<Vec<Json>> {
	let plan = j::s(j::at(w, "settlement"), "plan");
	Ok(space.read_all(&tmpl("Building", obj! { "room" => room, "plan" => plan }), txn).await?.iter().map(|e| fields(e).clone()).collect())
}

/// `enoughHuts`.
pub fn enough_huts(w: &Json, huts: &[Json]) -> bool {
	let Some(s) = j::opt(w, "settlement") else { return false };
	let owners: std::collections::HashSet<String> = huts.iter().map(|h| crate::fire::key_text(j::at(h, "accountId"))).collect();
	huts.len() as f64 >= j::n(s, "huts") && owners.len() as f64 >= j::n(s, "owners")
}

const ORDER: [&str; 3] = ["fremder", "helfer", "siedler"];
fn rank_name(r: &str) -> &'static str { match r { "helfer" => "Helfer", "siedler" => "Siedler", _ => "Fremder" } }

/// `rankOf`: a hut here makes a settler, a guest is a helper at most.
pub fn rank_of(s: &Json, huts: &[Json], account: Option<&Json>) -> String {
	let Some(a) = account else { return "fremder".into() };
	let id = j::at(a, "accountId");
	let r = if huts.iter().any(|h| j::at(h, "accountId") == id) { "siedler".to_owned() } else { j::a(s, "members").iter().find(|m| j::at(m, "accountId") == id).and_then(|m| j::so(m, "rank")).unwrap_or("fremder").to_owned() };
	if j::b(a, "guest") && r == "siedler" { "helfer".into() } else { r }
}

/// `needRank`: in a closed settlement, refuses unless the actor has at least `need`.
pub async fn need_rank(c: &Ctx, need: &str, what: &str) -> Result<()> {
	if j::opt(c.w(), "settlement").is_none() { return Ok(()); }
	let Some(s) = settlement_in(&c.space, c.room(), c.txn()).await? else { return Ok(()) };
	if !j::b(&s, "closed") { return Ok(()); }
	let have = rank_of(&s, &huts_in(&c.space, c.w(), j::s(&s, "room"), c.txn()).await?, c.account.as_ref());
	let idx = |r: &str| ORDER.iter().position(|x| *x == r).map_or(-1, |i| i as i32);
	if idx(&have) < idx(need) {
		return refuse(format!("{} ist geschlossen: {what} dürfen hier nur {}. Du bist {}; ein Siedler kann dich aufnehmen.", crate::fire::key_text(j::at(&s, "name")), if need == "siedler" { "Siedler" } else { "Helfer und Siedler" }, rank_name(&have)));
	}
	Ok(())
}

/// `settlementTick`: the settlements whose huts are too few now go, their name and zones with them. How many.
pub async fn settlement_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<f64> {
	if j::opt(w, "settlement").is_none() { return Ok(0.0); }
	let mut gone = 0.0;
	for e in space.read_all(&obj! { "type" => "Settlement" }, None).await? {
		let s = fields(&e).clone();
		if enough_huts(w, &huts_in(space, w, j::s(&s, "room"), None).await?) { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			if space.take_if_exists(&tmpl("Settlement", obj! { "settlementId" => j::at(&s, "settlementId").clone() }), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); }
			space.take_if_exists(&tmpl("SettlementName", obj! { "nameKey" => j::at(&s, "nameKey").clone() }), NO_WAIT, Some(&txn)).await?;
			for z in space.read_all(&tmpl("Zone", obj! { "room" => j::at(&s, "room").clone() }), None).await? { space.take_if_exists(&obj! { "id" => j::at(&z, "id").clone() }, NO_WAIT, Some(&txn)).await?; }
			let m = obj! { "room" => j::at(&s, "room").clone(), "to" => "*", "kind" => "world", "text" => format!("{} gibt es nicht mehr: zu wenige Hütten stehen noch. Was hier steht, bleibt.", key_text(j::at(&s, "name"))), "from" => "", "at" => time_now() };
			space.write_with(&obj! { "type" => "Msg", "fields" => m }, Some(&txn), lease_ms, msg_transient(space, "*", "world").await).await?;
			Ok(true)
		}.await;
		match r { Ok(true) => { space.commit(&txn).await?; gone += 1.0; } Ok(false) => space.abort(&txn).await?, Err(err) => { let _ = space.abort(&txn).await; return Err(err); } }
	}
	Ok(gone)
}

fn def_of(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "settlement") { Some(d) => Ok(d.clone()), None => refuse("In dieser Welt gibt es keine Siedlungen.") } }
fn name_key(name: &str) -> String { js::re(r"\s+", "g").replace(&js::trim(name).to_lowercase(), " ") }

async fn found(c: &mut Ctx, name: &str) -> Result<()> {
	let d = def_of(c)?;
	let n = js::re(r"\s+", "g").replace(js::trim(name), " ");
	let Some(account) = c.account.clone().filter(|a| !j::b(a, "guest")) else { return refuse("Gäste gründen keine Siedlung; registriere dich dafür.") };
	if !js::re(r"^[\p{L}][\p{L} '-]{1,29}$", "u").test(&n) { return not_understood("So gründest du eine: siedlung gründen <name> (2 bis 30 Buchstaben)."); }
	let huts = huts_in(&c.space, c.w(), c.room(), c.txn()).await?;
	if !huts.iter().any(|h| j::at(h, "accountId") == j::at(&account, "accountId")) { return refuse("Eine Siedlung gründet, wer hier eine Hütte hat."); }
	if !enough_huts(c.w(), &huts) { return refuse(format!("Für eine Siedlung braucht es {} Hütten von mindestens {} Besitzern in einem Raum; hier stehen {}.", key_text(j::at(&d, "huts")), key_text(j::at(&d, "owners")), huts.len())); }
	let s = obj! { "settlementId" => hex(&random_bytes(6)), "name" => n.as_str(), "nameKey" => name_key(&n), "room" => c.room(), "founder" => j::at(&account, "accountId").clone(), "founderName" => j::at(&c.actor, "name").clone(), "members" => Json::Array(vec![]), "closed" => false, "at" => time_now() };
	let r = async {
		c.space.write_unique(&tmpl("Settlement", s.clone()), c.txn(), FOREVER, &["room"]).await?;
		c.space.write_unique(&tmpl("SettlementName", obj! { "nameKey" => j::at(&s, "nameKey").clone() }), c.txn(), FOREVER, &["nameKey"]).await
	}.await;
	match r { Err(e) if e.to_string().contains("unique entry already exists") => return refuse("Hier gibt es schon eine Siedlung, oder der Name ist vergeben."), Err(e) => return Err(e), Ok(_) => {} }
	msg(c, "*", "world", &format!("{} gründet die Siedlung {n}! Wer hier eine Hütte hat, ist Siedler.", key_text(j::at(&c.actor, "name"))), MsgOpts::default()).await
}

/// `manage`: the settlement here, taken in the transaction, for a settler of it.
async fn manage(c: &Ctx) -> Result<Json> {
	def_of(c)?;
	let Some(e) = c.space.take_if_exists(&tmpl("Settlement", obj! { "room" => c.room() }), 5_000.0, c.txn()).await? else { return refuse("Hier ist keine Siedlung. „siedlung gründen <name>“ gründet eine.") };
	let s = fields(&e).clone();
	if rank_of(&s, &huts_in(&c.space, c.w(), j::s(&s, "room"), c.txn()).await?, c.account.as_ref()) != "siedler" { return refuse(format!("Das entscheiden die Siedler von {}.", key_text(j::at(&s, "name")))); }
	Ok(s)
}
async fn put(c: &Ctx, s: Json) -> Result<()> { c.space.write(&tmpl("Settlement", s), c.txn(), FOREVER).await?; Ok(()) }
fn with(s: &Json, k: &str, v: Json) -> Json { let mut o = j::object(s); o.insert(k, v); Json::Object(o) }

/// `tendersIn` (festival.ts): who tended the park of a room lately.
pub async fn tenders_in(space: &Space, w: &Json, room: &str, now: f64) -> Result<f64> {
	let Some(d) = j::opt(w, "festival") else { return Ok(0.0) };
	Ok(space.read_all(&tmpl("ParkCare", obj! { "room" => room }), None).await?.iter().filter(|e| j::n(fields(e), "lastWorldMs") + j::n(d, "tendedWorldMs") > now).count() as f64)
}

/// A settlement in the rank: its name, points, parks and who tended them.
pub struct Ranked { pub name: String, pub points: f64, pub parks: f64, pub tenders: f64 }
/// `settlementRanks`: the settlements of this space, the best first.
pub async fn settlement_ranks(space: &Space, w: &Json) -> Result<Vec<Ranked>> {
	let buildings: Vec<Json> = space.read_all(&obj! { "type" => "Building" }, None).await?.iter().map(|e| fields(e).clone()).collect();
	let now = decay_now_of(space, None).await?;
	let per = j::no(j::at(w, "shop"), "turnoverPerPoint").unwrap_or(1.0);
	let mut out = Vec::new();
	for e in space.read_all(&obj! { "type" => "Settlement" }, None).await? {
		let s = fields(&e);
		let here: Vec<&Json> = buildings.iter().filter(|b| j::at(b, "room") == j::at(s, "room")).collect();
		let tenders = tenders_in(space, w, j::s(s, "room"), now).await?;
		let points = here.iter().fold(0.0, |n, b| n + j::no(b, "points").unwrap_or(1.0) + (j::no(b, "turnover").unwrap_or(0.0) / per).floor()) + tenders;
		out.push(Ranked { name: key_text(j::at(s, "name")), points, parks: here.iter().filter(|b| j::s(b, "plan") == "park").count() as f64, tenders });
	}
	out.sort_by(|a, b| { let d = b.points - a.points; if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal) } else { js::locale_compare(&a.name, &b.name) } });
	Ok(out)
}

/// `siedlung`.
pub async fn siedlung(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = def_of(c)?;
	let words: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let word = words.first().cloned().unwrap_or_default();
	let tail = words.iter().skip(1).cloned().collect::<Vec<_>>().join(" ");
	let me = c.char_id().to_owned();
	let actor = key_text(j::at(&c.actor, "name"));
	let nt = phi_json::number_text;
	if js::re(r"^(?:gründen|gruenden|gründe|gruende|found)$", "i").test(&word) { return found(c, &tail).await; }
	if js::re(r"^(?:rang|rangliste|rank)$", "i").test(&word) {
		let ranks = settlement_ranks(&c.space, c.w()).await?;
		let text = if ranks.is_empty() { "In dieser Gegend gibt es noch keine Siedlung.".to_owned() } else {
			format!("Die Siedlungen dieser Gegend: {}.", ranks.iter().enumerate().map(|(i, r)| format!("{}. {}, {} Punkte{}", i + 1, r.name, nt(r.points), if r.parks > 0.0 { format!(" ({}{})", if r.parks == 1.0 { "ein Park".to_owned() } else { format!("{} Parks", nt(r.parks)) }, if r.tenders > 0.0 { format!(", gepflegt von {}", nt(r.tenders)) } else { String::new() }) } else { String::new() })).collect::<Vec<_>>().join("; "))
		};
		return msg(c, &me, "info", &text, MsgOpts::default()).await;
	}
	if js::re(r"^(?:zu|schließen|schliessen|close)$", "i").test(&word) || js::re(r"^(?:offen|auf|öffnen|oeffnen|open)$", "i").test(&word) {
		let s = manage(c).await?;
		let closed = js::re(r"^(?:zu|schl|close)", "i").test(&word);
		let name = key_text(j::at(&s, "name"));
		if hall_in(&c.space, c.w(), j::s(&s, "room"), c.txn()).await? { return refuse(format!("In {name} entscheidet das Rathaus: „antrag {}“ stellt es zur Abstimmung.", if closed { "zu" } else { "offen" })); }
		put(c, with(&s, "closed", Json::Bool(closed))).await?;
		return msg(c, "*", "info", &if closed { format!("{actor} schließt {name}: bauen dürfen hier nur noch Siedler, liefern und arbeiten auch Helfer.") } else { format!("{actor} öffnet {name}: hier darf wieder jeder bauen und helfen.") }, MsgOpts::default()).await;
	}
	if js::re(r"^(?:aufnehmen|nimm|nehme|add)$", "i").test(&word) {
		let Some(m) = js::caps(&js::re(r"^(.+?)(?:\s+als)?(?:\s+(helfer|siedler))?$", "i"), &js::re(r"\s+auf$", "i").replace(&tail, "")) else { return not_understood("So nimmst du jemanden auf: siedlung aufnehmen <name> [helfer].") };
		let s = manage(c).await?;
		let wanted = m[1].clone().unwrap_or_default();
		let who = c.space.read_all(&obj! { "type" => "Character" }, None).await?.into_iter().map(|e| fields(&e).clone()).find(|x| j::s(x, "name").to_lowercase() == wanted.to_lowercase());
		let Some(who) = who else { return refuse(format!("Eine Figur „{}“ ist hier nicht bekannt.", js::slice16(&wanted, 0, Some(30)))) };
		let rank = if j::b(&who, "guest") || m[2].as_deref().map(str::to_lowercase).as_deref() == Some("helfer") { "helfer" } else { "siedler" };
		let mut members: Vec<Json> = j::a(&s, "members").iter().filter(|x| j::at(x, "accountId") != j::at(&who, "accountId")).cloned().collect();
		members.push(obj! { "accountId" => j::at(&who, "accountId").clone(), "name" => j::at(&who, "name").clone(), "rank" => rank });
		put(c, with(&s, "members", Json::Array(members))).await?;
		return msg(c, "*", "info", &format!("{actor} nimmt {} als {} in {} auf.", key_text(j::at(&who, "name")), rank_name(rank), key_text(j::at(&s, "name"))), MsgOpts::default()).await;
	}
	if js::re(r"^(?:entlassen|entlasse|remove)$", "i").test(&word) {
		let s = manage(c).await?;
		let all = j::a(&s, "members");
		let left: Vec<Json> = all.iter().filter(|x| j::s(x, "name").to_lowercase() != tail.to_lowercase()).cloned().collect();
		let same = left.len() == all.len();
		put(c, with(&s, "members", Json::Array(left))).await?;
		if same { return refuse(format!("{} ist nicht aufgenommen (Hüttenbesitzer sind von selbst Siedler).", js::slice16(&tail, 0, Some(30)))); }
		return msg(c, "*", "info", &format!("{actor} entlässt {tail} aus {}.", key_text(j::at(&s, "name"))), MsgOpts::default()).await;
	}
	if !word.is_empty() { return not_understood("„siedlung“ zeigt die Siedlung hier; dazu gründen, aufnehmen, entlassen, zu, offen."); }
	let huts = huts_in(&c.space, c.w(), c.room(), c.txn()).await?;
	let s = settlement_in(&c.space, c.room(), c.txn()).await?;
	let mut owner_ids: Vec<String> = Vec::new();
	for h in &huts { let a = key_text(j::at(h, "accountId")); if !owner_ids.contains(&a) { owner_ids.push(a); } }
	let Some(s) = s else {
		let text = format!("Hier ist keine Siedlung; hier stehen {} Hütten von {} Besitzern (nötig: {} Hütten von {}).{}", huts.len(), owner_ids.len(), key_text(j::at(&d, "huts")), key_text(j::at(&d, "owners")), if enough_huts(c.w(), &huts) { " „siedlung gründen <name>“ gründet eine, wenn du hier eine Hütte hast." } else { "" });
		return msg(c, &me, "info", &text, MsgOpts::default()).await;
	};
	let mut owners: Vec<String> = Vec::new();
	for h in &huts { let o = key_text(j::at(h, "ownerName")); if !owners.contains(&o) { owners.push(o); } }
	let named = |r: &str| j::a(&s, "members").iter().filter(|m| j::s(m, "rank") == r).map(|m| key_text(j::at(m, "name"))).collect::<Vec<_>>();
	let zones = zones_line(&c.space, j::s(&s, "room")).await?;
	let helpers = named("helfer");
	let settlers: Vec<String> = owners.into_iter().chain(named("siedler")).collect();
	let tax = j::at(&s, "tax");
	let text = format!("{} (gegründet von {}, {}): {} Hütten. Siedler: {}.{} Du bist {}.{}{}", key_text(j::at(&s, "name")), key_text(j::at(&s, "founderName")), if j::b(&s, "closed") { "geschlossen" } else { "offen" }, huts.len(), settlers.join(", "),
		if helpers.is_empty() { String::new() } else { format!(" Helfer: {}.", helpers.join(", ")) }, rank_name(&rank_of(&s, &huts, c.account.as_ref())),
		if zones.is_empty() { String::new() } else { format!(" Zonen: {zones}.") }, if j::truthy(tax) { format!(" Steuer: {} Münzen je Stück aus dem Lager.", key_text(tax)) } else { String::new() });
	msg(c, &me, "info", &text, MsgOpts::default()).await
}
