// The wild from the fog, step 2 part 3 (docs/siedeln.md "Wild im Nebel"): hares come to the beds of rooms whose fire
// does not hold the fog back, and nibble at what grows there unless someone scares them off first.
//
// - The wild tick (worldevents.ts, "wild") looks only at rooms with beds: by the room's fog level (none while its fire
//   burns, more at night) a hare comes to one of its beds, at most a few per room. A hare is an entry; its coming and
//   its bite are its only writes.
// - It eats after a while: one plant falls back a stage, a seedling is gone, the bed's last living plant never.
// - Scaring it off is a take of its entry, so whoever comes first saves the bed, and a hare scared off eats nothing.
// - A fence around a bed (`zäune`) or a scarecrow nearby (a building plan) keeps the bed whole.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type AnimalFields, type BedFields, type BedPlant, type BuildingFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, msg, msgOptions, NotUnderstood, type CommandCtx } from "../context.ts";
import { fogOf } from "../fire.ts";
import { calendar } from "../worldtime.ts";
import { walkable, type GardenDef, type WildDef, type WorldDef } from "../world.ts";
import { bedHere, bedName, growFactor, mayTend, nextDue, protoName, sortOf, writeBed } from "./garden.ts";

const night = (worldMs: number) => { const h = calendar(worldMs).hour; return h >= 20 || h < 6; };
/** Cells between two rectangles (0: touching or overlapping), as one walks: diagonal steps count one. */
const gap = (a: { x: number; y: number; w?: number; h?: number }, b: { x: number; y: number; w?: number; h?: number }) =>
	Math.max(0, b.x - (a.x + (a.w ?? 1) - 1), a.x - (b.x + (b.w ?? 1) - 1), b.y - (a.y + (a.h ?? 1) - 1), a.y - (b.y + (b.h ?? 1) - 1));

/** A bed the hares cannot harm: fenced, a scarecrow close by, or in a room where fed geese keep watch (`guarded`). */
export const sheltered = (wd: WildDef, b: BedFields, scarecrows: BuildingFields[], guarded: ReadonlySet<string> = new Set()) => !!b.fenced || guarded.has(b.room) || scarecrows.some((s) => s.room === b.room && gap(b, s) <= wd.scarecrowReach);
/** The rooms where fed animals of the guard kind (the geese, `wd.guard`) keep watch: they cackle at whatever comes. */
export function guardedRooms(wd: WildDef, houses: BuildingFields[], now: number): Set<string> {
	return new Set(houses.filter((h) => !!wd.guard && h.herd?.kind === wd.guard && h.herd.fedUntilWorldMs > now).map((h) => h.room));
}

/** A hare's bite: one living plant falls back a stage, a seedling is gone; the bed's last living plant it leaves.
 *  Returns the plant it ate at (null: nothing). */
export function bite(g: GardenDef, b: BedFields, now: number, fog: number, rnd: () => number = Math.random): BedPlant | null {
	const living = b.plants.filter((p) => p.stage < 3);
	if (living.length < 2) return null;
	const p = living[Math.floor(rnd() * living.length) % living.length]!;
	if (p.stage === 0) b.plants = b.plants.filter((q) => q !== p);
	else {
		p.stage = (p.stage - 1) as 0 | 1;
		const sort = sortOf(g, p.sort);
		p.dueWorldMs = now + (sort ? sort.grow[p.stage] * growFactor(fog, b.weedy) : 0);
	}
	b.dueWorldMs = nextDue(b.plants);
	return p;
}

/** A message from the world to everyone in a room. */
async function tell(space: SpaceLike, leaseMs: number, room: string, text: string, txn: string | null = null): Promise<void> {
	await space.write({ type: "Msg", fields: { room, to: "*", kind: "world", text, from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
}

/** A free cell beside the bed where a hare can sit (walkable, no bed or building on it). */
function besideBed(w: WorldDef, b: BedFields, covered: Set<string>, rnd: () => number): { x: number; y: number } | null {
	const room = (w.allRooms ?? w.rooms).find((r) => r.roomId === b.room);
	if (!room) return null;
	const ring: Array<{ x: number; y: number }> = [];
	for (let x = b.x - 1; x <= b.x + b.w; x++) for (let y = b.y - 1; y <= b.y + b.h; y++) {
		if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) continue;
		if (walkable(w, room.ground, x, y) && !covered.has(`${x},${y}`)) ring.push({ x, y });
	}
	return ring.length ? ring[Math.floor(rnd() * ring.length) % ring.length]! : null;
}

/** The wild's recurring job (engine/worldevents.ts, "wild"): hares whose time has come eat and go, then each room with
 *  beds in fog may get a new one. Writes only when a hare comes or eats. */
export async function wildTick(space: SpaceLike, w: WorldDef, leaseMs: number, rnd: () => number = Math.random): Promise<{ came: number; ate: number }> {
	const g = w.garden, wd = w.wild;
	if (!g || !wd) return { came: 0, ate: 0 };
	const now = await worldNowOf(space);
	const animals = (await space.readAll({ type: "Animal" })).map((e) => fieldsOf<AnimalFields>(e));
	const beds = (await space.readAll({ type: "Bed" })).map((e) => fieldsOf<BedFields>(e));
	const scarecrows = (await space.readAll({ type: "Building", fields: { plan: wd.scarecrow } })).map((e) => fieldsOf<BuildingFields>(e));
	const guarded = wd.guard ? guardedRooms(wd, (await space.readAll({ type: "Building" })).map((e) => fieldsOf<BuildingFields>(e)), now) : new Set<string>();
	let came = 0, ate = 0;
	for (const a of animals.filter((x) => x.eatsAtWorldMs <= now)) {
		const bed = beds.find((b) => b.bedId === a.bedId);
		const txn = (await space.createTransaction(10_000)).id;
		try {
			// scared off meanwhile: nothing to do
			if (!(await space.takeIfExists({ type: "Animal", fields: { animalId: a.animalId } }, NO_WAIT, { txn }))) { await space.abort(txn); continue; }
			let text = `${a.name} hoppelt in den Nebel zurück.`;
			if (bed && sheltered(wd, bed, scarecrows, guarded)) text = bed.fenced || !guarded.has(bed.room) ? `${a.name} schnuppert ${bed.fenced ? "am Zaun um das" : "an der Vogelscheuche beim"} ${bedName(bed)} und hoppelt in den Nebel zurück.` : `Die Gänse schnattern los; ${a.name} flieht in den Nebel.`;
			else if (bed && bed.plants.filter((p) => p.stage < 3).length >= 2) {
				const t = await space.takeIfExists({ type: "Bed", fields: { bedId: bed.bedId } }, NO_WAIT, { txn });
				// a bed a command holds right now: the hare waits for the next round (a bed gone for long: it leaves)
				if (!t) { if (now - a.eatsAtWorldMs < wd.eatAfterWorldMs) { await space.abort(txn); continue; } }
				else {
					const b = fieldsOf<BedFields>(t);
					const p = sheltered(wd, b, scarecrows, guarded) ? null : bite(g, b, now, await fogOf(space, b.room), rnd);
					await space.write({ type: "Bed", fields: b as never }, txn, FOREVER);
					if (p) { ate++; text = `${a.name} knabbert im ${bedName(b)} an ${sortOf(g, p.sort)?.name ?? "einer Pflanze"} und hoppelt in den Nebel zurück.`; }
				}
			}
			if (bed) await tell(space, leaseMs, a.room, text, txn);
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	const isNight = night(now);
	for (const room of new Set(beds.map((b) => b.room))) {
		const fog = await fogOf(space, room);
		if (fog <= 0 || animals.filter((a) => a.room === room && a.eatsAtWorldMs > now).length >= wd.maxPerRoom) continue;
		if (rnd() >= (wd.chance[Math.min(3, fog)] ?? 0) * (isNight ? wd.nightFactor : 1)) continue;
		const targets = beds.filter((b) => b.room === room && b.plants.some((p) => p.stage < 3));
		const target = targets[Math.floor(rnd() * targets.length) % Math.max(1, targets.length)];
		if (!target) continue;
		const covered = new Set((await space.readAll({ type: "Plot", fields: { room } })).map((e) => `${e.fields.x},${e.fields.y}`));
		const at = besideBed(w, target, covered, rnd);
		if (!at) continue;
		const a: AnimalFields = { animalId: `hase-${randomBytes(5).toString("hex")}`, kind: "hase", name: wd.hare.name, room, ...at, bedId: target.bedId, eatsAtWorldMs: now + wd.eatAfterWorldMs, at: now };
		await space.write({ type: "Animal", fields: a as never }, null, FOREVER);
		await tell(space, leaseMs, room, `Ein ${wd.hare.name} hoppelt aus dem Nebel ans ${bedName(target)}. („scheuche hase“ jagt ihn fort.)`);
		came++;
	}
	return { came, ate };
}

const wild = (c: CommandCtx): WildDef => {
	const wd = c.world.wild;
	if (!wd) throw new CommandError("In dieser Welt kommt kein Wild aus dem Nebel.");
	return wd;
};

const scheuche: Command = {
	key: "scheuche", aliases: ["verscheuche", "scheuchen", "verscheuchen", "scare", "shoo"],
	help: "scheuche [hase] – einen Hasen bis drei Schritte von dir in den Nebel zurückjagen, bevor er frisst",
	async func(c, arg) {
		const wd = wild(c);
		if (arg.trim() && !/^(?:den\s+|die\s+)?(?:hasen?|hare|wild|tiere?)(?:\s+(?:weg|fort))?$/i.test(arg.trim())) throw new NotUnderstood("Verscheuchen lässt sich hier ein Hase („scheuche hase“).");
		const here = (await c.space.readAll({ type: "Animal", fields: { room: c.actor.room } })).map((e) => fieldsOf<AnimalFields>(e)).sort((a, b) => gap(c.actor, a) - gap(c.actor, b));
		const a = here[0];
		if (!a) throw new CommandError("Hier ist kein Hase.");
		if (gap(c.actor, a) > wd.scareReach) throw new NotUnderstood(`Geh näher an den ${a.name}n heran (höchstens ${wd.scareReach} Schritte).`);
		if (!(await c.space.takeIfExists({ type: "Animal", fields: { animalId: a.animalId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`Der ${a.name} ist schon fort.`);
		await msg(c, "*", "emote", `${c.actor.name} scheucht den ${a.name}n in den Nebel zurück.`);
	},
};

const zaeune: Command = {
	key: "zäune", aliases: ["zaeune", "umzäune", "umzaeune", "zäunen", "zaeunen", "fence"],
	help: "zäune – einen Zaun um ein Beet neben dir setzen (2 Treibholz, 1 Tangseil): Hasen kommen nicht mehr hinein",
	async func(c) {
		const wd = wild(c);
		const b = await bedHere(c, { may: (x) => mayTend(c, x), reach: 1 });
		if (b.fenced) throw new CommandError(`Um das ${bedName(b)} steht schon ein Zaun.`);
		const inv = await inventory(c);
		const missing = wd.fence.filter((n) => inv.filter((i) => i.f.proto === n.proto).length < n.count);
		if (missing.length) throw new CommandError(`Für einen Zaun brauchst du ${wd.fence.map((n) => `${n.count} ${protoName(c, n.proto)}`).join(" und ")}.`);
		for (const n of wd.fence) for (const it of inv.filter((i) => i.f.proto === n.proto).slice(0, n.count)) {
			if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Dein Material ist gerade nicht greifbar; bitte noch einmal.");
		}
		await writeBed(c, { ...b, fenced: true, untilWorldMs: Math.max(b.untilWorldMs, (await worldNowOf(c.space, c.txn)) + (c.world.garden?.bed.keepWorldMs ?? 0)) });
		await msg(c, "*", "emote", `${c.actor.name} setzt einen Zaun um das ${bedName(b)}; kein Hase kommt mehr hinein.`);
	},
};

export const WILD_COMMANDS: Command[] = [scheuche, zaeune];
