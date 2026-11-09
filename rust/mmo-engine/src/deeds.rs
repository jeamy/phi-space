//! Services to the community (`server/engine/deeds.ts`): one Deed per account and kind, for the reputation.
use phi_json::obj;

use crate::context::Ctx;
use crate::j;
use crate::space::{fields, tmpl, Result, Space, FOREVER, NO_WAIT};

/// `creditDeed`: one more of `kind` for the actor's account.
pub async fn credit_deed(c: &Ctx, kind: &str) -> Result<()> {
	let Some(a) = &c.account else { return Ok(()) };
	let account_id = j::at(a, "accountId").clone();
	let held = c.space.take_if_exists(&tmpl("Deed", obj! { "accountId" => account_id.clone(), "kind" => kind }), NO_WAIT, c.txn()).await?;
	let points = held.as_ref().map_or(0.0, |e| j::no(fields(e), "points").unwrap_or(0.0));
	let f = obj! { "accountId" => account_id, "kind" => kind, "charName" => j::at(&c.actor, "name").clone(), "points" => points + 1.0, "lastAt" => crate::source::time_now() };
	c.space.write(&obj! { "type" => "Deed", "fields" => f }, c.txn(), FOREVER).await?;
	Ok(())
}

/// `deedsOf`: an account's deeds by kind (beet, bau, tiere), summed over the spaces.
pub async fn deeds_of(spaces: &[&Space], account_id: &str) -> Result<[f64; 3]> {
	let mut out = [0.0; 3];
	for space in spaces {
		let rows = space.read_all(&tmpl("Deed", obj! { "accountId" => account_id }), None).await.unwrap_or_default();
		for e in rows {
			let d = fields(&e);
			let i = match j::s(d, "kind") { "beet" => 0, "bau" => 1, "tiere" => 2, _ => continue };
			let n = j::number(j::at(d, "points"));
			out[i] += if n.is_nan() || n == 0.0 { 0.0 } else { n };
		}
	}
	Ok(out)
}

/// `deedText`.
pub fn deed_text(d: [f64; 3]) -> String {
	let n = |x: f64| phi_json::number_text(x);
	[(d[0], "× am Gemeinschaftsbeet"), (d[1], "× fremde Bauten ausgebessert"), (d[2], "× fremde Tiere gefüttert")].iter().filter(|(k, _)| *k != 0.0).map(|(k, t)| format!("{}{t}", n(*k))).collect::<Vec<_>>().join(", ")
}

