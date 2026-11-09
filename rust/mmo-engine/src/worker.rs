//! What the world worker runs (`server/world-host.ts`): so far its recurring jobs, as its `runs` table has them (each in
//! `stableTerrain`, on the world as the rooms grew).
use phi_json::Json;

use crate::clock::by_peoples_pace;
use crate::commands::trade::{market_tick, orders_tick};
use crate::commands::wind::wind_tick;
use crate::fire::{chain_tick, fire_tick, flood_tick, fog_tick};
use crate::room_growth::{end_terrain, spatial_world, stable_terrain};
use crate::space::{Error, Result, Space};

/// The jobs ported so far.
pub const JOBS: &[&str] = &["fire", "fog", "flood", "orders", "market", "wind"];

/// Runs the recurring job `job` once.
pub async fn run_job(space: &Space, w: &Json, job: &str, msg_lease_ms: f64) -> Result<()> {
	if !JOBS.contains(&job) { return Err(Error::Other(format!("unknown job {job}"))); }
	let txn = stable_terrain(space).await?;
	let r: Result<()> = async {
		let live = spatial_world(space, w).await?;
		match job {
			"fire" => { fire_tick(space, &live, msg_lease_ms).await?; chain_tick(space, &live, msg_lease_ms).await }
			"fog" => fog_tick(space, &live, msg_lease_ms).await,
			"flood" => { if by_peoples_pace(space).await? { flood_tick(space, &live, msg_lease_ms).await } else { Ok(()) } }
			"orders" => orders_tick(space, &live).await,
			"market" => market_tick(space, &live).await,
			"wind" => { if std::env::var("SPACES_MMO_WIND").as_deref() != Ok("0") { wind_tick(space, &live, msg_lease_ms).await?; } Ok(()) }
			_ => unreachable!(),
		}
	}.await;
	end_terrain(space, &txn).await?;
	r
}
