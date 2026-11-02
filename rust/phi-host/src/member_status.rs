//! The status of the Members (`MemberStatusDirectory` of src/capability-directory.ts): the Root asks each Member what it is, and what
//! came of it goes into the routing and into a short-lived `MemberStatus` entry in one commit. A Member that does not answer loses its
//! capacity and capabilities, so that no rule places by what is no longer known.
use crate::capability::replace;
use phi_core::space::{error, CoreError, Space, Template};
use phi_json::{num_of, obj, safe_integer, text, Json};
use phi_service::Service;
use phi_wire::Local;

type R<T> = Result<T, CoreError>;
const ROUTING: &str = "phi-spaces.federation-routing";
pub const LEASE_MS: f64 = 30_000.0;

/// What a probe says; each of it is still to be checked.
#[derive(Clone)]
pub struct Probed {
	pub revision: Json,
	pub free: Json,
	pub lag: Json,
}

impl Probed {
	fn valid(&self) -> bool {
		let count = |v: &Json| v.is_null() || v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0);
		self.revision.as_f64().is_some_and(|n| safe_integer(n) && n >= 0.0) && count(&self.free) && count(&self.lag)
	}
}

pub trait StatusEnv {
	fn authorized(&self) -> R<()>;
	fn routing(&self) -> R<Json>;
	fn probe(&self, id: &str, target: &Json) -> Local<Result<Probed, String>>;
	fn record(&self, id: &str, target: &Json, status: Option<&Probed>, at: f64) -> R<()>;
	fn now(&self) -> f64;
}

fn listed(m: &Json) -> bool { matches!(text(m, "state"), Some("active" | "draining")) }

/// `refresh`: Member by Member. A probe that failed still counts, as a Member not reachable.
pub async fn refresh<E: StatusEnv>(env: &E) -> R<()> {
	env.authorized()?;
	let state = env.routing()?;
	for (id, m) in state.get("members").and_then(Json::as_object).map_or(vec![], |t| t.iter().collect()) {
		if !listed(m) {
			continue;
		}
		let at = env.now();
		let target = m.get("target").cloned().unwrap_or(Json::Null);
		let status = env.probe(id, &target).await.ok().filter(Probed::valid);
		env.authorized()?;
		env.record(id, &target, status.as_ref(), at)?;
	}
	Ok(())
}

/// One Member's status, on what the routing is by now. `Some`: the routing as written.
pub fn record_on(service: &mut Service, space: &str, mut routing: Json, id: &str, target: &Json, status: Option<&Probed>, at: f64) -> R<Option<Json>> {
	let held = routing.get("members").and_then(|t| t.get(id)).is_some_and(|m| listed(m) && m.get("target").and_then(|t| t.canonical().ok()) == target.canonical().ok());
	if !held {
		return Ok(None);
	}
	service.commit_on(Some(space), |s, now| {
		let host = target.get("hostId").cloned().unwrap_or(Json::Null);
		let caps = newest_capability(s, now, &host)?;
		let fresh = status.filter(|_| now - at < LEASE_MS);
		let current = routing.as_object_mut().and_then(|r| r.get_mut("members")).and_then(Json::as_object_mut).and_then(|t| t.get_mut(id)).and_then(Json::as_object_mut).ok_or_else(|| error("Error", "a Member without a record"))?;
		match fresh.filter(|p| !p.free.is_null()) {
			Some(p) => current.insert("capacity", obj! { "free" => p.free.clone(), "at" => at }),
			None => { current.remove("capacity"); }
		}
		match caps.filter(|_| fresh.is_some()) {
			Some(c) => {
				let names = ["tools", "models"].iter().flat_map(|k| c.get("fields").and_then(|f| f.get(k)).and_then(Json::as_array).cloned().unwrap_or_default()).collect();
				current.insert("capabilities", obj! { "names" => Json::Array(names), "at" => c.get("fields").and_then(|f| num_of(f, "at")).unwrap_or(f64::NAN) });
			}
			None => { current.remove("capabilities"); }
		}
		let of = |pick: fn(&Probed) -> &Json| fresh.map_or(Json::Null, |p| pick(p).clone());
		let fields = obj! { "memberId" => id, "hostId" => host, "reachable" => fresh.is_some(), "at" => at, "revision" => of(|p| &p.revision), "lag" => of(|p| &p.lag), "capacity" => of(|p| &p.free) };
		replace(s, now, "MemberStatus", "memberId", id.into(), fields, LEASE_MS)?;
		s.doc_writes.push((ROUTING.to_owned(), space.to_owned(), 1, routing.to_json_text()));
		Ok(())
	})?;
	Ok(Some(routing))
}

fn newest_capability(s: &mut Space, now: f64, host: &Json) -> R<Option<Json>> {
	let found = s.list(now, &Template::from_json(Some(&obj! { "type" => "Capability", "fields" => obj! { "hostId" => host.clone() } }))?, None, None, None)?;
	let mut best: Option<(f64, Json)> = None;
	for e in found.as_array().map_or(&[][..], Vec::as_slice) {
		let at = e.get("fields").and_then(|f| num_of(f, "at")).unwrap_or(f64::NAN);
		if best.as_ref().is_none_or(|(b, _)| at > *b) {
			best = Some((at, e.clone()));
		}
	}
	Ok(best.map(|(_, e)| e))
}
