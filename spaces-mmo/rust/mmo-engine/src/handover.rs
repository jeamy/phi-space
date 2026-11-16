//! A character crossing to another region (`server/engine/handover.ts`), one of the orders out of a region
//! (transfer.rs), in steps, each atomic and repeatable:
//!   1. in region A, in the command's transaction: the character, its cell and its account are taken and a Handover
//!      written (`hand_off`); what it carries stays in A, out of anyone's reach.
//!   2. a world worker of A takes the Handover and carries the pack over (`move_things`).
//!   3. the character is written into region B in one transaction of B (`arrive`); one already there means an earlier
//!      try got that far.
//!   4. A's transaction is committed: the Handover and the old token are gone.
use phi_json::{obj, Json};

use crate::context::Ctx;
use crate::fire::key_text;
use crate::j;
use crate::model::actor_token;
use crate::occupancy::{blocked_in, cell_key, claim_spot, free_cell_near, is_passage, occupied_in};
use crate::room_growth::{grown_point, pin_terrain, rows};
use crate::source::time_now;
use crate::space::{fields, refuse, tmpl, Error, Result, Space, FOREVER, HELD_WAIT_MS, NO_WAIT};
use crate::transfer::{move_things, MoveOptions};

/// A guest account's lease, as the accounts write it.
fn guest_ms() -> f64 { std::env::var("SPACES_MMO_GUEST_TTL_MS").ok().and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite()).unwrap_or(7.0 * 24.0 * 3_600_000.0) }

/// `handOff`, step 1 inside the command's transaction in region `from`: the character leaves for `room` at `at`
/// (`{x, y}`) in `to`.
pub async fn hand_off(c: &mut Ctx, from: &str, to: &str, room: &str, at: &Json, arrival_growth_revision: f64) -> Result<()> {
	let char_id = c.char_id().to_owned();
	let Some(e) = c.space.take(&tmpl("Character", obj! { "charId" => char_id.as_str() }), 5_000.0, c.txn()).await? else { return refuse("Deine Figur ist gerade nicht greifbar; bitte noch einmal.") };
	let ch = j::without(fields(&e), "refused");
	c.space.take_if_exists(&tmpl("Spot", obj! { "charId" => char_id.as_str() }), NO_WAIT, c.txn()).await?;
	let acc = match c.space.take_existing(&tmpl("Account", obj! { "accountId" => j::at(&ch, "accountId").clone() }), c.txn(), 2_000.0).await {
		Ok(a) => a,
		Err(Error::StillHeld(_)) => return Err(Error::Other("the account is held; the crossing is tried again".into())),
		Err(e) => return Err(e),
	};
	let mut character = j::object(&ch);
	character.insert("room", Json::from(room));
	for (k, v) in j::entries(at) { character.insert(k, v.clone()); }
	if let Some(s) = c.step.as_ref().filter(|s| j::truthy(s)) { character.insert("ack", s.clone()); }
	let handover = obj! {
		"arrivalGrowthRevision" => arrival_growth_revision,
		"handoverId" => format!("h-{char_id}-{}", crate::js::base36(time_now())), "charId" => char_id.as_str(), "from" => from, "to" => to,
		"character" => Json::Object(character), "account" => acc.map_or(Json::Null, |a| fields(&a).clone()), "at" => time_now()
	};
	c.space.write(&tmpl("Handover", handover), c.txn(), FOREVER).await?;
	Ok(())
}

/// `arrive`, step 3 in region `to`'s space: the character arrives; false when it was there already.
pub async fn arrive(space: &Space, w: &Json, h: &Json) -> Result<bool> {
	let txn = space.create_transaction(30_000.0).await?;
	let r: Result<bool> = async {
		pin_terrain(space, &txn).await?;
		let char_id = j::s(h, "charId");
		if space.read_existing(&tmpl("Character", obj! { "charId" => char_id }), Some(&txn), HELD_WAIT_MS).await?.is_some() { return Ok(false); }
		let ch = j::at(h, "character");
		if let Some(acc) = j::opt(h, "account").filter(|a| j::truthy(a)) {
			if space.read_existing(&tmpl("Account", obj! { "accountId" => j::at(acc, "accountId").clone() }), Some(&txn), HELD_WAIT_MS).await?.is_none() {
				space.write(&tmpl("Account", acc.clone()), Some(&txn), if j::b(acc, "guest") { guest_ms() } else { FOREVER }).await?;
			}
		}
		let room_id = j::s(ch, "room");
		let room = space.peek(&tmpl("Room", obj! { "roomId" => room_id }), None).await?.map(|e| fields(&e).clone());
		let growth = space.read_all(&tmpl("RoomGrowth", obj! { "roomId" => room_id }), Some(&txn)).await?.into_iter().next();
		let mut at = obj! { "x" => j::at(ch, "x").clone(), "y" => j::at(ch, "y").clone() };
		if let Some(g) = &growth { at = grown_point(&at, fields(g), j::no(h, "arrivalGrowthRevision").unwrap_or(0.0) as usize); }
		if let Some(room) = &room {
			let rid = j::s(room, "roomId");
			let exits: Vec<Json> = space.read_all(&tmpl("Exit", obj! { "location" => rid }), None).await?.iter().map(|e| fields(e).clone()).collect();
			if !is_passage(&exits, j::n(&at, "x"), j::n(&at, "y")) {
				let mut avoid: std::collections::HashSet<String> = occupied_in(space, rid, Some(char_id)).await?.into_iter().map(|(k, _)| k).collect();
				avoid.extend(blocked_in(space, rid).await?);
				let ground = rows(j::at(room, "ground"));
				for _ in 0..4 {
					let Some(cell) = free_cell_near(w, &ground, (j::n(&at, "x"), j::n(&at, "y")), &|k| avoid.contains(k), 8) else { break };
					if claim_spot(space, &txn, char_id, j::at(ch, "name"), rid, cell.0, cell.1).await?.is_none() { at = obj! { "x" => cell.0, "y" => cell.1 }; break; }
					avoid.insert(cell_key(cell.0, cell.1));
				}
			}
		}
		let mut f = j::object(ch);
		f.insert("x", j::at(&at, "x").clone());
		f.insert("y", j::at(&at, "y").clone());
		space.write(&tmpl("Character", Json::Object(f)), Some(&txn), FOREVER).await?;
		for it in j::a(h, "items") {
			let types: Vec<Json> = j::a(it, "types").iter().skip(1).cloned().collect();
			space.write(&obj! { "type" => j::at(it, "type").clone(), "types" => Json::Array(types), "fields" => j::at(it, "fields").clone() }, Some(&txn), FOREVER).await?;
		}
		if let Ok(None) = space.read_existing(&actor_token(char_id), Some(&txn), HELD_WAIT_MS).await { space.write(&actor_token(char_id), Some(&txn), FOREVER).await?; }
		let text = format!("{} kommt mit dem Kahn an.", key_text(j::at(ch, "name")));
		space.write(&tmpl("Msg", obj! { "room" => room_id, "to" => "*", "kind" => "info", "text" => text, "from" => "", "at" => time_now() }), Some(&txn), 60_000.0).await?;
		Ok(true)
	}.await;
	match r {
		Ok(true) => { space.commit(&txn).await?; Ok(true) }
		Ok(false) => { space.abort(&txn).await?; Ok(false) }
		Err(e) => { let _ = space.abort(&txn).await; Err(e) }
	}
}

/// `holdersOf`: what lies in a boat's hatch or backs a bill of exchange goes before its holder.
pub fn holders_of(w: &Json) -> Vec<String> {
	let mut out: Vec<String> = j::entries(j::at(j::at(w, "boat"), "hatch")).map(|(k, _)| k.to_owned()).collect();
	let note = j::at(j::at(w, "bank"), "note");
	if j::truthy(note) { out.push(key_text(j::at(note, "proto"))); }
	out
}

/// The Handover's steps 2 to 4 (`handovers(w).carry`).
pub async fn carry(here: &Space, there: &Space, w: &Json, h: &Json, txn: &str) -> Result<()> {
	let char_id = j::s(h, "charId");
	move_things(here, there, char_id, char_id, &MoveOptions { holders: holders_of(w), anywhere: false }).await?;
	arrive(there, w, h).await?;
	here.take_if_exists(&actor_token(char_id), NO_WAIT, Some(txn)).await?;
	Ok(())
}
