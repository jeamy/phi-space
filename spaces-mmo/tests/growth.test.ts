// The sizes (docs/siedeln.en.md): a full room grows by a strip on a free side, a fire's light grows with the people who build
// there, one account keeps two animal houses, cattle come with the town.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { freeSide, grownDecor, grownGround, growthTick } from "../server/engine/commands/growth.ts";
import { loadWorld } from "../server/engine/world.ts";
import { initialClock } from "../server/engine/worldtime.ts";
import type { CharacterFields, RoomFields, RoomGrowthFields } from "../server/model.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer, startStack } from "./stack.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";

const w = await loadWorld();
const room = (ground: string[]): RoomFields => ({ roomId: "r", name: "Testwiese", desc: "", ground });
const grass = (wide: number, high: number) => Array.from({ length: high }, () => ",".repeat(wide));

test("a room grows east first, then south, never past its size, nor to a beach or an exit", () => {
	assert.deepEqual(grownGround(["ab", "cd"], { east: 1, south: 1 }, ","), ["ab,", "cd,", ",,,"]);
	assert.deepEqual(grownDecor(["  "], { east: 1, south: 0 }), ["   "]);
	assert.equal(freeSide(w, room(grass(24, 16)), []), "east");
	assert.equal(freeSide(w, room(grass(24, 16)), [{ x: 23, y: 5 }]), "south");
	assert.equal(freeSide(w, room(grass(24, 16)), [{ x: 23, y: 5 }, { x: 4, y: 15 }]), null);
	assert.equal(freeSide(w, room(grass(36, 16)), []), "south");
	assert.equal(freeSide(w, room(grass(36, 24)), []), null, "the largest a room gets");
	assert.equal(freeSide(w, room(Array.from({ length: 16 }, () => ",".repeat(23) + "~")), []), "south", "not into the sea");
});

test("a full room grows once, what it grew stays in its entry, and the next count waits for land to fill", { timeout: 120_000 }, async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		await s.write({ type: "WorldClock", fields: initialClock(w.id, 12, Date.now(), 1) as never }, null, FOREVER);
		await s.write({ type: "Room", fields: room(grass(24, 16)) as never }, null, FOREVER);
		assert.equal(await growthTick(s, w, 60_000), 0, "empty: nothing grows");
		for (let i = 0; i < 270; i++) await s.write({ type: "Plot", fields: { room: "r", x: i % 24, y: Math.floor(i / 24), of: "b" } as never }, null, FOREVER);
		const both = await Promise.all([growthTick(s, w, 60_000), growthTick(s, w, 60_000)]);
		assert.equal(both[0]! + both[1]!, 1, "two workers grow it once");
		const r = (await s.readAll({ type: "Room", fields: { roomId: "r" } }))[0]!.fields as unknown as RoomFields;
		assert.equal(r.ground[0]!.length, 28);
		assert.equal(((await s.readAll({ type: "RoomGrowth" }))[0]!.fields as unknown as RoomGrowthFields).east, 4);
		assert.equal(await growthTick(s, w, 60_000), 0, "now less than 70 % is taken");
	} finally { await stack.close(); }
});

async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const give = async (s: SpaceLike, charId: string, proto: string) => { const p = (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!; await spawn(s, null, w, p, { location: charId, x: -1, y: -1 }); };

test("a fire carries 20 and grows with a builder; two animal houses are the most; cattle wait for the town", { timeout: 180_000 }, async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		await lightFire(s, 600_000, "feuer-bucht");
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Ole", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		const c = (await eventually(async () => (await s.readAll({ type: "Character", fields: { charId: me } }))[0], 10_000, me))!.fields as unknown as CharacterFields & { accountId: string };
		const accountId = (await s.readAll({ type: "Character", fields: { charId: me } }))[0]!.fields.accountId as string | undefined;
		await s.write({ type: "LightUse", fields: { beaconId: "feuer-bucht", used: 20 } as never }, null, FOREVER, { unique: ["beaconId"] });
		assert.match(await does(p, "bau regentonne", "Licht"), /Licht des Feuers reicht/);
		const key = accountId ?? (await s.readAll({ type: "Account" })).map((e) => e.fields as { accountId: string; name: string }).find((a) => a.name === "Ole")?.accountId ?? c.accountId;
		await s.write({ type: "FireBuilder", fields: { beaconId: "feuer-bucht", accountId: "someone", atWorldMs: Date.now() * 2 } as never }, null, FOREVER);
		assert.doesNotMatch(await does(p, "bau regentonne", /steckt eine Baustelle ab|passt keine/), /Licht/, "a builder here widened the light");
		for (const e of await s.readAll({ type: "Site" })) await s.takeIfExists({ id: e.id }, 0);
		for (const i of [0, 1]) await s.write({ type: "Building", fields: { buildId: `stall${i}`, plan: "huehnerstall", name: "Hühnerstall", room: c.room, x: 1, y: 1 + i, w: 1, h: 1, owner: me, ownerName: "Ole", accountId: key, beaconId: "feuer-bucht", points: 1, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		assert.match(await does(p, "bau hühnerstall", "Ställe"), /Mehr als 2 Ställe und Gehege/);
		await s.write({ type: "Building", fields: { buildId: "pen", plan: "gehege", name: "Gehege", room: c.room, x: c.x + 1, y: c.y, w: 1, h: 1, owner: me, ownerName: "Ole", accountId: key, beaconId: "feuer-bucht", points: 2, by: {}, untilWorldMs: FOREVER, builtAt: 0 } as never }, null, FOREVER);
		await give(s, me, "rind");
		assert.match(await does(p, "einstallen rind", "braucht"), /Rinder braucht/);
	} finally { await srv.close(); }
});
