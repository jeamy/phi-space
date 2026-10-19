// Evolving primes code in a codemode sandbox. Skips when pi-codemode is not installed (nothing is installed here).
import { describe, test, expect } from "./compat.ts";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { evaluate, evolve, firstPrimes, genomeToSource, loadCodemode, type Genome } from "../../examples/codemode-evolve.ts";

const cm = await loadCodemode();
const t: typeof test = cm ? test : (() => {}) as never;
const sound: Genome = { engine: "trial", cands: "6k", divisors: "primes", early: true, edge: "ok" };

describe("codemode-evolve", () => {
	test("the reference gives the first primes", () => {
		expect(firstPrimes(10)).toEqual([2, 3, 5, 7, 11, 13, 17, 19, 23, 29]);
		expect(firstPrimes(100)[99]).toBe(541);
	});
	t("a sound candidate passes, an off-by-one candidate fails", async () => {
		expect((await evaluate(cm!, genomeToSource(sound), 100)).ok).toBe(true);
		const bad = await evaluate(cm!, genomeToSource({ ...sound, edge: "off" }), 100);
		expect(bad.ok).toBe(false);
	});
	t("broken or hostile source is only a failed score", async () => {
		expect((await evaluate(cm!, "function firstPrimes(n){ throw new Error('x') }", 100)).ok).toBe(false);
		expect((await evaluate(cm!, "function firstPrimes(n){ return typeof process === 'undefined' ? [] : [1] }", 100)).ok).toBe(false);
	});
	t("a run in the space finds a correct, evaluated best", async () => {
		const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
		const r = await evolve(h, cm!, { agents: 4, gens: 2, perAgent: 2, seed: 7 });
		expect(r.history.length).toBe(2);
		expect(r.best).not.toBeNull();
		expect((await evaluate(cm!, r.best!.source, 100)).ok).toBe(true);
		await h.close(ctx);
	});
});
