// Acceptance of Phase 3 that a test can measure (docs/phasen.md): the hello of a room stays small and each player is
// sent only what happens around it. The latency: tests/perf/latency.test.ts (run alone). Drawing (autotiles, gliding,
// zoom, frame rate) is checked in the browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventually, Player, startServer } from "./stack.ts";
import type { ServerFrame } from "../server/gateway.ts";

async function player(url: string, name: string): Promise<{ p: Player; h: Extract<ServerFrame, { t: "hello" }> }> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, h: await p.play() };
}

test("a room's hello stays below 64 KiB, even with a dozen players and the things lying around", async () => {
	const srv = await startServer();
	try {
		const ps = await Promise.all(Array.from({ length: 12 }, async (_, i) => player(srv.url, `Gast${i}x`)));
		// a thirteenth comes once all twelve are online: its hello shows everyone
		await eventually(async () => (await srv.stack.space.count({ type: "Session" })) >= 12, 10_000, "twelve online");
		const last = await player(srv.url, "Dreizehn");
		ps.push(last);
		const bytes = Buffer.byteLength(JSON.stringify(last.h));
		assert.ok(last.h.chars.length >= 12 && last.h.objs.length >= 4, "the hello carries everyone and everything here");
		assert.ok(bytes < 64 * 1024, `hello ${bytes} bytes`);
		console.log(`hello: ${bytes} bytes for ${last.h.chars.length} characters and ${last.h.objs.length} objects`);
		await Promise.all(ps.map(({ p }) => p.leave()));
	} finally { await srv.close(); }
});

test("each player is sent only its room: moves in the bay do not reach the cliff path", async () => {
	const srv = await startServer();
	try {
		const a = await player(srv.url, "Bucht"), b = await player(srv.url, "Pfad");
		const n = b.p.frames.length;
		b.p.send("go ost");
		await b.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, n);
		const from = b.p.frames.length;
		// at the page's pace (one step per 500 ms; faster ones are dropped)
		for (let i = 0; i < 4; i++) { const n = a.p.frames.length; a.p.send(`step ${i % 2 ? -1 : 1} 0`); await a.p.until((f) => f.t === "char" && f.c.charId === a.h.me.charId, 5_000, n); await new Promise((r) => setTimeout(r, 450)); }
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(b.p.frames.slice(from).filter((f) => f.t === "char" && f.c.charId === a.h.me.charId).length, 0, "no frames about a room one is not in");
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});
