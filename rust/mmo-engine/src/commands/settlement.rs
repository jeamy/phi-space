//! Settlements (`server/engine/commands/settlement.ts`), so far what other commands read of them.
use phi_json::{obj, Json};

use crate::context::Ctx;
use crate::j;
use crate::space::{fields, refuse, tmpl, Result, Space};

/// `settlementIn`.
pub async fn settlement_in(space: &Space, room: &str, txn: Option<&str>) -> Result<Option<Json>> {
	Ok(space.peek(&tmpl("Settlement", obj! { "room" => room }), txn).await?.map(|e| fields(&e).clone()))
}

/// `hutsIn`: the huts of a room (the settlement's plan).
pub async fn huts_in(space: &Space, w: &Json, room: &str, txn: Option<&str>) -> Result<Vec<Json>> {
	let plan = j::s(j::at(w, "settlement"), "plan");
	Ok(space.read_all(&tmpl("Building", obj! { "room" => room, "plan" => plan }), txn).await?.iter().map(|e| fields(e).clone()).collect())
}

/// `enoughHuts`.
pub fn enough_huts(w: &Json, huts: &[Json]) -> bool {
	let Some(s) = j::opt(w, "settlement") else { return false };
	let owners: std::collections::HashSet<String> = huts.iter().map(|h| crate::fire::key_text(j::at(h, "accountId"))).collect();
	huts.len() as f64 >= j::n(s, "huts") && owners.len() as f64 >= j::n(s, "owners")
}

const ORDER: [&str; 3] = ["fremder", "helfer", "siedler"];
fn rank_name(r: &str) -> &'static str { match r { "helfer" => "Helfer", "siedler" => "Siedler", _ => "Fremder" } }

/// `rankOf`: a hut here makes a settler, a guest is a helper at most.
pub fn rank_of(s: &Json, huts: &[Json], account: Option<&Json>) -> String {
	let Some(a) = account else { return "fremder".into() };
	let id = j::at(a, "accountId");
	let r = if huts.iter().any(|h| j::at(h, "accountId") == id) { "siedler".to_owned() } else { j::a(s, "members").iter().find(|m| j::at(m, "accountId") == id).and_then(|m| j::so(m, "rank")).unwrap_or("fremder").to_owned() };
	if j::b(a, "guest") && r == "siedler" { "helfer".into() } else { r }
}

/// `needRank`: in a closed settlement, refuses unless the actor has at least `need`.
pub async fn need_rank(c: &Ctx, need: &str, what: &str) -> Result<()> {
	if j::opt(c.w(), "settlement").is_none() { return Ok(()); }
	let Some(s) = settlement_in(&c.space, c.room(), c.txn()).await? else { return Ok(()) };
	if !j::b(&s, "closed") { return Ok(()); }
	let have = rank_of(&s, &huts_in(&c.space, c.w(), j::s(&s, "room"), c.txn()).await?, c.account.as_ref());
	let idx = |r: &str| ORDER.iter().position(|x| *x == r).map_or(-1, |i| i as i32);
	if idx(&have) < idx(need) {
		return refuse(format!("{} ist geschlossen: {what} dürfen hier nur {}. Du bist {}; ein Siedler kann dich aufnehmen.", crate::fire::key_text(j::at(&s, "name")), if need == "siedler" { "Siedler" } else { "Helfer und Siedler" }, rank_name(&have)));
	}
	Ok(())
}
