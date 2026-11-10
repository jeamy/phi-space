//! What goes from one region to another (`server/engine/transfer.ts`, docs/welt-aufteilen.en.md "Übergabe zwischen
//! Regionen"). There is no transaction across two spaces, so every such way has one shape:
//!   1. in region A, inside the command's transaction, an order of its own type is written (a Handover, a Courier) and
//!      what it carries is put out of anyone's reach in A.
//!   2. a world worker of A takes the order in a transaction of A (`carry_one`) and does its steps against region B,
//!      each atomic and repeatable; things go over by `move_things`, written in B first, then taken in A.
//!   3. A's transaction is committed: the order is gone. A worker that dies before lets it lapse; the next try takes it.
use std::future::Future;
use std::pin::Pin;

use phi_json::{obj, Json};

use crate::j;
use crate::space::{fields, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

/// How many things go over in one step (a commit has a limit).
pub const THINGS_PER_STEP: usize = 40;

/// `MoveOptions`: the holders' protos (what they hold goes first), and whether a thing may already be anywhere in B.
#[derive(Clone, Default)]
pub struct MoveOptions { pub holders: Vec<String>, pub anywhere: bool }

/// `moveThings`: every Item at `from` in `here` to `to` in `there`, THINGS_PER_STEP at a time; how many it wrote.
pub fn move_things<'a>(here: &'a Space, there: &'a Space, from: &'a str, to: &'a str, o: &'a MoveOptions) -> Pin<Box<dyn Future<Output = Result<usize>> + 'a>> {
	Box::pin(async move {
		let mut wrote = 0;
		for proto in &o.holders {
			for h in here.read_all(&tmpl("Item", obj! { "location" => from, "proto" => proto.as_str() }), None).await? {
				let id = crate::fire::key_text(j::at(fields(&h), "itemId"));
				wrote += move_things(here, there, &id, &id, o).await?;
			}
		}
		loop {
			let step = here.read_limit(&tmpl("Item", obj! { "location" => from }), THINGS_PER_STEP, None).await?;
			if step.is_empty() { return Ok(wrote); }
			let id_of = |e: &Json| j::at(fields(e), "itemId").clone();
			let there_ids: Vec<Json> = if o.anywhere {
				let ops: Vec<Json> = step.iter().map(|e| obj! { "op" => "read", "template" => tmpl("Item", obj! { "itemId" => id_of(e) }) }).collect();
				let r = there.batch(&ops).await?;
				let rs = r.as_array().cloned().unwrap_or_default();
				step.iter().enumerate().filter(|(i, _)| rs.get(*i).and_then(|x| x.get("entry")).is_some_and(|x| !x.is_null())).map(|(_, e)| id_of(e)).collect()
			} else {
				there.read_all(&tmpl("Item", obj! { "location" => to }), None).await?.iter().map(id_of).collect()
			};
			let missing: Vec<&Json> = step.iter().filter(|e| !there_ids.contains(&id_of(e))).collect();
			if !missing.is_empty() {
				let ops: Vec<Json> = missing.iter().map(|e| {
					let f = if from == to { fields(e).clone() } else { let mut f = j::object(fields(e)); f.insert("location", Json::from(to)); f.insert("x", Json::from(-1.0)); f.insert("y", Json::from(-1.0)); Json::Object(f) };
					let types: Vec<Json> = j::a(e, "types").iter().skip(1).cloned().collect();
					obj! { "op" => "write", "entry" => obj! { "type" => j::at(e, "type").clone(), "types" => Json::Array(types), "fields" => f }, "lease" => FOREVER }
				}).collect();
				there.batch(&ops).await?;
			}
			wrote += missing.len();
			let ops: Vec<Json> = step.iter().map(|e| obj! { "op" => "take", "template" => obj! { "id" => e.get("id").cloned().unwrap_or(Json::Null) } }).collect();
			here.batch(&ops).await?;
		}
	})
}

/// The kinds of order that go out of a region (`Carrier`): a character crossing, things into a chest of one's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Carrier { Handover, Courier }

impl Carrier {
	/// Its entry type in A.
	pub fn entry_type(self) -> &'static str { match self { Carrier::Handover => "Handover", Carrier::Courier => "Courier" } }
	/// Step 2: everything the order does; `txn` is A's transaction that holds it.
	async fn carry(self, here: &Space, there: &Space, w: &Json, f: &Json, txn: &str) -> Result<()> {
		match self {
			Carrier::Handover => crate::handover::carry(here, there, w, f, txn).await,
			Carrier::Courier => crate::courier::carry(here, there, w, f).await,
		}
	}
}

/// `carryOne`: one order taken in a transaction of A, carried, then A commits.
pub async fn carry_one(here: &Space, regions: &[(String, Space)], carrier: Carrier, w: &Json, e: &Json) -> Result<()> {
	let txn = here.create_transaction(60_000.0).await?;
	let r: Result<bool> = async {
		let Some(taken) = here.take_if_exists(&obj! { "id" => e.get("id").cloned().unwrap_or(Json::Null) }, NO_WAIT, Some(&txn)).await? else { return Ok(false) };
		let f = fields(&taken).clone();
		let to = j::s(&f, "to");
		let Some((_, there)) = regions.iter().find(|(id, _)| id == to) else { return Err(Error::Other(format!("no address for the region {to}"))) };
		carrier.carry(here, there, w, &f, &txn).await?;
		Ok(true)
	}.await;
	match r {
		Ok(true) => here.commit(&txn).await,
		Ok(false) => here.abort(&txn).await,
		Err(err) => { let _ = here.abort(&txn).await; Err(err) }
	}
}

/// One round of `carryOut`: the orders of `carrier` waiting in `here` now (at most 8), each carried. How many there were.
pub async fn carry_waiting(here: &Space, regions: &[(String, Space)], carrier: Carrier, w: &Json) -> Result<usize> {
	let waiting = here.read_limit(&obj! { "type" => carrier.entry_type() }, 8, None).await?;
	for e in &waiting { carry_one(here, regions, carrier, w, e).await?; }
	Ok(waiting.len())
}
