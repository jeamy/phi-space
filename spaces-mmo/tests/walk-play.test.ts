// The walk in play: a held key over a real connection walks evenly, never backwards, and ends where the server is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WALK_MS } from "../client/walk.ts";
import { holdKey } from "./support/walk-drive.ts";
import { eventually, Player, startServer } from "./stack.ts";

const charAt = async (srv: Awaited<ReturnType<typeof startServer>>, charId: string) => (await srv.stack.space.readIfExists({ type: "Character", fields: { charId } }, 5_000))!.fields as Record<string, number>;

test("a held key walks evenly and never backwards; letting go stops it where the server has it", async () => {
	const srv = await startServer();
	try {
		const p = new Player(srv.url);
		await p.post("/api/register", { name: "Läuferin", password: "geheim-123" });
		const hello = await p.play(), me = hello.me.charId;
		p.send("move 2 13"); // the grass row of the grey bay, free to the east
		await eventually(async () => (await charAt(srv, me)).x === 2, 10_000, "at the start");
		await p.until((f) => f.t === "char" && f.c.charId === me && f.c.x === 2);
		const { drawn, server, sent } = await holdKey(p, hello, { x: 2, y: 13 }, 1, 0, 1_500);
		const xs = drawn.map((s) => s.x);
		assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]!), `never backwards: ${xs.join(" ")}`);
		assert.ok(sent >= 8, `about ten steps in 1.5 s (${sent})`);
		const gaps = drawn.slice(2).map((s, i) => s.t - drawn[i + 1]!.t);
		assert.ok(gaps.every((g) => g < WALK_MS * 2.2), `even steps: ${gaps.join(" ")}`);
		assert.deepEqual({ x: drawn.at(-1)!.x, y: drawn.at(-1)!.y }, server, "drawn where the server has it");
		assert.equal((await charAt(srv, me)).x, server!.x);
		await p.leave();
	} finally { await srv.close(); }
});
