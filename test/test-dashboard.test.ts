// Dashboard Phase 1 (docs/dashboard.md): the HTTP/SSE surface is a read-only projection of
// listSpaces/snapshotSpace/core.stats and the process meter — no mutation endpoint exists.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSpace, PhiSpaces, serveSpace, SpaceService, StaticIdentity } from "../src/index.ts";
import { Meter } from "../src/meter.ts";
import { groupSpaces, parseApps, startDashboard } from "../src/dashboard.ts";
import { ctx } from "./support/persistent.ts";
import { openTestHost } from "./support/host.ts";

const memory = () => openTestHost(ctx);

test("dashboard: spaces, detail, entries and metrics over HTTP; GET only", async () => {
	const h = await memory();
	const meter = new Meter();
	const client = new PhiSpaces(h, ctx, Date.now, meter);
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
	const seen = (t: string, matches: (event: typeof events[number]) => boolean) => events.some((e) => e.type === t && matches(e));
	const wait = async (t: string, matches: (event: typeof events[number]) => boolean = () => true): Promise<void> => {
		for (let i = 0; i < 300 && !seen(t, matches); i++) await new Promise((r) => setTimeout(r, 10));
		assert.ok(seen(t, matches), `SSE never sent ${t}; got ${events.map((e) => e.type).join(",")}`);
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
		await new PhiSpaces(h, ctx, Date.now, meter).write({ type: "Probe", fields: {} });
		await wait("space");
		assert.ok((events.find((e) => e.type === "space")!.stats as { entries: number }).entries >= 1);
		// An earlier periodic metric can legitimately precede the write under suite load.
		await wait("metrics", e => (e.totals as Record<string, number>).writes === 1);
	} finally {
		ac.abort();
		await pump;
		await dash.close();
		await h.close(ctx);
	}
});

test("dashboard: an app's space over its socket shows stats and entry pages; a missing socket is an offline app", async () => {
	const dir = mkdtempSync("/tmp/phi-dash-");
	const app = await memory();
	const identity = new StaticIdentity({ "peer-app": { principal: { peerId: "peer-app" }, roles: ["member"] } });
	const server = await serveSpace(new SpaceService({ host: app, ctx, identity }), { listen: { path: join(dir, "app.sock") }, connection: () => ({ peerId: "peer-app" }) });
	const local = new PhiSpaces(app, ctx);
	for (let n = 0; n < 3; n++) await local.write({ type: "Task", fields: { n } });
	await local.write({ type: "Result", fields: { ok: true } });
	// a named space on the same service (like the help system's "social-swarm" shard)
	await app.commit((tx) => createSpace(tx, "posts", Date.now()), ctx);
	await new PhiSpaces(app, ctx, Date.now, undefined, undefined, { space: "posts" }).write({ type: "Post", fields: { text: "hi" } });
	const h = await memory();
	const dash = await startDashboard({
		host: h, ctx, port: 0, appPollMs: 50,
		// the first address of "chat" is not there: the second one answers
		apps: [{ id: "chat", label: "Chat", addresses: [`unix:${join(dir, "missing.sock")}`, `unix:${join(dir, "app.sock")}`] }, { id: "gone", label: "Gone", addresses: [`unix:${join(dir, "missing.sock")}`] },
			{ id: "posts", label: "Posts", addresses: [`unix:${join(dir, "app.sock")}`], space: "posts" }],
	});
	try {
		const { apps } = await (await fetch(`${dash.url}/api/apps`)).json();
		const chat = apps.find((a: { id: string }) => a.id === "chat");
		assert.equal(chat.online, true);
		assert.equal(chat.address, `unix:${join(dir, "app.sock")}`);
		assert.equal(chat.alias, "default");
		assert.equal(chat.stats.entries, 4);
		assert.deepEqual(chat.stats.byType, { Task: 3, Result: 1 });
		const posts = apps.find((a: { id: string }) => a.id === "posts");
		assert.equal(posts.alias, "posts");
		assert.deepEqual(posts.stats.byType, { Post: 1 });
		const gone = apps.find((a: { id: string }) => a.id === "gone");
		assert.equal(gone.online, false);
		assert.ok(gone.error);

		const all = await (await fetch(`${dash.url}/api/apps/chat/entries?limit=2`)).json();
		assert.equal(all.entries.length, 2);
		assert.equal(all.next, 2);
		const rest = await (await fetch(`${dash.url}/api/apps/chat/entries?limit=2&after=2`)).json();
		assert.deepEqual(rest.entries.map((e: { type: string }) => e.type), ["Task", "Result"]);
		assert.equal(rest.next, null);
		const results = await (await fetch(`${dash.url}/api/apps/chat/entries?type=Result`)).json();
		assert.deepEqual(results.entries.map((e: { type: string }) => e.type), ["Result"]);
		assert.equal((await fetch(`${dash.url}/api/apps/nope/entries`)).status, 404);

		// a later write shows up with the next poll
		await local.write({ type: "Task", fields: { n: 3 } });
		let entries = 0;
		for (let i = 0; i < 100 && entries !== 5; i++) {
			await new Promise((r) => setTimeout(r, 20));
			entries = (await (await fetch(`${dash.url}/api/apps`)).json()).apps.find((a: { id: string }) => a.id === "chat").stats.entries;
		}
		assert.equal(entries, 5);
		// activity: commits per minute between polls, from the revision the stats carry; the dashboard's own polls (stats,
		// readAll pages) commit nothing, so a quiet space settles at 0
		const chatNow = async () => (await (await fetch(`${dash.url}/api/apps`)).json()).apps.find((a: { id: string }) => a.id === "chat");
		let c = await chatNow();
		assert.ok(c.activity.some((n: number) => n > 0), `a commit shows as activity: ${JSON.stringify(c.activity)}`);
		for (let i = 0; i < 100 && !(c.activity.length >= 3 && c.activity.slice(-2).every((n: number) => n === 0)); i++) {
			await new Promise((r) => setTimeout(r, 20));
			c = await chatNow();
		}
		assert.deepEqual(c.activity.slice(-2), [0, 0], `quiet polls: ${JSON.stringify(c.activity)}`);

		const js = await fetch(`${dash.url}/palettes.js`);
		assert.match(js.headers.get("content-type")!, /javascript/);
		const text = await js.text();
		assert.match(text, /export const PALETTES/);
		assert.doesNotMatch(text, /interface PaletteModeColors/);
	} finally {
		await dash.close();
		await server.close();
		await h.close(ctx);
		await app.close(ctx);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dashboard: app specs (DASHBOARD_APPS, --app) take alternatives; a default id keeps its label", () => {
	assert.deepEqual(parseApps("spaces-mmo=unix:/a.sock|tcp:127.0.0.1:3960, mine@posts=tcp:nano:3800, help-swarm=tcp:127.0.0.1:3600"), [
		{ id: "spaces-mmo", label: "spaces-mmo · Welt", addresses: ["unix:/a.sock", "tcp:127.0.0.1:3960"] },
		{ id: "mine", label: "mine", addresses: ["tcp:nano:3800"], space: "posts" },
		{ id: "help-swarm", label: "Help · Swarm-Shard", addresses: ["tcp:127.0.0.1:3600"], space: "social-swarm" },
	]);
	assert.throws(() => parseApps("nothing"), /id\[@space\]=address/);
});

test("dashboard: an app of every space (@*) lists its service's spaces with stats, folds session spaces, refuses entries", async () => {
	const dir = mkdtempSync("/tmp/phi-dash-");
	const app = await memory();
	// like the help hub: a role that lists spaces and reads stats, nothing else
	const identity = new StaticIdentity({ dashboard: { principal: { peerId: "dashboard" }, roles: ["stats"] } });
	const policy = { roles: { stats: { methods: ["hello", "stats", "spaces"] as const } } };
	const server = await serveSpace(new SpaceService({ host: app, ctx, identity, policy }), { listen: { path: join(dir, "hub.sock") }, connection: () => ({ peerId: "dashboard" }) });
	await new PhiSpaces(app, ctx).write({ type: "LlmAdmin", fields: {} });
	for (const alias of ["control", "chat-session-a", "chat-session-b", "chat-session-c"]) {
		await app.commit((tx) => createSpace(tx, alias, Date.now()), ctx);
		await new PhiSpaces(app, ctx, Date.now, undefined, undefined, { space: alias }).write({ type: alias === "control" ? "PeerKey" : "Msg", fields: {} });
	}
	const h = await memory();
	const dash = await startDashboard({ host: h, ctx, port: 0, appPollMs: 50, apps: parseApps(`hub@*=unix:${join(dir, "hub.sock")}`) });
	try {
		const hub = (await (await fetch(`${dash.url}/api/apps`)).json()).apps[0];
		assert.equal(hub.online, true);
		assert.equal(hub.stats.entries, 5);
		assert.deepEqual(hub.stats.byType, { LlmAdmin: 1, PeerKey: 1, Msg: 3 });
		assert.deepEqual(hub.spaces.map((s: { alias: string; spaces: number }) => [s.alias, s.spaces]), [["chat-session-*", 3], ["control", 1], ["default", 1]]);
		const refused = await fetch(`${dash.url}/api/apps/hub/entries`);
		assert.equal(refused.status, 403);
		assert.equal((await (await fetch(`${dash.url}/api/apps`)).json()).apps[0].online, true, "a refused read leaves the app online");
	} finally {
		await dash.close();
		await server.close();
		await h.close(ctx);
		await app.close(ctx);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dashboard: groupSpaces folds a prefix only from three spaces on", () => {
	const st = (entries: number) => ({ entries, byType: { T: entries }, locked: 0, uncommitted: 0, expired: 0, txns: 0, waiters: 0, registrations: 0, outbox: 0, returned: 0 });
	assert.deepEqual(groupSpaces([{ alias: "sieve-main", stats: st(2) }, { alias: "sieve-b", stats: st(1) }]).map((r) => r.alias), ["sieve-main", "sieve-b"]);
	const rows = groupSpaces([{ alias: "x-1", stats: st(1) }, { alias: "x-2", stats: st(2) }, { alias: "x-3", stats: st(3) }]);
	assert.deepEqual(rows.map((r) => [r.alias, r.spaces, r.stats.entries, r.stats.byType.T]), [["x-*", 3, 6, 6]]);
});
