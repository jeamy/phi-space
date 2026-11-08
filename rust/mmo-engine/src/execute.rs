//! Running one command line (`server/engine/commands.ts` `execute`) and serving a character's oldest intent as the world
//! worker does (`server/world-host.ts` `serve`, the plain path: no batching, no copy of the world; in a sequential walk
//! both are the same to the space).
use std::rc::Rc;

use phi_json::Json;

use crate::context::{msg, Ctx, MsgOpts};
use crate::j;
use crate::js::{self, JsRegex};
use crate::model::actor_token;
use crate::room_growth::{pin_terrain, spatial_world};
use crate::space::{fields, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

thread_local! {
	static WALKING: JsRegex = JsRegex::new(r"^(step|move|arrive)\b", "").expect("the walking pattern");
	static STEP: JsRegex = JsRegex::new(r"^step\s", "").expect("the step pattern");
}

fn llm_enabled() -> bool { std::env::var("SPACES_MMO_LLM").as_deref() == Ok("1") }

/// `say`: talk is never translated.
fn is_talk(line: &str) -> bool { js::re(r"^(say|sag|sage|'|emote|:|channel|kanal)\b", "i").test(line) || line.starts_with('\'') || line.starts_with(':') }

/// `split`: the verb and the rest ("'text" and ":text" are say and emote).
fn split(line: &str) -> (String, String) {
	if let Some(m) = js::caps(&js::re(r#"^(['":])(.*)$"#, "s"), line) {
		let rest = m[2].clone().unwrap_or_default();
		return (if m[1].as_deref() == Some(":") { "emote" } else { "say" }.into(), js::trim(&rest).to_owned());
	}
	let verb = crate::commands::default::words(line).into_iter().next().unwrap_or_default();
	(verb.clone(), js::trim(&line[verb.len()..]).to_owned())
}

/// `named`: whether `line` names `name` as a word of its own (any case).
fn named(line: &str, name: &str) -> bool {
	let escaped = js::re(r"[.*+?^${}()|[\]\\]", "g").replace(name, "\\$&");
	JsRegex::new(&format!(r"(^|[^\p{{L}}\p{{N}}]){escaped}([^\p{{L}}\p{{N}}]|$)"), "iu").is_ok_and(|r| r.test(line))
}

/// `viewFor`: what the translation rules may look at.
async fn view_for(c: &mut Ctx) -> Result<crate::translate::View> {
	let room = c.room().to_owned();
	let listings = if j::a(j::at(c.w(), "market"), "rooms").iter().any(|r| r.as_str() == Some(room.as_str())) {
		let mut l: Vec<Json> = c.space.read_all(&tmpl("Listing", phi_json::obj! { "room" => room.as_str() }), None).await?.iter().map(|e| fields(e).clone()).collect();
		l.sort_by(|a, b| { let d = j::n(a, "at") - j::n(b, "at"); if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap() } else { js::locale_compare(j::s(a, "listingId"), j::s(b, "listingId")) } });
		l.iter().map(|x| crate::fire::key_text(j::at(x, "itemName"))).collect()
	} else { vec![] };
	let me = crate::fire::key_text(j::at(&c.actor, "name"));
	let people = c.space.read_all(&tmpl("Character", phi_json::obj! { "room" => room.as_str() }), None).await?.iter().map(|e| crate::fire::key_text(j::at(fields(e), "name"))).filter(|n| *n != me).collect();
	let exits = crate::context::exits_here(c, None).await?.iter().map(|x| { let f = fields(x); (j::s(f, "name").to_owned(), j::strs(j::a(f, "aliases")).into_iter().map(str::to_owned).collect()) }).collect();
	let carried = crate::context::inventory(c).await?.iter().map(|i| crate::fire::key_text(j::at(fields(i), "name"))).collect();
	Ok(crate::translate::View { exits, listings, carried, people })
}

/// The model reads a line once before it is refused (`Translate`), when model calls are on.
async fn ask_model(c: &Ctx, line: &str, why: Option<&str>) -> Result<()> {
	let a = c.account.clone().unwrap_or(Json::Null);
	let mut t = phi_json::obj! { "reqId" => crate::source::hex(&crate::source::random_bytes(6)), "charId" => c.char_id(), "accountId" => j::at(&a, "accountId").clone(), "guest" => j::at(&a, "guest").clone(), "line" => js::slice16(line, 0, Some(300)), "room" => c.room(), "at" => crate::source::time_now() };
	if let Some(w) = why { crate::j::set(&mut t, "why", js::slice16(w, 0, Some(300))); }
	if let Some(l) = &c.lang { crate::j::set(&mut t, "lang", l.as_str()); }
	c.space.write(&phi_json::obj! { "type" => "Translate", "fields" => t }, c.txn(), 60_000.0).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("„{}“ – einen Moment, ich versuche das zu verstehen …", js::slice16(line, 0, Some(80))), MsgOpts::default()).await
}

/// `execute(c, line)`.
pub async fn execute(c: &mut Ctx, line: &str) -> Result<()> {
	let mut line = js::trim(line).to_owned();
	if line.is_empty() { return Ok(()); }
	if j::truthy(j::at(&c.actor, "aboard")) && WALKING.with(|r| r.test(&line)) { return refuse(crate::commands::passage::aboard_text(c).await?); }
	if STEP.with(|r| r.test(&line)) { return crate::commands::default::step(c, js::trim(js::slice16(&line, 5, None))).await; }
	let (merged, exits) = crate::commands::commands_of(c).await?;
	let said = c.asked.clone().unwrap_or_else(|| line.clone());
	let ruled = if is_talk(&line) || WALKING.with(|r| r.test(&line)) { None } else { let v = view_for(c).await?; crate::translate::translate_rules(&line, &v) };
	if let Some(r) = ruled { line = r; }
	let understood = (said != line && !is_talk(&line)).then(|| format!("„{}“ → {line}", js::slice16(&said, 0, Some(80))));
	let (verb, arg) = split(&line);
	let lower = verb.to_lowercase();
	let Some(cmd) = merged.iter().find(|(k, _)| *k == lower).map(|(_, c)| c.clone()) else {
		let model = llm_enabled() && c.asked.is_none() && c.account.as_ref().is_some_and(|a| !j::b(a, "npc"));
		if model { return ask_model(c, &line, None).await; }
		return refuse(match &c.asked { Some(a) => format!("„{}“ habe ich nicht verstanden. „help“ zeigt die Befehle.", js::slice16(a, 0, Some(80))), None => format!("Unbekannter Befehl „{}“. „help“ zeigt alle Befehle.", js::slice16(&verb, 0, Some(20))) });
	};
	if j::truthy(j::at(&c.actor, "aboard")) && !crate::commands::passage::may_aboard(&cmd.key) { return refuse(crate::commands::passage::aboard_text(c).await?); }
	if let Some(asked) = c.asked.clone() {
		let v = view_for(c).await?;
		if let Some(guessed) = v.people.iter().find(|n| named(&line, n) && !named(&asked, n)) {
			return refuse(format!("„{}“ → {line}: Meinst du {guessed}? Ich handle nicht für jemanden, den du nicht genannt hast; schreib den Namen so, wie er heißt.", js::slice16(&asked, 0, Some(80))));
		}
	}
	let ran: Result<()> = async {
		let me = c.char_id().to_owned();
		if let Some(u) = &understood { msg(c, &me, "info", u, MsgOpts::default()).await?; }
		let npc = c.account.as_ref().is_none_or(|a| j::b(a, "npc"));
		let before = crate::pack::pack_before(&c.space, c.w(), &me, &cmd.key, npc, &c.txn).await?;
		crate::commands::run(c, &cmd, &arg, &merged, &exits).await?;
		if let Some(too_much) = crate::pack::pack_after(&c.space, c.w(), &me, before, &c.txn).await? { return refuse(too_much); }
		Ok(())
	}.await;
	match ran {
		Err(Error::NotUnderstood(why)) if llm_enabled() && c.asked.is_none() && c.account.as_ref().is_some_and(|a| !j::b(a, "npc")) => ask_model(c, &said, Some(&why)).await,
		Err(e) if e.is_command() && understood.is_some() => refuse(format!("{}: {e}", understood.unwrap_or_default())),
		other => other,
	}
}

/// How a world worker serves characters: its space, the world's definition, how long messages and transactions last.
pub struct Worker { pub space: Space, pub w: Rc<Json>, pub msg_lease_ms: f64, pub txn_ms: f64 }

impl Worker {
	/// `begin`: a new transaction holding the character's token and its oldest intent.
	async fn begin(&self, char_id: &str) -> Result<(String, Option<Json>)> {
		let txn = self.space.create_transaction(self.txn_ms).await?;
		let claimed: Result<Option<Json>> = async {
			pin_terrain(&self.space, &txn).await?;
			if self.space.take_if_exists(&actor_token(char_id), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(None); }
			Ok(self.space.take_if_exists(&tmpl("Intent", phi_json::obj! { "charId" => char_id }), NO_WAIT, Some(&txn)).await?.map(|e| fields(&e).clone()))
		}.await;
		match claimed { Ok(i) => Ok((txn, i)), Err(e) => { let _ = self.space.abort(&txn).await; Err(e) } }
	}

	/// `one`: an entry from the snapshot, else a read that waits while another transaction holds it.
	async fn one(&self, t: &Json, wait_ms: f64) -> Result<Option<Json>> {
		match self.space.peek(t, None).await? { Some(e) => Ok(Some(e)), None => self.space.read_if_exists(t, wait_ms, None).await }
	}

	async fn finish(&self, txn: &str, char_id: &str) -> Result<()> {
		self.space.write(&actor_token(char_id), Some(txn), FOREVER).await?;
		self.space.commit(txn).await
	}

	/// `refuse`: in a transaction of its own (again holding the token), the intent consumed and the actor told.
	async fn refuse(&self, actor: &Json, text: &str) {
		let char_id = j::s(actor, "charId").to_owned();
		let Ok((txn, intent)) = self.begin(&char_id).await else { return };
		let told: Result<()> = async {
			if intent.is_none() { return self.space.abort(&txn).await; }
			let c = Ctx { space: self.space.clone(), txn: txn.clone(), world: self.w.clone(), actor: actor.clone(), account: None, load_account: false, msg_lease_ms: self.msg_lease_ms, asked: None, lang: None, step: None, inventory: None };
			msg(&c, &char_id, "error", text, MsgOpts::default()).await?;
			self.finish(&txn, &char_id).await
		}.await;
		if told.is_err() { let _ = self.space.abort(&txn).await; }
	}

	/// `serve`: runs the oldest intent of one character. "ran", "held" (another worker has the character), "refused:
	/// <text>" (told to the actor), "failed: <text>" (left for another try).
	pub async fn serve(&self, char_id: &str) -> Result<String> {
		let (txn, intent) = self.begin(char_id).await?;
		let Some(intent) = intent else { self.space.abort(&txn).await?; return Ok("held".into()) };
		let mut actor: Option<Json> = None;
		let ran: Result<()> = async {
			if let Some(a) = self.one(&tmpl("Character", phi_json::obj! { "charId" => char_id }), 5_000.0).await? {
				let a = fields(&a).clone();
				actor = Some(a.clone());
				let line = j::s(&intent, "line").to_owned();
				let stepping = STEP.with(|r| r.test(&line));
				let account = if stepping { None } else { self.one(&tmpl("Account", phi_json::obj! { "accountId" => j::at(&a, "accountId").clone() }), 2_000.0).await?.map(|e| fields(&e).clone()) };
				let world = Rc::new(spatial_world(&self.space, &self.w).await?);
				let mut c = Ctx { space: self.space.clone(), txn: txn.clone(), world, actor: a, load_account: account.is_none(), account, msg_lease_ms: self.msg_lease_ms, asked: j::so(&intent, "asked").map(str::to_owned), lang: j::so(&intent, "lang").map(str::to_owned), step: j::opt(&intent, "step").cloned(), inventory: None };
				execute(&mut c, &line).await?;
			}
			self.finish(&txn, char_id).await
		}.await;
		let Err(e) = ran else { return Ok("ran".into()) };
		let _ = self.space.abort(&txn).await;
		if e.is_command() {
			let text = e.to_string();
			if let Some(a) = &actor { self.refuse(a, &text).await; }
			return Ok(format!("refused: {text}"));
		}
		Ok(format!("failed: {e}"))
	}
}
