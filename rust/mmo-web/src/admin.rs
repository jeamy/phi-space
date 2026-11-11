//! The operator's window (`/api/admin/settings`): the settings with where each value comes from (`server/settings.ts`),
//! the models the model process published with the admin's choice (`chosen`, `defaultModel` of `server/llm.ts`) and
//! what stands in the way of model calls in each region (`server/llm-status.ts`).
use std::sync::OnceLock;

use mmo_engine::j;
use mmo_engine::js;
use mmo_engine::settings::forget_settings;
use mmo_engine::source::time_now;
use mmo_engine::space::{fields, tmpl, Space, NO_WAIT};
use phi_json::{obj, Json, Object};

use crate::regions::RegionSpaces;
use crate::{WebError, WebResult};

const FOREVER: f64 = -1.0;

/// The settings as the oracle's SETTINGS lists them (key, env, def, min, max, label, unit, help).
pub fn defs() -> &'static [Json] {
	static D: OnceLock<Vec<Json>> = OnceLock::new();
	D.get_or_init(|| phi_json::parse(include_str!("settings.json")).ok().and_then(|v| v.as_array().cloned()).expect("settings.json"))
}

fn env_number(name: &str) -> Option<f64> {
	let v = std::env::var(name).ok()?;
	if v.trim().is_empty() { return None; }
	let n = js::to_number(&v);
	n.is_finite().then_some(n)
}

/// What the Setting entries say: each key's value with its source, and the model choice.
struct Snapshot { values: Vec<(String, f64, &'static str)>, on: bool, allowed: Option<Vec<String>>, model: Option<String> }

async fn load(space: &Space) -> WebResult<Snapshot> {
	let mut saved: Vec<(String, Json)> = Vec::new();
	for e in space.read_all(&obj! { "type" => "Setting" }, None).await? {
		let f = fields(&e);
		let k = js_string(j::at(f, "key"));
		let v = j::at(f, "value").clone();
		match saved.iter_mut().find(|(x, _)| *x == k) { Some(s) => s.1 = v, None => saved.push((k, v)) }
	}
	let get = |k: &str| saved.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
	let values = defs().iter().map(|d| {
		let key = j::s(d, "key");
		match get(key).and_then(|v| v.as_f64()) {
			Some(v) => (key.to_owned(), v, "space"),
			None => match env_number(j::s(d, "env")) { Some(e) => (key.to_owned(), e, "env"), None => (key.to_owned(), j::n(d, "def"), "default") },
		}
	}).collect();
	let m = get("llm.models").unwrap_or(Json::Null);
	Ok(Snapshot {
		values,
		on: j::at(&m, "on") != &Json::Bool(false),
		allowed: j::ao(&m, "allowed").map(|a| a.iter().map(js_string).collect()),
		model: j::so(&m, "model").map(str::to_owned),
	})
}
fn value(s: &Snapshot, key: &str) -> f64 { s.values.iter().find(|(k, _, _)| k == key).map_or(f64::NAN, |x| x.1) }

fn js_string(v: &Json) -> String { match v { Json::String(s) => s.clone(), Json::Number(n) => js::number_text(*n), Json::Null => "null".into(), Json::Bool(b) => b.to_string(), o => o.to_json_text() } }
fn bad(t: impl Into<String>) -> WebError { WebError::Auth(400, t.into()) }

/// `saveSettings`: refuses unknown keys and values out of range; null goes back to the environment or the default.
async fn save_settings(space: &Space, values: &Object) -> WebResult<()> {
	for (key, v) in values.iter() {
		let Some(d) = defs().iter().find(|d| j::s(d, "key") == key) else { return Err(bad(format!("Unbekannte Einstellung {}", js::slice16(key, 0, Some(40))))) };
		let ok = v.is_null() || v.as_f64().is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n >= j::n(d, "min") && n <= j::n(d, "max"));
		if !ok { return Err(bad(format!("{}: eine ganze Zahl von {} bis {}", j::s(d, "label"), js::number_text(j::n(d, "min")), js::number_text(j::n(d, "max"))))); }
	}
	for (key, v) in values.iter() {
		while space.take_if_exists(&tmpl("Setting", obj! { "key" => key }), NO_WAIT, None).await?.is_some() {}
		if !v.is_null() { space.write(&tmpl("Setting", obj! { "key" => key, "value" => v.clone(), "at" => time_now() }), None, FOREVER).await?; }
	}
	forget_settings(space);
	Ok(())
}

async fn save_model_choice(space: &Space, choice: Option<&Json>) -> WebResult<()> {
	while space.take_if_exists(&tmpl("Setting", obj! { "key" => "llm.models" }), NO_WAIT, None).await?.is_some() {}
	if let Some(c) = choice { space.write(&tmpl("Setting", obj! { "key" => "llm.models", "value" => c.clone(), "at" => time_now() }), None, FOREVER).await?; }
	forget_settings(space);
	Ok(())
}

/// `defaultModel`: the newest whose id holds SPACES_MMO_LLM_MODEL (default haiku), else the one model there is.
fn default_model(available: &[Json]) -> Option<Json> {
	let want = js::lower(&std::env::var("SPACES_MMO_LLM_MODEL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "haiku".into()));
	let mut m: Vec<&Json> = available.iter().filter(|m| js::lower(j::s(m, "id")).contains(&want)).collect();
	m.sort_by(|a, b| js::locale_compare(j::s(b, "id"), j::s(a, "id")));
	m.first().map(|x| (*x).clone()).or_else(|| (available.len() == 1).then(|| available[0].clone()))
}
/// `chosen`: the allowed models and the one calls use.
fn chosen(available: &[Json], allowed: &Option<Vec<String>>, model: &Option<String>) -> (Vec<Json>, Option<Json>) {
	let allowed: Vec<Json> = match allowed {
		Some(a) => a.iter().filter_map(|l| available.iter().rev().find(|m| j::s(m, "label") == l).cloned()).collect(),
		None => default_model(available).into_iter().collect(),
	};
	let pick = allowed.iter().find(|m| model.as_deref() == Some(j::s(m, "label"))).or(allowed.first()).cloned();
	(allowed, pick)
}

/// `new Date(ms).toISOString()`.
fn iso(ms: f64) -> String {
	let ms = ms.floor() as i64;
	let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
	// civil from days (Howard Hinnant)
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = yoe + era * 400 + i64::from(m <= 2);
	format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

async fn used(space: &Space, key: &str) -> WebResult<f64> { Ok(space.read_if_exists(&tmpl("LlmCount", obj! { "key" => key }), 0.0, None).await?.map_or(0.0, |e| j::number(j::at(fields(&e), "used")))) }
async fn noted(space: &Space, key: &str) -> WebResult<Json> {
	let f = space.read_if_exists(&tmpl("LlmStatus", obj! { "key" => key }), 0.0, None).await?.map(|e| fields(&e).clone());
	Ok(match f { Some(f) if j::truthy(j::at(&f, "text")) => obj! { "text" => js_string(j::at(&f, "text")), "at" => j::no(&f, "at").unwrap_or(0.0) }, _ => Json::Null })
}

async fn llm_status(region: &str, space: &Space) -> WebResult<Json> {
	let info = space.read_limit(&obj! { "type" => "ModelInfo" }, 1, None).await?.first().map(|e| fields(e).clone());
	let s = load(space).await?;
	let now = iso(time_now());
	let (day, minute) = (&now[..10], &now[..16]);
	let (per_min, per_day) = (value(&s, "llm.perMin"), value(&s, "llm.perDay"));
	let day_used = used(space, &format!("day:{day}")).await?;
	let min_used = used(space, &format!("min:{minute}")).await?;
	let (last, ok) = (noted(space, "last").await?, noted(space, "ok").await?);
	let mut problems: Vec<Json> = Vec::new();
	let mut add = |level: &str, text: String, fix: String| problems.push(obj! { "level" => level, "text" => text, "fix" => fix });
	let n = js::number_text;
	let enabled = info.as_ref().is_some_and(|i| j::truthy(j::at(i, "enabled")));
	match &info {
		None => add("error", "Der Modellprozess meldet sich nicht (er meldet sich alle 20 Sekunden).".into(), format!("Prüfe, ob der Container model-{region} läuft (docker ps), und lies sein Log.")),
		Some(_) if !enabled => add("error", "Modellaufrufe sind in der Umgebung aus: SPACES_MMO_LLM ist nicht 1.".into(), "Trage SPACES_MMO_LLM=1 in die .env des Servers ein und starte die Container neu. Die Aufrufe kosten Tokens.".into()),
		Some(_) if !s.on => add("error", "Die Modellaufrufe sind hier im Fenster ausgeschaltet.".into(), "Setze unter „Modelle“ den Haken bei „Modell-NPCs und Übersetzen an“ und speichere.".into()),
		Some(i) if j::a(i, "models").is_empty() => add("error", "Kein Modell mit Zugangsdaten gefunden.".into(), "Lege den API-Schlüssel in die Umgebung des Modellprozesses (oder ~/.pi/agent/auth.json) und starte ihn neu.".into()),
		Some(i) if chosen(j::a(i, "models"), &s.allowed, &s.model).1.is_none() => add("error", "Kein erlaubtes Modell wählbar: das Standardmodell (SPACES_MMO_LLM_MODEL, sonst Haiku) fehlt unter den verfügbaren, oder die gewählten gibt es nicht mehr.".into(), "Wähle unter „Modelle“ eines aus und speichere.".into()),
		_ => {}
	}
	if enabled && s.on {
		if per_day == 0.0 { add("error", "Modellaufrufe je Tag stehen auf 0: alle Aufrufe sind angehalten.".into(), "Erhöhe „Modellaufrufe je Tag“ unter „Grenzen“.".into()); }
		else if day_used >= per_day { add("error", format!("Das Tageskontingent ist aufgebraucht: {} von {} Aufrufen (Kalendertag UTC, neu ab 00:00 UTC).", n(day_used), n(per_day)), "Erhöhe „Modellaufrufe je Tag“ unter „Grenzen“ oder warte bis zum nächsten UTC-Tag.".into()); }
		if per_min == 0.0 { add("error", "Modellaufrufe je Minute stehen auf 0: alle Aufrufe sind angehalten.".into(), "Erhöhe „Modellaufrufe je Minute“ unter „Grenzen“.".into()); }
		else if min_used >= per_min { add("warn", format!("Das Minutenkontingent ist gerade erreicht: {} von {}.", n(min_used), n(per_min)), "Es setzt zur nächsten Minute zurück; erhöhe „Modellaufrufe je Minute“, wenn das oft vorkommt.".into()); }
		let per_account = value(&s, "translate.perDay");
		if per_account == 0.0 { add("warn", "Übersetzungen je Konto stehen auf 0: freie Sätze werden nicht übersetzt.".into(), "Erhöhe „Übersetzungen je Konto und Tag“ unter „Grenzen“.".into()); }
		else {
			let suffix = format!(":{day}");
			let full = space.read_all(&obj! { "type" => "LlmCount" }, None).await?.iter().filter(|e| { let k = js_string(j::at(fields(e), "key")); k.starts_with("translate:") && k.ends_with(&suffix) && j::number(j::at(fields(e), "used")) >= per_account }).count();
			if full > 0 { add("warn", format!("{full} {} heute die Grenze für Übersetzungen erreicht ({} je Konto).", if full == 1 { "Konto hat" } else { "Konten haben" }, n(per_account)), "Erhöhe „Übersetzungen je Konto und Tag“ unter „Grenzen“. Gäste haben ihre eigene, kleinere Grenze.".into()); }
		}
		if value(&s, "translate.guestPerDay") == 0.0 { add("warn", "Übersetzungen je Gast stehen auf 0: Gäste bekommen keine Übersetzung.".into(), "Erhöhe „Übersetzungen je Gast und Tag“ unter „Grenzen“.".into()); }
	}
	if let Some(t) = j::so(&last, "text") { if t.starts_with("Fehler des Anbieters") && time_now() - j::n(&last, "at") < 15.0 * 60_000.0 { add("error", format!("Der Anbieter antwortet mit Fehlern. {t}"), "Prüfe den API-Schlüssel, das Guthaben beim Anbieter und die Erreichbarkeit; wähle sonst ein anderes Modell.".into()); } }
	Ok(obj! { "region" => region, "problems" => Json::Array(problems), "last" => last, "ok" => ok, "day" => obj! { "used" => day_used, "limit" => per_day }, "minute" => obj! { "used" => min_used, "limit" => per_min } })
}

/// GET (change None) and POST of `/api/admin/settings`; the caller checked that `me` is an admin.
pub async fn admin_settings(regions: &RegionSpaces, change: Option<&Json>) -> WebResult<Json> {
	let home = regions.home_space();
	let info = home.read_limit(&obj! { "type" => "ModelInfo" }, 1, None).await?.first().map(|e| fields(e).clone());
	let available: Vec<Json> = info.as_ref().map(|i| j::a(i, "models").to_vec()).unwrap_or_default();
	if let Some(change) = change {
		if let Some(values) = change.get("values") {
			let Some(o) = values.as_object() else { return Err(bad("values: Schlüssel und Zahlen")) };
			for (_, s) in regions.entries() { save_settings(s, o).await?; }
		}
		if let Some(m) = change.get("models") {
			if m.is_null() { for (_, s) in regions.entries() { save_model_choice(s, None).await?; } }
			else {
				let allowed = j::at(m, "allowed");
				let model = j::at(m, "model");
				let ok_allowed = allowed.is_null() || allowed.as_array().is_some_and(|a| a.iter().all(|l| l.as_str().is_some()));
				if m.as_object().is_none() || !matches!(j::at(m, "on"), Json::Bool(_)) || !ok_allowed || !(model.is_null() || model.as_str().is_some()) { return Err(bad("models: {on, allowed, model}")); }
				let labels: Vec<&str> = available.iter().map(|x| j::s(x, "label")).collect();
				let mut named: Vec<&str> = j::strs(j::a(m, "allowed"));
				if let Some(x) = model.as_str().filter(|x| !x.is_empty()) { named.push(x); }
				let unknown: Vec<&str> = named.into_iter().filter(|l| !labels.contains(l)).collect();
				if !unknown.is_empty() { return Err(bad(format!("Unbekannte Modelle: {}", unknown.iter().take(5).copied().collect::<Vec<_>>().join(", ")))); }
				if allowed.as_array().is_some_and(Vec::is_empty) { return Err(bad("Mindestens ein Modell erlauben (oder Standard)")); }
				if let (Some(x), Some(a)) = (model.as_str().filter(|x| !x.is_empty()), allowed.as_array()) { if !a.iter().any(|l| l.as_str() == Some(x)) { return Err(bad("Das verwendete Modell muss erlaubt sein")); } }
				let choice = obj! { "on" => j::at(m, "on").clone(), "allowed" => allowed.clone(), "model" => model.clone() };
				for (_, s) in regions.entries() { save_model_choice(s, Some(&choice)).await?; }
			}
		}
	}
	let s = load(home).await?;
	let (allowed, pick) = chosen(&available, &s.allowed, &s.model);
	let mut status = Vec::new();
	for (region, space) in regions.entries() {
		status.push(match llm_status(region, space).await {
			Ok(v) => v,
			Err(e) => obj! { "region" => region.as_str(), "problems" => Json::Array(vec![obj! { "level" => "error", "text" => format!("Der Raum {region} ist nicht erreichbar: {}", js::slice16(&e.to_string(), 0, Some(120))), "fix" => format!("Prüfe den Container space-{region}.") }]),
				"last" => Json::Null, "ok" => Json::Null, "day" => obj! { "used" => 0.0, "limit" => 0.0 }, "minute" => obj! { "used" => 0.0, "limit" => 0.0 } },
		});
	}
	let fields_v: Vec<Json> = defs().iter().map(|d| {
		let mut o = j::object(d);
		let reorder = ["key", "label", "unit", "help", "env", "def", "min", "max"];
		let mut out = Object::new();
		for k in reorder { if let Some(v) = o.remove(k) { out.insert(k, v); } }
		let (_, v, src) = s.values.iter().find(|(k, _, _)| k == j::s(d, "key")).cloned().unwrap_or_default();
		out.insert("value", Json::Number(v));
		out.insert("source", Json::from(src));
		Json::Object(out)
	}).collect();
	Ok(obj! {
		"status" => Json::Array(status),
		"fields" => Json::Array(fields_v),
		"models" => obj! { "enabled" => info.as_ref().is_some_and(|i| j::truthy(j::at(i, "enabled"))), "published" => info.is_some(), "on" => s.on, "custom" => s.allowed.is_some(), "available" => Json::Array(available.clone()),
			"allowed" => Json::Array(allowed.iter().map(|m| j::at(m, "label").clone()).collect()), "model" => pick.map_or(Json::Null, |m| j::at(&m, "label").clone()) }
	})
}

#[cfg(test)]
mod tests {
	#[test]
	fn iso_dates() {
		assert_eq!(super::iso(0.0), "1970-01-01T00:00:00.000Z");
		assert_eq!(super::iso(1_794_268_800_123.0), "2026-11-10T00:00:00.123Z");
		assert_eq!(super::iso(951_782_400_000.0), "2000-02-29T00:00:00.000Z");
	}
}
