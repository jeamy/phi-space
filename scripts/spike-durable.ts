// AP 0.3 (docs/implementierungsplan-v3.md): what pi-durable allows for named spaces, measured, not assumed.
//   node --experimental-strip-types scripts/spike-durable.ts [entries]
// (a) one commit over a session doc family member and a singleton; (b) singleton -> family under the same kind and
// copy-and-retire to a new kind; (c) commit cost of one space document with many entries on JSONL and SQLite.
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "../src/context.ts";
import { createRegistry, defineDoc, defineDocFamily, Harness, type Storage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../src/core.ts";

const N = Number(process.argv[2] ?? 10_000);
const open = (s: Storage) => Harness.open(s, { models: createModels(), registry: createRegistry() }, ctx);
const tmp = () => mkdtempSync(join(tmpdir(), "phi-spaces-spike-"));
const bytes = (p: string): number => {
	const st = statSync(p);
	return st.isDirectory() ? readdirSync(p).reduce((n, f) => n + bytes(join(p, f)), 0) : st.size;
};
type S = core.SpaceState & Record<string, any>;
const Single = defineDoc<S>({ kind: "spike.space", version: 4, scope: "session", initial: () => core.initialState() as S });
const SameKindFamily = defineDocFamily<S, null>({ kind: "spike.space", version: 4, scope: "session", family: true, initial: () => core.initialState() as S });
const Family = defineDocFamily<S, null>({ kind: "spike.space5", version: 5, scope: "session", family: true, initial: () => core.initialState() as S });
const Other = defineDoc<{ n: number }>({ kind: "spike.other", version: 1, scope: "session", initial: () => ({ n: 0 }) });

async function attempt(name: string, f: () => Promise<unknown>): Promise<void> {
	try { console.log(`${name}: ok ${JSON.stringify(await f()) ?? ""}`); }
	catch (e) { console.log(`${name}: FAILED ${(e as Error).constructor.name}: ${(e as Error).message}`); }
}

async function semantics(): Promise<void> {
	const dir = tmp();
	try {
		let h = await open(await openNodeJsonlStorage(dir, ctx));
		await h.commit(async (tx) => { core.write(await tx.doc(Single), 1, { type: "T", fields: { a: 1 } }, null, core.FOREVER); }, ctx);
		// (a) atomic multi-document commit, including a family member: a throw rolls both back.
		await attempt("a: multi-doc commit (family + singleton)", () => h.commit(async (tx) => {
			(await tx.doc(Family, "x", null)).nextId = 42;
			(await tx.doc(Other)).n = 1;
		}, ctx));
		await attempt("a: rollback on throw", async () => {
			await h.commit(async (tx) => { (await tx.doc(Family, "x", null)).nextId = 99; (await tx.doc(Other)).n = 2; throw new Error("boom"); }, ctx).catch(() => {});
			return { family: (await h.snapshot(Family, "x", ctx))?.nextId, other: (await h.snapshot(Other, ctx))?.n };
		});
		// (b1) the persisted singleton read through a family token of the same kind.
		await attempt("b1: same kind as family", () => h.commit(async (tx) => (await tx.doc(SameKindFamily, "default", null)).entries.length, ctx));
		// (b2) copy into a new kind and retire the singleton in one commit.
		await attempt("b2: copy-and-retire", () => h.commit(async (tx) => {
			const old = await tx.doc(Single);
			const copy = JSON.parse(JSON.stringify(old));
			Object.assign(await tx.doc(Family, "default", null), copy);
			await tx.retireDoc(Single);
			return copy.entries.length;
		}, ctx));
		await h.close(ctx);
		h = await open(await openNodeJsonlStorage(dir, ctx));
		await attempt("b2: after reopen", async () => ({ family: (await h.snapshot(Family, "default", ctx))?.entries.length, single: (await h.snapshot(Single, ctx)) === undefined ? "retired" : "still there" }));
		await attempt("b3: singleton after retire, fresh doc?", () => h.commit(async (tx) => (await tx.doc(Single)).entries.length, ctx));
		await h.close(ctx);
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

async function cost(kind: "jsonl" | "sqlite"): Promise<void> {
	const dir = tmp();
	const path = kind === "jsonl" ? dir : join(dir, "h.sqlite");
	try {
		const h = await open(kind === "jsonl" ? await openNodeJsonlStorage(dir, ctx) : await openNodeSqliteStorage(path));
		const fields = { payload: "x".repeat(200), n: 0 };
		const t0 = performance.now();
		const marks: string[] = [];
		const BATCH = 500;
		for (let i = 0; i < N; i += BATCH) {
			await h.commit(async (tx) => { const s = await tx.doc(Single); for (let j = i; j < Math.min(N, i + BATCH); j++) core.write(s, 1, { type: "T", fields: { ...fields, n: j } }, null, core.FOREVER); }, ctx);
		}
		marks.push(`fill ${N} entries in ${Math.round(performance.now() - t0)} ms`);
		// Single-entry commits on a full space: the cost an RPC write/take would pay.
		const single = async (label: string, f: (s: S) => void) => {
			const k = 200, t = performance.now();
			for (let i = 0; i < k; i++) await h.commit(async (tx) => f(await tx.doc(Single)), ctx);
			marks.push(`${label}: ${((performance.now() - t) / k).toFixed(2)} ms/commit`);
		};
		await single("write 1", (s) => { core.write(s, 1, { type: "T", fields }, null, core.FOREVER); });
		await single("take 1 (first match)", (s) => { core.probe(s, 1, { type: "T" }, null, true); });
		await single("take 1 (last match)", (s) => { core.probe(s, 1, { type: "T", fields: { n: N - 1 } }, null, true); core.write(s, 1, { type: "T", fields: { ...fields, n: N - 1 } }, null, core.FOREVER); });
		const t = performance.now();
		const snap = await h.snapshot(Single, ctx);
		marks.push(`snapshot: ${(performance.now() - t).toFixed(1)} ms, ${snap?.entries.length} entries`);
		await h.close(ctx);
		marks.push(`storage ${Math.round(bytes(path) / 1024)} KiB`);
		const t2 = performance.now();
		const h2 = await open(kind === "jsonl" ? await openNodeJsonlStorage(dir, ctx) : await openNodeSqliteStorage(path));
		await h2.snapshot(Single, ctx);
		marks.push(`reopen+snapshot: ${Math.round(performance.now() - t2)} ms`);
		await h2.close(ctx);
		console.log(`c: ${kind}: ${marks.join("; ")}`);
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

await semantics();
await cost("jsonl");
await cost("sqlite");
