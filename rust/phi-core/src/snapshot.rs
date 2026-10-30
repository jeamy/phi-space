//! Bounded immutable entry snapshots (src/snapshot.ts): a read larger than one page is copied once, and its pages are
//! served from the copy by a token, private to the host, the stream, the principal and the query. Snapshots live
//! beside the document (a host's memory, lost on a restart), bounded by `maxSnapshots`, `maxSnapshotBytes` and
//! `snapshotTtlMs`.
use crate::space::{byte_page, bytes, error, js_string, strict_eq, until, Result, Space, Template};
use phi_json::{hex, number_text, obj, Json, FOREVER};

#[derive(Clone, Debug)]
struct Record {
	snapshot_epoch: f64,
	token: String,
	stream_id: String,
	query: String,
	owner: Option<Json>,
	rev: f64,
	expires: f64,
	bytes: f64,
	items: Vec<Json>,
	/// Its last page was handed out: kept for a retry of that page, but the first to go when room is needed.
	read: bool,
}

/// One host's snapshots, in order of use (a Map in TypeScript: a page read moves its snapshot to the end).
#[derive(Default)]
pub struct Snapshots {
	cache: Vec<Record>,
}

fn illegal(m: &str) -> crate::space::CoreError { error("IllegalArgumentError", m) }
/// `Number.isSafeInteger`.
fn safe_integer(x: f64) -> bool { x.trunc() == x && x.abs() <= FOREVER }
fn same_owner(a: &Option<Json>, b: Option<&Json>) -> bool {
	match (a, b) {
		(None, None) => true,
		(Some(a), Some(b)) => strict_eq(a, b),
		_ => false,
	}
}
/// `/^(ss[0-9a-f]{32})\.(\d+)$/`: the token and the position of a snapshot cursor.
fn cursor(text: &str) -> Option<(String, f64)> {
	let (token, position) = text.split_once('.')?;
	let hex_ok = token.len() == 34 && token.starts_with("ss") && token[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
	let digits_ok = !position.is_empty() && position.bytes().all(|c| c.is_ascii_digit());
	(hex_ok && digits_ok).then(|| (token.to_owned(), position.parse().expect("digits")))
}

impl Snapshots {
	pub fn new() -> Self { Self::default() }

	/// `snapshotPage`: the first page of a read (made into a snapshot when it needs more than one page), or the page of
	/// a snapshot after `o.after`.
	pub fn page(&mut self, space: &mut Space, now: f64, tmpl: &Json, o: &Json, owner: Option<&Json>) -> Result<Json> {
		space.assert_ported()?;
		self.cache.retain(|s| s.expires > now);
		let lim = space.limits();
		let stream_id = space.stream_id();
		let txn = o.get("txn").filter(|t| !t.is_null());
		let query = obj! { "tmpl" => tmpl.clone(), "txn" => txn.cloned().unwrap_or(Json::Null) }.canonical().expect("finite");
		let mut token = o.get("token").cloned();
		let mut offset = 0.0;
		if let Some(after) = o.get("after").filter(|a| !a.is_null()) {
			let parsed = cursor(&js_string(after));
			let Some((t, position)) = parsed.filter(|(t, _)| token.as_ref().is_none_or(|given| strict_eq(given, &Json::String(t.clone())))) else {
				return Err(illegal("invalid snapshot cursor"));
			};
			token = Some(Json::String(t));
			offset = position;
		}
		let truthy_token = token.as_ref().filter(|t| crate::space::truthy(Some(t)));
		let found = truthy_token.and_then(|t| t.as_str()).and_then(|t| self.cache.iter().find(|s| s.token == t)).cloned();
		if truthy_token.is_some() && found.as_ref().is_none_or(|r| r.stream_id != stream_id || r.snapshot_epoch != 0.0) {
			return Err(error("SnapshotExpired", "the entry snapshot expired or belongs to another incarnation"));
		}
		if found.as_ref().is_some_and(|r| !same_owner(&r.owner, owner) || r.query != query) {
			return Err(error("PermissionError", "the snapshot belongs to another principal or query"));
		}
		let fresh = found.is_none();
		let mut rec = match found {
			Some(r) => r,
			None => {
				let template = Template::from_json(Some(tmpl))?;
				let Json::Array(items) = space.list(now, &template, txn, o.get("limit").filter(|l| !l.is_null()), owner)? else { unreachable!("list answers an array") };
				// the whole answer in one page: no snapshot, no token
				let rev = space.revision()?;
				let cap = match o.get("maxBytes").filter(|m| !m.is_null()) {
					None => Some(lim.max_frame_bytes),
					Some(Json::Number(m)) => Some(m.min(lim.max_frame_bytes)),
					Some(_) => None,
				};
				if let Some(cap) = cap.filter(|&c| safe_integer(c) && c >= 1.0) {
					let page = obj! { "items" => items.clone(), "next" => Json::Null, "streamId" => stream_id.as_str(), "rev" => rev.clone() };
					if bytes(&page) <= cap {
						return Ok(page);
					}
				}
				let size = bytes(&Json::Array(items.clone()));
				if size > lim.max_snapshot_bytes {
					return Err(error("ResourceExhausted", "the snapshot exceeds maxSnapshotBytes"));
				}
				let token = format!("ss{}", hex(&space.random_bytes(16)));
				Record { snapshot_epoch: 0.0, token, stream_id: stream_id.clone(), query, owner: owner.cloned(), rev: rev.as_f64().unwrap_or(0.0), expires: until(now, lim.snapshot_ttl_ms), bytes: size, items, read: false }
			}
		};
		if !safe_integer(offset) || offset < 0.0 || offset > rec.items.len() as f64 {
			return Err(illegal("invalid snapshot position"));
		}
		let budget = match o.get("maxBytes").filter(|m| !m.is_null()) {
			None => lim.max_frame_bytes,
			Some(Json::Number(m)) if safe_integer(*m) && *m >= 1.0 => *m,
			Some(_) => return Err(illegal("maxBytes must be positive")),
		};
		let (token, sid, rev) = (rec.token.clone(), rec.stream_id.clone(), rec.rev);
		let page = byte_page(&rec.items, offset as usize, budget.min(lim.max_frame_bytes), |items, next| {
			obj! { "items" => items, "next" => next.map_or(Json::Null, |k| format!("{token}.{}", number_text(k as f64)).into()), "token" => token.as_str(), "streamId" => sid.as_str(), "rev" => rev }
		})?;
		// a failed page never uses a token or evicts another snapshot; the cache is kept in order of use
		if page.get("next").is_some_and(Json::is_null) {
			rec.read = true;
		}
		if fresh {
			loop {
				let own: Vec<&Record> = self.cache.iter().filter(|s| s.stream_id == stream_id).collect();
				let total: f64 = own.iter().map(|s| s.bytes).sum();
				if !(own.len() as f64 >= lim.max_snapshots || total + rec.bytes > lim.max_snapshot_bytes) {
					break;
				}
				let Some(victim) = own.iter().find(|s| s.read).or(own.first()).map(|s| s.token.clone()) else { break };
				self.cache.retain(|s| s.token != victim);
			}
		} else {
			self.cache.retain(|s| s.token != rec.token);
		}
		self.cache.push(rec);
		Ok(page)
	}
}
