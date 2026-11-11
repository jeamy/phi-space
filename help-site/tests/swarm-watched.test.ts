// The demo runs only while someone watches (watchedOnly, as the help site's hub sets it): without a viewer it writes no
// SwarmTask and no Post; a viewer attached starts it; after the last one left it goes on for idleAfterMs, then stops.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Meter } from "phi-spaces";
import { SocialSwarmHub } from "../server/social/swarm.ts";
import { swarmSpace } from "./swarm-space.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("an unwatched swarm stands still; a viewer starts it, and it stops a while after the last one left", { timeout: 90_000 }, async () => {
	const t = await swarmSpace();
	const hub = new SocialSwarmHub(t.space, new Meter(), { pulses: false, maxEntries: null, watchedOnly: true, idleAfterMs: 500 });
	try {
		await hub.init();
		const posts = async () => (await hub.stats()).byType.Post ?? 0;
		const before = await posts();
		await sleep(2_500);
		assert.equal(await posts(), before, "no viewer: nothing produced");
		assert.equal(hub.watched, false);

		const closers: Array<() => void> = [];
		await hub.attachWebSocket({ id: "v", send() {}, close() {}, onMessage() {}, onClose: (h: () => void) => { closers.push(h); } } as never);
		assert.equal(hub.watched, true);
		for (let i = 0; i < 200 && (await posts()) === before; i++) await sleep(50);
		assert.ok((await posts()) > before, "a viewer: posts come");

		for (const h of closers) h();
		assert.equal(hub.watched, true, "just after the last viewer left it goes on");
		await sleep(1_500);
		assert.equal(hub.watched, false);
		// what was begun before it stopped is finished: tasks worked off, a question's answer and its receipt (polled every
		// 3 s) still come; then nothing more
		let settled = await posts();
		for (let i = 0; i < 10; i++) { await sleep(4_000); const now = await posts(); if (now === settled) break; settled = now; }
		await sleep(4_000);
		assert.equal(await posts(), settled, "a while after the last viewer: nothing produced");
	} finally { await hub.close(); await t.close(); }
});
