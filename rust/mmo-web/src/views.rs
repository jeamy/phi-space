//! The pure views of the gateway (`server/gateway.ts` charView, itemView, exitView, msgView, usesOf, the plans; the
//! bed's plants and the field of `garden.ts` and `field.ts`; `server/todos.ts`). A key JavaScript leaves out when its value
//! is undefined is left out here too.
use std::collections::HashSet;

use mmo_engine::context::where_to;
use mmo_engine::fire::key_text as txt;
use mmo_engine::funcparser::{render, View};
use mmo_engine::j;
use mmo_engine::js::{self, JsRegex};
use phi_json::{obj, Json, Object};

/// Inserts `k` when `v` is there (not undefined: a missing key or, as JSON has it, none).
pub fn put_some(o: &mut Object, k: &str, v: Option<&Json>) { if let Some(v) = v { o.insert(k, v.clone()); } }
pub fn obj_of(v: Json) -> Object { match v { Json::Object(o) => o, _ => Object::new() } }

pub fn proto_name(w: &Json, k: &str) -> String { j::by(j::a(w, "prototypes"), "key", k).map_or_else(|| k.to_owned(), |p| txt(j::at(p, "name"))) }

/// The characters a model plays, marked as AI wherever they appear.
pub fn char_view(c: &Json, model_chars: &HashSet<String>) -> Json {
	let id = j::s(c, "charId");
	let mut o = obj_of(obj! { "charId" => id, "name" => j::at(c, "name").clone(), "x" => j::at(c, "x").clone(), "y" => j::at(c, "y").clone(), "skin" => j::at(c, "skin").clone() });
	if j::truthy(j::at(c, "look")) { o.insert("look", j::at(c, "look").clone()); }
	if let Some(a) = j::opt(c, "aboard").filter(|a| j::truthy(a)) {
		let mut b = obj_of(obj! { "island" => j::at(a, "island").clone(), "arriveWorldMs" => j::at(a, "arriveWorldMs").clone() });
		put_some(&mut b, "to", a.get("to"));
		if j::truthy(j::at(a, "from")) { b.insert("from", j::at(a, "from").clone()); }
		o.insert("aboard", Json::Object(b));
	}
	if model_chars.contains(id) { o.insert("ai", Json::Bool(true)); }
	if id.starts_with("npc-siedler-") { o.insert("settler", Json::Bool(true)); }
	if j::truthy(j::at(c, "guest")) { o.insert("guest", Json::Bool(true)); }
	Json::Object(o)
}

pub fn item_view(f: &Json, proto_icon: &dyn Fn(&str) -> Option<String>, w: &Json) -> Json {
	let proto = j::s(f, "proto");
	let mut o = obj_of(obj! { "id" => j::at(f, "itemId").clone(), "kind" => "item", "name" => j::at(f, "name").clone(), "location" => j::at(f, "location").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone() });
	put_some(&mut o, "glyph", f.get("glyph"));
	if let Some(i) = proto_icon(proto) { o.insert("icon", Json::from(i)); }
	if j::truthy(j::at(w, "pack")) { o.insert("load", Json::Number(mmo_engine::pack::load_of(w, f.get("proto").and_then(Json::as_str)))); }
	if let Some(bag) = j::at(j::at(w, "pack"), "bags").get(proto).filter(|b| j::truthy(b)) { o.insert("bag", bag.clone()); }
	let v = j::at(f, "variety");
	if j::truthy(v) && !j::truthy(j::at(v, "name")) {
		let from = j::a(j::at(w, "garden"), "sorts").iter().find(|s| j::s(s, "seed") == proto || j::s(j::at(s, "yields"), "proto") == proto).map_or_else(String::new, |s| txt(j::at(s, "name")));
		let mut cross = obj_of(obj! { "id" => j::at(v, "id").clone(), "from" => from });
		put_some(&mut cross, "breeder", v.get("breeder"));
		o.insert("cross", Json::Object(cross));
	}
	Json::Object(o)
}

pub fn exit_view(f: &Json, w: &Json) -> Json {
	obj! { "id" => j::at(f, "exitId").clone(), "kind" => "exit", "name" => j::at(f, "name").clone(), "to" => where_to(w, f), "toRoom" => j::at(f, "destination").clone(), "location" => j::at(f, "location").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone() }
}

/// The names in the list of who plays ("Gerade spielen 3: Anna (Graue Bucht), Bo (Fischerdorf)").
pub fn who_names(text: &str) -> Vec<String> {
	let rest = text.split(": ").skip(1).collect::<Vec<_>>().join(": ");
	let tail = js::re(r"\s*\([^)]*\)\s*$", "");
	rest.split(", ").map(|x| js::trim(&tail.replace(x, "")).to_owned()).filter(|x| !x.is_empty()).collect()
}

/// Whether a message is meant for the viewer.
fn for_viewer(m: &Json, viewer: &str, name: &str) -> bool {
	let kind = j::s(m, "kind");
	if kind == "error" || j::s(m, "fromId") == viewer || (!name.is_empty() && j::s(m, "from") == name) { return false; }
	if j::s(m, "to") == viewer { return j::truthy(j::at(m, "fromId")); }
	if name.is_empty() || !(["say", "emote", "channel"].contains(&kind) || (kind == "info" && j::truthy(j::at(m, "actor")))) { return false; }
	let esc = js::re(r"[.*+?^${}()|[\]\\]", "g").replace(name, "\\$&");
	JsRegex::new(&format!("(^|[^\\p{{L}}\\p{{N}}]){esc}([^\\p{{L}}\\p{{N}}]|$)"), "iu").is_ok_and(|r| r.test(j::s(m, "text")))
}

pub fn msg_view(m: &Json, viewer: &str, model_names: &HashSet<String>, viewer_name: &str, players: Option<&HashSet<String>>) -> Json {
	let kind = j::s(m, "kind");
	let text = if j::truthy(j::at(m, "actor")) { render(j::s(m, "text"), &View { viewer, actor: j::s(m, "actor"), actor_name: j::s(m, "from") }) } else { j::s(m, "text").to_owned() };
	let mut o = obj_of(obj! { "kind" => j::at(m, "kind").clone(), "text" => text });
	put_some(&mut o, "from", m.get("from"));
	put_some(&mut o, "at", m.get("at"));
	if model_names.contains(j::s(m, "from")) { o.insert("ai", Json::Bool(true)); }
	if for_viewer(m, viewer, viewer_name) { o.insert("toMe", Json::Bool(true)); }
	let from_id = j::s(m, "fromId");
	if j::s(m, "to") == viewer || j::s(m, "actor") == viewer || (from_id == viewer && kind != "say" && kind != "channel") { o.insert("mine", Json::Bool(true)); }
	if ["say", "emote", "channel"].contains(&kind) && !from_id.is_empty() && !from_id.starts_with("npc-") { o.insert("player", Json::Bool(true)); }
	if kind == "who" { let empty = HashSet::new(); let p = players.unwrap_or(&empty); o.insert("players", Json::Array(who_names(j::s(m, "text")).into_iter().filter(|n| p.contains(n)).map(Json::from).collect())); }
	if kind == "help" && j::truthy(j::at(m, "help")) { o.insert("help", j::at(m, "help").clone()); }
	Json::Object(o)
}

/// `bedPlantsView` (garden.ts).
pub fn bed_plants_view(w: &Json, b: &Json) -> Json {
	let sorts = j::a(j::at(w, "garden"), "sorts");
	Json::Array(j::a(b, "plants").iter().map(|p| {
		let sort = sorts.iter().find(|s| j::at(s, "key") == j::at(p, "sort"));
		let color = j::opt(j::at(p, "variety"), "color").or_else(|| sort.and_then(|s| j::opt(s, "color"))).cloned().unwrap_or_else(|| Json::from("#7fae6a"));
		let mut o = obj_of(obj! { "x" => j::n(p, "x") - j::n(b, "x"), "y" => j::n(p, "y") - j::n(b, "y"), "stage" => j::at(p, "stage").clone(), "color" => color });
		put_some(&mut o, "model", sort.and_then(|s| s.get("model")));
		Json::Object(o)
	}).collect())
}

/// `fieldView` (field.ts): crop, color, model, stage, progress.
pub fn field_view(w: &Json, f: &Json) -> (Option<Json>, Option<Json>, Option<Json>, Json, f64) {
	let crop = mmo_engine::commands::field::crop_of(j::at(w, "fields"), j::at(f, "crop"));
	let need = j::n(f, "workNeed");
	(crop.and_then(|c| c.get("name").cloned()), crop.and_then(|c| c.get("color").cloned()), crop.and_then(|c| c.get("model").cloned()), j::at(f, "stage").clone(), if need != 0.0 && !need.is_nan() { j::n(f, "work") / need } else { 0.0 })
}

/// `usesOf`: what things are good for in world `w`, sent with the page.
pub fn uses_of(w: &Json) -> Json {
	let name = |k: &str| proto_name(w, k);
	let plans = j::a(j::at(w, "building"), "plans");
	let mut o = Object::new();
	if j::truthy(j::at(j::at(w, "cart"), "route")) { o.insert("roadEpoch", j::at(j::at(j::at(w, "cart"), "route"), "epoch").clone()); }
	if j::truthy(j::at(w, "sand")) { o.insert("sandTile", j::at(j::at(w, "sand"), "tile").clone()); }
	o.insert("npcs", Json::Array(j::a(w, "npcs").iter().map(|n| j::at(n, "name").clone()).collect()));
	let mut grinds: Vec<String> = Vec::new();
	for g in j::a(j::at(w, "mill"), "grinds") { let n = name(j::s(g, "from")); if !grinds.contains(&n) { grinds.push(n); } }
	o.insert("grinds", Json::Array(grinds.into_iter().map(Json::from).collect()));
	let mut foods = Object::new();
	for (k, ms) in j::entries(j::at(j::at(w, "food"), "foods")) { foods.insert(name(k), Json::Number(js::round(j::number(ms) / 3_600_000.0))); }
	o.insert("foods", Json::Object(foods));
	o.insert("recipes", Json::Array(j::a(w, "recipes").iter().map(|r| {
		let mut x = obj_of(obj! { "key" => j::at(r, "key").clone(), "name" => j::at(r, "name").clone(), "needs" => Json::Array(j::a(r, "needs").iter().map(|n| obj! { "name" => name(j::s(n, "proto")), "count" => j::at(n, "count").clone() }).collect()) });
		if j::truthy(j::at(r, "tool")) { x.insert("tool", Json::from(name(j::s(r, "tool")))); }
		if j::truthy(j::at(r, "at")) { x.insert("at", j::at(r, "at").clone()); }
		Json::Object(x)
	}).collect()));
	let mut feed = Object::new();
	for k in j::a(j::at(w, "animals"), "kinds").iter().chain(j::a(j::at(w, "wild"), "keepers")) { feed.insert(j::s(k, "key"), Json::Array(j::a(k, "feed").iter().map(|f| Json::from(name(f.as_str().unwrap_or("")))).collect())); }
	o.insert("feed", Json::Object(feed));
	o.insert("offerings", Json::Array(j::a(j::at(w, "chapel"), "offerings").iter().map(|f| Json::from(name(f.as_str().unwrap_or("")))).collect()));
	let sorts = j::a(j::at(w, "garden"), "sorts");
	let crops = j::a(j::at(w, "fields"), "crops");
	o.insert("flowers", Json::Array(sorts.iter().filter(|s| j::s(s, "kind") == "zier").map(|s| Json::from(name(j::s(j::at(s, "yields"), "proto")))).collect()));
	let mut seeds = Object::new();
	for s in sorts.iter().chain(crops) {
		let y = j::at(s, "yields");
		let grows = if let Json::Array(a) = y { a.first().map(|x| j::s(x, "proto")).unwrap_or("") } else { j::s(y, "proto") };
		let seed = j::s(s, "seed");
		if !seed.is_empty() && !grows.is_empty() && seed != grows { seeds.insert(name(seed), Json::from(name(grows))); }
	}
	o.insert("seeds", Json::Object(seeds));
	o.insert("beds", obj! {
		"flowers" => Json::Array(sorts.iter().filter(|s| j::s(s, "kind") == "zier").map(|s| Json::from(name(j::s(s, "seed")))).collect()),
		"plants" => Json::Array(sorts.iter().filter(|s| j::s(s, "kind") != "zier").map(|s| Json::from(name(j::s(s, "seed")))).collect()),
		"field" => Json::Array(crops.iter().map(|s| j::s(s, "seed")).filter(|seed| !sorts.iter().any(|s| j::s(s, "seed") == *seed)).map(|s| Json::from(name(s))).collect())
	});
	o.insert("chests", Json::Array(plans.iter().filter(|p| j::truthy(j::at(p, "chest")) && !j::truthy(j::at(p, "store"))).map(|p| j::at(p, "key").clone()).collect()));
	o.insert("stores", Json::Array(plans.iter().filter(|p| j::truthy(j::at(p, "store"))).map(|p| j::at(p, "key").clone()).collect()));
	let mut steps: Vec<Json> = Vec::new();
	if j::truthy(j::at(w, "mill")) { for g in j::a(j::at(w, "mill"), "grinds") { let from = name(j::s(g, "from")); steps.push(obj! { "kind" => "grind", "from" => from.as_str(), "to" => name(j::s(g, "to")), "at" => j::at(j::at(w, "mill"), "plan").clone(), "line" => format!("mahle alle {}", js::lower(&from)) }); } }
	for k in j::a(j::at(w, "animals"), "kinds") { steps.push(obj! { "kind" => "keep", "from" => j::at(k, "name").clone(), "to" => name(j::s(k, "yields")), "at" => j::at(k, "plan").clone(), "line" => format!("einstallen {}", js::lower(j::s(k, "name"))) }); }
	o.insert("steps", Json::Array(steps));
	Json::Object(o)
}

/// The building plans for the page's cell menu, with what each needs as text.
pub fn plans_of(w: &Json) -> Json {
	Json::Array(j::a(j::at(w, "building"), "plans").iter().map(|p| {
		let needs = j::a(p, "needs").iter().map(|n| format!("{} {}", js::number_text(j::n(n, "count")), proto_name(w, j::s(n, "proto")))).collect::<Vec<_>>().join(", ");
		let mut o = obj_of(obj! { "key" => j::at(p, "key").clone(), "name" => j::at(p, "name").clone() });
		if j::truthy(j::at(p, "dative")) { o.insert("dative", j::at(p, "dative").clone()); }
		o.insert("w", j::at(p, "w").clone()); o.insert("h", j::at(p, "h").clone());
		o.insert("needs", Json::from(needs));
		put_some(&mut o, "work", p.get("work"));
		if j::truthy(j::at(p, "chest")) && !j::truthy(j::at(p, "store")) { o.insert("chest", Json::Bool(true)); }
		let epoch = j::no(p, "epoch").unwrap_or(1.0);
		if epoch > 1.0 { o.insert("epoch", j::a(j::at(w, "epochs"), "names").get(epoch as usize - 1).cloned().filter(|x| !x.is_null()).unwrap_or_else(|| Json::from(format!("Epoche {}", js::number_text(epoch))))); }
		Json::Object(o)
	}).collect())
}

fn hours(ms: f64) -> String { let h = js::round(ms / 3_600_000.0); if h >= 1.0 { format!("{} {}", js::number_text(h), if h == 1.0 { "Stunde" } else { "Stunden" }) } else { "weniger als einer Stunde".into() } }

/// `todosFor` (server/todos.ts): the tasks of `char_id`, most urgent first.
pub fn todos_for<'a>(char_id: &str, objs: impl Iterator<Item = &'a Json>, herd_of: &dyn Fn(&str) -> Option<Json>, loads: impl Iterator<Item = &'a Json>, w: &Json, now: Option<f64>) -> Json {
	let room = |id: &str| j::by(j::a(w, "rooms"), "roomId", id).map_or_else(|| id.to_owned(), |r| txt(j::at(r, "name")));
	let where_ = |o: &Json| format!("in {} ({} {})", room(j::s(o, "location")), js::number_text(j::n(o, "x")), js::number_text(j::n(o, "y")));
	let mut out: Vec<(f64, Json)> = Vec::new();
	let mut add = |o: &Json, what: &str, text: String, rank: f64| out.push((rank, obj! { "id" => format!("{}:{what}", txt(j::at(o, "id"))), "text" => text, "room" => j::at(o, "location").clone(), "x" => j::at(o, "x").clone(), "y" => j::at(o, "y").clone(), "rank" => rank }));
	for o in objs {
		if j::s(o, "ownerId") != char_id || !j::truthy(j::at(o, "ownerId")) { continue; }
		let name = j::s(o, "name");
		match j::s(o, "kind") {
			"field" => match j::s(o, "fieldStage") {
				"reif" => add(o, "reif", format!("Dein {name} {} ist reif: ernten.", where_(o)), 0.0),
				"spaet" => add(o, "spaet", format!("Dein {name} {} ist überreif: bald ernten, sonst verdirbt die Ernte.", where_(o)), 0.0),
				"brach" => add(o, "brach", format!("Dein Acker {} liegt brach: bestellen („bestelle“).", where_(o)), 2.0),
				_ => {}
			},
			"bed" => {
				let plants = j::a(o, "plants");
				let ripe = plants.iter().filter(|p| j::n(p, "stage") == 2.0).count();
				let growing = plants.iter().filter(|p| j::n(p, "stage") < 2.0).count();
				if ripe > 0 { add(o, "reif", format!("In deinem {name} {} {} reif: ernten („ernte“).", where_(o), if ripe == 1 { "ist 1 Pflanze".to_owned() } else { format!("sind {ripe} Pflanzen") }), 0.0); }
				let thirst = j::n(o, "thirstMs");
				if let (true, Some(now), Some(wat)) = (growing > 0, now, j::no(o, "wateredWorldMs")) {
					if thirst != 0.0 && !thirst.is_nan() && now - wat > thirst / 2.0 {
						let dry = now - wat >= thirst;
						add(o, "durst", if dry { format!("Dein {name} {} ist trocken: gießen („gieße“), sonst welken die Pflanzen.", where_(o)) } else { format!("Dein {name} {} braucht bald Wasser: gießen („gieße“).", where_(o)) }, if dry { 0.0 } else { 1.0 });
					}
				}
				if j::truthy(j::at(o, "weedy")) { add(o, "unkraut", format!("In deinem {name} {} wächst Unkraut: jäten („jäte“).", where_(o)), 1.0); }
				if plants.iter().any(|p| j::n(p, "stage") == 3.0) { add(o, "welk", format!("In deinem {name} {} ist etwas verwelkt: neu pflanzen („pflanze“).", where_(o)), 2.0); }
				if plants.is_empty() { add(o, "leer", format!("Dein {name} {} ist leer: pflanzen („pflanze“).", where_(o)), 2.0); }
			}
			"site" => { let m = j::s(o, "missing"); add(o, "bau", format!("Deine Baustelle {name} {}: {} („liefere“, „arbeite“).", where_(o), if m.is_empty() { "fertig bauen".to_owned() } else { format!("es fehlen noch {m}") }), 1.0); }
			"building" if j::truthy(j::at(o, "herd")) => {
				let h = herd_of(j::s(o, "id"));
				let k = j::a(j::at(w, "animals"), "kinds").iter().find(|x| j::at(x, "key") == j::at(o, "herd"));
				let (Some(h), Some(k), Some(now)) = (h, k, now) else { continue };
				let goods = j::n(j::at(w, "animals"), "nestMax").min(j::n(&h, "goods") + 0f64.max(now.min(j::n(&h, "fedUntilWorldMs")) - j::n(&h, "atWorldMs")) / j::n(k, "everyWorldMs"));
				if goods >= 1.0 { add(o, "ertrag", format!("In deinem {name} {} liegt {} bereit: einsammeln („einsammeln“).", where_(o), proto_name(w, j::s(k, "yields"))), 0.0); }
				if j::n(&h, "fedUntilWorldMs") <= now { add(o, "hunger", format!("Die Tiere in deinem {name} {} sind hungrig: füttern („füttere“).", where_(o)), 0.0); }
			}
			_ => {}
		}
	}
	let mill_plan = j::at(j::at(w, "mill"), "plan");
	let mill = j::a(j::at(w, "building"), "plans").iter().find(|p| j::at(p, "key") == mill_plan && !mill_plan.is_null()).map_or_else(|| "Mühle".to_owned(), |p| txt(j::at(p, "name")));
	for l in loads {
		let Some(now) = now else { continue };
		if j::s(l, "charId") != char_id || j::n(l, "untilWorldMs") <= now { continue; }
		let o = obj! { "id" => j::at(l, "loadId").clone(), "location" => j::at(l, "room").clone(), "x" => j::at(l, "x").clone(), "y" => j::at(l, "y").clone() };
		let what = format!("{} {}", js::number_text(j::n(l, "count")), proto_name(w, j::s(l, "to")));
		if j::n(l, "readyWorldMs") <= now { add(&o, "mehl", format!("{what} wartet an der {mill} {}: abholen („abholen“).", where_(&o)), 0.0); }
		else { add(&o, "mahlt", format!("{what} ist an der {mill} {} in etwa {} fertig.", where_(&o), hours(j::n(l, "readyWorldMs") - now)), 2.0); }
	}
	out.sort_by(|a, b| a.0.total_cmp(&b.0));
	Json::Array(out.into_iter().map(|(_, t)| t).collect())
}
