// The world split into its regions with real processes (tests/stack.ts startRegions): a space process and a world worker
// per region, the web part following them all. Newcomers start in the regions in turn; a character takes the ferry into
// another region and plays on there.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { startServer as startWeb } from "../server/index.ts";
import { eventually, lightFire, Player, startRegions } from "./stack.ts";

const guest = async (url: string) => {
	const p = new Player(url);
	assert.equal((await p.post("/api/guest")).status, 200);
	const h = await p.play();
	return { p, h };
};

test("regions: newcomers start in every region's bay, and a ferry takes a character into another region where it plays on", async () => {
	const r = await startRegions();
	const srv = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	try {
		// four guests, one per region's bay
		const four = [];
		for (let i = 0; i < 4; i++) four.push(await guest(srv.url));
		assert.deepEqual(four.map((g) => g.h.room.roomId).sort(), ["graue-bucht", "krabbenbucht", "rauchhafen", "schaerenhafen"]);
		const west = four.find((g) => g.h.room.roomId === "graue-bucht")!;
		const me = west.h.me.charId;
		assert.equal((await r.space("west").readAll({ type: "Character", fields: { charId: me } })).length, 1);
		// light the fires on the way (the fog would close the ferries)
		await lightFire(r.space("west"), 60_000, "feuer-bucht");
		await lightFire(r.space("west"), 60_000, "feuer-anleger");
		for (const [line, room] of [["go ost", "klippenpfad"], ["go ost", "klippenkopf"], ["go möwenfels", "moewenfels-strand"]] as const) {
			const n = west.p.frames.length;
			west.p.send(line);
			await west.p.until((f) => f.t === "hello" && f.room.roomId === room, 15_000, n);
		}
		// it is in the north region now, with its account and session, and gone from the west
		assert.equal((await r.space("west").readAll({ type: "Character", fields: { charId: me } })).length, 0);
		const there = await r.space("nord").readAll({ type: "Character", fields: { charId: me } });
		assert.equal(there.length, 1);
		assert.equal(there[0]!.fields.room, "moewenfels-strand");
		await eventually(async () => (await r.space("nord").readAll({ type: "Session", fields: { charId: me } })).length === 1, 10_000, "the session in the north");
		await eventually(async () => (await r.space("west").readAll({ type: "Session", fields: { charId: me } })).length === 0, 10_000, "no session left in the west");
		// and it plays on there: a command goes to the north's world worker
		const n = west.p.frames.length;
		west.p.send("say hallo möwen");
		await west.p.until((f) => f.t === "msg" && /hallo möwen/.test(f.m.text), 10_000, n);
		// the page still knows its account
		const acc = String(there[0]!.fields.accountId);
		const where = Object.fromEntries(await Promise.all(r.ids.map(async (id) => [id, (await r.space(id).readAll({ type: "Account", fields: { accountId: acc } })).length])));
		const meNow = { ...(await west.p.me()), where };
		assert.equal(meNow.account?.guest, true, JSON.stringify(meNow));
	} finally { await srv.close(); await r.close(); }
});
