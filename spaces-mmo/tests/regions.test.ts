// The regions of Leuchtfeuer (server/engine/regions.ts) and the handover of a character between two region spaces
// (server/engine/handover.ts), against two spaces of their own.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { FOREVER, NO_WAIT, serveSpace, SpaceService, startService, StaticIdentity, type SpaceLike } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost } from "phi-spaces/store/host";
import { world } from "../worlds/leuchtfeuer/world.ts";
import { checkRegions, regionOfRoom, regionsOf, regionWorld } from "../server/engine/regions.ts";
import { arrive, deliver, handOff, type HandoverFields } from "../server/engine/handover.ts";
import { connectSpace, parseTarget } from "../server/space.ts";
import { actorToken, type CharacterFields } from "../server/model.ts";
import type { CommandCtx } from "../server/engine/context.ts";

test("every island in exactly one region, each region starts in a bay of its own, and only ferries cross between them", () => {
	checkRegions(world);
	const regions = regionsOf(world);
	assert.ok(regions.length >= 4, `${regions.length} regions`);
	const parts = regions.map((g) => regionWorld(world, g.regionId));
	assert.deepEqual(parts.flatMap((p) => p.rooms.map((r) => r.roomId)).sort(), world.rooms.map((r) => r.roomId).sort(), "every room in one region");
	for (const p of parts) {
		assert.ok(p.rooms.some((r) => r.roomId === p.start), `${p.region} starts in one of its rooms`);
		assert.ok(p.beacons.some((b) => b.covers.includes(p.start)), `${p.region}: a fire keeps its start clear`);
		assert.ok(world.npcs.some((n) => n.script === "huter" && p.beacons.some((b) => b.beaconId === n.beacon && b.covers.includes(p.start))), `${p.region}: a keeper of the start's fire`);
		assert.ok(p.market.rooms.length >= 1, `${p.region} has a market`);
		for (const b of p.beacons) for (const room of b.covers) assert.equal(regionOfRoom(world, room), p.region, `${b.beaconId} covers ${room} of its own region`);
		for (const e of p.exits) if (regionOfRoom(world, e.destination) !== p.region) assert.match(e.exitId, /-faehre-/, `${e.exitId}: only a ferry leaves the region`);
	}
});

const serve = async (sock: string) => {
	const host = openOwnMemoryHost(), stop = await startService(host, ctx, { watchDebounceMs: 10 });
	const server = await serveSpace(new SpaceService({ host, ctx, identity: new StaticIdentity({ p: { principal: { peerId: "p" }, roles: ["member"] } }), wakeOnCommit: true }), { listen: parseTarget(sock), connection: () => ({ peerId: "p" }) });
	const conn = connectSpace(sock);
	return { space: conn.space, async close() { conn.close(); await server.close(); await stop(); } };
};

test("a character crosses to another region with its pack and account, exactly once, and a repeated delivery changes nothing", async () => {
	const a = await serve(`unix:/tmp/mmo-region-a-${process.pid}.sock`), b = await serve(`unix:/tmp/mmo-region-b-${process.pid}.sock`);
	const west = regionWorld(world, "west"), nord = regionWorld(world, "nord");
	const halt = new AbortController();
	try {
		const ch: CharacterFields = { charId: "c-1", accountId: "a-1", name: "Kai", room: "klippenkopf", x: 12, y: 1, skin: 0, guest: false };
		await a.space.write({ type: "Account", fields: { accountId: "a-1", name: "Kai", guest: false, admin: false, createdAt: 1, touchedAt: 1 } }, null, FOREVER);
		await a.space.write({ type: "Character", fields: ch as never }, null, FOREVER);
		await a.space.write(actorToken("c-1"), null, FOREVER);
		await a.space.write({ type: "Spot", fields: { room: "klippenkopf", x: 12, y: 1, charId: "c-1", name: "Kai" } }, null, FOREVER);
		for (const itemId of ["m-1", "m-2"]) await a.space.write({ type: "Coin", types: ["Item"], fields: { itemId, proto: "muenze", name: "Münze", location: "c-1", x: -1, y: -1 } }, null, FOREVER);
		const room = nord.rooms.find((r) => r.roomId === "moewenfels-strand")!;
		await b.space.write({ type: "Room", fields: { roomId: room.roomId, name: room.name, desc: "", ground: room.ground, spawn: room.spawn } }, null, FOREVER);
		// step 1 in a command's transaction of A
		const txn = (await a.space.createTransaction(10_000)).id;
		await handOff({ space: a.space, txn, world: west, actor: ch, account: null, msgLeaseMs: 60_000, cache: {} } satisfies CommandCtx, "west", "nord", { room: "moewenfels-strand", x: 12, y: 14 });
		await a.space.commit(txn);
		assert.equal((await a.space.readAll({ type: "Character" })).length, 0, "in neither region now");
		assert.equal((await a.space.readAll({ type: "Item" })).length, 0);
		const [h] = await a.space.readAll({ type: "Handover" });
		// a delivery that got as far as B before its worker died: the next one finds the character there and writes nothing twice
		assert.equal(await arrive(b.space, nord, h!.fields as unknown as HandoverFields), true);
		const regions = new Map<string, SpaceLike>([["nord", b.space]]);
		const running = deliver(a.space, regions, west, halt.signal);
		for (let i = 0; i < 100 && (await a.space.readAll({ type: "Handover" })).length; i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal((await a.space.readAll({ type: "Handover" })).length, 0, "delivered");
		assert.equal(await a.space.readIfExists(actorToken("c-1"), NO_WAIT), null, "the old token is gone");
		const there = await b.space.readAll({ type: "Character" });
		assert.equal(there.length, 1);
		assert.equal(there[0]!.fields.room, "moewenfels-strand");
		assert.deepEqual((await b.space.readAll({ type: "Item" })).map((e) => [e.fields.itemId, e.types]).sort(), [["m-1", ["Coin", "Item"]], ["m-2", ["Coin", "Item"]]], "the pack, with its types");
		assert.equal((await b.space.readAll({ type: "Account" })).length, 1);
		assert.ok(await b.space.readIfExists(actorToken("c-1"), NO_WAIT), "a token in B");
		assert.equal((await b.space.readAll({ type: "Spot", fields: { charId: "c-1" } })).length, 1, "a cell in B");
		halt.abort();
		await running;
	} finally { halt.abort(); await a.close(); await b.close(); }
});
