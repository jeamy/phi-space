// Beacons, fog and the tide (docs/spielidee.en.md, docs/phasen.en.md Phase 2), in world time (docs/weltzeit.en.md). A fire is a
// Flame entry that says until which world time it burns: nobody has to put it out, the clock decides, and a paused world
// keeps its fires. Feeding takes the Beacon entry (the lock of its fire), the fuel and the old flame in one transaction and
// writes a longer one. The world's dates turn what the clock shows into the weather: the fire tick notices a fire that went
// out or came back, the fog tick moves each covered room's fog one step, the tide spawns flotsam that the sweep takes away
// when its world time is up.
import { FOREVER, NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf, type BeaconFields, type BuildingFields, type ContributionFields, type FireChainFields, type FlameFields, type FogFields, type ItemFields } from "../model.ts";
import { CommandError, msg, msgOptions, type CommandCtx } from "./context.ts";
import { resolvePrototype, spawn } from "./prototypes.ts";
import { patienceOf, worldNowOf } from "./clock.ts";
import { walkable, type WorldDef } from "./world.ts";
import { peek } from "../space.ts";
import { randomInt, timeNow } from "./source.ts";

/** The flame of a beacon, or null when it is out. */
export async function flameOf(space: SpaceLike, beaconId: string, txn?: string): Promise<FlameFields | null> {
	const e = await peek(space, { type: "Flame", fields: { beaconId } }, txn ? { txn } : {});
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
export async function feed(c: CommandCtx, item: { e: Taken; f: ItemFields }, beacon: BeaconFields, o: { quiet?: boolean } = {}): Promise<{ until: number; now: number }> {
	const fuel = c.world.fire.fuel[item.f.proto];
	if (!fuel) throw new CommandError(`${item.f.name} brennt nicht.`);
	const b = await c.space.take({ type: "Beacon", fields: { beaconId: beacon.beaconId } }, 5_000, { txn: c.txn });
	if (!b) throw new CommandError("Gerade legt jemand anderes nach; einen Moment.");
	if (!(await c.space.take({ type: item.e.type, id: item.e.id }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${item.f.name} ist gerade nicht greifbar.`);
	const now = await worldNowOf(c.space, c.txn), patient = await patienceOf(c.space, c.txn), add = fuel * patient, max = c.world.fire.maxMs * patient; // a log burns as long whatever the life of the world
	const old = await c.space.take({ type: "Flame", fields: { beaconId: beacon.beaconId } }, NO_WAIT, { txn: c.txn });
	const was = old ? fieldsOf<FlameFields>(old) : null;
	const left = was && was.until > now ? was.until - now : 0;
	const until = now + Math.min(max, left + add);
	await c.space.write({ type: "Flame", fields: { beaconId: beacon.beaconId, until, litAt: was?.litAt ?? now } satisfies FlameFields as never }, c.txn, FOREVER);
	await c.space.write({ type: "Beacon", fields: { ...fieldsOf<BeaconFields>(b), lit: true } as never }, c.txn, FOREVER);
	const mine = await c.space.take({ type: "Contribution", fields: { beaconId: beacon.beaconId, charId: c.actor.charId } }, NO_WAIT, { txn: c.txn });
	const had = mine ? fieldsOf<ContributionFields>(mine) : { beaconId: beacon.beaconId, charId: c.actor.charId, name: c.actor.name, pieces: 0, ms: 0 };
	await c.space.write({ type: "Contribution", fields: { ...had, name: c.actor.name, pieces: had.pieces + 1, ms: had.ms + fuel } satisfies ContributionFields as never }, c.txn, FOREVER);
	if (!o.quiet) await msg(c, "*", "info", `$you() $conj(legst|legt) ${item.f.name} ins ${beacon.name}. Es ${burnText({ beaconId: beacon.beaconId, until, litAt: now }, now)}.`, { templ: true });
	if (!left) await say(c.space, c.msgLeaseMs, beacon.covers, "world", `Das ${beacon.name} flammt auf.`, c.txn);
	return { until, now };
}

/** A message from the world itself to everyone in `rooms`. */
async function say(space: SpaceLike, leaseMs: number, rooms: string[], kind: "world" | "info", text: string, txn: string | null = null): Promise<void> {
	const o = await msgOptions(space, { to: "*", kind });
	for (const room of rooms) await space.write({ type: "Msg", fields: { room, to: "*", kind, text, from: "", at: timeNow() } as never }, txn, leaseMs, o);
}

/** Fire tick: a beacon whose flame lapsed (or came back) is marked so, and its rooms hear it. Only a change takes the
 *  beacon's lock: a tick that finds nothing new writes nothing (feeding is never kept waiting by a ticker that rewrites
 *  the beacon every round, and the change stream stays quiet). */
export async function fireTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	for (const def of w.beacons) {
		const seen = await peek(space, { type: "Beacon", fields: { beaconId: def.beaconId } });
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

/** The rooms each fire covers (by beaconId): those of the world file, and around each standing lighthouse (a plan with
 *  `lightRooms`) the rooms up to that many ways from its room, on its island and in this region. The lighthouse widens
 *  the fire whose light it was built in; a room two fires cover has the light of both. The fires of a burning signal
 *  fire chain (chainsOf) share their light: each covers the rooms of all of them, and only while every one burns. */
export async function coversOf(space: SpaceLike, w: WorldDef, txn: string | null = null): Promise<Map<string, string[]>> {
	const out = new Map(w.beacons.map((b) => [b.beaconId, [...b.covers]]));
	for (const p of w.building?.plans.filter((x) => x.lightRooms) ?? []) {
		for (const e of await space.readAll({ type: "Building", fields: { plan: p.key } }, txn ? { txn } : {})) {
			const b = fieldsOf<BuildingFields>(e), list = out.get(b.beaconId);
			if (list) for (const room of roomsAround(w, b.room, p.lightRooms!)) if (!list.includes(room)) list.push(room);
		}
	}
	for (const chain of await chainsOf(space, w, txn)) {
		if (!chain.lit) continue;
		const all = [...new Set(chain.fires.flatMap((id) => out.get(id) ?? []))];
		for (const id of chain.fires) out.set(id, all);
	}
	return out;
}

/** A signal fire chain: signal fires (a plan with `signal`) in rooms one way apart, over land or a ferry, in this region,
 *  that stand in the light of two fires or more. Those are its links; it burns while each of them burns (`out`: those
 *  that do not). */
export type Chain = { rooms: string[]; islands: string[]; fires: string[]; lit: boolean; out: Array<{ beaconId: string; until: number }> };
export async function chainsOf(space: SpaceLike, w: WorldDef, txn: string | null = null): Promise<Chain[]> {
	const here = new Set(w.rooms.map((r) => r.roomId)), fireIn = new Map<string, Set<string>>();
	for (const p of w.building?.plans.filter((x) => x.signal) ?? []) {
		for (const e of await space.readAll({ type: "Building", fields: { plan: p.key } }, txn ? { txn } : {})) {
			const b = fieldsOf<BuildingFields>(e);
			if (here.has(b.room) && w.beacons.some((x) => x.beaconId === b.beaconId)) fireIn.set(b.room, (fireIn.get(b.room) ?? new Set()).add(b.beaconId));
		}
	}
	const chains: Chain[] = [], seen = new Set<string>();
	let now: number | null = null;
	for (const start of [...fireIn.keys()].sort()) {
		if (seen.has(start)) continue;
		const rooms = [start];
		seen.add(start);
		for (let i = 0; i < rooms.length; i++) for (const x of w.exits) if (x.room === rooms[i] && fireIn.has(x.destination) && !seen.has(x.destination)) { seen.add(x.destination); rooms.push(x.destination); }
		const fires = [...new Set(rooms.flatMap((r) => [...fireIn.get(r)!]))].sort();
		if (fires.length < 2) continue;
		now ??= await worldNowOf(space, txn);
		const out: Chain["out"] = [];
		for (const id of fires) { const f = await flameOf(space, id, txn ?? undefined); if (!isLit(f, now)) out.push({ beaconId: id, until: f?.until ?? 0 }); }
		const islands = [...new Set(rooms.map((r) => w.rooms.find((x) => x.roomId === r)?.island ?? w.title))].sort();
		chains.push({ rooms: rooms.sort(), islands, fires, lit: !out.length, out });
	}
	return chains;
}

/** Chain tick: an island is alight while a burning chain links it (`FireChain.since`, in world time); when that ends the
 *  run counts for its longest (`best`), from the world time the first link went out. Only a change is written, so a
 *  quiet world writes nothing; the run of the moment is read from the clock. The comparison is that of this region's
 *  islands: each lies in one region. */
export async function chainTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	const chains = await chainsOf(space, w);
	for (const island of [...new Set(w.rooms.map((r) => r.island ?? w.title))]) {
		const mine = chains.filter((c) => c.islands.includes(island)), lit = mine.some((c) => c.lit);
		const seen = await peek(space, { type: "FireChain", fields: { island } });
		const was = seen ? fieldsOf<FireChainFields>(seen) : null;
		if (lit === !!was?.since) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const e = await space.takeIfExists({ type: "FireChain", fields: { island } }, NO_WAIT, { txn });
			if (seen && !e) { await space.abort(txn); continue; }
			const f = e ? fieldsOf<FireChainFields>(e) : { island, since: 0, best: 0, bestAt: 0 };
			const now = await worldNowOf(space, txn), rooms = w.rooms.filter((r) => (r.island ?? w.title) === island).map((r) => r.roomId);
			if (lit && !f.since) {
				await space.write({ type: "FireChain", fields: { ...f, since: now } satisfies FireChainFields as never }, txn, FOREVER, e ? {} : { unique: ["island"] });
				await say(space, leaseMs, rooms, "world", "Die Signalfeuer sehen einander; ihre Feuer teilen ihr Licht.", txn);
			} else if (!lit && f.since) {
				// it went out when its first link did (the tick comes a little later), or now when a signal fire fell
				const ends = mine.flatMap((c) => c.out.map((o) => o.until)).filter((t) => t >= f.since);
				const end = Math.min(now, ...ends), run = end - f.since;
				await space.write({ type: "FireChain", fields: { ...f, since: 0, ...(run > f.best ? { best: run, bestAt: end } : {}) } satisfies FireChainFields as never }, txn, FOREVER);
				await say(space, leaseMs, rooms, "world", "Die Kette der Signalfeuer ist unterbrochen; jedes Feuer leuchtet wieder für sich.", txn);
			} else { await space.abort(txn); continue; }
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
}
/** The rooms up to `ways` exits from `room` on its island (not over a ferry), in this region's world. */
export function roomsAround(w: WorldDef, room: string, ways: number): string[] {
	const island = (id: string) => w.rooms.find((r) => r.roomId === id)?.island;
	const home = island(room), seen = new Set([room]);
	let ring = [room];
	for (let i = 0; i < ways; i++) {
		ring = w.exits.filter((x) => ring.includes(x.room) && !seen.has(x.destination) && island(x.destination) === home && home !== undefined).map((x) => x.destination);
		for (const r of ring) seen.add(r);
	}
	return [...seen];
}

/** Fog tick: each room a beacon covers gets one step clearer while a fire that covers it burns, one step denser while
 *  none does. A room whose fog stays (clear and lit, or at its densest and dark) is not written: a world of many rooms
 *  would otherwise rewrite all of them every step. */
export async function fogTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	const cover = await coversOf(space, w), rooms = new Map<string, boolean>();
	for (const def of w.beacons) {
		const lit = isLit(await flameOf(space, def.beaconId), await worldNowOf(space));
		for (const room of cover.get(def.beaconId) ?? def.covers) rooms.set(room, (rooms.get(room) ?? false) || lit);
	}
	for (const [room, lit] of rooms) {
		const seen = await peek(space, { type: "Fog", fields: { room } });
		if (seen && fieldsOf<FogFields>(seen).level === (lit ? 0 : w.fog.max)) continue;
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

export const fogText = (level: number, denser: boolean): string =>
	[
		"Der Nebel reißt auf; die See liegt klar.",
		denser ? "Nebel zieht auf." : "Der Nebel lichtet sich.",
		denser ? "Der Nebel wird dicht; man sieht kaum zum Wasser." : "Der Nebel wird dünner; die Wege sind wieder zu erkennen.",
		"Dichter Nebel verschluckt die Wege.",
	][Math.min(3, level)]!;

export async function fogOf(space: SpaceLike, room: string): Promise<number> {
	const e = await peek(space, { type: "Fog", fields: { room } });
	return e ? fieldsOf<FogFields>(e).level : 0;
}

/** Free cells of `tile` in a room (no thing, exit or fire on them). */
async function freeCells(space: SpaceLike, w: WorldDef, roomId: string, tile: string): Promise<Array<{ x: number; y: number }>> {
	const room = w.rooms.find((r) => r.roomId === roomId)!;
	const taken = new Set([...(await space.readAll({ type: "Item", fields: { location: roomId } })), ...(await space.readAll({ type: "Exit", fields: { location: roomId } })), ...(await space.readAll({ type: "Beacon", fields: { room: roomId } })), ...(await space.readAll({ type: "Plot", fields: { room: roomId } }))].map((e) => `${e.fields.x},${e.fields.y}`));
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
	// more people on an island, more flotsam on its beaches: every `perPlayers` people online there one more piece may
	// lie on each beach, and one more comes with each tide (else, with many players, hardly anyone finds anything)
	const people = await peopleByIsland(space, w), per = Math.max(1, w.flood.perPlayers ?? 3);
	for (const fr of w.flood.rooms) {
		const extra = Math.floor((people.get(w.rooms.find((r) => r.roomId === fr.room)?.island ?? "") ?? 0) / per); // one or two people: none extra
		const lying = await space.count({ type: "Item", fields: { location: fr.room, flotsam: true } });
		const n = Math.min(fr.max + extra - lying, 1 + extra);
		if (n <= 0) continue;
		const cells = await freeCells(space, w, fr.room, fr.tile);
		const names: string[] = [];
		for (let i = 0; i < n && cells.length; i++) {
			const proto = await resolvePrototype(space, weighted(fr.protos ?? w.flood.protos));
			if (!proto) continue;
			const at = cells.splice(randomInt(0, cells.length), 1)[0]!;
			names.push((await spawn(space, null, w, proto, { location: fr.room, x: at.x, y: at.y, flotsam: true, expiresWorldMs: (await worldNowOf(space)) + (await patienceOf(space)) * w.flood.lifetimeMs })).name);
		}
		if (names.length) await say(space, leaseMs, [fr.room], "info", names.length === 1 ? `Die Flut spült ${names[0]} an.` : `Die Flut spült ${names.length} Dinge an: ${[...new Set(names)].join(", ")}.`);
	}
	await bringStaples(space, w, people);
}

/** What one builds with never runs out: an island with too little of a staple on its beaches gets more with each tide,
 *  on any of its beaches, quietly (a tide's messages are about the rest). Writes nothing while enough lies there. */
async function bringStaples(space: SpaceLike, w: WorldDef, people: Map<string, number>): Promise<void> {
	const st = w.flood.staples;
	if (!st || process.env.SPACES_MMO_STAPLES === "0") return;
	const islands = new Map<string, Array<WorldDef["flood"]["rooms"][number]>>();
	for (const fr of w.flood.rooms) {
		const island = w.rooms.find((r) => r.roomId === fr.room)?.island;
		if (island) islands.set(island, [...(islands.get(island) ?? []), fr]);
	}
	for (const [island, rooms] of islands) for (const t of st.things) {
		let lying = 0;
		for (const fr of rooms) lying += await space.count({ type: "Item", fields: { location: fr.room, proto: t.proto, flotsam: true } });
		const n = Math.min(t.perIsland + (people.get(island) ?? 0) - lying, st.perTide);
		if (n <= 0) continue;
		const proto = await resolvePrototype(space, t.proto);
		if (!proto) continue;
		for (let i = 0; i < n; i++) {
			const fr = rooms[randomInt(0, rooms.length)]!, cells = await freeCells(space, w, fr.room, fr.tile);
			if (!cells.length) continue;
			const at = cells[randomInt(0, cells.length)]!;
			await spawn(space, null, w, proto, { location: fr.room, x: at.x, y: at.y, flotsam: true, expiresWorldMs: (await worldNowOf(space)) + (await patienceOf(space)) * st.lifetimeMs });
		}
	}
}

/** People online (and the settlers who play in their stead, npc/settlers.ts: they gather like people, so the tide
 *  brings for them too), by the island they stand on. */
async function peopleByIsland(space: SpaceLike, w: WorldDef): Promise<Map<string, number>> {
	const live = new Set((await space.readAll({ type: "Session" })).map((s) => String(s.fields.charId)).filter((id) => !id.startsWith("npc-") || id.startsWith("npc-siedler-")));
	const out = new Map<string, number>();
	if (!live.size) return out;
	for (const c of await space.readAll({ type: "Character" })) {
		if (!live.has(String(c.fields.charId))) continue;
		const island = w.rooms.find((r) => r.roomId === c.fields.room)?.island ?? "";
		out.set(island, (out.get(island) ?? 0) + 1);
	}
	return out;
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
		names.push((await spawn(space, null, w, proto, { location: roomId, x: at.x, y: at.y, flotsam: true, expiresWorldMs: (await worldNowOf(space)) + (await patienceOf(space)) * w.flood.lifetimeMs * 2 })).name);
	}
	if (!names.length) return null;
	const room = w.rooms.find((r) => r.roomId === roomId)!;
	await space.write({ type: "Msg", fields: { room: roomId, to: `#${w.storm.channel}`, kind: "channel", text: `[${w.storm.channel}] Sturmflut in ${room.name} (${room.island ?? w.title})! Das Meer wirft Strandgut aus.`, from: "", at: timeNow() } as never }, null, leaseMs);
	await say(space, leaseMs, [roomId], "world", `Eine Sturmflut rollt heran und lässt ${names.length} Dinge am Strand zurück: ${[...new Set(names)].join(", ")}.`);
	return roomId;
}
