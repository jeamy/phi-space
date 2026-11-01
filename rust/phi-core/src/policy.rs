//! `validateFederationPolicy` (src/routing-semantics.ts): what a federation policy must be before a control host installs it, and
//! how it may differ from the one before. Members must already be registered; placement changes need an explicit proven removal.
use phi_json::{text, safe_of};
use crate::space::routing;
use crate::member::declared_supertypes;
use crate::space::{error, CoreError};
use phi_json::{digest_json, obj, Json};
use std::collections::{HashMap, HashSet};

type Result<T> = std::result::Result<T, CoreError>;
fn migration(m: impl Into<String>) -> CoreError { error("MigrationRequired", m) }
fn array<'a>(v: &'a Json, k: &str) -> &'a [Json] { v.get(k).and_then(Json::as_array).map_or(&[], Vec::as_slice) }
fn hash(v: &Json) -> Result<String> { digest_json(v).map_err(|_| routing("a value that cannot be hashed")) }
fn same(a: Option<&Json>, b: Option<&Json>) -> Result<bool> { Ok(hash(a.unwrap_or(&Json::Null))? == hash(b.unwrap_or(&Json::Null))?) }

fn name(v: Option<&Json>) -> Result<()> {
	let bad = || routing("invalid policy identifier");
	let n = v.and_then(Json::as_str).ok_or_else(bad)?;
	if n.is_empty() || n.encode_utf16().count() > 128 || ["__proto__", "constructor", "prototype"].contains(&n) { Err(bad()) } else { Ok(()) }
}

fn members(r: &Json) -> Vec<Json> {
	match r.get("member") {
		Some(m) => vec![m.clone()],
		None => array(r, "members").to_vec(),
	}
}

fn sorted(v: Option<&Json>) -> Json {
	let mut all: Vec<String> = v.and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect());
	all.sort_by(|a, b| phi_json::utf16_cmp(a, b));
	Json::Array(all.into_iter().map(Json::String).collect())
}

fn placement(r: &Json) -> Json {
	let of = |k: &str| r.get(k).cloned().unwrap_or(Json::Null);
	match (text(r, "mode"), text(r, "variant")) {
		(Some("local"), _) => obj! { "mode" => of("mode"), "member" => of("member") },
		(Some("expand"), _) => obj! { "mode" => of("mode"), "by" => of("by"), "members" => sorted(r.get("members")), "capability" => of("capability") },
		(Some("sync"), Some("primary")) => obj! { "mode" => of("mode"), "variant" => of("variant"), "member" => of("member") },
		_ => r.clone(),
	}
}

fn no_null(v: Option<&Json>) -> Json { v.cloned().unwrap_or(Json::Null) }

fn check_rule(r: &Json, p: &Json, table: &Json, types: &mut HashSet<String>, primary: &mut HashMap<String, String>) -> Result<()> {
	name(r.get("type"))?;
	let t = text(r, "type").unwrap_or("");
	let parents = array(r, "supertypes");
	if std::iter::once(t).chain(parents.iter().filter_map(Json::as_str)).any(|x| ["Capability", "MemberStatus"].contains(&x)) {
		return Err(routing("directory types are protected metadata"));
	}
	if !types.insert(t.to_owned()) {
		return Err(routing("one rule per type"));
	}
	if let Some(s) = r.get("supertypes").filter(|s| !s.is_null()) {
		let distinct: HashSet<String> = parents.iter().map(Json::to_json_text).collect();
		if s.as_array().is_none() || parents.len() > 16 || distinct.len() != parents.len() || parents.iter().any(|x| x.as_str() == Some(t)) {
			return Err(routing("invalid declared supertypes"));
		}
		for x in parents {
			name(Some(x))?;
		}
	}
	let ids = members(r);
	let distinct: HashSet<String> = ids.iter().map(Json::to_json_text).collect();
	if ids.is_empty() || ids.len() > 128 || distinct.len() != ids.len() {
		return Err(routing("invalid member set"));
	}
	for id in &ids {
		name(Some(id))?;
		let entry = table.get(id.as_str().unwrap_or("")).filter(|m| text(m, "state") != Some("detached")).ok_or_else(|| routing("unregistered rule member"))?;
		if entry.get("target").and_then(|x| x.get("authorityId")) != p.get("authorityId") {
			return Err(routing("member authority mismatch"));
		}
	}
	match (text(r, "mode"), text(r, "variant")) {
		(Some("expand"), _) => match r.get("by") {
			Some(by) if by.as_object().is_some() => name(by.get("field"))?,
			by => {
				let by = by.and_then(Json::as_str);
				if !matches!(by, Some("type" | "capacity" | "capability")) {
					return Err(routing("invalid expand placement"));
				}
				if by == Some("capability") && !r.get("capability").is_some_and(|c| c.as_str().is_some_and(|c| !c.is_empty())) {
					return Err(routing("capability selector required"));
				}
			}
		},
		(Some("sync"), Some("primary")) => {
			let durability = text(r, "durability");
			let standby = r.get("standbyReplica").filter(|s| s.as_str().is_some_and(|s| !s.is_empty()));
			if !r.get("primaryReplica").is_some_and(|x| x.as_str().is_some_and(|x| !x.is_empty())) || !safe_of(r.get("replicaConfigVersion")).is_some_and(|v| v >= 1.0) || (durability == Some("sync") && standby.is_none()) || (durability == Some("single") && standby.is_some()) {
				return Err(routing("invalid primary replica configuration"));
			}
			let signature = hash(&obj! { "primaryReplica" => no_null(r.get("primaryReplica")), "replicaConfigVersion" => no_null(r.get("replicaConfigVersion")), "durability" => no_null(r.get("durability")), "standbyReplica" => no_null(r.get("standbyReplica")), "backupReplica" => no_null(r.get("backupReplica")) })?;
			let member = text(r, "member").unwrap_or("").to_owned();
			if primary.get(&member).is_some_and(|s| *s != signature) {
				return Err(routing("one replica configuration per member"));
			}
			if let Some(rep) = table.get(&member).and_then(|m| m.get("replication")) {
				let differs = |k: &str| no_null(rep.get(k)) != no_null(r.get(k));
				if ["primaryReplica", "replicaConfigVersion", "durability", "standbyReplica", "backupReplica"].iter().any(|k| differs(k)) {
					return Err(routing("primary rule disagrees with the member replica configuration"));
				}
			}
			primary.insert(member, signature);
		}
		(Some("sync"), variant) => {
			if (variant == Some("lww") && (text(r, "semantics") != Some("state") || array(r, "keyFields").is_empty())) || (variant == Some("set") && text(r, "semantics") != Some("facts")) {
				return Err(routing("merge semantics must be explicit"));
			}
			if r.get("members").and_then(Json::as_array).is_none() {
				return Err(routing("merge member lacks a matching entry replication"));
			}
			for id in array(r, "members") {
				let rules = table.get(id.as_str().unwrap_or("")).and_then(|m| m.get("entryReplication")).map_or(&[][..], |e| array(e, "rules"));
				let found = rules.iter().find(|x| text(x, "type") == Some(t));
				let fits = found.is_some_and(|e| e.get("variant") == r.get("variant") && (variant != Some("lww") || e.get("keyFields").map(Json::to_json_text) == r.get("keyFields").map(Json::to_json_text)));
				if !fits {
					return Err(routing("merge member lacks a matching entry replication"));
				}
			}
		}
		(Some("local"), _) => {}
		_ => return Err(routing("unknown rule mode")),
	}
	Ok(())
}

fn check_profile(f: &Json, seen: &mut HashSet<String>) -> Result<()> {
	name(f.get("taskType"))?;
	let task = text(f, "taskType").unwrap_or("");
	let positive = |k: &str| safe_of(f.get(k)).is_some_and(|n| n >= 1.0);
	let gate_fine = match f.get("gateField") {
		None => true,
		Some(g) => g.as_str().is_some() && array(f, "equalFields").contains(g),
	};
	if seen.contains(task) || array(f, "resultTypes").is_empty() || array(f, "equalFields").is_empty() || !positive("maxResultBytes") || !positive("maxResultCount") || !positive("maxLeaseMs") || !gate_fine {
		return Err(routing("invalid completion profile"));
	}
	seen.insert(task.to_owned());
	for k in ["resultTypes", "equalFields"] {
		for x in array(f, k) {
			name(Some(x))?;
		}
	}
	Ok(())
}

fn check_change(p: &Json, old: &Json, allow: &[String]) -> Result<()> {
	let profile_of = |policy: &Json, task: Option<&str>| array(policy, "completionProfiles").iter().find(|f| text(f, "taskType") == task).cloned();
	for profile in array(old, "completionProfiles") {
		if !same(Some(profile), profile_of(p, text(profile, "taskType")).as_ref())? {
			return Err(migration("existing completion profile changes require controlled transition"));
		}
	}
	for profile in array(p, "completionProfiles") {
		let task = text(profile, "taskType");
		if profile_of(old, task).is_none() && array(old, "rules").iter().any(|r| text(r, "type") == task) {
			return Err(migration("adding a profile to an existing task type requires controlled transition"));
		}
	}
	let version = |v: &Json| v.get("policyVersion").and_then(Json::as_f64).unwrap_or(0.0);
	if old.get("authorityId") != p.get("authorityId") || version(p) != version(old) + 1.0 {
		return Err(routing("policy version must advance within authority"));
	}
	let allowed = |id: &Json| id.as_str().is_some_and(|i| allow.iter().any(|a| a == i));
	for r in array(old, "rules") {
		let Some(next) = array(p, "rules").iter().find(|n| n.get("type") == r.get("type")) else {
			if !members(r).iter().all(allowed) {
				return Err(migration("existing type rule may only disappear after proven removal"));
			}
			continue;
		};
		let selecting = text(r, "mode") == Some("expand") && matches!(text(r, "by"), Some("capacity" | "capability")) && text(next, "mode") == Some("expand") && same(r.get("by"), next.get("by"))? && r.get("capability") == next.get("capability");
		if selecting {
			if array(r, "members").iter().any(|id| !array(next, "members").contains(id) && !allowed(id)) {
				return Err(migration("selection search set cannot shrink without removal"));
			}
		} else if hash(&placement(r))? != hash(&placement(next))? {
			return Err(migration("existing placement is immutable"));
		}
		let parents = |x: &Json| x.get("supertypes").cloned().unwrap_or(Json::Array(vec![]));
		if !same(Some(&parents(r)), Some(&parents(next)))? {
			return Err(migration("existing type hierarchy is immutable"));
		}
	}
	let default_of = |v: &Json| v.get("default").and_then(|d| d.get("member")).cloned();
	if default_of(old) != default_of(p) && !default_of(old).is_some_and(|m| allowed(&m)) {
		return Err(migration("default placement is immutable"));
	}
	Ok(())
}

/// `validateFederationPolicy`. `table`: the registered Members by id.
pub fn validate_federation_policy(p: &Json, table: &Json, old: Option<&Json>, allow: &[String], future_modes: bool) -> Result<()> {
	name(p.get("authorityId"))?;
	let (rules, profiles) = (p.get("rules").and_then(Json::as_array), p.get("completionProfiles").and_then(Json::as_array));
	let (Some(rules), Some(profiles)) = (rules, profiles) else { return Err(routing("policy exceeds schema/budget")) };
	if !safe_of(p.get("policyVersion")).is_some_and(|v| v >= 1.0) || rules.len() > 128 || profiles.len() > 32 || p.to_json_text().len() > 65536 {
		return Err(routing("policy exceeds schema/budget"));
	}
	let default = p.get("default").filter(|d| text(d, "mode") == Some("local")).ok_or_else(|| routing("default must name local member"))?;
	name(default.get("member"))?;
	if table.get(text(default, "member").unwrap_or("")).is_none_or(|m| text(m, "state") == Some("detached")) {
		return Err(routing("default member is not registered"));
	}
	let (mut types, mut primary) = (HashSet::new(), HashMap::new());
	for r in rules {
		check_rule(r, p, table, &mut types, &mut primary)?;
	}
	for r in rules {
		let spreads = text(r, "mode") == Some("expand") || (text(r, "mode") == Some("sync") && text(r, "variant") != Some("primary"));
		if spreads && members(r).iter().filter_map(Json::as_str).any(|id| primary.contains_key(id) || table.get(id).is_some_and(|m| m.get("replication").is_some_and(|x| !x.is_null()))) {
			return Err(routing("primary member cannot be expand or merge member"));
		}
	}
	if !future_modes && rules.iter().any(|r| text(r, "mode") == Some("sync") && text(r, "variant") == Some("primary") && !table.get(text(r, "member").unwrap_or("")).is_some_and(|m| m.get("replication").is_some_and(|x| !x.is_null()))) {
		return Err(routing("sync activation requires phase 3 implementation"));
	}
	for r in rules {
		if declared_supertypes(p, text(r, "type").unwrap_or(""), &[])?.len() > 15 {
			return Err(routing("too many transitive supertypes"));
		}
	}
	let mut seen = HashSet::new();
	for f in profiles {
		check_profile(f, &mut seen)?;
	}
	match old {
		None if p.get("policyVersion").and_then(Json::as_f64) != Some(1.0) => Err(routing("initial policy version must be one")),
		None => Ok(()),
		Some(o) => check_change(p, o, allow),
	}
}
