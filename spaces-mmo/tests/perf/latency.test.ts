// The latency target of Phase 3 (docs/architektur.md, "Takt"): command to position frame below 150 ms. Run alone
// (`npm run test:perf`): inside `npm test` every test file starts its own stack at the same time, and that measures the
// test run, not the game.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Player, startServer } from "../stack.ts";
import { WALK_MS } from "../../client/walk.ts";
import type { ServerFrame } from "../../server/gateway.ts";

async function player(url: string, name: string): Promise<{ p: Player; h: Extract<ServerFrame, { t: "hello" }> }> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, h: await p.play() };
}

test("a step shows up fast: command to position frame, median below 150 ms", async () => {
	const srv = await startServer();
	try {
		const { p, h } = await player(srv.url, "Schnell");
		// up to three rounds of twelve steps; the best median counts (it measures the game, not other jobs on the machine)
		let best = Infinity, p90 = Infinity;
		for (let round = 0; round < 3 && best >= 150; round++) {
			const times: number[] = [];
			for (let i = 0; i < 12; i++) {
				const from = p.frames.length, dx = i % 2 ? -1 : 1, t0 = performance.now();
				p.send(`step ${dx} 0`);
				await p.until((f) => f.t === "char" && f.c.charId === h.me.charId, 5_000, from);
				const took = performance.now() - t0;
				times.push(took);
				// at the page's pace: a step beyond the gateway's burst is dropped and never answered
				await new Promise((r) => setTimeout(r, Math.max(0, WALK_MS - took)));
			}
			times.sort((a, b) => a - b);
			const median = times[Math.floor(times.length / 2)]!;
			if (median < best) { best = median; p90 = times[Math.floor(times.length * 0.9)]!; }
		}
		console.log(`step latency: median ${best.toFixed(0)} ms, p90 ${p90.toFixed(0)} ms`);
		assert.ok(best < 150, `median ${best.toFixed(0)} ms`);
		await p.leave();
	} finally { await srv.close(); }
});
