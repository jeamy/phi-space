//! The walk with model calls on and a small pack (docs/rust-portierung.en.md, R8.2): what a line not understood writes
//! for the model process (Translate), a translated line (`asked`) that acts on someone the player did not name, an
//! English player's messages, and the pack refused. A file of its own: the environment is the process's.
mod common;
#[path = "common/walk.rs"]
mod walk;

use walk::{Walk, START};

#[test]
fn with_the_model() {
	common::pin_env();
	std::env::set_var("SPACES_MMO_LLM", "1"); // the engine only writes Translate entries: no model process runs here
	std::env::set_var("SPACES_MMO_PACK_MAX", "2");
	let mut w = Walk::new("model", 23, START);
	w.load(false);
	let a = w.player(1, "graue-bucht", (10.0, 8.0), true);
	let _b = w.player_as(2, "graue-bucht", (12.0, 8.0), true, false);
	let lines: &[(&str, Option<&str>, Option<&str>)] = &[
		("tanze", None, None),
		("look niemand", None, None),
		("tanze", Some("tanz mal"), None),
		("look niemand", Some("schau nach niemand"), None),
		("give muschel an Wanderer2", Some("gib das dem da"), None),
		("look", None, Some("en")),
		("say hello", None, Some("en")),
		("gehe nach norden", None, None),
		("move 5 7", None, None), ("get treibholz", None, None),
		("move 14 5", None, None), ("get muschel", None, None),
		("move 17 9", None, None), ("get treibholz", None, None),
		("inventory", None, None), ("drop muschel", None, None), ("get muschel", None, None),
	];
	let mut said = Vec::new();
	for (i, (line, asked, lang)) in lines.iter().enumerate() {
		w.at(START + i as f64 * 13_000.0);
		let r = w.cmd_as(&a, line, None, *asked, *lang);
		eprintln!("{line} ({asked:?}) -> {r}");
		w.compare(&format!("{i}: {line} -> {r}"));
		said.push(r);
	}
	assert!(w.entries_with(r#""Translate""#) >= 2, "no Translate written");
	assert!(said.iter().any(|r| r.contains("Das trägst du nicht mehr")), "the pack never refused: {said:?}");
	assert!(said.iter().any(|r| r.contains("Meinst du Wanderer2")), "{said:?}");
}
