// The admin moves what stands on cells of its own (engine/commands/builder.ts versetze; the map's edit mode sends it):
// a building with its cells, its inside's record and the way out of it; a bed with its plants; refused where nothing may
// be built (beside the fire, on another's cells); for a player the command does not exist.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpaceLike } from "phi-spaces";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { worldNowOf } from "../server/engine/clock.ts";
import { makeInterior } from "../server/engine/commands/interior.ts";
import { eventually, Player, startServer } from "./stack.ts";

const w = await loadWorld();
async function says(p: Player, line: string, text: RegExp, ms = 40_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && text.test(f.m.text), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
async function player(url: string, name: string, token?: string): Promise<{ p: Player; me: string }> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123", ...(token ? { setupToken: token } : {}) })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
const charOf = async (space: SpaceLike, charId: string) => (await eventually(async () => (await space.readAll({ type: "Character", fields: { charId } }))[0] ?? null, 10_000, `character ${charId}`))!.fields as { accountId: string; room: string; x: number; y: number };
const one = async (space: SpaceLike, type: string, fields: Record<string, unknown>) => (await space.readAll({ type, fields: fields as never }))[0]?.fields as Record<string, any> | undefined;
const plots = async (space: SpaceLike, of: string) => (await space.readAll({ type: "Plot", fields: { of } })).map((e) => `${e.fields.x},${e.fields.y}`).sort();
const cellsOf = (x: number, y: number, wd: number, h: number) => { const out: string[] = []; for (let j = y; j < y + h; j++) for (let i = x; i < x + wd; i++) out.push(`${i},${j}`); return out.sort(); };

test("versetze: a building with its cells and its inside's door, a bed with its plants; refused beside the fire and on another's cells; not for a player", { timeout: 240_000 }, async () => {
	const srv = await startServer({ accountOptions: { setupToken: "t" } });
	try {
		const s = srv.stack.space;
		const admin = await player(srv.url, "Betreiberin", "t"), other = await player(srv.url, "Spielerin");
		const c = await charOf(s, admin.me), now = await worldNowOf(s);
		const fire = w.beacons.find((b) => b.room === c.room)!;
		// a free spot on the bay's grass, with room round it: nothing held there or beside it, far from the fire
		const ground = w.rooms.find((r) => r.roomId === c.room)!.ground as string[];
		const held = new Set((await s.readAll({ type: "Plot", fields: { room: c.room } })).map((e) => `${e.fields.x},${e.fields.y}`));
		const free = (x: number, y: number, wd: number, h: number) => cellsOf(x - 1, y - 1, wd + 2, h + 2).every((k) => { const [i, j] = k.split(",").map(Number); return ground[j!]?.[i!] === "," && !held.has(k); }) && Math.max(Math.abs(x - fire.x), Math.abs(y - fire.y)) > 4;
		let spot: { x: number; y: number } | null = null;
		for (let y = 2; y < ground.length && !spot; y++) for (let x = 2; x < ground[0]!.length - 8 && !spot; x++) if (free(x, y, 8, 2)) spot = { x, y };
		assert.ok(spot, "a free stretch of grass");
		// a hut of the admin's there, with plots as `bau` leaves them
		const hx = spot.x, hy = spot.y;
		await s.write({ type: "Building", fields: { buildId: "h-v", plan: "huette", name: "Hütte", room: c.room, x: hx, y: hy, w: 2, h: 2, owner: admin.me, ownerName: "Betreiberin", accountId: c.accountId, beaconId: fire.beaconId, points: 1, by: {}, untilWorldMs: now + 7 * 24 * 3600_000, builtAt: now } as never }, null, 3_600_000_000);
		for (const p of cellsOf(hx, hy, 2, 2)) { const [x, y] = p.split(",").map(Number); await s.write({ type: "Plot", fields: { room: c.room, x, y, of: "h-v" } as never }, null, 3_600_000_000, { unique: ["room", "x", "y"] }); }
		// its inside, as the way in makes it once
		const txn = (await s.createTransaction(30_000)).id;
		await makeInterior(s, txn, w, (await one(s, "Building", { buildId: "h-v" })) as never);
		await s.commit(txn);
		const doorBefore = (await one(s, "Exit", { exitId: "x-in-h-v" }))!.arrive as { x: number; y: number };

		// for a player the command does not exist: nothing moves
		other.p.send(`versetze h-v ${hx + 1} ${hy}`);
		await new Promise((r) => setTimeout(r, 1_500));
		assert.equal((await one(s, "Building", { buildId: "h-v" }))!.x, hx);

		// beside the fire nothing is built, so nothing is moved there; an unknown id says so
		assert.match(await says(admin.p, `versetze h-v ${fire.x} ${fire.y + 1}`, /nicht versetzen|kein fester Boden|zu Ende/), /Dorthin lässt sich Hütte nicht versetzen/);
		assert.match(await says(admin.p, "versetze niemand 1 1", /Kennung/), /nichts mit der Kennung/);

		// one step to a free place: try the steps until one is free (the bay's ground decides)
		let moved: { x: number; y: number } | null = null;
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
			const t = await says(admin.p, `versetze h-v ${hx + dx} ${hy + dy}`, /steht jetzt|nicht versetzen/);
			if (/steht jetzt/.test(t)) { moved = { x: hx + dx, y: hy + dy }; break; }
		}
		assert.ok(moved, "a free place one or two steps away");
		const b = (await one(s, "Building", { buildId: "h-v" }))!;
		assert.deepEqual([b.x, b.y], [moved.x, moved.y]);
		assert.deepEqual(await plots(s, "h-v"), cellsOf(moved.x, moved.y, 2, 2), "its cells went with it");
		assert.deepEqual(((await one(s, "Room", { roomId: "in-h-v" }))!.building as { x: number; y: number }), { ...((await one(s, "Room", { roomId: "in-h-v" }))!.building), x: moved.x, y: moved.y });
		assert.deepEqual((await one(s, "Exit", { exitId: "x-in-h-v" }))!.arrive, { x: doorBefore.x + moved.x - hx, y: doorBefore.y + moved.y - hy }, "the way out leads out in front of it");

		// a bed with a plant: the plant goes with it; onto the hut's cells it does not go
		const bx = hx + 5, by = hy;
		await s.write({ type: "Bed", fields: { bedId: "bed-v", room: c.room, x: bx, y: by, w: 2, h: 2, owner: admin.me, ownerName: "Betreiberin", accountId: c.accountId, beaconId: fire.beaconId, points: 1, sponsors: [], plants: [{ x: bx + 1, y: by, sort: "strandnelke", stage: 1, dueWorldMs: now + 3_600_000 }], wateredWorldMs: now, weedy: false, dueWorldMs: 1e15, untilWorldMs: now + 3_600_000_000, at: now } as never }, null, 3_600_000_000);
		for (const p of cellsOf(bx, by, 2, 2)) { const [x, y] = p.split(",").map(Number); await s.write({ type: "Plot", fields: { room: c.room, x, y, of: "bed-v" } as never }, null, 3_600_000_000, { unique: ["room", "x", "y"] }); }
		assert.match(await says(admin.p, `versetze bed-v ${moved.x + 1} ${moved.y}`, /nicht versetzen/), /Beet/);
		let bedTo: { x: number; y: number } | null = null;
		for (const [dx, dy] of [[1, 0], [0, 1], [0, -1], [2, 0], [1, 1]] as const) {
			const t = await says(admin.p, `versetze bed-v ${bx + dx} ${by + dy}`, /steht jetzt|nicht versetzen/);
			if (/steht jetzt/.test(t)) { bedTo = { x: bx + dx, y: by + dy }; break; }
		}
		assert.ok(bedTo, "a free place for the bed");
		const bed = (await one(s, "Bed", { bedId: "bed-v" }))!;
		assert.deepEqual(bed.plants.map((p: { x: number; y: number }) => [p.x, p.y]), [[bedTo.x + 1, bedTo.y]]);
		assert.deepEqual(await plots(s, "bed-v"), cellsOf(bedTo.x, bedTo.y, 2, 2));
	} finally { await srv.close(); }
});
