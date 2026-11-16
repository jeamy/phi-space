//! What people ask an NPC in plain words, and what the keeper can do about it without a model: bring wood to the fire
//! (`server/npc/requests.ts`). "ines, sammle bitte drei Scheit Treibholz": the sentence names her and asks for wood, so
//! she walks to the driftwood, picks it up, takes it to the fire and says what she did.
use phi_json::{obj, Json};

use super::Npc;
use crate::j;
use crate::js::{self, JsRegex};
use crate::space::{fields, tmpl, Result};

#[derive(Debug, Clone, PartialEq)]
pub enum Request { Gather(f64), Feed, Greet, Unclear }

const NUMBER: [(&str, f64); 9] = [("ein", 1.0), ("eine", 1.0), ("einen", 1.0), ("einem", 1.0), ("zwei", 2.0), ("drei", 3.0), ("vier", 4.0), ("fuenf", 5.0), ("fünf", 5.0)];
fn greeting() -> std::rc::Rc<JsRegex> { js::re(r"\b(hallo|hi|moin|hello|servus|guten (tag|abend|morgen))\b", "i") }

/// `requestOf`: what `text` asks of the NPC called `name`; None when the sentence is not meant for her.
pub fn request_of(text: &str, name: &str) -> Option<Request> {
	let named = JsRegex::new(&format!("(^|[^\\p{{L}}]){name}([^\\p{{L}}]|$)"), "iu").ok()?;
	if !named.test(text) { return None; }
	let wood = js::re(r"\b(treibholz|holz|scheite?|brennholz|driftwood|wood)\b", "i").test(text);
	if wood && js::re(r"\b(leg\w*|wirf\w*|werf\w*|füttere\w*|nachlegen|nachlege\w*|feed|put|throw)\b", "i").test(text) && js::re(r"\b(feuer|leuchtfeuer|fire)\b", "i").test(text) { return Some(Request::Feed); }
	if wood && js::re(r"\b(samm\w*|hol(e|en|t)?|such\w*|bring\w*|besorg\w*|geh\w*|lauf\w*|beschaff\w*|collect|fetch|gather|get)\b", "i").test(text) {
		let digits = js::caps(&js::re(r"\b(\d+)\b", ""), text).and_then(|m| m[1].clone());
		let count = match digits {
			Some(d) => js::to_number(&d),
			None => NUMBER.iter().find(|(w, _)| JsRegex::new(&format!("\\b{w}\\b"), "i").is_ok_and(|r| r.test(text))).map_or(2.0, |(_, k)| *k),
		};
		return Some(Request::Gather(1f64.max(4f64.min(count))));
	}
	if greeting().test(text) {
		let rest = greeting().replace(text, "");
		let rest = JsRegex::new(name, "i").map_or(rest.clone(), |r| r.replace(&rest, ""));
		if js::re(r"[^\p{L}]", "gu").replace(&rest, "").encode_utf16().count() < 3 { return Some(Request::Greet); }
	}
	Some(Request::Unclear)
}

fn reach(a: (f64, f64), b: (f64, f64)) -> f64 { (a.0 - b.0).abs().max((a.1 - b.1).abs()) }
fn is_wood(name: &str) -> bool { js::re("holz", "i").test(name) }
fn scheite(n: f64) -> String { format!("{} Scheit{}", phi_json::number_text(n), if n == 1.0 { "" } else { "e" }) }
fn xy(f: &Json) -> (f64, f64) { (j::n(f, "x"), j::n(f, "y")) }

/// Where the NPC stands now.
async fn position(n: &Npc) -> Result<Option<(f64, f64, String)>> {
	Ok(super::scripts::self_of(n).await?.map(|c| (j::n(&c, "x"), j::n(&c, "y"), j::s(&c, "room").to_owned())))
}

/// `gather`: walks to driftwood in the room, picks up up to `count` pieces, takes them to the fire and puts them in.
pub async fn gather(n: &Npc, me_char: &str, from: &str, mut count: f64) -> Result<()> {
	let carried = || async { Ok::<_, crate::space::Error>(n.space.read_all(&tmpl("Item", obj! { "location" => me_char }), None).await?.into_iter().map(|e| fields(&e).clone()).filter(|i| is_wood(j::s(i, "name"))).collect::<Vec<Json>>()) };
	let mut skipped: Vec<String> = Vec::new();
	let mut got = carried().await?.len() as f64;
	let start = got;
	if count == 0.0 {
		if got > 0.0 { n.act("say Gern, ich lege nach.").await?; } else { count = 1.0; n.act("say Gern, ich hole erst ein Scheit Treibholz.").await?; }
	} else { n.act(&format!("say Mach ich, {from}: ich hole {} Treibholz.", scheite(count))).await?; }
	let mut guard = 0.0;
	while guard < count * 3.0 && got - start < count && !n.halted() {
		guard += 1.0;
		let Some(here) = position(n).await? else { break };
		let mut lying: Vec<Json> = n.space.read_all(&tmpl("Item", obj! { "location" => here.2.as_str() }), None).await?.into_iter().map(|e| fields(&e).clone())
			.filter(|i| is_wood(j::s(i, "name")) && !skipped.iter().any(|s| s == j::s(i, "itemId"))).collect();
		lying.sort_by(|a, b| reach((here.0, here.1), xy(a)).total_cmp(&reach((here.0, here.1), xy(b))));
		let Some(piece) = lying.into_iter().next() else { break };
		if reach((here.0, here.1), xy(&piece)) > 0.0 { n.act(&format!("move {} {}", phi_json::number_text(j::n(&piece, "x")), phi_json::number_text(j::n(&piece, "y")))).await?; }
		n.act(&format!("get {}", j::s(&piece, "name"))).await?;
		let after = carried().await?.len() as f64;
		if after > got { got = after; } else { skipped.push(j::s(&piece, "itemId").to_owned()); }
	}
	let mine = carried().await?;
	if mine.is_empty() { return n.act(&format!("say Am Strand liegt gerade kein Treibholz, {from}. Die Flut bringt bald neues.")).await; }
	let w = n.w();
	let def = n.def();
	let beacon = j::a(&w, "beacons").iter().find(|b| j::at(b, "beaconId") == j::at(&def, "beacon")).cloned();
	let at = position(n).await?;
	if let (Some(beacon), Some(at)) = (&beacon, &at) {
		if at.2 == j::s(beacon, "room") {
			let bxy = xy(beacon);
			let pos = |p: Option<(f64, f64, String)>| p.map_or((at.0, at.1), |p| (p.0, p.1));
			for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
				if reach(pos(position(n).await?), bxy) <= 1.0 { break; }
				n.act(&format!("move {} {}", phi_json::number_text(bxy.0 + dx), phi_json::number_text(bxy.1 + dy))).await?;
			}
			if reach(pos(position(n).await?), bxy) <= 1.0 {
				let into = j::a(beacon, "aliases").first().and_then(Json::as_str).unwrap_or("feuer").to_owned();
				for it in &mine { if n.halted() { break; } n.act(&format!("put {} in {into}", j::s(it, "name"))).await?; }
				return n.act(&format!("say Fertig, {from}: {} liegen im Feuer.", scheite(mine.len() as f64))).await;
			}
		}
	}
	n.act(&format!("say Ich habe {} gesammelt, {from}, komme aber nicht ans Feuer.", scheite(mine.len() as f64))).await
}

/// `unclear`: a request the script cannot do.
pub fn unclear(from: &str) -> String { format!("Das habe ich nicht verstanden, {from}. Ich hüte das Feuer und hole auf Wunsch Treibholz: sag zum Beispiel „Ines, hol Holz“.") }
