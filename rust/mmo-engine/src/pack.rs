//! What a figure can carry (`server/engine/pack.ts`, `shared/load-format.ts`): every thing has a load by its kind, a figure
//! carries up to `pack.max`; checked once around every command.
use phi_json::{obj, Json};

use crate::j;
use crate::space::{fields, tmpl, Result, Space};

/// `loadOf`.
pub fn load_of(w: &Json, proto: Option<&str>) -> f64 {
	match proto {
		None | Some("") => 0.0,
		Some(p) if Some(p) == j::so(w, "currency") => 0.0,
		Some(p) => j::opt(w, "pack").and_then(|pk| j::at(j::at(pk, "load"), p).as_f64()).unwrap_or(1.0),
	}
}

/// `loadAt`: what `location` holds, in load.
pub async fn load_at(space: &Space, w: &Json, location: &str, txn: Option<&str>) -> Result<f64> {
	Ok(space.read_all(&tmpl("Item", obj! { "location" => location }), txn).await?.iter().map(|e| load_of(w, j::so(fields(e), "proto"))).sum())
}

/// `packMax`.
pub async fn pack_max(space: &Space, w: &Json) -> Result<f64> {
	let Some(pk) = j::opt(w, "pack") else { return Ok(f64::INFINITY) };
	Ok(match crate::settings::setting(space, "pack.max").await { Ok(v) => v, Err(_) => j::n(pk, "max") })
}

/// `fmtLoad`: 31.5 as "31½".
pub fn fmt_load(n: f64) -> String {
	let whole = (n + 1e-9).floor();
	let half = n - whole >= 0.5 - 1e-9;
	if whole == 0.0 && half { "½".into() } else { format!("{}{}", phi_json::number_text(whole), if half { "½" } else { "" }) }
}

const LIGHT: [&str; 18] = ["look", "say", "emote", "who", "help", "time", "inventory", "truhe", "lager", "reputation", "epoche", "wetter", "fahrplan", "wache", "baustelle", "tell", "whisper", "page"];

/// `packBefore`: the actor's load before a command, or None when it is not checked.
pub async fn pack_before(space: &Space, w: &Json, char_id: &str, key: &str, npc: bool, txn: &str) -> Result<Option<f64>> {
	if j::opt(w, "pack").is_none() || npc || LIGHT.contains(&key) { return Ok(None); }
	Ok(Some(load_at(space, w, char_id, Some(txn)).await?))
}

/// `packAfter`: the refusal when the command left the pack heavier than before and over the limit.
pub async fn pack_after(space: &Space, w: &Json, char_id: &str, before: Option<f64>, txn: &str) -> Result<Option<String>> {
	let Some(before) = before else { return Ok(None) };
	let after = load_at(space, w, char_id, Some(txn)).await?;
	if after <= before { return Ok(None); }
	let max = pack_max(space, w).await?;
	if after <= max { return Ok(None); }
	Ok(Some(format!("Das trägst du nicht mehr: dein Gepäck wöge {} von {}. Leg etwas in eine Truhe („verstaue <ding>“) oder lass es hier.", fmt_load(after), fmt_load(max))))
}
