// The wild from the fog (docs/siedeln.md "Wild im Nebel"): hares at the beds (step 2 part 3), deer at the fields, foxes
// at the coops and mice at the chests (step 3 part 4) come to rooms whose fire does not hold the fog back, and take a
// little unless someone scares them off first.
//
// - The wild tick (worldevents.ts, "wild") looks only at rooms with targets: by the room's fog level (none while its fire
//   burns, more at night; the fox almost only at night) one of each kind may come to a target, at most a few per room. An
//   animal is an entry; its coming and its bite are its only writes.
// - It eats after a while: a plant falls back a stage (a seedling is gone), a growing field gives less, a coop loses one
//   of its animals (its herd settled first), a chest a few grains. Never the last: the bed's last living plant, a coop's
//   last animal and a chest's last grain stay.
// - Scaring it off is a take of its entry, so whoever comes first saves the target, and one scared off eats nothing.
// - Shelter: a fence round a bed, field or coop (`zäune`), a scarecrow near a bed or field, a mousetrap in the chest, and
//   the guards: fed, the geese keep hares and foxes from their room, a dog hares, deer and foxes, a cat the mice.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type AnimalFields, type BedFields, type BedPlant, type BuildingFields, type FieldFields, type ItemFields } from "../../model.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, msg, msgOptions, NotUnderstood, type CommandCtx } from "../context.ts";
import { fogOf } from "../fire.ts";
import { calendar } from "../worldtime.ts";
import { walkable, type FieldDef, type GardenDef, type PreyDef, type WildDef, type WorldDef } from "../world.ts";
import { settleHerd } from "./animals.ts";
import { distTo, planOf, putBack, takeNear, type Rect } from "./build.ts";
import { cropOf, fieldName, harvestOf } from "./field.ts";
import { bedHere, bedName, growFactor, mayTend, nextDue, protoName, sortOf, writeBed } from "./garden.ts";

const night = (worldMs: number) => { const h = calendar(worldMs).hour; return h >= 20 || h < 6; };
/** Cells between two rectangles (0: touching or overlapping), as one walks: diagonal steps count one. */
const gap = (a: { x: number; y: number; w?: number; h?: number }, b: { x: number; y: number; w?: number; h?: number }) =>
	Math.max(0, b.x - (a.x + (a.w ?? 1) - 1), a.x - (b.x + (b.w ?? 1) - 1), b.y - (a.y + (a.h ?? 1) - 1), a.y - (b.y + (b.h ?? 1) - 1));

/** A kind of wild as the tick and `scheuche` see it: the hare from `wd.hare` and the top-level numbers, the others from
 *  `wd.prey`. */
export type WildKind = Omit<PreyDef, "key"> & { key: AnimalFields["kind"] };
export function wildKinds(wd: WildDef): WildKind[] {
	const n = wd.hare.name;
	const hare: WildKind = { key: "hase", name: n, aliases: ["hasen", "hare"], nom: `ein ${n}`, the: `der ${n}`, acc: `den ${n}n`, none: `kein ${n}`, goes: "hoppelt", to: "", icon: wd.hare.icon,
		chance: wd.chance, nightFactor: wd.nightFactor, eatAfterWorldMs: wd.eatAfterWorldMs };
	return [hare, ...(wd.prey ?? [])];
}
const kindOf = (wd: WildDef, a: AnimalFields) => wildKinds(wd).find((k) => k.key === (a.kind ?? "hase")) ?? wildKinds(wd)[0]!;
const cap = (t: string) => t[0]!.toUpperCase() + t.slice(1);
const pron = (k: WildKind) => (k.acc.startsWith("den ") ? "ihn" : k.acc.startsWith("das ") ? "es" : "sie");

/** Per room, the kinds of wild its fed guards keep away, with what the guard does when one comes ("Die Gänse schnattern
 *  los"): fed herds of a guard kind (the geese) and fed keepers (the dog, the cat). */
export function guardsIn(wd: WildDef, buildings: BuildingFields[], now: number): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	for (const b of buildings) for (const g of wd.guards ?? []) {
		const fed = (b.herd?.kind === g.by && b.herd.fedUntilWorldMs > now) || (b.keeper?.kind === g.by && b.keeper.fedUntilWorldMs > now);
		if (!fed) continue;
		const room = out.get(b.room) ?? new Map<string, string>();
		for (const k of g.kinds) if (!room.has(k)) room.set(k, g.says);
		out.set(b.room, room);
	}
	return out;
}
/** The rooms where a fed guard keeps `kind` (by default the hares) away. */
export function guardedRooms(wd: WildDef, buildings: BuildingFields[], now: number, kind = "hase"): Set<string> {
	return new Set([...guardsIn(wd, buildings, now)].filter(([, m]) => m.has(kind)).map(([room]) => room));
}

/** A bed the hares cannot harm: fenced, a scarecrow close by, or in a room where a fed guard keeps watch (`guarded`). */
export const sheltered = (wd: WildDef, b: BedFields, scarecrows: BuildingFields[], guarded: ReadonlySet<string> = new Set()) => !!b.fenced || guarded.has(b.room) || scarecrows.some((s) => s.room === b.room && gap(b, s) <= wd.scarecrowReach);

/** How often a deer may graze a crop before its yield would fall below `keep`. */
export const maxGrazes = (p: Pick<PreyDef, "bite" | "keep">) => (p.bite ? Math.floor((1 - (p.keep ?? 0.5)) / p.bite + 1e-9) : 0);
/** A deer grazes a growing field: its yield falls by `bite` of the whole (computed afresh from crop and soil, so the
 *  shares of the harvest still add up), never below `keep`. False when there is nothing more to graze. */
export function graze(d: FieldDef, p: Pick<PreyDef, "bite" | "keep">, f: FieldFields): boolean {
	const crop = cropOf(d, f.crop);
	if (!crop || f.stage !== "waechst" || (f.grazed ?? 0) >= maxGrazes(p)) return false;
	f.grazed = (f.grazed ?? 0) + 1;
	f.yields = harvestOf(crop, f.w * f.h, f.soil * Math.max(p.keep ?? 0.5, 1 - (p.bite ?? 0) * f.grazed));
	return true;
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

/** A free cell beside a target where an animal can sit (walkable, no bed, field or building on it). */
function beside(w: WorldDef, room: string, r: Rect, covered: Set<string>, rnd: () => number): { x: number; y: number } | null {
	const def = (w.allRooms ?? w.rooms).find((x) => x.roomId === room);
	if (!def) return null;
	const ring: Array<{ x: number; y: number }> = [];
	for (let x = r.x - 1; x <= r.x + r.w; x++) for (let y = r.y - 1; y <= r.y + r.h; y++) {
		if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) continue;
		if (walkable(w, def.ground, x, y) && !covered.has(`${x},${y}`)) ring.push({ x, y });
	}
	return ring.length ? ring[Math.floor(rnd() * ring.length) % ring.length]! : null;
}
const pick = <T>(xs: T[], rnd: () => number): T | undefined => xs[Math.floor(rnd() * xs.length) % Math.max(1, xs.length)];

/** What the tick reads once a round. */
type Seen = { now: number; beds: BedFields[]; fields: FieldFields[]; buildings: BuildingFields[]; scarecrows: BuildingFields[]; guards: Map<string, Map<string, string>> };
const owner = (k: WildKind, name: string) => k.to.replace("{owner}", name);

/** An animal whose time has come eats (or finds its target sheltered) and goes, in one transaction with the take of its
 *  entry: one scared off meanwhile does nothing. Returns whether it took something; null: its target is held by a
 *  command right now, it tries again next round. */
async function eat(space: SpaceLike, w: WorldDef, leaseMs: number, a: AnimalFields, s: Seen, rnd: () => number): Promise<boolean | null> {
	const wd = w.wild!, k = kindOf(wd, a), txn = (await space.createTransaction(10_000)).id;
	try {
		if (!(await space.takeIfExists({ type: "Animal", fields: { animalId: a.animalId } }, NO_WAIT, { txn }))) { await space.abort(txn); return false; }
		const guard = s.guards.get(a.room)?.get(k.key);
		const fled = guard ? `${guard}; ${k.the} flieht in den Nebel.` : null;
		const back = `${cap(k.the)} ${k.goes} in den Nebel zurück.`;
		// a target held by a command: wait for the next round, unless it has been gone for long
		const held = async () => { if (s.now - a.eatsAtWorldMs < k.eatAfterWorldMs) { await space.abort(txn); return true; } return false; };
		let text: string | null = null, took = false;
		if (k.key === "hase") {
			const bed = s.beds.find((b) => b.bedId === a.bedId);
			if (bed) {
				text = back;
				if (fled || sheltered(wd, bed, s.scarecrows)) text = fled ?? `${cap(k.the)} schnuppert ${bed.fenced ? "am Zaun um das" : "an der Vogelscheuche beim"} ${bedName(bed)} und ${k.goes} in den Nebel zurück.`;
				else if (bed.plants.filter((p) => p.stage < 3).length >= 2) {
					const t = await space.takeIfExists({ type: "Bed", fields: { bedId: bed.bedId } }, NO_WAIT, { txn });
					if (!t) { if (await held()) return null; }
					else {
						const b = fieldsOf<BedFields>(t);
						const p = sheltered(wd, b, s.scarecrows) ? null : bite(w.garden!, b, s.now, await fogOf(space, b.room), rnd);
						await space.write({ type: "Bed", fields: b as never }, txn, FOREVER);
						if (p) { took = true; text = `${cap(k.the)} knabbert im ${bedName(b)} an ${sortOf(w.garden!, p.sort)?.name ?? "einer Pflanze"} und ${k.goes} in den Nebel zurück.`; }
					}
				}
			}
		} else if (k.key === "reh") {
			const f = s.fields.find((x) => x.fieldId === a.target);
			if (f) {
				text = back;
				if (fled) text = fled;
				else if (f.fenced) text = `${cap(k.the)} findet den Zaun um die ${fieldName(f)} und ${k.goes} in den Nebel zurück.`;
				else if (s.scarecrows.some((c) => c.room === f.room && gap(f, c) <= wd.scarecrowReach)) text = `${cap(k.the)} scheut die Vogelscheuche bei der ${fieldName(f)} und ${k.goes} in den Nebel zurück.`;
				else if (f.stage === "waechst") {
					const t = await space.takeIfExists({ type: "Field", fields: { fieldId: f.fieldId } }, NO_WAIT, { txn });
					if (!t) { if (await held()) return null; }
					else {
						const x = fieldsOf<FieldFields>(t);
						took = !x.fenced && graze(w.fields!, k, x);
						await space.write({ type: "Field", fields: x as never }, txn, FOREVER);
						if (took) text = `${cap(k.the)} frisst sich an der ${fieldName(x)} satt und ${k.goes} in den Nebel zurück; sie wird weniger geben.`;
					}
				}
			}
		} else if (k.key === "fuchs") {
			const b = s.buildings.find((x) => x.buildId === a.target);
			if (b) {
				text = back;
				if (fled) text = fled;
				else if (b.fenced) text = `${cap(k.the)} streicht um den Zaun am Stall von ${b.ownerName} und ${k.goes} in den Nebel zurück.`;
				else {
					const t = await space.takeIfExists({ type: "Building", fields: { buildId: b.buildId } }, NO_WAIT, { txn });
					if (!t) { if (await held()) return null; }
					else {
						// the herd settled with all its animals first: what they gave until now stays theirs
						const h = await settleHerd(space, txn, w, fieldsOf<BuildingFields>(t), s.now);
						const one = h.k && h.n >= 2 ? (await space.readAll({ type: "Item", fields: { location: b.buildId, proto: h.k.proto } }))[0] : undefined;
						if (one && (await space.takeIfExists({ id: one.id }, NO_WAIT, { txn }))) { took = true; text = `${cap(k.the)} holt sich eins der ${h.k!.plural} aus dem Stall von ${b.ownerName} und ${k.goes} in den Nebel zurück.`; }
						await space.write({ type: "Building", fields: h.b as never }, txn, FOREVER);
					}
				}
			}
		} else if (k.key === "maus") {
			const b = s.buildings.find((x) => x.buildId === a.target);
			if (b) {
				text = back;
				const inside = (await space.readAll({ type: "Item", fields: { location: b.buildId } })).map((e) => fieldsOf<ItemFields>(e));
				if (fled) text = fled;
				else if (k.trap && inside.some((i) => i.proto === k.trap)) text = `In der Truhe von ${b.ownerName} schnappt die Mausefalle zu; ${k.the} ist gefangen.`;
				else {
					const food = inside.filter((i) => k.eats?.includes(i.proto));
					const n = Math.min(k.take ?? 1, food.length - 1);
					const eaten = new Map<string, number>();
					for (const i of food.slice(0, Math.max(0, n))) if (await space.takeIfExists({ type: "Item", fields: { itemId: i.itemId, location: b.buildId } }, NO_WAIT, { txn })) eaten.set(i.name, (eaten.get(i.name) ?? 0) + 1);
					if (eaten.size) { took = true; text = `${cap(k.the)} nagt an der Truhe von ${b.ownerName} und ${k.goes} in den Nebel zurück; es fehlen ${[...eaten].map(([nm, x]) => `${x} ${nm}`).join(" und ")}.`; }
				}
			}
		}
		if (text) await tell(space, leaseMs, a.room, text, txn);
		await space.commit(txn);
		return took;
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** The targets of a kind in a room that it may come for now (for foxes and mice, what is inside is read only here, after
 *  the roll hit). */
async function targets(space: SpaceLike, w: WorldDef, k: WildKind, room: string, s: Seen): Promise<Array<{ id: string; r: Rect; name: string }>> {
	if (k.key === "hase") return s.beds.filter((b) => b.room === room && b.plants.some((p) => p.stage < 3)).map((b) => ({ id: b.bedId, r: b, name: bedName(b) }));
	if (k.key === "reh") return s.fields.filter((f) => f.room === room && f.stage === "waechst" && (f.grazed ?? 0) < maxGrazes(k)).map((f) => ({ id: f.fieldId, r: f, name: f.ownerName }));
	const out: Array<{ id: string; r: Rect; name: string }> = [];
	if (k.key === "fuchs") {
		for (const b of s.buildings.filter((x) => x.room === room && k.houses?.includes(x.plan) && x.herd)) {
			const kind = w.animals?.kinds.find((x) => x.key === b.herd!.kind);
			if (kind && (await space.count({ type: "Item", fields: { location: b.buildId, proto: kind.proto } })) >= 2) out.push({ id: b.buildId, r: b, name: b.ownerName });
		}
	}
	if (k.key === "maus") {
		for (const b of s.buildings.filter((x) => x.room === room && planOf(w, x.plan)?.chest)) {
			const food = (await space.readAll({ type: "Item", fields: { location: b.buildId } })).filter((e) => k.eats?.includes(String(e.fields.proto)));
			if (food.length >= 2) out.push({ id: b.buildId, r: b, name: b.ownerName });
		}
	}
	return out;
}
/** The rooms a kind might come to at all, from what the tick read (no further reads). */
function roomsFor(w: WorldDef, k: WildKind, s: Seen): Set<string> {
	if (k.key === "hase") return new Set(s.beds.map((b) => b.room));
	if (k.key === "reh") return new Set(s.fields.filter((f) => f.stage === "waechst").map((f) => f.room));
	if (k.key === "fuchs") return new Set(s.buildings.filter((b) => k.houses?.includes(b.plan) && b.herd).map((b) => b.room));
	return new Set(s.buildings.filter((b) => planOf(w, b.plan)?.chest).map((b) => b.room));
}

/** The wild's recurring job (engine/worldevents.ts, "wild"): animals whose time has come eat and go, then each room with
 *  targets in fog may get a new one of each kind. Writes only when one comes or eats. */
export async function wildTick(space: SpaceLike, w: WorldDef, leaseMs: number, rnd: () => number = Math.random): Promise<{ came: number; ate: number }> {
	const wd = w.wild;
	if (!wd) return { came: 0, ate: 0 };
	const now = await worldNowOf(space);
	const kinds = wildKinds(wd).filter((k) => k.key === "hase" ? !!w.garden : k.key === "reh" ? !!w.fields : k.key === "fuchs" ? !!w.animals : true);
	const animals = (await space.readAll({ type: "Animal" })).map((e) => fieldsOf<AnimalFields>(e));
	const beds = w.garden ? (await space.readAll({ type: "Bed" })).map((e) => fieldsOf<BedFields>(e)) : [];
	const fields = kinds.some((k) => k.key === "reh") ? (await space.readAll({ type: "Field" })).map((e) => fieldsOf<FieldFields>(e)) : [];
	const buildings = (await space.readAll({ type: "Building" })).map((e) => fieldsOf<BuildingFields>(e));
	const s: Seen = { now, beds, fields, buildings, scarecrows: buildings.filter((b) => b.plan === wd.scarecrow), guards: guardsIn(wd, buildings, now) };
	let came = 0, ate = 0;
	const waiting: AnimalFields[] = [];
	for (const a of animals) {
		if (a.eatsAtWorldMs > now) { waiting.push(a); continue; }
		const r = await eat(space, w, leaseMs, a, s, rnd);
		if (r) ate++;
		if (r === null) waiting.push(a);
	}
	const isNight = night(now);
	for (const k of kinds) for (const room of roomsFor(w, k, s)) {
		const fog = await fogOf(space, room);
		if (fog <= 0 || waiting.filter((a) => a.room === room && (a.kind ?? "hase") === k.key).length >= wd.maxPerRoom) continue;
		if (rnd() >= (k.chance[Math.min(3, fog)] ?? 0) * (isNight ? k.nightFactor : (k.dayFactor ?? 1))) continue;
		const target = pick(await targets(space, w, k, room, s), rnd);
		if (!target) continue;
		const covered = new Set((await space.readAll({ type: "Plot", fields: { room } })).map((e) => `${e.fields.x},${e.fields.y}`));
		const at = beside(w, room, target.r, covered, rnd);
		if (!at) continue;
		const a: AnimalFields = { animalId: `${k.key}-${randomBytes(5).toString("hex")}`, kind: k.key, name: k.name, room, ...at, ...(k.key === "hase" ? { bedId: target.id } : { target: target.id }), eatsAtWorldMs: now + k.eatAfterWorldMs, at: now };
		await space.write({ type: "Animal", fields: a as never }, null, FOREVER);
		waiting.push(a);
		const where = k.key === "hase" ? `ans ${target.name}` : owner(k, target.name);
		await tell(space, leaseMs, room, `${cap(k.nom)} ${k.goes} aus dem Nebel ${where}. („scheuche ${k.key}“ jagt ${pron(k)} fort.)`);
		came++;
	}
	return { came, ate };
}

const wild = (c: CommandCtx): WildDef => {
	const wd = c.world.wild;
	if (!wd) throw new CommandError("In dieser Welt kommt kein Wild aus dem Nebel.");
	return wd;
};
const GENERIC = /^(?:das\s+)?(?:wild|tiere?|alle)$/i;

const scheuche: Command = {
	key: "scheuche", aliases: ["verscheuche", "scheuchen", "verscheuchen", "scare", "shoo"],
	help: "scheuche [hase|reh|fuchs|maus] – ein Tier aus dem Nebel bis drei Schritte von dir zurückjagen, bevor es frisst",
	async func(c, arg) {
		const wd = wild(c), kinds = wildKinds(wd);
		const word = arg.trim().replace(/\s+(?:weg|fort)$/i, "").replace(/^(?:den|die|das|der)\s+/i, "").toLowerCase();
		const named = word && !GENERIC.test(word) ? kinds.find((k) => [k.key, k.name, ...k.aliases].some((x) => x.toLowerCase() === word)) : undefined;
		if (word && !GENERIC.test(word) && !named) throw new NotUnderstood(`Verscheuchen lässt sich Wild aus dem Nebel: ${kinds.map((k) => `„scheuche ${k.key}“`).join(", ")}.`);
		const here = (await c.space.readAll({ type: "Animal", fields: { room: c.actor.room } })).map((e) => fieldsOf<AnimalFields>(e))
			.filter((a) => !named || (a.kind ?? "hase") === named.key).sort((a, b) => gap(c.actor, a) - gap(c.actor, b));
		const a = here[0];
		if (!a) throw new CommandError(named ? `Hier ist ${named.none}.` : "Hier ist kein Wild.");
		const k = kindOf(wd, a);
		if (gap(c.actor, a) > wd.scareReach) throw new NotUnderstood(`Geh näher heran: ${k.the} ist zu weit weg (höchstens ${wd.scareReach} Schritte).`);
		if (!(await c.space.takeIfExists({ type: "Animal", fields: { animalId: a.animalId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${cap(k.the)} ist schon fort.`);
		await msg(c, "*", "emote", `${c.actor.name} scheucht ${k.acc} in den Nebel zurück.`);
	},
};

/** Takes what a fence costs from the actor's pack; throws (naming it) when something is missing. */
async function payFence(c: CommandCtx, needs: Array<{ proto: string; count: number }>): Promise<void> {
	const inv = await inventory(c);
	const missing = needs.filter((n) => inv.filter((i) => i.f.proto === n.proto).length < n.count);
	if (missing.length) throw new CommandError(`Für diesen Zaun brauchst du ${needs.map((n) => `${n.count} ${protoName(c, n.proto)}`).join(" und ")}.`);
	for (const n of needs) for (const it of inv.filter((i) => i.f.proto === n.proto).slice(0, n.count)) {
		if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError("Dein Material ist gerade nicht greifbar; bitte noch einmal.");
	}
}

const zaeune: Command = {
	key: "zäune", aliases: ["zaeune", "umzäune", "umzaeune", "zäunen", "zaeunen", "fence"],
	help: "zäune – einen Zaun um ein Beet (2 Treibholz, 1 Tangseil), eine Flur oder einen Hühnerstall neben dir setzen: Hasen, Rehe und Füchse kommen nicht mehr hinein",
	async func(c) {
		const wd = wild(c), room = { room: c.actor.room };
		const near = <F extends Rect>(xs: F[]) => xs.filter((x) => distTo(c.actor, x) <= 1);
		const beds = near((await c.space.readAll({ type: "Bed", fields: room })).map((e) => fieldsOf<BedFields>(e))).filter((b) => mayTend(c, b));
		if (beds.length) {
			const b = await bedHere(c, { may: (x) => mayTend(c, x), reach: 1 });
			if (b.fenced) throw new CommandError(`Um das ${bedName(b)} steht schon ein Zaun.`);
			await payFence(c, wd.fence);
			await writeBed(c, { ...b, fenced: true, untilWorldMs: Math.max(b.untilWorldMs, (await worldNowOf(c.space, c.txn)) + (c.world.garden?.bed.keepWorldMs ?? 0)) });
			return msg(c, "*", "emote", `${c.actor.name} setzt einen Zaun um das ${bedName(b)}; kein Hase kommt mehr hinein.`);
		}
		const mineField = (f: FieldFields) => f.accountId === c.account?.accountId || !!f.open;
		if (wd.fieldFence && near((await c.space.readAll({ type: "Field", fields: room })).map((e) => fieldsOf<FieldFields>(e))).some(mineField)) {
			const r = await takeNear<FieldFields>(c, "Field", "fieldId", 1, mineField);
			if (!("f" in r)) throw new CommandError("Die Flur ist gerade nicht greifbar; bitte noch einmal.");
			if (r.f.fenced) throw new CommandError(`Um die ${fieldName(r.f)} steht schon ein Zaun.`);
			await payFence(c, wd.fieldFence);
			await c.space.write({ type: "Field", fields: { ...r.f, fenced: true } as never }, c.txn, FOREVER);
			return msg(c, "*", "emote", `${c.actor.name} zieht einen Zaun um die ${fieldName(r.f)}; kein Reh kommt mehr hinein.`);
		}
		const houses = wildKinds(wd).find((k) => k.key === "fuchs")?.houses ?? [];
		const mineCoop = (b: BuildingFields) => b.accountId === c.account?.accountId && houses.includes(b.plan);
		if (wd.coopFence && near((await c.space.readAll({ type: "Building", fields: room })).map((e) => fieldsOf<BuildingFields>(e))).some(mineCoop)) {
			const r = await takeNear<BuildingFields>(c, "Building", "buildId", 1, mineCoop);
			if (!("f" in r)) throw new CommandError("Der Stall ist gerade nicht greifbar; bitte noch einmal.");
			if (r.f.fenced) throw new CommandError("Um den Stall steht schon ein Zaun.");
			await payFence(c, wd.coopFence);
			await putBack(c, { ...r.f, fenced: true });
			return msg(c, "*", "emote", `${c.actor.name} setzt einen Zaun mit Tür um den Stall; kein Fuchs kommt mehr hinein.`);
		}
		throw new NotUnderstood("Neben dir ist kein Beet, keine Flur und kein Hühnerstall, den du einzäunen darfst.");
	},
};

export const WILD_COMMANDS: Command[] = [scheuche, zaeune];
