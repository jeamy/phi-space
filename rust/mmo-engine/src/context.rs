//! What a command runs with (`server/engine/context.ts`): the space and its transaction, the world, the actor, its
//! account; messages to rooms and players; looking up things by name.
use phi_json::{obj, Json, Object};

use crate::j;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{Result, Space};

/// `CommandCtx`.
pub struct Ctx {
	pub space: Space,
	pub txn: String,
	pub world: std::rc::Rc<Json>,
	pub actor: Json,
	pub account: Option<Json>,
	/// The account is read when a lock asks (`loadAccount`; a step).
	pub load_account: bool,
	pub msg_lease_ms: f64,
	pub asked: Option<String>,
	pub lang: Option<String>,
	pub step: Option<Json>,
	/// The actor's inventory for this command (read once, outside the transaction).
	pub inventory: Option<Vec<Json>>,
}

impl Ctx {
	pub fn txn(&self) -> Option<&str> { Some(self.txn.as_str()) }
	pub fn char_id(&self) -> &str { j::s(&self.actor, "charId") }
	pub fn room(&self) -> &str { j::s(&self.actor, "room") }
	pub fn w(&self) -> &Json { &self.world }
}

/// Who writes a message: the space, the transaction (None: at once), the actor, how long it stays, its language.
pub struct Sender<'a> { pub space: &'a Space, pub txn: Option<&'a str>, pub actor: &'a Json, pub msg_lease_ms: f64, pub lang: Option<&'a str> }

impl Ctx {
	pub fn sender(&self) -> Sender<'_> { Sender { space: &self.space, txn: Some(&self.txn), actor: &self.actor, msg_lease_ms: self.msg_lease_ms, lang: self.lang.as_deref() } }
}

/// Options of a message: `$you()`/`$conj()` rendered per reader, another room, the parts of `help`.
#[derive(Default)]
pub struct MsgOpts { pub templ: bool, pub room: Option<String>, pub help: Option<Json> }

/// `msgOptions`: whether a message is a transient write (only what nobody reads later is).
pub async fn msg_transient(space: &Space, to: &str, kind: &str) -> bool {
	if std::env::var("SPACES_MMO_MSG_TRANSIENT").as_deref() == Ok("0") || kind == "say" || to.starts_with('#') || to.starts_with("npc-") { return false; }
	space.supports("write.transient").await
}

/// How long a message to a player waits for it (real time).
pub const NOTICE_MS: f64 = 14.0 * 24.0 * 3_600_000.0;
/// Whether a message to `to` goes to one player.
pub fn to_one_player(to: &str) -> bool { to != "*" && !to.starts_with('#') && !to.starts_with("npc-") }

/// `toPlayer`: a message to one player as a Notice, kept 14 days.
pub async fn to_player(space: &Space, m: &Json, txn: Option<&str>) -> Result<()> {
	let mut n = j::object(m);
	n.insert("noticeId", Json::from(format!("n-{}", hex(&random_bytes(6)))));
	n.insert("charId", j::at(m, "to").clone());
	space.write(&obj! { "type" => "Notice", "fields" => Json::Object(n) }, txn, NOTICE_MS).await?;
	Ok(())
}

/// `msg`: a message from the actor in its room (or `o.room`).
pub async fn msg_from(c: &Sender<'_>, to: &str, kind: &str, text: &str, o: MsgOpts) -> Result<()> {
	let mut m = Object::new();
	m.insert("room", Json::from(o.room.unwrap_or_else(|| j::s(c.actor, "room").to_owned())));
	m.insert("to", Json::from(to));
	m.insert("kind", Json::from(kind));
	m.insert("text", Json::from(text));
	m.insert("from", j::at(c.actor, "name").clone());
	m.insert("fromId", j::at(c.actor, "charId").clone());
	m.insert("at", Json::from(time_now()));
	if let Some(l) = c.lang { m.insert("lang", Json::from(l)); }
	if o.templ { m.insert("actor", j::at(c.actor, "charId").clone()); }
	if let Some(h) = o.help { m.insert("help", h); }
	let m = Json::Object(m);
	if to != j::s(c.actor, "charId") && to_one_player(to) { return to_player(c.space, &m, c.txn).await; }
	let transient = msg_transient(c.space, to, kind).await;
	c.space.write_with(&obj! { "type" => "Msg", "fields" => m }, c.txn, c.msg_lease_ms, transient).await?;
	Ok(())
}

/// `msg(c, to, kind, text, o)` of a command.
pub async fn msg(c: &Ctx, to: &str, kind: &str, text: &str, o: MsgOpts) -> Result<()> { msg_from(&c.sender(), to, kind, text, o).await }
