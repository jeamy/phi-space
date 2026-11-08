// The world split into its regions with real processes (tests/stack.ts startRegions): a space process and a world worker
// per region, the web part following them all. Newcomers start in the regions in turn; a character takes the ferry into
// another region and plays on there.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import { eventually, lightFire, Player, startRegions, startWeb } from "./stack.ts";

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
			await through(west.p, line, room);
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

test("regions: a lapsed guest's contributions to a fire in another region go with it; anything whose owner might be registered stays", async () => {
	const r = await startRegions({ worldEnv: { SPACES_MMO_CLEANUP_MS: "300" } });
	try {
		const gave = (charId: string, name: string) => r.space("west").write({ type: "Contribution", fields: { beaconId: "feuer-bucht", charId, name, pieces: 1, ms: 60_000 } as never }, null, FOREVER);
		// a guest in the north whose account has lapsed (none was written), with a contribution to a fire in the west
		await r.space("nord").write({ type: "Character", fields: { charId: "c-lapsed", accountId: "a-lapsed", name: "Strandläufer-1", guest: true, room: "moewenfels-strand", x: 3, y: 3 } as never }, null, FOREVER);
		await gave("c-lapsed", "Strandläufer-1");
		// one whose character is in no region any more (a registered player in a transaction looks like that for a
		// round — it must never lose its reputation), and one of a character that plays on in the east
		await gave("c-nowhere", "Strandläufer-2");
		const kept = (await r.space("ost").readAll({ type: "Character" }))[0]!;
		await gave(String(kept.fields.charId), String(kept.fields.name));
		const left = async () => (await r.space("west").readAll({ type: "Contribution" })).map((e) => String(e.fields.charId));
		await eventually(async () => { const l = await left(); return !l.includes("c-lapsed"); }, 10_000, "the lapsed guest's contribution is taken");
		const l = await left();
		assert.ok(l.includes("c-nowhere") && l.includes(String(kept.fields.charId)), `no other contribution goes: ${l}`);
		assert.equal((await r.space("nord").readAll({ type: "Character", fields: { charId: "c-lapsed" } })).length, 0);
	} finally { await r.close(); }
});

/** Through an exit. A fire lit from outside clears the fog only with the next fog step: a refusal until then is asked again. */
async function through(p: Player, line: string, room: string, ms = 60_000): Promise<void> {
	const end = Date.now() + ms;
	for (;;) {
		const n = p.frames.length;
		p.send(line);
		const f = await p.until((f) => (f.t === "hello" && f.room.roomId === room) || (f.t === "msg" && f.m.text.includes("zu dicht")), Math.max(1, end - Date.now()), n);
		if (f.t === "hello") return;
		await new Promise((r) => setTimeout(r, 250));
	}
}

test("regions: a trader on his way stays a while where people are and answers who speaks to him (also without the '→ say' line)", { timeout: 300_000 }, async () => {
	const r = await startRegions({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.1", SPACES_MMO_NPCS: "kalle" } });
	const srv = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	try {
		// too few coins for the large ship (economy.ts byShip): he walks to the ferry, by the cliff head
		const west = r.space("west");
		await eventually(() => west.readIfExists({ type: "Character", fields: { charId: "npc-kalle" } }, 1_000), 20_000, "Kalle");
		for (const e of (await west.readAll({ type: "Item", fields: { location: "npc-kalle", proto: "muenze" } })).slice(2)) await west.takeIfExists({ id: e.id }, 1_000);
		await r.npcProcess("west");
		await r.npcProcess("ost");
		const { p } = await guest(srv.url);
		await lightFire(r.space("west"), 600_000, "feuer-bucht");
		await lightFire(r.space("west"), 600_000, "feuer-anleger");
		for (const [line, room] of [["go ost", "klippenpfad"], ["go ost", "klippenkopf"]] as const) {
			await through(p, line, room);
		}
		// Kalle comes by on his way from the bay to Kupferhafen (another region)
		await eventually(async () => (await r.space("west").readAll({ type: "Character", fields: { charId: "npc-kalle", room: "klippenkopf" } })).length === 1, 120_000, "Kalle at the cliff head");
		// a round of his is soon over: he stays while someone is here
		await new Promise((ok) => setTimeout(ok, 1500));
		const n = p.frames.length;
		p.send("hallo kalle");
		await p.until((f) => f.t === "msg" && /^Kalle: .*ich kaufe/.test(f.m.text), 20_000, n);
		const lines = p.frames.slice(n).flatMap((f) => (f.t === "msg" ? [f.m.text] : []));
		assert.ok(lines.some((t) => /: hallo kalle$/.test(t)), lines.join("\n"));
		assert.ok(!lines.some((t) => t.includes("→ say")), lines.join("\n"));
	} finally { await srv.close(); await r.close(); }
});
