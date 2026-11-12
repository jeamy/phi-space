//! The wild from the fog (`server/engine/commands/wild.ts`): hares at the beds, deer at the fields, foxes at the coops,
//! mice at the chests and gulls at the smokehouse's rack come to rooms whose fire does not hold the fog back
//! (`wild_tick`) and take a little unless someone scares them off first (`scheuche`); fences (`zäune`), scarecrows,
//! traps and fed guards keep them off.
use phi_json::{obj, Json};

use super::animals::settle_herd;
use super::build::{dist_to, plan_of, put_back, take_near, Rect};
use super::field::{crop_of, field_name, harvest_of};
use super::garden::{bed_here, bed_name, grow_factor, may_tend, next_due, proto_name, sort_of, write_bed};
use crate::clock::{decay_now_of, world_now_of};
use crate::context::{inventory, msg, msg_transient, Ctx, MsgOpts};
use crate::fire::{fog_of, key_text};
use crate::j;
use crate::js;
use crate::source::{hex, random, random_bytes, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};
use crate::world::walkable;
use crate::worldtime::calendar;

fn txt(v: &Json) -> String { key_text(v) }
fn night(world_ms: f64) -> bool { let h = calendar(world_ms).1; h >= 20.0 || h < 6.0 }
fn dim(v: &Json, k: &str) -> f64 { j::no(v, k).unwrap_or(1.0) }
/// `gap`: cells between two rectangles (0: touching or overlapping), diagonal steps counting one.
fn gap(a: &Json, b: &Json) -> f64 {
	let (ax, ay, aw, ah) = (j::n(a, "x"), j::n(a, "y"), dim(a, "w"), dim(a, "h"));
	let (bx, by, bw, bh) = (j::n(b, "x"), j::n(b, "y"), dim(b, "w"), dim(b, "h"));
	0f64.max(bx - (ax + aw - 1.0)).max(ax - (bx + bw - 1.0)).max(by - (ay + ah - 1.0)).max(ay - (by + bh - 1.0))
}

/// `wildKinds`: the hare from `wd.hare` and the top-level numbers, the others from `wd.prey`.
pub fn wild_kinds(wd: &Json) -> Vec<Json> {
	let n = txt(j::at(j::at(wd, "hare"), "name"));
	let hare = obj! { "key" => "hase", "name" => n.as_str(), "aliases" => Json::Array(vec![Json::from("hasen"), Json::from("hare")]), "nom" => format!("ein {n}"), "the" => format!("der {n}"), "acc" => format!("den {n}n"), "none" => format!("kein {n}"), "goes" => "hoppelt", "to" => "", "icon" => j::at(j::at(wd, "hare"), "icon").clone(),
		"chance" => j::at(wd, "chance").clone(), "nightFactor" => j::at(wd, "nightFactor").clone(), "eatAfterWorldMs" => j::at(wd, "eatAfterWorldMs").clone() };
	std::iter::once(hare).chain(j::a(wd, "prey").iter().cloned()).collect()
}
fn kind_key(a: &Json) -> String { j::so(a, "kind").map_or_else(|| "hase".to_owned(), str::to_owned) }
fn kind_of(wd: &Json, a: &Json) -> Json { let ks = wild_kinds(wd); let key = kind_key(a); ks.iter().find(|k| j::s(k, "key") == key).cloned().unwrap_or_else(|| ks[0].clone()) }
fn cap(t: &str) -> String { let mut ch = t.chars(); ch.next().map_or_else(String::new, |f| f.to_uppercase().collect::<String>() + ch.as_str()) }
fn pron(k: &Json) -> &'static str { let acc = j::s(k, "acc"); if acc.starts_with("den ") { "ihn" } else if acc.starts_with("das ") { "es" } else { "sie" } }
fn the(k: &Json) -> String { txt(j::at(k, "the")) }
fn goes(k: &Json) -> String { txt(j::at(k, "goes")) }

/// `guardsIn`: per room, the kinds its fed guards keep away, with what the guard does.
pub fn guards_in(wd: &Json, buildings: &[Json], now: f64) -> Vec<(String, Vec<(String, String)>)> {
	let mut out: Vec<(String, Vec<(String, String)>)> = Vec::new();
	for b in buildings {
		for g in j::a(wd, "guards") {
			let by = j::at(g, "by");
			let herd = j::at(b, "herd");
			let keeper = j::at(b, "keeper");
			let fed = (j::at(herd, "kind") == by && j::n(herd, "fedUntilWorldMs") > now) || (j::at(keeper, "kind") == by && j::n(keeper, "fedUntilWorldMs") > now);
			if !fed || !(j::truthy(herd) || j::truthy(keeper)) { continue; }
			let room = j::s(b, "room").to_owned();
			let i = match out.iter().position(|(r, _)| *r == room) { Some(i) => i, None => { out.push((room, Vec::new())); out.len() - 1 } };
			for k in j::a(g, "kinds") { let k = txt(k); if !out[i].1.iter().any(|(x, _)| *x == k) { out[i].1.push((k, txt(j::at(g, "says")))); } }
		}
	}
	out
}
fn guard_says(g: &[(String, Vec<(String, String)>)], room: &str, kind: &str) -> Option<String> { g.iter().find(|(r, _)| r == room).and_then(|(_, m)| m.iter().find(|(k, _)| k == kind)).map(|(_, s)| s.clone()) }

/// `sheltered`: a bed the hares cannot harm (fenced, a scarecrow close by).
fn sheltered(wd: &Json, b: &Json, scarecrows: &[Json]) -> bool { j::b(b, "fenced") || scarecrows.iter().any(|s| j::at(s, "room") == j::at(b, "room") && gap(b, s) <= j::n(wd, "scarecrowReach")) }
/// `maxGrazes`.
pub fn max_grazes(p: &Json) -> f64 { let bite = j::no(p, "bite").unwrap_or(0.0); if bite != 0.0 { ((1.0 - j::no(p, "keep").unwrap_or(0.5)) / bite + 1e-9).floor() } else { 0.0 } }
/// `graze`: a deer grazes a growing field; false when there is nothing more to graze.
pub fn graze(d: &Json, p: &Json, f: &mut Json) -> bool {
	let Some(crop) = crop_of(d, j::at(f, "crop")).cloned() else { return false };
	let grazed = j::no(f, "grazed").unwrap_or(0.0);
	if j::s(f, "stage") != "waechst" || grazed >= max_grazes(p) { return false; }
	let g = grazed + 1.0;
	j::set(f, "grazed", g);
	let y = harvest_of(&crop, j::n(f, "w") * j::n(f, "h"), j::n(f, "soil") * j::no(p, "keep").unwrap_or(0.5).max(1.0 - j::no(p, "bite").unwrap_or(0.0) * g));
	j::set(f, "yields", y);
	true
}
/// `bite`: one living plant falls back a stage, a seedling is gone; the bed's last living plant stays. The plant's sort.
pub fn bite(g: &Json, b: &mut Json, now: f64, fog: f64) -> Option<Json> {
	let mut plants = j::a(b, "plants").to_vec();
	let living: Vec<usize> = (0..plants.len()).filter(|&i| j::n(&plants[i], "stage") < 3.0).collect();
	if living.len() < 2 { return None; }
	let i = living[(random() * living.len() as f64).floor() as usize % living.len()];
	let p = plants[i].clone();
	if j::n(&p, "stage") == 0.0 { plants.remove(i); } else {
		let stage = j::n(&p, "stage") - 1.0;
		j::set(&mut plants[i], "stage", stage);
		let due = now + sort_of(g, j::s(&p, "sort")).map_or(0.0, |s| j::a(s, "grow").get(stage as usize).map_or(f64::NAN, j::number) * grow_factor(fog, j::b(b, "weedy")));
		j::set(&mut plants[i], "dueWorldMs", due);
	}
	let due = next_due(&plants);
	j::set(b, "plants", Json::Array(plants));
	j::set(b, "dueWorldMs", due);
	Some(p)
}

async fn tell(space: &Space, lease_ms: f64, room: &str, text: &str, txn: Option<&str>) -> Result<()> {
	let m = obj! { "room" => room, "to" => "*", "kind" => "world", "text" => text, "from" => "", "at" => time_now() };
	space.write_with(&obj! { "type" => "Msg", "fields" => m }, txn, lease_ms, msg_transient(space, "*", "world").await).await?;
	Ok(())
}

/// `beside`: a free cell beside a target where an animal can sit.
fn beside(w: &Json, room: &str, r: Rect, covered: &[String]) -> Option<(f64, f64)> {
	let def = j::by(j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms")), "roomId", room)?;
	let ground: Vec<String> = j::a(def, "ground").iter().map(txt).collect();
	let mut ring = Vec::new();
	let mut x = r.x - 1.0;
	while x <= r.x + r.w {
		let mut y = r.y - 1.0;
		while y <= r.y + r.h {
			let inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
			if !inside && walkable(w, &ground, x, y) && !covered.contains(&format!("{},{}", phi_json::number_text(x), phi_json::number_text(y))) { ring.push((x, y)); }
			y += 1.0;
		}
		x += 1.0;
	}
	if ring.is_empty() { None } else { Some(ring[(random() * ring.len() as f64).floor() as usize % ring.len()]) }
}

/// What the tick reads once a round.
struct Seen { now: f64, beds: Vec<Json>, fields: Vec<Json>, buildings: Vec<Json>, scarecrows: Vec<Json>, guards: Vec<(String, Vec<(String, String)>)> }

/// `eat`: an animal whose time has come eats (or finds its target sheltered) and goes. Some(took); None: its target is
/// held by a command right now, it tries again next round.
async fn eat(space: &Space, w: &Json, lease_ms: f64, a: &Json, s: &Seen) -> Result<Option<bool>> {
	let wd = j::at(w, "wild");
	let k = kind_of(wd, a);
	let txn = space.create_transaction(10_000.0).await?;
	let r: Result<Option<bool>> = async {
		if space.take_if_exists(&tmpl("Animal", obj! { "animalId" => j::at(a, "animalId").clone() }), NO_WAIT, Some(&txn)).await?.is_none() { space.abort(&txn).await?; return Ok(Some(false)); }
		let room = j::s(a, "room");
		let key = j::s(&k, "key");
		let fled = guard_says(&s.guards, room, key).map(|g| format!("{g}; {} flieht in den Nebel.", the(&k)));
		let back = format!("{} {} in den Nebel zurück.", cap(&the(&k)), goes(&k));
		// a target held by a command: wait for the next round, unless it has been gone for long
		let wait = s.now - j::n(a, "eatsAtWorldMs") < j::n(&k, "eatAfterWorldMs");
		let mut text: Option<String> = None;
		let mut took = false;
		let target = j::at(a, "target");
		if key == "hase" {
			if let Some(bed) = s.beds.iter().find(|b| j::at(b, "bedId") == j::at(a, "bedId")) {
				text = Some(back.clone());
				if fled.is_some() || sheltered(wd, bed, &s.scarecrows) {
					text = Some(fled.clone().unwrap_or_else(|| format!("{} schnuppert {} {} und {} in den Nebel zurück.", cap(&the(&k)), if j::b(bed, "fenced") { "am Zaun um das" } else { "an der Vogelscheuche beim" }, bed_name(bed), goes(&k))));
				} else if j::a(bed, "plants").iter().filter(|p| j::n(p, "stage") < 3.0).count() >= 2 {
					match space.take_if_exists(&tmpl("Bed", obj! { "bedId" => j::at(bed, "bedId").clone() }), NO_WAIT, Some(&txn)).await? {
						None => if wait { space.abort(&txn).await?; return Ok(None); },
						Some(t) => {
							let mut b = fields(&t).clone();
							let p = if sheltered(wd, &b, &s.scarecrows) { None } else { let fog = fog_of(space, j::s(&b, "room")).await?; bite(j::at(w, "garden"), &mut b, s.now, fog) };
							space.write(&tmpl("Bed", b.clone()), Some(&txn), FOREVER).await?;
							if let Some(p) = p { took = true; text = Some(format!("{} knabbert im {} an {} und {} in den Nebel zurück.", cap(&the(&k)), bed_name(&b), sort_of(j::at(w, "garden"), j::s(&p, "sort")).map_or_else(|| "einer Pflanze".to_owned(), |x| txt(j::at(x, "name"))), goes(&k))); }
						}
					}
				}
			}
		} else if key == "reh" {
			if let Some(f) = s.fields.iter().find(|x| j::at(x, "fieldId") == target) {
				text = Some(back.clone());
				if fled.is_some() { text = fled.clone(); }
				else if j::b(f, "fenced") { text = Some(format!("{} findet den Zaun um den {} und {} in den Nebel zurück.", cap(&the(&k)), field_name(f), goes(&k))); }
				else if s.scarecrows.iter().any(|c| j::at(c, "room") == j::at(f, "room") && gap(f, c) <= j::n(wd, "scarecrowReach")) { text = Some(format!("{} scheut die Vogelscheuche bei der {} und {} in den Nebel zurück.", cap(&the(&k)), field_name(f), goes(&k))); }
				else if j::s(f, "stage") == "waechst" {
					match space.take_if_exists(&tmpl("Field", obj! { "fieldId" => j::at(f, "fieldId").clone() }), NO_WAIT, Some(&txn)).await? {
						None => if wait { space.abort(&txn).await?; return Ok(None); },
						Some(t) => {
							let mut x = fields(&t).clone();
							took = !j::b(&x, "fenced") && graze(j::at(w, "fields"), &k, &mut x);
							space.write(&tmpl("Field", x.clone()), Some(&txn), FOREVER).await?;
							if took { text = Some(format!("{} frisst sich an der {} satt und {} in den Nebel zurück; sie wird weniger geben.", cap(&the(&k)), field_name(&x), goes(&k))); }
						}
					}
				}
			}
		} else if key == "fuchs" {
			if let Some(b) = s.buildings.iter().find(|x| j::at(x, "buildId") == target) {
				text = Some(back.clone());
				if fled.is_some() { text = fled.clone(); }
				else if j::b(b, "fenced") { text = Some(format!("{} streicht um den Zaun am Stall von {} und {} in den Nebel zurück.", cap(&the(&k)), txt(j::at(b, "ownerName")), goes(&k))); }
				else {
					match space.take_if_exists(&tmpl("Building", obj! { "buildId" => j::at(b, "buildId").clone() }), NO_WAIT, Some(&txn)).await? {
						None => if wait { space.abort(&txn).await?; return Ok(None); },
						Some(t) => {
							// the herd settled with all its animals first: what they gave until now stays theirs
							let h = settle_herd(space, &txn, w, fields(&t), s.now).await?;
							let one = match &h.k { Some(hk) if h.n >= 2.0 => space.read_all(&tmpl("Item", obj! { "location" => j::at(b, "buildId").clone(), "proto" => j::at(hk, "proto").clone() }), None).await?.into_iter().next(), _ => None };
							if let Some(one) = one {
								if space.take_if_exists(&obj! { "id" => j::at(&one, "id").clone() }, NO_WAIT, Some(&txn)).await?.is_some() {
									took = true;
									text = Some(format!("{} holt sich eins der {} aus dem Stall von {} und {} in den Nebel zurück.", cap(&the(&k)), txt(j::at(h.k.as_ref().unwrap_or(&Json::Null), "plural")), txt(j::at(b, "ownerName")), goes(&k)));
								}
							}
							space.write(&tmpl("Building", h.b.clone()), Some(&txn), FOREVER).await?;
						}
					}
				}
			}
		} else if key == "maus" || key == "moewe" {
			if let Some(b) = s.buildings.iter().find(|x| j::at(x, "buildId") == target) {
				text = Some(back.clone());
				let inside: Vec<Json> = space.read_all(&tmpl("Item", obj! { "location" => j::at(b, "buildId").clone() }), None).await?.iter().map(|e| fields(e).clone()).collect();
				let owner = txt(j::at(b, "ownerName"));
				let trap = j::opt(&k, "trap").filter(|t| j::truthy(t));
				if fled.is_some() { text = fled.clone(); }
				else if trap.is_some_and(|t| inside.iter().any(|i| j::at(i, "proto") == t)) {
					text = Some(if key == "moewe" { format!("Über dem Gestell von {owner} liegt ein Netz; {} findet nichts und {} in den Nebel zurück.", the(&k), goes(&k)) } else { format!("In der Truhe von {owner} schnappt die Mausefalle zu; {} ist gefangen.", the(&k)) });
				} else {
					let eats = j::a(&k, "eats");
					let food: Vec<&Json> = inside.iter().filter(|i| eats.contains(j::at(i, "proto"))).collect();
					let n = j::no(&k, "take").unwrap_or(1.0).min(food.len() as f64 - 1.0);
					let mut eaten: Vec<(String, f64)> = Vec::new();
					for i in food.iter().take(n.max(0.0) as usize) {
						if space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(i, "itemId").clone(), "location" => j::at(b, "buildId").clone() }), NO_WAIT, Some(&txn)).await?.is_some() {
							let nm = txt(j::at(i, "name"));
							match eaten.iter_mut().find(|(x, _)| *x == nm) { Some(e) => e.1 += 1.0, None => eaten.push((nm, 1.0)) }
						}
					}
					let lost = eaten.iter().map(|(nm, x)| format!("{} {nm}", phi_json::number_text(*x))).collect::<Vec<_>>().join(" und ");
					if !eaten.is_empty() {
						took = true;
						text = Some(if key == "moewe" { format!("{} pickt am Gestell von {owner} und {} in den Nebel zurück; es fehlen {lost}.", cap(&the(&k)), goes(&k)) } else { format!("{} nagt an der Truhe von {owner} und {} in den Nebel zurück; es fehlen {lost}.", cap(&the(&k)), goes(&k)) });
					}
				}
			}
		}
		if let Some(t) = &text { tell(space, lease_ms, room, t, Some(&txn)).await?; }
		space.commit(&txn).await?;
		Ok(Some(took))
	}.await;
	if r.is_err() { let _ = space.abort(&txn).await; }
	r
}

/// `chestFor`: a chest the kind eats from: a mouse any, a gull only those of its houses.
fn chest_for(w: &Json, k: &Json, b: &Json) -> bool { plan_of(w, j::s(b, "plan")).is_some_and(|p| j::b(p, "chest")) && j::ao(k, "houses").is_none_or(|h| h.contains(j::at(b, "plan"))) }
fn in_houses(k: &Json, b: &Json) -> bool { j::ao(k, "houses").is_some_and(|h| h.contains(j::at(b, "plan"))) }

/// `targets`: the targets of a kind in a room that it may come for now (id, rectangle, name).
async fn targets(space: &Space, w: &Json, k: &Json, room: &str, s: &Seen) -> Result<Vec<(Json, Rect, String)>> {
	let key = j::s(k, "key");
	if key == "hase" { return Ok(s.beds.iter().filter(|b| j::s(b, "room") == room && j::a(b, "plants").iter().any(|p| j::n(p, "stage") < 3.0)).map(|b| (j::at(b, "bedId").clone(), Rect::of(b), bed_name(b))).collect()); }
	if key == "reh" { return Ok(s.fields.iter().filter(|f| j::s(f, "room") == room && j::s(f, "stage") == "waechst" && j::no(f, "grazed").unwrap_or(0.0) < max_grazes(k)).map(|f| (j::at(f, "fieldId").clone(), Rect::of(f), txt(j::at(f, "ownerName")))).collect()); }
	let mut out = Vec::new();
	if key == "fuchs" {
		for b in s.buildings.iter().filter(|x| j::s(x, "room") == room && in_houses(k, x) && j::b(x, "herd")) {
			let Some(kind) = j::opt(w, "animals").and_then(|a| j::a(a, "kinds").iter().find(|x| j::at(x, "key") == j::at(j::at(b, "herd"), "kind"))) else { continue };
			if space.count(&tmpl("Item", obj! { "location" => j::at(b, "buildId").clone(), "proto" => j::at(kind, "proto").clone() }), None).await? >= 2.0 { out.push((j::at(b, "buildId").clone(), Rect::of(b), txt(j::at(b, "ownerName")))); }
		}
	}
	if key == "maus" || key == "moewe" {
		let eats = j::a(k, "eats");
		for b in s.buildings.iter().filter(|x| j::s(x, "room") == room && chest_for(w, k, x)) {
			let food = space.read_all(&tmpl("Item", obj! { "location" => j::at(b, "buildId").clone() }), None).await?.iter().filter(|e| eats.iter().any(|x| txt(x) == txt(j::at(fields(e), "proto")))).count();
			if food >= 2 { out.push((j::at(b, "buildId").clone(), Rect::of(b), txt(j::at(b, "ownerName")))); }
		}
	}
	Ok(out)
}
/// `roomsFor`: the rooms a kind might come to at all, in the order a Set keeps them.
fn rooms_for(w: &Json, k: &Json, s: &Seen) -> Vec<String> {
	let key = j::s(k, "key");
	let rooms: Vec<String> = match key {
		"hase" => s.beds.iter().map(|b| j::s(b, "room").to_owned()).collect(),
		"reh" => s.fields.iter().filter(|f| j::s(f, "stage") == "waechst").map(|f| j::s(f, "room").to_owned()).collect(),
		"fuchs" => s.buildings.iter().filter(|b| in_houses(k, b) && j::b(b, "herd")).map(|b| j::s(b, "room").to_owned()).collect(),
		_ => s.buildings.iter().filter(|b| chest_for(w, k, b)).map(|b| j::s(b, "room").to_owned()).collect(),
	};
	let mut out: Vec<String> = Vec::new();
	for r in rooms { if !out.contains(&r) { out.push(r); } }
	out
}

/// `wildTick`: animals whose time has come eat and go, then each room with targets in fog may get a new one of each
/// kind. (came, ate).
pub async fn wild_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<(f64, f64)> {
	let Some(wd) = j::opt(w, "wild") else { return Ok((0.0, 0.0)) };
	let now = world_now_of(space, None).await?;
	let kinds: Vec<Json> = wild_kinds(wd).into_iter().filter(|k| match j::s(k, "key") { "hase" => j::b(w, "garden"), "reh" => j::b(w, "fields"), "fuchs" => j::b(w, "animals"), _ => true }).collect();
	let all = |ty: &'static str| async move { Ok::<_, Error>(space.read_all(&obj! { "type" => ty }, None).await?.iter().map(|e| fields(e).clone()).collect::<Vec<Json>>()) };
	let animals = all("Animal").await?;
	let beds = if j::b(w, "garden") { all("Bed").await? } else { Vec::new() };
	let fields_ = if kinds.iter().any(|k| j::s(k, "key") == "reh") { all("Field").await? } else { Vec::new() };
	let buildings = all("Building").await?;
	let scarecrow = j::at(wd, "scarecrow");
	let s = Seen { now, scarecrows: buildings.iter().filter(|b| j::at(b, "plan") == scarecrow).cloned().collect(), guards: guards_in(wd, &buildings, now), beds, fields: fields_, buildings };
	let (mut came, mut ate) = (0.0, 0.0);
	let mut waiting: Vec<Json> = Vec::new();
	for a in &animals {
		if j::n(a, "eatsAtWorldMs") > now { waiting.push(a.clone()); continue; }
		let r = eat(space, w, lease_ms, a, &s).await?;
		if r == Some(true) { ate += 1.0; }
		if r.is_none() { waiting.push(a.clone()); }
	}
	let is_night = night(now);
	for k in &kinds {
		let key = j::s(k, "key").to_owned();
		for room in rooms_for(w, k, &s) {
			let fog = fog_of(space, &room).await?;
			if fog <= 0.0 || waiting.iter().filter(|a| j::s(a, "room") == room && kind_key(a) == key).count() as f64 >= j::n(wd, "maxPerRoom") { continue; }
			let idx = 3f64.min(fog);
			let chance = if idx.fract() == 0.0 && idx >= 0.0 { j::a(k, "chance").get(idx as usize).and_then(Json::as_f64).unwrap_or(0.0) } else { 0.0 };
			if random() >= chance * if is_night { j::n(k, "nightFactor") } else { j::no(k, "dayFactor").unwrap_or(1.0) } { continue; }
			let ts = targets(space, w, k, &room, &s).await?;
			let i = (random() * ts.len() as f64).floor() as usize % ts.len().max(1);
			let Some((id, r, name)) = ts.get(i).cloned() else { continue };
			let covered: Vec<String> = space.read_all(&tmpl("Plot", obj! { "room" => room.as_str() }), None).await?.iter().map(|e| format!("{},{}", txt(j::at(fields(e), "x")), txt(j::at(fields(e), "y")))).collect();
			let Some((x, y)) = beside(w, &room, r, &covered) else { continue };
			let mut a = obj! { "animalId" => format!("{key}-{}", hex(&random_bytes(5))), "kind" => key.as_str(), "name" => j::at(k, "name").clone(), "room" => room.as_str(), "x" => x, "y" => y };
			j::set(&mut a, if key == "hase" { "bedId" } else { "target" }, id);
			j::set(&mut a, "eatsAtWorldMs", now + j::n(k, "eatAfterWorldMs"));
			j::set(&mut a, "at", now);
			space.write(&tmpl("Animal", a.clone()), None, FOREVER).await?;
			waiting.push(a);
			let where_ = if key == "hase" { format!("ans {name}") } else { j::s(k, "to").replace("{owner}", &name) };
			tell(space, lease_ms, &room, &format!("{} {} aus dem Nebel {where_}. („scheuche {key}“ jagt {} fort.)", cap(&txt(j::at(k, "nom"))), goes(k), pron(k)), None).await?;
			came += 1.0;
		}
	}
	Ok((came, ate))
}

fn wild(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "wild") { Some(w) => Ok(w.clone()), None => refuse("In dieser Welt kommt kein Wild aus dem Nebel.") } }
const GENERIC: &str = r"^(?:das\s+)?(?:wild|tiere?|alle)$";

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"scheuche" => scheuche(c, arg).await,
		"zäune" => zaeune(c).await,
		k => Err(Error::Other(format!("unported: wild/{k}"))),
	}
}

async fn scheuche(c: &mut Ctx, arg: &str) -> Result<()> {
	let wd = wild(c)?;
	let kinds = wild_kinds(&wd);
	let word = js::lower(&js::re(r"^(?:den|die|das|der)\s+", "i").replace(&js::re(r"\s+(?:weg|fort)$", "i").replace(js::trim(arg), ""), ""));
	let generic = js::re(GENERIC, "i").test(&word);
	let named = if !word.is_empty() && !generic { kinds.iter().find(|k| [txt(j::at(k, "key")), txt(j::at(k, "name"))].into_iter().chain(j::a(k, "aliases").iter().map(txt)).any(|x| js::lower(&x) == word)).cloned() } else { None };
	if !word.is_empty() && !generic && named.is_none() { return not_understood(format!("Verscheuchen lässt sich Wild aus dem Nebel: {}.", kinds.iter().map(|k| format!("„scheuche {}“", txt(j::at(k, "key")))).collect::<Vec<_>>().join(", "))); }
	let mut here: Vec<Json> = c.space.read_all(&tmpl("Animal", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|a| named.as_ref().is_none_or(|n| kind_key(a) == j::s(n, "key"))).collect();
	here.sort_by(|a, b| gap(&c.actor, a).partial_cmp(&gap(&c.actor, b)).unwrap_or(std::cmp::Ordering::Equal));
	let Some(a) = here.first().cloned() else { return refuse(named.map_or_else(|| "Hier ist kein Wild.".to_owned(), |n| format!("Hier ist {}.", txt(j::at(&n, "none"))))) };
	let k = kind_of(&wd, &a);
	let reach = j::n(&wd, "scareReach");
	if gap(&c.actor, &a) > reach { return not_understood(format!("Geh näher heran: {} ist zu weit weg (höchstens {} Schritte).", the(&k), phi_json::number_text(reach))); }
	if c.space.take_if_exists(&tmpl("Animal", obj! { "animalId" => j::at(&a, "animalId").clone() }), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{} ist schon fort.", cap(&the(&k)))); }
	msg(c, "*", "emote", &format!("{} scheucht {} in den Nebel zurück.", txt(j::at(&c.actor, "name")), txt(j::at(&k, "acc"))), MsgOpts::default()).await
}

/// `payFence`: takes what a fence costs from the actor's pack; refuses (naming it) when something is missing.
async fn pay_fence(c: &mut Ctx, first: &[Json], alt: Option<&[Json]>) -> Result<()> {
	let inv = inventory(c).await?;
	let of = |p: &Json| inv.iter().filter(|i| j::at(fields(i), "proto") == p).collect::<Vec<_>>();
	let lacks = |needs: &[Json]| needs.iter().any(|n| (of(j::at(n, "proto")).len() as f64) < j::n(n, "count"));
	let named = |c: &Ctx, needs: &[Json]| needs.iter().map(|n| format!("{} {}", txt(j::at(n, "count")), proto_name(c, j::s(n, "proto")))).collect::<Vec<_>>().join(" und ");
	// planks instead (WildDef.fenceAlt) when the first cost is not carried
	let needs = match alt { Some(a) if lacks(first) && !lacks(a) => a, _ => first };
	if lacks(needs) {
		return refuse(format!("Für diesen Zaun brauchst du {}{}.", named(c, first), alt.map_or_else(String::new, |a| format!(" oder {}", named(c, a)))));
	}
	let me = c.char_id().to_owned();
	for n in needs {
		for it in of(j::at(n, "proto")).into_iter().take(j::n(n, "count") as usize) {
			if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(fields(it), "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_none() { return refuse("Dein Material ist gerade nicht greifbar; bitte noch einmal."); }
		}
	}
	Ok(())
}

async fn zaeune(c: &mut Ctx) -> Result<()> {
	let wd = wild(c)?;
	let me = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let near = |xs: Vec<Json>| -> Vec<Json> { xs.into_iter().filter(|x| dist_to(me, Rect::of(x)) <= 1.0).collect() };
	let read = |ty: &'static str| { let t = tmpl(ty, obj! { "room" => c.room() }); let space = c.space.clone(); async move { Ok::<_, Error>(space.read_all(&t, None).await?.iter().map(|e| fields(e).clone()).collect::<Vec<Json>>()) } };
	let name = txt(j::at(&c.actor, "name"));
	if near(read("Bed").await?).iter().any(|b| may_tend(c, b)) {
		let b = bed_here(c, false, Some(&|x: &Json| may_tend(c, x)), Some(1.0)).await?;
		if j::b(&b, "fenced") { return refuse(format!("Um das {} steht schon ein Zaun.", bed_name(&b))); }
		pay_fence(c, j::a(&wd, "fence"), j::ao(&wd, "fenceAlt")).await?;
		let keep = j::opt(c.w(), "garden").map_or(0.0, |g| j::no(j::at(g, "bed"), "keepWorldMs").unwrap_or(0.0));
		let until = j::n(&b, "untilWorldMs").max(decay_now_of(&c.space, c.txn()).await? + keep);
		let mut nb = b.clone();
		j::set(&mut nb, "fenced", true);
		j::set(&mut nb, "untilWorldMs", until);
		write_bed(c, &nb).await?;
		return msg(c, "*", "emote", &format!("{name} setzt einen Zaun um das {}; kein Hase kommt mehr hinein.", bed_name(&b)), MsgOpts::default()).await;
	}
	let acc = c.account.as_ref().map(|a| j::at(a, "accountId").clone());
	let mine_field = |f: &Json| acc.as_ref() == Some(j::at(f, "accountId")) || j::b(f, "open");
	if let Some(fence) = j::ao(&wd, "fieldFence") {
		if near(read("Field").await?).iter().any(mine_field) {
			let Ok(f) = take_near(c, "Field", "fieldId", 1.0, &mine_field).await? else { return refuse("Der Acker ist gerade nicht greifbar; bitte noch einmal.") };
			if j::b(&f, "fenced") { return refuse(format!("Um die {} steht schon ein Zaun.", field_name(&f))); }
			pay_fence(c, fence, j::ao(&wd, "fieldFenceAlt")).await?;
			let mut nf = f.clone();
			j::set(&mut nf, "fenced", true);
			c.space.write(&tmpl("Field", nf), c.txn(), FOREVER).await?;
			return msg(c, "*", "emote", &format!("{name} zieht einen Zaun um den {}; kein Reh kommt mehr hinein.", field_name(&f)), MsgOpts::default()).await;
		}
	}
	let houses: Vec<Json> = wild_kinds(&wd).iter().find(|k| j::s(k, "key") == "fuchs").map_or_else(Vec::new, |k| j::a(k, "houses").to_vec());
	let mine_coop = |b: &Json| acc.as_ref() == Some(j::at(b, "accountId")) && houses.contains(j::at(b, "plan"));
	if let Some(fence) = j::ao(&wd, "coopFence") {
		if near(read("Building").await?).iter().any(mine_coop) {
			let Ok(b) = take_near(c, "Building", "buildId", 1.0, &mine_coop).await? else { return refuse("Der Stall ist gerade nicht greifbar; bitte noch einmal.") };
			if j::b(&b, "fenced") { return refuse("Um den Stall steht schon ein Zaun."); }
			pay_fence(c, fence, j::ao(&wd, "coopFenceAlt")).await?;
			let mut nb = b.clone();
			j::set(&mut nb, "fenced", true);
			put_back(c, &nb).await?;
			return msg(c, "*", "emote", &format!("{name} setzt einen Zaun mit Tür um den Stall; kein Fuchs kommt mehr hinein."), MsgOpts::default()).await;
		}
	}
	not_understood("Neben dir ist kein Beet, kein Acker und kein Hühnerstall, den du einzäunen darfst.")
}
