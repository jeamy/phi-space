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
