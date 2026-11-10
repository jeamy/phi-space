//! A courier (`server/engine/courier.ts`, docs/siedeln.en.md "Load"): what a player puts into a chest of its own in
//! another region, one of the orders out of a region (transfer.rs). `verstaue` moves the things to the courier's id and
//! writes a Courier; a world worker of A writes them into the chest in B (one already anywhere in B is not written
//! twice) and takes them in A. A chest become a ruin gets them in its estate; a building gone without one, a new estate.
use phi_json::{obj, Json};

use crate::clock::world_now_of;
use crate::handover::holders_of;
use crate::j;
use crate::space::{tmpl, Result, Space, FOREVER, NO_WAIT};
use crate::transfer::{move_things, MoveOptions};

/// The Courier's step 2 (`couriers(w).carry`).
pub async fn carry(here: &Space, there: &Space, w: &Json, f: &Json) -> Result<()> {
	let build_id = j::s(f, "buildId");
	let mut to = build_id.to_owned();
	if there.read_if_exists(&tmpl("Building", obj! { "buildId" => build_id }), NO_WAIT, None).await?.is_none() {
		to = format!("est-{build_id}");
		if there.read_if_exists(&tmpl("Estate", obj! { "estateId" => to.as_str() }), NO_WAIT, None).await?.is_none() {
			let until = world_now_of(there, None).await? + j::no(j::at(w, "building"), "estateWorldMs").unwrap_or(30.0 * 24.0 * 3_600_000.0);
			let est = obj! { "estateId" => to.as_str(), "accountId" => j::at(f, "accountId").clone(), "ownerName" => j::at(f, "ownerName").clone(), "room" => j::at(f, "room").clone(), "name" => j::at(f, "name").clone(), "untilWorldMs" => until };
			there.write(&tmpl("Estate", est), None, FOREVER).await?;
		}
	}
	move_things(here, there, j::s(f, "courierId"), &to, &MoveOptions { holders: holders_of(w), anywhere: true }).await?;
	Ok(())
}
