//! `RegionSpaces` (`server/region-spaces.ts`): one client per region, or the one space of the whole world.
use std::cell::Cell;
use std::time::Duration;

use mmo_engine::j;
use mmo_engine::regions::{regions_of, WHOLE};
use mmo_engine::space::{Error, Result, Space};
use mmo_engine::world_host::connect;
use phi_json::Json;

pub struct RegionSpaces { pub w: Json, spaces: Vec<(String, Space)>, next: Cell<usize> }

impl RegionSpaces {
	/// Clients of every region SPACES_MMO_REGIONS names, or of the one space `whole`.
	pub fn connect(w: &Json, whole: &str) -> Result<Self> {
		let raw = std::env::var("SPACES_MMO_REGIONS").unwrap_or_default();
		let mut spaces: Vec<(String, Space)> = Vec::new();
		if raw.trim().is_empty() { spaces.push((WHOLE.to_owned(), connect(whole)?)); } else {
			let mut out: Vec<(String, String)> = Vec::new();
			for part in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
				let Some(i) = part.find('=').filter(|i| *i >= 1) else { return Err(Error::Other(format!("SPACES_MMO_REGIONS: \"{part}\" is not region=address"))) };
				let (k, v) = (part[..i].to_owned(), part[i + 1..].to_owned());
				match out.iter_mut().find(|(x, _)| *x == k) { Some(slot) => slot.1 = v, None => out.push((k, v)) }
			}
			for g in regions_of(w) { let id = j::s(&g, "regionId"); if !out.iter().any(|(k, _)| k == id) { return Err(Error::Other(format!("SPACES_MMO_REGIONS names no address for the region {id}"))); } }
			for (k, a) in out { spaces.push((k, connect(&a)?)); }
		}
		Ok(Self { w: w.clone(), spaces, next: Cell::new(0) })
	}
	pub fn size(&self) -> usize { self.spaces.len() }
	pub fn home(&self) -> &str { &self.spaces[0].0 }
	pub fn home_space(&self) -> &Space { &self.spaces[0].1 }
	pub fn get(&self, id: &str) -> Option<&Space> { self.spaces.iter().find(|(k, _)| k == id).map(|(_, s)| s) }
	pub fn entries(&self) -> &[(String, Space)] { &self.spaces }

	/// The region whose space holds an entry `tmpl` matches; with `wait_ms` looked for again until then.
	pub async fn find(&self, tmpl: &Json, wait_ms: f64) -> Result<Option<(String, Space)>> {
		let end = mmo_engine::source::time_now() + wait_ms;
		loop {
			for (region, space) in &self.spaces { if !space.read_limit(tmpl, 1, None).await?.is_empty() { return Ok(Some((region.clone(), space.clone()))); } }
			if mmo_engine::source::time_now() >= end || self.spaces.len() == 1 { return Ok(None); }
			tokio::time::sleep(Duration::from_millis(100)).await;
		}
	}

	/// Where a new character starts: the regions in turn; without regions the world's start.
	pub fn next_start(&self) -> (String, Space, String) {
		if self.spaces.len() == 1 { let (r, s) = &self.spaces[0]; return (r.clone(), s.clone(), j::s(&self.w, "start").to_owned()); }
		let regions: Vec<Json> = regions_of(&self.w).into_iter().filter(|g| self.get(j::s(g, "regionId")).is_some()).collect();
		let i = self.next.get();
		self.next.set(i + 1);
		let g = &regions[i % regions.len()];
		let id = j::s(g, "regionId").to_owned();
		(id.clone(), self.get(&id).cloned().expect("the region's space"), j::s(g, "start").to_owned())
	}
}
