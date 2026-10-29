// Building (docs/siedeln.md, "Wie ein Bau entsteht", step 1): a player stakes out a site for a plan; everyone may
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
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type BuildingFields, type ItemFields, type LightUseFields, type RoomFields, type SiteFields, type WorkRestFields } from "../../model.ts";
import { peek } from "../../space.ts";
import { worldNowOf } from "../clock.ts";
import type { Command } from "../cmdsets.ts";
import { byName, CommandError, exitsHere, inventory, msg, NotUnderstood, roomOf, type CommandCtx } from "../context.ts";
import { flameOf, isLit } from "../fire.ts";
import { blockedIn, cellKey, isPassage, occupiedIn } from "../occupancy.ts";
import { walkable, type PlanDef, type WorldDef } from "../world.ts";

const ARTICLE = /^(?:eine?n?|einem|der|die|das|den|dem|a|an|the)\s+/i;
type Rect = { x: number; y: number; w: number; h: number };
const cells = (r: Rect) => { const out: Array<{ x: number; y: number }> = []; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y }); return out; };
/** Chebyshev distance from a cell to a rectangle (0: inside, 1: beside it). */
export const distTo = (p: { x: number; y: number }, r: Rect) => Math.max(Math.max(r.x - p.x, 0, p.x - (r.x + r.w - 1)), Math.max(r.y - p.y, 0, p.y - (r.y + r.h - 1)));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const human = (c: CommandCtx) => !!c.account && !c.account.npc && !c.actor.charId.startsWith("npc-");
/** The plan a name means ("hütte", "eine Hütte"). */
export const planOf = (w: WorldDef, name: string): PlanDef | undefined => {
	const n = name.trim().toLowerCase().replace(ARTICLE, "");
	return w.building?.plans.find((p) => p.key === n || p.name.toLowerCase() === n || p.aliases.includes(n));
};
const missing = (s: SiteFields) => [...s.needs.filter((n) => n.have < n.count).map((n) => `${n.count - n.have} ${n.name}`), ...(s.work < s.workNeed ? [`${s.workNeed - s.work} Arbeit`] : [])];

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
async function refusal(c: CommandCtx, room: RoomFields, rect: Rect): Promise<string | null> {
	const height = room.ground.length, width = room.ground[0]?.length ?? 0;
	if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > width || rect.y + rect.h > height) return "Dort ist der Raum zu Ende.";
	const exits = (await exitsHere(c, room.roomId)).map((x) => x.f);
	const blocked = await blockedIn(c.space, c.world, room.roomId);
	const people = await occupiedIn(c.space, room.roomId);
	const things = new Set((await c.space.readAll({ type: "Item", fields: { location: room.roomId } })).map((e) => cellKey(e.fields as never)));
	const fires = c.world.beacons.filter((b) => b.room === room.roomId);
	for (const p of cells(rect)) {
		const k = cellKey(p);
		if (!walkable(c.world, room.ground, p.x, p.y)) return "Dort ist kein fester Boden.";
		if (isPassage(exits, p)) return "Dort ist ein Weg hinaus; den baut niemand zu.";
		if (fires.some((b) => Math.max(Math.abs(b.x - p.x), Math.abs(b.y - p.y)) <= 1)) return "So nah am Feuer baut man nicht.";
		if (blocked.has(k)) return "Dort steht schon etwas oder wird gebaut.";
		if (people.has(k) || (p.x === c.actor.x && p.y === c.actor.y)) return "Dort steht jemand.";
		if (things.has(k)) return "Dort liegt etwas; räum es erst weg.";
	}
	// nothing may close a way: from the room's spawn every exit, every fire's side and the builder stay reachable
	const after = new Set([...blocked, ...cells(rect).map(cellKey)]);
	const start = room.spawn && !after.has(cellKey(room.spawn)) ? room.spawn : exits[0] ? { x: exits[0].x, y: exits[0].y } : { x: c.actor.x, y: c.actor.y };
	const reach = reachable(c.world, room.ground, start, after);
	const ok = (p: { x: number; y: number }) => reach.has(cellKey(p));
	if (!exits.every((x) => ok(x)) || (room.spawn && !ok(room.spawn)) || !ok(c.actor)) return "Damit wäre ein Weg zugebaut.";
	if (!fires.every((b) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ok({ x: b.x + dx!, y: b.y + dy! })))) return "Damit käme niemand mehr ans Feuer.";
	return null;
}

/** The rectangles beside the actor where `plan` could go, nearest sides first (below, right, left, above, corners). */
function besides(c: CommandCtx, plan: PlanDef): Rect[] {
	const { x, y } = c.actor, out: Rect[] = [];
	for (let ry = y - plan.h; ry <= y + 1; ry++) for (let rx = x - plan.w; rx <= x + 1; rx++) {
		const r = { x: rx, y: ry, w: plan.w, h: plan.h };
		if (distTo(c.actor, r) === 1) out.push(r);
	}
	const side = (r: Rect) => (r.y === y + 1 ? 0 : r.x === x + 1 ? 1 : r.x + r.w === x ? 2 : 3) * 10 + Math.abs(r.x + r.w / 2 - 0.5 - x) + Math.abs(r.y + r.h / 2 - 0.5 - y);
	return out.sort((a, b) => side(a) - side(b));
}

/** A burning fire that covers the room and has light left for `points` (its LightUse taken in the transaction); null with
 *  the reason. */
async function lightFor(c: CommandCtx, points: number): Promise<{ beaconId: string; use: LightUseFields; fresh: boolean } | string> {
	const now = await worldNowOf(c.space, c.txn);
	const max = c.world.building?.lightPoints ?? 0;
	const fires = c.world.beacons.filter((b) => b.covers.includes(c.actor.room)).sort((a, b) => Number(b.room === c.actor.room) - Number(a.room === c.actor.room));
	if (!fires.length) return "Hier hält kein Feuer den Nebel fern; gebaut wird nur im Licht.";
	let lit = false;
	for (const b of fires) {
		if (!isLit(await flameOf(c.space, b.beaconId), now)) continue;
		lit = true;
		const e = await c.space.takeIfExists({ type: "LightUse", fields: { beaconId: b.beaconId } }, NO_WAIT, { txn: c.txn });
		if (!e && (await c.space.count({ type: "LightUse", fields: { beaconId: b.beaconId } }))) throw new CommandError("Gerade baut jemand anderes im Licht dieses Feuers; bitte gleich noch einmal.");
		const use = e ? fieldsOf<LightUseFields>(e) : { beaconId: b.beaconId, used: 0 };
		if (use.used + points <= max) return { beaconId: b.beaconId, use, fresh: !e };
		if (e) await c.space.write({ type: "LightUse", fields: use as never }, c.txn, FOREVER); // unchanged, back
	}
	return lit ? "Das Licht des Feuers reicht für keinen weiteren Bau; ein Leuchtturm oder ein zweites Feuer würde helfen." : "Das Feuer, das hier Licht gibt, ist aus; gebaut wird nur im Licht.";
}
/** Writes the fire's light use back (`fresh`: its first: with the unique check, so two first sites cannot both write one). */
async function useLight(c: CommandCtx, beaconId: string, use: LightUseFields, delta: number, fresh: boolean): Promise<void> {
	try { await c.space.write({ type: "LightUse", fields: { beaconId, used: Math.max(0, use.used + delta) } as never }, c.txn, FOREVER, fresh ? { unique: ["beaconId"] } : {}); }
	catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Gerade baut jemand anderes im Licht dieses Feuers; bitte gleich noch einmal."); throw e; }
}

/** The site beside the actor (by plan name when given), taken in the transaction. */
async function siteHere(c: CommandCtx, name: string): Promise<{ s: SiteFields }> {
	const sites = (await c.space.readAll({ type: "Site", fields: { room: c.actor.room } })).map((e) => fieldsOf<SiteFields>(e));
	const near = sites.filter((s) => distTo(c.actor, s) <= 1 && (!name || planOf(c.world, name)?.key === s.plan || s.name.toLowerCase() === name.toLowerCase()));
	if (!near.length) throw new NotUnderstood(sites.length ? "Geh näher an die Baustelle heran (direkt daneben)." : "Hier ist keine Baustelle. „bau <plan>“ steckt eine ab.");
	const e = await c.space.take({ type: "Site", fields: { buildId: near[0]!.buildId } }, 5_000, { txn: c.txn });
	if (!e) throw new CommandError("Die Baustelle ist gerade nicht greifbar; bitte noch einmal.");
	return { s: fieldsOf<SiteFields>(e) };
}

/** Writes the site back, or, when nothing is missing, the building in its place. */
async function settle(c: CommandCtx, s: SiteFields): Promise<void> {
	const now = await worldNowOf(c.space, c.txn);
	if (s.needs.every((n) => n.have >= n.count) && s.work >= s.workNeed) {
		const plan = planOf(c.world, s.plan);
		const b: BuildingFields = { buildId: s.buildId, plan: s.plan, name: s.name, room: s.room, x: s.x, y: s.y, w: s.w, h: s.h, owner: s.owner, ownerName: s.ownerName, accountId: s.accountId, beaconId: s.beaconId, points: s.points, by: s.by, untilWorldMs: now + (plan?.keepWorldMs ?? 7 * 24 * 3600_000), builtAt: now };
		await c.space.write({ type: "Building", fields: b as never }, c.txn, FOREVER);
		const helpers = Object.entries(s.by).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} (${k})`).join(", ");
		await msg(c, "*", "world", `Die ${s.name} von ${s.ownerName} steht! Mitgebaut: ${helpers}.`);
		return;
	}
	await c.space.write({ type: "Site", fields: { ...s, untilWorldMs: now + (c.world.building?.siteWorldMs ?? 2 * 24 * 3600_000) } as never }, c.txn, FOREVER);
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
			const list = def.plans.map((p) => `${p.name} (${p.w}×${p.h}): ${p.needs.map((n) => `${n.count} ${c.world.prototypes.find((x) => x.key === n.proto)?.name ?? n.proto}`).join(", ")}, ${p.work} Arbeit`);
			return msg(c, c.actor.charId, "info", `Baupläne: ${list.join("; ")}. „bau <plan>“ steckt neben dir eine Baustelle ab; liefern und arbeiten können alle.`);
		}
		const m = /^(\S+)(?:\s+(\d+)\s+(\d+))?$/.exec(arg.trim().replace(ARTICLE, ""));
		const plan = m && planOf(c.world, m[1]!);
		if (!plan) throw new NotUnderstood(`Einen Bauplan „${arg.slice(0, 20)}“ gibt es nicht. „bau“ zeigt die Pläne.`);
		if (!c.account || c.account.guest) throw new CommandError("Gäste können liefern und mitarbeiten, aber nichts besitzen; registriere dich, um selbst zu bauen.");
		if (c.account.npc || c.actor.charId.startsWith("npc-")) throw new CommandError("Baustellen stecken nur Menschen ab.");
		if ((await c.space.count({ type: "Site", fields: { accountId: c.account.accountId } })) >= def.maxSites) throw new CommandError("Du hast schon eine offene Baustelle; bau sie erst fertig.");
		if ((await c.space.count({ type: "Site", fields: { accountId: c.account.accountId } })) + (await c.space.count({ type: "Building", fields: { accountId: c.account.accountId } })) >= def.maxBuildings) throw new CommandError(`Mehr als ${def.maxBuildings} Bauten hat niemand.`);
		const light = await lightFor(c, plan.points);
		if (typeof light === "string") throw new CommandError(light);
		const room = await roomOf(c);
		const tries = m[2] !== undefined ? [{ x: Number(m[2]), y: Number(m[3]), w: plan.w, h: plan.h }] : besides(c, plan);
		let rect: Rect | null = null, why = "";
		for (const r of tries) { const no = await refusal(c, room, r); if (!no) { rect = r; break; } why ||= no; }
		if (!rect) throw new CommandError(`Hier passt keine ${plan.name} hin: ${why}`);
		const buildId = randomBytes(6).toString("hex"), now = await worldNowOf(c.space, c.txn);
		for (const p of cells(rect)) {
			try { await c.space.write({ type: "Plot", fields: { room: room.roomId, x: p.x, y: p.y, of: buildId } as never }, c.txn, FOREVER, { unique: ["room", "x", "y"] }); }
			catch (e) { if (/unique entry already exists/.test((e as Error).message)) throw new CommandError("Dort hat gerade jemand anderes abgesteckt."); throw e; }
		}
		await useLight(c, light.beaconId, light.use, plan.points, light.fresh);
		const s: SiteFields = { buildId, plan: plan.key, name: plan.name, room: room.roomId, ...rect, owner: c.actor.charId, ownerName: c.actor.name, accountId: c.account.accountId,
			needs: plan.needs.map((n) => ({ proto: n.proto, name: c.world.prototypes.find((x) => x.key === n.proto)?.name ?? n.proto, count: n.count, have: 0 })), work: 0, workNeed: plan.work, human: 0, other: 0, beaconId: light.beaconId, points: plan.points, by: {},
			untilWorldMs: now + def.siteWorldMs, at: now };
		await c.space.write({ type: "Site", fields: s as never }, c.txn, FOREVER);
		await msg(c, "*", "info", `${c.actor.name} steckt eine Baustelle ab: ${plan.name}. Es fehlen ${missing(s).join(", ")} – liefern („liefere <ding>“) und mitarbeiten („arbeite“) können alle.`);
	},
};

const liefere: Command = {
	key: "liefere", aliases: ["deliver"],
	help: "liefere [n] <ding> – an die Baustelle neben dir liefern, was sie braucht (zu viel bleibt bei dir)",
	async func(c, arg) {
		const m = /^(?:(\d+)\s+)?(.+?)(?:\s+(?:an|zur|zu|to|für|fuer)\s+(?:die\s+|der\s+)?(.+))?$/i.exec(arg.trim());
		if (!m) throw new NotUnderstood("Was lieferst du? Zum Beispiel: liefere 3 treibholz");
		const hits = byName(await inventory(c), m[2]!.replace(ARTICLE, ""));
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
		await msg(c, c.actor.charId, "info", `Du lieferst ${plural(n, `Stück ${need.name}`, `Stück ${need.name}`)} an die ${s.name}.${mine.length > n && m[1] && Number(m[1]) > n ? " Den Rest braucht sie nicht; er bleibt bei dir." : ""}${missing(s).length ? ` Es fehlen noch ${missing(s).join(", ")}.` : ""}`);
		await settle(c, s);
	},
};

const arbeite: Command = {
	key: "arbeite", aliases: ["work"],
	help: "arbeite – an der Baustelle neben dir mitarbeiten (danach ruhst du eine Weile)",
	async func(c, arg) {
		const now = await worldNowOf(c.space, c.txn);
		const rest = await peek(c.space, { type: "WorkRest", fields: { charId: c.actor.charId } });
		const until = rest ? fieldsOf<WorkRestFields>(rest).untilWorldMs : 0;
		if (until > now) throw new CommandError(`Du bist noch müde von der letzten Arbeit; in etwa ${Math.max(1, Math.round((until - now) / 60_000))} Minuten wieder.`);
		const { s } = await siteHere(c, arg.replace(/^(?:an|auf)\s+(?:der\s+)?/i, "").replace(/^baustelle$/i, ""));
		if (s.work >= s.workNeed) throw new CommandError(`An der ${s.name} ist die Arbeit getan; es fehlen nur noch ${missing(s).join(", ")}.`);
		credit(c, s, 1);
		s.work += 1;
		if (rest) await c.space.takeIfExists({ id: rest.id }, NO_WAIT, { txn: c.txn });
		await c.space.write({ type: "WorkRest", fields: { charId: c.actor.charId, untilWorldMs: now + (c.world.building?.restWorldMs ?? 3600_000) } satisfies WorkRestFields as never }, c.txn, FOREVER);
		await msg(c, "*", "emote", `${c.actor.name} arbeitet an der ${s.name} (${s.work}/${s.workNeed}).`);
		await settle(c, s);
	},
};

const baustelle: Command = {
	key: "baustelle", aliases: ["baustellen", "site", "sites"],
	help: "baustelle – was hier gebaut wird und was noch fehlt",
	async func(c) {
		const sites = (await c.space.readAll({ type: "Site", fields: { room: c.actor.room } })).map((e) => fieldsOf<SiteFields>(e));
		const built = (await c.space.readAll({ type: "Building", fields: { room: c.actor.room } })).map((e) => fieldsOf<BuildingFields>(e));
		if (!sites.length && !built.length) return msg(c, c.actor.charId, "info", "Hier wird nichts gebaut. „bau“ zeigt die Baupläne.");
		const lines = [...sites.map((s) => `Baustelle ${s.name} von ${s.ownerName}: es fehlen ${missing(s).join(", ")}.`), ...built.map((b) => `${b.name} von ${b.ownerName}.`)];
		await msg(c, c.actor.charId, "look", lines.join("\n"));
	},
};

export const BUILD_COMMANDS: Command[] = [bau, liefere, arbeite, baustelle];

/** The sweep's part (engine/sweep.ts): sites whose world time is up lapse with their cells and give their light back;
 *  rests that are over go. Each in a transaction of its own. */
export async function buildSweep(space: SpaceLike): Promise<void> {
	const now = await worldNowOf(space);
	for (const e of await space.readAll({ type: "Site" })) {
		const s = fieldsOf<SiteFields>(e);
		if (s.untilWorldMs > now) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			if (!(await space.takeIfExists({ type: "Site", fields: { buildId: s.buildId } }, NO_WAIT, { txn }))) { await space.abort(txn); continue; }
			await freeCells(space, txn, s.room, s.buildId);
			const light = await space.takeIfExists({ type: "LightUse", fields: { beaconId: s.beaconId } }, 5_000, { txn });
			if (light) await space.write({ type: "LightUse", fields: { beaconId: s.beaconId, used: Math.max(0, fieldsOf<LightUseFields>(light).used - (s.points ?? 1)) } as never }, txn, FOREVER);
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	for (const e of await space.readAll({ type: "WorkRest" })) if (Number(e.fields.untilWorldMs) <= now) await space.takeIfExists({ id: e.id }, NO_WAIT);
}
/** Takes the cells of a site or building. */
export async function freeCells(space: SpaceLike, txn: string, room: string, of: string): Promise<void> {
	for (const p of await space.readAll({ type: "Plot", fields: { room, of } })) await space.takeIfExists({ id: p.id }, NO_WAIT, { txn });
}
export type { ItemFields };
