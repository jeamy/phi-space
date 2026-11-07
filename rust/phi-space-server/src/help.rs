// The swarm Space of the help site (help-site/server/social/space-side.ts and retention.ts): the Space by its alias, its
// limits and completion profile, the HostInfo entry and the purge of the oldest posts above the cap. Host code, on the
// store's own thread, as the TypeScript space process runs it in its host's commits.
use phi_core::space::{error, CoreError, Template};
use phi_json::{obj, Json, Object, FOREVER};
use phi_service::Service;
use std::collections::{HashMap, HashSet};

pub const ALIAS: &str = "social-swarm";
/// retention.ts `SWARM_CLAIM_RESULT_MS`.
pub const CLAIM_RESULT_MS: f64 = 15.0 * 60_000.0;
const DEFAULT_MAX_ENTRIES: f64 = 20_000.0;
const MIN_KEEP_POSTS: usize = 20;
/// The author id of the operator's own posts: never purged, nor are the replies under them.
const HUMAN_AUTHOR: &str = "agent-you";
const BATCH_POSTS: usize = 50;
const BATCH_LIKES: usize = 200;
const NOTICE_POST_IDS: usize = 1000;

type R<T> = Result<T, CoreError>;

/// `SWARM_LIMITS`.
pub fn limits() -> Json {
	obj! { "claimResultMs" => CLAIM_RESULT_MS, "generationAdmitMs" => CLAIM_RESULT_MS, "maxTxnsPerOwner" => 1000.0, "maxWaitersPerOwner" => 1000.0, "maxRegsPerOwner" => 1000.0 }
}

fn profiles() -> Json {
	Json::Array(vec![obj! { "taskType" => "SwarmTask", "resultTypes" => Json::Array(vec!["Post".into(), "Like".into()]), "equalFields" => Json::Array(vec!["taskId".into()]), "maxResultCount" => 1.0, "maxResultBytes" => 64.0 * 1024.0, "maxLeaseMs" => 60_000.0 }])
}

/// `retentionConfig`: `SWARM_MAX_ENTRIES` (default 20000; 0, off or anything else that is no whole number from 1 off).
#[derive(Clone, Copy)]
pub struct Retention {
	pub cap: f64,
	pub low: f64,
}
pub fn retention() -> Option<Retention> {
	let cap = match std::env::var("SWARM_MAX_ENTRIES").ok().filter(|v| !v.is_empty()) {
		None => DEFAULT_MAX_ENTRIES,
		Some(raw) => raw.trim().parse::<f64>().unwrap_or(f64::NAN),
	};
	(cap.is_finite() && cap.trunc() == cap && cap >= 1.0).then(|| Retention { cap, low: cap - (cap * 0.05).floor().max(1.0) })
}
/// `retentionEvery`: `SWARM_RETENTION_MS` (at least 10, default 10 s).
pub fn every_ms() -> u64 { std::env::var("SWARM_RETENTION_MS").ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|n| n.is_finite() && *n >= 10.0).map_or(10_000, |n| n as u64) }

fn found(r: &Json) -> bool { r.get("status").and_then(Json::as_str) == Some("found") }
fn tmpl(v: Json) -> R<Template> { Template::from_json(Some(&v)) }
fn text(o: &Object, key: &str) -> String { o.get(key).and_then(Json::as_str).unwrap_or("").to_owned() }
fn number(o: &Object, key: &str) -> f64 { o.get(key).and_then(Json::as_f64).unwrap_or(f64::NAN) }

/// `prepareSwarmSpace`: the Space by its alias, limits, completion profile (only while no transaction is open), and the
/// HostInfo entry replaced.
pub fn prepare(service: &mut Service, facts: Json, cap: Option<f64>) -> R<()> {
	service.create_space_with(ALIAS, phi_store::system_random(), |_, _| Ok(()))?;
	service.commit_on(Some(ALIAS), |s, now| {
		s.set_limits(now, &limits())?;
		if s.state.txns.is_empty() {
			s.set_completion_profiles(now, Some(&profiles()))?;
		}
		let any = tmpl(obj! { "type" => "HostInfo" })?;
		while found(&s.probe(now, &any, None, true, None)?) {}
		let mut fields = facts;
		if let Json::Object(o) = &mut fields {
			o.insert("cap", cap.map_or(Json::Null, Json::Number));
		}
		s.write(now, &obj! { "type" => "HostInfo", "fields" => fields }, None, Some(&FOREVER.into()), None)?;
		Ok(())
	})
}

struct Victim {
	node: String,
	refs: Vec<(String, &'static str)>,
	post_id: String,
}

/// `purgeOldest`: above the cap the oldest posts go with their history nodes and likes, down to the low-water mark;
/// strays (likes whose post lies on the other shard) first. Each part is one commit that also repoints the next newer
/// kept node, so paging never meets a dangling pointer. Returns what the PurgeNotice says, or None when nothing had to go.
pub fn purge(service: &mut Service, cfg: Retention) -> R<Option<String>> {
	let now = service.now();
	let reader = service.store.reader(Some(ALIAS))?;
	let space = &reader.space;
	let visible = space.stats(now)?.get("entries").and_then(Json::as_f64).unwrap_or(0.0);
	if visible <= cfg.cap {
		return Ok(None);
	}
	let entries = &space.state.entries;
	let Some(head) = entries.iter().find(|e| e.type_ == "PostHistoryHead") else { return Ok(None) };
	if head.fields.get("ready") == Some(&Json::Bool(false)) {
		return Ok(None);
	}
	let mut nodes: HashMap<&str, &phi_core::state::EntryRec> = HashMap::new();
	let mut posts: HashMap<String, String> = HashMap::new();
	let mut likes: HashMap<String, Vec<String>> = HashMap::new();
	for e in entries.iter() {
		if e.written_under.is_some() || e.taken_by.is_some() {
			continue;
		}
		match e.type_.as_str() {
			"PostHistoryNode" => { nodes.insert(&e.id, e); }
			"Post" => { posts.insert(text(&e.fields, "postId"), e.id.clone()); }
			"Like" => likes.entry(text(&e.fields, "postId")).or_default().push(e.id.clone()),
			_ => {}
		}
	}
	let mut newest_first = vec![];
	let (mut id, mut seen) = (text(&head.fields, "next"), HashSet::new());
	while !id.is_empty() && !seen.contains(&id) {
		let Some(n) = nodes.get(id.as_str()) else { break };
		seen.insert(id.clone());
		newest_first.push(*n);
		id = text(&n.fields, "next");
	}
	let oldest: Vec<_> = newest_first.into_iter().rev().collect();
	let target = visible - cfg.low;
	let mut strays: Vec<_> = entries.iter().filter(|e| e.type_ == "Like" && e.written_under.is_none() && e.taken_by.is_none() && !posts.contains_key(&text(&e.fields, "postId"))).collect();
	strays.sort_by(|a, b| number(&a.fields, "at").partial_cmp(&number(&b.fields, "at")).unwrap_or(std::cmp::Ordering::Equal));
	strays.truncate(target.max(0.0) as usize);
	let strays: Vec<String> = strays.into_iter().map(|e| e.id.clone()).collect();
	// what stays: posts of people (the operator's own) and every reply under them, however deep the thread
	let info: Vec<(String, String, String)> = oldest.iter().map(|n| match phi_json::parse(&text(&n.fields, "post")).ok().and_then(|p| p.as_object().cloned()) {
		// String(p.postId ?? ""), String(p.author ?? ""), p.replyTo ? String(p.replyTo) : ""
		Some(p) => (p.get("postId").filter(|v| !v.is_null()).map_or(String::new(), stringify), p.get("author").filter(|v| !v.is_null()).map_or(String::new(), stringify), p.get("replyTo").filter(|v| truthy(v)).map_or(String::new(), stringify)),
		None => Default::default(),
	}).collect();
	let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
	for (pid, _, reply_to) in &info {
		if !reply_to.is_empty() {
			children.entry(reply_to.as_str()).or_default().push(pid.as_str());
		}
	}
	let mut keep: HashSet<&str> = HashSet::new();
	let mut todo: Vec<&str> = info.iter().filter(|(pid, author, _)| author == HUMAN_AUTHOR && !pid.is_empty()).map(|(pid, _, _)| pid.as_str()).collect();
	while let Some(id) = todo.pop() {
		if keep.insert(id) {
			todo.extend(children.get(id).into_iter().flatten().copied());
		}
	}
	let mut victims = vec![];
	let mut planned = strays.len() as f64;
	for (i, node) in oldest.iter().enumerate().take(oldest.len().saturating_sub(MIN_KEEP_POSTS)) {
		if planned >= target {
			break;
		}
		let post_id = info[i].0.clone();
		if !post_id.is_empty() && keep.contains(post_id.as_str()) {
			continue;
		}
		let mut refs = vec![(node.id.clone(), "PostHistoryNode")];
		if let Some(p) = posts.get(&post_id) {
			refs.push((p.clone(), "Post"));
		}
		refs.extend(likes.get(&post_id).into_iter().flatten().map(|l| (l.clone(), "Like")));
		planned += refs.len() as f64;
		victims.push(Victim { node: node.id.clone(), refs, post_id });
	}
	if victims.is_empty() && strays.is_empty() {
		return Ok(None);
	}
	// The chain runs from the newest node to the oldest (`next` points to the older one). A node that goes is unlinked: the
	// next newer node takes over its `next`, so survivors in the middle (the kept threads) stay chained.
	let mut older_of: HashMap<String, String> = HashMap::new();
	let mut newer_of: HashMap<String, String> = HashMap::new();
	for (i, n) in oldest.iter().enumerate() {
		older_of.insert(n.id.clone(), text(&n.fields, "next"));
		if let Some(m) = oldest.get(i + 1) {
			newer_of.insert(n.id.clone(), m.id.clone());
		}
	}
	let mut removed = 0.0;
	let mut post_ids: Vec<String> = vec![];
	for part in strays.chunks(BATCH_LIKES) {
		removed += service.commit_on(Some(ALIAS), |s, now| {
			let mut n = 0.0;
			for id in part {
				if found(&s.probe(now, &tmpl(obj! { "type" => "Like", "id" => id.as_str() })?, None, true, None)?) {
					n += 1.0;
				}
			}
			s.touch(now);
			Ok(n)
		})?;
	}
	for part in victims.chunks(BATCH_POSTS) {
		let links: Vec<(String, String, String)> = part.iter().map(|v| {
			let (newer, older) = (newer_of.get(&v.node).cloned().unwrap_or_default(), older_of.get(&v.node).cloned().unwrap_or_default());
			if !newer.is_empty() {
				older_of.insert(newer.clone(), older.clone());
			}
			if !older.is_empty() {
				newer_of.insert(older.clone(), newer.clone());
			}
			(v.node.clone(), newer, older)
		}).collect();
		removed += service.commit_on(Some(ALIAS), |s, now| {
			let mut n = 0.0;
			for v in part {
				for (id, type_) in &v.refs {
					if found(&s.probe(now, &tmpl(obj! { "type" => *type_, "id" => id.as_str() })?, None, true, None)?) {
						n += 1.0;
					} else if *id == v.node {
						return Err(error("Error", "history node unavailable"));
					}
				}
			}
			let going: HashSet<&str> = part.iter().map(|v| v.node.as_str()).collect();
			for (_, newer, older) in &links {
				if newer.is_empty() || going.contains(newer.as_str()) {
					continue; // the newest node never goes (MIN_KEEP_POSTS); a neighbour that goes too is not relinked
				}
				let Some(at) = s.state.entries.iter().position(|e| e.id == *newer) else { return Err(error("Error", "history chain changed")) };
				s.state.entries.get_mut(at).fields.insert("next", older.as_str().into());
			}
			s.touch(now);
			Ok(n)
		})?;
		post_ids.extend(part.iter().filter(|v| !v.post_id.is_empty()).map(|v| v.post_id.clone()));
	}
	let at = service.now();
	let shown = post_ids[post_ids.len().saturating_sub(NOTICE_POST_IDS)..].iter().map(|p| Json::from(p.as_str())).collect::<Vec<_>>();
	let posts_gone = post_ids.len() as f64;
	let line = service.commit_on(Some(ALIAS), |s, now| {
		let old = s.probe(now, &tmpl(obj! { "type" => "PurgeNotice" })?, None, true, None)?;
		let total = if found(&old) { old.get("entry").and_then(|e| e.get("fields")).and_then(|f| f.get("totalRemoved")).and_then(Json::as_f64).filter(|n| *n != 0.0 && !n.is_nan()).unwrap_or(0.0) } else { 0.0 };
		let entries = s.stats(now)?.get("entries").and_then(Json::as_f64).unwrap_or(0.0);
		let fields = obj! { "at" => at, "removed" => removed, "posts" => posts_gone, "totalRemoved" => total + removed, "cap" => cfg.cap, "entries" => entries, "postIds" => Json::Array(shown) };
		s.write(now, &obj! { "type" => "PurgeNotice", "fields" => fields }, None, Some(&FOREVER.into()), None)?;
		Ok(format!("[swarm] retention: purged {removed} entries ({posts_gone} posts), {entries} left, cap {}", cfg.cap))
	})?;
	Ok(Some(line))
}

/// `String(v)` of a value read from a post's JSON.
fn stringify(v: &Json) -> String {
	match v {
		Json::String(s) => s.clone(),
		other => other.canonical().unwrap_or_default(),
	}
}
/// JavaScript truthiness of a JSON value.
fn truthy(v: &Json) -> bool {
	match v {
		Json::Null | Json::Bool(false) => false,
		Json::Number(n) => *n != 0.0 && !n.is_nan(),
		Json::String(s) => !s.is_empty(),
		_ => true,
	}
}
