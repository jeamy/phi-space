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

/// Registered player `n` stands somewhere else (its character taken and written again as the accounts write it).
fn stand(w: &mut Walk, n: usize, room: &str, x: f64, y: f64) {
	assert!(w.take(obj! { "type" => "Character", "fields" => obj! { "charId" => format!("c-walk{n}") } }));
	w.write(obj! { "type" => "Character", "fields" => obj! { "charId" => format!("c-walk{n}"), "accountId" => format!("a-walk{n}"), "name" => format!("Wanderer{n}"), "room" => room, "x" => x, "y" => y, "skin" => (n % 4) as f64, "guest" => false } });
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
		(&b, "liefere 2 treibholz"), (&a, "aushang 1 tangseil je 1"), (&a, "aushang ab"), (&a, "aushang ab"), (&a, "aushang 2 arbeit je 1"), (&a, "aushang 1 tangseil je 2"), (&b, "liefere muschel"), (&a, "liefere muschel"), (&a, "liefere 6 treibholz an die hütte"), (&a, "liefere treibholz"), (&a, "aushang 1 treibholz je 1"), (&a, "liefere tangseil zur baustelle"),
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
		(&a, "offer treibholz an Wanderer2"), (&a, "offer muschel an Wanderer2"), (&a, "offer zurück"),
	] { run(&mut w, who, line); }
	// an offer whose things are gone, one whose giver left, one of a guest
	give(&mut w, &a, "perle", 1);
	for (who, line) in [(&a, "offer perle an Wanderer2"), (&a, "drop perle"), (&b, "accept"), (&a, "get perle"), (&a, "offer muschel an Wanderer2")] { run(&mut w, who, line); }
	stand(&mut w, 1, "duenen", 5.0, 5.0);
	run(&mut w, &b, "accept");
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	w.write(obj! { "type" => "Offer", "fields" => obj! { "offerId" => "o-g", "from" => g.as_str(), "fromName" => "Strandläufer-1003", "to" => b.as_str(), "toName" => "Wanderer2", "give" => Json::Array(vec![Json::from("t-50")]), "giveNames" => Json::Array(vec![Json::from("Treibholz")]), "want" => Json::Array(vec![]), "room" => "graue-bucht", "at" => 1.0 } });
	run(&mut w, &b, "accept Strandläufer-1003");
	// the market board: listings
	for (who, line) in [
		(&g, "markt"), (&g, "markt biete treibholz für 2"), (&a, "markt"), (&a, "markt biete treibholz für 0"), (&a, "markt biete"), (&a, "markt biete stein für 3"),
		(&a, "markt biete münze für 3"), (&a, "markt biete 3 treibholz für 5"), (&a, "markt biete muschel für 2 münzen"), (&a, "markt biete 30 muscheln für 9"), (&b, "markt biete treibholz um 1"), (&a, "markt"),
		(&b, "markt kaufe 9"), (&b, "markt kaufe muschel"), (&b, "markt kaufe gans"), (&a, "markt kaufe treibholz"), (&a, "markt kaufe 3 treibholz für 6"), (&b, "markt kaufe treibholz"),
		(&b, "markt kaufe 3 treibholz für 5"), (&a, "markt zurück 1"), (&a, "markt zurück 7"), (&b, "markt zurück 1"), (&a, "markt kaufe 1"),
		(&a, "markt biete 2 muscheln für 4"), (&a, "markt biete treibholz für 900"), (&b, "markt kaufe 2 muscheln für 3"), (&b, "markt kaufe 2"), (&b, "markt zurück 1"), (&a, "markt zurück 1"), (&a, "markt"), (&a, "markt hm"),
		(&a, "markt kaufe"), (&a, "markt zurück 1"),
	] { run(&mut w, who, line); }
	// the cheapest of two lots, one who cannot pay a single coin, a lot by its count and price, one's own by number
	stand(&mut w, 4, "graue-bucht", 8.0, 12.0);
	give(&mut w, &b, "muschel", 1);
	for (who, line) in [(&b, "markt biete muschel für 1"), (&a, "markt biete muschel für 2"), (&d, "markt kaufe muschel"), (&a, "markt kaufe 1 muschel für 1"), (&a, "markt kaufe 1"), (&a, "markt zurück 1")] { run(&mut w, who, line); }
	// a lot from one's chest
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "h-a", "plan" => "huette", "name" => "Hütte", "room" => "graue-bucht", "x" => 20.0, "y" => 2.0, "w" => 2.0, "h" => 2.0, "owner" => a.as_str(), "ownerName" => "Wanderer1", "accountId" => "a-walk1", "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	give(&mut w, "h-a", "muschel", 2);
	for (who, line) in [(&a, "markt biete muschel aus hütte für 3"), (&a, "markt biete stein aus hütte für 3"), (&a, "markt"), (&a, "markt zurück 1"), (&a, "truhe")] { run(&mut w, who, line); }
	// wanted notices
	for (who, line) in [
		(&a, "markt suche ziege für 5"), (&a, "markt suche gibtsnicht für 5"), (&a, "markt suche münze für 3"), (&a, "markt suche ziege"), (&a, "markt suche ziege für 5000"),
		(&a, "markt suche 2 treibholz für 3"), (&a, "markt suche netz für 2"), (&a, "markt suche spaten für 1"), (&a, "markt suche eine perle für 90"), (&a, "markt suche tang für 1"), (&a, "markt suche tang für 1"),
		(&a, "markt"), (&b, "markt antworte 1 ab 9"), (&b, "markt antworte 1 ab 3"), (&b, "markt antworte 1 keins"), (&b, "markt antworte 1 x"), (&b, "markt antworte 1 ab 5000"), (&a, "markt antworte 1 ab 9"),
		(&b, "markt antworte 1 ab 8"), (&a, "markt"), (&b, "markt liefere 1"), (&b, "markt liefere 9"), (&b, "markt liefere 2 x"), (&a, "markt liefere 2"), (&b, "markt liefere 3"),
		(&b, "markt liefere 2 für 2"), (&b, "markt suche zurück 1"), (&a, "markt suche zurück 9"), (&a, "markt suche zurück 1"), (&a, "markt"), (&a, "inventory"), (&b, "inventory"),
		(&a, "markt suche"), (&a, "markt suche 2 muscheln für 4"), (&b, "markt antworte 4 ab 7"), (&d, "markt antworte 4 keins"), (&a, "markt"), (&d, "markt liefere 4"),
	] { run(&mut w, who, line); }
	give(&mut w, &d, "muschel", 1);
	run(&mut w, &d, "markt liefere 4");
	give(&mut w, &d, "muschel", 1);
	for (who, line) in [(&d, "markt liefere 4"), (&a, "markt")] { run(&mut w, who, line); }
	// crafting, beside a workshop and without one: a knife without wear breaks at once, then there is none
	give(&mut w, &a, "muschelmesser", 1);
	give(&mut w, &a, "treibholz", 6);
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "wb-1", "plan" => "webstuhl", "name" => "Webstuhl", "room" => "graue-bucht", "x" => 24.0, "y" => 8.0, "w" => 2.0, "h" => 1.0, "owner" => b.as_str(), "ownerName" => "Wanderer2", "accountId" => "a-walk2", "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	for (who, line) in [(&a, "craft holzbuendel"), (&a, "craft holzbuendel")] { run(&mut w, who, line); }
	for (who, line) in [
		(&g, "craft"), (&a, "craft gibtsnicht"), (&a, "craft muschelmesser"), (&a, "craft 25 netz"), (&a, "craft 0 netz"), (&a, "craft tuch"), (&a, "craft kaese"), (&a, "craft spaten"),
		(&a, "craft 2 netze"), (&a, "craft drei holzbündel"), (&a, "craft muschelmesser"), (&a, "craft 2 holzbuendel"), (&a, "craft tangseil"), (&a, "craft seil"), (&a, "baue hütte 30 30"), (&a, "inventory"),
	] { run(&mut w, who, line); }
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "ws-1", "plan" => "werkstatt", "name" => "Werkstatt", "room" => "graue-bucht", "x" => 5.0, "y" => 14.0, "w" => 2.0, "h" => 1.0, "owner" => b.as_str(), "ownerName" => "Wanderer2", "accountId" => "a-walk2", "beaconId" => "feuer-bucht", "points" => 3.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	give(&mut w, &a, "treibholz", 9);
	give(&mut w, &a, "muschel", 2);
	for (who, line) in [(&a, "craft muschelmesser"), (&a, "craft 3 holzbuendel"), (&a, "craft 9 muschelmesser"), (&a, "inventory")] { run(&mut w, who, line); }
	// the order board, with a site's and a store's orders on it
	for (who, line) in [(&a, "order"), (&a, "order nimm 1"), (&a, "order liefere")] { run(&mut w, who, line); }
	for _ in 0..4 { w.tick("orders"); }
	w.write(obj! { "type" => "SiteOrder", "fields" => obj! { "orderId" => "so-1", "buildId" => "s-9", "siteName" => "Hütte", "room" => "graue-bucht", "ownerName" => "Wanderer2", "proto" => "treibholz", "name" => "Treibholz", "left" => 2.0, "pay" => 1.0, "at" => 0.0 } });
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "k-1", "plan" => "kaufhaus", "name" => "Kaufhaus", "room" => "graue-bucht", "x" => 20.0, "y" => 12.0, "w" => 2.0, "h" => 2.0, "owner" => b.as_str(), "ownerName" => "Wanderer2", "accountId" => "a-walk2", "beaconId" => "feuer-bucht", "points" => 3.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	for (id, at, reward) in [("so-k1", "k-1", 1.0), ("so-k2", "k-gone", 1.0), ("so-k3", "k-1", 3.0)] { w.write(obj! { "type" => "ShopOrder", "fields" => obj! { "shopOrderId" => id, "buildId" => at, "storeName" => "Kaufhaus", "ownerName" => "Wanderer2", "room" => "graue-bucht", "proto" => "muschel", "protoName" => "Muschel", "count" => 4.0, "reward" => reward } }); }
	w.write(obj! { "type" => "Order", "fields" => obj! { "orderId" => "j-zz", "kind" => "buendel", "text" => "Ein Bündel.", "needs" => Json::Array(vec![obj! { "proto" => "holzbuendel", "count" => 1.0 }]), "reward" => obj! { "proto" => "muenze", "count" => 2.0 }, "takenBy" => "", "room" => "graue-bucht", "expiresWorldMs" => 9e15 } });
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
	w.tick("market");
	w.at(START + 30.0 * 3_600_000.0);
	w.tick("market");
	w.tick("market");
	// a restock entry for what the trader has again goes
	w.write(obj! { "type" => "Restock", "fields" => obj! { "charId" => "npc-jorin", "proto" => "muschelmesser", "nextWorldMs" => 0.0 } });
	w.tick("market");
	w.compare("market ticks");
	// lots and notices posted at the same moment, in the order of their ids
	for id in ["l-t2", "l-t1"] { w.write(obj! { "type" => "Listing", "fields" => obj! { "listingId" => id, "seller" => "c-x", "sellerName" => "X", "itemId" => "i-x", "itemName" => "Perle", "price" => 5.0, "room" => "graue-bucht", "at" => 1.0, "expiresWorldMs" => 9e15 } }); }
	for id in ["w-t2", "w-t1"] { w.write(obj! { "type" => "Wanted", "fields" => obj! { "wantedId" => id, "buyer" => "c-x", "buyerName" => "X", "proto" => "perle", "protoName" => "Perle", "price" => 5.0, "room" => "graue-bucht", "at" => 1.0, "expiresWorldMs" => 9e15 } }); }
	run(&mut w, &a, "markt");
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
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Nordinsel", "since" => 0.0, "best" => 3_600_000.0 } });
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Westinsel", "since" => 0.0, "best" => 60_000.0 } });
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Ostinsel", "since" => 0.0, "best" => 60_000.0 } });
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Kupferinsel", "since" => 0.0, "best" => 72.0 * 3_600_000.0 } });
	w.write(obj! { "type" => "FireChain", "fields" => obj! { "island" => "Leer", "since" => 0.0, "best" => 0.0 } });
	for (who, line) in [(&a, "signalfeuer"), (&g, "signale")] { run(&mut w, who, line); }
	// scenery beside b: the old boat in four works, the market stand stays
	for (who, line) in [(&a, "räume"), (&b, "räume 13 10"), (&b, "räume 1 1"), (&b, "räume"), (&b, "räume 14 6"), (&b, "räume"), (&b, "räume"), (&b, "räume"), (&b, "inventory")] { run(&mut w, who, line); }
	w.write(obj! { "type" => "Scenery", "fields" => obj! { "sceneryId" => "s-fass", "room" => "graue-bucht", "x" => 15.0, "y" => 9.0, "w" => 1.0, "h" => 1.0, "model" => "fass", "name" => "Fass", "work" => 1.0, "left" => 1.0, "yields" => Json::Array(vec![]) } });
	run(&mut w, &b, "räume");
	// a quarry and a clay pit beside a
	run(&mut w, &a, "breche");
	w.write(building("q-1", "steinbruch", "Steinbruch", "graue-bucht", 3.0, 12.0, "feuer-bucht"));
	w.write(building("q-2", "lehmgrube", "Lehmgrube", "graue-bucht", 5.0, 11.0, "feuer-bucht"));
	run(&mut w, &a, "breche");
	give(&mut w, &a, "spitzhacke", 1, Some(2.0));
	give(&mut w, &a, "spaten", 1, None);
	for (who, line) in [(&a, "breche"), (&a, "breche"), (&a, "breche"), (&a, "steche"), (&a, "stechen"), (&g, "steche"), (&a, "inventory")] { run(&mut w, who, line); }
	// a salt garden needs no tool; what the buildings beside one make (craft hier), a steak that spoils, a bag that carries more
	run(&mut w, &a, "harke");
	w.write(building("sg-1", "salzgarten", "Salzgarten", "graue-bucht", 4.0, 14.0, "feuer-bucht"));
	for (who, line) in [(&a, "harke"), (&a, "salz"), (&g, "harke"), (&b, "craft hier"), (&a, "craft hier")] { run(&mut w, who, line); }
	w.write(building("hu-1", "huette", "Hütte", "graue-bucht", 13.0, 9.0, "feuer-bucht"));
	w.write(building("ws-1", "werkstatt", "Werkstatt", "graue-bucht", 15.0, 6.0, "feuer-bucht"));
	run(&mut w, &b, "craft hier");
	give(&mut w, &b, "rinderfilet", 1, None);
	give(&mut w, &b, "treibholz", 3, None);
	give(&mut w, &b, "ledertasche", 1, None);
	for (who, line) in [(&b, "craft here"), (&b, "craft steak"), (&b, "craft"), (&b, "inventory")] { run(&mut w, who, line); }
	// a load that grows with the bag carried: the pack's limit counts it
	w.write(obj! { "type" => "Scenery", "fields" => obj! { "sceneryId" => "s-kiste", "room" => "graue-bucht", "x" => 13.0, "y" => 7.0, "w" => 1.0, "h" => 1.0, "model" => "kiste", "name" => "Kiste", "work" => 1.0, "left" => 1.0, "yields" => Json::Array(vec![obj! { "proto" => "treibholz", "count" => 3.0 }]) } });
	run(&mut w, &b, "räume");
	// the wind, the fog
	run(&mut w, &a, "wetter");
	for _ in 0..6 { w.tick("wind"); }
	run(&mut w, &a, "wetter");
	w.write(obj! { "type" => "Fog", "fields" => obj! { "room" => "graue-bucht", "level" => 2.0 } });
	for k in 0..8 { w.tick("wind"); if k % 2 == 1 { run(&mut w, &a, "wind"); } }
	for level in [3.0, 0.0, 7.0] {
		w.take(obj! { "type" => "Wind", "fields" => obj! { "island" => "Graue Insel" } });
		w.write(obj! { "type" => "Wind", "fields" => obj! { "island" => "Graue Insel", "level" => level } });
		run(&mut w, &a, "wetter");
	}
	assert!(w.take(obj! { "type" => "Fog", "fields" => obj! { "room" => "graue-bucht" } }));
	run(&mut w, &a, "wetter");
	w.call("stormRaisesWind", Some("graue-bucht"));
	w.call("stormRaisesWind", Some("graue-bucht"));
	w.call("stormRaisesWind", None);
	w.tick("wind");
	run(&mut w, &a, "wetter");
	// the clock
	for (who, line) in [
		(&a, "time"), (&a, "clock"), (&b, "clock"), (&b, "clock pause"), (&b, "clock pause"), (&a, "zeit"), (&b, "clock weiter"), (&b, "clock weiter"), (&b, "clock rate 0"),
		(&b, "clock rate"), (&b, "clock rate 2,5"), (&b, "clock verfall 3"), (&b, "clock verfall x"), (&b, "clock x"), (&b, "clock status"), (&b, "clock rate 1"), (&b, "clock verfall 1"), (&b, "uhr stand"), (&a, "time"), (&b, "clock rate 0,5"), (&b, "clock rate 1"),
	] { run(&mut w, who, line); }
	w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "year.days", "value" => 0.0 } });
	run(&mut w, &a, "time");
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 25 && said.iter().filter(|r| r.starts_with("refused")).count() > 15, "{said:?}");
	let counts = (w.entries_with("SceneryGone"), w.entries_with(r#""Blessing""#), w.entries_with(r#""Sated""#));
	assert_eq!(counts, (3, 1, 2), "nothing happened");
}

/// Settlements and their hall (settlement.ts, epoch.ts, townhall.ts): founding one with its refusals, taking in and letting
/// go, closing and opening, the rank of the region's settlements, the island's epoch, motions with their votes, and the
/// ticks of the epoch job that decide the motions, count the epoch and end a settlement whose huts are gone.
#[test]
fn settling() {
	let mut w = Walk::new("settling", 37, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (4.0, 12.0), true);
	let e = w.player_as(4, "graue-bucht", (6.0, 11.0), true, false);
	let d = w.player_as(5, "anleger", (16.0, 4.0), true, false);
	let at_room = |id: &str, plan: &str, name: &str, room: &str, x: f64, y: f64, wh: (f64, f64), owner: usize, points: Option<f64>| {
		let mut f = obj! { "buildId" => id, "plan" => plan, "name" => name, "room" => room, "x" => x, "y" => y, "w" => wh.0, "h" => wh.1, "owner" => format!("c-walk{owner}"), "ownerName" => format!("Wanderer{owner}"), "accountId" => format!("a-walk{owner}"), "beaconId" => "feuer-bucht", "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 };
		if let Some(p) = points { walk::j_set(&mut f, "points", Json::from(p)); }
		obj! { "type" => "Building", "fields" => f }
	};
	let building = |id: &str, plan: &str, name: &str, x: f64, y: f64, wh: (f64, f64), owner: usize| at_room(id, plan, name, "graue-bucht", x, y, wh, owner, Some(1.0));
	w.write(building("h-1", "huette", "Hütte", 8.0, 15.0, (2.0, 2.0), 1));
	w.write(building("h-2", "huette", "Hütte", 11.0, 15.0, (2.0, 2.0), 1));
	w.write(obj! { "type" => "Field", "fields" => obj! { "fieldId" => "f-1", "room" => "graue-bucht", "points" => 2.0, "untilWorldMs" => 9e15 } });
	w.write(obj! { "type" => "Bed", "fields" => obj! { "bedId" => "b-1", "room" => "graue-bucht", "untilWorldMs" => 9e15 } });
	w.write(obj! { "type" => "Bed", "fields" => obj! { "bedId" => "b-2", "room" => "graue-bucht", "untilWorldMs" => 1.0 } });
	w.compare("setup");
	let i = std::cell::Cell::new(0);
	let mut said = Vec::new();
	let mut run = |w: &mut Walk, who: &str, line: &str| {
		i.set(i.get() + 1);
		let i = i.get();
		w.at(START + i as f64 * 9_000.0);
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{i}: {who} {line} -> {r}"));
		said.push(r);
	};
	run(&mut w, &a, "siedlung gründen Graubucht");
	w.write(building("h-3", "huette", "Hütte", 20.0, 12.0, (2.0, 2.0), 2));
	for (who, line) in [
		(&a, "siedlung rang"), (&a, "siedlung"), (&g, "siedlung gründen Graubucht"), (&e, "siedlung gründen Graubucht"), (&a, "siedlung gründen X"), (&a, "siedlung zu"), (&a, "siedlung gründen  Graue   Bucht "),
		(&b, "siedlung gründen Zweite"), (&a, "siedlung"), (&a, "siedlung rang"), (&a, "siedlung x"), (&e, "siedlung zu"), (&a, "siedlung zu"), (&a, "siedlung schließen"), (&g, "siedlung"),
		(&a, "siedlung aufnehmen"), (&a, "siedlung aufnehmen Niemand"), (&a, "siedlung aufnehmen wanderer4 als helfer"), (&a, "siedlung aufnehmen Strandläufer-1003 auf"), (&a, "siedlung"), (&e, "siedlung"),
		(&a, "siedlung aufnehmen Wanderer4 siedler"), (&e, "siedlung"), (&a, "siedlung entlassen Niemand"), (&a, "siedlung entlassen wanderer4"), (&a, "siedlung offen"), (&d, "siedlung"),
		(&a, "epoche"), (&d, "epoch"),
	] { run(&mut w, who, line); }
	// a guest with a hut is a helper at most
	w.write(building("h-g", "huette", "Hütte", 14.0, 15.0, (2.0, 2.0), 3));
	run(&mut w, &g, "siedlung");
	for force in [3.0, 4.0, 5.0] {
		w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "epoch.force", "value" => force } });
		run(&mut w, &a, "epoche");
	}
	w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "epoch.force", "value" => 0.0 } });
	// the rank: a park tended, a store's turnover, a building without points, and a settlement in the dunes with two parks
	w.write(obj! { "type" => "ParkCare", "fields" => obj! { "room" => "graue-bucht", "charId" => "c-walk1", "lastWorldMs" => 9e15 } });
	w.write(building("p-1", "park", "Park", 14.0, 2.0, (4.0, 4.0), 2));
	w.write(obj! { "type" => "Building", "fields" => { let mut f = building("sh-1", "kaufhaus", "Kaufhaus", 24.0, 2.0, (2.0, 2.0), 2).get("fields").cloned().unwrap(); walk::j_set(&mut f, "turnover", Json::from(45.0)); f } });
	w.write(at_room("x-1", "brunnen", "Brunnen", "graue-bucht", 24.0, 5.0, (1.0, 1.0), 2, None));
	w.write(obj! { "type" => "Settlement", "fields" => obj! { "settlementId" => "s-d", "name" => "Dünendorf", "nameKey" => "dünendorf", "room" => "duenen", "founder" => "a-walk9", "founderName" => "Jemand", "members" => Json::Array(vec![]), "closed" => false, "at" => 0.0 } });
	w.write(obj! { "type" => "SettlementName", "fields" => obj! { "nameKey" => "dünendorf" } });
	w.write(obj! { "type" => "Zone", "fields" => obj! { "zoneId" => "z-d", "room" => "duenen", "settlementId" => "s-d", "kind" => "gruen", "x" => 1.0, "y" => 1.0, "w" => 2.0, "h" => 2.0 } });
	for (id, x) in [("p-d1", 2.0), ("p-d2", 8.0)] { w.write(at_room(id, "park", "Park", "duenen", x, 2.0, (4.0, 4.0), 2, Some(1.0))); }
	for (who, line) in [(&a, "siedlung rang"), (&a, "epoche")] { run(&mut w, who, line); }
	// the hall
	for (who, line) in [(&a, "antrag"), (&a, "antrag zu"), (&a, "antrag grünzone"), (&a, "antrag abriss"), (&a, "stimme ja"), (&d, "stimme ja")] { run(&mut w, who, line); }
	w.write(building("r-1", "rathaus", "Rathaus", 1.0, 12.0, (4.0, 3.0), 2));
	let long = format!("antrag {}", "lang ".repeat(30));
	for (who, line) in [
		(&e, "antrag zu"), (&a, "antrag steuer 9"), (&a, "antrag offen"), (&a, long.as_str()), (&a, "antrag abriss"), (&a, "siedlung zu"), (&a, "antrag zu"), (&a, "antrag"),
		(&a, "antrag offen"), (&b, "stimme ja"), (&b, "stimme nein"), (&b, "stimme vielleicht"), (&e, "stimme ja"), (&g, "stimme ja"), (&a, "antrag"),
	] { run(&mut w, who, line); }
	let drop_motion = |w: &mut Walk| { assert!(w.take(obj! { "type" => "Motion", "fields" => obj! { "room" => "graue-bucht" } })); };
	drop_motion(&mut w);
	for line in ["antrag grünzone", "antrag zone frei", "antrag steuer 3", "antrag wegerecht", "antrag das Dorf soll blühen"] { run(&mut w, &a, line); run(&mut w, &a, "antrag"); drop_motion(&mut w); }
	stand(&mut w, 1, "graue-bucht", 19.0, 11.0);
	for line in ["antrag zu", "antrag abriss", "antrag", "stimme ja"] { run(&mut w, &a, line); }
	drop_motion(&mut w);
	w.write(building("l-1", "lagerhaus", "Lagerhaus", 22.0, 9.0, (3.0, 2.0), 2));
	stand(&mut w, 1, "graue-bucht", 21.0, 11.0);
	run(&mut w, &a, "antrag abriss");
	w.write(thing(&w.w.clone(), "t-in", "treibholz", "l-1"));
	stand(&mut w, 1, "graue-bucht", 23.0, 8.0);
	run(&mut w, &a, "antrag abriss");
	stand(&mut w, 1, "graue-bucht", 12.0, 5.0);
	run(&mut w, &a, "antrag abriss");
	stand(&mut w, 4, "graue-bucht", 2.0, 11.0);
	run(&mut w, &e, "antrag zu");
	// closed, with a tax and zones (as carried motions leave it): the hall decides, a hut in the green zone is refused
	let s = w.peek(obj! { "type" => "Settlement", "fields" => obj! { "room" => "graue-bucht" } }).expect("the settlement");
	let mut sf = s.get("fields").cloned().unwrap();
	walk::j_set(&mut sf, "closed", Json::Bool(true));
	walk::j_set(&mut sf, "tax", Json::from(2.0));
	assert!(w.take(obj! { "type" => "Settlement", "fields" => obj! { "room" => "graue-bucht" } }));
	w.write(obj! { "type" => "Settlement", "fields" => sf });
	w.write(obj! { "type" => "Zone", "fields" => obj! { "zoneId" => "z-g", "room" => "graue-bucht", "kind" => "gruen", "x" => 2.0, "y" => 2.0, "w" => 3.0, "h" => 3.0 } });
	w.write(obj! { "type" => "Zone", "fields" => obj! { "zoneId" => "z-w", "room" => "graue-bucht", "kind" => "weg", "x" => 6.0, "y" => 2.0, "w" => 2.0, "h" => 2.0 } });
	w.write(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-bucht", "until" => 9e15, "litAt" => 0.0 } });
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	for (who, line) in [(&a, "siedlung"), (&a, "antrag zu"), (&a, "siedlung offen"), (&a, "bau hütte 2 2"), (&a, "bau hütte 6 2")] { run(&mut w, who, line); }
	// the count of the motions, a day later: a tax carried, a green zone tied, the zones lifted, demolitions
	let day = |w: &mut Walk| { i.set(i.get() + 10_000); w.at(START + i.get() as f64 * 9_000.0); };
	let decide = |w: &mut Walk, votes: &[(&str, bool)]| {
		let m = w.peek(obj! { "type" => "Motion", "fields" => obj! { "room" => "graue-bucht" } }).expect("a motion");
		let id = m.get("fields").and_then(|f| f.get("motionId")).cloned().unwrap();
		for (acc, yes) in votes {
			w.take(obj! { "type" => "Vote", "fields" => obj! { "motionId" => id.clone(), "accountId" => *acc } });
			w.write(obj! { "type" => "Vote", "fields" => obj! { "motionId" => id.clone(), "accountId" => *acc, "yes" => *yes } });
		}
		day(w);
		let ended = w.call("motionTick", None);
		eprintln!("motionTick -> {}", ended.to_json_text());
	};
	run(&mut w, &a, "antrag steuer 3");
	decide(&mut w, &[("a-walk2", true)]);
	run(&mut w, &a, "antrag grünzone");
	decide(&mut w, &[("a-walk2", false)]);
	// a green zone carried; the count before its end leaves it open
	run(&mut w, &a, "antrag grünzone");
	assert_eq!(w.call("motionTick", None), Json::from(0.0), "not yet");
	decide(&mut w, &[("a-walk2", true)]);
	run(&mut w, &a, "antrag zone frei");
	decide(&mut w, &[("a-walk2", true)]);
	run(&mut w, &a, "antrag offen");
	decide(&mut w, &[]);
	// the hut goes; the warehouse is emptied for the motion and filled again before the count; the next hut is gone first
	stand(&mut w, 1, "graue-bucht", 19.0, 11.0);
	run(&mut w, &a, "antrag abriss");
	decide(&mut w, &[("a-walk2", true)]);
	assert!(w.take(obj! { "type" => "Item", "fields" => obj! { "itemId" => "t-in" } }));
	stand(&mut w, 1, "graue-bucht", 23.0, 8.0);
	run(&mut w, &a, "antrag abriss");
	let t = thing(&w.w.clone(), "t-in", "treibholz", "l-1");
	w.write(t);
	decide(&mut w, &[("a-walk2", true)]);
	w.write(building("h-7", "huette", "Hütte", 20.0, 12.0, (2.0, 2.0), 2));
	stand(&mut w, 1, "graue-bucht", 19.0, 11.0);
	run(&mut w, &a, "antrag abriss");
	assert!(w.take(obj! { "type" => "Building", "fields" => obj! { "buildId" => "h-7" } }));
	decide(&mut w, &[("a-walk2", true)]);
	run(&mut w, &a, "siedlung");
	// a motion whose settlement is gone lapses
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	run(&mut w, &a, "antrag zu");
	let s = w.peek(obj! { "type" => "Settlement", "fields" => obj! { "room" => "graue-bucht" } }).expect("the settlement");
	assert!(w.take(obj! { "type" => "Settlement", "fields" => obj! { "room" => "graue-bucht" } }));
	decide(&mut w, &[]);
	w.write(obj! { "type" => "Settlement", "fields" => s.get("fields").cloned().unwrap() });
	// the epoch: the stock reaches a village, the count follows; it decays and falls back
	w.write(at_room("big-1", "werkstatt", "Werkstatt", "graue-bucht", 26.0, 12.0, (2.0, 1.0), 2, Some(20.0)));
	run(&mut w, &a, "epoche");
	assert_eq!(w.call("epochTick", None).as_array().map(Vec::len), Some(1), "the island rose");
	assert_eq!(w.call("epochTick", None).as_array().map(Vec::len), Some(0), "nothing changed");
	run(&mut w, &a, "epoche");
	assert!(w.take(obj! { "type" => "Building", "fields" => obj! { "buildId" => "big-1" } }));
	assert_eq!(w.call("epochTick", None).as_array().map(Vec::len), Some(1), "the island fell back");
	w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "epoch.force", "value" => 3.0 } });
	w.call("epochTick", None);
	w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "epoch.force", "value" => 0.0 } });
	w.call("epochTick", None);
	// the settlements: the dunes have no huts, then Graue Bucht loses its own; the name is free again
	assert_eq!(w.call("settlementTick", None), Json::from(1.0), "the dunes' settlement");
	for h in ["h-1", "h-2"] { assert!(w.take(obj! { "type" => "Building", "fields" => obj! { "buildId" => h } })); }
	assert_eq!(w.call("settlementTick", None), Json::from(1.0), "Graue Bucht");
	assert_eq!(w.call("settlementTick", None), Json::from(0.0), "nothing left");
	for (id, x) in [("h-4", 8.0), ("h-5", 11.0)] { w.write(building(id, "huette", "Hütte", x, 15.0, (2.0, 2.0), 1)); }
	w.write(building("h-6", "huette", "Hütte", 17.0, 15.0, (2.0, 2.0), 2));
	for (who, line) in [(&a, "siedlung"), (&a, "siedlung gründen Graue Bucht"), (&a, "siedlung rang")] { run(&mut w, who, line); }
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 30 && said.iter().filter(|r| r.starts_with("refused")).count() > 20, "{said:?}");
	assert!(w.entries_with(r#""Settlement""#) >= 1 && w.entries_with(r#""Epoch""#) >= 1, "nothing was founded or counted");
}
