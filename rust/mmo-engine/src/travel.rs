//! How often a player travelled (`server/engine/travel.ts`): one Travel entry per character and region, raised inside the
//! command's transaction. Players, settlers and the figures a model plays count; the scripted NPCs do not.
use phi_json::{obj, Json};

use crate::context::{ensure_account, Ctx};
use crate::j;
use crate::space::{fields, tmpl, Result, FOREVER};

/// `countTrip`: one more `kind` for the actor (nothing for a scripted NPC).
pub async fn count_trip(c: &mut Ctx, kind: &str) -> Result<()> {
	ensure_account(c).await?;
	let me = c.char_id().to_owned();
	let acc = c.account.as_ref();
	let listed = (acc.is_some_and(|a| !j::b(a, "npc")) && !me.starts_with("npc-")) || acc.is_some_and(|a| j::b(a, "settler")) || me.starts_with("npc-siedler-")
		|| j::a(c.w(), "npcs").iter().any(|n| j::b(n, "model") && format!("npc-{}", j::s(n, "npcId")) == me);
	if !listed { return Ok(()); }
	let had = c.space.take_existing(&tmpl("Travel", obj! { "charId" => me.as_str() }), c.txn(), 2_000.0).await?;
	let mut f = had.map_or_else(|| obj! { "charId" => me.as_str() }, |e| fields(&e).clone());
	let n = j::no(&f, kind).unwrap_or(0.0) + 1.0;
	j::set(&mut f, kind, Json::from(n));
	c.space.write(&tmpl("Travel", f), c.txn(), FOREVER).await?;
	Ok(())
}
