// A building's inside (docs/innenraeume.en.md): a room of its own per building whose plan has an `interior`, with the id
// `in-<buildId>`. Its owner and the guests it invites go in (`betrete` beside the building); inside stand the furnishings
// that do what the building does from outside: the hearth cooks its recipes, the chest is its chest, the bed is for sleep.
// One exit „hinaus“ on its door cell leads out in front of the building.
//
// - The room is made when the site becomes the building (build.ts settle) and, for buildings that stood before, by the
//   sweep (interiorSweep, every sweep: a building of such a plan without its room gets it).
// - The room goes with its building: when the building is gone (fallen to a ruin, voted away, torn down) the sweep puts
//   whoever is inside in front of where it stood, gives what lies on the floor to the owner's estate (`nachlass`) and
//   takes the room, its exit and its furnishings.
// - Nothing walks in from outside: there is no exit into it, so a stranger passing the building never bumps into a door,
//   and NPCs, the atlas and the room jobs (they go by the world's rooms) never see it.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type CharacterFields, type EstateFields, type ExitFields, type RoomFields, type RoomGrowthFields, type RuinFields, type SceneryFields } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, NotUnderstood, toPlayer, type CommandCtx } from "../context.ts";
import { timeNow } from "../source.ts";
import { blockedIn, cellKey, freeCellNear, releaseSpot } from "../occupancy.ts";
import { draftOf } from "../typeclasses.ts";
import { walkable, type InteriorDef, type WorldDef } from "../world.ts";
import { worldNowOf } from "../clock.ts";
import { describeRoom, dropOffers, placeIn, relocate } from "./default.ts";
import { ARTICLE, distTo, planOf } from "./build.ts";
import { wakeOutside } from "./sleep.ts";

export const INTERIOR = "in-";
export const interiorOf = (buildId: string) => `${INTERIOR}${buildId}`;
export const isInterior = (room: string) => room.startsWith(INTERIOR);
/** The building whose inside `room` is, by its id (null outside). */
export const buildIdOf = (room: string): string | null => (isInterior(room) ? room.slice(INTERIOR.length) : null);
const exitIdOf = (buildId: string) => `x-${interiorOf(buildId)}`;
const furnishingId = (buildId: string, kind: string) => `f-${buildId}-${kind}`;

type Space = Pick<SpaceLike, "readAll" | "readIfExists" | "write" | "takeIfExists">;

/** A walkable, free cell in front of the building, where one stands coming out: below its middle first (the door side
 *  of the houses on the map), then the rest of its rim. Null when the building is walled in. */
async function frontOf(space: Space, w: WorldDef, b: Pick<BuildingFields, "room" | "x" | "y" | "w" | "h">): Promise<{ x: number; y: number } | null> {
	const roomE = (await space.readAll({ type: "Room", fields: { roomId: b.room } }))[0];
	if (!roomE) return null;
	const ground = fieldsOf<RoomFields>(roomE).ground, blocked = await blockedIn(space as SpaceLike, w, b.room);
	const exits = new Set((await space.readAll({ type: "Exit", fields: { location: b.room } })).map((e) => cellKey(e.fields as unknown as { x: number; y: number })));
	const mid = b.x + Math.floor(b.w / 2), rim: Array<{ x: number; y: number }> = [{ x: mid, y: b.y + b.h }];
	for (let x = b.x - 1; x <= b.x + b.w; x++) rim.push({ x, y: b.y + b.h });
	for (let y = b.y + b.h - 1; y >= b.y; y--) rim.push({ x: b.x - 1, y }, { x: b.x + b.w, y });
	for (let x = b.x - 1; x <= b.x + b.w; x++) rim.push({ x, y: b.y - 1 });
	const free = rim.find((p) => walkable(w, ground, p.x, p.y) && !blocked.has(cellKey(p)) && !exits.has(cellKey(p)));
	return free ?? freeCellNear(w, ground, { x: mid, y: b.y + b.h }, new Set([...blocked, ...exits]));
}

/** Writes the inside of `b` once (nothing when its room is there already, or its plan has none). */
export async function makeInterior(space: Space, txn: string, w: WorldDef, b: BuildingFields): Promise<RoomFields | null> {
	const plan = planOf(w, b.plan), def = plan?.interior;
	if (!plan || !def) return null;
	const roomId = interiorOf(b.buildId);
	if (await space.readIfExists({ type: "Room", fields: { roomId } }, 1_000, { txn })) return null;
	const front = await frontOf(space, w, b);
	if (!front) return null;
	const growth = (await space.readAll({ type: "RoomGrowth", fields: { roomId: b.room } }, { txn }))[0];
	const revision = growth ? fieldsOf<RoomGrowthFields>(growth).steps?.length ?? 0 : 0;
	const room: RoomFields = { roomId, name: `${plan.name} von ${b.ownerName}`, desc: insideText(plan.name, plan.dative, def), ground: def.ground, spawn: def.spawn,
		building: { buildId: b.buildId, name: b.name, room: b.room, x: b.x, y: b.y, w: b.w, h: b.h, accountId: b.accountId, ownerName: b.ownerName } };
	await space.write(draftOf("Room", w.typeclasses, room), txn, FOREVER);
	const outside = w.rooms.find((r) => r.roomId === b.room)?.name ?? "draußen";
	const exit: ExitFields = { exitId: exitIdOf(b.buildId), name: "hinaus", aliases: ["raus", "tür", "tuer", "out"], desc: `Hinaus nach ${outside}.`, location: roomId, destination: b.room, x: def.door.x, y: def.door.y, arrive: front, locks: "", ...(revision ? { arriveGrowthRevision: revision } : {}) };
	await space.write(draftOf("Exit", w.typeclasses, exit), txn, FOREVER);
	for (const f of def.furniture) {
		const s: SceneryFields = { sceneryId: furnishingId(b.buildId, f.kind), room: roomId, x: f.x, y: f.y, w: 1, h: 1, model: f.kind, name: f.name, fixed: true, work: 0, left: 0, yields: [], of: b.buildId, plan: b.plan, owner: b.owner, ...(f.use ? { use: f.use } : {}), desc: f.desc };
		await space.write({ type: "Scenery", fields: s as never }, txn, FOREVER);
		await space.write({ type: "Plot", fields: { room: roomId, x: f.x, y: f.y, of: s.sceneryId } as never }, txn, FOREVER, { unique: ["room", "x", "y"] });
	}
	return room;
}

/** "Drinnen in der Hütte", "Drinnen im Backhaus": by the plan's dative ("einer Hütte", "einem Backhaus"). */
const insideText = (name: string, dative: string | undefined, def: InteriorDef) => `Drinnen ${/^einem\b/.test(dative ?? "") ? "im" : "in der"} ${name}: ${def.furniture.map((f) => f.name).join(", ")}. „hinaus“ führt vor die Tür.`;

/** Takes the inside of a building that is gone: whoever is in it stands in front of where it stood (`at`, the ruin or
 *  the building's place), what lies on its floor goes to the owner's estate, the room, its exit and furnishings go. */
export async function dropInterior(space: Space, txn: string, w: WorldDef, roomId: string, at: (Pick<BuildingFields, "room" | "x" | "y" | "w" | "h" | "accountId" | "ownerName" | "name">) | null): Promise<void> {
	const buildId = buildIdOf(roomId)!;
	const front = at ? await frontOf(space, w, at) : null;
	const start = w.rooms.find((r) => r.roomId === w.start)!;
	const to = at && front ? { room: at.room, ...front } : { room: start.roomId, ...start.spawn };
	for (const e of await space.readAll({ type: "Character", fields: { room: roomId } }, { txn })) {
		const t = await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
		if (!t) continue;
		await releaseSpot(space as SpaceLike, txn, String(t.fields.charId));
		await space.write({ type: t.type, types: t.types.slice(1), fields: { ...(t.fields as unknown as CharacterFields), ...to } as never }, txn, FOREVER);
		await toPlayer(space as SpaceLike, { room: to.room, to: String(t.fields.charId), kind: "info", text: `${at?.name ?? "Der Bau"} steht nicht mehr; du stehst draußen.`, from: "", fromId: "", at: timeNow() }, txn);
		await wakeOutside(space, txn, String(t.fields.charId), to.room);
	}
	const floor = await space.readAll({ type: "Item", fields: { location: roomId } }, { txn });
	if (floor.length && at) {
		const est: EstateFields = { estateId: `est-${roomId}`, accountId: at.accountId, ownerName: at.ownerName, room: at.room, name: `${at.name} (drinnen)`, untilWorldMs: (await worldNowOf(space as SpaceLike, txn)) + (w.building?.estateWorldMs ?? 30 * 24 * 3600_000) };
		await space.write({ type: "Estate", fields: est as never }, txn, FOREVER);
		for (const it of floor) {
			const t = await space.takeIfExists({ id: it.id }, NO_WAIT, { txn });
			if (t) await space.write({ type: t.type, types: t.types.slice(1), fields: { ...t.fields, location: est.estateId } as never }, txn, FOREVER);
		}
	} else for (const it of floor) await space.takeIfExists({ id: it.id }, NO_WAIT, { txn });
	for (const e of await space.readAll({ type: "Scenery", fields: { room: roomId } }, { txn })) await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
	for (const e of await space.readAll({ type: "Plot", fields: { room: roomId } }, { txn })) await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
	for (const e of await space.readAll({ type: "Spot", fields: { room: roomId } }, { txn })) await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
	await space.takeIfExists({ type: "Exit", fields: { exitId: exitIdOf(buildId) } }, NO_WAIT, { txn });
	await space.takeIfExists({ type: "Room", fields: { roomId } }, NO_WAIT, { txn });
}

/** Every sweep: a building of a plan with an inside gets its room, an inside whose building is gone goes. */
export async function interiorSweep(space: SpaceLike, w: WorldDef | undefined, inTxn: (f: (txn: string) => Promise<boolean>) => Promise<void>): Promise<void> {
	if (!w?.building?.plans.some((p) => p.interior)) return;
	const kept = new Map((await space.readAll({ type: "Room" })).map((e) => fieldsOf<RoomFields>(e)).filter((r) => isInterior(r.roomId)).map((r) => [r.roomId, r]));
	const rooms = new Set(kept.keys());
	const standing = new Map<string, BuildingFields>();
	for (const e of await space.readAll({ type: "Building" })) { const b = fieldsOf<BuildingFields>(e); standing.set(b.buildId, b); }
	for (const b of standing.values()) if (planOf(w, b.plan)?.interior && !rooms.has(interiorOf(b.buildId))) await inTxn(async (txn) => !!(await makeInterior(space, txn, w, b)));
	for (const roomId of rooms) {
		const b = standing.get(buildIdOf(roomId)!);
		if (b && planOf(w, b.plan)?.interior) continue;
		const ruin = (await space.readAll({ type: "Ruin", fields: { buildId: buildIdOf(roomId)! } }))[0];
		// where it stood: the ruin when it fell (a room grown since moved it), else what the room kept of it
		const at = b ?? (ruin ? fieldsOf<RuinFields>(ruin) : kept.get(roomId)?.building ?? null);
		// without a ruin the building went by a way that logs itself (torn down, voted down, destroyed: "building gone"); a
		// line here without such a line before it is a building that went unaccounted for
		if (!b && !ruin) console.error(`[world] inside ${roomId} taken: its building is gone without a ruin (${JSON.stringify(kept.get(roomId)?.building ?? null)})`);
		await inTxn(async (txn) => { await dropInterior(space, txn, w, roomId, at); return true; });
	}
}

/** Whether the actor may go into `b`: its owner, and whom the owner invited. */
export const mayEnter = (c: CommandCtx, b: BuildingFields) => (!!c.account && !c.account.guest && b.accountId === c.account.accountId) || !!b.guests?.some((g) => g.charId === c.actor.charId);
const isOwner = (c: CommandCtx, b: BuildingFields) => !!c.account && !c.account.guest && b.accountId === c.account.accountId;

/** The buildings that count as beside the actor: outside those it stands beside; inside, its building when it stands
 *  beside the furnishing that does `use` (any furnishing, or none needed, without one). */
export async function nearBuildings(c: CommandCtx, use?: "cook" | "chest" | "sleep"): Promise<BuildingFields[]> {
	const inside = buildIdOf(c.actor.room);
	if (!inside) return (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => distTo(c.actor, b) <= 1);
	const b = (await c.space.readAll({ type: "Building", fields: { buildId: inside } }))[0];
	if (!b) return [];
	if (use) {
		const pieces = (await c.space.readAll({ type: "Scenery", fields: { room: c.actor.room } })).map((e) => fieldsOf<SceneryFields>(e)).filter((s) => s.use === use);
		if (!pieces.some((s) => distTo(c.actor, s) <= 1)) return [];
	}
	return [fieldsOf<BuildingFields>(b)];
}
/** Inside a building, the furnishing for `use` and whether the actor stands beside it (to say where to go). */
export async function furnishingFor(c: CommandCtx, use: "cook" | "chest" | "sleep"): Promise<SceneryFields | null> {
	if (!isInterior(c.actor.room)) return null;
	return (await c.space.readAll({ type: "Scenery", fields: { room: c.actor.room } })).map((e) => fieldsOf<SceneryFields>(e)).find((s) => s.use === use) ?? null;
}

/** The building one means: at x y, or beside one (one's own first, then one invited into). */
async function enterable(c: CommandCtx, arg: string): Promise<BuildingFields> {
	const at = /^(\d+)\s+(\d+)$/.exec(arg.trim()), n = arg.trim().replace(ARTICLE, "").toLowerCase();
	const near = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e))
		.filter((b) => distTo(c.actor, b) <= 1 && (at ? distTo({ x: Number(at[1]), y: Number(at[2]) }, b) === 0 : !n || planOf(c.world, n)?.key === b.plan || b.name.toLowerCase() === n));
	const houses = near.filter((b) => planOf(c.world, b.plan)?.interior);
	if (!houses.length) throw new (near.length ? CommandError : NotUnderstood)(near.length ? `In ${planOf(c.world, near[0]!.plan)?.dative ?? near[0]!.name} geht man nicht hinein.` : "Geh direkt neben eine Hütte (ein Backhaus, eine Metzgerei), in die du darfst.");
	return houses.find((b) => isOwner(c, b)) ?? houses.find((b) => mayEnter(c, b)) ?? houses[0]!;
}

const betrete: Command = {
	key: "betrete", aliases: ["hinein", "eintreten", "enter"],
	help: "betrete [x y] – in den Bau neben dir gehen (Hütte, Backhaus, Metzgerei): den eigenen oder einen, in den man eingeladen ist; „hinaus“ führt wieder vor die Tür",
	async func(c, arg) {
		if (isInterior(c.actor.room)) throw new CommandError("Du bist schon drinnen; „hinaus“ führt vor die Tür.");
		const b = await enterable(c, arg);
		if (!mayEnter(c, b)) throw new CommandError(`Die Tür ist zu. Hinein dürfen nur ${b.ownerName} und wer eingeladen ist.`);
		const roomId = interiorOf(b.buildId);
		// a building whose inside the sweep has not made yet: made now, in the command's transaction (so the room is not
		// readable outside it yet: it is described from its plan)
		const was = (await c.space.readAll({ type: "Room", fields: { roomId } }))[0];
		const made = was ? null : await makeInterior(c.space, c.txn, c.world, b);
		const room = was ? fieldsOf<RoomFields>(was) : made;
		if (!room) throw new CommandError("Vor der Tür ist kein Platz; so kommt man nicht hinein.");
		const at = await placeIn(c, room, room.spawn ?? planOf(c.world, b.plan)!.interior!.spawn);
		await relocate(c, { room: roomId, x: at.x, y: at.y }, { spot: false });
		await dropOffers(c);
		await msg(c, "*", "info", `$you() $conj(gehst|geht) in die ${b.name} von ${b.ownerName}.`, { templ: true });
		await msg(c, "*", "info", `$you() $conj(kommst|kommt) herein.`, { templ: true, room: roomId });
		await msg(c, c.actor.charId, "look", made ? `${made.name}\n${made.desc}` : await describeRoom(c, roomId, true), { room: roomId });
	},
};

/** One's own building with an inside: the one one is in, or beside one. */
async function ownHouse(c: CommandCtx): Promise<BuildingFields> {
	const inside = buildIdOf(c.actor.room);
	const all = inside ? (await c.space.readAll({ type: "Building", fields: { buildId: inside } })).map((e) => fieldsOf<BuildingFields>(e))
		: (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => distTo(c.actor, b) <= 1);
	const b = all.find((x) => planOf(c.world, x.plan)?.interior && isOwner(c, x));
	if (!b) throw new CommandError(all.some((x) => planOf(c.world, x.plan)?.interior) ? "Einladen kann nur, wem der Bau gehört." : "Stell dich neben deine Hütte (oder dein Backhaus, deine Metzgerei) oder geh hinein.");
	const e = await c.space.take({ type: "Building", fields: { buildId: b.buildId } }, 5_000, { txn: c.txn });
	if (!e) throw new CommandError("Der Bau ist gerade nicht greifbar; bitte noch einmal.");
	return fieldsOf<BuildingFields>(e);
}

const einladen: Command = {
	key: "einladen", aliases: ["lade", "invite"],
	help: "einladen [name] – jemanden in den eigenen Bau einladen, Hütte, Backhaus oder Metzgerei (neben ihm oder drinnen); ohne Namen: wer eingeladen ist",
	async func(c, arg) {
		const b = await ownHouse(c);
		const n = arg.trim().replace(/\s+ein$/i, "");
		if (!n) {
			await c.space.write({ type: "Building", fields: b as never }, c.txn, FOREVER);
			return msg(c, c.actor.charId, "info", b.guests?.length ? `In deine ${b.name} dürfen: ${b.guests.map((g) => g.name).join(", ")}. „ausladen <name>“ nimmt es zurück.` : `In deine ${b.name} hast du niemanden eingeladen. „einladen <name>“ lädt jemanden ein.`);
		}
		const who = (await c.space.readAll({ type: "Character" })).map((e) => fieldsOf<CharacterFields>(e)).find((ch) => ch.name.toLowerCase() === n.toLowerCase());
		if (!who) throw new CommandError(`Eine Figur „${n.slice(0, 30)}“ gibt es hier nicht.`);
		if (who.charId === c.actor.charId) throw new CommandError("In deinen eigenen Bau darfst du ohnehin.");
		if (b.guests?.some((g) => g.charId === who.charId)) throw new CommandError(`${who.name} ist schon eingeladen.`);
		if ((b.guests?.length ?? 0) >= GUESTS_MAX) throw new CommandError(`Mehr als ${GUESTS_MAX} Gäste lädt man nicht ein; „ausladen <name>“ macht Platz.`);
		await c.space.write({ type: "Building", fields: { ...b, guests: [...b.guests ?? [], { charId: who.charId, name: who.name }] } as never }, c.txn, FOREVER);
		await msg(c, c.actor.charId, "info", `${who.name} darf jetzt in deine ${b.name}.`);
		await msg(c, who.charId, "info", `${c.actor.name} lädt dich in die ${b.name} ein („betrete“ neben ihr).`, { room: who.room });
	},
};
const GUESTS_MAX = 12;

const ausladen: Command = {
	key: "ausladen", aliases: ["uninvite"],
	help: "ausladen <name> – eine Einladung in den eigenen Bau zurücknehmen; wer drinnen ist, steht dann draußen",
	async func(c, arg) {
		const b = await ownHouse(c);
		const n = arg.trim().toLowerCase();
		const g = b.guests?.find((x) => x.name.toLowerCase() === n);
		if (!g) { await c.space.write({ type: "Building", fields: b as never }, c.txn, FOREVER); throw new CommandError(n ? `${arg.trim().slice(0, 30)} ist nicht eingeladen.` : "Wen? Zum Beispiel: ausladen Mira"); }
		const guests = b.guests!.filter((x) => x.charId !== g.charId);
		const { guests: _g, ...rest } = b;
		await c.space.write({ type: "Building", fields: (guests.length ? { ...rest, guests } : rest) as never }, c.txn, FOREVER);
		// a guest inside goes out at once
		const roomId = interiorOf(b.buildId);
		const inside = (await c.space.readAll({ type: "Character", fields: { charId: g.charId, room: roomId } }, { txn: c.txn }))[0];
		if (inside) {
			const front = await frontOf(c.space, c.world, b);
			const t = front && await c.space.takeIfExists({ id: inside.id }, 5_000, { txn: c.txn });
			if (t && front) {
				await releaseSpot(c.space, c.txn, g.charId);
				await c.space.write({ type: t.type, types: t.types.slice(1), fields: { ...t.fields, room: b.room, ...front } as never }, c.txn, FOREVER);
				await msg(c, g.charId, "info", `${c.actor.name} hat dich ausgeladen; du stehst vor der ${b.name}.`, { room: b.room });
				await wakeOutside(c.space, c.txn, g.charId, b.room);
			}
		}
		await msg(c, c.actor.charId, "info", `${g.name} darf nicht mehr in deine ${b.name}.`);
		await msg(c, g.charId, "info", `${c.actor.name} hat die Einladung in die ${b.name} zurückgenommen.`);
	},
};

export const INTERIOR_COMMANDS: Command[] = [betrete, einladen, ausladen];
