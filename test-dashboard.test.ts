// Dashboard Phase 1 (docs/dashboard.md): the HTTP/SSE surface is a read-only projection of
// listSpaces/snapshotSpace/core.stats and the process meter — no mutation endpoint exists.
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { PiSpaces } from "./src/index.ts";
import { Meter } from "./src/meter.ts";
import { startDashboard } from "./src/dashboard.ts";
import { ctx } from "./test/support/persistent.ts";

const memory = () => Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);

test("dashboard: spaces, detail, entries and metrics over HTTP; GET only", async () => {
	const h = await memory();
	const meter = new Meter();
	const client = new PiSpaces(h, ctx, Date.now, meter);
	const dash = await startDashboard({ host: h, ctx, port: 0, meter });
	try {
		const spaces = await (await fetch(`${dash.url}/api/spaces`)).json();
		assert.equal(spaces.spaces.length, 1);
		assert.equal(spaces.spaces[0]!.alias, "default");
		assert.equal(spaces.spaces[0]!.stats.entries, 0);

		const index = await fetch(`${dash.url}/`);
		assert.ok(index.ok);
		assert.match(index.headers.get("content-type")!, /text\/html/);
		assert.match(await index.text(), /Live Dashboard/);
		assert.equal((await fetch(`${dash.url}/api/nope`)).status, 404);
		assert.equal((await fetch(`${dash.url}/api/spaces`, { method: "POST" })).status, 405);

		const lease = await client.write({ type: "Probe", fields: { n: 1 } }, null, 10_000);
		const detail = await (await fetch(`${dash.url}/api/spaces/default`)).json();
		assert.equal(detail.stats.entries, 1);
		const page = await (await fetch(`${dash.url}/api/spaces/default/entries?limit=10`)).json();
		assert.equal(page.total, 1);
		assert.equal(page.entries[0]!.id, lease.id);
		assert.equal(page.entries[0]!.fields.n, 1);
		assert.equal(page.next, null);

		const metrics = await (await fetch(`${dash.url}/api/metrics`)).json();
		assert.equal(metrics.totals.writes, 1);
		assert.equal(metrics.connections, 0);
		assert.ok(metrics.uptimeMs >= 0);
	} finally {
		await dash.close();
		await h.close(ctx);
	}
});

test("dashboard: SSE says hello, then pushes space and metrics events after a commit", async () => {
	const h = await memory();
	const meter = new Meter();
	const dash = await startDashboard({ host: h, ctx, port: 0, meter, metricsMs: 100 });
	const ac = new AbortController();
	const events: Array<{ type: string; [k: string]: unknown }> = [];
	const seen = (t: string) => events.some((e) => e.type === t);
	const wait = async (t: string): Promise<void> => {
		for (let i = 0; i < 300 && !seen(t); i++) await new Promise((r) => setTimeout(r, 10));
		assert.ok(seen(t), `SSE never sent ${t}; got ${events.map((e) => e.type).join(",")}`);
	};
	const res = await fetch(`${dash.url}/api/live`, { signal: ac.signal });
	const pump = (async () => {
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
				for (const line of buf.slice(0, i).split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
				buf = buf.slice(i + 2);
			}
		}
	})().catch(() => {});
	try {
		await wait("hello");
		await new PiSpaces(h, ctx, Date.now, meter).write({ type: "Probe", fields: {} });
		await wait("space");
		assert.ok((events.find((e) => e.type === "space")!.stats as { entries: number }).entries >= 1);
		await wait("metrics");
		assert.equal((events.find((e) => e.type === "metrics")!.totals as Record<string, number>).writes, 1);
	} finally {
		ac.abort();
		await pump;
		await dash.close();
		await h.close(ctx);
	}
});
