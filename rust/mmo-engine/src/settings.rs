//! The numbers an admin may change (`server/settings.ts`): saved as Setting entries, else the environment, else the
//! default; read at most every `SPACES_MMO_SETTINGS_MS` (default 5 s, real time) per space.
use std::cell::RefCell;
use std::collections::HashMap;

use phi_json::{obj, Json};

use crate::j;
use crate::space::{fields, Result, Space};

/// key, environment variable, default.
pub const SETTINGS: &[(&str, &str, f64)] = &[
	("llm.perMin", "SPACES_MMO_LLM_PER_MIN", 20.0), ("llm.perDay", "SPACES_MMO_LLM_PER_DAY", 500.0), ("translate.perDay", "SPACES_MMO_TRANSLATE_PER_DAY", 200.0),
	("translate.guestPerDay", "SPACES_MMO_TRANSLATE_GUEST_PER_DAY", 20.0), ("npc.max", "SPACES_MMO_NPC_MAX", 10.0), ("npc.budgetDay", "SPACES_MMO_NPC_BUDGET_DAY", -1.0),
	("cmd.burst", "SPACES_MMO_CMD_BURST", 20.0), ("settlers.min", "SPACES_MMO_SETTLERS_MIN", 30.0), ("epoch.dorf", "SPACES_MMO_EPOCH_DORF", 15.0),
	("epoch.stadt", "SPACES_MMO_EPOCH_STADT", 40.0), ("epoch.netz", "SPACES_MMO_EPOCH_NETZ", 80.0), ("clock.life", "SPACES_MMO_CLOCK_LIFE", -1.0),
	("clock.decay", "SPACES_MMO_CLOCK_DECAY", -1.0), ("work.rest", "SPACES_MMO_WORK_REST", 15.0), ("year.days", "SPACES_MMO_YEAR_DAYS", 56.0),
	("epoch.force", "SPACES_MMO_EPOCH_FORCE", 0.0), ("beam.cost", "SPACES_MMO_BEAM_COST", 1.0), ("beam.cooldown", "SPACES_MMO_BEAM_COOLDOWN", 10.0),
	("beam.epoch", "SPACES_MMO_BEAM_EPOCH", 4.0), ("keep.scheuche", "SPACES_MMO_KEEP_SCHEUCHE", 7.0), ("keep.bau", "SPACES_MMO_KEEP_BAU", 30.0),
	("keep.lager", "SPACES_MMO_KEEP_LAGER", 45.0), ("keep.kapelle", "SPACES_MMO_KEEP_KAPELLE", 60.0), ("keep.park", "SPACES_MMO_KEEP_PARK", 120.0),
	("build.max1", "SPACES_MMO_BUILD_MAX_1", 10.0), ("build.max2", "SPACES_MMO_BUILD_MAX_2", 15.0), ("build.max3", "SPACES_MMO_BUILD_MAX_3", 18.0),
	("build.max4", "SPACES_MMO_BUILD_MAX_4", 20.0), ("animals.houses", "SPACES_MMO_ANIMAL_HOUSES", 5.0), ("pack.max", "SPACES_MMO_PACK_MAX", 1000.0),
	("cmd.perSec", "SPACES_MMO_CMD_PER_SEC", 5.0),
];

fn env_number(name: &str) -> Option<f64> {
	let v = std::env::var(name).ok()?;
	if v.trim().is_empty() { return None; }
	let n = crate::js::to_number(&v);
	n.is_finite().then_some(n)
}

/// `resolve`: the values from the entries read (key → value).
pub fn resolve(saved: &[(String, Json)]) -> HashMap<&'static str, f64> {
	SETTINGS.iter().map(|(k, env, def)| {
		let s = saved.iter().rev().find(|(x, _)| x == k).and_then(|(_, v)| v.as_f64());
		(*k, s.or_else(|| env_number(env)).unwrap_or(*def))
	}).collect()
}

fn ttl_ms() -> f64 { let t = std::env::var("SPACES_MMO_SETTINGS_MS").map_or(f64::NAN, |v| crate::js::to_number(&v)); if t > 0.0 { t } else { 5_000.0 } }

fn real_now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0) }

/// The values of the settings by key.
pub type Values = HashMap<&'static str, f64>;

thread_local! {
	/// The last snapshot per space (by the address of its client) and when it was read.
	static CACHE: RefCell<HashMap<usize, (f64, Values)>> = RefCell::new(HashMap::new());
}

/// The settings of `space`, read at most every few seconds.
pub async fn settings_of(space: &Space) -> Result<HashMap<&'static str, f64>> {
	let key = space.key();
	if let Some((at, v)) = CACHE.with(|c| c.borrow().get(&key).cloned()) { if real_now() - at < ttl_ms() { return Ok(v); } }
	let saved: Vec<(String, Json)> = space.read_all(&obj! { "type" => "Setting" }, None).await?.iter().map(|e| (j::s(fields(e), "key").to_owned(), j::at(fields(e), "value").clone())).collect();
	let v = resolve(&saved);
	CACHE.with(|c| c.borrow_mut().insert(key, (real_now(), v.clone())));
	Ok(v)
}

/// `setting(space, key)`.
pub async fn setting(space: &Space, key: &str) -> Result<f64> { Ok(*settings_of(space).await?.get(key).unwrap_or_else(|| panic!("no setting {key}"))) }

/// `workRestMs`.
pub async fn work_rest_ms(space: &Space) -> Result<f64> { Ok(setting(space, "work.rest").await? * 60_000.0) }

/// `forgetSettings`.
pub fn forget_settings(space: &Space) { CACHE.with(|c| c.borrow_mut().remove(&space.key())); }
