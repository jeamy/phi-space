//! A room's cells as one array (`shared/grid.ts`; docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3,
//! "Performance strategy"): index y·w + x instead of "x,y" strings, for searches over a room.

use phi_json::Json;

/// The four neighbours in the order every search takes them (right, left, down, up).
const NEAR: [(isize, isize); 4] = [(1, 0), (-1, 0), (0, 1), (0, -1)];

/// The open cells of a room of `w` × `h` (true: open).
pub struct Grid { pub w: usize, pub h: usize, pub open: Vec<bool> }

impl Grid {
	pub fn of(w: usize, h: usize, open: impl Fn(usize, usize) -> bool) -> Grid {
		let mut cells = vec![false; w * h];
		for y in 0..h { for x in 0..w { cells[y * w + x] = open(x, y); } }
		Grid { w, h, open: cells }
	}

	/// `components`: the connected parts of the open cells (four neighbours), a label per cell, the same for cells of one
	/// part, -1 for a closed cell; labels count from 0 in the order the parts are first met, row by row.
	pub fn components(&self) -> Vec<i32> {
		let n = self.open.len();
		let mut label = vec![-1i32; n];
		let mut queue = Vec::with_capacity(n);
		let mut next = 0;
		for first in 0..n {
			if !self.open[first] || label[first] != -1 { continue; }
			label[first] = next;
			queue.clear();
			queue.push(first);
			let mut head = 0;
			while head < queue.len() {
				let at = queue[head];
				head += 1;
				let x = at % self.w;
				let near = [(x + 1 < self.w).then(|| at + 1), (x > 0).then(|| at - 1), (at + self.w < n).then(|| at + self.w), at.checked_sub(self.w)];
				for m in near.into_iter().flatten() {
					if self.open[m] && label[m] == -1 { label[m] = next; queue.push(m); }
				}
			}
			next += 1;
		}
		label
	}

	/// `walkGrid`: the cells of a room one can walk on (`world::walkable`), as wide as the ground's first row.
	pub fn walk(w: &Json, ground: &[String]) -> Grid {
		let width = ground.first().map_or(0, |r| crate::js::len16(r));
		let tiles = crate::j::at(w, "tiles");
		let mut known: [Option<bool>; 128] = [None; 128];
		let mut open = vec![false; width * ground.len()];
		for (y, row) in ground.iter().enumerate() {
			if !row.is_ascii() {
				for x in 0..width { open[y * width + x] = crate::world::walkable(w, ground, x as f64, y as f64); }
				continue;
			}
			for (x, b) in row.bytes().take(width).enumerate() {
				let walk = *known[b as usize].get_or_insert_with(|| crate::j::b(crate::j::at(tiles, &(b as char).to_string()), "walk"));
				open[y * width + x] = walk;
			}
		}
		Grid { w: width, h: ground.len(), open }
	}

	/// `indexOf`: the index of the cell (x, y), or None when it lies outside or is not a whole cell.
	pub fn index_of(&self, c: (f64, f64)) -> Option<usize> {
		let (x, y) = c;
		if x.fract() != 0.0 || y.fract() != 0.0 || !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x >= self.w as f64 || y >= self.h as f64 { return None; }
		Some(y as usize * self.w + x as usize)
	}

	fn neighbour(&self, at: usize, (dx, dy): (isize, isize)) -> Option<usize> {
		let (x, y) = ((at % self.w) as isize + dx, (at / self.w) as isize + dy);
		(x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h).then(|| y as usize * self.w + x as usize)
	}
	fn cell(&self, at: usize) -> (f64, f64) { ((at % self.w) as f64, (at / self.w) as f64) }

	/// `closing`: the grid with the cells of `keys` ("x,y" as `occupancy::cell_key` writes them) closed; a key of no cell
	/// of the grid is left out. The occupied sets the callers keep become one mask per search this way.
	pub fn closing<'a>(mut self, keys: impl IntoIterator<Item = &'a String>) -> Grid {
		for k in keys {
			let Some((a, b)) = k.split_once(',') else { continue };
			let (x, y) = (crate::js::to_number(a), crate::js::to_number(b));
			if let Some(i) = self.index_of((x, y)) { if crate::occupancy::cell_key(x, y) == *k { self.open[i] = false; } }
		}
		self
	}

	/// `pathIn`: the shortest walk from `from` to `to` over open cells, at most `max` steps; the cells after the start, the
	/// target last; empty when they are the same cell, None when there is none. The start need not be open.
	pub fn path(&self, from: (f64, f64), to: (f64, f64), max: usize) -> Option<Vec<(f64, f64)>> {
		let goal = self.index_of(to).filter(|&g| self.open[g])?;
		if from == to { return Some(vec![]); }
		let start = self.index_of(from)?;
		let mut prev = vec![usize::MAX; self.w * self.h];
		prev[start] = start;
		let mut frontier = vec![start];
		let mut step = 0;
		while step < max && !frontier.is_empty() {
			let mut next = Vec::new();
			for &at in &frontier {
				for d in NEAR {
					let Some(k) = self.neighbour(at, d) else { continue };
					if prev[k] != usize::MAX || !self.open[k] { continue; }
					prev[k] = at;
					if k == goal {
						let mut path = Vec::new();
						let mut p = k;
						while p != start { path.push(self.cell(p)); p = prev[p]; }
						path.reverse();
						return Some(path);
					}
					next.push(k);
				}
			}
			frontier = next;
			step += 1;
		}
		None
	}

	/// `reachIn`: the cells reachable from `from` over open cells, `from` itself included whether open or not.
	pub fn reach(&self, from: (f64, f64)) -> Vec<bool> {
		let mut seen = vec![false; self.w * self.h];
		let Some(start) = self.index_of(from) else { return seen };
		seen[start] = true;
		let mut queue = vec![start];
		let mut i = 0;
		while i < queue.len() {
			let at = queue[i];
			i += 1;
			for d in NEAR { if let Some(k) = self.neighbour(at, d) { if !seen[k] && self.open[k] { seen[k] = true; queue.push(k); } } }
		}
		seen
	}
}


/// `nearestOpen`: the nearest cell to `at` (itself first) that is `open`, ring by ring over every cell of a room of
/// `size` (width, height), open or not, in the order of the four neighbours; None when there is none within `radius`.
/// Only the cells it reaches are looked at, marked by their index.
pub fn nearest_open(size: (usize, usize), at: (f64, f64), radius: usize, open: impl Fn((f64, f64)) -> bool) -> Option<(f64, f64)> {
	let g = Grid { w: size.0, h: size.1, open: Vec::new() };
	let mut seen: std::collections::HashSet<usize> = g.index_of(at).into_iter().collect();
	let mut ring = vec![at];
	let mut r = 0;
	while r <= radius && !ring.is_empty() {
		for c in &ring { if open(*c) { return Some(*c); } }
		let mut next = Vec::new();
		for c in &ring {
			for (dx, dy) in NEAR {
				let n = (c.0 + dx as f64, c.1 + dy as f64);
				if let Some(i) = g.index_of(n) { if seen.insert(i) { next.push(n); } }
			}
		}
		ring = next;
		r += 1;
	}
	None
}

#[cfg(test)]
mod tests {
	//! The searches on the grid against the searches over "x,y" strings they replaced (kept here as they were), over random
	//! rooms with obstacles, blocked cells outside the room, cut-offs at `max` and `radius`, blocked and unreachable
	//! targets and a start on its target (as tests/grid-search.test.ts does in TypeScript).
	use std::collections::{HashMap, HashSet};
	use super::*;
	use crate::occupancy::cell_key as key;
	use crate::world::walkable;

	const STEPS: [(f64, f64); 4] = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)];

	fn legacy_find_path(w: &Json, ground: &[String], from: (f64, f64), to: (f64, f64), max: usize, blocked: &HashSet<String>) -> Option<Vec<(f64, f64)>> {
		if !walkable(w, ground, to.0, to.1) || blocked.contains(&key(to.0, to.1)) { return None; }
		if from == to { return Some(vec![]); }
		let width = crate::js::len16(&ground[0]) as f64;
		let k = |x: f64, y: f64| y * width + x;
		let k0 = k(from.0, from.1);
		let mut prev: HashMap<u64, f64> = HashMap::from([(k0.to_bits(), -1.0)]);
		let mut frontier = vec![from];
		let mut step = 0;
		while step < max && !frontier.is_empty() {
			let mut next = Vec::new();
			for c in &frontier {
				for (dx, dy) in STEPS {
					let (x, y) = (c.0 + dx, c.1 + dy);
					let kk = k(x, y);
					if prev.contains_key(&(kk + 0.0).to_bits()) || !walkable(w, ground, x, y) || blocked.contains(&key(x, y)) { continue; }
					prev.insert((kk + 0.0).to_bits(), k(c.0, c.1));
					if x == to.0 && y == to.1 {
						let mut path = Vec::new();
						let mut at = kk;
						while at != k0 { path.insert(0, (at % width, (at / width).floor())); at = prev[&(at + 0.0).to_bits()]; }
						return Some(path);
					}
					next.push((x, y));
				}
			}
			frontier = next;
			step += 1;
		}
		None
	}

	fn legacy_reachable(w: &Json, ground: &[String], from: (f64, f64), blocked: &HashSet<String>) -> HashSet<String> {
		let mut seen: HashSet<String> = HashSet::from([key(from.0, from.1)]);
		let mut ring = vec![from];
		while !ring.is_empty() {
			let mut next = Vec::new();
			for c in &ring {
				for (dx, dy) in STEPS {
					let n = (c.0 + dx, c.1 + dy);
					let k = key(n.0, n.1);
					if seen.contains(&k) || blocked.contains(&k) || !walkable(w, ground, n.0, n.1) { continue; }
					seen.insert(k);
					next.push(n);
				}
			}
			ring = next;
		}
		seen
	}

	fn legacy_free_cell_near(w: &Json, ground: &[String], at: (f64, f64), avoid: &HashSet<String>, radius: usize) -> Option<(f64, f64)> {
		let mut seen: HashSet<String> = HashSet::from([key(at.0, at.1)]);
		let mut ring = vec![at];
		let width = ground.first().map_or(0, |r| crate::js::len16(r)) as f64;
		let mut r = 0;
		while r <= radius && !ring.is_empty() {
			for c in &ring { if walkable(w, ground, c.0, c.1) && !avoid.contains(&key(c.0, c.1)) { return Some(*c); } }
			let mut next = Vec::new();
			for c in &ring {
				for (dx, dy) in STEPS {
					let n = (c.0 + dx, c.1 + dy);
					let k = key(n.0, n.1);
					if !seen.contains(&k) && n.1 >= 0.0 && n.1 < ground.len() as f64 && n.0 >= 0.0 && n.0 < width { seen.insert(k); next.push(n); }
				}
			}
			ring = next;
			r += 1;
		}
		None
	}

	fn legacy_trace(w: &Json, ground: &[String], from: (f64, f64), to: &[(f64, f64)], blocked: &HashSet<String>) -> Option<Vec<(f64, f64)>> {
		let at_of = |x: f64, y: f64| ground.get(y as usize).map_or("", |r| crate::js::slice16(r, x as isize, Some(x as isize + 1)));
		let (h, wd) = (ground.len() as f64, ground.first().map_or(0, |r| crate::js::len16(r)) as f64);
		let goal: HashSet<String> = to.iter().map(|p| key(p.0, p.1)).collect();
		let mut dist: HashMap<String, f64> = HashMap::from([(key(from.0, from.1), 0.0)]);
		let mut before: HashMap<String, (String, (f64, f64))> = HashMap::new();
		let mut open: Vec<((f64, f64), f64)> = vec![(from, 0.0)];
		while !open.is_empty() {
			open.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
			let (c, d) = open.remove(0);
			let k = key(c.0, c.1);
			if d > dist.get(&k).copied().unwrap_or(f64::INFINITY) { continue; }
			if goal.contains(&k) {
				let mut out = vec![c];
				let mut at = k;
				while let Some((prev, cell)) = before.get(&at) { out.insert(0, *cell); at = prev.clone(); }
				return Some(out);
			}
			for (dx, dy) in STEPS {
				let n = (c.0 + dx, c.1 + dy);
				let nk = key(n.0, n.1);
				if n.0 < 0.0 || n.1 < 0.0 || n.0 >= wd || n.1 >= h || !walkable(w, ground, n.0, n.1) || blocked.contains(&nk) { continue; }
				let nd = d + if at_of(n.0, n.1) == ":" { 1.0 } else { 3.0 };
				if nd < dist.get(&nk).copied().unwrap_or(f64::INFINITY) { dist.insert(nk.clone(), nd); before.insert(nk, (k.clone(), c)); open.push((n, nd)); }
			}
		}
		None
	}

	struct Room { ground: Vec<String>, blocked: HashSet<String>, width: usize, height: usize }

	#[test]
	fn the_searches_on_the_grid_answer_as_over_strings() {
		let w = phi_json::parse(r##"{"tiles":{"~":{"walk":false},".":{"walk":true},",":{"walk":true},":":{"walk":true},"_":{"walk":true},"#":{"walk":false}}}"##).unwrap();
		let mut seed: u64 = 11;
		let mut rnd = move || { seed = (seed.wrapping_mul(1103515245).wrapping_add(12345)) % (1 << 31); seed as f64 / (1u64 << 31) as f64 };
		let (dry, wet) = ([".", ",", "_"], ["~", "#"]);
		let (mut found, mut cut, mut none, mut traced) = (0, 0, 0, 0);
		for n in 0..600 {
			let (width, height) = (3 + (rnd() * 40.0) as usize, 3 + (rnd() * 26.0) as usize);
			let (water, cobble) = (rnd() * 0.45, rnd() * 0.5);
			let mut rows: Vec<Vec<&str>> = (0..height).map(|_| (0..width).map(|_| if rnd() < water { wet[(rnd() * 2.0) as usize] } else if rnd() < cobble { ":" } else { dry[(rnd() * 3.0) as usize] }).collect()).collect();
			if rnd() < 0.3 { let x = (rnd() * width as f64) as usize; for row in rows.iter_mut() { row[x] = "~"; } }
			let mut blocked = HashSet::new();
			for _ in 0..((rnd() * (width * height) as f64 * 0.25) as usize) { blocked.insert(key((rnd() * (width + 4) as f64).floor() - 2.0, (rnd() * (height + 4) as f64).floor() - 2.0)); }
			let r = Room { ground: rows.iter().map(|r| r.concat()).collect(), blocked, width, height };
			let any = |rnd: &mut dyn FnMut() -> f64| ((rnd() * (r.width + 2) as f64).floor() - 1.0, (rnd() * (r.height + 2) as f64).floor() - 1.0);
			let inside = |rnd: &mut dyn FnMut() -> f64| ((rnd() * r.width as f64).floor(), (rnd() * r.height as f64).floor());
			// findPath
			let from = inside(&mut rnd);
			let to = if rnd() < 0.1 { from } else { any(&mut rnd) };
			let max = if rnd() < 0.3 { (rnd() * 12.0) as usize } else { 80 };
			let empty = HashSet::new();
			let blocked = if rnd() < 0.2 { &empty } else { &r.blocked };
			let before = legacy_find_path(&w, &r.ground, from, to, max, blocked);
			assert_eq!(crate::world::find_path(&w, &r.ground, from, to, max, blocked), before, "#{n} {from:?} -> {to:?} max {max}");
			if before.as_ref().is_some_and(|p| !p.is_empty()) { found += 1; }
			if before.is_none() && legacy_find_path(&w, &r.ground, from, to, 10_000, blocked).is_some() { cut += 1; }
			// the reach of a building check
			let start = inside(&mut rnd);
			let reach_before = legacy_reachable(&w, &r.ground, start, &r.blocked);
			let g = Grid::walk(&w, &r.ground).closing(&r.blocked);
			let reach = g.reach(start);
			for y in -1..=r.height as isize { for x in -1..=r.width as isize {
				let c = (x as f64, y as f64);
				assert_eq!(g.index_of(c).is_some_and(|i| reach[i]), reach_before.contains(&key(c.0, c.1)), "#{n} reach {c:?} from {start:?}");
			} }
			// freeCellNear
			let at = any(&mut rnd);
			let radius = if rnd() < 0.3 { (rnd() * 4.0) as usize } else { 8 };
			let near = legacy_free_cell_near(&w, &r.ground, at, &r.blocked, radius);
			assert_eq!(crate::occupancy::free_cell_near(&w, &r.ground, at, &|k| r.blocked.contains(k), radius), near, "#{n} near {at:?} radius {radius}");
			if near.is_none() { none += 1; }
			// the road's trace
			let goals: Vec<(f64, f64)> = (0..1 + (rnd() * 4.0) as usize).map(|_| any(&mut rnd)).collect();
			let t = legacy_trace(&w, &r.ground, start, &goals, &r.blocked);
			assert_eq!(crate::commands::road::trace(&w, &r.ground, start, &goals, &r.blocked), t, "#{n} trace {start:?} -> {goals:?}");
			if t.is_some() { traced += 1; }
		}
		assert!(found > 100 && cut > 10 && none > 10 && traced > 100, "{found} ways, {cut} cut off, {none} without a free cell, {traced} traces");
	}

	/// What the searches cost on the grid against over strings (tests/perf/search-cost.ts for TypeScript): a room of the
	/// largest size at scale 1 and one of the maximal size at scale 2, a sixth of the cells blocked, a wall of water with
	/// one gap. `cargo test --release --lib search_cost -- --ignored --nocapture`.
	#[test]
	#[ignore]
	fn search_cost() {
		let w = phi_json::parse(r##"{"tiles":{"~":{"walk":false},",":{"walk":true},":":{"walk":true}}}"##).unwrap();
		let mut seed: u64 = 5;
		let mut rnd = move || { seed = (seed.wrapping_mul(1103515245).wrapping_add(12345)) % (1 << 31); seed as f64 / (1u64 << 31) as f64 };
		let median = |f: &dyn Fn()| { let mut t: Vec<f64> = (0..200).map(|_| { let s = std::time::Instant::now(); f(); s.elapsed().as_secs_f64() * 1e6 }).collect(); t.sort_by(|a, b| a.total_cmp(b)); t[100].round() };
		for (wd, h) in [(36usize, 24usize), (72, 48)] {
			let wall = wd / 2;
			let (from, to) = ((0.0, 0.0), ((wd - 1) as f64, (h - 1) as f64));
			// a room with a way across
			let (ground, blocked) = loop {
				let mut rows: Vec<Vec<&str>> = (0..h).map(|_| (0..wd).map(|_| if rnd() < 0.2 { ":" } else { "," }).collect()).collect();
				for (y, row) in rows.iter_mut().enumerate() { if y != h * 8 / 10 { row[wall] = "~"; } }
				let mut blocked = HashSet::new();
				for y in 0..h { for x in 0..wd { if rnd() < 1.0 / 6.0 && !(x < 2 && y < 2) && !(x + 2 >= wd && y + 2 >= h) && x + 1 != wall && x != wall + 1 { blocked.insert(key(x as f64, y as f64)); } } }
				let ground: Vec<String> = rows.iter().map(|r| r.concat()).collect();
				if legacy_find_path(&w, &ground, from, to, wd * h, &blocked).is_some() { break (ground, blocked); }
			};
			type Case<'a> = (&'a str, Box<dyn Fn() + 'a>, Box<dyn Fn() + 'a>);
			let cases: [Case; 4] = [
				("findPath, max 40", Box::new(|| { legacy_find_path(&w, &ground, from, to, 40, &blocked); }), Box::new(|| { crate::world::find_path(&w, &ground, from, to, 40, &blocked); })),
				("findPath, room-wide", Box::new(|| { legacy_find_path(&w, &ground, from, to, wd * h, &blocked); }), Box::new(|| { crate::world::find_path(&w, &ground, from, to, wd * h, &blocked); })),
				("reach of a building check", Box::new(|| { legacy_reachable(&w, &ground, from, &blocked); }), Box::new(|| { Grid::walk(&w, &ground).closing(&blocked).reach(from); })),
				("road trace", Box::new(|| { legacy_trace(&w, &ground, from, &[to], &blocked); }), Box::new(|| { crate::commands::road::trace(&w, &ground, from, &[to], &blocked); })),
			];
			for (name, old, new) in &cases { println!("{wd}x{h} {name}: old {} µs, new {} µs", median(old.as_ref()), median(new.as_ref())); }
		}
	}
}
