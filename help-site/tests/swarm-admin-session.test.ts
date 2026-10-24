import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { Meter, openOwnMemoryHost } from "../../src/index.ts";
import { SocialSwarmHub } from "../server/social/swarm.ts";

async function connect(opts: ConstructorParameters<typeof SocialSwarmHub>[3]) {
	const host = openOwnMemoryHost();
	const hub = new SocialSwarmHub(host, ctx, new Meter(), { produce: false, pulses: false, seedContent: false, maxEntries: null, ...opts });
	await hub.init();
	const sent: any[] = [];
	let handler!: (raw: string) => Promise<void> | void;
	await hub.attachWebSocket({ id: "t", send: (d: any) => sent.push(typeof d === "string" ? JSON.parse(d) : d), close() {}, onMessage: (h: typeof handler) => { handler = h; }, onClose() {} } as any);
	return { sent, say: (m: unknown) => handler(JSON.stringify(m)), close: async () => { await hub.close(); await host.close(ctx); } };
}

test("an open AdminSpaces session makes a feed connection admin; the password still does, and a wrong session does nothing", async () => {
	const c = await connect({ adminCheck: (p) => p === "pw", sessionCheck: (id) => id === "good-session" });
	try {
		await c.say({ type: "swarm.agentCount", count: 50 });
		assert.ok(c.sent.some((m) => m.type === "swarm.denied"), "not admin yet: swarm controls are refused");
		c.sent.length = 0;
		await c.say({ type: "admin.session", sessionId: "bad" });
		assert.ok(!c.sent.some((m) => m.type === "admin.ok" || m.type === "admin.denied"), "an unknown session is ignored without noise");
		await c.say({ type: "admin.session", sessionId: "good-session" });
		assert.ok(c.sent.some((m) => m.type === "admin.ok"), "a valid session makes the connection admin");
		c.sent.length = 0;
		await c.say({ type: "swarm.agentCount", count: 50 });
		assert.ok(!c.sent.some((m) => m.type === "swarm.denied"), "admin controls are allowed now");
	} finally { await c.close(); }
	const d = await connect({ adminCheck: (p) => p === "pw" });
	try {
		await d.say({ type: "admin.session", sessionId: "good-session" });
		assert.ok(!d.sent.some((m) => m.type === "admin.ok"), "without a session check nothing is granted");
		await d.say({ type: "admin.auth", password: "pw" });
		assert.ok(d.sent.some((m) => m.type === "admin.ok"), "the password login is unchanged");
	} finally { await d.close(); }
});
