// Sleep (engine/commands/sleep.ts, docs/innenraeume.en.md "Sleep"): beside the bed of one's hut the figure lies down; the
// next command only wakes it, with one rested work per `sleep.rate` world minutes slept; a rested work writes no rest,
// and when they are used up the rest after work is back. The bed holds one; an invited guest sleeps in it when it is
// free; at most `sleep.max`; put out of the house, the guest wakes outside with what it slept.
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
async function walk(p: Player, space: SpaceLike, charId: string, x: number, y: number): Promise<void> {
	p.send(`move ${x} ${y}`);
	await eventually(async () => { const f = await charOf(space, charId); return f.x === x && f.y === y ? f : null; }, 10_000, `${charId} at ${x} ${y}`);
}
/** Lets the sleep of `charId` have begun `mins` world minutes ago. */
async function slept(space: SpaceLike, charId: string, mins: number): Promise<void> {
	const e = await space.takeIfExists({ type: "Sleep", fields: { charId } }, 2_000);
	assert.ok(e, `${charId} asleep`);
	await space.write({ type: "Sleep", fields: { ...e.fields, sinceWorldMs: Number(e.fields.sinceWorldMs) - mins * 60_000 } as never }, null, FOREVER);
}
const restedLeft = async (space: SpaceLike, charId: string) => Number((await space.readAll({ type: "Rested", fields: { charId } }))[0]?.fields.left ?? 0);
const resting = async (space: SpaceLike, charId: string) => (await space.readAll({ type: "WorkRest", fields: { charId } })).length;

test("sleep in the hut's bed: woken by the next command, rested works by the time slept, no rest after them, at most eight; a guest in the free bed", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const host = new Player(srv.url), guest = new Player(srv.url);
		assert.equal((await host.post("/api/register", { name: "Schlaefer", password: "geheim-123" })).status, 200);
		assert.equal((await guest.post("/api/register", { name: "Gast", password: "geheim-123" })).status, 200);
		const me = (await host.play()).me.charId, other = (await guest.play()).me.charId;
		const c = await charOf(s, me);
		const now = await worldNowOf(s);
		await s.write({ type: "Building", fields: { buildId: "h-bett", plan: "huette", name: "Hütte", room: c.room, x: c.x + 1, y: c.y - 1, w: 2, h: 2, owner: me, ownerName: "Schlaefer", accountId: c.accountId, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, FOREVER);
		const inside = "in-h-bett";

		// away from the bed, and outside, there is no sleep
		assert.match(await does(host, "schlafe", "Bett einer Hütte"), /betrete/);
		await does(host, "betrete", "Du kommst herein");
		assert.match(await does(host, "schlafe", "Geh zum"), /Bett/);
		await walk(host, s, me, 4, 1);
		await does(host, "einladen Gast", "darf jetzt");
		// tired from a work before it lies down
		await s.write({ type: "WorkRest", fields: { charId: me, untilWorldMs: now + 3600_000 } as never }, null, FOREVER);
		await does(host, "schlafe", "schläfst ein");
		assert.equal((await s.readAll({ type: "Sleep", fields: { charId: me } })).length, 1);
		assert.match(await does(host, "schlafe", "schläfst schon"), /schon/);

		// the guest: the bed holds one
		guest.send(`move ${c.x} ${c.y}`);
		await eventually(async () => { const f = await charOf(s, other); return Math.max(Math.abs(f.x - (c.x + 1)), Math.abs(f.y - c.y)) <= 1 && f.room === c.room ? f : null; }, 10_000, "the guest beside the hut");
		await does(guest, "betrete", "Du kommst herein");
		await walk(guest, s, other, 4, 2);
		assert.match(await does(guest, "schlafe", "schläft schon"), /Schlaefer/);

		// 100 minutes: three rested works, the rest from before is over; the command that woke it did nothing else
		await slept(s, me, 100);
		const woke = await does(host, "look", "Du wachst auf");
		assert.match(woke, /3 Arbeiten/);
		assert.equal((await s.readAll({ type: "Sleep", fields: { charId: me } })).length, 0);
		assert.equal(await restedLeft(s, me), 3);
		assert.equal(await resting(s, me), 0);

		// a rested work writes no rest; the fourth does
		await s.write({ type: "Scenery", fields: { sceneryId: "kiste-bett", room: inside, x: 3, y: 2, w: 1, h: 1, model: "kiste", name: "Kiste", fixed: false, work: 0, left: 9, yields: [] } as never }, null, FOREVER);
		for (const left of [2, 1, 0]) {
			await does(host, "räume 3 2", left ? `noch ${left === 1 ? "eine Arbeit" : `${left} Arbeiten`} ohne Pause` : "letzte Arbeit ohne Pause");
			assert.equal(await restedLeft(s, me), left);
			assert.equal(await resting(s, me), 0, "no rest after a rested work");
		}
		await does(host, "räume 3 2", "räumt auf");
		await eventually(async () => ((await resting(s, me)) ? true : null), 10_000, "the rest after work is back");
		assert.match(await does(host, "räume 3 2", "müde"), /Minuten/);

		// the bed is free: the guest sleeps in it, long; put out, it wakes outside with at most eight
		await walk(host, s, me, 3, 4);
		await does(guest, "schlafe", "schläfst ein");
		await slept(s, other, 600);
		await does(host, "ausladen Gast", "darf nicht mehr");
		await eventually(async () => ((await charOf(s, other)).room === c.room ? true : null), 10_000, "the guest outside");
		assert.equal((await s.readAll({ type: "Sleep", fields: { charId: other } })).length, 0);
		assert.equal(await restedLeft(s, other), 8);
		await host.leave(); await guest.leave();
	} finally { await srv.close(); }
});
