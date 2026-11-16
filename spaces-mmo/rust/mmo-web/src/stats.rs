//! The statistics page (`server/stats.ts`, GET /api/stats): the players and what the world holds, read from every region
//! and added up; read at most every 20 s, everyone shares one reading.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use mmo_engine::j;
use mmo_engine::js;
use mmo_engine::source::time_now;
use mmo_engine::space::{fields, tmpl, Result, Space};
use phi_json::{obj, Json, Object};

use crate::omap::OMap;
use crate::regions::RegionSpaces;

const TRIPS: [&str; 5] = ["beam", "ship", "sail", "row", "train"];
const TYPES: [&str; 12] = ["Account", "Character", "Session", "Contribution", "ParkCare", "Deed", "Travel", "Building", "Bed", "Field", "Site", "Settlement"];

async fn all(space: &Space, ty: &str) -> Result<Vec<Json>> {
	let mut out = Vec::new();
	let (mut after, mut token): (Option<String>, Option<String>) = (None, None);
	loop {
		let page = space.remote().read_page(&obj! { "type" => ty }, Some(256.0 * 1024.0), after.as_deref(), token.as_deref(), None, None).await?;
		for e in j::a(&page, "items") { out.push(fields(e).clone()); }
		after = j::so(&page, "next").map(str::to_owned);
		token = j::so(&page, "token").map(str::to_owned);
		if after.is_none() { return Ok(out); }
	}
}

fn no_trips() -> Vec<f64> { vec![0.0; TRIPS.len()] }
fn trips_json(t: &[f64]) -> Json { let mut o = Object::new(); for (k, v) in TRIPS.iter().zip(t) { o.insert(*k, Json::Number(*v)); } Json::Object(o) }
fn count_of(m: &mut OMap<f64>, k: &str, by: f64) { let v = m.get(k).copied().unwrap_or(0.0); m.set(k, v + by); }
fn de(a: &str, b: &str) -> std::cmp::Ordering { js::locale_compare(a, b) }

pub async fn collect_stats(regions: &RegionSpaces, w: &Json) -> Json {
	let mut read: HashMap<&str, Vec<Json>> = TYPES.iter().map(|t| (*t, Vec::new())).collect();
	let mut missing: Vec<Json> = Vec::new();
	let mut space_of: HashMap<String, Space> = HashMap::new();
	let got = futures_join(regions.entries().iter().map(|(region, space)| async move {
		let mut got = Vec::new();
		for t in TYPES { got.push(all(space, t).await?); }
		Ok::<_, mmo_engine::space::Error>((region.clone(), space.clone(), got))
	}).collect()).await;
	for (i, r) in got.into_iter().enumerate() {
		match r {
			Ok((_, space, got)) => {
				for c in &got[1] { space_of.insert(js_string(j::at(c, "charId")), space.clone()); }
				for (t, rows) in TYPES.iter().zip(got) { read.get_mut(t).expect("type").extend(rows); }
			}
			Err(_) => missing.push(Json::from(regions.entries()[i].0.as_str())),
		}
	}
	let ai: HashSet<String> = j::a(w, "npcs").iter().filter(|n| j::truthy(j::at(n, "model"))).map(|n| format!("npc-{}", j::s(n, "npcId"))).collect();
	let mut accounts: HashMap<String, Json> = HashMap::new();
	for a in &read["Account"] { accounts.insert(j::s(a, "accountId").to_owned(), a.clone()); }
	let kind_of = |c: &Json| -> Option<&'static str> {
		let a = accounts.get(j::s(c, "accountId"))?;
		let cid = j::s(c, "charId");
		if j::truthy(j::at(a, "settler")) || cid.starts_with("npc-siedler-") { return Some("settler"); }
		if ai.contains(cid) { return Some("ai"); }
		if j::truthy(j::at(a, "npc")) || cid.starts_with("npc-") { None } else { Some("player") }
	};
	let mut chars: OMap<(Json, &'static str)> = OMap::default();
	for c in &read["Character"] { if let Some(k) = kind_of(c) { chars.set(j::s(c, "charId"), (c.clone(), k)); } }
	let live: HashSet<String> = read["Session"].iter().map(|s| js_string(j::at(s, "charId"))).collect();
	let all_rooms = j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms"));
	let rooms: HashMap<&str, &Json> = all_rooms.iter().map(|r| (j::s(r, "roomId"), r)).collect();
	let mut pieces: HashMap<String, (f64, HashSet<String>)> = HashMap::new();
	for c in &read["Contribution"] { let p = pieces.entry(j::s(c, "charId").to_owned()).or_default(); p.0 += j::n(c, "pieces"); p.1.insert(js_string(j::at(c, "beaconId"))); }
	let mut parks: HashMap<String, f64> = HashMap::new();
	for p in &read["ParkCare"] { *parks.entry(j::s(p, "accountId").to_owned()).or_insert(0.0) += j::number(j::at(p, "points")); }
	let mut deeds: HashMap<String, f64> = HashMap::new();
	for d in &read["Deed"] { *deeds.entry(j::s(d, "accountId").to_owned()).or_insert(0.0) += j::number(j::at(d, "points")); }
	let mut trips: HashMap<String, Vec<f64>> = HashMap::new();
	let mut total = no_trips();
	for t in &read["Travel"] {
		let cid = j::s(t, "charId");
		if !chars.has(cid) { continue; }
		let mine = trips.entry(cid.to_owned()).or_insert_with(no_trips);
		for (i, k) in TRIPS.iter().enumerate() { let v = j::no(t, k).unwrap_or(0.0); mine[i] += v; total[i] += v; }
	}
	let owned = |rows: &[Json]| { let mut m: HashMap<String, f64> = HashMap::new(); for r in rows { *m.entry(j::s(r, "accountId").to_owned()).or_insert(0.0) += 1.0; } m };
	let (buildings, beds, flds) = (&read["Building"], &read["Bed"], &read["Field"]);
	let (own_b, own_beds, own_f) = (owned(buildings), owned(beds), owned(flds));
	let mut own_plans: HashMap<String, OMap<f64>> = HashMap::new();
	for b in buildings { count_of(own_plans.entry(j::s(b, "accountId").to_owned()).or_default(), j::s(b, "plan"), 1.0); }
	let hut_plan = j::so(j::at(w, "settlement"), "plan");
	let settlements: Vec<(&Json, HashSet<String>)> = read["Settlement"].iter().map(|s| (s, buildings.iter().filter(|b| Some(j::s(b, "plan")) == hut_plan && j::at(b, "room") == j::at(s, "room")).map(|b| j::s(b, "accountId").to_owned()).collect())).collect();
	let ranks_of = |a: &Json| -> Json {
		let aid = j::s(a, "accountId");
		let mut out: Vec<Json> = settlements.iter().filter_map(|(s, huts)| {
			let r = if huts.contains(aid) { Some("siedler".to_owned()) } else { j::a(s, "members").iter().find(|m| j::s(m, "accountId") == aid).and_then(|m| j::so(m, "rank")).map(str::to_owned) };
			let rank = if r.as_deref() == Some("siedler") && j::truthy(j::at(a, "guest")) { Some("helfer".to_owned()) } else { r };
			rank.filter(|r| !r.is_empty()).map(|rank| obj! { "settlement" => j::at(s, "name").clone(), "rank" => rank, "founder" => j::s(s, "founder") == aid })
		}).collect();
		out.sort_by(|x, y| (j::s(y, "rank") == "siedler").cmp(&(j::s(x, "rank") == "siedler")).then_with(|| de(j::s(x, "settlement"), j::s(y, "settlement"))));
		Json::Array(out)
	};
	let plan_name = |key: &str| j::a(j::at(w, "building"), "plans").iter().find(|p| j::s(p, "key") == key).map_or_else(|| key.to_owned(), |p| j::s(p, "name").to_owned());
	// the pack of each figure listed, read where it stands
	let ids: Vec<String> = chars.keys().map(str::to_owned).collect();
	let packs_got = futures_join(ids.iter().map(|cid| { let space = space_of.get(cid).cloned(); let cid = cid.clone(); async move {
		let space = space?;
		let items = space.read_all(&tmpl("Item", obj! { "location" => cid.as_str() }), None).await.ok()?;
		let mut n: OMap<f64> = OMap::default();
		for e in items { count_of(&mut n, &js_string(j::at(fields(&e), "name")), 1.0); }
		let mut list: Vec<(String, f64)> = n.iter().map(|(k, v)| (k.to_owned(), *v)).collect();
		list.sort_by(|x, y| y.1.total_cmp(&x.1).then_with(|| de(&x.0, &y.0)));
		Some((cid, Json::Array(list.into_iter().map(|(name, count)| obj! { "name" => name, "count" => count }).collect())))
	} }).collect()).await;
	let packs: HashMap<String, Json> = packs_got.into_iter().flatten().collect();
	let mut list: Vec<Json> = chars.values().map(|(c, kind)| {
		let a = &accounts[j::s(c, "accountId")];
		let cid = j::s(c, "charId");
		let room = rooms.get(j::s(c, "room"));
		let p = pieces.get(cid);
		let guest = j::truthy(j::at(a, "guest"));
		let since = if guest { j::at(a, "createdAt").clone() } else { j::opt(a, "registeredAt").cloned().unwrap_or_else(|| j::at(a, "createdAt").clone()) };
		let at = if j::truthy(j::at(c, "aboard")) { obj! { "aboard" => true } } else {
			obj! { "room" => j::at(c, "room").clone(), "roomName" => room.map_or_else(|| j::at(c, "room").clone(), |r| j::at(r, "name").clone()), "island" => room.and_then(|r| j::opt(r, "island")).cloned().unwrap_or(Json::Null), "x" => j::at(c, "x").clone(), "y" => j::at(c, "y").clone() }
		};
		let aid = j::s(c, "accountId");
		let mut plans: Vec<(String, f64)> = own_plans.get(aid).map(|m| m.iter().map(|(k, v)| (k.to_owned(), *v)).collect()).unwrap_or_default();
		plans.sort_by(|x, y| y.1.total_cmp(&x.1));
		obj! {
			"charId" => cid, "name" => j::at(c, "name").clone(), "kind" => *kind, "guest" => j::at(a, "guest").clone(), "online" => live.contains(cid), "since" => since, "at" => at,
			"reputation" => obj! { "pieces" => p.map_or(0.0, |p| p.0), "beacons" => p.map_or(0.0, |p| p.1.len() as f64), "parks" => parks.get(aid).copied().unwrap_or(0.0), "deeds" => deeds.get(aid).copied().unwrap_or(0.0) },
			"trips" => trips_json(trips.get(cid).map_or(&no_trips()[..], |t| &t[..])),
			"ranks" => ranks_of(a),
			"owns" => obj! { "buildings" => own_b.get(aid).copied().unwrap_or(0.0), "beds" => own_beds.get(aid).copied().unwrap_or(0.0), "fields" => own_f.get(aid).copied().unwrap_or(0.0),
				"plans" => Json::Array(plans.into_iter().map(|(plan, count)| obj! { "plan" => plan.as_str(), "name" => plan_name(&plan), "count" => count }).collect()),
				"carries" => packs.get(cid).cloned().unwrap_or(Json::Array(vec![])) }
		}
	}).collect();
	let order = |k: &str| match k { "player" => 0, "settler" => 1, _ => 2 };
	list.sort_by(|x, y| order(j::s(x, "kind")).cmp(&order(j::s(y, "kind"))).then_with(|| j::truthy(j::at(y, "online")).cmp(&j::truthy(j::at(x, "online")))).then_with(|| j::truthy(j::at(x, "guest")).cmp(&j::truthy(j::at(y, "guest")))).then_with(|| de(j::s(x, "name"), j::s(y, "name"))));
	let people: Vec<&Json> = list.iter().filter(|p| j::s(p, "kind") == "player").collect();
	let mut by_plan: OMap<f64> = OMap::default();
	for b in buildings { count_of(&mut by_plan, j::s(b, "plan"), 1.0); }
	let mut bp: Vec<(String, f64)> = by_plan.iter().map(|(k, v)| (k.to_owned(), *v)).collect();
	bp.sort_by(|x, y| y.1.total_cmp(&x.1));
	let settlement_ids: HashSet<String> = read["Settlement"].iter().map(|s| js_string(j::at(s, "settlementId"))).collect();
	let n = |f: &dyn Fn(&&Json) -> bool| people.iter().filter(|p| f(p)).count() as f64;
	obj! {
		"at" => time_now(),
		"players" => obj! { "total" => people.len() as f64, "registered" => n(&|p| !j::truthy(j::at(p, "guest"))), "guests" => n(&|p| j::truthy(j::at(p, "guest"))), "online" => n(&|p| j::truthy(j::at(p, "online"))),
			"settlers" => list.iter().filter(|p| j::s(p, "kind") == "settler").count() as f64, "ai" => list.iter().filter(|p| j::s(p, "kind") == "ai").count() as f64 },
		"trips" => trips_json(&total),
		"buildings" => obj! { "total" => buildings.len() as f64, "houses" => by_plan.get("huette").copied().unwrap_or(0.0), "byPlan" => Json::Array(bp.into_iter().map(|(plan, count)| obj! { "plan" => plan.as_str(), "name" => plan_name(&plan), "count" => count }).collect()) },
		"beds" => beds.len() as f64, "fields" => flds.len() as f64, "sites" => read["Site"].len() as f64,
		"settlements" => settlement_ids.len() as f64,
		"list" => Json::Array(list), "missing" => Json::Array(missing)
	}
}

/// All the futures at once on this thread, their results in order.
async fn futures_join<F: std::future::Future>(fs: Vec<F>) -> Vec<F::Output> {
	let hs: Vec<_> = fs.into_iter().map(|f| Box::pin(f)).collect();
	let mut out = Vec::with_capacity(hs.len());
	let mut pending: Vec<_> = hs.into_iter().map(Some).collect();
	let mut done: Vec<Option<F::Output>> = (0..pending.len()).map(|_| None).collect();
	std::future::poll_fn(|cx| {
		let mut all = true;
		for (i, p) in pending.iter_mut().enumerate() {
			if let Some(f) = p {
				match f.as_mut().poll(cx) { std::task::Poll::Ready(v) => { done[i] = Some(v); *p = None; } std::task::Poll::Pending => all = false }
			}
		}
		if all { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
	}).await;
	for d in done { out.push(d.expect("done")); }
	out
}

fn js_string(v: &Json) -> String { match v { Json::String(s) => s.clone(), Json::Number(n) => js::number_text(*n), Json::Null => "null".into(), o => o.to_json_text() } }

/// The statistics, read at most every 20 s.
pub struct StatsCache { regions: Rc<RegionSpaces>, w: Rc<Json>, last: RefCell<Option<(f64, Json)>>, loading: RefCell<Option<Rc<tokio::sync::OnceCell<Json>>>> }
impl StatsCache {
	pub fn new(regions: Rc<RegionSpaces>, w: Rc<Json>) -> Self { Self { regions, w, last: RefCell::new(None), loading: RefCell::new(None) } }
	pub async fn get(&self) -> Json {
		if let Some((at, v)) = self.last.borrow().as_ref() { if time_now() - at <= 20_000.0 { return v.clone(); } }
		let cell = { let mut l = self.loading.borrow_mut(); l.get_or_insert_with(|| Rc::new(tokio::sync::OnceCell::new())).clone() };
		let at = time_now();
		let v = cell.get_or_init(|| collect_stats(&self.regions, &self.w)).await.clone();
		*self.loading.borrow_mut() = None;
		*self.last.borrow_mut() = Some((at, v.clone()));
		v
	}
}
