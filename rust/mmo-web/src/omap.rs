//! A map in insertion order, as JavaScript's `Map`: a key set again keeps its place, a key deleted and set again goes
//! to the end.
use std::collections::HashMap;

pub struct OMap<V> { slots: Vec<Option<(String, V)>>, at: HashMap<String, usize>, live: usize }

impl<V> Default for OMap<V> { fn default() -> Self { Self { slots: Vec::new(), at: HashMap::new(), live: 0 } } }

impl<V> OMap<V> {
	pub fn get(&self, k: &str) -> Option<&V> { self.at.get(k).and_then(|i| self.slots[*i].as_ref()).map(|(_, v)| v) }
	pub fn get_mut(&mut self, k: &str) -> Option<&mut V> { let i = *self.at.get(k)?; self.slots[i].as_mut().map(|(_, v)| v) }
	pub fn has(&self, k: &str) -> bool { self.at.contains_key(k) }
	pub fn set(&mut self, k: &str, v: V) {
		if let Some(i) = self.at.get(k) { self.slots[*i] = Some((k.to_owned(), v)); return; }
		self.at.insert(k.to_owned(), self.slots.len());
		self.slots.push(Some((k.to_owned(), v)));
		self.live += 1;
	}
	pub fn delete(&mut self, k: &str) -> Option<V> {
		let i = self.at.remove(k)?;
		let v = self.slots[i].take().map(|(_, v)| v);
		self.live -= 1;
		if self.slots.len() > 64 && self.live * 2 < self.slots.len() { self.compact(); }
		v
	}
	fn compact(&mut self) {
		let old = std::mem::take(&mut self.slots);
		self.at.clear();
		for (k, v) in old.into_iter().flatten() { self.at.insert(k.clone(), self.slots.len()); self.slots.push(Some((k, v))); }
	}
	pub fn len(&self) -> usize { self.live }
	pub fn is_empty(&self) -> bool { self.live == 0 }
	pub fn clear(&mut self) { self.slots.clear(); self.at.clear(); self.live = 0; }
	pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> { self.slots.iter().flatten().map(|(k, v)| (k.as_str(), v)) }
	pub fn values(&self) -> impl Iterator<Item = &V> { self.slots.iter().flatten().map(|(_, v)| v) }
	pub fn keys(&self) -> impl Iterator<Item = &str> { self.slots.iter().flatten().map(|(k, _)| k.as_str()) }
	pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> { self.slots.iter_mut().flatten().map(|(_, v)| v) }
}
