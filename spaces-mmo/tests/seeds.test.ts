// "sammle samen" (engine/commands/garden.ts): every find is one thing in the pack and is told once.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerFrame } from "../server/gateway.ts";
import { Player, startServer } from "./stack.ts";

test("a find of seeds is one thing in the pack and one message", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space, p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Sucherin", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const packed = async () => (await s.readAll({ type: "Item", fields: { location: me } })).length;
		const start = await packed();
		let finds = 0;
		for (let i = 0; i < 40 && finds < 4; i++) {
			const before = p.frames.length;
			for (const e of await s.readAll({ type: "SeedRest" })) await s.takeIfExists({ id: e.id }, 0);
			// the page offers the search again once the rest is over
			if (i > 0) await p.until((f) => f.t === "trade" && f.trade.seedRestUntilWorldMs === null, 10_000, before);
			const from = p.frames.length;
			p.send("sammle samen");
			await p.until((f) => f.t === "msg" && /findest|keine reifen|Hier wächst nichts/.test(f.m.text), 20_000, from);
			// and does not offer it while the figure rests: the trade view says until when
			await p.until((f) => f.t === "trade" && !!f.trade.seedRestUntilWorldMs, 10_000, from);
			await new Promise((r) => setTimeout(r, 300));
			const told = p.frames.slice(from).filter((f): f is Extract<ServerFrame, { t: "msg" }> => f.t === "msg" && /Du findest/.test(f.m.text));
			assert.ok(told.length <= 1, `told ${told.length} times: ${told.map((f) => f.m.text).join(" | ")}`);
			finds += told.length;
			assert.equal(await packed() - start, finds, `after ${finds} finds the pack holds ${await packed() - start} more`);
		}
		assert.ok(finds >= 2, `only ${finds} finds in 40 tries`);
	} finally { await srv.close(); }
});
