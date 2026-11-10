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

/// The windmill (mill.ts): grinding with its refusals (no mill, not grain, nothing carried, too many sacks, none left), loads
/// that queue one after the other, a gale that grinds faster, a storm surge that grinds ahead on its island only, fetching
/// from too far, too early, in part and in whole, and the oven's recipes named with backe.
#[test]
fn milling() {
	let mut w = Walk::new("milling", 37, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (12.0, 8.0), true);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	give(&mut w, &a, "weizen", 15);
	give(&mut w, &a, "gerste", 2);
	give(&mut w, &a, "knochen", 1);
	give(&mut w, &a, "treibholz", 2);
	give(&mut w, &a, "wasserkanne", 1);
	give(&mut w, &b, "weizen", 3);
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| {
		step += 1;
		at.set(at.get() + 11_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r);
	};
	let building = |id: &str, plan: &str, name: &str, room: &str, x: f64, y: f64| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => plan, "name" => name, "room" => room, "x" => x, "y" => y, "w" => 2.0, "h" => 2.0, "owner" => "c-walk9", "ownerName" => "Jemand", "accountId" => "a-walk9", "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	for (who, line) in [(&a, "mahle"), (&a, "mahle weizen"), (&a, "abholen"), (&a, "backe"), (&a, "backe kuchen"), (&a, "backe laib")] { run(&mut w, who, line, 0.0); }
	w.write(building("m-1", "windmuehle", "Windmühle", "graue-bucht", 5.0, 11.0));
	w.write(building("m-2", "windmuehle", "Windmühle", "duenen", 3.0, 3.0));
	w.write(building("m-3", "windmuehle", "Windmühle", "kupferhafen-markt", 3.0, 3.0));
	w.write(obj! { "type" => "MillLoad", "fields" => obj! { "loadId" => "ml-2", "buildId" => "m-2", "room" => "duenen", "x" => 3.0, "y" => 3.0, "w" => 2.0, "h" => 2.0, "charId" => "c-walk9", "name" => "Jemand", "from" => "weizen", "to" => "mehl", "count" => 4.0, "readyWorldMs" => 9e13, "untilWorldMs" => 9e15 } });
	w.write(obj! { "type" => "MillLoad", "fields" => obj! { "loadId" => "ml-3", "buildId" => "m-3", "room" => "kupferhafen-markt", "x" => 3.0, "y" => 3.0, "w" => 2.0, "h" => 2.0, "charId" => "c-walk9", "name" => "Jemand", "from" => "weizen", "to" => "mehl", "count" => 4.0, "readyWorldMs" => 9e13, "untilWorldMs" => 9e15 } });
	for (who, line) in [
		(&g, "mahle"), (&g, "mahle weizen"), (&a, "mahle"), (&a, "mahle treibholz"), (&a, "mahle stein"), (&a, "mahle 3 weizen"), (&a, "mahle"),
		(&b, "mahle 0 weizen"), (&b, "mühle"), (&b, "mahle das weizen"), (&b, "mahle"), (&a, "abholen"),
	] { run(&mut w, who, line, 0.0); }
	w.take(obj! { "type" => "Wind", "fields" => obj! { "island" => "Graue Insel" } });
	w.write(obj! { "type" => "Wind", "fields" => obj! { "island" => "Graue Insel", "level" => 3.0 } });
	for (who, line) in [(&a, "mahle 13 weizen"), (&a, "mahle meine gerste"), (&a, "mahle knochen"), (&a, "mahle weizen"), (&a, "mahle")] { run(&mut w, who, line, 0.0); }
	w.call("stormTurnsMills", Some("graue-bucht"));
	for (who, line) in [(&a, "mahle"), (&b, "mahle")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 1, "graue-bucht", 9.0, 14.0);
	run(&mut w, &a, "abholen", 0.0);
	stand(&mut w, 1, "graue-bucht", 7.0, 12.0);
	for (who, line) in [(&a, "abholen"), (&a, "abholen"), (&a, "mahle")] { run(&mut w, who, line, 3_600_000.0); }
	w.call("stormTurnsMills", Some("klippenpfad"));
	w.call("stormTurnsMills", None);
	w.call("stormTurnsMills", Some("werft"));
	w.call("stormTurnsMills", Some("graue-bucht"));
	for (who, line) in [(&a, "mahle"), (&b, "abholen"), (&a, "abholen"), (&a, "mahle")] { run(&mut w, who, line, 0.0); }
	for (who, line) in [(&a, "abholen"), (&a, "abholen"), (&a, "inventory"), (&g, "abholen")] { run(&mut w, who, line, 40_000_000.0); }
	give(&mut w, &a, "gerste", 2);
	for (who, line) in [(&a, "mahle 1 gerste"), (&a, "mahle 1 gerste")] { run(&mut w, who, line, 0.0); }
	run(&mut w, &a, "abholen", 2_400_000.0);
	run(&mut w, &a, "mahle", 0.0);
	w.write(building("bh-1", "backhaus", "Backhaus", "graue-bucht", 8.0, 11.0));
	for (who, line) in [(&b, "backe"), (&a, "backe kuchen"), (&a, "backe das brot"), (&a, "inventory")] { run(&mut w, who, line, 0.0); }
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 10 && said.iter().filter(|r| r.starts_with("refused")).count() > 10, "{said:?}");
	assert!(w.entries_with("Du holst") >= 1, "nothing was fetched");
}

/// Festivals (festival.ts): opening one with its refusals (no park, a guest, the season, no settlement, not a settler,
/// one open, the rest after one), showing flowers, a harvest and boats, tending the park, and the shows' end in the
/// epoch job: a prize as an estate, a figure winning for the settlement's honour, too few, and one whose settlement is gone.
#[test]
fn festivals() {
	let mut w = Walk::new("festivals", 41, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (4.0, 12.0), true);
	let e = w.player_as(4, "graue-bucht", (6.0, 13.0), true, false);
	assert!(w.take(obj! { "type" => "Account", "fields" => obj! { "accountId" => "a-walk4" } }));
	w.write(obj! { "type" => "Account", "fields" => obj! { "accountId" => "a-walk4", "name" => "Wanderer4", "guest" => false, "admin" => false, "settler" => true, "createdAt" => START, "touchedAt" => START } });
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize, variety: Option<Json>| { for _ in 0..k { n += 1; let t = thing(&world, &format!("t-{n}"), proto, to); let t = match &variety { Some(v) => { let mut f = t.get("fields").cloned().unwrap(); walk::j_set(&mut f, "variety", v.clone()); obj! { "type" => "Item", "fields" => f } } None => t }; w.write(t); } };
	give(&mut w, &a, "strandnelke", 1, Some(obj! { "name" => "Abendrot", "color" => "rot" }));
	give(&mut w, &a, "strandnelke", 2, None);
	give(&mut w, &a, "treibholz", 1, None);
	give(&mut w, &b, "duenenrose", 1, Some(obj! { "color" => "gelb" }));
	give(&mut w, &e, "nebelblume", 1, None);
	give(&mut w, &g, "strandnelke", 1, None);
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| {
		step += 1;
		at.set(at.get() + 9_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r);
	};
	let building = |id: &str, plan: &str, name: &str, x: f64, y: f64, owner: usize| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => plan, "name" => name, "room" => "graue-bucht", "x" => x, "y" => y, "w" => 2.0, "h" => 2.0, "owner" => format!("c-walk{owner}"), "ownerName" => format!("Wanderer{owner}"), "accountId" => format!("a-walk{owner}"), "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	let settlement = |rest: Option<f64>| { let mut f = obj! { "settlementId" => "s-1", "name" => "Graubucht", "room" => "graue-bucht", "members" => Json::Array(vec![]), "closed" => false }; if let Some(r) = rest { walk::j_set(&mut f, "showRestWorldMs", Json::from(r)); } obj! { "type" => "Settlement", "fields" => f } };
	for (who, line) in [(&a, "fest"), (&a, "fest tanz"), (&g, "fest blumen"), (&a, "fest blumen"), (&a, "pflege"), (&a, "zeige nelke"), (&g, "pflege")] { run(&mut w, who, line, 0.0); }
	w.write(building("p-1", "park", "Park", 5.0, 11.0, 9));
	for (who, line) in [(&a, "fest blumen"), (&a, "fest ernte"), (&a, "fest regatta"), (&a, "fest race")] { run(&mut w, who, line, 0.0); }
	w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "year.days", "value" => 0.0 } });
	run(&mut w, &a, "fest blumen", 0.0);
	w.write(building("h-1", "huette", "Hütte", 8.0, 15.0, 1));
	w.write(settlement(None));
	for (who, line) in [
		(&b, "fest blumen"), (&a, "fest Blumenschau"), (&a, "fest ernte"), (&a, "fest"), (&a, "zeige"), (&a, "zeige stein"), (&a, "zeige treibholz"),
		(&a, "zeige abendrot"), (&a, "zeige strandnelke"), (&b, "zeige rose"), (&e, "zeige nebelblume"), (&g, "zeige strandnelke"), (&a, "fest"),
		(&a, "pflege"), (&a, "pflege"), (&b, "pflege"), (&e, "pflegen"),
	] { run(&mut w, who, line, 0.0); }
	assert_eq!(w.call("showTick", None), Json::from(0.0));
	run(&mut w, &a, "fest", 200_000_000.0);
	assert_eq!(w.call("showTick", None), Json::from(1.0));
	for (who, line) in [(&a, "fest"), (&a, "fest blumen"), (&a, "nachlass"), (&a, "pflege")] { run(&mut w, who, line, 0.0); }
	// a harvest festival
	assert!(w.take(obj! { "type" => "Settlement", "fields" => obj! { "settlementId" => "s-1" } }));
	w.write(settlement(Some(1.0)));
	give(&mut w, &a, "weizen", 3, None);
	give(&mut w, &a, "samen-ruebe", 1, None);
	give(&mut w, &b, "kartoffel", 1, None);
	for (who, line) in [(&a, "fest harvest"), (&a, "zeige"), (&a, "zeige weizen"), (&a, "zeige weizen"), (&a, "zeige rübensamen"), (&b, "zeige kartoffel"), (&a, "fest"), (&e, "zeige nebelblume")] { run(&mut w, who, line, 0.0); }
	run(&mut w, &a, "fest", 200_000_000.0);
	assert_eq!(w.call("showTick", None), Json::from(1.0));
	// a regatta at the landing stage, with a figure among the crews
	assert!(w.take(obj! { "type" => "Settlement", "fields" => obj! { "settlementId" => "s-1" } }));
	w.write(settlement(None));
	give(&mut w, &a, "segelboot", 1, None);
	give(&mut w, &b, "ruderboot", 1, None);
	give(&mut w, &e, "ruderboot", 1, None);
	run(&mut w, &a, "fest regatta", 0.0);
	w.write(building("st-1", "steg", "Steg", 5.0, 14.0, 9));
	for (who, line) in [(&a, "fest regatta"), (&a, "zeige"), (&a, "zeige segelboot"), (&b, "zeige ruderboot"), (&e, "zeige ruderboot"), (&e, "zeige ruderboot"), (&a, "zeige weizen"), (&a, "fest"), (&a, "inventory")] { run(&mut w, who, line, 0.0); }
	run(&mut w, &a, "fest", 200_000_000.0);
	assert_eq!(w.call("showTick", None), Json::from(1.0));
	// one alone wins nothing; a show whose settlement is gone lapses
	assert!(w.take(obj! { "type" => "Settlement", "fields" => obj! { "settlementId" => "s-1" } }));
	w.write(settlement(None));
	give(&mut w, &a, "strandnelke", 1, None);
	for (who, line) in [(&a, "fest blumen"), (&a, "zeige strandnelke")] { run(&mut w, who, line, 0.0); }
	w.write(obj! { "type" => "Show", "fields" => obj! { "showId" => "sh-x", "room" => "duenen", "settlementId" => "s-gone", "settlementName" => "Fort", "kind" => "blumen", "byName" => "Jemand", "endsWorldMs" => 1.0 } });
	w.write(obj! { "type" => "ShowEntry", "fields" => obj! { "showId" => "sh-x", "accountId" => "a-walk9", "charName" => "Jemand", "name" => "Rose", "score" => 1.0, "at" => 1.0 } });
	run(&mut w, &a, "fest", 200_000_000.0);
	assert_eq!(w.call("showTick", None), Json::from(2.0));
	run(&mut w, &a, "fest", 0.0);
	// a figure wins for the settlement's honour; of equal ones the earlier is ahead
	assert!(w.take(obj! { "type" => "Settlement", "fields" => obj! { "settlementId" => "s-1" } }));
	w.write(settlement(None));
	give(&mut w, &a, "strandnelke", 1, None);
	give(&mut w, &b, "strandnelke", 1, None);
	give(&mut w, &e, "nebelblume", 1, Some(obj! { "name" => "Silberhauch" }));
	for (who, line) in [(&a, "fest blumen"), (&b, "zeige strandnelke"), (&a, "zeige strandnelke"), (&e, "zeige nebelblume"), (&a, "fest")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 2, "graue-bucht", 12.0, 8.0);
	run(&mut w, &b, "zeige strandnelke", 0.0);
	run(&mut w, &a, "fest", 200_000_000.0);
	assert_eq!(w.call("showTick", None), Json::from(1.0));
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 15 && said.iter().filter(|r| r.starts_with("refused")).count() > 15, "{said:?}");
	assert_eq!(w.entries_with(r#""Estate""#), 2, "the prizes of the flower show and the harvest festival");
}

/// The department store and the counting house (shop.ts): the till filled and emptied by its owner, selling to the store
/// and buying from it at prices led by its stock, a settlement's tax on what is bought, delivery orders posted, delivered
/// in part and whole, cancelled, loans against a pledge, paid back, ended by their time with the house standing and gone,
/// and bills of exchange written and cashed.
#[test]
fn shops() {
	let mut w = Walk::new("shops", 43, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (12.0, 8.0), true);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	give(&mut w, &b, "treibholz", 3);
	give(&mut w, &b, "perle", 1);
	give(&mut w, &b, "kerze", 1);
	give(&mut w, &b, "brot", 1);
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| {
		step += 1;
		at.set(at.get() + 9_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r);
	};
	let building = |id: &str, plan: &str, name: &str, x: f64, y: f64, wh: (f64, f64), owner: usize| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => plan, "name" => name, "room" => "graue-bucht", "x" => x, "y" => y, "w" => wh.0, "h" => wh.1, "owner" => format!("c-walk{owner}"), "ownerName" => format!("Wanderer{owner}"), "accountId" => format!("a-walk{owner}"), "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	for (who, line) in [(&a, "laden"), (&b, "kredit 5 gegen perle"), (&b, "wechsel"), (&b, "wechsel 5"), (&b, "tilge")] { run(&mut w, who, line, 0.0); }
	w.write(building("k-1", "kaufhaus", "Kaufhaus", 5.0, 11.0, (2.0, 2.0), 1));
	w.write(building("ko-1", "kontor", "Kontor", 8.0, 11.0, (2.0, 2.0), 9));
	for (who, line) in [(&a, "laden"), (&a, "laden einlegen 5"), (&a, "laden einlegen x")] { run(&mut w, who, line, 0.0); }
	give(&mut w, &a, "muenze", 30);
	for (who, line) in [
		(&a, "laden einlegen 10"), (&a, "laden entnehme 3"), (&a, "laden entnehme 50"), (&b, "laden einlegen 2"), (&b, "laden"),
		(&b, "laden verkaufe treibholz"), (&b, "laden verkaufe treibholz"), (&b, "laden verkaufe perle"), (&b, "laden verkaufe gold"), (&b, "laden verkaufe xyzzy"), (&b, "laden verkaufe kerze"), (&a, "laden"),
		(&b, "laden kaufe stein"), (&b, "laden kaufe treibholz"), (&b, "laden kaufe brot"), (&b, "laden verkaufe brot"), (&b, "laden kaufe das brot"),
	] { run(&mut w, who, line, 0.0); }
	// a settlement's tax on what is bought at its store, kept in its warehouse
	w.write(obj! { "type" => "Settlement", "fields" => obj! { "settlementId" => "s-1", "room" => "graue-bucht", "name" => "Graubucht", "closed" => false, "members" => Json::Array(vec![]), "tax" => 1.0 } });
	run(&mut w, &b, "laden kaufe treibholz", 0.0);
	w.write(building("l-1", "lagerhaus", "Lagerhaus", 19.0, 12.0, (3.0, 2.0), 9));
	give(&mut w, &b, "muenze", 12);
	for (who, line) in [(&b, "laden kaufe treibholz"), (&b, "laden verkaufe treibholz"), (&b, "laden kaufe treibholz"), (&a, "laden")] { run(&mut w, who, line, 0.0); }
	// delivery orders
	give(&mut w, &b, "fisch", 5);
	for (who, line) in [
		(&b, "laden bestelle 5 fisch für 2"), (&a, "laden bestelle fisch"), (&a, "laden bestelle 5 kerze für 1"), (&a, "laden bestelle 0 fisch für 1"), (&a, "laden bestelle 21 fisch für 1"),
		(&a, "laden bestelle 3 fisch für 0"), (&a, "laden bestelle 9 fisch für 9"), (&a, "laden einlegen 15"), (&a, "laden bestelle 3 Fisch für 2"), (&a, "laden bestelle 2 fische für 1"),
		(&a, "laden bestelle 1 tang fuer 1"), (&a, "laden bestelle 1 Muschel for 1"), (&a, "laden bestelle 1 ei für 1"), (&a, "laden"), (&a, "laden entnehme 20"), (&a, "laden entnehme 2"),
		(&a, "laden liefere fisch"), (&b, "laden liefere stein"), (&b, "laden liefere kerze"), (&b, "laden liefere 2 fisch"), (&b, "laden"), (&b, "laden liefere alle fisch"), (&b, "laden liefere fisch"),
		(&a, "laden storniere tang"), (&a, "laden storniere gold"), (&a, "laden storniere"), (&b, "laden storniere muschel"), (&a, "laden storniere Muschel"), (&a, "laden tanz"), (&a, "laden einlegen -2"),
	] { run(&mut w, who, line, 0.0); }
	// loans
	for (who, line) in [(&g, "kredit"), (&b, "kredit"), (&b, "kredit x"), (&a, "kredit 2 gegen muenze"), (&b, "kredit 50 gegen perle"), (&b, "kredit 2 gegen kerze"), (&b, "kredit 2 gegen gold"), (&b, "kredit 2 gegen xyzzy"), (&b, "kredit 0 gegen perle"), (&b, "kredit 5 gegen perle")] { run(&mut w, who, line, 0.0); }
	give(&mut w, "ko-1", "muenze", 20);
	give(&mut w, &b, "perle", 1);
	for (who, line) in [(&b, "kredit 5 gegen die perle"), (&b, "kredit"), (&b, "kredit 3 gegen perle"), (&b, "inventory")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 2, "graue-bucht", 12.0, 9.0);
	run(&mut w, &b, "tilge", 0.0);
	stand(&mut w, 2, "graue-bucht", 7.0, 13.0);
	for (who, line) in [(&b, "tilge"), (&b, "tilge"), (&b, "kredit 4 gegen perle"), (&a, "tilge")] { run(&mut w, who, line, 0.0); }
	w.write(obj! { "type" => "Loan", "fields" => obj! { "loanId" => "loan-a", "buildId" => "ko-1", "room" => "graue-bucht", "accountId" => "a-walk1", "charId" => a.as_str(), "charName" => "Wanderer1", "owed" => 999.0, "untilWorldMs" => 9e15 } });
	stand(&mut w, 1, "graue-bucht", 10.0, 13.0);
	run(&mut w, &a, "tilge", 0.0);
	assert!(w.take(obj! { "type" => "Loan", "fields" => obj! { "loanId" => "loan-a" } }));
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	// a loan whose house is gone is paid back with nothing; one that ran out: the pledge to the house, or back
	w.write(obj! { "type" => "Loan", "fields" => obj! { "loanId" => "loan-x", "buildId" => "gone", "room" => "graue-bucht", "accountId" => "a-walk1", "charId" => a.as_str(), "charName" => "Wanderer1", "owed" => 3.0, "untilWorldMs" => 9e15 } });
	give(&mut w, "loan-x", "muschel", 1);
	run(&mut w, &a, "tilge", 0.0);
	w.write(obj! { "type" => "Loan", "fields" => obj! { "loanId" => "loan-y", "buildId" => "gone", "room" => "graue-bucht", "accountId" => "a-walk9", "charId" => a.as_str(), "charName" => "Wanderer1", "owed" => 3.0, "untilWorldMs" => 1.0 } });
	give(&mut w, "loan-y", "tang", 2);
	assert_eq!(w.call("loanTick", None), Json::from(1.0));
	run(&mut w, &b, "kredit", 700_000_000.0);
	assert_eq!(w.call("loanTick", None), Json::from(1.0));
	assert_eq!(w.call("loanTick", None), Json::from(0.0));
	for (who, line) in [(&b, "kredit"), (&b, "inventory"), (&a, "inventory")] { run(&mut w, who, line, 0.0); }
	// bills of exchange
	give(&mut w, &b, "muenze", 10);
	for (who, line) in [
		(&g, "wechsel 5"), (&b, "wechsel"), (&b, "wechsel einlösen"), (&b, "wechsel 500"), (&b, "wechsel x"), (&b, "wechsel 30"), (&b, "wechsel 4"), (&b, "wechsel 3 münzen"), (&b, "wechsel"),
		(&b, "inventory"), (&b, "wechsel einlösen"), (&b, "wechsel"), (&b, "wechsel 2"), (&b, "wechsel cash"),
	] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 3, "graue-bucht", 10.0, 11.0);
	for (who, line) in [(&g, "wechsel 2"), (&g, "wechsel einlösen"), (&g, "laden"), (&g, "kredit 1 gegen x")] { run(&mut w, who, line, 0.0); }
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 25 && said.iter().filter(|r| r.starts_with("refused")).count() > 30, "{said:?}");
}

/// Rooms that grow (growth.ts) in the epoch job with its ticks: a room not full yet, a full one growing east twice with
/// everyone and everything in it moved (a figure, its spot, a building, a motion's zone, a thing on the ground, the arrival
/// of an exit into it), then south when east is at its limit, and a room whose seams a building cuts everywhere.
#[test]
fn growing() {
	let mut w = Walk::new("growing", 47, START);
	w.load(false);
	let a = w.player_as(1, "duenen", (20.0, 6.0), true, false);
	let world = w.w.clone();
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "h-1", "plan" => "huette", "name" => "Hütte", "room" => "duenen", "x" => 20.0, "y" => 12.0, "w" => 2.0, "h" => 2.0, "owner" => a.as_str(), "ownerName" => "Wanderer1", "accountId" => "a-walk1", "beaconId" => "feuer-anleger", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	w.write(obj! { "type" => "Motion", "fields" => obj! { "motionId" => "m-1", "room" => "duenen", "settlementId" => "s-x", "kind" => "zone", "zone" => obj! { "x" => 14.0, "y" => 1.0, "w" => 2.0, "h" => 2.0 }, "byName" => "Jemand", "endsWorldMs" => 9e15 } });
	w.write(obj! { "type" => "Settlement", "fields" => obj! { "settlementId" => "s-x", "room" => "duenen", "name" => "Dünenheim", "closed" => false, "members" => Json::Array(vec![]) } });
	w.write(thing(&world, "t-ground", "treibholz", "duenen"));
	assert!(w.take(obj! { "type" => "Item", "fields" => obj! { "itemId" => "t-ground" } }));
	let mut f = thing(&world, "t-ground", "treibholz", "duenen").get("fields").cloned().unwrap();
	walk::j_set(&mut f, "x", Json::from(22.0));
	walk::j_set(&mut f, "y", Json::from(3.0));
	w.write(obj! { "type" => "Item", "fields" => f });
	let ground = |w: &Walk, room: &str| -> Vec<String> {
		let e = w.run(w.space.peek(&obj! { "type" => "Room", "fields" => obj! { "roomId" => room } }, None)).unwrap().unwrap();
		e.get("fields").and_then(|f| f.get("ground")).and_then(Json::as_array).unwrap().iter().map(|r| r.as_str().unwrap().to_owned()).collect()
	};
	let exits = |w: &Walk, room: &str| -> Vec<(f64, f64)> {
		w.run(w.space.read_all(&obj! { "type" => "Exit", "fields" => obj! { "location" => room } }, None)).unwrap().iter().map(|e| { let f = e.get("fields").unwrap(); (f.get("x").and_then(Json::as_f64).unwrap_or(-9.0), f.get("y").and_then(Json::as_f64).unwrap_or(-9.0)) }).collect()
	};
	// the land of a room, west first: what a Plot may stand on
	let land = |w: &Walk, room: &str| -> Vec<(f64, f64)> {
		let g = ground(w, room);
		let ex = exits(w, room);
		let mut out = Vec::new();
		for x in 0..g[0].len() { for (y, row) in g.iter().enumerate() {
			let (xf, yf) = (x as f64, y as f64);
			if mmo_engine::world::walkable(&w.w, &g, xf, yf) && &row[x..x + 1] != ":" && !ex.iter().any(|(ex, ey)| (ex - xf).abs().max((ey - yf).abs()) <= 1.0) { out.push((xf, yf)); }
		} }
		out
	};
	let mut plots = 0;
	let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
	let mut fill = |w: &mut Walk, room: &str, share: f64, skip: &dyn Fn(f64, f64) -> bool| {
		let cells = land(w, room);
		let want = (cells.len() as f64 * share).ceil() as usize;
		let mut put = 0;
		for (x, y) in cells {
			if put >= want { break; }
			if skip(x, y) || !used.insert(format!("{room} {x} {y}")) { continue; } plots += 1; put += 1; w.write(obj! { "type" => "Plot", "fields" => obj! { "room" => room, "x" => x, "y" => y, "of" => format!("p-{plots}") } }); }
	};
	w.compare("setup");
	w.tick("epoch");
	w.compare("not full");
	assert!(w.peek(obj! { "type" => "RoomGrowth" }).is_none());
	fill(&mut w, "duenen", 0.6, &|_, _| false);
	w.tick("epoch");
	w.compare("60 percent");
	assert!(w.peek(obj! { "type" => "RoomGrowth" }).is_none());
	fill(&mut w, "duenen", 0.15, &|x, _| x < 13.0);
	w.at(START + 60_000.0);
	w.tick("epoch");
	w.compare("grown once");
	assert!(w.peek(obj! { "type" => "RoomGrowth", "fields" => obj! { "roomId" => "duenen" } }).is_some(), "duenen did not grow");
	eprintln!("after one: {:?} {:?}", w.where_is(&a), ground(&w, "duenen")[0].len());
	let r = w.cmd(&a, "look", None);
	w.compare(&format!("look -> {r}"));
	fill(&mut w, "duenen", 0.2, &|x, _| x < 16.0);
	w.at(START + 120_000.0);
	w.tick("epoch");
	w.compare("grown twice");
	fill(&mut w, "duenen", 0.25, &|x, _| x < 20.0);
	w.at(START + 180_000.0);
	w.tick("epoch");
	w.compare("grown a third time");
	eprintln!("after three: {:?} {}x{}", w.where_is(&a), ground(&w, "duenen")[0].len(), ground(&w, "duenen").len());
	// a room whose seams a building cuts everywhere does not grow
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "wide", "plan" => "huette", "name" => "Hütte", "room" => "salzwiesen", "x" => 0.0, "y" => 0.0, "w" => 24.0, "h" => 16.0, "owner" => "c-walk9", "ownerName" => "Jemand", "accountId" => "a-walk9", "beaconId" => "feuer-anleger", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	fill(&mut w, "salzwiesen", 0.8, &|_, _| false);
	w.at(START + 240_000.0);
	w.tick("epoch");
	w.compare("cut everywhere");
	assert!(w.peek(obj! { "type" => "RoomGrowth", "fields" => obj! { "roomId" => "salzwiesen" } }).is_none());
	let g = w.peek(obj! { "type" => "RoomGrowth", "fields" => obj! { "roomId" => "duenen" } }).unwrap();
	eprintln!("{}", g.to_json_text());
}

/// Builder and admin commands (builder.ts): digging rooms with a way back, opening exits into rooms by name and id,
/// creating things by typeclass and prototype, setting names, descriptions, aliases and locks, tags on and off, examining,
/// destroying, and an admin giving and taking the builder's level; for a player the commands do not exist.
#[test]
fn shaping_the_world() {
	let mut w = Walk::new("shaping", 53, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (4.0, 12.0), true);
	w.player_as(4, "duenen", (5.0, 5.0), false, false);
	let account = |n: usize, perms: Json, admin: bool| obj! { "type" => "Account", "fields" => obj! { "accountId" => format!("a-walk{n}"), "name" => format!("Wanderer{n}"), "guest" => false, "admin" => admin, "perms" => perms, "createdAt" => START, "touchedAt" => START } };
	assert!(w.take(obj! { "type" => "Account", "fields" => obj! { "accountId" => "a-walk1" } }));
	w.write(account(1, Json::Array(vec![Json::from("Builder")]), false));
	assert!(w.take(obj! { "type" => "Account", "fields" => obj! { "accountId" => "a-walk2" } }));
	w.write(account(2, Json::Array(vec![]), true));
	let world = w.w.clone();
	w.write(thing(&world, "t-1", "treibholz", &a));
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
	for (who, line) in [
		(&g, "dig Keller = runter"), (&a, "dig"), (&a, "dig Höhle"), (&a, "dig @@ = hinab"), (&a, "dig Höhle = hinab, hinauf"), (&a, "dig Kammer = tür"), (&a, "move 9 13"), (&a, "dig Kammer = tür"),
		(&a, "open"), (&a, "open nord"), (&a, "open nord = nirgends"), (&a, "move 11 13"), (&a, "open nord = höhle"), (&a, "move 12 13"), (&a, "open ost = graue-bucht"), (&a, "open west = höhle"),
		(&a, "create"), (&a, "create Stein der Weisen"), (&a, "create Kiste:Gibtsnicht"), (&a, "create Kiste:Exit"), (&a, "create Kiste:"), (&a, "create Truhe : Item"),
		(&a, "spawn"), (&a, "spawn Muschel"), (&a, "spawn gibtsnicht"),
		(&a, "set"), (&a, "set hier = x"), (&a, "set /name = x"), (&a, "set hier/name = Graue Bucht am Meer"), (&a, "set hier/aliases = x"), (&a, "set hier/desc = Ein stiller Strand."),
		(&a, "set treibholz/aliases = Holz, Stück ,"), (&a, "set treibholz/locks = get:perm(Builder)"), (&a, "set treibholz/locks = get:("), (&a, "set treibholz/name = @@@"), (&a, "set holz/name = Altes Holz"),
		(&a, "set nichts/name = x"), (&a, "set muschel/desc = Glänzt."), (&a, "set tür/desc = Eine Tür."),
		(&a, "lock tür = traverse:perm(Builder)"), (&a, "lock hier = x"), (&a, "lock tür = bad("), (&a, "lock tür"),
		(&a, "tag muschel"), (&a, "tag muschel = schwer"), (&a, "tag muschel = schwer:gewicht"), (&a, "tag muschel = schwer"), (&a, "tag muschel"), (&a, "tag muschel = -schwer"), (&a, "tag muschel = -schwer"), (&a, "tag muschel = !!"), (&a, "tag hier = ruhig"),
		(&a, "examine"), (&a, "examine muschel"), (&a, "ex tür"), (&a, "examine hier"),
		(&a, "destroy hier"), (&a, "destroy muschel"), (&a, "destroy stein der weisen"), (&a, "destroy nichts"),
		(&a, "perm Wanderer1 = Player"), (&b, "perm"), (&b, "perm Wanderer3 = Builder"), (&b, "perm niemand = Builder"), (&b, "perm Wanderer1 = Admin"), (&b, "perm wanderer1 = player"), (&a, "dig Gang = gang"),
		(&b, "perm Wanderer1 = builder"), (&b, "perm Wanderer1 = Builder"), (&b, "perm Wanderer4 = Builder"), (&a, "move 5 13"), (&a, "hinab"), (&a, "look"), (&a, "hinauf"), (&b, "tür"), (&g, "create Ding"),
	] { run(&mut w, who, line); }
	run(&mut w, &a, &format!("set truhe/desc = {}", "x".repeat(1001)));
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 30 && said.iter().filter(|r| r.starts_with("refused")).count() > 20, "{said:?}");
}

/// The world's time at real time `real` (the clock's anchor and rate).
fn world_now(w: &mut Walk, real: f64) -> f64 {
	let clock = w.peek(obj! { "type" => "WorldClock" }).unwrap();
	let c = clock.get("fields").unwrap();
	let n = |k: &str| c.get(k).and_then(Json::as_f64).unwrap();
	n("worldAnchorMs") + (real - n("realAnchorMs")) * n("rate")
}

/// Gardens (garden.ts): digging beds of the three kinds with their refusals, planting by count and by cell, a sponsor
/// watering, the garden tick moving the plants on (and wilting a dry one), the harvest of a flower bed with its crossings,
/// naming a crossing, the community bed's shares, weeding, seeds from the wild flora, the rain barrel and a storm filling it.
#[test]
fn gardening() {
	let mut w = Walk::new("gardening", 46, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (6.0, 12.0), true);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	give(&mut w, &a, "spaten", 1);
	give(&mut w, &a, "samen-strandnelke", 4);
	give(&mut w, &a, "samen-duenenrose", 3);
	give(&mut w, &a, "samen-strandkohl", 2);
	give(&mut w, &a, "wasserkanne", 18);
	give(&mut w, &b, "wasserkanne", 17);
	give(&mut w, &b, "samen-moehre", 4);
	give(&mut w, &g, "samen-moehre", 1);
	w.write(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-bucht", "until" => 9e15, "litAt" => 0.0 } });
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| {
		step += 1;
		at.set(at.get() + 7_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r);
	};
	for (who, line) in [
		(&g, "umgraben"), (&a, "beet"), (&b, "umgraben"), (&a, "pflanze strandnelke"), (&a, "umgraben zier 30 30"), (&a, "umgraben zier 4 11"), (&a, "beet"), (&a, "beet ansehen 4 11"),
		(&a, "pflanze 2 strandnelken"), (&a, "pflanze samen-duenenrose 5 12"), (&a, "pflanze samen-strandkohl"), (&a, "pflanze 0 strandnelken"), (&a, "pflanze 5 samen-duenenrose"), (&a, "pflanze rose 9 9"), (&a, "pflanze"),
		(&a, "pflanze gibtsnicht"), (&a, "pflanze weizen"), (&a, "pflanze samen-duenenrose ins beet"),
		(&a, "umgraben 7 10"), (&a, "pflanze samen-strandkohl"), (&a, "umgraben gemeinschaft 12 12"), (&a, "beet anlegen gemeinschaft 1 13"), (&a, "umgraben gemeinschaft 10 13"), (&a, "umgraben 11 14"),
		(&g, "pflanze samen-moehre"), (&b, "pflanze 2 samen-moehre"), (&a, "beet"),
		(&a, "pate"), (&a, "pate Wanderer2"), (&a, "pate wanderer2"), (&a, "pate Niemand"), (&a, "pate Wanderer1"), (&a, "pate"), (&a, "pate weg Niemand"),
		(&b, "gieße"), (&g, "gieße"), (&g, "jäte"), (&a, "jäte"), (&a, "ernte"),
	] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 1, "graue-bucht", 12.0, 13.0);
	stand(&mut w, 2, "graue-bucht", 2.0, 12.0);
	for (who, line) in [(&a, "umgraben"), (&a, "pflanze 2 samen-strandkohl"), (&a, "pflanze samen-strandkohl"), (&b, "pflanze 4 samen-moehre"), (&b, "pflanze samen-moehre"), (&b, "beet aufgeben")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	// the plants move on (fog slows them): every four hours both water and the tick looks, until the flowers are ripe
	assert_eq!(w.call("gardenTick", None), Json::from(0.0));
	for _ in 0..16 { for (who, line) in [(&a, "gieße"), (&b, "gieße")] { run(&mut w, who, line, 2.0 * 3_600_000.0); } w.call("gardenTick", None); }
	for (who, line) in [(&a, "beet"), (&a, "ernte"), (&b, "ernte"), (&g, "ernte"), (&a, "jäte"), (&a, "inventory")] { run(&mut w, who, line, 0.0); }
	// the digger's share of the community bed
	stand(&mut w, 1, "graue-bucht", 0.0, 12.0);
	for (who, line) in [(&a, "beet"), (&a, "ernte"), (&a, "ernte"), (&a, "gieße"), (&a, "jäte"), (&a, "beet aufgeben")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	// naming crossings (two seeds of one, one of another, in place of what the harvest crossed): one planted before it is
	// named, then one planted named
	while let Some(e) = w.peek(obj! { "type" => "Item", "fields" => obj! { "location" => a.as_str(), "name" => "Kreuzungssamen" } }) { assert!(w.take(obj! { "type" => "Item", "fields" => obj! { "itemId" => e.get("fields").unwrap().get("itemId").cloned().unwrap() } })); }
	for (k, id, color) in [(1, "v-1", "#c0507a"), (2, "v-1", "#c0507a"), (3, "v-2", "#d0a040")] {
		let mut f = thing(&world, &format!("x-{k}"), "samen-strandnelke", &a).get("fields").cloned().unwrap();
		for (key, v) in [("name", Json::from("Kreuzungssamen")), ("aliases", Json::Array(vec![Json::from("kreuzung"), Json::from("kreuzungssamen")])), ("variety", obj! { "id" => id, "name" => "", "color" => color, "breeder" => a.as_str(), "breederName" => "Wanderer1" })] { walk::j_set(&mut f, key, v); }
		w.write(obj! { "type" => "Item", "fields" => f });
	}
	give(&mut w, &a, "wasserkanne", 16);
	for (who, line) in [
		(&a, "benenne"), (&a, "benenne Abendrot"), (&a, "benenne 9 Abendrot"), (&a, "benenne 0 Abendrot"), (&a, "benenne 1 Kohl"), (&a, "benenne 1 x"), (&a, "benenne 1 look"), (&a, "benenne 1 Ab3nd"),
		(&a, "pflanze kreuzungssamen"), (&a, "benenne die kreuzung als 1 abendröte"), (&a, "benenne Abendröte"), (&a, "pflanze abendröte-samen"), (&b, "benenne Tau"), (&a, "benenne   morgen   rot"), (&a, "benenne Neu"), (&a, "inventory"), (&a, "beet"),
	] { run(&mut w, who, line, 0.0); }
	for _ in 0..16 { run(&mut w, &a, "gieße", 4.0 * 3_600_000.0); w.call("gardenTick", None); }
	for (who, line) in [(&a, "beet"), (&a, "ernte"), (&a, "inventory"), (&a, "pate weg wanderer2"), (&a, "pate weg Wanderer2")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 1, "graue-bucht", 9.0, 14.0);
	for (who, line) in [(&a, "ernte"), (&a, "beet aufgeben"), (&a, "ernte flur")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	// planted again, left dry: the tick wilts it, weeding pulls it
	for (who, line) in [(&a, "pflanze 2 strandnelken"), (&a, "pflanze 3 samen-duenenrose 4 11")] { run(&mut w, who, line, 0.0); }
	run(&mut w, &a, "beet", 30.0 * 3_600_000.0);
	w.call("gardenTick", None);
	run(&mut w, &a, "beet", 30.0 * 3_600_000.0);
	w.call("gardenTick", None);
	for (who, line) in [(&a, "beet"), (&a, "jäte"), (&a, "jäte"), (&a, "beet aufgeben")] { run(&mut w, who, line, 0.0); }
	// winter: what grows outside stands still until the spring, beside a greenhouse it grows on
	give(&mut w, &a, "samen-strandnelke", 1);
	give(&mut w, &a, "samen-strandkohl", 1);
	run(&mut w, &a, "umgraben zier 4 11", 0.0);
	run(&mut w, &a, "pflanze strandnelke", 0.0);
	stand(&mut w, 1, "graue-bucht", 12.0, 13.0);
	run(&mut w, &a, "pflanze samen-strandkohl", 0.0);
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "gh-1", "plan" => "gewaechshaus", "name" => "Gewächshaus", "room" => "graue-bucht", "x" => 6.0, "y" => 10.0, "w" => 2.0, "h" => 2.0, "owner" => "c-walk9", "ownerName" => "Jemand", "accountId" => "a-walk9", "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	run(&mut w, &a, "beet", 24.0 * 3_600_000.0);
	let day = world_now(&mut w, at.get()) / 86_400_000.0;
	w.write(obj! { "type" => "Setting", "fields" => obj! { "key" => "year.days", "value" => day * 1.1 } });
	w.call("gardenTick", None);
	run(&mut w, &a, "beet", 0.0);
	assert!(w.take(obj! { "type" => "Setting", "fields" => obj! { "key" => "year.days" } }));
	// seeds from the wild flora, then again too soon
	for (who, line) in [(&a, "sammle stein"), (&a, "sammle"), (&a, "sammle samen"), (&b, "sammle die samen"), (&b, "sammle saatgut"), (&a, "sammle samen")] { run(&mut w, who, line, 0.0); }
	for (who, line) in [(&a, "sammle samen"), (&b, "sammle samen"), (&a, "sammle"), (&b, "sammle")] { run(&mut w, who, line, 700_000.0); }
	stand(&mut w, 2, "duenen", 3.0, 3.0);
	run(&mut w, &b, "sammle samen", 0.0);
	stand(&mut w, 2, "graue-bucht", 7.0, 13.0);
	// the rain barrel
	let barrel = |water: Option<(f64, f64)>| { let mut f = obj! { "buildId" => "rt-1", "plan" => "regentonne", "name" => "Regentonne", "room" => "graue-bucht", "x" => 8.0, "y" => 14.0, "w" => 1.0, "h" => 1.0, "owner" => "c-walk9", "ownerName" => "Jemand", "accountId" => "a-walk9", "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 }; if let Some((x, at)) = water { walk::j_set(&mut f, "water", Json::from(x)); walk::j_set(&mut f, "waterAtWorldMs", Json::from(at)); } obj! { "type" => "Building", "fields" => f } };
	for (who, line) in [(&b, "schöpfe"), (&a, "schöpfe")] { run(&mut w, who, line, 0.0); }
	w.write(barrel(None));
	for (who, line) in [(&b, "schöpfe"), (&b, "schöpfe"), (&b, "schöpfe"), (&b, "inventory")] { run(&mut w, who, line, 0.0); }
	assert!(w.take(obj! { "type" => "Building", "fields" => obj! { "buildId" => "rt-1" } }));
	let now = world_now(&mut w, at.get());
	w.write(barrel(Some((0.0, now - 3_600_000.0))));
	w.call("stormFillsBarrels", Some("vogelklippen"));
	w.call("stormFillsBarrels", None);
	run(&mut w, &b, "schöpfe", 0.0);
	w.call("stormFillsBarrels", Some("graue-bucht"));
	for (who, line) in [(&b, "schöpfe"), (&b, "schöpfe")] { run(&mut w, who, line, 0.0); }
	w.write(obj! { "type" => "Building", "fields" => obj! { "buildId" => "h-1", "plan" => "huette", "name" => "Hütte", "room" => "graue-bucht", "x" => 6.0, "y" => 14.0, "w" => 2.0, "h" => 2.0, "owner" => "c-walk9", "ownerName" => "Jemand", "accountId" => "a-walk9", "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } });
	run(&mut w, &b, "schöpfe", 0.0);
	// a bed nobody tends goes back to grass, and the seed rests go
	run(&mut w, &a, "beet", 15.0 * 86_400_000.0);
	w.call("gardenTick", None);
	run(&mut w, &a, "beet", 0.0);
	assert!(w.take(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-bucht" } }));
	run(&mut w, &a, "umgraben 11 10", 0.0);
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 25 && said.iter().filter(|r| r.starts_with("refused")).count() > 20, "{said:?}");
	assert!(w.entries_with(r#""Variety""#) + w.entries_with("Kreuzung") >= 1, "nothing crossed");
}

/// Fields (field.ts): staking one out with its refusals, choosing the crop, seed and work points with their rests, an open
/// field with a helper, the field tick ripening it, fertiliser, the harvest's shares over many hands, tired soil after the
/// same crop again, a crop left too late and lost, sowing from `pflanze`, and giving a field up.
#[test]
fn farming() {
	let mut w = Walk::new("farming", 47, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (4.0, 12.0), true, false);
	let g = w.player(3, "graue-bucht", (6.0, 12.0), true);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	give(&mut w, &a, "weizen", 6);
	give(&mut w, &b, "weizen", 2);
	give(&mut w, &a, "knochenmehl", 3);
	w.write(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-bucht", "until" => 9e15, "litAt" => 0.0 } });
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| {
		step += 1;
		at.set(at.get() + 7_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r);
	};
	for (who, line) in [(&a, "flur"), (&g, "flur anlegen"), (&a, "flur anlegen"), (&a, "bestelle"), (&a, "pflanze weizen"), (&a, "pflanze gerste")] { run(&mut w, who, line, 0.0); }
	w.write(obj! { "type" => "Epoch", "fields" => obj! { "island" => "Graue Insel", "epoch" => 2.0, "points" => 100.0, "at" => START } });
	run(&mut w, &a, "flur anlegen", 0.0);
	give(&mut w, &a, "spaten", 1);
	for (who, line) in [
		(&a, "flur anlegen 30 30"), (&a, "flur anlegen 3 12"), (&a, "flur anlegen"), (&a, "flur"), (&a, "flur ansehen 4 13"), (&a, "flur ansehen 20 2"), (&b, "bestelle weizen"), (&b, "flur offen"),
		(&a, "bestelle"), (&a, "bestelle gibtsnicht"), (&a, "bestelle mit weizen"), (&a, "bestelle gerste"), (&a, "bestelle weizen"), (&a, "flur"), (&a, "flur offen"), (&b, "bestelle weizen"), (&b, "bestelle"),
		(&a, "dünge"), (&a, "ernte"), (&a, "ernte flur"),
	] { run(&mut w, who, line, 0.0); }
	for (who, line) in [(&a, "bestelle"), (&a, "bestelle"), (&a, "flur"), (&a, "dünge"), (&a, "ernte"), (&a, "bestelle")] { run(&mut w, who, line, 3_600_000.0); }
	// ripening, fertiliser, then the harvest in many hands
	assert_eq!(w.call("fieldTick", None), Json::from(0.0));
	run(&mut w, &a, "dünge", 0.0);
	run(&mut w, &a, "dünge", 0.0);
	run(&mut w, &a, "flur", 150.0 * 3_600_000.0);
	w.call("fieldTick", None);
	for (who, line) in [(&a, "flur"), (&a, "dünge"), (&a, "bestelle"), (&a, "ernte"), (&b, "ernte"), (&g, "ernte"), (&a, "ernte"), (&a, "flur zu"), (&b, "ernte"), (&a, "flur offen")] { run(&mut w, who, line, 0.0); }
	for _ in 0..4 { for (who, line) in [(&a, "ernte flur"), (&b, "ernte")] { run(&mut w, who, line, 2_000_000.0); } }
	for (who, line) in [(&a, "flur"), (&a, "inventory"), (&b, "inventory")] { run(&mut w, who, line, 2_000_000.0); }
	// the same group again (barley after wheat): the soil is tired; then it is left too late and lost
	give(&mut w, &a, "gerste", 1);
	for (who, line) in [(&b, "bestelle gerste"), (&a, "dünge"), (&a, "pflanze gerste"), (&a, "ernte"), (&a, "dünge")] { run(&mut w, who, line, 0.0); }
	for (who, line) in [(&a, "bestelle"), (&a, "bestelle")] { run(&mut w, who, line, 3_600_000.0); }
	give(&mut w, &a, "gerste", 3);
	for (who, line) in [(&a, "bestelle"), (&a, "flur"), (&a, "dünge")] { run(&mut w, who, line, 0.0); }
	run(&mut w, &a, "flur", 150.0 * 3_600_000.0);
	w.call("fieldTick", None);
	run(&mut w, &a, "flur", 0.0);
	run(&mut w, &a, "ernte", 0.0);
	run(&mut w, &a, "flur", 50.0 * 3_600_000.0);
	w.call("fieldTick", None);
	for (who, line) in [(&a, "flur"), (&a, "ernte"), (&b, "ernte")] { run(&mut w, who, line, 2_000_000.0); }
	run(&mut w, &a, "flur", 50.0 * 3_600_000.0);
	w.call("fieldTick", None);
	for (who, line) in [(&a, "flur"), (&b, "flur aufgeben"), (&a, "flur zu"), (&a, "flur aufgeben"), (&a, "flur"), (&a, "pflanze weizen")] { run(&mut w, who, line, 0.0); }
	// one nobody works goes back to grass
	run(&mut w, &a, "flur anlegen", 0.0);
	run(&mut w, &a, "flur", 15.0 * 86_400_000.0);
	w.call("fieldTick", None);
	run(&mut w, &a, "flur", 0.0);
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 25 && said.iter().filter(|r| r.starts_with("refused")).count() > 15, "{said:?}");
	assert!(w.entries_with("ist eingebracht") >= 1, "nothing was brought in");
}

/// Animals (animals.ts): a coop with its refusals (the kind, its house, the epoch, full), feeding by anyone, yields
/// counted on lazily and collected (also through `sammle eier`), a young one born, taking them out, slaughtering in
/// the coop and at the butcher's shop with the knife wearing, and a dog and a cat keeping watch at a building.
#[test]
fn keeping_animals() {
	let mut w = Walk::new("keeping_animals", 53, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (6.0, 13.0), true);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	for (p, k) in [("huhn", 4), ("kueken", 1), ("schaf", 1), ("rind", 1), ("hund", 1), ("katze", 1), ("weizen", 12), ("kohl", 4), ("ei", 2), ("stein", 1)] { give(&mut w, &a, p, k); }
	give(&mut w, &b, "kohl", 3);
	for p in ["huhn", "schaf", "ziege"] { give(&mut w, &b, p, 1); }
	give(&mut w, &b, "milch", 2);
	for (id, to, wear) in [("k-1", &a, 4.0), ("k-2", &b, 2.0)] { let mut f = thing(&world, id, "muschelmesser", to).get("fields").cloned().unwrap(); walk::j_set(&mut f, "wear", Json::from(wear)); w.write(obj! { "type" => "Item", "fields" => f }); }
	let building = |id: &str, plan: &str, name: &str, x: f64, y: f64, owner: usize| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => plan, "name" => name, "room" => "graue-bucht", "x" => x, "y" => y, "w" => 2.0, "h" => 2.0, "owner" => format!("c-walk{owner}"), "ownerName" => format!("Wanderer{owner}"), "accountId" => format!("a-walk{owner}"), "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| {
		step += 1;
		at.set(at.get() + 7_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r);
	};
	for (who, line) in [(&a, "stall"), (&a, "füttere"), (&a, "einsammeln"), (&a, "wache"), (&a, "schlachte")] { run(&mut w, who, line, 0.0); }
	w.write(building("s-1", "huehnerstall", "Hühnerstall", 5.0, 11.0, 1));
	w.write(building("h-1", "huette", "Hütte", 2.0, 13.0, 1));
	w.write(building("p-2", "gehege", "Gehege", 9.0, 12.0, 2));
	let day = 86_400_000.0;
	for (who, line) in [
		(&a, "stall"), (&b, "stall"), (&g, "einstallen"), (&a, "einstallen gibtsnicht"), (&a, "einstallen rind"), (&a, "einstallen schaf"), (&a, "einstallen kueken"), (&a, "stall"), (&a, "einstallen"), (&a, "einstallen ein huhn"), (&a, "einstallen huhn"), (&a, "stall"),
		(&b, "einstallen huhn"), (&b, "ausstallen"), (&a, "einsammeln"), (&a, "sammle eier"), (&b, "einsammeln"), (&a, "ausstallen"), (&a, "füttere ei"), (&a, "füttere stein"), (&a, "füttere 2 weizen"), (&a, "füttere"), (&a, "füttere kohl"), (&a, "stall"), (&g, "stall"),
	] { run(&mut w, who, line, 0.0); }
	for (who, line) in [(&a, "stall"), (&a, "sammle die eier"), (&a, "einsammeln"), (&b, "füttere die hühner mit kohl"), (&a, "stall")] { run(&mut w, who, line, day); }
	for (who, line) in [(&a, "stall"), (&a, "einsammeln"), (&a, "füttere alle weizen"), (&b, "füttere"), (&a, "stall")] { run(&mut w, who, line, 3.0 * day); }
	for (who, line) in [(&a, "stall"), (&a, "einsammeln"), (&a, "füttere"), (&a, "stall")] { run(&mut w, who, line, 2.5 * day); }
	for (who, line) in [(&a, "stall"), (&a, "einsammeln"), (&a, "schlachte hund"), (&a, "schlachte schaf"), (&a, "schlachte das huhn"), (&a, "schlachte"), (&a, "schlachte"), (&a, "schlachte"), (&b, "schlachte"), (&a, "inventory")] { run(&mut w, who, line, 2.0 * day); }
	for (who, line) in [(&a, "ausstallen kueken"), (&a, "ausstallen"), (&a, "stall"), (&a, "ausstallen"), (&a, "ausstallen"), (&a, "ausstallen"), (&a, "stall"), (&a, "füttere")] { run(&mut w, who, line, 0.0); }
	give(&mut w, &a, "huhn", 3);
	for _ in 0..7 { run(&mut w, &a, "einstallen huhn", 0.0); }
	run(&mut w, &a, "stall", 0.0);
	// the pen of another and the guards
	stand(&mut w, 2, "graue-bucht", 8.0, 13.0);
	for (who, line) in [(&b, "stall"), (&b, "einstallen huhn"), (&b, "einstallen schaf"), (&b, "einstallen ziege"), (&b, "füttere"), (&b, "füttere 1 kohl"), (&b, "stall"), (&b, "wache"), (&a, "wache")] { run(&mut w, who, line, 0.0); }
	w.write(building("h-2", "huette", "Hütte", 4.0, 15.0, 1));
	stand(&mut w, 1, "graue-bucht", 3.0, 15.0);
	stand(&mut w, 2, "graue-bucht", 4.0, 14.0);
	for (who, line) in [(&a, "ausstallen hund"), (&a, "füttere katze"), (&a, "einstallen hund"), (&a, "einstallen katze"), (&a, "wache"), (&a, "füttere katze stein"), (&b, "füttere katze"), (&a, "füttere hund stein"), (&a, "füttere hund 1 ei"), (&a, "füttere den hund mit 1 ei"), (&a, "füttere hund"), (&a, "füttere hund"), (&a, "füttere"), (&b, "füttere hund"), (&a, "wache"), (&a, "schlachte hund"), (&a, "ausstallen katze"), (&a, "ausstallen hund"), (&a, "ausstallen hund")] { run(&mut w, who, line, 0.0); }
	// at the butcher's shop with an animal carried
	w.write(building("m-1", "metzgerei", "Metzgerei", 12.0, 13.0, 9));
	stand(&mut w, 1, "graue-bucht", 12.0, 12.0);
	for (who, line) in [(&a, "schlachte hund"), (&a, "schlachte ziege"), (&a, "schlachte"), (&a, "schlachte huhn"), (&a, "schlachte"), (&a, "schlachte"), (&a, "schlachte"), (&a, "inventory")] { run(&mut w, who, line, 0.0); }
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 25 && said.iter().filter(|r| r.starts_with("refused")).count() > 20, "{said:?}");
}

/// The wild from the fog (wild.ts): hares at a bed, a deer at a field, a fox at a coop, mice at a chest and gulls at a
/// smokehouse coming in a room in fog and eating, scared off (`scheuche` with its refusals), fences round the bed, the
/// field and the coop (`zäune`), a mousetrap and a net, a scarecrow and fed guards keeping them off.
#[test]
fn the_wild() {
	let mut w = Walk::new("the_wild", 54, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (5.0, 13.0), true, false);
	let b = w.player_as(2, "graue-bucht", (7.0, 13.0), true, false);
	let g = w.player(3, "graue-bucht", (6.0, 12.0), true);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	for (p, k) in [("spaten", 1), ("samen-strandnelke", 4), ("samen-duenenrose", 3), ("wasserkanne", 22), ("weizen", 6), ("huhn", 4), ("treibholz", 1), ("tangseil", 1)] { give(&mut w, &a, p, k); }
	give(&mut w, &b, "samen-strandkohl", 3);
	give(&mut w, &b, "spaten", 1);
	give(&mut w, &b, "wasserkanne", 22);
	let building = |id: &str, plan: &str, name: &str, x: f64, y: f64, sz: (f64, f64), owner: usize| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => plan, "name" => name, "room" => "graue-bucht", "x" => x, "y" => y, "w" => sz.0, "h" => sz.1, "owner" => format!("c-walk{owner}"), "ownerName" => format!("Wanderer{owner}"), "accountId" => format!("a-walk{owner}"), "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	w.write(obj! { "type" => "Flame", "fields" => obj! { "beaconId" => "feuer-bucht", "until" => 9e15, "litAt" => 0.0 } });
	w.write(obj! { "type" => "Epoch", "fields" => obj! { "island" => "Graue Insel", "epoch" => 2.0, "points" => 100.0, "at" => START } });
	w.write(building("s-1", "huehnerstall", "Hühnerstall", 5.0, 11.0, (2.0, 1.0), 1));
	w.write(building("h-1", "huette", "Hütte", 9.0, 12.0, (2.0, 2.0), 2));
	w.write(building("r-1", "raeucherei", "Räucherei", 12.0, 13.0, (2.0, 2.0), 1));
	for (p, k) in [("weizen", 4), ("brot", 1)] { give(&mut w, "h-1", p, k); }
	give(&mut w, "r-1", "fisch", 4);
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| {
		step += 1;
		at.set(at.get() + 7_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r);
	};
	// nothing to scare, nothing to fence; then two beds (the second by a scarecrow), a field and the coop's hens
	for (who, line) in [(&a, "scheuche"), (&a, "scheuche hase"), (&a, "scheuche gibtsnicht"), (&a, "zäune"), (&a, "umgraben 4 13"), (&a, "pflanze 3 strandnelken"), (&b, "umgraben 7 14"), (&b, "pflanze 3 samen-strandkohl")] { run(&mut w, who, line, 0.0); }
	w.write(building("v-1", "vogelscheuche", "Vogelscheuche", 9.0, 15.0, (1.0, 1.0), 2));
	stand(&mut w, 1, "graue-bucht", 5.0, 12.0);
	for _ in 0..3 { run(&mut w, &a, "einstallen huhn", 0.0); }
	stand(&mut w, 1, "graue-bucht", 2.0, 9.0);
	for (who, line) in [(&a, "flur anlegen"), (&a, "flur"), (&a, "bestelle weizen")] { run(&mut w, who, line, 0.0); }
	for _ in 0..3 { run(&mut w, &a, "bestelle", 3_600_000.0); }
	run(&mut w, &a, "flur", 0.0);
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	stand(&mut w, 3, "graue-bucht", 22.0, 8.0);
	// the fog comes; the wild with it, every twenty minutes through a night, with someone scaring off what comes now
	// and then (and one too far away to)
	w.write(obj! { "type" => "Fog", "fields" => obj! { "room" => "graue-bucht", "level" => 3.0 } });
	let mut got = (0.0, 0.0);
	let tick = |w: &mut Walk, got: &mut (f64, f64)| { let r = w.call("wildTick", None); eprintln!("wildTick -> {}", r.to_json_text()); got.0 += r.get("came").and_then(Json::as_f64).unwrap(); got.1 += r.get("ate").and_then(Json::as_f64).unwrap(); };
	for i in 0..60 {
		run(&mut w, &g, "look", 20.0 * 60_000.0);
		tick(&mut w, &mut got);
		if i % 6 == 2 { for line in ["scheuche den hasen weg", "scheuche reh", "scheuche die maus fort", "scheuche möwe", "scheuche fuchs", "scheuche"] { run(&mut w, &a, line, 0.0); } }
		if i % 7 == 4 { run(&mut w, &g, "scheuche alle", 0.0); }
		if i % 3 == 0 { run(&mut w, &a, "gieße", 0.0); run(&mut w, &b, "gieße", 0.0); w.call("gardenTick", None); }
	}
	// a scarecrow by the field, then fences, traps and the guards
	w.write(building("v-2", "vogelscheuche", "Vogelscheuche", 1.0, 8.0, (1.0, 1.0), 1));
	stand(&mut w, 1, "graue-bucht", 5.0, 13.0);
	run(&mut w, &a, "zäune", 0.0);
	give(&mut w, &a, "treibholz", 13);
	give(&mut w, &a, "tangseil", 4);
	run(&mut w, &a, "zäune", 0.0);
	run(&mut w, &a, "zäune", 0.0);
	stand(&mut w, 2, "graue-bucht", 12.0, 9.0);
	run(&mut w, &b, "zäune", 0.0);
	give(&mut w, "h-1", "mausefalle", 1);
	give(&mut w, "r-1", "netz", 1);
	for _ in 0..24 { run(&mut w, &g, "look", 20.0 * 60_000.0); tick(&mut w, &mut got); }
	stand(&mut w, 1, "graue-bucht", 7.0, 11.0);
	run(&mut w, &a, "zäune", 0.0);
	run(&mut w, &a, "zäune", 0.0);
	stand(&mut w, 1, "graue-bucht", 2.0, 9.0);
	run(&mut w, &a, "zäune", 0.0);
	run(&mut w, &a, "zäune", 0.0);
	for _ in 0..12 { run(&mut w, &g, "look", 20.0 * 60_000.0); tick(&mut w, &mut got); }
	let mut f = w.peek(obj! { "type" => "Building", "fields" => obj! { "buildId" => "h-1" } }).unwrap().get("fields").cloned().unwrap();
	assert!(w.take(obj! { "type" => "Building", "fields" => obj! { "buildId" => "h-1" } }));
	walk::j_set(&mut f, "keeper", obj! { "kind" => "katze", "fedUntilWorldMs" => 9e15 });
	w.write(obj! { "type" => "Building", "fields" => f });
	w.write(obj! { "type" => "Building", "fields" => { let mut x = building("h-2", "huette", "Hütte", 18.0, 13.0, (2.0, 2.0), 2).get("fields").cloned().unwrap(); walk::j_set(&mut x, "keeper", obj! { "kind" => "hund", "fedUntilWorldMs" => 9e15 }); x } });
	assert!(w.take(obj! { "type" => "Item", "fields" => obj! { "location" => "h-1", "proto" => "mausefalle" } }));
	// the job as the worker runs it
	for _ in 0..12 { run(&mut w, &g, "look", 20.0 * 60_000.0); w.tick("wild"); }
	eprintln!("came {} ate {}", got.0, got.1);
	assert!(got.0 >= 8.0 && got.1 >= 3.0, "{got:?}");
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 15 && said.iter().filter(|r| r.starts_with("refused")).count() > 8, "{said:?}");
}

/// Roads and carts, the railway (cart.ts) and the garden job whole: a cart set down, loaded and unloaded with its
/// refusals, driven along two roads a room an hour, put on a route between two chests it loads and unloads by itself,
/// stopped and taken along; the island railway between stations with its timetable, freight sent and fetched, a ride.
#[test]
fn carts_and_trains() {
	let mut w = Walk::new("carts_and_trains", 55, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (19.0, 8.0), true, false);
	let b = w.player_as(2, "graue-bucht", (18.0, 9.0), true, false);
	let g = w.player(3, "graue-bucht", (17.0, 8.0), true);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	for (p, k) in [("karren", 2), ("treibholz", 5), ("muschel", 3), ("tangseil", 2), ("muenze", 4)] { give(&mut w, &a, p, k); }
	give(&mut w, &b, "muenze", 1);
	give(&mut w, &b, "treibholz", 1);
	let building = |id: &str, plan: &str, room: &str, x: f64, y: f64, sz: (f64, f64), owner: usize| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => plan, "name" => plan, "room" => room, "x" => x, "y" => y, "w" => sz.0, "h" => sz.1, "owner" => format!("c-walk{owner}"), "ownerName" => format!("Wanderer{owner}"), "accountId" => format!("a-walk{owner}"), "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	w.write(building("road-1", "strasse", "graue-bucht", 21.0, 8.0, (1.0, 1.0), 1));
	w.write(building("road-2", "strasse", "klippenpfad", 22.0, 7.0, (1.0, 1.0), 1));
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| {
		step += 1;
		at.set(at.get() + 7_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r);
	};
	let hour = 3_600_000.0;
	for (who, line) in [
		(&g, "karren"), (&a, "karren"), (&a, "karren lade treibholz"), (&a, "karren halt"), (&a, "karren stelle"), (&b, "karren stelle"), (&a, "karren"), (&a, "karren lade"), (&a, "karren lade gibtsnicht"), (&a, "karren lade karren"),
		(&a, "karren lade treibholz"), (&a, "karren lade den treibholz"), (&a, "karren entlade"), (&a, "karren entlade"), (&a, "karren lade muschel"), (&a, "karren nimm"), (&a, "karren hüpfe"),
		(&a, "karren fahre nirgendwo"), (&a, "karren fahre Fischerdorf"), (&a, "karren fahre klippenkopf"), (&a, "karren lade treibholz"), (&a, "karren"),
	] { run(&mut w, who, line, 0.0); }
	// a room an hour, then the notice
	assert_eq!(w.call("cartTick", None), Json::from(0.0));
	for _ in 0..3 { run(&mut w, &a, "karren", hour); w.call("cartTick", None); }
	// the other cart on a route between two chests
	for (who, line) in [(&a, "karren stelle"), (&a, "karren pendel Graue Bucht"), (&a, "karren pendel Fischerdorf"), (&a, "karren pendel nirgendwo"), (&a, "karren pendel Klippenpfad mit gibtsnicht"), (&a, "karren pendel Klippenpfad")] { run(&mut w, who, line, 0.0); }
	w.write(building("h-1", "huette", "graue-bucht", 15.0, 10.0, (2.0, 2.0), 1));
	w.write(building("h-2", "huette", "klippenpfad", 14.0, 10.0, (2.0, 2.0), 1));
	w.write(building("h-3", "huette", "klippenpfad", 4.0, 10.0, (2.0, 2.0), 2));
	give(&mut w, "h-1", "treibholz", 3);
	give(&mut w, "h-1", "muschel", 2);
	give(&mut w, "h-1", "muenze", 2);
	for (who, line) in [(&a, "karren pendel Klippenpfad mit dem Treibholz"), (&a, "karren")] { run(&mut w, who, line, 0.0); }
	// the garden job as the worker runs it: load, go, unload, come back, wait with nothing to carry
	// and a figure aboard whose ship has come (an intent to land), one still on the way
	w.write(obj! { "type" => "Passage", "fields" => obj! { "charId" => "c-walk8", "to" => "klippenpfad", "arriveWorldMs" => 0.0 } });
	w.write(obj! { "type" => "Passage", "fields" => obj! { "charId" => "c-walk9", "to" => "klippenpfad", "arriveWorldMs" => 9e15 } });
	for _ in 0..6 { run(&mut w, &g, "look", hour); w.tick("garden"); }
	for (who, line) in [(&a, "karren"), (&a, "karren halt"), (&a, "karren halt")] { run(&mut w, who, line, 0.0); }
	for _ in 0..2 { run(&mut w, &g, "look", hour); w.tick("garden"); }
	stand(&mut w, 1, "graue-bucht", 10.0, 9.0);
	for (who, line) in [(&a, "karren"), (&a, "karren entlade"), (&a, "karren nimm"), (&a, "karren nimm")] { run(&mut w, who, line, 0.0); }
	// the railway: three stations on this island, one on another
	w.write(building("bf-1", "bahnhof", "graue-bucht", 14.0, 4.0, (3.0, 2.0), 1));
	w.write(building("bf-2", "bahnhof", "klippenpfad", 9.0, 5.0, (3.0, 2.0), 1));
	w.write(building("bf-3", "bahnhof", "klippenpfad", 2.0, 12.0, (3.0, 2.0), 2));
	w.write(building("bf-4", "bahnhof", "fischerdorf", 9.0, 9.0, (3.0, 2.0), 2));
	w.write(building("bf-5", "bahnhof", "moewenfels-strand", 9.0, 9.0, (3.0, 2.0), 2));
	run(&mut w, &a, "zug", 0.0);
	stand(&mut w, 1, "graue-bucht", 13.0, 5.0);
	stand(&mut w, 2, "graue-bucht", 15.0, 6.0);
	stand(&mut w, 3, "graue-bucht", 17.0, 5.0);
	for round in 0..3 {
		for (who, line) in [
			(&a, "zug"), (&a, "zug gibtsnicht"), (&a, "zug sende treibholz nach Nirgendwo"), (&a, "zug sende gibtsnicht nach Klippenpfad"), (&g, "zug sende muschel nach klippenpfad"),
			(&a, "zug sende 2 treibholz nach Klippenpfad"), (&a, "zug sende alle nach fischerdorf"), (&b, "zug sende treibholz nach klippenpfad"), (&b, "zug Fischerdorf"),
		] { run(&mut w, who, line, 0.0); }
		run(&mut w, &a, "zug", 11.0 * 60_000.0 * (round + 1) as f64);
	}
	give(&mut w, &a, "muenze", 2);
	give(&mut w, &a, "muschel", 30);
	for _ in 0..3 { for (who, line) in [(&a, "zug sende 25 muschel nach klippenpfad"), (&a, "zug klippenpfad")] { run(&mut w, who, line, 0.0); } run(&mut w, &a, "zug", 10.0 * 60_000.0); }
	for (who, line) in [(&a, "zug"), (&a, "zug abholen"), (&a, "zug abholen"), (&a, "inventory")] { run(&mut w, who, line, 0.0); }
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 25 && said.iter().filter(|r| r.starts_with("refused")).count() > 20, "{said:?}");
	assert!(w.entries_with("angekommen") >= 1, "the cart never arrived");
}

/// The water (fishing.ts, passage.ts, liner.rs): the net beside a jetty, sand from the beach, a boat's hatch loaded and
/// unloaded to the full, rowing between the jetties of an island and sailing to another, then the large ship: the
/// timetable, waiting for it, boarding with the fare, refused aboard, and landing by the intent the garden job sends.
#[test]
fn on_the_water() {
	let mut w = Walk::new("on_the_water", 56, START);
	w.load(false);
	let a = w.player_as(1, "graue-bucht", (12.0, 9.0), true, false);
	let b = w.player_as(2, "graue-bucht", (6.0, 8.0), true, false);
	let world = w.w.clone();
	let mut n = 0;
	let mut give = |w: &mut Walk, to: &str, proto: &str, k: usize| { for _ in 0..k { n += 1; w.write(thing(&world, &format!("t-{n}"), proto, to)); } };
	for (p, k) in [("netz", 1), ("ruderboot", 1), ("segelboot", 1), ("spaten", 1), ("muenze", 5), ("muschel", 25)] { give(&mut w, &a, p, k); }
	give(&mut w, &b, "muschel", 1);
	let building = |id: &str, room: &str, x: f64, y: f64| obj! { "type" => "Building", "fields" => obj! { "buildId" => id, "plan" => "steg", "name" => "Steg", "room" => room, "x" => x, "y" => y, "w" => 2.0, "h" => 1.0, "owner" => "c-walk9", "ownerName" => "Wanderer9", "accountId" => "a-walk9", "beaconId" => "feuer-bucht", "points" => 1.0, "by" => obj! {}, "untilWorldMs" => 9e15, "builtAt" => 0.0 } };
	w.write(building("st-1", "graue-bucht", 5.0, 7.0));
	w.write(building("st-2", "klippenpfad", 10.0, 6.0));
	w.write(building("st-3", "moewenfels-strand", 11.0, 7.0));
	w.compare("setup");
	let at = std::cell::Cell::new(START);
	let mut said = Vec::new();
	let mut step = 0;
	let mut run = |w: &mut Walk, who: &str, line: &str, later: f64| -> String {
		step += 1;
		at.set(at.get() + 7_000.0 + later);
		w.at(at.get());
		let r = w.cmd(who, line, None);
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{step}: {who} {line} -> {r}"));
		said.push(r.clone());
		r
	};
	let rest = 15.0 * 60_000.0;
	for (who, line) in [(&a, "wirf netz"), (&a, "wirf ball"), (&a, "luke"), (&b, "luke"), (&a, "luke lade muschel"), (&b, "rudere"), (&a, "rudere"), (&a, "segle"), (&a, "schaufle"), (&b, "wirf netz"), (&b, "schaufle")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 1, "graue-bucht", 5.0, 8.0);
	run(&mut w, &a, "wirf das netz", 0.0);
	run(&mut w, &a, "wirf netz", 0.0);
	for _ in 0..4 { run(&mut w, &a, "wirf netz", rest); }
	run(&mut w, &a, "schaufle", rest);
	run(&mut w, &a, "schaufle", 0.0);
	for (who, line) in [
		(&a, "luke"), (&a, "luke lade"), (&a, "luke hüpfe"), (&a, "luke lade 3 muschel"), (&a, "luke lade gibtsnicht"), (&a, "luke lade segelboot"), (&a, "luke"), (&a, "luke entlade 2 muschel"), (&a, "luke entlade gibtsnicht"),
		(&a, "luke lade alle"), (&a, "luke lade muschel"), (&a, "luke"), (&a, "luke entlade"), (&a, "luke entlade alle"), (&a, "luke lade 4 muschel"),
		(&a, "rudere"), (&a, "rudere nirgendwo"), (&a, "rudere klippenpfad"), (&a, "schaufle"), (&a, "rudere"), (&a, "rudere graue bucht"),
		(&a, "segle"), (&a, "segle atlantis"), (&a, "segle möwenfels"),
	] { run(&mut w, who, line, 0.0); }
	run(&mut w, &a, "segle möwenfels", rest);
	run(&mut w, &a, "luke", 0.0);
	run(&mut w, &a, "segle graue insel", rest);
	// the large ship
	for (who, line) in [(&a, "fahrplan"), (&a, "einschiffen möwenfels")] { run(&mut w, who, line, 0.0); }
	stand(&mut w, 1, "graue-bucht", 10.0, 8.0);
	let mut boarded = false;
	for _ in 0..60 {
		run(&mut w, &a, "fahrplan", 0.0);
		if run(&mut w, &a, "einschiffen gibtsnicht", 0.0) == "ran" { break; }
		if run(&mut w, &a, "einschiffen tangriff", 0.0) == "ran" { boarded = true; break; }
		run(&mut w, &a, "look", 25.0 * 60_000.0);
	}
	assert!(boarded, "the ship never lay in the bay");
	for line in ["look", "schaufle", "west", "fahrplan", "ausschiffen", "ausschiffen nächster"] { run(&mut w, &a, line, 0.0); }
	let mut landed = false;
	for _ in 0..60 {
		run(&mut w, &b, "look", 25.0 * 60_000.0);
		w.tick("garden");
		run(&mut w, &a, "look", 0.0);
		if w.where_is(&a).0 != "graue-bucht" { landed = true; break; }
	}
	assert!(landed, "never landed");
	for line in ["ausschiffen", "fahrplan", "inventory"] { run(&mut w, &a, line, 0.0); }
	assert!(said.iter().filter(|r| r.as_str() == "ran").count() > 20 && said.iter().filter(|r| r.starts_with("refused")).count() > 20, "{said:?}");
}
