//! The large ship (`shared/liner.ts`): when it lies in a bay and where, a pure function of the world time. Only what the
//! commands ask is here; the ways over the map and the berths are the page's.
use phi_json::Json;

use crate::j;
use crate::js;

/// A bay the ship calls at.
#[derive(Clone, Debug)]
pub struct Stop { pub island: String, pub room: String, pub x: f64, pub y: f64 }
/// `Timetable`: `leg_ms[i]` is the time from stop i to the next; a loop is the stays and the legs.
#[derive(Clone, Debug)]
pub struct Timetable { pub stops: Vec<Stop>, pub stay_ms: f64, pub leg_ms: Vec<f64>, pub cycle_ms: f64 }
/// `ShipState`.
#[derive(Clone, Copy, Debug)]
pub struct ShipState { pub lies: Option<usize>, pub from: usize, pub to: usize, pub f: f64, pub left_ms: f64 }

/// `baysOf`: per island the first room with a spawn, in the order a Map keeps them.
pub fn bays_of(rooms: &[Json]) -> Vec<(String, &Json)> {
	let mut seen: Vec<(String, &Json)> = Vec::new();
	for r in rooms {
		let island = j::s(r, "island");
		if !island.is_empty() && j::truthy(j::at(r, "spawn")) && !seen.iter().any(|(i, _)| i == island) { seen.push((island.to_owned(), r)); }
	}
	seen
}

/// `timetable`: the bays round the middle of the map, so the legs do not cross; a leg takes `unitWorldMs` a cell.
pub fn timetable(rooms: &[Json], d: &Json) -> Option<Timetable> {
	let mapped: Vec<Json> = rooms.iter().filter(|r| j::truthy(j::at(r, "map"))).cloned().collect();
	let mut stops: Vec<Stop> = bays_of(&mapped).into_iter().map(|(island, r)| Stop { island, room: j::s(r, "roomId").to_owned(), x: j::n(j::at(r, "map"), "x"), y: j::n(j::at(r, "map"), "y") }).collect();
	if stops.len() < 2 { return None; }
	let n = stops.len() as f64;
	let cx = stops.iter().fold(0.0, |a, r| a + r.x) / n;
	let cy = stops.iter().fold(0.0, |a, r| a + r.y) / n;
	stops.sort_by(|a, b| {
		let d = (a.y - cy).atan2(a.x - cx) - (b.y - cy).atan2(b.x - cx);
		if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal) } else { js::locale_compare(&a.island, &b.island) }
	});
	let unit = j::n(d, "unitWorldMs");
	let stay = j::n(d, "stayWorldMs");
	let leg_ms: Vec<f64> = (0..stops.len()).map(|i| { let (a, b) = (&stops[i], &stops[(i + 1) % stops.len()]); (5.0 * 60_000.0f64).max(js::round((b.x - a.x).hypot(b.y - a.y) * unit)) }).collect();
	let cycle_ms = leg_ms.iter().fold(0.0, |a, l| a + stay + l);
	Some(Timetable { stops, stay_ms: stay, leg_ms, cycle_ms })
}

fn in_cycle(t: &Timetable, now: f64) -> f64 { ((now % t.cycle_ms) + t.cycle_ms) % t.cycle_ms }

/// `shipState`.
pub fn ship_state(t: &Timetable, now: f64) -> ShipState {
	let mut at = in_cycle(t, now);
	for i in 0..t.stops.len() {
		let next = (i + 1) % t.stops.len();
		if at < t.stay_ms { return ShipState { lies: Some(i), from: i, to: i, f: 0.0, left_ms: t.stay_ms - at }; }
		at -= t.stay_ms;
		if at < t.leg_ms[i] { return ShipState { lies: None, from: i, to: next, f: at / t.leg_ms[i], left_ms: t.leg_ms[i] - at }; }
		at -= t.leg_ms[i];
	}
	ShipState { lies: Some(0), from: 0, to: 0, f: 0.0, left_ms: t.stay_ms }
}

/// `shipComes`: time until the ship lies at stop `i` (0 while it lies there).
pub fn ship_comes(t: &Timetable, now: f64, i: usize) -> f64 {
	if ship_state(t, now).lies == Some(i) { return 0.0; }
	let start = (0..i).fold(0.0, |a, k| a + t.stay_ms + t.leg_ms[k]);
	(((start - in_cycle(t, now)) % t.cycle_ms) + t.cycle_ms) % t.cycle_ms
}

/// `nextStop`: the stop a passenger aboard can leave at next and how long until the ship lies there; None when it is
/// the destination itself.
pub fn next_stop(t: &Timetable, now: f64, from: Option<&str>, to: &str) -> Option<(usize, Stop, f64)> {
	let s = ship_state(t, now);
	let n = t.stops.len();
	let i = match s.lies { Some(l) => if Some(t.stops[l].room.as_str()) == from { (l + 1) % n } else { l }, None => s.to };
	let stop = t.stops[i].clone();
	if stop.room == to { None } else { Some((i, stop, ship_comes(t, now, i))) }
}

/// `linerOf`: the timetable of a world's line (its bays over all regions), or None.
pub fn liner_of(w: &Json) -> Option<Timetable> {
	let d = j::opt(w, "liner").filter(|d| j::truthy(d))?;
	timetable(j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms")), d)
}
