//! A room's cells as one array (`shared/grid.ts`; docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3,
//! "Performance strategy"): index y·w + x instead of "x,y" strings, for searches over a room.

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
}
