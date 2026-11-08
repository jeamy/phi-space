//! The world's clock in the space (`server/engine/clock.ts`).
use phi_json::{obj, Json};

use crate::j;
use crate::settings::setting;
use crate::source::{random, time_now};
use crate::space::{fields, Error, Result, Space, FOREVER, NO_WAIT};
use crate::worldtime::{decay_at, world_at, MAX_RATE, MIN_RATE, WORLD_DAY_MS};

/// `readClock`.
pub async fn read_clock(space: &Space, txn: Option<&str>) -> Result<Json> {
	match space.peek(&obj! { "type" => "WorldClock" }, txn).await? { Some(e) => Ok(fields(&e).clone()), None => Err(Error::Other("the world has no clock".into())) }
}
/// `worldNowOf`.
pub async fn world_now_of(space: &Space, txn: Option<&str>) -> Result<f64> { Ok(world_at(&read_clock(space, txn).await?, time_now())) }
/// `decayNowOf`.
pub async fn decay_now_of(space: &Space, txn: Option<&str>) -> Result<f64> { Ok(decay_at(&read_clock(space, txn).await?, time_now())) }
/// `patience`: world ms per ms of the second clock.
pub fn patience(clock: &Json) -> f64 { let rate = j::n(clock, "rate"); rate / j::no(clock, "decayRate").unwrap_or(rate) }
/// `patienceOf`.
pub async fn patience_of(space: &Space, txn: Option<&str>) -> Result<f64> { Ok(patience(&read_clock(space, txn).await?)) }

/// `materialize`.
pub fn materialize(clock: &Json, real_now: f64) -> Json {
	let mut o = j::object(clock);
	o.insert("worldAnchorMs", Json::from(world_at(clock, real_now)));
	o.insert("decayAnchorMs", Json::from(decay_at(clock, real_now)));
	o.insert("decayRate", Json::from(j::no(clock, "decayRate").unwrap_or(j::n(clock, "rate"))));
	o.insert("realAnchorMs", Json::from(real_now));
	Json::Object(o)
}

fn valid(r: f64) -> bool { (MIN_RATE..=MAX_RATE).contains(&r) }

/// `syncRates`: the admin's two rates reach this region's clock (-1 leaves it).
pub async fn sync_rates(space: &Space) -> Result<()> {
	let (life, decay, now) = (setting(space, "clock.life").await?, setting(space, "clock.decay").await?, read_clock(space, None).await?);
	let change_life = valid(life) && life != j::n(&now, "rate");
	let change_decay = valid(decay) && decay != j::no(&now, "decayRate").unwrap_or(j::n(&now, "rate"));
	if !change_life && !change_decay { return Ok(()); }
	let real_now = time_now();
	let txn = space.create_transaction(10_000.0).await?;
	let r: Result<()> = async {
		let Some(t) = space.take_if_exists(&obj! { "type" => "WorldClock" }, NO_WAIT, Some(&txn)).await? else { space.abort(&txn).await?; return Ok(()) };
		let mut next = fields(&t).clone();
		if change_life { next = materialize(&next, real_now); j::set(&mut next, "rate", life); }
		if change_decay { next = materialize(&next, real_now); j::set(&mut next, "decayRate", decay); }
		space.write(&obj! { "type" => "WorldClock", "fields" => next }, Some(&txn), FOREVER).await?;
		space.commit(&txn).await
	}.await;
	if r.is_err() { let _ = space.abort(&txn).await; }
	r
}

/// `byPeoplesPace`.
pub async fn by_peoples_pace(space: &Space) -> Result<bool> { Ok(random() * patience_of(space, None).await? < 1.0) }

/// `seasonIndex`.
pub fn season_index(world_ms: f64, year_days: f64) -> Option<f64> {
	if year_days <= 0.0 { return None; }
	let in_year = (world_ms / WORLD_DAY_MS) % year_days;
	Some(3f64.min((in_year * 4.0 / year_days).floor()))
}
/// `nextSpring`.
pub fn next_spring(world_ms: f64, year_days: f64) -> f64 { ((world_ms / WORLD_DAY_MS / year_days).floor() + 1.0) * year_days * WORLD_DAY_MS }

/// `frozenUntil`: the next spring in winter, else None.
pub async fn frozen_until(space: &Space, now: f64) -> Result<Option<f64>> {
	let year_days = setting(space, "year.days").await?;
	Ok((season_index(now, year_days) == Some(3.0)).then(|| next_spring(now, year_days)))
}
/// `seasonNow`.
pub async fn season_now(space: &Space, now: f64) -> Result<Option<f64>> { Ok(season_index(now, setting(space, "year.days").await?)) }

const SEASON_TEXT: [&str; 4] = ["Der Frühling kommt: Was im Winter stand, wächst weiter.", "Es wird Sommer.", "Der Herbst beginnt: Zeit für das Erntefest.", "Der Winter kommt: Draußen wächst nichts mehr, bis es Frühling wird."];

/// `seasonTick`: a new season is told in every room of the region, once.
pub async fn season_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<bool> {
	let Some(season) = season_now(space, world_now_of(space, None).await?).await? else { return Ok(false) };
	let txn = space.create_transaction(10_000.0).await?;
	let r: Result<bool> = async {
		let was = space.take_if_exists(&obj! { "type" => "Season" }, NO_WAIT, Some(&txn)).await?;
		if was.as_ref().is_some_and(|e| j::number(j::at(fields(e), "season")) == season) { space.abort(&txn).await?; return Ok(false); }
		space.write(&obj! { "type" => "Season", "fields" => obj! { "season" => season } }, Some(&txn), FOREVER).await?;
		if was.is_some() {
			for r in j::a(w, "rooms") {
				space.write(&obj! { "type" => "Msg", "fields" => obj! { "room" => j::at(r, "roomId").clone(), "to" => "*", "kind" => "world", "text" => SEASON_TEXT[season as usize], "from" => "", "at" => time_now() } }, Some(&txn), lease_ms).await?;
			}
		}
		space.commit(&txn).await?;
		Ok(was.is_some())
	}.await;
	if r.is_err() { let _ = space.abort(&txn).await; }
	r
}
