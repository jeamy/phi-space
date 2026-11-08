// Where the engine's clock and chance come from (docs/rust-portierung.en.md, R8.0 item 5). Every command and tick reads
// the real time and draws its random numbers and ids through here, never from Date.now(), Math.random or node:crypto
// (tests/source.test.ts checks that). A world worker uses the real ones. A test runs the engine with a seeded source
// and a clock of its own (`withSource`): the same intents then give the same entries, which the Rust engine (R8.2) is held
// against. The source belongs to the call: it goes along with the async context of `withSource`, so two engines with
// sources of their own can run side by side in one process.
//
// The seeded generator is mulberry32, specified here so another implementation reproduces it bit for bit (vectors in
// tests/source.test.ts): a 32-bit state, starting at `seed >>> 0`; each step adds 0x6D2B79F5 (mod 2^32) to the state and
// mixes a copy t of it: t = (t ^ t >>> 15) * (t | 1); t ^= t + (t ^ t >>> 7) * (t | 61); out = t ^ t >>> 14 (all products
// and sums mod 2^32, >>> a logical shift). From that 32-bit output u:
//   float: u / 2^32;
//   int(min, max): with n = max - min (1 ≤ n ≤ 2^32), the first u below 2^32 - (2^32 mod n), as min + u mod n (rejection);
//   bytes(n): the outputs one after another, each as four bytes little-endian, cut to n.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes as cryptoBytes, randomInt as cryptoInt } from "node:crypto";

export type Source = {
	/** Real time in ms since the epoch (what Date.now() would say). */
	now(): number;
	/** A number in [0, 1). */
	float(): number;
	/** An integer in [min, max). */
	int(min: number, max: number): number;
	/** `n` random bytes. */
	bytes(n: number): Buffer;
};

/** The real clock and the operating system's randomness. */
export const SYSTEM: Source = {
	now: () => Date.now(),
	float: () => Math.random(),
	int: (min, max) => cryptoInt(min, max),
	bytes: (n) => cryptoBytes(n),
};

const TWO32 = 2 ** 32;

/** The 32-bit generator alone (see the head of this file). */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	};
}

/** A seeded source: chance from `seed`, the time from `clock` (default: always `start`). */
export function seeded(seed: number, clock: (() => number) | number = 0): Source {
	const next = mulberry32(seed), now = typeof clock === "number" ? () => clock : clock;
	return {
		now,
		float: () => next() / TWO32,
		int(min, max) {
			const n = max - min;
			if (!Number.isInteger(min) || !Number.isInteger(n) || n < 1 || n > TWO32) throw new RangeError(`int(${min}, ${max}): no range of 1 to 2^32 integers`);
			const limit = TWO32 - (TWO32 % n);
			for (;;) { const u = next(); if (u < limit) return min + (u % n); }
		},
		bytes(n) {
			const out = Buffer.alloc(Math.ceil(n / 4) * 4);
			for (let i = 0; i < out.length; i += 4) out.writeUInt32LE(next(), i);
			return out.subarray(0, n);
		},
	};
}

const current = new AsyncLocalStorage<Source>();

/** Runs `fn` with `source` as the engine's clock and chance (and everything it starts, awaited or not). */
export const withSource = <T>(source: Source, fn: () => T): T => current.run(source, fn);
/** The source of this call: the one of the nearest `withSource`, else the real one. */
export const source = (): Source => current.getStore() ?? SYSTEM;

/** The time now (ms since the epoch). */
export const timeNow = (): number => source().now();
/** A number in [0, 1), like Math.random(). */
export const random = (): number => source().float();
/** An integer in [min, max), or in [0, min) with one argument, like crypto.randomInt. */
export const randomInt = (min: number, max?: number): number => (max === undefined ? source().int(0, min) : source().int(min, max));
/** `n` random bytes, like crypto.randomBytes. */
export const randomBytes = (n: number): Buffer => source().bytes(n);
