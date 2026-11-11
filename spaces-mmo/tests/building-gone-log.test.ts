// A building that goes says so in the world's log, with why (docs/betrieb.en.md "Backups"): a hut torn down by its owner
// leaves "[world] building gone: <id> huette of <owner> in <room> at <x>,<y>: torn down by <name>" on the world worker's
// stderr, in TypeScript and in Rust (SPACES_MMO_WORLD_CMD) alike.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import type { ServerFrame } from "../server/gateway.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { eventually, Player, startServer } from "./stack.ts";

async function does(p: Player, line: string, text: string | RegExp, ms = 20_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const charOf = async (space: SpaceLike, charId: string) => (await eventually(async () => (await space.readAll({ type: "Character", fields: { charId } }))[0] ?? null, 10_000, `character ${charId}`))!.fields as { accountId: string; room: string; x: number; y: number };

test("a building torn down says so in the world's log, with who and where", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		let log = "";
		for (const w of srv.stack.worlds) w.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Abreisserin", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		await does(p, "look", /./);
		const c = await charOf(s, me);
		const now = await worldNowOf(s);
		await s.write({ type: "Building", fields: { buildId: "b-gone", plan: "huette", name: "Hütte", room: c.room, x: c.x + 1, y: c.y - 1, w: 2, h: 2, owner: me, ownerName: "Abreisserin", accountId: c.accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, FOREVER);
		await does(p, "abriss hütte", "reißt die Hütte ab");
		const line = await eventually(() => log.split("\n").find((l) => l.includes("[world] building gone: b-gone")) ?? null, 10_000, "the log line");
		assert.equal(line, `[world] building gone: b-gone huette of Abreisserin in ${c.room} at ${c.x + 1},${c.y - 1}: torn down by Abreisserin`);
		await p.leave();
	} finally { await srv.close(); }
});
