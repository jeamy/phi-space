//! Regions (`server/engine/regions.ts`, docs/welt-aufteilen.en.md): the world split into spaces, each a group of
//! islands with its own world worker. A ferry to an island of another region hands the character over (handover.rs).
//! Without `regions` in the world definition the whole world is one region, "world". The start-up's parts (checking the
//! regions, their addresses) are the world host's, not here.
use phi_json::{obj, Json};

use crate::j;
use crate::space::{Error, Result};

/// `WHOLE`: the region of a world that has none.
pub const WHOLE: &str = "world";

/// `regionsOf`: the regions the world defines; without them one, the whole world.
pub fn regions_of(w: &Json) -> Vec<Json> {
	if let Some(r) = j::ao(w, "regions").filter(|r| !r.is_empty()) { return r.to_vec(); }
	let mut islands: Vec<Json> = Vec::new();
	for r in j::a(w, "rooms") {
		let i = Json::from(j::so(r, "island").unwrap_or(""));
		if !islands.contains(&i) { islands.push(i); }
	}
	vec![obj! { "regionId" => WHOLE, "islands" => Json::Array(islands), "start" => j::at(w, "start").clone() }]
}

/// `regionOfRoom`: the region a room lies in, or None for a room the definition does not know.
pub fn region_of_room(w: &Json, room_id: &str) -> Option<String> {
	let room = j::by(j::a(w, "rooms"), "roomId", room_id)?;
	let island = Json::from(j::so(room, "island").unwrap_or(""));
	regions_of(w).into_iter().find(|g| j::a(g, "islands").contains(&island)).map(|g| j::s(&g, "regionId").to_owned())
}

/// `regionWorld`: the part of the world one region's processes run (its rooms, the exits leaving them, its things,
/// fires, tides, storms, markets and boards); `allRooms` and `allBeacons` are the whole world's.
pub fn region_world(w: &Json, region_id: &str) -> Result<Json> {
	let regions = regions_of(w);
	let Some(region) = regions.iter().find(|g| j::s(g, "regionId") == region_id) else {
		let ids: Vec<&str> = regions.iter().map(|g| j::s(g, "regionId")).collect();
		return Err(Error::Other(format!("the world {} has no region {region_id} (it has {})", j::s(w, "id"), ids.join(", "))));
	};
	let islands = j::a(region, "islands");
	let rooms: Vec<Json> = j::a(w, "rooms").iter().filter(|r| islands.contains(&Json::from(j::so(r, "island").unwrap_or("")))).cloned().collect();
	let here: Vec<&str> = rooms.iter().map(|r| j::s(r, "roomId")).collect();
	let in_here = |room: &str| here.contains(&room);
	let by_room = |list: &[Json]| Json::Array(list.iter().filter(|x| in_here(j::s(x, "room"))).cloned().collect());
	let ids_here = |list: &[Json]| Json::Array(list.iter().filter(|x| x.as_str().is_some_and(in_here)).cloned().collect());
	let mut out = j::object(w);
	out.insert("region", Json::from(region_id));
	out.insert("allRooms", j::at(w, "rooms").clone());
	out.insert("allBeacons", j::at(w, "beacons").clone());
	out.insert("start", j::at(region, "start").clone());
	out.insert("exits", by_room(j::a(w, "exits")));
	out.insert("objects", by_room(j::a(w, "objects")));
	out.insert("beacons", by_room(j::a(w, "beacons")));
	if let Some(sc) = j::ao(w, "scenery") { out.insert("scenery", by_room(sc)); }
	let mut flood = j::object(j::at(w, "flood"));
	flood.insert("rooms", by_room(j::a(j::at(w, "flood"), "rooms")));
	out.insert("flood", Json::Object(flood));
	if let Some(storm) = j::opt(w, "storm").filter(|s| j::truthy(s)) {
		let mut s = j::object(storm);
		s.insert("rooms", ids_here(j::a(storm, "rooms")));
		out.insert("storm", Json::Object(s));
	}
	let mut market = j::object(j::at(w, "market"));
	market.insert("rooms", ids_here(j::a(j::at(w, "market"), "rooms")));
	out.insert("market", Json::Object(market));
	let orders = j::at(w, "orders");
	let mut o = j::object(orders);
	o.insert("rooms", ids_here(j::a(orders, "rooms")));
	o.insert("kinds", Json::Array(j::a(orders, "kinds").iter().filter(|k| j::ao(k, "rooms").is_none_or(|r| r.iter().any(|x| x.as_str().is_some_and(in_here)))).cloned().collect()));
	out.insert("orders", Json::Object(o));
	out.insert("rooms", Json::Array(rooms.clone()));
	Ok(Json::Object(out))
}
