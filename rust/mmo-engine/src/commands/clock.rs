//! The world's clock as commands (`server/engine/commands/clock.ts`): `time` tells everyone the world time; `clock` is the
//! operator's (Admin): status, pause, resume and the two rates. A change takes the clock entry and writes it again with
//! both anchors moved to the moment of the change, in the command's transaction.
use phi_json::{obj, Json};

use crate::clock::{materialize, season_now};
use crate::context::{msg, Ctx, MsgOpts};
use crate::j;
use crate::js;
use crate::source::time_now;
use crate::space::{fields, refuse, tmpl, Result, FOREVER, NO_WAIT};
use crate::worldtime::{calendar, format_world_time, world_at, MAX_RATE, MIN_RATE, SEASONS};

async fn read(c: &Ctx) -> Result<Json> {
	match c.space.peek(&tmpl("WorldClock", obj! { "worldId" => j::at(c.w(), "id").clone() }), c.txn()).await? { Some(e) => Ok(e), None => refuse("Diese Welt hat noch keine Uhr.") }
}
fn rate_text(r: f64) -> String { phi_json::number_text(r) }

fn describe(clock: &Json, now: f64) -> String {
	let at = world_at(clock, now);
	let (day, ..) = calendar(at);
	let rate = j::n(clock, "rate");
	let speed = if rate == 1.0 { "in Echtzeit".to_owned() } else if rate > 1.0 { format!("{}-fach beschleunigt", rate_text(rate)) } else { format!("{}-fach verlangsamt", rate_text(rate)) };
	let decay = j::no(clock, "decayRate").unwrap_or(rate);
	format!("{} Uhr (Welttag {}); {}, der Verfall {}.", format_world_time(at), phi_json::number_text(day + 1.0), if j::b(clock, "paused") { "die Uhr ist angehalten".to_owned() } else { format!("die Uhr läuft {speed}") }, if decay == 1.0 { "in Echtzeit".to_owned() } else { format!("{}-fach", rate_text(decay)) })
}

/// `time`.
pub async fn time(c: &mut Ctx, _arg: &str) -> Result<()> {
	let clock = fields(&read(c).await?).clone();
	let season = season_now(&c.space, world_at(&clock, time_now())).await?;
	let me = c.char_id().to_owned();
	let text = format!("Es ist {} Uhr{}{}.", format_world_time(world_at(&clock, time_now())), season.map_or_else(String::new, |s| format!(", {}", SEASONS[s as usize])), if j::b(&clock, "paused") { " (die Zeit steht still)" } else { "" });
	msg(c, &me, "info", &text, MsgOpts::default()).await
}

fn with(clock: &Json, real_now: f64, k: &str, v: Json) -> Json { let mut m = materialize(clock, real_now); if let Json::Object(o) = &mut m { o.insert(k, v); } m }
fn rate_of(value: Option<&str>) -> Option<f64> {
	let r = value.map_or(f64::NAN, |v| js::to_number(&v.replacen(',', ".", 1)));
	(r.is_finite() && (MIN_RATE..=MAX_RATE).contains(&r)).then_some(r)
}

/// `clock`.
pub async fn clock(c: &mut Ctx, arg: &str) -> Result<()> {
	let e = read(c).await?;
	let now = fields(&e).clone();
	let words: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let verb = words.first().cloned().unwrap_or_default();
	let value = words.get(1).map(String::as_str);
	let real_now = time_now();
	let next = if js::re(r"^(pause|halt|stop|anhalten)$", "i").test(&verb) {
		if j::b(&now, "paused") { return refuse("Die Uhr steht schon still."); }
		Some(with(&now, real_now, "paused", Json::Bool(true)))
	} else if js::re(r"^(weiter|resume|start|fortsetzen)$", "i").test(&verb) {
		if !j::b(&now, "paused") { return refuse("Die Uhr läuft schon."); }
		Some(with(&now, real_now, "paused", Json::Bool(false)))
	} else if js::re(r"^(rate|tempo|speed)$", "i").test(&verb) {
		let Some(r) = rate_of(value) else { return refuse(format!("So geht es: clock rate <n> mit {} bis {} (1 = Echtzeit, 60 = eine Weltminute je Sekunde).", rate_text(MIN_RATE), rate_text(MAX_RATE))) };
		Some(with(&now, real_now, "rate", Json::from(r)))
	} else if js::re(r"^(verfall|decay)$", "i").test(&verb) {
		let Some(r) = rate_of(value) else { return refuse(format!("So geht es: clock verfall <n> mit {} bis {} (1 = echte Tage).", rate_text(MIN_RATE), rate_text(MAX_RATE))) };
		Some(with(&now, real_now, "decayRate", Json::from(r)))
	} else if !verb.is_empty() && !js::re(r"^(status|stand)$", "i").test(&verb) {
		return refuse("So geht es: clock | clock pause | clock weiter | clock rate <n> | clock verfall <n>");
	} else { None };
	if let Some(n) = &next {
		if c.space.take(&obj! { "type" => j::at(&e, "type").clone(), "id" => j::at(&e, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Die Uhr wird gerade geändert; bitte gleich noch einmal."); }
		c.space.write(&tmpl("WorldClock", n.clone()), c.txn(), FOREVER).await?;
	}
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &describe(next.as_ref().unwrap_or(&now), real_now), MsgOpts::default()).await
}
