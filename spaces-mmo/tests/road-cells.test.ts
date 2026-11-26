// A road's cells while its road is being worked on (inventory 7.4, the gap left by step 6; plan section 3, "Locks"): a
// delivery, a vote or a mend takes the road's Route and its Road parts and writes them back, so for that transaction
// they are not visible to others. A builder must still see the road's cells: they are kept in RoadCells entries of
// their own, which only a holder of the rooms' locks writes or takes (a plan, a road given up or lapsed), never a
// delivery. Here a transaction of the test holds the road's Route and Road parts as a delivery does, and `bau` onto a
// road cell is refused, with nothing staked.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces";
import type { ServerFrame } from "../server/gateway.ts";
import { loadWorld } from "../server/engine/world.ts";
import { roadCellsEntries, roadEntries } from "../server/engine/commands/road.ts";
import type { RouteFields } from "../server/model.ts";
import { eventually, lightFire, Player, startServer } from "./stack.ts";

const ROOM = "graue-bucht", OTHER = "klippenpfad";
const w = await loadWorld();

test("a road being delivered to keeps its cells: bau onto one is refused while the delivery's transaction holds the road", { timeout: 240_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.001" } });
	try {
		const s = srv.stack.space;
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Baumeisterin", password: "geheim-123" })).status, 200);
		const me = (await p.play()).me.charId;
		p.send("move 16 11");
		await eventually(async () => { const c = (await s.readAll({ type: "Character", fields: { charId: me } }))[0]?.fields; return c?.x === 16 && c?.y === 11; }, 40_000, "at 16,11");
		await lightFire(s, 600_000, "feuer-bucht");
		const island = w.rooms.find((r) => r.roomId === ROOM)!.island!;
		// a road under construction whose cells run along row 13 under the hut's place (16,12 to 17,13)
		const cells = [...Array.from({ length: 9 }, (_, i) => ({ room: ROOM, x: 12 + i, y: 13 })), { room: OTHER, x: 5, y: 5 }, { room: OTHER, x: 6, y: 5 }];
		const route: RouteFields = { routeId: "r-test", pair: [ROOM, OTHER].sort().join("|"), island, rooms: [ROOM, OTHER], names: ["Graue Bucht", "Klippenpfad"], cells, state: "build", planner: me, plannerName: "Baumeisterin", accountId: "a", voters: [], yes: [], no: [], voteUntil: 0, needs: [{ proto: "stein", name: "Stein", count: 20, have: 0 }], work: 0, workNeed: 10, by: {}, untilWorldMs: 9e15, at: 0, points: 2 };
		for (const e of [...roadEntries(route), ...roadCellsEntries(route)]) await s.write(e as never, null, FOREVER);
		// the road seen: bau onto it is refused
		const said = async (line: string) => { const from = p.frames.length; p.send(line); const f = await p.until((f) => f.t === "msg" && /steckt eine Baustelle ab|passt keine?|gerade gebaut/.test(f.m.text), 40_000, from); return (f as Extract<ServerFrame, { t: "msg" }>).m.text; };
		assert.match(await said("bau hütte 16 12"), /Dort führt eine Straße entlang/);

		// a delivery's transaction: the Route and its Road parts taken, to be written back at its commit
		const txn = (await s.createTransaction(60_000)).id;
		assert.ok(await s.takeIfExists({ type: "Route", fields: { routeId: "r-test" } }, 5_000, { txn }));
		for (const e of await s.readAll({ type: "Road", fields: { routeId: "r-test" } }, { txn })) assert.ok(await s.takeIfExists({ id: e.id }, 5_000, { txn }));
		assert.match(await said("bau hütte 16 12"), /Dort führt eine Straße entlang/);
		assert.equal((await s.readAll({ type: "Site", fields: { room: ROOM } })).length, 0, "nothing staked on the road");
		await s.abort(txn);
	} finally { await srv.close(); }
});
