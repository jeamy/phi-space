//! Placement of a federation (src/routing-semantics.ts after `validateFederationPolicy`, and src/federation-journals.ts): which
//! Member takes a write, which Members a search asks, and the fixed journal topology. All of it follows from the policy, the
//! Member table and the entry, so every router comes to the same answer.
use crate::member::{declared_supertypes, hrw, rule_for};
use crate::space::{error, routing, CoreError, Result};
use phi_json::{digest_json, num_of, safe_integer, text, utf16_cmp, Json};
use std::cmp::Ordering;

const MAX_AGE_MS: f64 = 60_000.0;
const FUTURE_SKEW_MS: f64 = 2_000.0;

/// The digest of a routing value; one that cannot be hashed is a routing conflict.
pub fn hash(v: &Json) -> Result<String> { digest_json(v).map_err(|_| routing("a value that cannot be hashed")) }
fn canonical(v: &Json) -> Result<String> { v.canonical().map_err(|_| routing("a value that cannot be hashed")) }
fn type_error(m: &str) -> CoreError { error("TypeError", m) }
use phi_json::names;
fn sorted_unique(mut v: Vec<String>) -> Vec<String> {
	v.sort_by(|a, b| utf16_cmp(a, b));
	v.dedup();
	v
}
fn primary(r: &Json) -> bool { text(r, "mode") == Some("sync") && text(r, "variant") == Some("primary") }
fn single(r: &Json) -> bool { text(r, "mode") == Some("local") || primary(r) }

/// `normalizeFederatedEntry`: the draft with the supertypes its rule declares.
pub fn normalize_federated_entry(policy: &Json, entry: &Json) -> Result<Json> {
	let type_ = text(entry, "type").unwrap_or("");
	let parents = declared_supertypes(policy, type_, &[])?;
	if names(entry.get("types")).iter().any(|t| t != type_ && !parents.contains(t)) {
		return Err(routing("entry supertypes must be declared by its rule"));
	}
	let mut copy = entry.json_copy();
	if let Json::Object(o) = &mut copy {
		o.insert("types", phi_json::strings(&parents));
	}
	Ok(copy)
}

/// `mergeKey`: the canonical lww key, or for set the canonical fields.
fn merge_key(r: &Json, fields: &Json) -> Result<String> {
	if text(r, "variant") == Some("set") {
		return canonical(fields);
	}
	let mut key = vec![r.get("type").cloned().unwrap_or(Json::Null)];
	for k in names(r.get("keyFields")) {
		match fields.get(&k) {
			None | Some(Json::Null) => return Err(routing("lww key field missing")),
			Some(v) => key.push(v.clone()),
		}
	}
	canonical(&Json::Array(key))
}

/// `isMergeType`: replicated by merge (lww/set), no exclusive allocation.
pub fn is_merge_type(policy: &Json, type_: Option<&str>) -> bool {
	let Some(type_) = type_.filter(|t| !t.is_empty()) else { return false };
	let rules = policy.get("rules").and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
	rules.iter().find(|r| text(r, "type") == Some(type_)).is_some_and(|r| text(r, "mode") == Some("sync") && text(r, "variant") != Some("primary"))
}

fn by_field(r: &Json) -> Option<&str> { r.get("by").and_then(|b| text(b, "field")) }

fn fresh_capacity(m: &Json, now: f64) -> bool {
	let Some(c) = m.get("capacity").filter(|c| !c.is_null()) else { return false };
	let (free, at) = (num_of(c, "free").unwrap_or(f64::NAN), num_of(c, "at").unwrap_or(f64::NAN));
	free.is_finite() && free >= 0.0 && safe_integer(at) && now - at <= MAX_AGE_MS && at <= now + FUTURE_SKEW_MS
}

fn by_load(r: &Json, table: &Json, now: f64) -> Result<String> {
	let candidates: Vec<&Json> = names(r.get("members")).iter().filter_map(|id| table.get(id)).filter(|m| text(m, "state") == Some("active")).collect();
	let id = |m: &Json| text(m, "id").unwrap_or("").to_owned();
	if text(r, "by") == Some("capacity") {
		if candidates.iter().any(|m| !fresh_capacity(m, now)) {
			return Err(error("CapacityUnavailable", "capacity observations stale/missing"));
		}
		let free = |m: &Json| m.get("capacity").and_then(|c| num_of(c, "free")).unwrap_or(0.0);
		let mut open: Vec<&&Json> = candidates.iter().filter(|m| free(m) > 0.0).collect();
		open.sort_by(|a, b| free(b).partial_cmp(&free(a)).unwrap_or(Ordering::Equal).then_with(|| utf16_cmp(&id(a), &id(b))));
		return open.first().map(|m| id(m)).ok_or_else(|| error("CapacityUnavailable", "no available capacity"));
	}
	let wanted = r.get("capability");
	let capable = |m: &Json| {
		let Some(c) = m.get("capabilities").filter(|c| !c.is_null()) else { return false };
		let at = num_of(c, "at").unwrap_or(f64::NAN);
		now - at <= MAX_AGE_MS && at <= now + FUTURE_SKEW_MS && wanted.is_some_and(|w| c.get("names").and_then(Json::as_array).is_some_and(|n| n.contains(w)))
	};
	let mut found: Vec<String> = candidates.iter().filter(|m| capable(m)).map(|m| id(m)).collect();
	found.sort_by(|a, b| utf16_cmp(a, b));
	found.into_iter().next().ok_or_else(|| error("NoCapableMember", "no fresh capable member"))
}

/// `writeMember`: the one Member that takes this write.
pub fn write_member(policy: &Json, table: &Json, entry: &Json, now: f64) -> Result<String> {
	let null = Json::Null;
	let r = rule_for(policy, text(entry, "type").unwrap_or(""));
	let fields = entry.get("fields").unwrap_or(&null);
	let members = names(r.get("members"));
	let id = if single(&r) {
		text(&r, "member").unwrap_or("").to_owned()
	} else if text(&r, "mode") == Some("sync") {
		hrw(&merge_key(&r, fields)?.into(), &members)?
	} else if text(&r, "by") == Some("type") {
		hrw(r.get("type").unwrap_or(&null), &members)?
	} else if let Some(field) = by_field(&r) {
		let Some(value) = fields.get(field) else { return Err(routing("HRW key field missing")) };
		hrw(value, &members)?
	} else {
		by_load(&r, table, now)?
	};
	match table.get(&id).and_then(|m| text(m, "state")) {
		None | Some("detached" | "recoveryBlocked") => Err(routing("placement member unavailable")),
		Some("active") => Ok(id),
		Some(_) => Err(error("MemberDrained", "placement member is not admitting new work")),
	}
}

fn rule_members(r: &Json) -> Vec<String> { if r.get("member").is_some() { names(Some(&Json::Array(vec![r.get("member").cloned().unwrap_or(Json::Null)]))) } else { names(r.get("members")) } }

fn targets_of(r: &Json, template: &Json) -> Result<Vec<String>> {
	let null = Json::Null;
	if single(r) {
		return Ok(rule_members(r));
	}
	let members = names(r.get("members"));
	let type_ = r.get("type").unwrap_or(&null);
	let fields = template.get("fields").filter(|f| !f.is_null());
	if text(r, "mode") == Some("sync") {
		// Merge Members converge: one of them answers; by key when a lww template names the whole key.
		let keyed = text(r, "variant") == Some("lww") && fields.is_some_and(|f| names(r.get("keyFields")).iter().all(|k| f.get(k).is_some()));
		let value = if keyed { merge_key(r, fields.unwrap_or(&null))?.into() } else { type_.clone() };
		return Ok(vec![hrw(&value, &members)?]);
	}
	if text(r, "by") == Some("type") {
		return Ok(vec![hrw(type_, &members)?]);
	}
	if let Some(v) = by_field(r).and_then(|k| fields?.get(k)).filter(|v| !v.is_null()) {
		return Ok(vec![hrw(v, &members)?]);
	}
	Ok(members)
}

/// `searchMembers`: the Members a search with this template has to ask.
pub fn search_members(policy: &Json, template: &Json) -> Result<Vec<String>> {
	let rules = policy.get("rules").and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
	let Some(type_) = template.get("type").and_then(Json::as_str).filter(|t| !t.is_empty()) else {
		let default = policy.get("default").and_then(|d| text(d, "member")).unwrap_or("").to_owned();
		return Ok(sorted_unique(std::iter::once(default).chain(rules.iter().flat_map(rule_members)).collect()));
	};
	let mut chosen = vec![];
	for r in rules {
		let name = text(r, "type").unwrap_or("");
		if name == type_ || declared_supertypes(policy, name, &[])?.iter().any(|t| t == type_) {
			chosen.push(r.clone());
		}
	}
	if !chosen.iter().any(|r| text(r, "type") == Some(type_)) {
		chosen.push(rule_for(policy, type_));
	}
	let mut out = vec![];
	for r in &chosen {
		out.extend(targets_of(r, template)?);
	}
	Ok(sorted_unique(out))
}

/// `validateJournalPartitions`.
pub fn validate_journal_partitions(n: f64) -> Result<()> {
	if safe_integer(n) && (1.0..=1024.0).contains(&n) { Ok(()) } else { Err(type_error("journalPartitions must be 1..1024")) }
}
/// `operationPartition`: the journal of an operation, fixed by its id.
pub fn operation_partition(id: &str, n: f64) -> Result<f64> {
	validate_journal_partitions(n)?;
	let digest = hash(&id.into())?;
	let head = u32::from_str_radix(&digest[..8], 16).map_err(|_| routing("a digest that is not hex"))?;
	Ok(f64::from(head) % n)
}
/// `parentJournalKey`.
pub fn parent_journal_key(id: &str, n: f64, partition: f64) -> Result<String> {
	validate_journal_partitions(n)?;
	if partition.trunc() != partition || !partition.is_finite() || partition < 0.0 || partition >= n {
		return Err(type_error("invalid journal partition"));
	}
	if n == 1.0 { Ok(id.to_owned()) } else { hash(&Json::Array(vec![id.into(), "parent-partition-v1".into(), Json::Number(partition)])) }
}
/// `partitionRouterId`.
pub fn partition_router_id(id: &str, partition: f64) -> Result<String> {
	Ok(format!("partition-{}", hash(&Json::Array(vec![id.into(), "router-partition-v1".into(), Json::Number(partition)]))?))
}

/// One call of a test driver: `fn` names it, the rest of the line are its arguments.
pub fn call(l: &Json) -> Result<Json> {
	let null = Json::Null;
	let arg = |k: &str| l.get(k).unwrap_or(&null);
	let number = |k: &str| num_of(l, k).unwrap_or(f64::NAN);
	let id = text(l, "id").unwrap_or("");
	let list = |v: Vec<String>| phi_json::strings(&v);
	match text(l, "fn") {
		Some("normalize") => normalize_federated_entry(arg("policy"), arg("entry")),
		Some("isMerge") => Ok(Json::Bool(is_merge_type(arg("policy"), text(l, "type")))),
		Some("write") => write_member(arg("policy"), arg("table"), arg("entry"), number("now")).map(Json::from),
		Some("search") => search_members(arg("policy"), arg("template")).map(list),
		Some("partition") => operation_partition(id, number("n")).map(Json::Number),
		Some("parent") => parent_journal_key(id, number("n"), number("partition")).map(Json::from),
		Some("router") => partition_router_id(id, number("partition")).map(Json::from),
		_ => Err(error("Bad", "unknown routing call")),
	}
}
