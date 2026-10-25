// Beacons, fog and the tide (docs/spielidee.md, docs/phasen.md Phase 2). A fire is a Flame entry whose lease is its burn
// time left: nobody has to put it out, the space removes it at the computed moment. Feeding takes the Beacon entry (the
// lock of its fire), the fuel and the old flame in one transaction and writes a longer one. The tickers turn what the
// space shows into the world's weather: the fire tick notices a fire that went out or came back, the fog tick moves each
// covered room's fog one step, the tide spawns flotsam with a lease of its own.
import { randomInt } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf, type BeaconFields, type ContributionFields, type FlameFields, type FogFields, type ItemFields } from "../model.ts";
import { CommandError, msg, type CommandCtx } from "./context.ts";
import { resolvePrototype, spawn } from "./prototypes.ts";
import { gameMs } from "./time.ts";
import { walkable, type WorldDef } from "./world.ts";

/** The flame of a beacon, or null when it is out. */
export async function flameOf(space: SpaceLike, beaconId: string, txn?: string): Promise<FlameFields | null> {
	const e = await space.readIfExists({ type: "Flame", fields: { beaconId } }, NO_WAIT, txn ? { txn } : {});
	return e ? fieldsOf<FlameFields>(e) : null;
}

/** "brennt noch etwa 12 Minuten" / "ist erloschen", in game minutes. */
export function burnText(f: FlameFields | null, now = Date.now()): string {
	if (!f || f.until <= now) return "ist erloschen";
	const min = Math.max(1, Math.round((f.until - now) / gameMs(60_000, 1)));
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
	const now = Date.now(), add = gameMs(fuel), max = gameMs(c.world.fire.maxMs);
	const old = await c.space.take({ type: "Flame", fields: { beaconId: beacon.beaconId } }, NO_WAIT, { txn: c.txn });
	const was = old ? fieldsOf<FlameFields>(old) : null;
	const left = was && was.until > now ? was.until - now : 0;
	const until = now + Math.min(max, left + add);
	await c.space.write({ type: "Flame", fields: { beaconId: beacon.beaconId, until, litAt: was?.litAt ?? now } satisfies FlameFields as never }, c.txn, until - now);
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
		if (!seen || !!(await flameOf(space, def.beaconId)) === !!seen.fields.lit) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const b = await space.takeIfExists({ type: "Beacon", fields: { beaconId: def.beaconId } }, NO_WAIT, { txn });
			if (!b) { await space.abort(txn); continue; } // someone is feeding it right now
			const beacon = fieldsOf<BeaconFields>(b);
			const lit = !!(await flameOf(space, def.beaconId, txn));
			await space.write({ type: "Beacon", fields: { ...beacon, lit } as never }, txn, FOREVER);
			if (lit !== beacon.lit) await say(space, leaseMs, beacon.covers, "world", lit ? `Das ${beacon.name} brennt.` : `Das ${beacon.name} ist erloschen. Der Nebel kriecht heran.`, txn);
			await space.commit(txn);
		} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
	}
}

/** Fog tick: each room a beacon covers gets one step clearer while it burns, one step denser while it is out. */
export async function fogTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	for (const def of w.beacons) {
		const lit = !!(await flameOf(space, def.beaconId));
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

/** The tide: in each flood room below its maximum, one piece of flotsam on a free cell of the room's tile, with the
 *  world's lifetime as lease (picked up, it is written anew without one and stays). */
export async function floodTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	const total = w.flood.protos.reduce((s, p) => s + p.weight, 0);
	for (const fr of w.flood.rooms) {
		if ((await space.count({ type: "Item", fields: { location: fr.room, flotsam: true } })) >= fr.max) continue;
		const room = w.rooms.find((r) => r.roomId === fr.room)!;
		const taken = new Set([...(await space.readAll({ type: "Item", fields: { location: fr.room } })), ...(await space.readAll({ type: "Exit", fields: { location: fr.room } }))].map((e) => `${e.fields.x},${e.fields.y}`));
		const cells: Array<{ x: number; y: number }> = [];
		room.ground.forEach((row, y) => [...row].forEach((t, x) => { if (t === fr.tile && walkable(w, room.ground, x, y) && !taken.has(`${x},${y}`)) cells.push({ x, y }); }));
		if (!cells.length) continue;
		let r = randomInt(0, total);
		const pick = w.flood.protos.find((p) => (r -= p.weight) < 0)!;
		const proto = await resolvePrototype(space, pick.proto);
		if (!proto) continue;
		const at = cells[randomInt(0, cells.length)]!;
		const item = await spawn(space, null, w, proto, { location: fr.room, x: at.x, y: at.y, flotsam: true, lease: gameMs(w.flood.lifetimeMs) });
		await say(space, leaseMs, [fr.room], "info", `Die Flut spült ${item.name} an.`);
	}
}
