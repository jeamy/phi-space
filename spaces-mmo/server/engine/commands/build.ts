// Building (docs/siedeln.en.md, "Wie ein Bau entsteht", step 1): a player stakes out a site for a plan; everyone may
// deliver what it needs and work on it; when nothing is missing it becomes the building, in the same transaction.
//
// - The site, and later the building, stands on Plot entries, one per cell, written with the space's `unique` check on
//   room and cell: two never share a cell, however many stake out at once, and nobody walks onto them
//   (occupancy.ts blockedIn).
// - Nothing may close a way: no exit, door or fire cell, nothing on a thing or a person, and with the footprint the
//   room's exits, its spawn and a place beside each fire must stay reachable.
// - Light is building land: a site needs a burning fire that covers its room, and takes `points` of that fire's light
//   (LightUse, one entry per fire, taken in the transaction). A full fire takes no more.
// - Delivered goods and work points are counted on the Site entry taken in the command's transaction, so twenty people
//   delivering at once finish it exactly once and nothing is lost or counted twice. What is not needed stays in the pack.
// - At most half of what a site gets may come from NPCs or automata.
// - A site without progress lapses at its world time (the sweep, buildSweep); work makes a figure rest a while (WorkRest).
import { hutsIn, needRank, rankOf, settlementIn } from "./settlement.ts";
import { epochName, epochOf, islandOf, needEpoch } from "./epoch.ts";
import { blessed } from "./chapel.ts";
import { zoneRefusal } from "./townhall.ts";
import { satedFactor } from "./food.ts";
import { closeOrders, keptUntil, orderLine, ordersOfSite, payFor } from "./siteorder.ts";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type EstateFields, type FreightFields, type FireBuilderFields, type IntentFields, type ItemFields, type LightUseFields, type MillLoadFields, type PlotFields, type RoomFields, type RuinFields, type SceneryFields, type StoreLogFields, type SiteFields, type WorkRestFields } from "../../model.ts";
import { resolvePrototype, spawn } from "../prototypes.ts";
import { peek } from "../../space.ts";
import { decayNowOf, patienceOf, worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { byName, CommandError, exitsHere, inventory, msg, NotUnderstood, roomOf, type CommandCtx, itemsNamed } from "../context.ts";
import { coversOf, flameOf, isLit } from "../fire.ts";
import { blockedIn, cellKey, isPassage, occupiedIn } from "../occupancy.ts";
import { placeIn, relocate } from "./default.ts";
import { walkable, type PlanDef, type WorldDef } from "../world.ts";
import { setting, workRestMs } from "../../settings.ts";
import { chestOrder, fmtLoad, loadAt, loadOf, loadOfAll, packMax } from "../pack.ts";
import type { CourierFields } from "../courier.ts";
import { randomBytes, timeNow } from "../source.ts";

export const ARTICLE = /^(?:eine?n?|einem|der|die|das|den|dem|a|an|the)\s+/i;
export type Rect = { x: number; y: number; w: number; h: number };
export const cells = (r: Rect) => { const out: Array<{ x: number; y: number }> = []; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y }); return out; };
/** Chebyshev distance from a cell to a rectangle (0: inside, 1: beside it). */
export const distTo = (p: { x: number; y: number }, r: Rect) => Math.max(Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1)));
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A person, for the rules of building and sowing: a player, or a settler (an NPC that plays like one, server/npc/settlers.ts). */
export const human = (c: CommandCtx) => !!c.account && (!!c.account.settler || (!c.account.npc && !c.actor.charId.startsWith("npc-")));
/** The plan a name means ("hütte", "eine Hütte"). */
export const planOf = (w: WorldDef, name: string): PlanDef | undefined => {
	const n = name.trim().toLowerCase().replace(ARTICLE, "");
	return w.building?.plans.find((p) => p.key === n || p.name.toLowerCase() === n || p.aliases.includes(n));
};
export const missing = (s: SiteFields) => [...s.needs.filter((n) => n.have < n.count).map((n) => `${n.count - n.have} ${n.name}`), ...(s.work < s.workNeed ? [`${s.workNeed - s.work} Arbeit`] : [])];

/** The cells reachable from `from` without passing `blocked` (4 directions, as one walks). */
function reachable(w: WorldDef, ground: string[], from: { x: number; y: number }, blocked: ReadonlySet<string>): Set<string> {
	const seen = new Set<string>([cellKey(from)]);
	let ring = [from];
	while (ring.length) {
		const next: Array<{ x: number; y: number }> = [];
		for (const c of ring) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
			const n = { x: c.x + dx, y: c.y + dy }, k = cellKey(n);
			if (seen.has(k) || blocked.has(k) || !walkable(w, ground, n.x, n.y)) continue;
			seen.add(k); next.push(n);
		}
		ring = next;
	}
	return seen;
}

/** Why `rect` cannot be built on (null: it can). */
/** The cobbles of paths and plazas: nothing is built or dug on them (docs/siedeln.en.md "Bebauung"). */
export const PATH = ":";
/** `onPeople`: beds and fields are dug and sown under anyone's feet, who walks off them afterwards (default.ts moveTo). */
/** How far from an exit a plan `atExit` may lie: the cells right beside it stay free (isPassage). */
export const EXIT_REACH = 2;

export async function refusal(c: CommandCtx, room: RoomFields, rect: Rect, green = false, onPeople = false): Promise<string | null> {
	const height = room.ground.length, width = room.ground[0]?.length ?? 0;
	if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > width || rect.y + rect.h > height) return "Dort ist der Raum zu Ende.";
	const zoned = await zoneRefusal(c, room.roomId, cells(rect), green);
	if (zoned) return zoned;
	const exits = (await exitsHere(c, room.roomId)).map((x) => x.f);
	const blocked = await blockedIn(c.space, c.world, room.roomId);
	// the builder is no one in the way: it steps off the site it staked out (bau); beds and fields are dug under anyone's feet
	const people = await occupiedIn(c.space, room.roomId, c.actor.charId);
	const things = new Set((await c.space.readAll({ type: "Item", fields: { location: room.roomId } })).map((e) => cellKey(e.fields as never)));
	const fires = c.world.beacons.filter((b) => b.room === room.roomId);
	for (const p of cells(rect)) {
		const k = cellKey(p);
		if (!walkable(c.world, room.ground, p.x, p.y)) return "Dort ist kein fester Boden.";
		if (room.ground[p.y]?.[p.x] === PATH) return "Das ist ein Weg; Wege und Plätze bleiben frei.";
		if (isPassage(exits, p)) return "Dort ist ein Weg hinaus; den baut niemand zu.";
		if (fires.some((b) => Math.max(Math.abs(b.x - p.x), Math.abs(b.y - p.y)) <= 1)) return "So nah am Feuer baut man nicht.";
		if (blocked.has(k)) { const piece = (await c.space.readAll({ type: "Scenery", fields: { room: room.roomId } })).map((e) => fieldsOf<SceneryFields>(e)).find((s) => distTo(p, s) === 0); return piece && !piece.fixed ? `Dort steht ${piece.name}; erst abräumen (räume).` : "Dort steht schon etwas oder wird gebaut."; }
		if (!onPeople && people.has(k)) return "Dort steht jemand.";
		if (things.has(k)) return "Dort liegt etwas; räum es erst weg.";
	}
	// nothing may close a way: from the room's spawn every exit, every fire's side and the builder stay reachable
	const after = new Set([...blocked, ...cells(rect).map(cellKey)]);
	const start = room.spawn && !after.has(cellKey(room.spawn)) ? room.spawn : exits[0] ? { x: exits[0].x, y: exits[0].y } : { x: c.actor.x, y: c.actor.y };
	const reach = reachable(c.world, room.ground, start, after);
	const ok = (p: { x: number; y: number }) => reach.has(cellKey(p));
	if (!exits.every((x) => ok(x)) || (room.spawn && !ok(room.spawn)) || !(ok(c.actor) || distTo(c.actor, rect) === 0)) return "Damit wäre ein Weg zugebaut.";
	if (!fires.every((b) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ok({ x: b.x + dx!, y: b.y + dy! })))) return "Damit käme niemand mehr ans Feuer.";
	return null;
}

/** The rectangles beside the actor where `plan` could go, nearest sides first (below, right, left, above, corners). */
export function besides(c: CommandCtx, plan: Pick<PlanDef, "w" | "h">): Rect[] {
	const { x, y } = c.actor, out: Rect[] = [];
	for (let ry = y - plan.h; ry <= y + 1; ry++) for (let rx = x - plan.w; rx <= x + 1; rx++) {
		const r = { x: rx, y: ry, w: plan.w, h: plan.h };
		if (distTo(c.actor, r) === 1) out.push(r);
	}
	const side = (r: Rect) => (r.y === y + 1 ? 0 : r.x === x + 1 ? 1 : r.x + r.w === x ? 2 : 3) * 10 + Math.abs(r.x + r.w / 2 - 0.5 - x) + Math.abs(r.y + r.h / 2 - 0.5 - y);
	return out.sort((a, b) => side(a) - side(b));
}

/** What a fire's light carries: more with each registered player who built here lately, so a busy island is not stuck and a
 *  deserted one holds no place. */
async function lightOf(c: CommandCtx, beaconId: string): Promise<number> {
	const def = c.world.building, base = def?.lightPoints ?? 0, more = def?.lightGrowth;
	const bonus = (await c.space.readAll({ type: "Building", fields: { beaconId } }, { txn: c.txn })).reduce((n, e) => n + (planOf(c.world, String(e.fields.plan))?.lightBonus ?? 0), 0); // a lighthouse
	if (!more) return base + bonus;
	const now = await decayNowOf(c.space, c.txn), active = (await c.space.readAll({ type: "FireBuilder", fields: { beaconId } }, { txn: c.txn })).filter((e) => fieldsOf<FireBuilderFields>(e).atWorldMs + more.activeMs > now).length;
	return Math.min(more.max, base + active * more.perPlayer) + bonus;
}
/** The actor counts as building at this fire. Figures fill the light, they do not widen it. */
async function noteBuilder(c: CommandCtx, beaconId: string): Promise<void> {
	if (!c.world.building?.lightGrowth || !c.account || c.account.guest || c.account.settler) return;
	const key = { beaconId, accountId: c.account.accountId };
	await c.space.takeIfExists({ type: "FireBuilder", fields: key }, NO_WAIT, { txn: c.txn });
	await c.space.write({ type: "FireBuilder", fields: { ...key, atWorldMs: await decayNowOf(c.space, c.txn) } satisfies FireBuilderFields as never }, c.txn, FOREVER);
}

/** Whether a cell beside the rect is water. */
const touchesWater = (w: WorldDef, room: RoomFields, r: Rect) => cells({ x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 }).some((p) => room.ground[p.y]?.[p.x] !== undefined && !walkable(w, room.ground, p.x, p.y));

/** A burning fire that covers the room and has light left for `points` (its LightUse taken in the transaction); null with
 *  the reason. */
export async function lightFor(c: CommandCtx, points: number): Promise<{ beaconId: string; use: LightUseFields; fresh: boolean } | string> {
	const now = await worldNowOf(c.space, c.txn);
	// a settler leaves part of the light free for the people who come (world settlers.reserve)
	const share = c.account?.settler ? 1 - (c.world.settlers?.reserve ?? 0.25) : 1;
	// a lighthouse widens its fire to the rooms around it (fire.ts coversOf): its light is shared there too
	const cover = await coversOf(c.space, c.world, c.txn);
	const fires = c.world.beacons.filter((b) => cover.get(b.beaconId)?.includes(c.actor.room)).sort((a, b) => Number(b.room === c.actor.room) - Number(a.room === c.actor.room));
	if (!fires.length) return "Hier hält kein Feuer den Nebel fern; gebaut wird nur im Licht.";
	let lit = false;
	for (const b of fires) {
		if (!isLit(await flameOf(c.space, b.beaconId), now)) continue;
		lit = true;
		const e = await c.space.takeIfExists({ type: "LightUse", fields: { beaconId: b.beaconId } }, NO_WAIT, { txn: c.txn });
		if (!e && (await c.space.count({ type: "LightUse", fields: { beaconId: b.beaconId } }))) throw new CommandError("Gerade baut jemand anderes im Licht dieses Feuers; bitte gleich noch einmal.");
		const use = e ? fieldsOf<LightUseFields>(e) : { beaconId: b.beaconId, used: 0 };
		if (use.used + points <= (await lightOf(c, b.beaconId)) * share) return { beaconId: b.beaconId, use, fresh: !e };
		if (e) await c.space.write({ type: "LightUse", fields: use as never }, c.txn, FOREVER); // unchanged, back
	}
	return lit ? "Das Licht des Feuers reicht für keinen weiteren Bau; ein Leuchtturm oder ein zweites Feuer würde helfen." : "Das Feuer, das hier Licht gibt, ist aus; gebaut wird nur im Licht.";
}
/** Writes the fire's light use back (`fresh`: its first: with the unique check, so two first sites cannot both write one). */
export async function useLight(c: CommandCtx, beaconId: string, use: LightUseFields, delta: number, fresh: boolean): Promise<void> {
	try { await c.space.write({ type: "LightUse", fields: { beaconId, used: Math.max(0, use.used + delta) } as never }, c.txn, FOREVER, fresh ? { unique: ["beaconId"] } : {}); }
	catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Gerade baut jemand anderes im Licht dieses Feuers; bitte gleich noch einmal."); throw e; }
}

/** How far from a site one still delivers and works on it: two cells, so a crowd fits (a hut of 2×2 has 12 cells beside
 *  it, 32 within two; one figure per cell). Chest, repair and demolition stay beside the building. */
export const SITE_REACH = 2;

/** The entry of `type` (a site, a bed) within `reach` of the actor whose cells (Plot `of`) carry `idKey`, taken in the
 *  transaction; `named` picks among several. One another command holds right now is not read (it is taken in that
 *  transaction), but its cells are: it is waited for through them. Null: none within reach (`far`: one in the room). */
export async function takeNear<F extends Rect>(c: CommandCtx, type: string, idKey: keyof F & string, reach: number, named: (f: F) => boolean = () => true): Promise<{ f: F } | { far: boolean }> {
	const all = (await c.space.readAll({ type, fields: { room: c.actor.room } })).map((e) => fieldsOf<F>(e));
	// the nearest first: what the figure stands at, not what lies two steps behind it
	const near = all.filter((f) => distTo(c.actor, f) <= reach && named(f)).sort((a, b) => distTo(c.actor, a) - distTo(c.actor, b));
	if (near.length) {
		const e = await c.space.take({ type, fields: { [idKey]: near[0]![idKey] as never } }, 5_000, { txn: c.txn });
		if (!e) throw new CommandError("Das ist gerade nicht greifbar; bitte noch einmal.");
		return { f: fieldsOf<F>(e) };
	}
	const plots = (await c.space.readAll({ type: "Plot", fields: { room: c.actor.room } })).map((e) => fieldsOf<PlotFields>(e));
	const held = new Set(plots.filter((p) => distTo(c.actor, { x: p.x, y: p.y, w: 1, h: 1 }) <= reach && !all.some((f) => String(f[idKey]) === p.of)).map((p) => p.of));
	for (const id of held) {
		const e = await c.space.takeIfExists({ type, fields: { [idKey]: id } }, 5_000, { txn: c.txn });
		if (!e) continue; // cells of something else, or it is gone meanwhile
		const f = fieldsOf<F>(e);
		if (named(f)) return { f };
		await c.space.write({ type: e.type, types: e.types.slice(1), fields: e.fields as never }, c.txn, FOREVER);
	}
	return { far: all.length > 0 };
}

/** The site within SITE_REACH of the actor (by plan name when given), taken in the transaction. */
export async function siteHere(c: CommandCtx, name: string): Promise<{ s: SiteFields }> {
	const r = await takeNear<SiteFields>(c, "Site", "buildId", SITE_REACH, (s) => !name || planOf(c.world, name)?.key === s.plan || s.name.toLowerCase() === name.toLowerCase());
	if ("f" in r) return { s: r.f };
	throw new NotUnderstood(r.far ? "Geh näher an die Baustelle heran (höchstens zwei Schritte entfernt)." : "Hier ist keine Baustelle. „bau <plan>“ steckt eine ab.");
}

const WORLD_DAY = 24 * 3600_000;
/** How long a plan stands after building or repair: the admin's setting when it has one. */
async function keepOf(c: CommandCtx, plan: PlanDef | undefined): Promise<number> {
	if (plan?.keepSetting) return (await setting(c.space, plan.keepSetting)) * WORLD_DAY;
	return plan?.keepWorldMs ?? 7 * WORLD_DAY;
}

/** Writes the site back, or, when nothing is missing, the building in its place. */
export async function settle(c: CommandCtx, s: SiteFields): Promise<void> {
	const now = await worldNowOf(c.space, c.txn), kept = await decayNowOf(c.space, c.txn);
	if (s.needs.every((n) => n.have >= n.count) && s.work >= s.workNeed) {
		const plan = planOf(c.world, s.plan);
		const b: BuildingFields = { buildId: s.buildId, plan: s.plan, name: s.name, room: s.room, x: s.x, y: s.y, w: s.w, h: s.h, owner: s.owner, ownerName: s.ownerName, accountId: s.accountId, beaconId: s.beaconId, points: s.points, by: s.by, untilWorldMs: kept + (await keepOf(c, plan)), builtAt: now };
		await c.space.write({ type: "Building", fields: b as never }, c.txn, FOREVER);
		await closeOrders(c.space, c.txn, s, kept + (c.world.building?.estateWorldMs ?? 30 * 24 * 3600_000));
		const helpers = Object.entries(s.by).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} (${k})`).join(", ");
		await msg(c, "*", "world", `Die ${s.name} von ${s.ownerName} steht! Mitgebaut: ${helpers}.`);
		return;
	}
	await c.space.write({ type: "Site", fields: { ...s, untilWorldMs: kept + (c.world.building?.siteWorldMs ?? 2 * 24 * 3600_000) } as never }, c.txn, FOREVER);
}
/** Counts a contribution of `n` for the actor; NPCs and automata may give at most half of what the site needs. */
function credit(c: CommandCtx, s: SiteFields, n: number): number {
	const total = s.needs.reduce((a, x) => a + x.count, 0) + s.workNeed;
	if (!human(c)) n = Math.max(0, Math.min(n, Math.floor(total / 2) - s.other));
	if (!n) throw new CommandError("Diese Baustelle bauen Menschen; Helfer haben ihren Teil schon getan.");
	if (human(c)) s.human += n; else s.other += n;
	s.by = { ...s.by, [c.actor.name]: (s.by[c.actor.name] ?? 0) + n };
	return n;
}

/** "baue" is also the word for crafting (trade.ts): a plan's name after it comes here. */
export const bau: Command = {
	key: "bau", aliases: ["build", "errichte"],
	help: "bau <plan> – neben dir eine Baustelle abstecken (bau allein: die Baupläne; bau <plan> <x> <y>: an einer Stelle)",
	async func(c, arg) {
		const def = c.world.building;
		if (!def?.plans.length) throw new CommandError("In dieser Welt wird nicht gebaut.");
		if (!arg.trim()) {
			const epoch = await epochOf(c.space, islandOf(c.world, c.actor.room), c.txn);
			const list = [...def.plans].sort((a, b) => a.name.localeCompare(b.name, "de")).map((p) => `${p.name}${(p.epoch ?? 1) > epoch ? ` (erst ab ${epochName(c.world, p.epoch!)})` : ""} (${p.w}×${p.h}): ${p.needs.map((n) => `${n.count} ${c.world.prototypes.find((x) => x.key === n.proto)?.name ?? n.proto}`).join(", ")}, ${p.work} Arbeit`);
			return msg(c, c.actor.charId, "info", `Baupläne: ${list.join("; ")}. „bau <plan>“ steckt neben dir eine Baustelle ab; liefern und arbeiten können alle.`);
		}
		const m = /^(\S+)(?:\s+(\d+)\s+(\d+))?$/.exec(arg.trim().replace(ARTICLE, ""));
		const plan = m && planOf(c.world, m[1]!);
		if (!plan) throw new NotUnderstood(`Einen Bauplan „${arg.slice(0, 20)}“ gibt es nicht. „bau“ zeigt die Pläne.`);
		if (!c.account || c.account.guest) throw new CommandError("Gäste können liefern und mitarbeiten, aber nichts besitzen; registriere dich, um selbst zu bauen.");
		if (!human(c)) throw new CommandError("Baustellen stecken nur Menschen ab.");
		await needEpoch(c, plan.epoch, `Der Bauplan „${plan.name}“`);
		await needRank(c, "siedler", "Bauen");
		const open = (await c.space.readAll({ type: "Site", fields: { accountId: c.account.accountId } }, { txn: c.txn })).map((e) => fieldsOf<SiteFields>(e));
		if (open.length >= def.maxSites) {
			const where = open.map((s) => `${s.name} in ${c.world.rooms.find((r) => r.roomId === s.room)?.name ?? s.room} (${s.x} ${s.y})`).join(", ");
			throw new CommandError(`Du hast schon eine offene Baustelle: ${where}; bau sie erst fertig.`);
		}
		// small things and animal houses do not count; how many count grows with the island's epoch (the operator's settings)
		const free = new Set(def.uncounted ?? []);
		if (!free.has(plan.key)) {
			const epoch = await epochOf(c.space, islandOf(c.world, c.actor.room), c.txn);
			const max = (await setting(c.space, `build.max${Math.min(4, Math.max(1, epoch))}`).catch(() => undefined)) ?? def.maxBuildings;
			const held = open.filter((s) => !free.has(s.plan)).length + (await c.space.readAll({ type: "Building", fields: { accountId: c.account.accountId } }, { txn: c.txn })).filter((e) => !free.has(String(e.fields.plan))).length;
			if (held >= max) throw new CommandError(`Mehr als ${max} Bauten hat hier niemand (${epochName(c.world, epoch)}); Regentonne, Vogelscheuche, Ställe, Gehege, Bienenstock, Straße und Signalfeuer zählen nicht mit.`);
		}
		const herds = c.world.animals;
		if (herds?.houses[plan.key]) {
			const maxHouses = (await setting(c.space, "animals.houses").catch(() => undefined)) ?? herds.maxHouses ?? Infinity;
			const mine = [...(await c.space.readAll({ type: "Building", fields: { accountId: c.account.accountId } })), ...(await c.space.readAll({ type: "Site", fields: { accountId: c.account.accountId } }))];
			if (mine.filter((e) => herds.houses[String(e.fields.plan)]).length >= maxHouses) throw new CommandError(`Mehr als ${maxHouses} Ställe, Gehege und Bienenstöcke hält niemand im Blick.`);
		}
		if (plan.onePerRoom && ((await c.space.count({ type: "Building", fields: { room: c.actor.room, plan: plan.key } })) || (await c.space.count({ type: "Site", fields: { room: c.actor.room, plan: plan.key } })))) throw new CommandError(`Ein Raum hat höchstens einen Bau „${plan.name}“, und hier steht er schon (oder seine Baustelle).`);
		const light = await lightFor(c, plan.points);
		if (typeof light === "string") throw new CommandError(light);
		await noteBuilder(c, light.beaconId);
		const room = await roomOf(c);
		const tries = m[2] !== undefined ? [{ x: Number(m[2]), y: Number(m[3]), w: plan.w, h: plan.h }] : besides(c, plan);
		let rect: Rect | null = null, why = "";
		const exits = plan.atExit ? await exitsHere(c) : [];
		for (const r of tries) { const no = (await refusal(c, room, r, !!plan.green, !!plan.green)) ?? (plan.shore && !touchesWater(c.world, room, r) ? "Das muss ans Wasser grenzen." : plan.atExit && !exits.some((x) => distTo(x.f, r) <= EXIT_REACH) ? "Eine Straße beginnt neben einem Ausgang." : null); if (!no) { rect = r; break; } why ||= no; }
		if (!rect) throw new CommandError(`Hier passt keine ${plan.name} hin: ${why}`);
		const buildId = randomBytes(6).toString("hex"), now = await worldNowOf(c.space, c.txn);
		for (const p of cells(rect)) {
			try { await c.space.write({ type: "Plot", fields: { room: room.roomId, x: p.x, y: p.y, of: buildId } as never }, c.txn, FOREVER, { unique: ["room", "x", "y"] }); }
			catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Dort hat gerade jemand anderes abgesteckt."); throw e; }
		}
		await useLight(c, light.beaconId, light.use, plan.points, light.fresh);
		const s: SiteFields = { buildId, plan: plan.key, name: plan.name, room: room.roomId, ...rect, owner: c.actor.charId, ownerName: c.actor.name, accountId: c.account.accountId,
			needs: plan.needs.map((n) => ({ proto: n.proto, name: c.world.prototypes.find((x) => x.key === n.proto)?.name ?? n.proto, count: n.count, have: 0 })), work: 0, workNeed: plan.work, human: 0, other: 0, beaconId: light.beaconId, points: plan.points, by: {},
			untilWorldMs: (await decayNowOf(c.space, c.txn)) + def.siteWorldMs, at: now };
		await c.space.write({ type: "Site", fields: s as never }, c.txn, FOREVER);
		// standing on it, the builder steps off onto the nearest free cell beside it
		if (distTo(c.actor, rect) === 0) { const off = await placeIn(c, room, c.actor, { avoid: cells(rect).map(cellKey), exits: false }); await relocate(c, { room: room.roomId, ...off }, { spot: false }); }
		await msg(c, "*", "info", `${c.actor.name} steckt eine Baustelle ab: ${plan.name}. Es fehlen ${missing(s).join(", ")} – liefern („liefere <ding>“) und mitarbeiten („arbeite“) können alle.`);
	},
};

const liefere: Command = {
	key: "liefere", aliases: ["deliver"],
	help: "liefere [n] <ding> – an die Baustelle neben dir (bis zwei Schritte) liefern, was sie braucht (zu viel bleibt bei dir)",
	async func(c, arg) {
		const m = /^(?:(\d+)\s+)?(.+?)(?:\s+(?:an|zur|zu|to|für|fuer)\s+(?:die\s+|der\s+)?(.+))?$/i.exec(arg.trim());
		if (!m) throw new NotUnderstood("Was lieferst du? Zum Beispiel: liefere 3 treibholz");
		await needRank(c, "helfer", "Liefern");
		const hits = itemsNamed(c.world, await inventory(c), m[2]!.replace(ARTICLE, ""));
		if (!hits.length) throw new NotUnderstood(`Du trägst nichts, was „${m[2]!.slice(0, 30)}“ heißt.`);
		const proto = hits[0]!.f.proto;
		const { s } = await siteHere(c, m[3] && !/^baustelle$/i.test(m[3]) ? m[3] : "");
		const need = s.needs.find((n) => n.proto === proto);
		if (!need) throw new CommandError(`Die ${s.name} braucht kein ${hits[0]!.f.name}. Es fehlen ${missing(s).join(", ") || "nur noch Hände"}.`);
		const open = need.count - need.have;
		if (open <= 0) throw new CommandError(`${need.name} hat die Baustelle genug. Es fehlen ${missing(s).join(", ")}.`);
		const mine = (await inventory(c)).filter((i) => i.f.proto === proto);
		let n = Math.min(m[1] ? Number(m[1]) : open, open, mine.length);
		if (n <= 0) throw new CommandError(`Du hast kein ${need.name}.`);
		n = credit(c, s, n);
		for (const it of mine.slice(0, n)) if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${it.f.name} ist gerade nicht greifbar; bitte noch einmal.`);
		need.have += n;
		// the owner pays nobody for its own share: its order stays for the others (and its wage goes back when the site stands)
		const wage = s.owner === c.actor.charId ? 0 : await payFor(c, s.buildId, proto, n);
		await msg(c, c.actor.charId, "info", `Du lieferst ${plural(n, `Stück ${need.name}`, `Stück ${need.name}`)} an die ${s.name}.${wage ? ` Lohn: ${plural(wage, "Münze", "Münzen")}.` : ""}${mine.length > n && m[1] && Number(m[1]) > n ? " Den Rest braucht sie nicht; er bleibt bei dir." : ""}${missing(s).length ? ` Es fehlen noch ${missing(s).join(", ")}.` : ""}`);
		await settle(c, s);
	},
};

/** Throws while the actor is tired from the last work. */
export async function rested(c: CommandCtx) {
	const now = await worldNowOf(c.space, c.txn);
	const rest = await peek(c.space, { type: "WorkRest", fields: { charId: c.actor.charId } });
	const until = rest ? fieldsOf<WorkRestFields>(rest).untilWorldMs : 0;
	if (until > now) throw new CommandError(`Du bist noch müde von der letzten Arbeit; in etwa ${Math.max(1, Math.round((until - now) / 60_000))} Minuten wieder.`);
	return { now, rest };
}
/** The actor worked: it rests for a while. */
export async function tire(c: CommandCtx, now: number, rest: Awaited<ReturnType<typeof rested>>["rest"]): Promise<void> {
	if (rest) await c.space.takeIfExists({ id: rest.id }, NO_WAIT, { txn: c.txn });
	const ms = (await workRestMs(c.space)) / ((await blessed(c, now)) ? 2 : 1) / (await satedFactor(c, now));
	await c.space.write({ type: "WorkRest", fields: { charId: c.actor.charId, untilWorldMs: now + ms } satisfies WorkRestFields as never }, c.txn, FOREVER);
}

const arbeite: Command = {
	key: "arbeite", aliases: ["work"],
	help: "arbeite – an der Baustelle neben dir (bis zwei Schritte) mitarbeiten (danach ruhst du eine Weile)",
	async func(c, arg) {
		await needRank(c, "helfer", "Mitarbeiten");
		const { now, rest } = await rested(c);
		const { s } = await siteHere(c, arg.replace(/^(?:an|auf)\s+(?:der\s+)?/i, "").replace(/^baustelle$/i, ""));
		if (s.work >= s.workNeed) throw new CommandError(`An der ${s.name} ist die Arbeit getan; es fehlen nur noch ${missing(s).join(", ")}.`);
		credit(c, s, 1);
		s.work += 1;
		await tire(c, now, rest);
		const wage = s.owner === c.actor.charId ? 0 : await payFor(c, s.buildId, "", 1);
		await msg(c, "*", "emote", `${c.actor.name} arbeitet an der ${s.name} (${s.work}/${s.workNeed}).`);
		if (wage) await msg(c, c.actor.charId, "info", `Lohn: ${plural(wage, "Münze", "Münzen")}.`);
		await settle(c, s);
	},
};

const baustelle: Command = {
	key: "baustelle", aliases: ["baustellen", "site", "sites"],
	help: "baustelle [x y] – was hier gebaut wird und was noch fehlt (mit x y: nur das auf dieser Zelle)",
	async func(c, arg) {
		const at = /^(\d+)\s+(\d+)$/.exec(arg.trim());
		const here = <F extends Rect>(all: F[]) => (at ? all.filter((r) => distTo({ x: Number(at[1]), y: Number(at[2]) }, r) === 0) : all);
		const sites = here((await c.space.readAll({ type: "Site", fields: { room: c.actor.room } })).map((e) => fieldsOf<SiteFields>(e)));
		const built = here((await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e)));
		const ruins = here((await c.space.readAll({ type: "Ruin", fields: { room: c.actor.room } })).map((e) => fieldsOf<RuinFields>(e)));
		if (!sites.length && !built.length && !ruins.length) return msg(c, c.actor.charId, "info", "Hier wird nichts gebaut. „bau“ zeigt die Baupläne.");
		const now = await worldNowOf(c.space, c.txn);
		const wages = new Map<string, string>();
		for (const s of sites) { const o = await ordersOfSite(c.space, s.buildId); if (o.length) wages.set(s.buildId, ` Lohn: ${o.map(orderLine).join("; ")}.`); }
		const lines = [...sites.map((s) => `${s.accountId === c.account?.accountId ? `Deine Baustelle ${s.name}` : `Baustelle ${s.name} von ${s.ownerName}`}: es fehlen ${missing(s).join(", ")}.${wages.get(s.buildId) ?? ""}`), ...built.map((b) => `${b.name} von ${b.ownerName}: hält noch ${days(b.untilWorldMs - now)} („repariere“ bessert sie aus).`), ...ruins.map((r) => `Ruine einer ${r.name} von ${r.ownerName}.`)];
		await msg(c, c.actor.charId, "look", lines.join("\n"));
	},
};

/** A building beside the actor (by plan name when given; only one's own with `own`), taken in the transaction. */
export async function buildingHere(c: CommandCtx, name: string, o: { own: boolean }): Promise<BuildingFields> {
	const all = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e));
	const n = name.trim().replace(ARTICLE, "");
	const near = all.filter((b) => distTo(c.actor, b) <= 1 && (!n || planOf(c.world, n)?.key === b.plan || b.name.toLowerCase() === n.toLowerCase()));
	const mine = near.filter((b) => b.accountId === c.account?.accountId);
	const b = (o.own ? mine : [...mine, ...near])[0];
	if (!b) throw new NotUnderstood(o.own ? (near.length ? "Das ist nicht dein Bau." : "Geh direkt neben deinen Bau.") : "Geh direkt neben den Bau.");
	const e = await c.space.take({ type: "Building", fields: { buildId: b.buildId } }, 5_000, { txn: c.txn });
	if (!e) throw new CommandError("Der Bau ist gerade nicht greifbar; bitte noch einmal.");
	return fieldsOf<BuildingFields>(e);
}
export const putBack = (c: CommandCtx, b: BuildingFields) => c.space.write({ type: "Building", fields: b as never }, c.txn, FOREVER);
/** Moves a thing (taken in the transaction) to `location`. */
async function moveItem(space: SpaceLike, txn: string | null, itemId: string, from: string, to: string): Promise<boolean> {
	const e = await space.takeIfExists({ type: "Item", fields: { itemId, location: from } }, NO_WAIT, txn ? { txn } : {});
	if (!e) return false;
	await space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, location: to, x: -1, y: -1 } as never }, txn, FOREVER);
	return true;
}
/** "3 holz", "alle muscheln", "tang": how many (null: all) and what. */
export const amount = (arg: string): { n: number | null; name: string } => {
	const m = /^(?:(\d+|alle?|all)\s+)?(.+)$/i.exec(arg.trim().replace(/\s+(?:in|aus|from|into)\s+(?:die\s+|der\s+)?(?:truhe|kiste|chest|lager|lagerhaus|warehouse)$/i, ""));
	if (!m) return { n: 1, name: "" };
	return { n: !m[1] ? 1 : /^\d+$/.test(m[1]) ? Number(m[1]) : null, name: m[2]!.replace(ARTICLE, "") };
};
export const days = (ms: number) => { const d = Math.round(ms / (24 * 3600_000)); return d >= 1 ? `etwa ${d} ${d === 1 ? "Tag" : "Tage"}` : `etwa ${Math.max(1, Math.round(ms / 3600_000))} Stunden`; };

/** A dog or cat left at a building lies in it like the chest's content, but is not part of it (animals.ts). */
const keeperProto = (c: CommandCtx, proto: unknown) => !!c.world.wild?.keepers?.some((k) => k.proto === proto);
/** What lies in a building's chest (its things, without a dog or cat on guard). */
const chestOf = async (c: CommandCtx, buildId: string) => (await c.space.readAll({ type: "Item", fields: { location: buildId } })).filter((e) => !keeperProto(c, e.fields.proto));


/** The chest beside the actor: one's own first, else a warehouse (it need not be one's own: `storeRight` decides). */
/** Beside a building without a chest (a scarecrow, a coop): which plans have one. */
function noChest(c: CommandCtx, b: BuildingFields): CommandError {
	const have = (c.world.building?.plans ?? []).filter((p) => p.chest && !p.store).map((p) => p.name);
	return new CommandError(have.length ? `Die ${b.name} hat keine Truhe (eine haben: ${have.join(", ")}).` : `Die ${b.name} hat keine Truhe.`);
}
async function chestHere(c: CommandCtx): Promise<BuildingFields> {
	const near = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => distTo(c.actor, b) <= 1);
	const own = near.find((b) => b.accountId === c.account?.accountId && planOf(c.world, b.plan)?.chest && !planOf(c.world, b.plan)?.store);
	const store = near.find((b) => planOf(c.world, b.plan)?.store);
	return own || !store ? buildingHere(c, own?.plan ?? "", { own: true }) : buildingHere(c, store.plan, { own: false });
}
/** Who may use a warehouse and how much they may still take today. Without a settlement it is its owner's chest; in one,
 *  the ranks count, also in an open one: an open settlement lets strangers in, not empty the store. */
async function storeRight(c: CommandCtx, b: BuildingFields): Promise<{ left: number; quota: number | null }> {
	const d = c.world.building?.store, s = await settlementIn(c.space, c.actor.room, c.txn);
	if (!d || !s) {
		if (b.accountId === c.account?.accountId) return { left: Infinity, quota: null };
		throw new CommandError(`Dieses Lagerhaus gehört ${b.ownerName}; allen dient es erst in einer Siedlung.`);
	}
	const rank = rankOf(s, await hutsIn(c.space, c.world, s.room, c.txn), c.account);
	if (s.closed && rank === "fremder") throw new CommandError(`${s.name} ist geschlossen: an das Lager dürfen nur Helfer und Siedler.`);
	const now = await worldNowOf(c.space, c.txn), lines = (await c.space.readAll({ type: "StoreLog", fields: { buildId: b.buildId, accountId: c.account?.accountId ?? "", kind: "aus" } })).map((e) => fieldsOf<StoreLogFields>(e));
	const taken = lines.filter((l) => l.worldMs > now - WORLD_DAY).reduce((n, l) => n + l.count, 0);
	return { left: Math.max(0, d.quota[rank] - taken), quota: d.quota[rank] };
}
const logStore = async (c: CommandCtx, b: BuildingFields, kind: StoreLogFields["kind"], itemName: string, count: number) => {
	const line: StoreLogFields = { logId: randomBytes(6).toString("hex"), buildId: b.buildId, accountId: c.account?.accountId ?? "", name: c.actor.name, kind, itemName, count, worldMs: await worldNowOf(c.space, c.txn), at: timeNow() };
	await c.space.write({ type: "StoreLog", fields: line as never }, c.txn, c.world.building?.store?.logKeepMs ?? WORLD_DAY);
};

const lager: Command = {
	key: "lager", aliases: ["warehouse", "depot"],
	help: "lager [log] – was im Lagerhaus neben dir liegt und was du heute noch nehmen darfst; log: wer zuletzt ein- und ausgelagert hat",
	async func(c, arg) {
		const near = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e));
		const b = near.find((x) => planOf(c.world, x.plan)?.store && distTo(c.actor, x) <= 1);
		if (!b) throw new NotUnderstood("Geh direkt neben ein Lagerhaus.");
		const right = await storeRight(c, b);
		if (/^(?:log|protokoll|buch)$/i.test(arg.trim())) {
			const lines = (await c.space.readAll({ type: "StoreLog", fields: { buildId: b.buildId } })).map((e) => fieldsOf<StoreLogFields>(e)).sort((x, y) => y.worldMs - x.worldMs || y.at - x.at);
			const show = lines.slice(0, c.world.building?.store?.logShow ?? 10).map((l) => `  ${l.name} ${l.kind === "aus" ? "nimmt" : "legt ein"}: ${l.count} ${l.itemName}`);
			return msg(c, c.actor.charId, "look", show.length ? ["Das Lagerbuch:", ...show].join("\n") : "Das Lagerbuch ist leer.");
		}
		if (arg.trim()) throw new NotUnderstood("„lager“ zeigt das Lager, „lager log“ das Lagerbuch. Einlagern: verstaue <ding>, nehmen: entnimm <ding>.");
		const count = new Map<string, number>();
		const inside = (await chestOf(c, b.buildId)).map((e) => fieldsOf<ItemFields>(e));
		for (const i of inside) count.set(i.name, (count.get(i.name) ?? 0) + 1);
		const cap = capOf(c, b);
		await msg(c, c.actor.charId, "look", `${inside.length ? `Im Lager (${heldText(c, inside, cap)}): ${[...count].map(([n, k]) => `${k} ${n}`).join(", ")}.` : cap === Infinity ? "Das Lager ist leer." : `Das Lager ist leer (Platz für ${cap}).`}${right.quota === null ? "" : ` Du darfst heute noch ${right.left} von ${right.quota} Dingen nehmen.`}`);
	},
};

const truhe: Command = {
	key: "truhe", aliases: ["kiste", "chest"],
	help: "truhe – was in der Truhe deines Baus neben dir liegt (verstaue <ding>, entnimm <ding>)",
	async func(c) {
		const b = await chestHere(c);
		await putBack(c, b);
		if (planOf(c.world, b.plan)?.store) return lager.func(c, "");
		if (!planOf(c.world, b.plan)?.chest) throw noChest(c, b);
		const cap = capOf(c, b);
		const items = (await chestOf(c, b.buildId)).map((e) => fieldsOf<ItemFields>(e));
		const count = new Map<string, number>(); for (const i of items) count.set(i.name, (count.get(i.name) ?? 0) + 1);
		await msg(c, c.actor.charId, "look", items.length ? `In der Truhe (${heldText(c, items, cap)}): ${[...count].map(([n, k]) => `${k} ${n}`).join(", ")}.` : cap === Infinity ? "Die Truhe ist leer." : `Die Truhe ist leer (Platz für ${cap}).`);
	},
};
/** A chest of one's own, wherever it stands: here (this region's space) or in another region. */
export type OwnChest = { b: BuildingFields; region: string | null; space: SpaceLike };
/** One's chests in every region (a warehouse is not one's chest), in the order the lists number them (chestOrder). */
export async function ownChests(c: CommandCtx): Promise<OwnChest[]> {
	if (!c.account) return [];
	const chestPlan = (b: BuildingFields) => !!planOf(c.world, b.plan)?.chest && !planOf(c.world, b.plan)?.store;
	const read = async (space: SpaceLike, region: string | null, txn: string | null) => (await space.readAll({ type: "Building", fields: { accountId: c.account!.accountId } }, txn ? { txn } : {})).map((e) => fieldsOf<BuildingFields>(e)).filter(chestPlan).map((b) => ({ b, region, space }));
	const all = [...await read(c.space, null, c.txn)];
	for (const [region, space] of c.elsewhere ?? []) all.push(...await read(space, region, null).catch(() => []));
	const roomName = (r: string) => (c.world.allRooms ?? c.world.rooms).find((x) => x.roomId === r)?.name ?? r;
	return all.sort((x, y) => chestOrder({ ...x.b, roomName: roomName(x.b.room) }, { ...y.b, roomName: roomName(y.b.room) }));
}
const chestLabel = (c: CommandCtx, b: BuildingFields) => `${b.name} (${(c.world.allRooms ?? c.world.rooms).find((x) => x.roomId === b.room)?.name ?? b.room})`;
/** The chest `target` names ("2", "hütte", "die hütte in den dünen", "kupferhafen"); none named: the one beside, else
 *  the only one. */
async function chestNamed(c: CommandCtx, target: string): Promise<OwnChest> {
	const mine = await ownChests(c);
	if (!mine.length) throw new CommandError("Du hast keine Truhe: eine Hütte hat eine („bau hütte“).");
	const t = target.trim().toLowerCase().replace(ARTICLE, "").replace(/^(?:meine[nm]?|my)\s+/, "");
	const generic = !t || /^(?:truhe|kiste|chest)$/.test(t);
	if (generic) {
		const beside = mine.find((x) => x.region === null && x.b.room === c.actor.room && distTo(c.actor, x.b) <= 1);
		if (beside) return beside;
		if (mine.length === 1) return mine[0]!;
		throw new CommandError(`In welche Truhe? ${mine.map((x, i) => `${i + 1} ${chestLabel(c, x.b)}`).join(", ")}. Sag zum Beispiel „verstaue 3 muscheln in 2“.`);
	}
	const nr = /^(?:(?:truhe|kiste|chest|nr\.?)\s*)?(\d+)$/.exec(t);
	if (nr) { const x = mine[Number(nr[1]) - 1]; if (!x) throw new CommandError(`Eine Truhe ${nr[1]} hast du nicht (1 bis ${mine.length}).`); return x; }
	// the words name the building, its place or both
	const words = t.split(/\s+/).filter((w) => w.length > 2 && !/^(?:in|im|am|an|auf|bei|der|die|das|den|dem|des|von|truhe|kiste)$/.test(w));
	const names = (x: OwnChest) => [x.b.name, ...(planOf(c.world, x.b.plan)?.aliases ?? []), (c.world.allRooms ?? c.world.rooms).find((r) => r.roomId === x.b.room)?.name ?? x.b.room].join(" ").toLowerCase();
	const fits = mine.filter((x) => words.length && words.every((w) => names(x).includes(w)));
	if (fits.length === 1) return fits[0]!;
	if (fits.length > 1) {
		const beside = fits.find((x) => x.region === null && x.b.room === c.actor.room && distTo(c.actor, x.b) <= 1);
		if (beside) return beside;
		throw new CommandError(`Das passt auf mehrere Truhen: ${fits.map((x) => `${mine.indexOf(x) + 1} ${chestLabel(c, x.b)}`).join(", ")}. Sag die Nummer, etwa „verstaue 3 muscheln in ${mine.indexOf(fits[0]!) + 1}“.`);
	}
	throw new CommandError(`Eine Truhe „${target.trim().slice(0, 30)}“ hast du nicht. Deine Truhen: ${mine.map((x, i) => `${i + 1} ${chestLabel(c, x.b)}`).join(", ")}.`);
}
/** What some things weigh in a chest (a world without loads counts them). */
const heldIn = (c: CommandCtx, items: Array<Pick<ItemFields, "proto">>) => c.world.pack ? loadOfAll(c.world, items) : items.length;
const weight = (c: CommandCtx, proto: string) => c.world.pack ? loadOf(c.world, proto) : 1;
/** How much a chest holds: without limit where the world has loads (only the pack has one, pack.ts), else its plan's
 *  `chest` things. */
const capOf = (c: CommandCtx, b: BuildingFields) => c.world.pack ? Infinity : planOf(c.world, b.plan)?.chest ?? 0;
/** "(Last 12)" or "(12/20)" for a chest's or store's heading; "" for an empty one without limit. */
const heldText = (c: CommandCtx, items: Array<Pick<ItemFields, "proto">>, cap: number) => cap === Infinity ? `Last ${fmtLoad(heldIn(c, items))}` : `${heldIn(c, items)}/${cap}`;
/** "3 muscheln in die hütte am anleger": what, and the chest's words (none: the one beside or the only one). */
const storeArg = (arg: string): { what: string; target: string } => {
	const m = /^(.+?)\s+(?:in|ins|nach|into|to)\s+(.+)$/i.exec(arg.trim());
	return m ? { what: m[1]!, target: m[2]! } : { what: arg, target: "" };
};

/** At most this many things move in one command (coins paid with them included): each move takes the thing and writes
 *  it anew, which costs a world's thing about 700 bytes of the commit, and a commit carries at most maxCommitBytes
 *  (192 KiB; 500 driftwood in one went round and round, 2026-11-08). More follows as the same command again. */
export const MOVES_PER_COMMAND = 100;
/** The rest of a command that moved MOVES_PER_COMMAND things: the character's next intent, written with this one. */
const goOn = (c: CommandCtx, line: string) => c.space.write({ type: "Intent", fields: { intentId: randomBytes(8).toString("hex"), charId: c.actor.charId, line, at: timeNow(), ...(c.lang ? { lang: c.lang } : {}) } satisfies IntentFields as never }, c.txn, 30_000);
const restOf = (n: number | null, left: number) => (n === null ? "alle" : String(left));
const goingOn = " Den Rest legst du gleich nach.";

const verstaue: Command = {
	key: "verstaue", aliases: ["einlagern", "store"],
	help: "verstaue [n|alle] <ding> [in <truhe>] – etwas in eine deiner Truhen legen, von überall (neben dir: diese; „in 2“ oder „in die hütte am anleger“: eine andere; neben einem Lagerhaus: ins Lager)",
	async func(c, arg) {
		const { what, target } = storeArg(arg);
		const { n, name } = amount(what);
		const hits = itemsNamed(c.world, await inventory(c), name);
		if (!hits.length) throw new NotUnderstood(`Du trägst nichts, was „${name.slice(0, 30)}“ heißt.`);
		// beside a warehouse and no chest named: into the store, as before
		const near = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e)).filter((b) => distTo(c.actor, b) <= 1);
		const ownBeside = near.some((b) => b.accountId === c.account?.accountId && planOf(c.world, b.plan)?.chest && !planOf(c.world, b.plan)?.store);
		const storeBeside = near.find((b) => planOf(c.world, b.plan)?.store);
		const proto = hits[0]!.f.proto, all = (await inventory(c)).filter((i) => i.f.proto === proto), each = weight(c, proto);
		if (storeBeside && !ownBeside && (!target || /^(?:das\s+)?(?:lager|lagerhaus|warehouse)$/i.test(target.trim()))) {
			const b = await buildingHere(c, storeBeside.plan, { own: false });
			await storeRight(c, b);
			const cap = capOf(c, b);
			const room = cap === Infinity ? Infinity : cap - heldIn(c, (await chestOf(c, b.buildId)).map((e) => fieldsOf<ItemFields>(e)));
			const fit = Math.min(n ?? all.length, all.length, each ? Math.floor(room / each + 1e-9) : all.length), k = Math.min(fit, MOVES_PER_COMMAND);
			if (k <= 0) throw new CommandError(`Das Lager ist voll (${cap}).`);
			let moved = 0;
			for (const it of all.slice(0, k)) if (await moveItem(c.space, c.txn, it.f.itemId, c.actor.charId, b.buildId)) moved++;
			await putBack(c, b);
			await logStore(c, b, "ein", hits[0]!.f.name, moved);
			const later = k < fit && moved === k;
			if (later) await goOn(c, `verstaue ${restOf(n, fit - k)} ${name}${target ? ` in ${target}` : ""}`);
			return msg(c, c.actor.charId, "info", `Du legst ${moved} ${hits[0]!.f.name} in das Lager.${later ? goingOn : fit < Math.min(n ?? all.length, all.length) ? " Mehr passt nicht hinein." : ""}`);
		}
		const chest = await chestNamed(c, target);
		const cap = capOf(c, chest.b);
		let room = Infinity;
		if (cap !== Infinity) {
			const keepers = new Set((c.world.wild?.keepers ?? []).map((k) => k.proto));
			const inside = (await chest.space.readAll({ type: "Item", fields: { location: chest.b.buildId } }, chest.region === null ? { txn: c.txn } : {})).map((e) => fieldsOf<ItemFields>(e)).filter((i) => !keepers.has(i.proto));
			// what is on its way there by courier counts as in it
			const coming = chest.region === null ? 0 : (await c.space.readAll({ type: "Courier", fields: { buildId: chest.b.buildId } }, { txn: c.txn })).reduce((m, e) => m + Number(e.fields.count), 0);
			room = cap - heldIn(c, inside) - coming;
		}
		const fit = Math.min(n ?? all.length, all.length, each ? Math.floor(room / each + 1e-9) : all.length), k = Math.min(fit, MOVES_PER_COMMAND);
		const where = `die Truhe deiner ${chestLabel(c, chest.b)}`;
		if (k <= 0) throw new CommandError(`Die Truhe deiner ${chestLabel(c, chest.b)} ist voll (${cap}).`);
		const beside = chest.region === null && chest.b.room === c.actor.room && distTo(c.actor, chest.b) <= 1;
		let moved = 0;
		if (chest.region === null) {
			for (const it of all.slice(0, k)) if (await moveItem(c.space, c.txn, it.f.itemId, c.actor.charId, chest.b.buildId)) moved++;
		} else {
			// another region: a courier carries them (courier.ts); until then they lie with it, out of anyone's reach
			const courierId = `cou-${randomBytes(6).toString("hex")}`;
			for (const it of all.slice(0, k)) if (await moveItem(c.space, c.txn, it.f.itemId, c.actor.charId, courierId)) moved++;
			const f: CourierFields = { courierId, to: chest.region, buildId: chest.b.buildId, accountId: chest.b.accountId, ownerName: chest.b.ownerName, room: chest.b.room, name: chest.b.name, proto, count: moved, at: timeNow() };
			await c.space.write({ type: "Courier", fields: f as never }, c.txn, FOREVER);
		}
		const later = k < fit && moved === k;
		if (later) await goOn(c, `verstaue ${restOf(n, fit - k)} ${name}${target ? ` in ${target}` : ""}`);
		const more = later ? goingOn : fit < Math.min(n ?? all.length, all.length) ? " Mehr passt nicht hinein." : "";
		await msg(c, c.actor.charId, "info", beside ? `Du legst ${moved} ${hits[0]!.f.name} in die Truhe.${more}` : chest.region === null ? `Du legst ${moved} ${hits[0]!.f.name} in ${where}.${more}` : `Ein Bote bringt ${moved} ${hits[0]!.f.name} in ${where}.${more}`);
	},
};
const entnimm: Command = {
	key: "entnimm", aliases: ["hole", "retrieve"],
	help: "entnimm [n|alle] <ding> – etwas aus der Truhe deines Baus neben dir nehmen",
	async func(c, arg) {
		const { n, name } = amount(arg);
		const b = await chestHere(c);
		const shared = !!planOf(c.world, b.plan)?.store, left = shared ? (await storeRight(c, b)).left : Infinity;
		if (left <= 0) throw new CommandError("Für heute hast du aus dem Lager genommen, was dir zusteht.");
		const inside = (await chestOf(c, b.buildId)).map((e) => ({ e, f: fieldsOf<ItemFields>(e) }));
		const hits = itemsNamed(c.world, inside, name);
		if (!hits.length) throw new NotUnderstood(`In der Truhe ist nichts, was „${name.slice(0, 30)}“ heißt.`);
		const proto = hits[0]!.f.proto, all = inside.filter((i) => i.f.proto === proto);
		let moved = 0;
		const want = Math.min(n ?? all.length, all.length);
		// a town hall's tax: coins for each thing, into the store; the coins themselves go free
		const tax = shared && proto !== c.world.currency ? (await settlementIn(c.space, c.actor.room, c.txn))?.tax ?? 0 : 0;
		const coins = tax ? (await inventory(c)).filter((i) => i.f.proto === c.world.currency) : [];
		const payable = tax ? Math.floor(coins.length / tax) : Infinity;
		if (!payable) throw new CommandError(`Das Lager nimmt ${tax} Münzen Steuer je Stück; so viele hast du nicht.`);
		// as much as the pack still takes (pack.ts)
		const each = c.world.pack ? loadOf(c.world, proto) : 0, free = each ? (await packMax(c.space, c.world)) - (await loadAt(c.space, c.world, c.actor.charId, c.txn)) : Infinity;
		const fits = each ? Math.max(0, Math.floor(free / each + 1e-9)) : Infinity;
		if (!fits) throw new CommandError(`Das trägst du nicht mehr: dein Gepäck ist voll (${fmtLoad(await loadAt(c.space, c.world, c.actor.charId, c.txn))} von ${fmtLoad(await packMax(c.space, c.world))} Last).`);
		const take = Math.min(want, left, payable, fits), k = Math.min(take, Math.max(1, Math.floor(MOVES_PER_COMMAND / (1 + tax))));
		for (const it of all.slice(0, k)) if (await moveItem(c.space, c.txn, it.f.itemId, b.buildId, c.actor.charId)) moved++;
		for (const coin of coins.slice(0, moved * tax)) if (!(await moveItem(c.space, c.txn, coin.f.itemId, c.actor.charId, b.buildId))) throw new CommandError("Die Münzen sind gerade nicht greifbar; bitte noch einmal.");
		await putBack(c, b);
		if (shared) await logStore(c, b, "aus", hits[0]!.f.name, moved);
		const later = k < take && moved === k;
		if (later) await goOn(c, `entnimm ${restOf(n, take - k)} ${name}`);
		await msg(c, c.actor.charId, "info", `Du nimmst ${moved} ${hits[0]!.f.name} aus ${shared ? "dem Lager" : "der Truhe"}.${tax ? ` ${moved * tax} Münzen Steuer bleiben im Lager.` : ""}${later ? " Den Rest nimmst du gleich nach." : want > take ? (fits < Math.min(left, payable) ? " Mehr trägst du nicht." : payable < left ? " Für mehr reichen deine Münzen nicht." : " Mehr steht dir heute nicht zu.") : ""}`);
	},
};

const repariere: Command = {
	key: "repariere", aliases: ["repair", "ausbessern"],
	help: "repariere – einen Bau neben dir ausbessern (kostet etwas Material; jeder darf helfen)",
	async func(c, arg) {
		const b = await buildingHere(c, arg, { own: false });
		const plan = planOf(c.world, b.plan);
		const now = await worldNowOf(c.space, c.txn);
		const cost = plan?.repair ?? [];
		const inv = await inventory(c);
		for (const r of cost) if (inv.filter((i) => i.f.proto === r.proto).length < r.count) throw new CommandError(`Zum Ausbessern brauchst du ${r.count} ${c.world.prototypes.find((p) => p.key === r.proto)?.name ?? r.proto}.`);
		for (const r of cost) for (const it of inv.filter((i) => i.f.proto === r.proto).slice(0, r.count)) await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn });
		const until = (await decayNowOf(c.space, c.txn)) + (await keepOf(c, plan));
		await putBack(c, { ...b, untilWorldMs: until });
		await msg(c, "*", "emote", `${c.actor.name} bessert die ${b.name} von ${b.ownerName} aus; sie hält wieder ${days(until - now)}.`);
	},
};

/** Gives back `count` of each prototype into the actor's pack. */
export async function giveBack(c: CommandCtx, what: Array<{ proto: string; count: number }>): Promise<string[]> {
	const out: string[] = [];
	for (const w of what) {
		if (w.count <= 0) continue;
		const p = await resolvePrototype(c.space, w.proto);
		if (!p) continue;
		for (let i = 0; i < w.count; i++) await spawn(c.space, c.txn, c.world, p, { location: c.actor.charId, x: -1, y: -1 });
		out.push(`${w.count} ${p.name}`);
	}
	return out;
}
/** Gives a fire back the light a site or building took. */
export async function releaseLight(space: SpaceLike, txn: string, beaconId: string, points: number): Promise<void> {
	const light = await space.takeIfExists({ type: "LightUse", fields: { beaconId } }, 5_000, { txn });
	if (light) await space.write({ type: "LightUse", fields: { beaconId, used: Math.max(0, fieldsOf<LightUseFields>(light).used - points) } as never }, txn, FOREVER);
}

const abriss: Command = {
	key: "abriss", aliases: ["reisse", "reiße", "demolish"],
	help: "abriss – deinen Bau oder deine Baustelle neben dir abreißen (reisse … ab): die Fläche wird frei, ein Teil des Materials kommt zurück; eine Ruine neben dir räumt jeder ab",
	async func(c, arg) {
		const name = arg.replace(/\s+ab$/i, "").replace(/^(?:die|den|das|meine?n?)\s+/i, "").replace(/^baustelle$/i, "");
		const site = (await c.space.readAll({ type: "Site", fields: { room: c.actor.room } })).map((e) => fieldsOf<SiteFields>(e)).find((s) => distTo(c.actor, s) <= 1 && s.accountId === c.account?.accountId);
		if (site && (!name || /baustelle/i.test(arg) || planOf(c.world, name)?.key === site.plan)) {
			if (!(await c.space.takeIfExists({ type: "Site", fields: { buildId: site.buildId } }, 5_000, { txn: c.txn }))) throw new CommandError("Die Baustelle ist gerade nicht greifbar; bitte noch einmal.");
			const back = await giveBack(c, site.needs.map((n) => ({ proto: n.proto, count: n.have })));
			await closeOrders(c.space, c.txn, site, await keptUntil(c));
			await freeCells(c.space, c.txn, site.room, site.buildId);
			await releaseLight(c.space, c.txn, site.beaconId, site.points ?? 1);
			await msg(c, "*", "info", `${c.actor.name} gibt die Baustelle ${site.name} auf.${back.length ? ` Zurück an ${c.actor.name}: ${back.join(", ")}.` : ""}`);
			return;
		}
		// a ruin beside one: anyone may clear it (its light went back already); what lay in its chest stays the owner's estate
		const ruinName = name.replace(/^ruine?\s*(?:(?:der|des|einer|eines|von|of the|of)\s+)?/i, "");
		const ownNear = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).some((e) => { const b = fieldsOf<BuildingFields>(e); return b.accountId === c.account?.accountId && distTo(c.actor, b) <= 1; });
		const ruins = (await c.space.readAll({ type: "Ruin", fields: { room: c.actor.room } })).map((e) => fieldsOf<RuinFields>(e)).filter((r) => distTo(c.actor, r) <= 1 && (!ruinName || planOf(c.world, ruinName)?.key === r.plan || r.name.toLowerCase() === ruinName.toLowerCase()));
		const ruin = /^ruine?\b/i.test(name) || !ownNear ? (ruins.find((r) => r.accountId === c.account?.accountId) ?? ruins[0]) : undefined;
		if (ruin) {
			if (!c.account || c.account.guest) throw new CommandError("Ruinen räumen nur registrierte Spieler.");
			if (!(await c.space.takeIfExists({ type: "Ruin", fields: { buildId: ruin.buildId } }, 5_000, { txn: c.txn }))) throw new CommandError("Die Ruine ist gerade nicht greifbar; bitte noch einmal.");
			await freeCells(c.space, c.txn, ruin.room, ruin.buildId);
			const estate = await c.space.readIfExists({ type: "Estate", fields: { estateId: `est-${ruin.buildId}` } }, NO_WAIT, { txn: c.txn });
			await msg(c, "*", "info", `${c.actor.name} räumt die Ruine ab (${ruin.name} von ${ruin.ownerName}); die Fläche ist frei.${estate ? ` Der Nachlass wartet hier weiter auf ${ruin.ownerName} („nachlass“).` : ""}`);
			return;
		}
		const b = await buildingHere(c, name, { own: true });
		const plan = planOf(c.world, b.plan);
		// what a settlement laid in is not the owner's to carry off
		if (plan?.store && (await settlementIn(c.space, c.actor.room, c.txn)) && (await chestOf(c, b.buildId)).length) throw new CommandError("Im Lager liegt noch, was der Siedlung gehört. Erst wenn es leer ist, kann es weg.");
		// half of the material comes back; what lay in the chest goes into the pack
		const back = await giveBack(c, (plan?.needs ?? []).map((n) => ({ proto: n.proto, count: Math.floor(n.count / 2) })));
		let kept = 0;
		for (const it of await c.space.readAll({ type: "Item", fields: { location: b.buildId } })) if (await moveItem(c.space, c.txn, String(it.fields.itemId), b.buildId, c.actor.charId)) kept++;
		await freeCells(c.space, c.txn, b.room, b.buildId);
		await releaseLight(c.space, c.txn, b.beaconId, b.points ?? 1);
		const stopped = await stopLoads(c.space, c.txn, b.buildId, await worldNowOf(c.space, c.txn));
		await msg(c, "*", "info", `${c.actor.name} reißt die ${b.name} ab; die Fläche ist frei.${back.length ? ` Zurück: ${back.join(", ")}.` : ""}${kept ? ` Aus der Truhe: ${kept} Dinge.` : ""}${stopped ? " Das Korn, das noch nicht gemahlen war, holen die, die es brachten, hier ab („abholen“)." : ""}`);
	},
};

const nachlass: Command = {
	key: "nachlass", aliases: ["estate"],
	help: "nachlass – was in der Truhe eines verfallenen Baus von dir lag, hier abholen",
	async func(c) {
		const mine = (await c.space.readAll({ type: "Estate", fields: { room: c.actor.room } })).filter((e) => e.fields.accountId === c.account?.accountId);
		if (!mine.length) throw new CommandError("Hier liegt kein Nachlass von dir.");
		let got = 0, left = 0;
		// as much as the pack still takes (pack.ts): the rest waits in the estate
		let free = c.world.pack ? (await packMax(c.space, c.world)) - (await loadAt(c.space, c.world, c.actor.charId, c.txn)) : Infinity;
		for (const e of mine) {
			const est = await c.space.takeIfExists({ id: e.id }, NO_WAIT, { txn: c.txn });
			if (!est) continue;
			let rest = 0;
			for (const it of await c.space.readAll({ type: "Item", fields: { location: String(est.fields.estateId) } })) {
				const each = c.world.pack ? loadOf(c.world, String(it.fields.proto)) : 0;
				if (each > free + 1e-9) { rest++; continue; }
				if (await moveItem(c.space, c.txn, String(it.fields.itemId), String(est.fields.estateId), c.actor.charId)) { got++; free -= each; }
			}
			if (rest) { left += rest; await c.space.write({ type: "Estate", fields: est.fields as never }, c.txn, FOREVER); }
		}
		await msg(c, c.actor.charId, "info", got ? `Du holst deinen Nachlass ab: ${got} Dinge.${left ? ` ${left} Dinge bleiben hier, mehr trägst du nicht.` : ""}` : left ? `Das trägst du nicht mehr: ${left} Dinge warten hier weiter im Nachlass.` : "Der Nachlass war leer.");
	},
};

export const BUILD_COMMANDS: Command[] = [bau, liefere, arbeite, baustelle, truhe, lager, verstaue, entnimm, repariere, abriss, nachlass];

/** The sweep's part (engine/sweep.ts), each in a transaction of its own: sites whose world time is up lapse with their
 *  cells and give their light back; a building nobody kept becomes a ruin (its light goes back, what lay in its chest
 *  waits as an estate for its owner); a ruin whose time is up goes with its cells; an estate nobody fetched goes with its
 *  things; rests that are over go. */
export async function buildSweep(space: SpaceLike, w?: WorldDef): Promise<void> {
	const now = await decayNowOf(space), life = await worldNowOf(space);
	const inTxn = async (run: (txn: string) => Promise<boolean>) => {
		const txn = (await space.createTransaction(10_000)).id;
		try { if (await run(txn)) await space.commit(txn); else await space.abort(txn); }
		catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	};
	for (const e of await space.readAll({ type: "Site" })) {
		const s = fieldsOf<SiteFields>(e);
		if (s.untilWorldMs > now) continue;
		await inTxn(async (txn) => {
			if (!(await space.takeIfExists({ type: "Site", fields: { buildId: s.buildId } }, NO_WAIT, { txn }))) return false;
			await closeOrders(space, txn, s, now + (w?.building?.estateWorldMs ?? 30 * 24 * 3600_000));
			await freeCells(space, txn, s.room, s.buildId);
			await releaseLight(space, txn, s.beaconId, s.points ?? 1);
			return true;
		});
	}
	for (const e of await space.readAll({ type: "Building" })) {
		const b = fieldsOf<BuildingFields>(e);
		if (b.untilWorldMs > now) continue;
		await inTxn(async (txn) => {
			if (!(await space.takeIfExists({ type: "Building", fields: { buildId: b.buildId } }, NO_WAIT, { txn }))) return false;
			const ruin: RuinFields = { buildId: b.buildId, plan: b.plan, name: b.name, room: b.room, x: b.x, y: b.y, w: b.w, h: b.h, owner: b.owner, ownerName: b.ownerName, accountId: b.accountId, untilWorldMs: now + (w?.building?.ruinWorldMs ?? 10 * 24 * 3600_000) };
			await space.write({ type: "Ruin", fields: ruin as never }, txn, FOREVER);
			await releaseLight(space, txn, b.beaconId, b.points ?? 1);
			await stopLoads(space, txn, b.buildId, life);
			const inside = await space.readAll({ type: "Item", fields: { location: b.buildId } });
			if (inside.length) {
				const est: EstateFields = { estateId: `est-${b.buildId}`, accountId: b.accountId, ownerName: b.ownerName, room: b.room, name: b.name, untilWorldMs: now + (w?.building?.estateWorldMs ?? 30 * 24 * 3600_000) };
				await space.write({ type: "Estate", fields: est as never }, txn, FOREVER);
				for (const it of inside) await moveItem(space, txn, String(it.fields.itemId), b.buildId, est.estateId);
			}
			return true;
		});
	}
	// freight the railway carried and nobody fetched, or whose station fell: the sender's estate on the spot
	for (const e of await space.readAll({ type: "Freight" })) {
		const f = fieldsOf<FreightFields>(e);
		if (f.untilWorldMs > life && (await space.readIfExists({ type: "Building", fields: { buildId: f.buildId } }, 1_000))) continue;
		await inTxn(async (txn) => {
			if (!(await space.takeIfExists({ type: "Freight", fields: { freightId: f.freightId } }, NO_WAIT, { txn }))) return false;
			const est: EstateFields = { estateId: `est-${f.freightId}`, accountId: f.accountId, ownerName: f.ownerName, room: f.room, name: "Fracht", untilWorldMs: now + (w?.building?.estateWorldMs ?? 30 * 24 * 3600_000) };
			await space.write({ type: "Estate", fields: est as never }, txn, FOREVER);
			for (const it of await space.readAll({ type: "Item", fields: { location: f.freightId } }, { txn })) await moveItem(space, txn, String(it.fields.itemId), f.freightId, est.estateId);
			return true;
		});
	}
	for (const e of await space.readAll({ type: "Ruin" })) {
		const r = fieldsOf<RuinFields>(e);
		if (r.untilWorldMs > now) continue;
		await inTxn(async (txn) => {
			if (!(await space.takeIfExists({ type: "Ruin", fields: { buildId: r.buildId } }, NO_WAIT, { txn }))) return false;
			await freeCells(space, txn, r.room, r.buildId);
			return true;
		});
	}
	for (const e of await space.readAll({ type: "Estate" })) {
		const est = fieldsOf<EstateFields>(e);
		if (est.untilWorldMs > now) continue;
		await inTxn(async (txn) => {
			if (!(await space.takeIfExists({ id: e.id }, NO_WAIT, { txn }))) return false;
			for (const it of await space.readAll({ type: "Item", fields: { location: est.estateId } })) await space.takeIfExists({ id: it.id }, NO_WAIT, { txn });
			return true;
		});
	}
	for (const type of ["WorkRest", "Blessing", "BeamRest"]) for (const e of await space.readAll({ type })) if (Number(e.fields.untilWorldMs) <= now) await space.takeIfExists({ id: e.id }, NO_WAIT);
	// flour (or grain back) nobody fetched
	for (const e of await space.readAll({ type: "MillLoad" })) if (Number(e.fields.untilWorldMs) <= now) await space.takeIfExists({ id: e.id }, NO_WAIT);
}
/** A building a town hall voted away, in the transaction of the count: the area and the light are free at once, and half of
 *  the material with what lay in the chest waits for the owner as an estate on the spot. */
export async function demolishByVote(space: SpaceLike, txn: string, w: WorldDef, b: BuildingFields, now: number): Promise<void> {
	await freeCells(space, txn, b.room, b.buildId);
	await releaseLight(space, txn, b.beaconId, b.points ?? 1);
	await stopLoads(space, txn, b.buildId, await worldNowOf(space));
	const est: EstateFields = { estateId: `est-${b.buildId}`, accountId: b.accountId, ownerName: b.ownerName, room: b.room, name: b.name, untilWorldMs: now + (w.building?.estateWorldMs ?? 30 * 24 * 3600_000) };
	await space.write({ type: "Estate", fields: est as never }, txn, FOREVER);
	for (const it of await space.readAll({ type: "Item", fields: { location: b.buildId } })) await moveItem(space, txn, String(it.fields.itemId), b.buildId, est.estateId);
	for (const n of planOf(w, b.plan)?.needs ?? []) {
		const proto = await resolvePrototype(space, n.proto);
		if (proto) for (let i = 0; i < Math.floor(n.count / 2); i++) await spawn(space, txn, w, proto, { location: est.estateId, x: -1, y: -1 });
	}
}

/** A mill that falls stops grinding: its loads not yet ground give their grain back, ready now, at the mill's place
 *  (engine/commands/mill.ts). How many it stopped. */
export async function stopLoads(space: SpaceLike, txn: string, buildId: string, now: number): Promise<number> {
	let n = 0;
	for (const e of await space.readAll({ type: "MillLoad", fields: { buildId } })) {
		const l = fieldsOf<MillLoadFields>(e);
		if (l.readyWorldMs <= now || !(await space.takeIfExists({ type: "MillLoad", fields: { loadId: l.loadId } }, 5_000, { txn }))) continue;
		await space.write({ type: "MillLoad", fields: { ...l, to: l.from, readyWorldMs: now } as never }, txn, FOREVER);
		n++;
	}
	return n;
}
/** Takes the cells of a site or building. */
export async function freeCells(space: SpaceLike, txn: string, room: string, of: string): Promise<void> {
	for (const p of await space.readAll({ type: "Plot", fields: { room, of } })) await space.takeIfExists({ id: p.id }, NO_WAIT, { txn });
}
