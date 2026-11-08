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
use crate::space::{fields, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

thread_local! {
	static WALKING: JsRegex = JsRegex::new(r"^(step|move|arrive)\b", "").expect("the walking pattern");
	static STEP: JsRegex = JsRegex::new(r"^step\s", "").expect("the step pattern");
}

/// `execute(c, line)`.
pub async fn execute(c: &mut Ctx, line: &str) -> Result<()> {
	let line = js::trim(line);
	if line.is_empty() { return Ok(()); }
	if j::b(&c.actor, "aboard") && WALKING.with(|r| r.test(line)) { return Err(Error::Other("unported: aboard".into())); }
	if STEP.with(|r| r.test(line)) { return crate::commands::default::step(c, js::trim(js::slice16(line, 5, None))).await; }
	Err(Error::Other(format!("unported: {}", js::slice16(line, 0, Some(40)))))
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
