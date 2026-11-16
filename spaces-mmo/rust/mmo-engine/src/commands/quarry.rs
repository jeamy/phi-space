//! The quarry and the clay pit (`server/engine/commands/quarry.ts`): beside one, anyone's, a pickaxe breaks stone and a
//! spade cuts clay; at a salt garden one rakes salt, without a tool. It is work: the tool wears, and the figure rests afterwards like after `arbeite`.
use phi_json::{obj, Json};

use super::build::{dist_to, plan_of, rested, tire, Rect};
use super::settlement::need_rank;
use super::trade::{consume, move_item};
use crate::context::{inventory, msg, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::space::{fields, refuse, tmpl, Result};

async fn dig(c: &mut Ctx, q: &Json, what: &str, done: &str, tired: &str) -> Result<()> {
	let plan_key = j::s(q, "plan");
	let at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let near = c.space.read_all(&tmpl("Building", obj! { "room" => c.room(), "plan" => plan_key }), None).await?.iter().any(|e| dist_to(at, Rect::of(fields(e))) <= 1.0);
	if !near { return refuse(format!("{what} direkt neben {}.", plan_of(c.w(), plan_key).and_then(|p| j::so(p, "dative")).unwrap_or("einer Grube"))); }
	need_rank(c, "helfer", tired).await?;
	let (now, rest) = rested(c).await?;
	// the salt garden needs no tool: the sun does the work
	let needs_tool = j::b(q, "tool");
	let tool = if needs_tool { inventory(c).await?.into_iter().find(|i| j::at(fields(i), "proto") == j::at(q, "tool")).map(|t| fields(&t).clone()) } else { None };
	if needs_tool && tool.is_none() { return refuse(format!("Dafür brauchst du ein Werkzeug: {}.", key_text(j::at(q, "tool")))); }
	let Some(p) = resolve_prototype(&c.space, j::s(q, "makes")).await? else { return refuse("Der Steinbruch ist kaputt.") };
	let wear = tool.as_ref().and_then(|t| t.get("wear")).map(j::number);
	let left = wear.map_or(1.0, |w| w - 1.0);
	let me = c.char_id().to_owned();
	if let Some(tool) = &tool {
		if left <= 0.0 { consume(c, tool, &me).await?; }
		else if wear.is_some() { move_item(c, tool, &me, &me, &[("wear", Json::from(left))]).await?; }
	}
	for _ in 0..j::n(q, "count").max(0.0) as usize { spawn(&c.space, c.txn(), c.w(), &p, At { location: me.clone(), x: -1.0, y: -1.0, ..Default::default() }, &Json::Null).await?; }
	tire(c, now, rest.as_ref()).await?;
	let text = done.replacen('%', &format!("{} {}", key_text(j::at(q, "count")), key_text(j::at(&p, "name"))), 1);
	msg(c, "*", "info", &format!("$you() {text}{}", if let Some(tool) = tool.as_ref().filter(|_| left <= 0.0) { format!(" Die {} zerbricht dabei.", key_text(j::at(tool, "name"))) } else { String::new() }), MsgOpts { templ: true, ..Default::default() }).await
}

/// `breche`, `steche` and `harke`.
pub async fn run(c: &mut Ctx, key: &str, _arg: &str) -> Result<()> {
	let w = c.world.clone();
	match key {
		"breche" => { let Some(q) = j::opt(&w, "quarry") else { return refuse("In dieser Welt gibt es keine Steinbrüche.") }; dig(c, q, "Stein bricht man", "$conj(brichst|bricht) % aus dem Fels.", "Stein brechen").await }
		"harke" => { let Some(q) = j::opt(&w, "salt") else { return refuse("In dieser Welt gibt es keine Salzgärten.") }; dig(c, q, "Salz harkt man", "$conj(harkst|harkt) % aus dem Salzgarten.", "Salz harken").await }
		_ => { let Some(q) = j::opt(&w, "clay") else { return refuse("In dieser Welt gibt es keine Lehmgruben.") }; dig(c, q, "Lehm sticht man", "$conj(stichst|sticht) % aus der Grube.", "Lehm stechen").await }
	}
}
