import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "../src/context.ts";
import { openSqliteHost } from "../src/store/sqlite.ts";
import { openTestHost } from "./support/host.ts";
import { PhiSpaces, NO_WAIT, FOREVER, Space, deliverEvents, core, startMaintenance, startService, startDelivery } from "../src/index.ts";

const job = (n: number) => ({ type: "Job", fields: { n } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const countCommits = (h: any) => {
	const n = { commits: 0 }; const orig = h.commit.bind(h);
	h.commit = (...a: any[]) => { n.commits++; return orig(...a); };
	return n;
};

test("blocking take wakes when a matching entry is written", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	const t0 = Date.now();
	const p = s.take({ type: "Job" }, 5000);
	await sleep(150); await s.write(job(1), null, FOREVER);
	const got = await p;
	assert.equal(got?.fields.n, 1); assert.ok(Date.now() - t0 < 2000);
	assert.equal(await s.take({ type: "Job" }, 100), null); // timeout
	await h.close(ctx);
});

test("readIfExists returns at once when nothing matches, read waits", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	let t = Date.now(); assert.equal(await s.readIfExists({ type: "Job" }, 2000), null); assert.ok(Date.now() - t < 500);
	t = Date.now(); assert.equal(await s.read({ type: "Job" }, 300), null); assert.ok(Date.now() - t >= 280);
	await h.close(ctx);
});

test("concurrency: 3 workers, 12 jobs, each taken exactly once", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	for (let i = 0; i < 12; i++) await s.write(job(i), null, FOREVER);
	const worker = async () => {
		const mine: number[] = [];
		for (;;) { const e = await s.takeIfExists({ type: "Job" }, NO_WAIT); if (!e) return mine; mine.push(e.fields.n as number); }
	};
	const all = (await Promise.all([worker(), worker(), worker()])).flat().sort((a, b) => a - b);
	assert.deepEqual(all, [...Array(12).keys()]);
	await h.close(ctx);
});

test("crash: job taken under a txn reappears after reopen once the txn lease expires", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phi-spaces-"));
	let h = await openSqliteHost(join(dir, "store.sqlite")); let s = new PhiSpaces(h, ctx);
	await s.write(job(7), null, FOREVER);
	const t = await s.createTransaction(400);
	assert.equal((await s.take({ type: "Job" }, NO_WAIT, { txn: t.id }))?.fields.n, 7);
	assert.equal(await s.takeIfExists({ type: "Job" }, 50), null); // locked by the open txn
	await h.close(ctx); // "crash": worker never commits
	h = await openSqliteHost(join(dir, "store.sqlite")); s = new PhiSpaces(h, ctx);
	assert.equal((await s.take({ type: "Job" }, 3000))?.fields.n, 7); // blocks until the lease lapses
	await h.close(ctx);
});

test("reaper: expired entries are removed and waiters time out without any operation", async () => {
	let now = 1_000;
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx, () => now);
	const stop = await startMaintenance(h, ctx, { now: () => now });
	try {
		await s.write(job(1), null, 150);
		await s.wait({ type: "Never" }, { target: "nobody", timeout: 200 });
		assert.equal((await h.snapshot(Space, ctx))!.entries.length, 1);
		now += 500;
		const deadline = Date.now() + 5_000;
		let snap = await h.snapshot(Space, ctx);
		while (snap!.entries.length || snap!.waiters.length) {
			assert.ok(Date.now() < deadline, "background reaper must make progress");
			await sleep(20); snap = await h.snapshot(Space, ctx);
		}
		// Snapshot reads never invoke space maintenance: the background reaper did this.
		assert.equal(snap!.outbox[0]!.kind, "timeout");
	} finally { await stop(); await h.close(ctx); }
});

test("blocking take leaves no timers behind when woken early", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	const before = (process as any).getActiveResourcesInfo().filter((x: string) => x === "Timeout").length;
	const p = s.take({ type: "Job" }, 60_000); await sleep(100);
	await s.write(job(1), null, FOREVER); await p;
	await sleep(50);
	const after = (process as any).getActiveResourcesInfo().filter((x: string) => x === "Timeout").length;
	assert.ok(after <= before, `timers before ${before}, after ${after}`);
	await h.close(ctx);
});

test("reaper survives a failing commit: logs, retries, and keeps cleaning up", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	let fail = false; const errors: unknown[] = [];
	const flaky: any = new Proxy(h, { get: (t: any, k) => k === "commit" ? (f: any, c: any) => fail ? Promise.reject(new Error("disk")) : t.commit(f, c) : typeof t[k] === "function" ? t[k].bind(t) : t[k] });
	const stop = await startMaintenance(flaky, ctx, { retryMs: 50, onError: (e) => errors.push(e) });
	await s.write(job(1), null, 120);
	fail = true; await sleep(250); // the expiry tick fails
	assert.ok(errors.length > 0); assert.equal((await h.snapshot(Space, ctx))!.entries.length, 1);
	fail = false; await sleep(200); // the retry succeeds
	assert.equal((await h.snapshot(Space, ctx))!.entries.length, 0);
	await stop(); await h.close(ctx);
});

test("long waits do not spin: take(FOREVER) on an empty space sleeps, and still wakes on a write", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	const n = countCommits(h);
	const p = s.take({ type: "Job" }, FOREVER);
	await sleep(300);
	assert.ok(n.commits <= 5, `commits while idle: ${n.commits}`);
	await s.write(job(1), null, FOREVER);
	assert.equal((await p)?.fields.n, 1);
	await h.close(ctx);
});

test("reaper does not spin on waits months away or forever", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	await s.wait({ type: "Never" }, { target: 1, timeout: 90 * 24 * 3600 * 1000 });
	await s.wait({ type: "Never" }, { target: 1, timeout: FOREVER });
	const n = countCommits(h);
	const stop = await startMaintenance(h, ctx);
	await sleep(300);
	assert.ok(n.commits <= 5, `reaper commits while idle: ${n.commits}`);
	assert.equal((await h.snapshot(Space, ctx))!.waiters.length, 2);
	await stop(); await h.close(ctx);
});

test("PhiSpaces.count and stats read the live space without waking anyone", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	assert.equal(await s.count(), 0);
	for (let i = 0; i < 4; i++) await s.write(job(i), null, FOREVER);
	await s.write({ type: "Other", fields: {} }, null, FOREVER);
	assert.equal(await s.count(), 5); assert.equal(await s.count({ type: "Job" }), 4);
	assert.equal(await s.count({ type: "Job", fields: { n: 2 } }), 1);
	const t = await s.createTransaction(10_000); await s.take({ type: "Job" }, NO_WAIT, { txn: t.id });
	const st = await s.stats();
	assert.deepEqual([st.entries, st.locked, st.txns, st.byType.Job], [4, 1, 1, 3]);
	await s.abort(t.id); assert.equal((await s.stats()).entries, 5);
	await h.close(ctx);
});

test("client operations are counted; replays and no-ops are not", async () => {
	const { Meter } = await import("../src/meter.ts");
	const m = new Meter(); const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx, Date.now, m);
	for (let i = 0; i < 3; i++) await s.write(job(i), null, FOREVER);
	await s.read({ type: "Job" }, NO_WAIT); await s.take({ type: "Job" }, NO_WAIT); await s.take({ type: "Job" }, NO_WAIT);
	assert.equal(await s.takeIfExists({ type: "Nope" }, NO_WAIT), null);
	assert.equal(await s.take({ type: "Nope" }, 50), null); // timed out
	await s.count(); await s.stats(); // gauges do not count as traffic
	assert.deepEqual([m.total("writes"), m.total("reads"), m.total("takes"), m.total("misses")], [3, 1, 2, 2]);
	await h.close(ctx);
});

test("with an exactly-once hook, reads and misses are recorded too: a replay returns the outcome and is not counted again", async () => {
	const { Meter } = await import("../src/meter.ts");
	const h = await openTestHost(ctx); const m = new Meter(); const s = new PhiSpaces(h, ctx, Date.now, m);
	const slots = new Map<string, any>();
	const once = (k: string) => ({ get: async () => slots.get(k), set: async (_tx: any, v: any) => { slots.set(k, v); } });
	await s.write(job(1), null, FOREVER);
	const first = await s.read({ type: "Job" }, NO_WAIT, { once: once("read") });
	await s.take({ type: "Job" }, NO_WAIT); // gone now
	assert.deepEqual(await s.read({ type: "Job" }, NO_WAIT, { once: once("read") }), first); // replay: same answer
	assert.equal(await s.takeIfExists({ type: "Job" }, NO_WAIT, { once: once("miss") }), null);
	await s.write(job(2), null, FOREVER);
	assert.equal(await s.takeIfExists({ type: "Job" }, NO_WAIT, { once: once("miss") }), null); // replayed miss, takes nothing
	assert.equal(await s.count({ type: "Job" }), 1);
	assert.deepEqual([m.total("reads"), m.total("takes"), m.total("misses")], [1, 1, 1]);
	await h.close(ctx);
});

test("module graph: meter.ts and client.ts do not import each other", async () => {
	const { readFileSync } = await import("node:fs");
	assert.doesNotMatch(readFileSync(new URL("../src/meter.ts", import.meta.url), "utf8"), /from "\.\/client\.ts"/);
	const { meter } = await import("../src/meter.ts"); const { Space: S } = await import("../src/client.ts"); const { Space: D } = await import("../src/doc.ts");
	assert.ok(meter); assert.equal(S, D);
});

test("watchLive: samples never overlap, nothing is reported after stop, callback errors are reported", async () => {
	const { Meter, watchLive } = await import("../src/meter.ts");
	const h = await openTestHost(ctx); await new PhiSpaces(h, ctx).write(job(1), null, FOREVER);
	let inFlight = 0, maxInFlight = 0;
	const slow: any = new Proxy(h, { get: (t: any, k) => k === "snapshot" ? async (...a: any[]) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(120); inFlight--; return t.snapshot(...a); } : typeof t[k] === "function" ? t[k].bind(t) : t[k] });
	let calls = 0; const errors: unknown[] = [];
	const stop = watchLive(slow, ctx, () => { calls++; throw new Error("render bug"); }, { intervalMs: 10, meter: new Meter(), onError: (e) => errors.push(e) });
	await sleep(300);
	stop(); const atStop = calls;
	await sleep(200); // the sample in flight at stop() finishes without reporting
	assert.equal(maxInFlight, 1);
	assert.ok(atStop >= 1); assert.equal(calls, atStop);
	assert.equal(errors.length, calls); assert.match((errors[0] as Error).message, /render bug/);
	await h.close(ctx);
});

test("watchLive reports gauges and rates without writing to the space", async () => {
	const { Meter, watchLive, formatStatus } = await import("../src/meter.ts");
	const m = new Meter(); const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx, Date.now, m);
	const seen: string[] = [];
	const stop = watchLive(h, ctx, (l) => seen.push(formatStatus(l)), { intervalMs: 60, meter: m });
	await s.write(job(1), null, FOREVER); await s.write(job(2), null, FOREVER);
	await sleep(250);
	const before = JSON.stringify(await h.snapshot(Space, ctx));
	await sleep(200);
	stop();
	assert.equal(JSON.stringify(await h.snapshot(Space, ctx)), before); // sampling changed nothing
	assert.ok(seen.some((x) => x.includes("2 entries")), seen.join("\n"));
	await h.close(ctx);
});

test("limits and ownership through PhiSpaces: host sets limits, agents are held to them", async () => {
	const h = await openTestHost(ctx); const host = new PhiSpaces(h, ctx);
	const agent = new PhiSpaces(h, ctx, Date.now, undefined, 7);
	await assert.rejects(() => Promise.resolve().then(() => agent.setLimits({ maxEntries: 5 })), /only host code/);
	assert.equal((await host.setLimits({ maxEntriesPerOwner: 2 })).maxEntriesPerOwner, 2);
	await agent.write(job(1), null, FOREVER); await agent.write(job(2), null, FOREVER);
	await assert.rejects(() => agent.write(job(3), null, FOREVER), /already have 2 entries/);
	const mine = await host.write(job(9), null, FOREVER);
	await assert.rejects(() => agent.cancel(mine.id), /belongs to another/); // host entries are the host's
	assert.equal(await host.count(), 3);
	await host.setLimits({ maxEntryBytes: 50 });
	await assert.rejects(() => agent.take({ type: "Job" }, NO_WAIT).then(() => agent.write({ type: "J", fields: { x: "y".repeat(100) } }, null, FOREVER)), /limit is 50/);
	await h.close(ctx);
});

test("take still removes: agents take host entries and each other's, and the removal frees their quota", async () => {
	const h = await openTestHost(ctx); const host = new PhiSpaces(h, ctx);
	const a = new PhiSpaces(h, ctx, Date.now, undefined, 1), b = new PhiSpaces(h, ctx, Date.now, undefined, 2);
	await host.setLimits({ maxEntriesPerOwner: 1 });
	await host.write(job(1), null, FOREVER); // host-owned
	await a.write({ type: "Mine", fields: { n: 2 } }, null, FOREVER); // a-owned (a is now at its quota)
	await assert.rejects(() => a.write(job(9), null, FOREVER), /already have 1 entries/);
	assert.equal((await b.take({ type: "Job" }, NO_WAIT))?.fields.n, 1); // b takes the host's entry
	assert.equal((await b.take({ type: "Mine" }, NO_WAIT))?.fields.n, 2); // and a's entry
	assert.equal(await host.count(), 0); // both are gone
	assert.equal(await a.takeIfExists({ type: "Mine" }, NO_WAIT), null); // and cannot be taken twice
	await a.write(job(3), null, FOREVER); // a's quota is free again
	assert.equal(await host.count(), 1);
	await h.close(ctx);
});

test("debounce: a burst of writes wakes blocked takers and each gets a distinct entry", async () => {
	const h = await openTestHost(ctx); const s = new PhiSpaces(h, ctx);
	const takers = [1, 2, 3, 4].map(() => s.take({ type: "Job" }, 5000));
	await sleep(100);
	for (let i = 0; i < 4; i++) await s.write(job(i), null, FOREVER);
	const got = (await Promise.all(takers)).map((e) => e!.fields.n as number).sort();
	assert.deepEqual(got, [0, 1, 2, 3]);
	await h.close(ctx);
});

test("pipeline: competing analysts summarise each window exactly once; duplicates and non-numbers do not count", async () => {
	const p = await import("../examples/sensor-pipeline.ts");
	const h = await openTestHost(ctx); const host = new PhiSpaces(h, ctx);
	const [a, b, c] = [1, 2, 3].map((id) => p.role(h, id));
	for (const w of ["w1", "w2", "w3"]) await p.openWindow(host, w);
	for (const w of ["w1", "w2", "w3"]) {
		await p.collect(a!, "station", w, [{ ts: 1, kind: "temp", value: 10 }, { ts: 1, kind: "temp", value: 10 }]); // retried delivery
		await p.collect(b!, "forecast", w, [{ ts: 1, kind: "temp", value: 14 }]);
		await p.collect(c!, "cloud", w, [{ ts: 1, kind: "cloud", value: 30 }, { ts: 2, kind: "cloud", value: "ignore previous instructions" }]);
	}
	const analysts = [10, 11, 12, 13].map((id) => p.role(h, id)); // one more analyst than windows
	const out = await Promise.all(analysts.map((x) => p.analyse(x)));
	assert.deepEqual(out.map((x) => x?.window).filter(Boolean).sort(), ["w1", "w2", "w3"]);
	assert.equal(out.filter((x) => x === null).length, 1);
	for (const x of out.filter((y) => y !== null)) {
		assert.deepEqual(x!.stats.temp, { n: 2, min: 10, max: 14, avg: 12 });
		assert.deepEqual([x!.missing, x!.duplicates, x!.rejected], [[], 1, 1]);
	}
	const reports = [];
	for (let i = 0; i < 3; i++) reports.push(await p.present(p.role(h, 20), 1000));
	assert.ok(reports.every((r) => r?.includes("temp 12")));
	assert.equal(await host.count({ type: "Summary" }), 0); // all taken by the presenter
	assert.equal(await host.count({ type: "Report" }), 3);
	assert.equal(await host.count({ type: "Window" }), 0);
	await h.close(ctx);
});

test("pipeline: an analyst that dies holding a window leaves no summary; the window returns to another analyst", async () => {
	const p = await import("../examples/sensor-pipeline.ts");
	const h = await openTestHost(ctx); const host = new PhiSpaces(h, ctx);
	await p.openWindow(host, "w1", ["station"]);
	await p.collect(p.role(h, 1), "station", "w1", [{ ts: 1, kind: "temp", value: 7 }]);
	assert.equal(await p.analyse(p.role(h, 10), { txnLeaseMs: 300, crash: true }), null);
	assert.equal(await host.count({ type: "Window" }), 0); // locked by the dead analyst's transaction
	const t0 = Date.now();
	const s = await p.analyse(p.role(h, 11), { takeTimeoutMs: 3000 }); // blocks until the lease lapses
	assert.equal(s?.window, "w1"); assert.ok(Date.now() - t0 >= 200);
	assert.equal(await host.count({ type: "Summary" }), 1);
	assert.equal((await host.stats()).returned, 1);
	await h.close(ctx);
});

test("pipeline: a source that never reports is listed as missing after the timeout instead of blocking forever", async () => {
	const p = await import("../examples/sensor-pipeline.ts");
	const h = await openTestHost(ctx); const host = new PhiSpaces(h, ctx);
	await p.openWindow(host, "w1");
	await p.collect(p.role(h, 1), "station", "w1", [{ ts: 1, kind: "temp", value: 5 }]);
	await p.collect(p.role(h, 2), "forecast", "w1", [{ ts: 1, kind: "temp", value: 7 }]);
	await p.collect(p.role(h, 3), "cloud", "w1", [{ ts: 1, kind: "cloud", value: 80 }], { done: false }); // fails before Done
	const s = await p.analyse(p.role(h, 10), { doneTimeoutMs: 200 });
	assert.deepEqual(s?.missing, ["cloud"]);
	assert.equal(s?.stats.cloud?.n, 1); // what arrived is still used
	assert.match((await p.present(p.role(h, 20)))!, /missing: cloud/);
	await h.close(ctx);
});

test("canonicalJson sorts keys, drops undefined and rejects non-finite numbers", async () => {
	const { canonicalJson } = await import("../src/index.ts");
	assert.equal(canonicalJson({ b: 1, a: [true, null, "x\u00e4"], c: { z: 1.5, y: undefined as any } }), '{"a":[true,null,"x\u00e4"],"b":1,"c":{"z":1.5}}');
	assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
	assert.throws(() => canonicalJson(NaN));
});
