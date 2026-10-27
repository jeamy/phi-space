// Load as on big and nano (docs/betrieb.md, "Last und Latenz"): the space on SQLite, every NPC role, several players
// walking at the page's own pace (one step per WALK_MS, at most eight ahead of the answers, client/walk.ts), and the
// processes of big reaching the space of nano through a proxy that delays every chunk (the network between the hosts).
// It measures what a player feels: the time from a step to its answer (the `ack` on the own character).
//
//   LOAD_PLAYERS=10        players walking at once
//   LOAD_SECONDS=15        how long they walk
//   LOAD_DELAY_MS=0        one-way delay between big and nano, in ms (a ping of 2 × this)
//   LOAD_WORLDS=near       where the world workers run: near (on nano, next to the space), far (on big), both
//   LOAD_NPCS=all          all: every NPC role of the world (on big); none: no npc process
//   LOAD_P99_MS            fail when the 99th percentile is above this (default: no limit, only the report)
// Run alone: `npm run test:perf`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer as startWeb } from "../../server/index.ts";
import type { ServerFrame } from "../../server/gateway.ts";
import { Player, startStack } from "../stack.ts";

const env = (k: string, d: string) => process.env[k] || d;
const PLAYERS = Number(env("LOAD_PLAYERS", "10")), SECONDS = Number(env("LOAD_SECONDS", "15")), DELAY = Number(env("LOAD_DELAY_MS", "0"));
const WORLDS = env("LOAD_WORLDS", "near"), NPCS = env("LOAD_NPCS", "all"), P99 = Number(env("LOAD_P99_MS", "0"));
const WALK_MS = 150, AHEAD = 8;

/** A unix socket at `path` that forwards to `target`, every chunk in both directions `ms` late (in order). */
async function delayProxy(path: string, target: string, ms: number): Promise<() => Promise<void>> {
	const socks = new Set<Socket>();
	const pipe = (from: Socket, to: Socket) => {
		let last = 0;
		from.on("data", (d) => { const at = Math.max(Date.now() + ms, last); last = at; setTimeout(() => { if (!to.destroyed) to.write(d); }, at - Date.now()); });
		from.on("close", () => setTimeout(() => to.destroy(), ms));
		from.on("error", () => to.destroy());
	};
	const server = createServer((a) => {
		const b = connect(target);
		socks.add(a); socks.add(b);
		pipe(a, b); pipe(b, a);
	});
	await new Promise<void>((ok) => server.listen(path, ok));
	return () => new Promise<void>((ok) => { for (const s of socks) s.destroy(); server.close(() => ok()); });
}

const pct = (xs: number[], p: number) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]! : NaN;

test(`load: ${PLAYERS} players walking, ${DELAY} ms between big and nano, world workers ${WORLDS}, NPCs ${NPCS}`, { timeout: 300_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "mmo-load-"));
	const stack = await startStack({ dataDir: dir, worlds: 0 });
	// big's view of nano's sockets: through the delaying proxy (or directly without a delay)
	const farOf = (spec: string) => (DELAY > 0 ? spec.replace(/\.sock$/, "-far.sock") : spec);
	const farSpace = farOf(stack.world), farAcc = farOf(stack.accounts);
	const proxies = DELAY > 0 ? [await delayProxy(farSpace.slice(5), stack.world.slice(5), DELAY), await delayProxy(farAcc.slice(5), stack.accounts.slice(5), DELAY)] : [];
	let web: Awaited<ReturnType<typeof startWeb>> | undefined;
	const players: Player[] = [];
	try {
		if (WORLDS === "near" || WORLDS === "both") await stack.worldProcess();
		if (WORLDS === "far" || WORLDS === "both") await stack.worldProcess({ SPACES_MMO_SPACE: farSpace });
		if (NPCS === "all") await stack.npcProcess({ SPACES_MMO_SPACE: farSpace, SPACES_MMO_NPCS: "" });
		web = await startWeb({ port: 0, space: farSpace, accounts: farAcc });
		for (let i = 0; i < PLAYERS; i++) {
			const p: Player = new Player(web.url);
			assert.equal((await p.post("/api/guest")).status, 200); // guests walk like anyone (registrations are limited per address and day)
			await p.play();
			players.push(p);
		}
		await new Promise((r) => setTimeout(r, 1000)); // the arrivals settle
		const times: number[] = [];
		let lost = 0;
		const end = Date.now() + SECONDS * 1000;
		await Promise.all(players.map(async (p, n) => {
			const hello = p.frames.find((f) => f.t === "hello") as Extract<ServerFrame, { t: "hello" }>;
			const sent = new Map<number, number>();
			let seq = 0, acked = 0;
			p.ws!.addEventListener("message", (e) => {
				const f = JSON.parse(String((e as MessageEvent).data)) as ServerFrame;
				if (f.t !== "char" || f.c.charId !== hello.me.charId || f.ack === undefined) return;
				for (const [s, at] of sent) if (s <= f.ack) { times.push(Date.now() - at); sent.delete(s); }
				acked = Math.max(acked, f.ack);
			});
			await new Promise((r) => setTimeout(r, (n * WALK_MS) / PLAYERS)); // not all in the same instant
			while (Date.now() < end) {
				// the page's pace: one step per WALK_MS, and never more than AHEAD steps without an answer
				if (seq - acked < AHEAD) {
					seq++;
					const dx = Math.floor((seq - 1) / 3) % 2 ? -1 : 1; // three steps right, three left
					sent.set(seq, Date.now());
					p.ws!.send(JSON.stringify({ t: "step", seq, dx, dy: 0 }));
				}
				await new Promise((r) => setTimeout(r, WALK_MS));
			}
			await new Promise((r) => setTimeout(r, 3000)); // the last answers
			lost += sent.size;
		}));
		// what the space holds now (every commit and every read of a type costs in proportion to it)
		const byType = new Map<string, number>();
		for (const e of await stack.space.readAll()) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
		console.log(`[load] entries: ${[...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ")}`);
		times.sort((a, b) => a - b);
		const report = `steps ${times.length} (${(times.length / SECONDS).toFixed(1)}/s), unanswered ${lost}; step → answer: p50 ${pct(times, 0.5)} ms, p95 ${pct(times, 0.95)} ms, p99 ${pct(times, 0.99)} ms, max ${times.at(-1)} ms`;
		console.log(`[load] ${PLAYERS} players, delay ${DELAY} ms, worlds ${WORLDS}, npcs ${NPCS}: ${report}`);
		assert.ok(times.length > 0, "no step was answered");
		if (P99 > 0) assert.ok(pct(times, 0.99) <= P99, `p99 ${pct(times, 0.99)} ms above ${P99} ms`);
	} finally {
		await Promise.all(players.map((p) => p.leave().catch(() => {})));
		await web?.close();
		for (const close of proxies) await close();
		await stack.close();
		await rm(dir, { recursive: true, force: true });
	}
});
