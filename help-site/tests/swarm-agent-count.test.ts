import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Meter } from "phi-spaces";
import { SocialSwarmHub } from "../server/social/swarm.ts";
import type { SwarmSpace } from "../server/social/batch.ts";
import { swarmSpace } from "./swarm-space.ts";

async function open(host: SwarmSpace, maxEntries: number | null = null) {
	const hub = new SocialSwarmHub(host, new Meter(), { produce: false, pulses: false, maxEntries, adminCheck: () => true });
	await hub.init();
	let handler!: (raw: string) => Promise<void> | void;
	await hub.attachWebSocket({ id: "t", send() {}, close() {}, onMessage: (h: typeof handler) => { handler = h; }, onClose() {} } as any);
	await handler(JSON.stringify({ type: "admin.auth", password: "pw" }));
	return { hub, say: (count: number) => handler(JSON.stringify({ type: "swarm.agentCount", count })) };
}

async function agentEntries(hub: SocialSwarmHub, n: number): Promise<void> {
	for (let i = 0; i < 400 && (await hub.stats()).byType.Agent !== n; i++) await new Promise((r) => setTimeout(r, 25));
	assert.equal((await hub.stats()).byType.Agent, n);
}

test("the agent setting changes the Agent entries and survives a restart", async () => {
	const t = await swarmSpace(), host = t.space;
	try {
		const first = await open(host);
		const start = (await first.hub.stats()).agentCount;
		await first.say(start + 50);
		await agentEntries(first.hub, start + 50);
		await first.say(30);
		await agentEntries(first.hub, 30);
		assert.equal((await first.hub.stats()).agentCount, 30);
		await first.hub.close();

		const second = await open(host);
		assert.equal((await second.hub.stats()).agentCount, 30);
		await agentEntries(second.hub, 30);
		await second.hub.close();
	} finally { await t.close(); }
});

test("Agent entries stop at a quarter of the entry cap, the roster does not", async () => {
	const t = await swarmSpace(), host = t.space;
	try {
		const { hub, say } = await open(host, 800);
		await say(500);
		await agentEntries(hub, 200);
		assert.equal((await hub.stats()).agentCount, 500);
		await hub.close();
	} finally { await t.close(); }
});
