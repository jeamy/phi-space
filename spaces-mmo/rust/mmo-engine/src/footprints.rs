//! The occupancy of a room from the objects' footprints (`shared/footprints.ts`; docs/3d-welt-und-raster-plan-2026-11-21.en.md
//! section 3, "Occupancy"): per cell the object on it and what it does there, in the form of the shared grid (index
//! y·w + x). The game reads the objects' Footprint entries (`footprint_occupancy`); the objects' own rectangles give the
//! same (`occupancy_of`), and every walk compares the two; the migration compares the legacy plots in the same way.
use std::collections::HashMap;

use phi_json::Json;

use crate::j;

/// A step onto the cell is refused.
pub const MOVE: u8 = 1;
/// Nothing is built on the cell.
pub const BUILD: u8 = 2;
/// The cell counts for the growth share where it is land.
pub const SHARE: u8 = 4;

/// `FOOTPRINTS`: the objects that stand on cells of their own, with the field that names them.
pub const FOOTPRINTS: [(&str, &str); 7] = [("Site", "buildId"), ("Building", "buildId"), ("Ruin", "buildId"), ("Bed", "bedId"), ("Field", "fieldId"), ("Tree", "treeId"), ("Scenery", "sceneryId")];

/// A cell a second object claims (the first keeps it).
#[derive(Debug, Clone, PartialEq)]
pub struct Overlap { pub x: f64, pub y: f64, pub first: String, pub second: String }
/// A cell of an object beyond the room.
#[derive(Debug, Clone, PartialEq)]
pub struct Outside { pub x: f64, pub y: f64, pub id: String }

/// `Occupancy`: `at[y·w + x]` the index of the object in `ids` (-1: none), `flags` its MOVE, BUILD and SHARE.
#[derive(Debug, Clone)]
pub struct Occupancy { pub w: usize, pub h: usize, pub ids: Vec<String>, pub at: Vec<i32>, pub flags: Vec<u8>, pub overlaps: Vec<Overlap>, pub outside: Vec<Outside>, index: HashMap<String, i32> }

fn type_of(e: &Json, t: &str) -> bool { j::s(e, "type") == t || j::a(e, "types").iter().any(|x| x.as_str() == Some(t)) }
fn num(f: &Json, k: &str, d: f64) -> f64 { j::no(f, k).unwrap_or(d) }
fn id_text(v: &Json) -> String { match v { Json::String(s) => s.clone(), Json::Null => "undefined".into(), other => other.to_json_text() } }

impl Occupancy {
	fn new(w: usize, h: usize) -> Self { Occupancy { w, h, ids: Vec::new(), at: vec![-1; w * h], flags: vec![0; w * h], overlaps: Vec::new(), outside: Vec::new(), index: HashMap::new() } }

	fn claim(&mut self, id: &str, x: f64, y: f64, flags: u8) {
		if !(x >= 0.0 && y >= 0.0 && x < self.w as f64 && y < self.h as f64 && x.fract() == 0.0 && y.fract() == 0.0) { self.outside.push(Outside { x, y, id: id.to_owned() }); return; }
		let i = y as usize * self.w + x as usize;
		let k = match self.index.get(id) { Some(k) => *k, None => { self.ids.push(id.to_owned()); let k = self.ids.len() as i32 - 1; self.index.insert(id.to_owned(), k); k } };
		if self.at[i] != -1 && self.ids[self.at[i] as usize] != id { self.overlaps.push(Overlap { x, y, first: self.ids[self.at[i] as usize].clone(), second: id.to_owned() }); self.flags[i] |= flags; return; }
		self.at[i] = k;
		self.flags[i] |= flags;
	}

	fn rect(&mut self, id: &str, f: &Json, flags: u8) {
		let (x0, y0, fw, fh) = (num(f, "x", f64::NAN), num(f, "y", f64::NAN), num(f, "w", 1.0), num(f, "h", 1.0));
		let mut y = y0;
		while y < y0 + fh { let mut x = x0; while x < x0 + fw { self.claim(id, x, y, flags); x += 1.0; } y += 1.0; }
	}

	/// The object on cell (x, y), if any.
	pub fn id_at(&self, x: usize, y: usize) -> Option<&str> { let k = self.at[y * self.w + x]; (k >= 0).then(|| self.ids[k as usize].as_str()) }
}

/// `occupancyOf`: the occupancy of a room of `w` × `h` from its entries (whole entries: type, types, fields).
pub fn occupancy_of<'a>(w: usize, h: usize, entries: impl IntoIterator<Item = &'a Json>) -> Occupancy {
	let mut o = Occupancy::new(w, h);
	for e in entries {
		let f = j::at(e, "fields");
		if let Some((kind, key)) = FOOTPRINTS.iter().find(|(t, _)| type_of(e, t)) {
			if *kind == "Scenery" && j::b(f, "through") { continue; }
			o.rect(&id_text(j::at(f, key)), f, MOVE | BUILD | SHARE);
		} else if type_of(e, "Beacon") {
			o.rect(&id_text(j::at(f, "beaconId")), f, MOVE | BUILD);
		}
	}
	o
}

/// `footprintOccupancy`: the same from a room's Footprint entries and Beacons.
pub fn footprint_occupancy<'a>(w: usize, h: usize, entries: impl IntoIterator<Item = &'a Json>) -> Occupancy {
	let mut o = Occupancy::new(w, h);
	for e in entries {
		let f = j::at(e, "fields");
		if type_of(e, "Footprint") { o.rect(&id_text(j::at(f, "of")), f, MOVE | BUILD | SHARE); }
		else if type_of(e, "Beacon") { o.claim(&id_text(j::at(f, "beaconId")), num(f, "x", f64::NAN), num(f, "y", f64::NAN), MOVE | BUILD); }
	}
	o
}

/// `plotOccupancy`: the same from a room's Plot entries and Beacons.
pub fn plot_occupancy<'a>(w: usize, h: usize, entries: impl IntoIterator<Item = &'a Json>) -> Occupancy {
	let mut o = Occupancy::new(w, h);
	for e in entries {
		let f = j::at(e, "fields");
		if type_of(e, "Plot") { o.claim(&id_text(j::at(f, "of")), num(f, "x", f64::NAN), num(f, "y", f64::NAN), MOVE | BUILD | SHARE); }
		else if type_of(e, "Beacon") { o.claim(&id_text(j::at(f, "beaconId")), num(f, "x", f64::NAN), num(f, "y", f64::NAN), MOVE | BUILD); }
	}
	o
}

/// `occupancyId`: the ID an occupancy gives an entry (its object's, `of` for a plot, the fire's), if any.
pub fn occupancy_id(e: &Json) -> Option<String> {
	let f = j::at(e, "fields");
	if type_of(e, "Plot") || type_of(e, "Footprint") { return Some(id_text(j::at(f, "of"))); }
	if type_of(e, "Beacon") { return Some(id_text(j::at(f, "beaconId"))); }
	FOOTPRINTS.iter().find(|(t, _)| type_of(e, t)).map(|(_, k)| id_text(j::at(f, k)))
}

/// `occupancyReport`: what differs in a room, as lines (the same text as the TypeScript); `skip`: objects whose
/// differences are left out, with the cells of their overlaps.
pub fn occupancy_report(room: &str, plots: &Occupancy, footprints: &Occupancy, skip: &dyn Fn(&str) -> bool, kept: &str) -> Vec<String> {
	let t = phi_json::number_text;
	let any = |ids: &[Option<&str>]| ids.iter().any(|id| id.is_some_and(skip));
	let passed: std::collections::HashSet<usize> = plots.overlaps.iter().chain(&footprints.overlaps).filter(|c| any(&[Some(&c.first), Some(&c.second)])).map(|c| c.y as usize * plots.w + c.x as usize).collect();
	let mut out = Vec::new();
	for c in plots.overlaps.iter().filter(|c| !any(&[Some(&c.first), Some(&c.second)])) { out.push(format!("{room} {},{}: {kept} of {} and {}", t(c.x), t(c.y), c.first, c.second)); }
	for c in plots.outside.iter().filter(|c| !any(&[Some(&c.id)])) { out.push(format!("{room} {},{}: {kept} of {} outside the room", t(c.x), t(c.y), c.id)); }
	for c in footprints.overlaps.iter().filter(|c| !any(&[Some(&c.first), Some(&c.second)])) { out.push(format!("{room} {},{}: objects {} and {} overlap", t(c.x), t(c.y), c.first, c.second)); }
	for c in footprints.outside.iter().filter(|c| !any(&[Some(&c.id)])) { out.push(format!("{room} {},{}: object {} reaches outside the room", t(c.x), t(c.y), c.id)); }
	for i in 0..plots.at.len() {
		let (a, b) = (plots.id_at(i % plots.w, i / plots.w), footprints.id_at(i % plots.w, i / plots.w));
		if (a != b || plots.flags[i] != footprints.flags[i]) && !any(&[a, b]) && !passed.contains(&i) {
			let flags = if a == b { format!(" (flags {} and {})", plots.flags[i], footprints.flags[i]) } else { String::new() };
			out.push(format!("{room} {},{}: {kept} say {}, objects {}{flags}", i % plots.w, i / plots.w, a.unwrap_or("nothing"), b.unwrap_or("nothing")));
		}
	}
	out
}

/// `storeOccupancyReport`: every room's Footprint entries (`against_plots`: its legacy plots) against its objects over a
/// whole store's entries (`rooms_required`: a room without its Room entry is reported, else compared on a grid as large
/// as what lies in it); an object with a second Footprint entry is reported first.
pub fn store_occupancy_report(entries: &[Json], rooms_required: bool, skip: &dyn Fn(&str) -> bool, against_plots: bool) -> Vec<String> {
	let kept = if against_plots { "Plot" } else { "Footprint" };
	let mut size: HashMap<String, (usize, usize)> = HashMap::new();
	let mut rooms: Vec<(String, Vec<&Json>)> = Vec::new();
	for e in entries {
		let f = j::at(e, "fields");
		if type_of(e, "Room") {
			let g = j::a(f, "ground");
			size.insert(id_text(j::at(f, "roomId")), (g.first().and_then(Json::as_str).map_or(0, |r| r.encode_utf16().count()), g.len()));
			continue;
		}
		if !type_of(e, kept) && !type_of(e, "Beacon") && !FOOTPRINTS.iter().any(|(t, _)| type_of(e, t)) { continue; }
		let room = id_text(j::at(f, "room"));
		match rooms.iter_mut().find(|(r, _)| *r == room) { Some((_, l)) => l.push(e), None => rooms.push((room, vec![e])) }
	}
	rooms.sort_by(|a, b| a.0.cmp(&b.0));
	let mut out = Vec::new();
	if !against_plots {
		let mut seen: Vec<(String, usize)> = Vec::new();
		for e in entries.iter().filter(|e| type_of(e, "Footprint")) {
			let f = j::at(e, "fields");
			let k = format!("{} {}", id_text(j::at(f, "room")), id_text(j::at(f, "of")));
			match seen.iter_mut().find(|(x, _)| *x == k) { Some(s) => s.1 += 1, None => seen.push((k, 1)) }
		}
		seen.sort_by(|a, b| a.0.cmp(&b.0));
		for (k, n) in seen { if n > 1 && !skip(&k[k.find(' ').map_or(0, |i| i + 1)..]) { out.push(format!("{k}: {n} footprint entries")); } }
	}
	for (room, list) in &rooms {
		let s = match size.get(room) {
			Some(s) => *s,
			None if rooms_required => { out.push(format!("{room}: occupied cells in a room that is not there")); continue; }
			None => list.iter().fold((0, 0), |(w, h), e| { let f = j::at(e, "fields"); ((w as f64).max(num(f, "x", 0.0) + num(f, "w", 1.0)) as usize, (h as f64).max(num(f, "y", 0.0) + num(f, "h", 1.0)) as usize) }),
		};
		let kept_occ = if against_plots { plot_occupancy(s.0, s.1, list.iter().copied()) } else { footprint_occupancy(s.0, s.1, list.iter().copied()) };
		out.extend(occupancy_report(room, &kept_occ, &occupancy_of(s.0, s.1, list.iter().copied()), skip, if against_plots { "plots" } else { "footprint entries" }));
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;
	use phi_json::obj;

	fn entry(t: &str, fields: Json) -> Json { obj! { "type" => t, "types" => Json::Array(vec![Json::from(t)]), "fields" => fields } }

	#[test]
	fn footprints_give_the_plots_occupancy_and_differences_are_named() {
		let hut = entry("Building", obj! { "buildId" => "h", "room" => "r", "x" => 1, "y" => 1, "w" => 2, "h" => 2 });
		let through = entry("Scenery", obj! { "sceneryId" => "s", "room" => "r", "x" => 0, "y" => 0, "w" => 1, "h" => 1, "through" => true });
		let fire = entry("Beacon", obj! { "beaconId" => "f", "room" => "r", "x" => 4, "y" => 0 });
		let room = entry("Room", obj! { "roomId" => "r", "ground" => Json::Array(vec![Json::from("......"), Json::from("......"), Json::from("......")]) });
		let mut all = vec![room.clone(), hut, through, fire];
		for (x, y) in [(1, 1), (2, 1), (1, 2), (2, 2)] { all.push(entry("Plot", obj! { "room" => "r", "x" => x, "y" => y, "of" => "h" })); }
		assert!(store_occupancy_report(&all, true, &|_| false, true).is_empty());
		let o = occupancy_of(6, 3, all.iter());
		assert_eq!((o.id_at(1, 1), o.flags[7], o.id_at(4, 0), o.flags[4], o.id_at(0, 0)), (Some("h"), MOVE | BUILD | SHARE, Some("f"), MOVE | BUILD, None));
		all.pop();
		all.push(entry("Plot", obj! { "room" => "r", "x" => 5, "y" => 2, "of" => "gone" }));
		assert_eq!(store_occupancy_report(&all, true, &|_| false, true), vec!["r 2,2: plots say nothing, objects h", "r 5,2: plots say gone, objects nothing"]);
	}

	#[test]
	fn footprint_entries_give_the_objects_occupancy_and_differences_are_named() {
		let room = entry("Room", obj! { "roomId" => "r", "ground" => Json::Array(vec![Json::from("......"), Json::from("......"), Json::from("......")]) });
		let hut = entry("Building", obj! { "buildId" => "h", "room" => "r", "x" => 1, "y" => 1, "w" => 2, "h" => 2 });
		let fire = entry("Beacon", obj! { "beaconId" => "f", "room" => "r", "x" => 4, "y" => 0 });
		let print = |of: &str, x: f64, y: f64, w: f64, h: f64| entry("Footprint", obj! { "room" => "r", "of" => of, "x" => x, "y" => y, "w" => w, "h" => h });
		assert!(store_occupancy_report(&[room.clone(), hut.clone(), fire.clone(), print("h", 1.0, 1.0, 2.0, 2.0)], true, &|_| false, false).is_empty());
		assert_eq!(store_occupancy_report(&[room, hut, fire, print("h", 1.0, 1.0, 2.0, 1.0), print("old", 4.0, 2.0, 1.0, 1.0), print("x", 2.0, 2.0, 1.0, 1.0)], true, &|_| false, false), vec![
			"r 1,2: footprint entries say nothing, objects h",
			"r 2,2: footprint entries say x, objects h",
			"r 4,2: footprint entries say old, objects nothing",
		]);
	}

	#[test]
	fn overlaps_a_footprint_beyond_the_room_and_a_missing_room_are_reported() {
		let all = vec![
			entry("Room", obj! { "roomId" => "r", "ground" => Json::Array(vec![Json::from("...."), Json::from("....")]) }),
			entry("Bed", obj! { "bedId" => "a", "room" => "r", "x" => 0, "y" => 0, "w" => 2, "h" => 1 }),
			entry("Tree", obj! { "treeId" => "t", "room" => "r", "x" => 1, "y" => 0, "w" => 1, "h" => 1 }),
			entry("Field", obj! { "fieldId" => "f", "room" => "r", "x" => 3, "y" => 1, "w" => 2, "h" => 1 }),
			entry("Ruin", obj! { "buildId" => "x", "room" => "elsewhere", "x" => 0, "y" => 0, "w" => 1, "h" => 1 }),
		];
		assert_eq!(store_occupancy_report(&all, true, &|_| false, false), vec![
			"elsewhere: occupied cells in a room that is not there",
			"r 1,0: objects a and t overlap",
			"r 4,1: object f reaches outside the room",
			"r 0,0: footprint entries say nothing, objects a",
			"r 1,0: footprint entries say nothing, objects a",
			"r 3,1: footprint entries say nothing, objects f",
		]);
		assert_eq!(store_occupancy_report(&all, false, &|_| false, false)[0], "elsewhere 0,0: footprint entries say nothing, objects x");
	}
}
