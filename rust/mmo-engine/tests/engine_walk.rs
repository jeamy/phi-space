//! The Rust engine against the frozen TypeScript engine (docs/rust-portierung.en.md, R8.2): two space servers in memory
//! (`src/standalone.ts`), the TypeScript engine on one through `spaces-mmo/tests/r8/engine-driver.ts` (imported from the
//! oracle of tests/common), this crate on the other, the same seed and clock; after every step both spaces hold the
//! same entries in the same order (type, types and fields; the ids are the servers' own).
mod common;
#[path = "common/walk.rs"]
mod walk;

use phi_json::{obj, Json};
use walk::{Dice, Walk, START};

#[test]
fn loading_the_world() {
	let mut w = Walk::new("load", 7, START);
	for (i, replace) in [false, false, true].into_iter().enumerate() {
		w.at(START + i as f64 * 60_000.0);
		w.load(replace);
		w.compare(&format!("load {i} (replace {replace})"));
	}
}

#[test]
fn the_weather() {
	let mut w = Walk::new("weather", 11, START);
	w.load(false);
	for round in 0..8 {
		w.at(START + (round + 1) as f64 * 20.0 * 60_000.0);
		for job in ["fire", "fog", "flood"] {
			w.tick(job);
			w.compare(&format!("round {round}, {job}"));
		}
	}
	let (flotsam, fog, washed) = (w.entries_with(r#""flotsam":true"#), w.entries_with("Nebel"), w.entries_with("Die Flut spült"));
	eprintln!("the weather: {flotsam} pieces of flotsam, {fog} fog messages, {washed} tide messages");
	assert!(flotsam > 0 && fog > 0 && washed > 0, "the walk did nothing");
}

/// Walking: a character steps about the world (toward the exits of its room mostly, into walls, onto another one, with
/// and without a page's step number, a few malformed steps), now and then the fog thickens; every step on both sides.
#[test]
fn walking() {
	let mut w = Walk::new("walking", 13, START);
	w.load(false);
	let a = w.player(1, "graue-bucht", (10.0, 8.0), true);
	let b = w.player(2, "graue-bucht", (11.0, 8.0), true);
	w.compare("players");
	let mut dice = Dice(5);
	let (mut said, mut rooms) = (std::collections::BTreeMap::<String, usize>::new(), std::collections::BTreeSet::<String>::new());
	for i in 0..320 {
		w.at(START + i as f64 * 7_000.0);
		if i % 90 == 60 { w.tick("fog"); w.compare(&format!("fog before step {i}")); }
		let (room, x, y) = w.where_is(&a);
		rooms.insert(room.clone());
		let exits: Vec<(f64, f64)> = w.w.get("exits").and_then(Json::as_array).unwrap().iter().filter(|e| e.get("room").and_then(Json::as_str) == Some(room.as_str())).map(|e| (e.get("x").and_then(Json::as_f64).unwrap(), e.get("y").and_then(Json::as_f64).unwrap())).collect();
		let line = match dice.next(20) {
			0 => "step 1 1".to_owned(),
			1 => "step x".to_owned(),
			2 => "step  0   -1".to_owned(),
			n if n < 14 && !exits.is_empty() => {
				// the first cell of the way to one of the room's exits
				let target = exits[(i / 45) % exits.len()];
				let def = w.w.get("rooms").and_then(Json::as_array).unwrap().iter().find(|r| r.get("roomId").and_then(Json::as_str) == Some(room.as_str())).unwrap();
				let ground = mmo_engine::room_growth::rows(def.get("ground").unwrap());
				match mmo_engine::world::find_path(&w.w, &ground, (x, y), target, 200, &|_| false).and_then(|p| p.first().copied()) {
					Some((nx, ny)) => format!("step {} {}", nx - x, ny - y),
					None => "step 1 0".to_owned(),
				}
			}
			_ => ["step 1 0", "step -1 0", "step 0 1", "step 0 -1"][dice.next(4) as usize].to_owned(),
		};
		let step = (dice.next(3) > 0).then(|| obj! { "conn" => "k1", "seq" => i as f64 });
		let who = if dice.next(6) == 0 { &b } else { &a };
		let r = w.cmd(who, &line, step);
		*said.entry(js_cut(&r)).or_default() += 1;
		w.compare(&format!("step {i}: {line} -> {r}"));
	}
	eprintln!("walking: {said:?}, rooms {rooms:?}");
	assert!(rooms.len() > 1, "the walk never left its room");
}

fn js_cut(r: &str) -> String { r.chars().take(70).collect() }

/// The commands of default.ts and what every line goes through (the command sets, the exits as commands, help, the
/// translation rules, the pack): a guest and a registered player look, talk, pick up, put into the fire, drop, give,
/// walk out and back, and type what is not a command.
#[test]
fn talking() {
	let mut w = Walk::new("talking", 17, START);
	w.load(false);
	let a = w.player(1, "graue-bucht", (10.0, 8.0), true);
	let b = w.player_as(2, "graue-bucht", (11.0, 8.0), true, false);
	w.compare("players");
	let script: &[(&str, &str)] = &[
		("a", "look"), ("a", "schau"), ("a", "l leuchtfeuer"), ("a", "look muschel"), ("a", "look ost"), ("a", "look wander"), ("a", "look niemand"), ("a", "schau dich um"),
		("a", "say hallo"), ("a", "'moin"), ("a", ":winkt"), ("a", "emote"), ("a", "say"), ("a", "hallo Wanderer2, wie geht's?"), ("a", "moin"), ("b", "Strandläufer-1001: komm her"),
		("a", "who"), ("a", "wer"), ("a", "wer ist da"), ("a", "help"), ("b", "hilfe"), ("a", "help step"), ("a", "help geh"), ("a", "help gibtsnicht"), ("a", "?"), ("a", "help intro"),
		("a", "inventory"), ("a", "i"), ("a", "was trage ich"),
		("a", "move 5 7"), ("a", "get treibholz"), ("a", "nimm das treibholz auf"), ("a", "get muschel"), ("a", "move 14 5"), ("a", "heb muschel"), ("a", "inventar"),
		("a", "move 9 9"), ("a", "put treibholz in feuer"), ("a", "lege muschel ins feuer"), ("a", "wirf alle hölzer ins feuer"), ("a", "look leuchtfeuer"),
		("a", "drop muschel"), ("a", "get muschel"), ("a", "give muschel an Wanderer2"), ("a", "move 10 9"), ("b", "move 9 8"),
		("b", "move 17 9"), ("b", "get treibholz"), ("b", "move 10 8"), ("b", "give treibholz an Strandläufer-1001"), ("b", "gib Strandläufer-1001 das treibholz"), ("a", "give 2 treibholz an Wanderer2"), ("a", "give 99 treibholz an Wanderer2"), ("a", "give treibholz an niemand"), ("a", "give treibholz"),
		("a", "lege zwei hölzer ins feuer"), ("a", "put alle muscheln in feuer"), ("a", "put grosses holz in feuer"), ("a", "put drei stück tang in feuer"), ("a", "reputation"), ("b", "ruf"),
		("a", "channel"), ("a", "kanal hafen hallo alle"), ("a", "kanal welt x"), ("a", "kanal hafen"), ("a", "chan HAFEN laut"),
		("a", "tanze"), ("a", "Tanze wild"), ("a", "step"), ("a", "schritt 1 0"), ("a", "move 99 99"), ("a", "move a b"), ("a", "move 1"), ("a", "arrive"),
		("a", "gehe nach osten"), ("a", "look"), ("a", "west"), ("a", "go"), ("a", "go nirgendwo"), ("a", "geh süd"), ("a", "nord"), ("a", "lauf richtung klippenpfad"),
		("b", "inventory"), ("b", "drop treibholz"), ("b", "look treibholz"),
	];
	let mut refused = 0;
	for (i, (who, line)) in script.iter().enumerate() {
		w.at(START + i as f64 * 11_000.0);
		let id = if *who == "a" { a.clone() } else { b.clone() };
		let r = w.cmd(&id, line, None);
		if r.starts_with("refused") { refused += 1; }
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{i}: {who} {line} -> {r}"));
	}
	assert!(refused > 5 && refused < script.len() / 2, "{refused} of {} refused", script.len());
}

/// Who stands where: a cell held by one who went offline is taken over, one held by one who is online refuses, someone
/// on one's own cell sends one to the nearest free cell, and leaving a room ends the offers made there (the other side
/// told by a Notice).
#[test]
fn crowding() {
	let mut w = Walk::new("crowding", 19, START);
	w.load(false);
	let a = w.player(1, "graue-bucht", (10.0, 8.0), true);
	let b = w.player_as(2, "graue-bucht", (12.0, 8.0), true, false);
	let c = w.player(3, "graue-bucht", (11.0, 8.0), false);
	let spot = |ch: &str, name: &str, x: f64, y: f64| obj! { "type" => "Spot", "fields" => obj! { "room" => "graue-bucht", "x" => x, "y" => y, "charId" => ch, "name" => name } };
	w.write(spot(&b, "Wanderer2", 12.0, 8.0));
	w.write(spot(&c, "Strandläufer-1003", 11.0, 8.0));
	w.compare("spots");
	let offer = |id: &str, from: &str, to: &str| obj! { "type" => "Offer", "fields" => obj! { "offerId" => id, "from" => from, "fromName" => "x", "to" => to, "toName" => "y", "give" => Json::Array(vec![]), "giveNames" => Json::Array(vec![]), "want" => Json::Array(vec![]), "room" => "graue-bucht", "at" => START } };
	let mut said = Vec::new();
	let mut run = |w: &mut Walk, i: usize, who: &str, line: &str, step: Option<Json>| {
		w.at(START + i as f64 * 9_000.0);
		let r = w.cmd(who, line, step);
		eprintln!("{line} -> {r}");
		w.compare(&format!("{i}: {line} -> {r}"));
		said.push(r);
	};
	run(&mut w, 0, &a, "step 1 0", None); // onto the offline one's Spot
	run(&mut w, 1, &a, "step 1 0", None); // onto the online one's
	run(&mut w, 2, &a, "step 1 0", Some(obj! { "conn" => "k", "seq" => 1.0 })); // the same, a page's step: answered
	run(&mut w, 3, &a, "step 1 0", Some(obj! { "conn" => "k", "seq" => 2.0 })); // told once
	w.write(spot(&b, "Wanderer2", 11.0, 8.0)); // someone on its cell
	run(&mut w, 4, &a, "arrive", None);
	run(&mut w, 5, &a, "move 8 8", None);
	run(&mut w, 6, &b, "move 9 8", None);
	run(&mut w, 7, &a, "move 10 8", None); // the way round the other
	w.write(offer("o-1", &a, &b));
	w.write(offer("o-2", &b, &a));
	run(&mut w, 8, &a, "ost", None);
	run(&mut w, 9, &b, "look", None);
	assert!(said.iter().any(|r| r.contains("Dort steht schon Wanderer2")), "{said:?}");
	assert!(w.entries_with(r#""Notice""#) >= 1, "no notice");
}

/// A thing of the world's prototype `proto` at `location`, as spawn writes it.
fn thing(w: &Json, id: &str, proto: &str, location: &str) -> Json {
	let p = w.get("prototypes").and_then(Json::as_array).unwrap().iter().find(|p| p.get("key").and_then(Json::as_str) == Some(proto)).unwrap();
	let f = obj! { "itemId" => id, "name" => p.get("name").cloned().unwrap(), "aliases" => p.get("aliases").cloned().unwrap_or(Json::Array(vec![])), "desc" => p.get("desc").cloned().unwrap_or(Json::from("")), "location" => location, "x" => -1.0, "y" => -1.0, "locks" => p.get("locks").cloned().unwrap(), "proto" => proto };
	obj! { "type" => "Item", "fields" => f }
}

/// Building (build.ts, siteorder.ts): refusals of where and what, a site staked out under one's feet, wages hung out and
/// paid, delivering and working until the hut stands, its chest, repair, demolition, a ruin cleared with the estate
/// waiting in it, a warehouse in a closed settlement with its quota and tax, and a fire whose light is out or used up.
#[test]
fn building() {
	let mut w = Walk::new("building", 23, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (4.0, 12.0), true);
	let d = w.player_as(4, "anleger", (16.0, 4.0), true, false);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	give(&mut w, &a, "treibholz", 6);
	give(&mut w, &a, "tangseil", 3);
	give(&mut w, &a, "muenze", 12);
	give(&mut w, &a, "muschel", 2);
	give(&mut w, &b, "treibholz", 4);
	give(&mut w, &b, "tangseil", 1);
	give(&mut w, &g, "treibholz", 2);
	w.write(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-bucht", "until" => 9e15, "litAt" => 0.0 } });
	w.write(obj! { "type" => "Zone", "fields" => obj! { "zoneId" => "z-1", "room" => "graue-bucht", "kind" => "weg", "x" => 1.0, "y" => 8.0, "w" => 2.0, "h" => 2.0 } });
	w.compare("setup");
	let i = std::cell::Cell::new(0);
	let mut said = Vec::new();
	let mut run = |w: &mut Walk, who: &str, line: &str| {
		i.set(i.get() + 1);
		let i = i.get();
		w.at(START + i as f64 * 13_000.0);
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{i}: {who} {line} -> {r}"));
		said.push(r);
	};
	for (who, line) in [
		(&d, "bau hütte"), (&a, "bau"), (&g, "bau hütte"), (&a, "bau gibtsnicht"), (&a, "bau strasse"), (&a, "bau hütte 30 30"), (&a, "bau hütte 1 1"), (&a, "bau hütte 1 8"),
		(&a, "bau hütte 8 9"), (&a, "bau hütte 22 7"), (&a, "bau hütte 4 6"), (&a, "bau hütte 14 10"), (&a, "bau hütte 12 6"), (&a, "bau hütte 5 12"), (&a, "bau steg"), (&a, "baustelle"), (&a, "arbeite"), (&a, "aushang"),
		(&a, "bau eine hütte 5 13"), (&a, "bau regentonne"), (&a, "baustelle"), (&a, "baustelle 5 13"), (&a, "baustelle 3 3"), (&b, "bau hütte 30 30"),
		(&a, "aushang"), (&b, "aushang ab"), (&a, "aushang 2 treibholz je 1"), (&a, "aushang 3 arbeit je 1"), (&a, "aushang 2 holz je 1"), (&a, "aushang 3 muscheln je 1"),
		(&a, "aushang x"), (&a, "aushang 1 arbeit je 0"), (&a, "aushang 50 tangseil je 9"), (&a, "aushang"), (&b, "baustelle"),
		(&b, "liefere 2 treibholz"), (&a, "aushang 1 tangseil je 1"), (&a, "aushang ab"), (&a, "aushang ab"), (&a, "aushang 2 arbeit je 1"), (&a, "aushang 1 tangseil je 1"), (&b, "liefere muschel"), (&a, "liefere muschel"), (&a, "liefere 6 treibholz an die hütte"), (&a, "liefere treibholz"), (&a, "liefere tangseil zur baustelle"),
		(&b, "liefere tangseil"), (&a, "liefere"), (&g, "liefere treibholz"),
		(&a, "arbeite"), (&a, "arbeite"), (&b, "arbeite an der baustelle"), (&g, "arbeite"),
	] { run(&mut w, who, line); }
	w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "work.rest", "value" => 0.0 } });
	i.set(i.get() + 2_000); // the rest of the first work is over
	for k in 0..19 { run(&mut w, if k % 3 == 0 { &b } else { &a }, "arbeite"); }
	let hut = |id: &str, room: &str| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => "huette", "name" => "Hütte", "room" => room, "x" => 3.0, "y" => 3.0, "w" => 2.0, "h" => 2.0, "owner" => "c-walk1", "ownerName" => "Wanderer1", "accountId" => "a-walk1", "beaconId" => "feuer-anleger", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	w.write(hut("h-2", "duenen"));
	for (who, line) in [
		(&a, "arbeite"), (&a, "aushang"), (&a, "baustelle"), (&a, "truhe"), (&a, "verstaue muschel in hütte"), (&a, "verstaue 2 muscheln"), (&a, "kiste"), (&a, "verstaue alle münzen in 1"), (&a, "verstaue holz in 2"),
		(&a, "verstaue holz in meine hütte"), (&a, "verstaue holz in die hütte am kai"), (&a, "verstaue stein"), (&a, "truhe"), (&a, "entnimm muschel"), (&a, "entnimm 5 muscheln aus der truhe"),
		(&a, "entnimm stein"), (&a, "entnimm alle münzen"), (&b, "truhe"), (&b, "verstaue treibholz"), (&a, "lager"), (&a, "repariere"), (&b, "repariere hütte"), (&g, "repariere"),
		(&a, "baustelle"), (&b, "abriss"), (&a, "abriss die hütte"), (&a, "baustelle"), (&a, "inventory"),
		(&a, "bau hühnerstall"), (&a, "abriss baustelle"), (&a, "abriss"), (&a, "nachlass"), (&a, "verstaue muschel"), (&a, "entnimm muschel"),
	] { run(&mut w, who, line); }
	w.write(hut("h-3", "salzwiesen"));
	give(&mut w, &a, "muschel", 3);
	for (who, line) in [(&a, "verstaue muschel"), (&a, "verstaue muschel in hütte"), (&a, "verstaue muschel in 2"), (&a, "verstaue muschel in die hütte in den salzwiesen"), (&a, "verstaue muschel in die hütte in den dünen"), (&a, "verstaue muschel in die hütte am kai")] { run(&mut w, who, line); }
	// a ruin of someone else with its estate, and a warehouse in a closed settlement
	for x in [3.0, 4.0] { w.write(obj! { "type" => "Plot", "fields" => obj! { "room" => "graue-bucht", "x" => x, "y" => 9.0, "of" => "r-1" } }); }
	w.write(obj! { "type" => "Ruin", "fields" => obj! { "buildId" => "r-1", "plan" => "huette", "name" => "Hütte", "room" => "graue-bucht", "x" => 3.0, "y" => 9.0, "w" => 2.0, "h" => 1.0, "owner" => "c-old", "ownerName" => "Alte", "accountId" => "a-walk1", "untilWorldMs" => 9e15 } });
	w.write(obj! { "type" => "Estate", "fields" => obj! { "estateId" => "est-r-1", "accountId" => "a-walk1", "ownerName" => "Wanderer1", "room" => "graue-bucht", "name" => "Hütte", "untilWorldMs" => 9e15 } });
	give(&mut w, "est-r-1", "muschel", 2);
	for x in [19.0, 20.0, 21.0] { for y in [12.0, 13.0] { w.write(obj! { "type" => "Plot", "fields" => obj! { "room" => "graue-bucht", "x" => x, "y" => y, "of" => "l-1" } }); } }
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "l-1", "plan" => "lagerhaus", "name" => "Lagerhaus", "room" => "graue-bucht", "x" => 19.0, "y" => 12.0, "w" => 3.0, "h" => 2.0, "owner" => b.as_str(), "ownerName" => "Wanderer2", "accountId" => "a-walk2", "beaconId" => "feuer-bucht", "points" => 3.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	give(&mut w, &b, "muenze", 3);
	give(&mut w, &b, "treibholz", 6);
	w.write(obj! { "type" => "Plot", "fields" => obj! { "room" => "graue-bucht", "x" => 6.0, "y" => 11.0, "of" => "v-1" } });
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "v-1", "plan" => "vogelscheuche", "name" => "Vogelscheuche", "room" => "graue-bucht", "x" => 6.0, "y" => 11.0, "w" => 1.0, "h" => 1.0, "owner" => "c-walk1", "ownerName" => "Wanderer1", "accountId" => "a-walk1", "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	w.compare("ruin and warehouse");
	for (who, line) in [
		(&a, "move 5 10"), (&a, "truhe"), (&g, "move 5 8"), (&g, "abriss ruine"), (&a, "abriss ruine der hütte"), (&a, "nachlass"), (&a, "nachlass"),
		(&b, "move 18 13"), (&a, "move 18 11"), (&a, "lager"), (&b, "lager"), (&b, "verstaue 2 treibholz"), (&b, "verstaue treibholz ins lager"), (&b, "verstaue 3 holz"), (&b, "lager log"), (&b, "lager x"),
		(&b, "entnimm treibholz"), (&a, "verstaue treibholz"), (&b, "truhe"),
	] { run(&mut w, who, line); }
	w.write(obj! { "type" => "Settlement", "fields" => obj! { "room" => "graue-bucht", "name" => "Graubucht", "closed" => true, "members" => Json::Array(vec![obj! { "accountId" => "a-walk2", "rank" => "helfer" }]), "tax" => 1.0 } });
	for (who, line) in [(&a, "lager"), (&a, "liefere treibholz"), (&b, "lager"), (&b, "entnimm 2 treibholz"), (&b, "entnimm alle treibholz"), (&b, "lager"), (&b, "lager log"), (&b, "abriss lagerhaus"), (&a, "bau hütte")] { run(&mut w, who, line); }
	// the fire of the landing: out, then lit with its light used up
	run(&mut w, &d, "bau hütte");
	w.write(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-anleger", "until" => 9e15, "litAt" => 0.0 } });
	w.write(obj! { "type" => "LightUse", "fields" => obj! { "beaconId" => "feuer-anleger", "used" => 100.0 } });
	run(&mut w, &d, "bau hütte");
	run(&mut w, &d, "bau regentonne");
	assert!(said.iter().any(|r| r == "ran") && said.iter().filter(|r| r.starts_with("refused")).count() > 20, "{said:?}");
	assert!(w.entries_with("steht! Mitgebaut") >= 1, "the hut never stood");
}

/// Trade (trade.ts): offers between two with their refusals, the market board's listings and wanted notices (answered,
/// delivered for less, withdrawn), crafting with a tool that wears and breaks, the order board, and the ticks that post
/// orders, restock a trader and give back what lies in escrow for a listing that lapsed.
#[test]
fn trading() {
	let mut w = Walk::new("trading", 29, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (4.0, 12.0), true);
	let d = w.player_as(4, "anleger", (16.0, 4.0), true, false);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	give(&mut w, &a, "treibholz", 14);
	give(&mut w, &a, "muschel", 8);
	give(&mut w, &a, "muenze", 10);
	give(&mut w, &a, "tangseil", 2);
	give(&mut w, &b, "treibholz", 3);
	give(&mut w, &b, "muenze", 12);
	give(&mut w, &g, "treibholz", 1);
	w.compare("setup");
	let i = std::cell::Cell::new(0);
	let mut said = Vec::new();
	let mut run = |w: &mut Walk, who: &str, line: &str| {
		i.set(i.get() + 1);
		let i = i.get();
		w.at(START + i as f64 * 7_000.0);
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{i}: {who} {line} -> {r}"));
		said.push(r);
	};
	// offers
	for (who, line) in [
		(&d, "markt"), (&d, "order"), (&g, "offer treibholz an Wanderer1"), (&g, "accept"), (&g, "decline"),
		(&a, "offer"), (&a, "offer treibholz an Niemand"), (&a, "offer stein an Wanderer2"), (&a, "offer 20 treibholz an Wanderer2"), (&a, "offer treibhol an Wanderer2"),
		(&a, "offer 2 treibholz an Wanderer2 für 1 münze"), (&b, "decline Wanderer1"), (&b, "decline"), (&a, "offer muschel an Wanderer2"), (&b, "accept Wanderer1"),
		(&a, "offer 2 treibholz und muschel an Wanderer2 für 2 münzen, muschel"), (&b, "accept"), (&a, "offer treibholz an Wanderer2 für 3 perlen"), (&b, "accept"), (&b, "accept Niemand"),
		(&a, "offer zurück"), (&a, "offer zurück"), (&a, "offer 2 muscheln an Strandläufer-1003"), (&g, "decline"),
	] { run(&mut w, who, line); }
	// the market board: listings
	for (who, line) in [
		(&g, "markt"), (&g, "markt biete treibholz für 2"), (&a, "markt"), (&a, "markt biete treibholz für 0"), (&a, "markt biete"), (&a, "markt biete stein für 3"),
		(&a, "markt biete münze für 3"), (&a, "markt biete 3 treibholz für 5"), (&a, "markt biete muschel für 2 münzen"), (&a, "markt biete 30 muscheln für 9"), (&b, "markt biete treibholz um 1"), (&a, "markt"),
		(&b, "markt kaufe 9"), (&b, "markt kaufe muschel"), (&b, "markt kaufe gans"), (&a, "markt kaufe treibholz"), (&a, "markt kaufe 3 treibholz für 6"), (&b, "markt kaufe treibholz"),
		(&b, "markt kaufe 3 treibholz für 5"), (&a, "markt zurück 1"), (&a, "markt zurück 7"), (&b, "markt zurück 1"), (&a, "markt kaufe 1"),
		(&a, "markt biete 2 muscheln für 4"), (&a, "markt biete treibholz für 900"), (&b, "markt kaufe 2 muscheln für 3"), (&b, "markt kaufe 2"), (&b, "markt zurück 1"), (&a, "markt zurück 1"), (&a, "markt"), (&a, "markt hm"),
	] { run(&mut w, who, line); }
	// wanted notices
	for (who, line) in [
		(&a, "markt suche ziege für 5"), (&a, "markt suche gibtsnicht für 5"), (&a, "markt suche münze für 3"), (&a, "markt suche ziege"), (&a, "markt suche ziege für 5000"),
		(&a, "markt suche 2 treibholz für 3"), (&a, "markt suche netz für 2"), (&a, "markt suche spaten für 1"), (&a, "markt suche eine perle für 90"), (&a, "markt suche tang für 1"), (&a, "markt suche tang für 1"),
		(&a, "markt"), (&b, "markt antworte 1 ab 9"), (&b, "markt antworte 1 ab 3"), (&b, "markt antworte 1 keins"), (&b, "markt antworte 1 x"), (&b, "markt antworte 1 ab 5000"), (&a, "markt antworte 1 ab 9"),
		(&b, "markt antworte 1 ab 8"), (&a, "markt"), (&b, "markt liefere 1"), (&b, "markt liefere 9"), (&b, "markt liefere 2 x"), (&a, "markt liefere 2"), (&b, "markt liefere 3"),
		(&b, "markt liefere 2 für 2"), (&b, "markt suche zurück 1"), (&a, "markt suche zurück 9"), (&a, "markt suche zurück 1"), (&a, "markt"), (&a, "inventory"), (&b, "inventory"),
	] { run(&mut w, who, line); }
	// crafting, beside a workshop and without one
	for (who, line) in [
		(&g, "craft"), (&a, "craft gibtsnicht"), (&a, "craft muschelmesser"), (&a, "craft 25 netz"), (&a, "craft 0 netz"), (&a, "craft tuch"), (&a, "craft kaese"), (&a, "craft spaten"),
		(&a, "craft 2 netze"), (&a, "craft drei holzbündel"), (&a, "craft muschelmesser"), (&a, "craft 2 holzbuendel"), (&a, "craft tangseil"), (&a, "craft seil"), (&a, "baue hütte 30 30"), (&a, "inventory"),
	] { run(&mut w, who, line); }
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "ws-1", "plan" => "werkstatt", "name" => "Werkstatt", "room" => "graue-bucht", "x" => 5.0, "y" => 14.0, "w" => 2.0, "h" => 1.0, "owner" => b.as_str(), "ownerName" => "Wanderer2", "accountId" => "a-walk2", "beaconId" => "feuer-bucht", "points" => 3.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	give(&mut w, &a, "treibholz", 9);
	give(&mut w, &a, "muschel", 2);
	for (who, line) in [(&a, "craft muschelmesser"), (&a, "craft 3 holzbuendel"), (&a, "inventory")] { run(&mut w, who, line); }
	// the order board, with a site's and a store's orders on it
	for (who, line) in [(&a, "order"), (&a, "order nimm 1"), (&a, "order liefere")] { run(&mut w, who, line); }
	for _ in 0..4 { w.tick("orders"); }
	w.write(obj! { "type" => "SiteOrder", "fields" => obj! { "orderId" => "so-1", "buildId" => "s-9", "siteName" => "Hütte", "room" => "graue-bucht", "ownerName" => "Wanderer2", "proto" => "treibholz", "name" => "Treibholz", "left" => 2.0, "pay" => 1.0, "at" => 0.0 } });
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "k-1", "plan" => "kaufhaus", "name" => "Kaufhaus", "room" => "graue-bucht", "x" => 20.0, "y" => 12.0, "w" => 2.0, "h" => 2.0, "owner" => b.as_str(), "ownerName" => "Wanderer2", "accountId" => "a-walk2", "beaconId" => "feuer-bucht", "points" => 3.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	for (id, at) in [("so-k1", "k-1"), ("so-k2", "k-gone")] { w.write(obj! { "type" => "ShopOrder", "fields" => obj! { "shopOrderId" => id, "buildId" => at, "storeName" => "Kaufhaus", "ownerName" => "Wanderer2", "room" => "graue-bucht", "proto" => "muschel", "protoName" => "Muschel", "count" => 4.0, "reward" => 1.0 } }); }
	give(&mut w, &a, "muschel", 4);
	give(&mut w, &a, "treibholz", 4);
	for (who, line) in [
		(&a, "order"), (&g, "order nimm 1"), (&a, "order liefere"), (&a, "order nimm 9"), (&a, "order nimm 1"), (&a, "order nimm 2"), (&a, "order"), (&a, "order aufgeben"), (&a, "order aufgeben"),
		(&a, "order nimm 2"), (&a, "order x"), (&a, "order liefere"), (&b, "order nimm 1"), (&b, "order liefere"), (&a, "order"), (&a, "inventory"),
	] { run(&mut w, who, line); }
	// the market's tick: a lot whose listing lapsed goes back, a trader gets back what it sold
	w.write(obj! { "type" => "Item", "fields" => { let mut t = thing(&w.w, "t-lapsed", "perle", "market").get("fields").cloned().unwrap(); walk::j_set(&mut t, "listing", Json::from("l-gone")); walk::j_set(&mut t, "seller", Json::from(b.as_str())); t } });
	w.write(obj! { "type" => "Item", "fields" => { let mut t = thing(&w.w, "t-loose", "perle", "market").get("fields").cloned().unwrap(); walk::j_set(&mut t, "listing", Json::from("w-gone")); t } });
	assert!(w.take(obj! { "type" => "Item", "fields" => obj! { "location" => "npc-jorin", "proto" => "muschelmesser" } }), "Jorin's knife");
	w.tick("market");
	w.at(START + 30.0 * 3_600_000.0);
	w.tick("market");
	w.tick("market");
	w.compare("market ticks");
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 30 && said.iter().filter(|r| r.starts_with("refused")).count() > 30, "{said:?}");
	assert!(w.entries_with(r#""Restock""#) == 0 && w.entries_with("t-lapsed") == 1, "the ticks did nothing");
}

/// The small modules: eating (food.ts), offering at a chapel (chapel.ts), the signal fire chains (signal.ts), clearing
/// scenery (scenery.ts), breaking stone and cutting clay (quarry.ts), the wind with its tick (wind.ts), and the world's
/// clock for everyone and for an admin (clock.ts).
#[test]
fn small_things() {
	let mut w = Walk::new("small", 31, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (14.0, 8.0), true, false);
	let g = w.player(3, "graue-bucht", (4.0, 12.0), true);
	// b is the admin
	assert!(w.take(obj! { "type" => "Account", "fields" => obj! { "accountId" => "a-walk2" } }));
	w.write(obj! { "type" => "Account", "fields" => obj! { "accountId" => "a-walk2", "name" => "Wanderer2", "guest" => false, "admin" => true, "createdAt" => START, "touchedAt" => START } });
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize, wear: Option<f64>| { for _ in 0..k { n += 1; let t = thing(&world, &format!("t-{n}"), proto, to); let t = match wear { Some(x) => { let mut f = t.get("fields").cloned().unwrap(); walk::j_set(&mut f, "wear", Json::from(x)); obj! { "type" => "Item", "fields" => f } } None => t }; w.write(t); } };
	give(&mut w, &a, "brot", 1, None);
	give(&mut w, &a, "ei", 1, None);
	give(&mut w, &a, "treibholz", 1, None);
	give(&mut w, &a, "perle", 2, None);
	give(&mut w, &g, "ei", 1, None);
	w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "work.rest", "value" => 0.0 } });
	w.compare("setup");
	let i = std::cell::Cell::new(0);
	let mut said = Vec::new();
	let mut run = |w: &mut Walk, who: &str, line: &str| {
		i.set(i.get() + 1);
		let i = i.get();
		w.at(START + i as f64 * 11_000.0);
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{i}: {who} {line} -> {r}"));
		said.push(r);
	};
	let building = |id: &str, plan: &str, name: &str, room: &str, x: f64, y: f64, beacon: &str| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => plan, "name" => name, "room" => room, "x" => x, "y" => y, "w" => 2.0, "h" => 2.0, "owner" => "c-walk9", "ownerName" => "Jemand", "accountId" => "a-walk9", "beaconId" => beacon, "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	// eating and offering
	for (who, line) in [(&a, "iss"), (&a, "iss stein"), (&a, "iss treibholz"), (&a, "iss brot"), (&a, "iss ei"), (&g, "esse ei"), (&a, "opfere perle")] { run(&mut w, who, line); }
	w.write(building("k-1", "kapelle", "Kapelle", "graue-bucht", 6.0, 14.0, "feuer-bucht"));
	for (who, line) in [(&a, "opfere"), (&a, "opfere stein"), (&a, "opfere treibholz"), (&a, "opfere perle"), (&a, "opfere perle")] { run(&mut w, who, line); }
	// signal fires: none, a chain out, a chain lit, and the runs of the region
	run(&mut w, &a, "signalfeuer");
	w.write(building("sf-1", "signalfeuer", "Signalfeuer", "graue-bucht", 2.0, 14.0, "feuer-bucht"));
	w.write(building("sf-2", "signalfeuer", "Signalfeuer", "duenen", 3.0, 3.0, "feuer-anleger"));
	w.write(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-bucht", "until" => 9e15, "litAt" => 0.0 } });
	run(&mut w, &a, "signalfeuer");
	w.write(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-anleger", "until" => 9e15, "litAt" => 0.0 } });
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Graue Insel", "since" => 1.0, "best" => 5.0 } });
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Nebelholm", "since" => 0.0, "best" => 3_000_000.0 } });
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Kupferinsel", "since" => 0.0, "best" => 72.0 * 3_600_000.0 } });
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Leer", "since" => 0.0, "best" => 0.0 } });
	for (who, line) in [(&a, "signalfeuer"), (&g, "signale")] { run(&mut w, who, line); }
	// scenery beside b: the old boat in four works, the market stand stays
	for (who, line) in [(&a, "räume"), (&b, "räume 13 10"), (&b, "räume 1 1"), (&b, "räume"), (&b, "räume 14 6"), (&b, "räume"), (&b, "räume"), (&b, "räume"), (&b, "inventory")] { run(&mut w, who, line); }
	// a quarry and a clay pit beside a
	run(&mut w, &a, "breche");
	w.write(building("q-1", "steinbruch", "Steinbruch", "graue-bucht", 3.0, 12.0, "feuer-bucht"));
	w.write(building("q-2", "lehmgrube", "Lehmgrube", "graue-bucht", 5.0, 11.0, "feuer-bucht"));
	run(&mut w, &a, "breche");
	give(&mut w, &a, "spitzhacke", 1, Some(2.0));
	give(&mut w, &a, "spaten", 1, None);
	for (who, line) in [(&a, "breche"), (&a, "breche"), (&a, "breche"), (&a, "steche"), (&a, "stechen"), (&g, "steche"), (&a, "inventory")] { run(&mut w, who, line); }
	// the wind, the fog
	run(&mut w, &a, "wetter");
	for _ in 0..6 { w.tick("wind"); }
	run(&mut w, &a, "wetter");
	w.write(obj! { "type" => "Fog", "fields" => obj! { "room" => "graue-bucht", "level" => 2.0 } });
	for k in 0..8 { w.tick("wind"); if k % 2 == 1 { run(&mut w, &a, "wind"); } }
	// the clock
	for (who, line) in [
		(&a, "time"), (&a, "clock"), (&b, "clock"), (&b, "clock pause"), (&b, "clock pause"), (&a, "zeit"), (&b, "clock weiter"), (&b, "clock weiter"), (&b, "clock rate 0"),
		(&b, "clock rate"), (&b, "clock rate 2,5"), (&b, "clock verfall 3"), (&b, "clock verfall x"), (&b, "clock x"), (&b, "clock status"), (&b, "clock rate 1"), (&b, "clock verfall 1"), (&b, "uhr stand"), (&a, "time"),
	] { run(&mut w, who, line); }
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 25 && said.iter().filter(|r| r.starts_with("refused")).count() > 15, "{said:?}");
	assert!(w.entries_with("SceneryGone") == 1 && w.entries_with(r#""Blessing""#) == 1 && w.entries_with(r#""Sated""#) == 2, "nothing happened");
}
