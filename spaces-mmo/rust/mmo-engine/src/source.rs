//! The engine's clock and chance (`server/engine/source.ts`): every command and tick reads the time and draws chance
//! here. A thread runs with the real ones unless `with_source` set a seeded source for it (the comparison with the
//! TypeScript engine, R8.2): mulberry32 as specified bit for bit in `source.ts`, the integer range by rejection, bytes
//! little-endian.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// The 32-bit generator alone.
pub struct Mulberry32(Cell<u32>);

impl Mulberry32 {
	pub fn new(seed: u32) -> Self { Self(Cell::new(seed)) }
	pub fn next_u32(&self) -> u32 {
		let state = self.0.get().wrapping_add(0x6d2b79f5);
		self.0.set(state);
		let mut t = state;
		t = (t ^ (t >> 15)).wrapping_mul(t | 1);
		t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
		t ^ (t >> 14)
	}
}

/// A seeded source: chance from a seed, the time from a clock.
pub struct Seeded {
	next: Mulberry32,
	clock: Box<dyn Fn() -> f64>,
}

impl Seeded {
	pub fn new(seed: u32, clock: impl Fn() -> f64 + 'static) -> Self { Self { next: Mulberry32::new(seed), clock: Box::new(clock) } }
}

const TWO32: f64 = 4_294_967_296.0;

thread_local! {
	static CURRENT: RefCell<Option<Rc<Seeded>>> = const { RefCell::new(None) };
}

/// Runs `fn` with `source` as this thread's clock and chance (the engine of one comparison runs on one thread).
pub fn with_source<T>(source: Rc<Seeded>, f: impl FnOnce() -> T) -> T {
	let before = CURRENT.with(|c| c.replace(Some(source)));
	let out = f();
	CURRENT.with(|c| *c.borrow_mut() = before);
	out
}

/// Sets this thread's source for good (a driver whose steps come one by one).
pub fn set_source(source: Option<Rc<Seeded>>) { CURRENT.with(|c| *c.borrow_mut() = source); }

fn current() -> Option<Rc<Seeded>> { CURRENT.with(|c| c.borrow().clone()) }

/// The time now (ms since the epoch).
pub fn time_now() -> f64 {
	match current() {
		Some(s) => (s.clock)(),
		None => std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64),
	}
}

fn os_u32() -> u32 {
	let mut b = [0u8; 4];
	getrandom::getrandom(&mut b).expect("the operating system's randomness");
	u32::from_le_bytes(b)
}

fn next_u32() -> u32 { current().map_or_else(os_u32, |s| s.next.next_u32()) }

/// A number in [0, 1), like `Math.random()`.
pub fn random() -> f64 { next_u32() as f64 / TWO32 }

/// An integer in [min, max), like `crypto.randomInt(min, max)`.
pub fn random_int(min: f64, max: f64) -> f64 {
	let n = max - min;
	assert!(min.fract() == 0.0 && n.fract() == 0.0 && (1.0..=TWO32).contains(&n), "int({min}, {max}): no range of 1 to 2^32 integers");
	let limit = TWO32 - (TWO32 % n);
	loop {
		let u = next_u32() as f64;
		if u < limit { return min + (u % n); }
	}
}

/// `n` random bytes.
pub fn random_bytes(n: usize) -> Vec<u8> {
	let mut out = Vec::with_capacity(n.div_ceil(4) * 4);
	while out.len() < n { out.extend_from_slice(&next_u32().to_le_bytes()); }
	out.truncate(n);
	out
}

/// Lowercase hex, as `Buffer.toString("hex")`.
pub fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_vectors_of_source_ts() {
		let take = |seed: u32| { let m = Mulberry32::new(seed); (0..4).map(|_| m.next_u32()).collect::<Vec<_>>() };
		assert_eq!(take(0), [1144304738, 1416247, 958946056, 627933444]);
		assert_eq!(take(1), [2693262067, 11749833, 2265367787, 4213581821]);
		assert_eq!(take(0xdeadbeef), [4043151706, 1147597007, 3315858022, 1538288752]);
		set_source(Some(Rc::new(Seeded::new(1, || 1234.0))));
		assert_eq!(random(), 2693262067.0 / TWO32);
		assert_eq!(random_int(0.0, 10.0), (11749833 % 10) as f64);
		assert_eq!(time_now(), 1234.0);
		set_source(Some(Rc::new(Seeded::new(1, || 0.0))));
		assert_eq!(hex(&random_bytes(6)), "f3ea87a0c949");
		set_source(Some(Rc::new(Seeded::new(0xdeadbeef, || 0.0))));
		assert_eq!(random_int(0.0, 3.0 * 1073741824.0), 1147597007.0);
		set_source(None);
	}
}
