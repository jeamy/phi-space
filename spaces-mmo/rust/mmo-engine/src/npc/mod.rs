//! The npc process (`server/npc-host.ts`, `server/npc/*.ts`; docs/rust-portierung.en.md R8.4): the world's NPCs. An NPC is
//! a character like any other: it is online while this process keeps its Session entry, and it acts only by writing
//! intents, which a world worker runs like a player's commands. Scripts (`scripts.rs`, `economy.rs`, `settlers.rs`) look
//! at the world through reads and decide what to type next; model roles ask the model process through Think and Thought
//! entries (`minds.rs`). Each role is claimed with a lease, so several npc processes (TypeScript or this one) share the
//! roles and never play one twice.
//!
//! Unlike the engine it is not held against the oracle step by step: it reads the real clock and chance, as the
//! TypeScript process does; the integration tests of spaces-mmo hold it (`SPACES_MMO_NPC_CMD`).
pub mod economy;
pub mod minds;
pub mod requests;
pub mod scripts;
pub mod settlers;

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use phi_json::{obj, Json};
use phi_spaces_client::Opts;
use tokio::sync::watch;

use crate::j;
use crate::js;
use crate::model::actor_token;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, tmpl, Result, Space};
use crate::worldtime::{calendar, decay_at, world_at, WORLD_HOUR_MS};

/// The world clock as a process reads it (`ClockCache`): fetched at most every 15 s, the world time calculated from it
/// in between.
pub struct ClockCache { space: Space, world_id: Option<String>, clock: RefCell<Option<Json>>, at: Cell<f64> }

impl ClockCache {
	pub fn new(space: Space, world_id: Option<String>) -> Self { Self { space, world_id, clock: RefCell::new(None), at: Cell::new(0.0) } }
	/// The clock as last read (None while the world has none).
	pub async fn clock(&self) -> Option<Json> {
		let real = time_now();
		if self.clock.borrow().is_none() || real - self.at.get() > 15_000.0 {
			let t = match &self.world_id { Some(id) => tmpl("WorldClock", obj! { "worldId" => id.as_str() }), None => obj! { "type" => "WorldClock" } };
			if let Ok(Some(e)) = self.space.peek(&t, None).await { *self.clock.borrow_mut() = Some(fields(&e).clone()); self.at.set(real); }
		}
		self.clock.borrow().clone()
	}
	/// World milliseconds per millisecond of the second clock, as last read (1 before the first read).
	pub fn patience(&self) -> f64 { self.clock.borrow().as_ref().map_or(1.0, crate::clock::patience) }
	/// Milliseconds of the second clock per real millisecond, as last read (1 before the first read).
	pub fn decay_rate(&self) -> f64 { self.clock.borrow().as_ref().map_or(1.0, |c| j::no(c, "decayRate").or_else(|| j::no(c, "rate")).unwrap_or(1.0)) }
	/// The world time now, or None while the world has no clock.
	pub async fn now(&self) -> Option<f64> { self.clock().await.map(|c| world_at(&c, time_now())) }
	/// The time of the second clock now, or None.
	pub async fn decay_now(&self) -> Option<f64> { self.clock().await.map(|c| decay_at(&c, time_now())) }
}

/// `presentAt`: a plan in world hours, present from `presentFromHour` (inclusive) to `presentUntilHour` (exclusive).
pub fn present_at(plan: &Json, world_ms: f64) -> bool {
	let h = calendar(world_ms).3 / WORLD_HOUR_MS;
	let (from, until) = (j::n(plan, "presentFromHour"), j::n(plan, "presentUntilHour"));
	if from == until { return true; }
	if from < until { h >= from && h < until } else { h >= from || h < until }
}

/// `STOCK_STEP` (trade.ts).
const STOCK_STEP: f64 = 0.12;
/// `stockPrices` (trade.ts): a trader's prices by its stock, less when it holds much, more when it runs short.
pub fn stock_prices(base: (f64, f64), stock: f64, keep: f64) -> (f64, f64) {
	let f = 0.5f64.max(2f64.min(1.0 + STOCK_STEP * (keep - stock)));
	let sell = if base.1 > 0.0 { 1f64.max(js::round(base.1 * f)) } else { 0.0 };
	let mut buy = if base.0 > 0.0 { js::round(base.0 * f) } else { 0.0 };
	if sell > 0.0 && buy >= sell { buy = sell - 1.0; }
	(0f64.max(buy), sell)
}
/// `lotAsk` (trade.ts): what a trader asks for `count`; for animals each one more a coin less.
pub fn lot_ask(w: &Json, proto: &str, price: Option<(f64, f64)>, count: f64) -> f64 {
	let (buy, sell) = price.unwrap_or((0.0, 0.0));
	if sell <= 0.0 || count <= 0.0 { return 0.0; }
	if j::by(j::a(w, "prototypes"), "key", proto).map(|p| j::s(p, "typeclass")) != Some("Livestock") { return sell * count; }
	let floor = 1f64.max(sell.min(buy));
	let mut sum = 0.0;
	let mut i = 0.0;
	while i < count { sum += floor.max(sell - i); i += 1.0; }
	sum
}

/// Where a figure last typed `zug` or `einschiffen` and how often.
pub type Boarding = Option<(String, u32)>;

/// The session of one NPC: online or not, and the lease of its Session entry.
pub struct Session { char_id: String, regional: bool, online: Cell<bool>, lease: RefCell<Option<String>> }

pub(crate) const SESSION_LEASE_MS: f64 = 60_000.0;

impl Session {
	/// `keep`: the Session entry while the NPC is online (and, with regions, here); errors wait for the next beat.
	async fn keep(&self, space: &Space) {
		let here = !self.regional || matches!(space.peek(&tmpl("Character", obj! { "charId" => self.char_id.as_str() }), None).await, Ok(Some(_)));
		let lease = self.lease.borrow().clone();
		if !self.online.get() || !here {
			if let Some(l) = lease { let _ = space.remote().cancel(&l, &Opts::default()).await; *self.lease.borrow_mut() = None; }
			return;
		}
		if let Some(l) = lease {
			if space.remote().renew(&l, SESSION_LEASE_MS, &Opts::default()).await.is_ok() { return; }
			*self.lease.borrow_mut() = None;
		}
		let f = obj! { "sessionId" => format!("npc-{}", hex(&random_bytes(4))), "charId" => self.char_id.as_str(), "accountId" => self.char_id.as_str() };
		if let Ok(e) = space.write(&tmpl("Session", f), None, SESSION_LEASE_MS).await { *self.lease.borrow_mut() = e.get("id").and_then(Json::as_str).map(str::to_owned); }
	}
	async fn cancel(&self, space: &Space) {
		let lease = self.lease.borrow_mut().take();
		if let Some(l) = lease { let _ = space.remote().cancel(&l, &Opts::default()).await; }
	}
}

/// An NPC as its script sees it (`Npc` of scripts.ts).
pub struct Npc {
	pub def: RefCell<Json>,
	pub world: RefCell<Rc<Json>>,
	pub char_id: String,
	pub space: Space,
	pub halt: watch::Receiver<bool>,
	pub session: Rc<Session>,
	/// `clockOf(space)`: the clock without a world id.
	pub clock: Rc<ClockCache>,
	pub boarding: RefCell<Boarding>,
}

impl Npc {
	pub fn def(&self) -> Json { self.def.borrow().clone() }
	pub fn w(&self) -> Rc<Json> { self.world.borrow().clone() }
	pub fn halted(&self) -> bool { *self.halt.borrow() }
	/// Sleeps `ms` real milliseconds, or until the process stops.
	pub async fn sleep(&self, ms: f64) {
		let mut h = self.halt.clone();
		tokio::select! { _ = tokio::time::sleep(Duration::from_millis(ms.max(0.0) as u64)) => {}, _ = h.wait_for(|x| *x) => {} }
	}
	pub fn is_online(&self) -> bool { self.session.online.get() }
	/// Shows or hides the NPC (a wanderer comes and goes); showing it steps it onto a free cell.
	pub async fn set_online(&self, on: bool) -> Result<()> {
		self.session.online.set(on);
		self.session.keep(&self.space).await;
		if on { self.act("arrive").await?; }
		Ok(())
	}
	/// The time of the second clock now (real time while the world has no clock): what a role's own timers count in.
	pub async fn now(&self) -> f64 { self.clock.decay_now().await.unwrap_or_else(time_now) }
	/// Real milliseconds for a rhythm of `world_ms` (at least `min_ms`).
	pub fn pace(&self, world_ms: f64, min_ms: f64) -> f64 { min_ms.max(js::round(world_ms / self.clock.decay_rate())) }
	/// Types a command (an intent) and waits until a world worker has run it: until the intent is taken, then until its
	/// transaction is over (the token), and once more, for a refused command that is put back and consumed again.
	pub async fn act(&self, line: &str) -> Result<()> {
		let intent = obj! { "intentId" => hex(&random_bytes(8)), "charId" => self.char_id.as_str(), "line" => line, "at" => time_now() };
		self.space.write(&tmpl("Intent", intent), None, 30_000.0).await?;
		let mine = tmpl("Intent", obj! { "charId" => self.char_id.as_str() });
		let token = actor_token(&self.char_id);
		let give_up = time_now() + 5_000.0;
		let mut i = 0;
		while time_now() < give_up && !self.halted() {
			if self.space.count(&mine, None).await? == 0.0 {
				let _ = self.space.read_if_exists(&token, 5_000.0, None).await;
				if self.space.count(&mine, None).await? > 0.0 { i += 1; continue; }
				let _ = self.space.read_if_exists(&token, 5_000.0, None).await;
				return Ok(());
			}
			self.sleep(250f64.min(50.0 * 2f64.powi(i.min(3)))).await;
			i += 1;
		}
		Ok(())
	}
}

/// `pick`: one of `xs` at random (None when it is empty).
pub fn pick<T: Clone>(xs: &[T]) -> Option<T> { xs.get(crate::source::random_int(0.0, (xs.len().max(1)) as f64) as usize).cloned() }

pub mod host;

#[cfg(test)]
mod tests {
	use super::{lot_ask, stock_prices};

	/// The assertions of `tests/phase4.test.ts` on `stockPrices` and `lotAsk`.
	#[test]
	fn prices() {
		assert_eq!(stock_prices((4.0, 8.0), 4.0, 4.0), (4.0, 8.0));
		assert_eq!(stock_prices((4.0, 8.0), 0.0, 4.0), (6.0, 12.0));
		assert_eq!(stock_prices((4.0, 8.0), 8.0, 4.0), (2.0, 4.0));
		assert_eq!(stock_prices((4.0, 8.0), 40.0, 4.0), (2.0, 4.0));
		assert_eq!(stock_prices((4.0, 8.0), 0.0, 40.0), (8.0, 16.0));
		assert_eq!(stock_prices((1.0, 2.0), 20.0, 2.0), (0.0, 1.0));
		assert_eq!(stock_prices((6.0, 0.0), 10.0, 2.0), (3.0, 0.0));
		for stock in 0..30 {
			for base in [(1.0, 2.0), (2.0, 3.0), (4.0, 8.0), (6.0, 10.0), (12.0, 24.0)] { let (b, s) = stock_prices(base, stock as f64, 4.0); assert!(b < s, "{base:?} at {stock}"); }
		}
		let w = phi_json::parse(r#"{"prototypes":[{"key":"ziege","typeclass":"Livestock"},{"key":"huhn","typeclass":"Livestock"},{"key":"honig","typeclass":"Item"}]}"#).unwrap();
		let goat: Vec<f64> = (1..=6).map(|n| lot_ask(&w, "ziege", Some((4.0, 8.0)), n as f64)).collect();
		assert_eq!(goat, vec![8.0, 15.0, 21.0, 26.0, 30.0, 34.0]);
		assert_eq!(lot_ask(&w, "huhn", Some((2.0, 5.0)), 5.0), 16.0);
		assert_eq!(lot_ask(&w, "honig", Some((2.0, 4.0)), 3.0), 12.0);
		assert_eq!(lot_ask(&w, "ziege", Some((0.0, 3.0)), 5.0), 8.0);
		assert_eq!(lot_ask(&w, "ziege", None, 2.0), 0.0);
	}
}
