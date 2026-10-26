// Beacons, fog and the tide (docs/spielidee.md, docs/phasen.md Phase 2), in world time (docs/weltzeit.md). A fire is a
// Flame entry that says until which world time it burns: nobody has to put it out, the clock decides, and a paused world
// keeps its fires. Feeding takes the Beacon entry (the lock of its fire), the fuel and the old flame in one transaction and
// writes a longer one. The world's dates turn what the clock shows into the weather: the fire tick notices a fire that went
// out or came back, the fog tick moves each covered room's fog one step, the tide spawns flotsam that the sweep takes away
// when its world time is up.
import { randomInt } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf, type BeaconFields, type ContributionFields, type FlameFields, type FogFields, type ItemFields } from "../model.ts";
import { CommandError, msg, type CommandCtx } from "./context.ts";
import { resolvePrototype, spawn } from "./prototypes.ts";
import { worldNowOf } from "./clock.ts";
import { walkable, type WorldDef } from "./world.ts";

/** The flame of a beacon, or null when it is out. */
export async function flameOf(space: SpaceLike, beaconId: string, txn?: string): Promise<FlameFields | null> {
	const e = await space.readIfExists({ type: "Flame", fields: { beaconId } }, NO_WAIT, txn ? { txn } : {});
	return e ? fieldsOf<FlameFields>(e) : null;
}

/** Whether the flame burns at world time `worldMs`. */
export const isLit = (f: FlameFields | null, worldMs: number): boolean => !!f && f.until > worldMs;

/** "brennt noch etwa 12 Minuten" / "ist erloschen", in world minutes at world time `worldMs`. */
export function burnText(f: FlameFields | null, worldMs: number): string {
	if (!f || f.until <= worldMs) return "ist erloschen";
	const min = Math.max(1, Math.round((f.until - worldMs) / 60_000));
	return `brennt noch etwa ${min} Minute${min === 1 ? "" : "n"}`;
}

/** Puts a carried fuel item into a beacon next to the actor: the flame burns longer (or is lit), the actor's
 *  contribution grows. All in the command's transaction. */
export async function feed(c: CommandCtx, item: { e: Taken; f: ItemFields }, beacon: BeaconFields): Promise<void> {
	const fuel = c.world.fire.fuel[item.f.proto];
	if (!fuel) throw new CommandError(`${item.f.name} brennt nicht.`);
	const b = await c.space.take({ type: "Beacon", fields: { beaconId: beacon.beaconId } }, 5_000, { txn: c.txn });
	if (!b) throw new CommandError("Gerade legt jemand anderes nach; einen Moment.");
	if (!(await c.space.take({ type: item.e.type, id: item.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${item.f.name} ist gerade nicht greifbar.`);
	const now = await worldNowOf(c.space, c.txn), add = fuel, max = c.world.fire.maxMs; // world milliseconds
	const old = await c.space.take({ type: "Flame", fields: { beaconId: beacon.beaconId } }, NO_WAIT, { txn: c.txn });
	const was = old ? fieldsOf<FlameFields>(old) : null;
	const left = was && was.until > now ? was.until - now : 0;
	const until = now + Math.min(max, left + add);
	await c.space.write({ type: "Flame", fields: { beaconId: beacon.beaconId, until, litAt: was?.litAt ?? now } satisfies FlameFields as never }, c.txn, FOREVER);
	await c.space.write({ type: "Beacon", fields: { ...fieldsOf<BeaconFields>(b), lit: true } as never }, c.txn, FOREVER);
	const mine = await c.space.take({ type: "Contribution", fields: { beaconId: beacon.beaconId, charId: c.actor.charId } }, NO_WAIT, { txn: c.txn });
	const had = mine ? fieldsOf<ContributionFields>(mine) : { beaconId: beacon.beaconId, charId: c.actor.charId, name: c.actor.name, pieces: 0, ms: 0 };
	await c.space.write({ type: "Contribution", fields: { ...had, name: c.actor.name, pieces: had.pieces + 1, ms: had.ms + fuel } satisfies ContributionFields as never }, c.txn, FOREVER);
	await msg(c, "*", "info", `$you() $conj(legst|legt) ${item.f.name} ins ${beacon.name}. Es ${burnText({ beaconId: beacon.beaconId, until, litAt: now }, now)}.`, { templ: true });
	if (!left) await say(c.space, c.msgLeaseMs, beacon.covers, "world", `Das ${beacon.name} flammt auf.`, c.txn);
}

/** A message from the world itself to everyone in `rooms`. */
async function say(space: SpaceLike, leaseMs: number, rooms: string[], kind: "world" | "info", text: string, txn: string | null = null): Promise<void> {
	for (const room of rooms) await space.write({ type: "Msg", fields: { room, to: "*", kind, text, from: "", at: Date.now() } as never }, txn, leaseMs);
}

/** Fire tick: a beacon whose flame lapsed (or came back) is marked so, and its rooms hear it. Only a change takes the
 *  beacon's lock: a tick that finds nothing new writes nothing (feeding is never kept waiting by a ticker that rewrites
 *  the beacon every round, and the change stream stays quiet). */
export async function fireTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	for (const def of w.beacons) {
		const seen = await space.readIfExists({ type: "Beacon", fields: { beaconId: def.beaconId } }, NO_WAIT);
		if (!seen || isLit(await flameOf(space, def.beaconId), await worldNowOf(space)) === !!seen.fields.lit) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const b = await space.takeIfExists({ type: "Beacon", fields: { beaconId: def.beaconId } }, NO_WAIT, { txn });
			if (!b) { await space.abort(txn); continue; } // someone is feeding it right now
			const beacon = fieldsOf<BeaconFields>(b);
			const lit = isLit(await flameOf(space, def.beaconId, txn), await worldNowOf(space, txn));
			await space.write({ type: "Beacon", fields: { ...beacon, lit } as never }, txn, FOREVER);
			if (lit !== beacon.lit) await say(space, leaseMs, beacon.covers, "world", lit ? `Das ${beacon.name} brennt.` : `Das ${beacon.name} ist erloschen. Der Nebel kriecht heran.`, txn);
			await space.commit(txn);
		} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
	}
}

/** Fog tick: each room a beacon covers gets one step clearer while it burns, one step denser while it is out. */
export async function fogTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	for (const def of w.beacons) {
		const lit = isLit(await flameOf(space, def.beaconId), await worldNowOf(space));
		for (const room of def.covers) {
			const txn = (await space.createTransaction(10_000)).id;
			try {
				const e = await space.takeIfExists({ type: "Fog", fields: { room } }, NO_WAIT, { txn });
				if (!e) { await space.abort(txn); continue; }
				const was = fieldsOf<FogFields>(e).level, level = Math.max(0, Math.min(w.fog.max, was + (lit ? -1 : 1)));
				await space.write({ type: "Fog", fields: { room, level } satisfies FogFields as never }, txn, FOREVER);
				if (level !== was) await say(space, leaseMs, [room], "world", fogText(level, level > was), txn);
				await space.commit(txn);
			} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
		}
	}
}

export const fogText = (level: number, denser: boolean): string =>
	[
		"Der Nebel reißt auf; die See liegt klar.",
		denser ? "Nebel zieht auf." : "Der Nebel lichtet sich.",
		denser ? "Der Nebel wird dicht; man sieht kaum zum Wasser." : "Der Nebel wird dünner; die Wege sind wieder zu erkennen.",
		"Dichter Nebel verschluckt die Wege.",
	][Math.min(3, level)]!;

export async function fogOf(space: SpaceLike, room: string): Promise<number> {
	const e = await space.readIfExists({ type: "Fog", fields: { room } }, NO_WAIT);
	return e ? fieldsOf<FogFields>(e).level : 0;
}

/** Free cells of `tile` in a room (no thing, exit or fire on them). */
async function freeCells(space: SpaceLike, w: WorldDef, roomId: string, tile: string): Promise<Array<{ x: number; y: number }>> {
	const room = w.rooms.find((r) => r.roomId === roomId)!;
	const taken = new Set([...(await space.readAll({ type: "Item", fields: { location: roomId } })), ...(await space.readAll({ type: "Exit", fields: { location: roomId } })), ...(await space.readAll({ type: "Beacon", fields: { room: roomId } }))].map((e) => `${e.fields.x},${e.fields.y}`));
	const cells: Array<{ x: number; y: number }> = [];
	room.ground.forEach((row, y) => [...row].forEach((t, x) => { if (t === tile && walkable(w, room.ground, x, y) && !taken.has(`${x},${y}`)) cells.push({ x, y }); }));
	return cells;
}

const weighted = (protos: Array<{ proto: string; weight: number }>) => {
	let r = randomInt(0, protos.reduce((s, p) => s + p.weight, 0));
	return protos.find((p) => (r -= p.weight) < 0)!.proto;
};

/** The tide: in each flood room below its maximum, one piece of flotsam on a free cell of the room's tile (the room's
 *  own things, else the world's), with the world's lifetime as `expiresWorldMs` (the sweep takes it away then; picked up, it
 *  is written anew without the date and stays). */
export async function floodTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	for (const fr of w.flood.rooms) {
		if ((await space.count({ type: "Item", fields: { location: fr.room, flotsam: true } })) >= fr.max) continue;
		const cells = await freeCells(space, w, fr.room, fr.tile);
		if (!cells.length) continue;
		const proto = await resolvePrototype(space, weighted(fr.protos ?? w.flood.protos));
		if (!proto) continue;
		const at = cells[randomInt(0, cells.length)]!;
		const item = await spawn(space, null, w, proto, { location: fr.room, x: at.x, y: at.y, flotsam: true, expiresWorldMs: (await worldNowOf(space)) + w.flood.lifetimeMs });
		await say(space, leaseMs, [fr.room], "info", `Die Flut spült ${item.name} an.`);
	}
}

/** A storm surge: on the beach of one of the storm's rooms `count` things at once (leased like flotsam), and everyone
 *  hears on the channel where. Who comes first finds the most. */
export async function stormTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<string | null> {
	if (!w.storm?.rooms.length) return null;
	const roomId = w.storm.rooms[randomInt(0, w.storm.rooms.length)]!;
	const cells = await freeCells(space, w, roomId, ".");
	const names: string[] = [];
	for (let i = 0; i < w.storm.count && cells.length; i++) {
		const proto = await resolvePrototype(space, weighted(w.storm.protos));
		if (!proto) continue;
		const at = cells.splice(randomInt(0, cells.length), 1)[0]!;
		names.push((await spawn(space, null, w, proto, { location: roomId, x: at.x, y: at.y, flotsam: true, expiresWorldMs: (await worldNowOf(space)) + w.flood.lifetimeMs * 2 })).name);
	}
	if (!names.length) return null;
	const room = w.rooms.find((r) => r.roomId === roomId)!;
	await space.write({ type: "Msg", fields: { room: roomId, to: `#${w.storm.channel}`, kind: "channel", text: `[${w.storm.channel}] Sturmflut in ${room.name} (${room.island ?? w.title})! Das Meer wirft Strandgut aus.`, from: "", at: Date.now() } as never }, null, leaseMs);
	await say(space, leaseMs, [roomId], "world", `Eine Sturmflut rollt heran und lässt ${names.length} Dinge am Strand zurück: ${[...new Set(names)].join(", ")}.`);
	return roomId;
}
