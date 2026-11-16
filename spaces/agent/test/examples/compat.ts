// Vitest-compatible surface over node:test + node:assert, so the example suite
// runs with the repo's built-in runner (`node --test`) without a new dependency.
import { describe, it, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const matchers = (v: unknown, negated = false) => {
	const check = (ok: boolean, msg: string) => {
		if (negated ? ok : !ok) assert.fail(`${negated ? "not " : ""}${msg}`);
	};
	const api = {
		toBe: (e: unknown) => check(Object.is(v, e), `expected ${fmt(v)} toBe ${fmt(e)}`),
		toEqual: (e: unknown) => check(deepEq(v, e), `expected ${fmt(v)} toEqual ${fmt(e)}`),
		toBeDefined: () => check(v !== undefined, `expected value toBeDefined`),
		toBeNull: () => check(v === null, `expected ${fmt(v)} toBeNull`),
		toBeTruthy: () => check(!!v, `expected ${fmt(v)} toBeTruthy`),
		toBeFalsy: () => check(!v, `expected ${fmt(v)} toBeFalsy`),
		toBeGreaterThan: (e: number) => check(typeof v === "number" && v > e, `expected ${fmt(v)} > ${e}`),
		toBeGreaterThanOrEqual: (e: number) => check(typeof v === "number" && v >= e, `expected ${fmt(v)} >= ${e}`),
		toBeLessThan: (e: number) => check(typeof v === "number" && v < e, `expected ${fmt(v)} < ${e}`),
		toBeLessThanOrEqual: (e: number) => check(typeof v === "number" && v <= e, `expected ${fmt(v)} <= ${e}`),
		toBeCloseTo: (e: number, digits = 2) => check(typeof v === "number" && Math.abs(v - e) < 0.5 * 10 ** -digits, `expected ${fmt(v)} ≈ ${e}`),
		toContain: (e: unknown) =>
			check(
				(typeof v === "string" && v.includes(String(e))) || (Array.isArray(v) && v.includes(e)),
				`expected ${fmt(v)} toContain ${fmt(e)}`
			),
		toContainEqual: (e: unknown) => check(Array.isArray(v) && v.some((x) => deepEq(x, e)), `expected ${fmt(v)} toContainEqual ${fmt(e)}`),
		toHaveProperty: (key: string, ...rest: unknown[]) => {
			check(typeof v === "object" && v !== null && key in v, `expected ${fmt(v)} toHaveProperty ${key}`);
			if (rest.length > 0) check(deepEq((v as Record<string, unknown>)[key], rest[0]), `expected property ${key} toEqual ${fmt(rest[0])}`);
		},
		toMatch: (re: RegExp | string) => check(typeof v === "string" && new RegExp(re).test(v), `expected ${fmt(v)} toMatch ${re}`),
		toThrow: (e?: RegExp | string) => {
			assert.equal(typeof v, "function", "toThrow needs a function");
			let threw = false, msg = "";
			try { (v as () => void)(); } catch (err) { threw = true; msg = String(err); }
			check(threw && (e === undefined || new RegExp(e).test(msg)), `expected function toThrow ${e ?? ""}, got ${msg}`);
		},
		get not() { return matchers(v, true); }
	};
	return api;
};

const fmt = (v: unknown) => JSON.stringify(v)?.slice(0, 120);
const deepEq = (a: unknown, b: unknown): boolean => {
	try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
};

const custom: Record<string, (...args: any[]) => any> = {};

export const expect = Object.assign(
	(v: unknown, _message?: string) => {
		const base = matchers(v);
		return new Proxy(base as Record<string, unknown>, {
			get(t, prop) {
				if (prop in t) return t[prop as string];
				const fn = custom[prop as string];
				if (!fn) return undefined;
				return async (...args: any[]) => {
					let r: any = fn(v, ...args);
					if (typeof r === "function") r = r(v); // curried matcher style
					r = await r;
					if (r && typeof r === "object" && "pass" in r && !r.pass)
						assert.fail(r.message?.() ?? `expected ${fmt(v)} ${String(prop)}`);
					return r;
				};
			}
		}) as typeof base & Record<string, (...a: unknown[]) => unknown>;
	},
	{
		extend: (defs: Record<string, (...args: any[]) => any>) => Object.assign(custom, defs)
	}
);

// Minimal vi stub: only useRealTimers is actually used by the suite.
export const vi = {
	useRealTimers: () => {},
	useFakeTimers: () => {},
	fn: <T extends (...a: unknown[]) => unknown>(impl?: T) => impl ?? (() => undefined as unknown as T)
};

// Vitest allows test(name, fn, { timeout }); node:test wants test(name, options, fn).
const wrap =
	(fn: any) =>
	(name: string, a: any, b?: any) => {
		if (b === undefined) return fn(name, a); // (name, fn)
		return fn(name, b, a); // (name, fn, vitestOpts) → (name, opts, fn)
	};

const it_ = wrap(it);
const test_ = wrap(test);
export { describe };
export { it_ as it, test_ as test, beforeEach, afterEach };
export const beforeAll = before;
export const afterAll = after;
