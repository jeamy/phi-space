// Roads, planned (docs/siedeln.en.md "Road"): a road runs from the middle of one room through a door to the middle of the
// next room on the same island, along the cobble paths where it can. Nobody lays a piece of road somewhere: `straße plane
// <ort>` draws the trace, the settlers of both rooms (whoever has a hut there, the settlers a settlement took in; no
// guests, no figures the game plays) vote on it with `straße ja` / `straße nein`, and when more say yes than no it becomes
// a site of its own that everyone builds with `liefere` and `arbeite` beside it; each work paves the next stretch. A
// finished road links its two rooms for carts (cart.ts roadLinks) until it decays; `straße repariere` mends it.
// The road's cells stay walkable: they are no plot, only nothing is built on them (build.ts refusal).
//
// One Route entry holds the whole road, a Road entry per room what the page draws (written together with it, roadSave).
// The terms run on the decay clock; roadTick resolves votes and lets roads lapse.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type AccountFields, type CharacterFields, type ExitFields, type RoadFields, type RoomFields, type RouteFields } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, inventory, itemsNamed, msg, msgOptions, NotUnderstood, roomOf, toPlayer, type CommandCtx } from "../context.ts";
import { decayNowOf } from "../clock.ts";
import { blockedIn, cellKey } from "../occupancy.ts";
import { walkable, type WorldDef } from "../world.ts";
import { randomBytes, timeNow } from "../source.ts";
import { setting } from "../../settings.ts";
import { epochName, epochOf, islandOf } from "./epoch.ts";
import { hutsIn, needRank, settlementIn } from "./settlement.ts";
import { ARTICLE, days, human, plural, rested, SITE_REACH, tire } from "./build.ts";

type Cell = { x: number; y: number };
type RouteDef = NonNullable<NonNullable<WorldDef["cart"]>["route"]>;
const WORLD_DAY = 24 * 3600_000;

const defOf = (w: WorldDef): RouteDef | null => w.cart?.route ?? null;
const nameOf = (w: WorldDef, room: string) => (w.allRooms ?? w.rooms).find((r) => r.roomId === room)?.name ?? room;
const islandOfRoom = (w: WorldDef, room: string) => (w.allRooms ?? w.rooms).find((r) => r.roomId === room)?.island ?? null;
const pairOf = (a: string, b: string) => [a, b].sort().join("|");
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** The middle of a room a road runs to: beside its fire, else the cobble cell nearest the room's centre, else the walkable
 *  cell nearest it. The cells that count as arrived. */
function middleOf(w: WorldDef, room: RoomFields, fire: Cell | undefined): Cell[] {
	const g = room.ground, h = g.length, wd = g[0]?.length ?? 0;
	if (fire) return STEPS.map(([dx, dy]) => ({ x: fire.x + dx, y: fire.y + dy })).filter((p) => walkable(w, g, p.x, p.y));
	const mid = { x: (wd - 1) / 2, y: (h - 1) / 2 };
	let best: Cell | null = null, bestD = Infinity, bestCobble = false;
	for (let y = 0; y < h; y++) for (let x = 0; x < wd; x++) {
		if (!walkable(w, g, x, y)) continue;
		const cobble = g[y]![x] === ":", d = Math.hypot(x - mid.x, y - mid.y);
		if ((cobble && !bestCobble) || (cobble === bestCobble && d < bestD)) { best = { x, y }; bestD = d; bestCobble = cobble; }
	}
	return best ? [best] : [];
}

/** The cheapest way over walkable, unblocked cells from `from` to one of `to` (cobbles cost less: the road follows the
 *  paths), both ends included; null when there is none. */
function trace(w: WorldDef, ground: string[], from: Cell, to: Cell[], blocked: ReadonlySet<string>): Cell[] | null {
	const h = ground.length, wd = ground[0]?.length ?? 0, goal = new Set(to.map(cellKey));
	const dist = new Map<string, number>([[cellKey(from), 0]]), before = new Map<string, string>(), open: Array<{ c: Cell; d: number }> = [{ c: from, d: 0 }];
	while (open.length) {
		open.sort((a, b) => a.d - b.d);
		const { c, d } = open.shift()!, k = cellKey(c);
		if (d > (dist.get(k) ?? Infinity)) continue;
		if (goal.has(k)) {
			const out: Cell[] = [c];
			for (let at = k; before.has(at); ) { at = before.get(at)!; const [x, y] = at.split(",").map(Number); out.unshift({ x: x!, y: y! }); }
			return out;
		}
		for (const [dx, dy] of STEPS) {
			const n = { x: c.x + dx, y: c.y + dy }, nk = cellKey(n);
			if (n.x < 0 || n.y < 0 || n.x >= wd || n.y >= h || !walkable(w, ground, n.x, n.y) || blocked.has(nk)) continue;
			const nd = d + (ground[n.y]![n.x] === ":" ? 1 : 3);
			if (nd < (dist.get(nk) ?? Infinity)) { dist.set(nk, nd); before.set(nk, k); open.push({ c: n, d: nd }); }
		}
	}
	return null;
}

/** The accounts that vote on a road between these rooms: hut owners there and the settlers a settlement took in, who are
 *  registered people (no guests, no figures the game plays). */
async function votersOf(space: SpaceLike, w: WorldDef, rooms: string[], txn: string | null): Promise<string[]> {
	const out = new Set<string>();
	for (const room of rooms) {
		for (const h of await hutsIn(space, w, room, txn)) out.add(h.accountId);
		for (const m of (await settlementIn(space, room, txn))?.members ?? []) if (m.rank === "siedler") out.add(m.accountId);
	}
	const people: string[] = [];
	for (const id of out) {
		const a = (await space.readAll({ type: "Account", fields: { accountId: id } }, txn ? { txn } : {}))[0];
		const f = a ? fieldsOf<AccountFields>(a) : null;
		if (f && !f.guest && !f.npc && !f.settler) people.push(id);
	}
	return people.sort();
}

const missingOf = (r: RouteFields) => [...r.needs.filter((n) => n.have < n.count).map((n) => `${n.count - n.have} ${n.name}`), ...(r.work < r.workNeed ? [`${r.workNeed - r.work} Arbeit`] : [])];
const votesOf = (r: RouteFields) => `${r.yes.length} ja, ${r.no.length} nein von ${r.voters.length}`;
/** How many of the road's cells are paved: by the work done, all once it stands. */
const pavedOf = (r: RouteFields) => (r.state === "built" ? r.cells.length : r.state === "vote" ? 0 : Math.floor((r.cells.length * Math.min(r.work, r.workNeed)) / Math.max(1, r.workNeed)));
const nameOfRoute = (r: RouteFields, from: string) => `Straße nach ${r.names[r.rooms[0] === from ? 1 : 0]}`;

/** Writes the road back with its two parts (the old ones taken in the transaction). */
async function roadSave(space: SpaceLike, txn: string, r: RouteFields): Promise<void> {
	await space.write({ type: "Route", fields: r as never }, txn, FOREVER);
	for (const e of await space.readAll({ type: "Road", fields: { routeId: r.routeId } }, { txn })) await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
	const paved = pavedOf(r), missing = missingOf(r).join(", "), votes = votesOf(r);
	let before = 0;
	for (const room of r.rooms) {
		const cells = r.cells.filter((c) => c.room === room).map((c) => ({ x: c.x, y: c.y }));
		const part: RoadFields = { roadId: `${r.routeId}:${room}`, routeId: r.routeId, room, to: r.rooms[0] === room ? r.rooms[1] : r.rooms[0], name: nameOfRoute(r, room), cells, paved: Math.max(0, Math.min(cells.length, paved - before)), state: r.state, missing, votes, ...(r.state === "vote" && r.votedBy?.length ? { votedBy: r.votedBy } : {}) };
		await space.write({ type: "Road", fields: part as never }, txn, FOREVER);
		before += cells.length;
	}
}
/** Takes the road and its parts away. */
async function roadGone(space: SpaceLike, txn: string, routeId: string): Promise<void> {
	await space.takeIfExists({ type: "Route", fields: { routeId } }, NO_WAIT, { txn });
	for (const e of await space.readAll({ type: "Road", fields: { routeId } }, { txn })) await space.takeIfExists({ id: e.id }, NO_WAIT, { txn });
}

const routesOf = async (space: SpaceLike, txn: string | null = null) => (await space.readAll({ type: "Route" }, txn ? { txn } : {})).map((e) => fieldsOf<RouteFields>(e));
/** The cells of roads in a room (nothing is built there; build.ts refusal). */
export async function roadCellsIn(space: SpaceLike, room: string, txn: string | null = null): Promise<Set<string>> {
	const out = new Set<string>();
	for (const e of await space.readAll({ type: "Road", fields: { room } }, txn ? { txn } : {})) for (const c of fieldsOf<RoadFields>(e).cells) out.add(cellKey(c));
	return out;
}
/** Room to rooms the finished roads join, both ways (the cart's search, the overview's). */
export async function routeLinks(space: SpaceLike, txn: string | null = null): Promise<Array<[string, string]>> {
	return (await routesOf(space, txn)).filter((r) => r.state === "built").map((r) => r.rooms);
}
/** The points the finished roads add to each island's held stock (epoch.ts islandPoints). */
export async function routePoints(space: SpaceLike): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	for (const r of await routesOf(space)) if (r.state === "built") out.set(r.island, (out.get(r.island) ?? 0) + r.points);
	return out;
}

/** Tells the voters who are not the actor that a road waits for their vote (a notice where they stand). */
async function askVoters(c: CommandCtx, r: RouteFields): Promise<void> {
	for (const accountId of r.voters) {
		if (accountId === c.account?.accountId) continue;
		for (const e of await c.space.readAll({ type: "Character", fields: { accountId } }, { txn: c.txn })) {
			const ch = fieldsOf<CharacterFields>(e);
			await toPlayer(c.space, { room: ch.room, to: ch.charId, kind: "info", text: `${r.plannerName} plant eine Straße zwischen ${r.names[0]} und ${r.names[1]}. Als Siedler dort stimmst du mit „straße ja“ oder „straße nein“ ab, in ${r.names[0]} oder ${r.names[1]}; noch ${days(r.voteUntil - (await decayNowOf(c.space, c.txn)))}.`, from: c.actor.name, at: timeNow() }, c.txn);
		}
	}
}

/** After a vote or at its end: more yes than no makes the road a site, else it is dropped. True when it was decided. */
async function decide(space: SpaceLike, w: WorldDef, txn: string, r: RouteFields, now: number, early: boolean, say: (room: string, text: string) => Promise<void>): Promise<boolean> {
	if (early && r.yes.length + r.no.length < r.voters.length) return false;
	if (r.yes.length > r.no.length) {
		r.state = "build"; r.untilWorldMs = now + (defOf(w)?.siteWorldMs ?? 14 * WORLD_DAY);
		await roadSave(space, txn, r);
		for (const room of r.rooms) await say(room, `Die Straße zwischen ${r.names[0]} und ${r.names[1]} ist beschlossen (${votesOf(r)}). Jetzt wird gebaut: liefern („liefere stein“) und mitarbeiten („arbeite“) neben der Trasse; es fehlen ${missingOf(r).join(", ")}.`);
	} else {
		await roadGone(space, txn, r.routeId);
		for (const room of r.rooms) await say(room, `Die Straße zwischen ${r.names[0]} und ${r.names[1]} wird nicht gebaut (${votesOf(r)}).`);
	}
	return true;
}

/** The road under construction with a cell within reach of the actor, taken in the transaction; null when there is none. */
export async function routeNear(c: CommandCtx): Promise<RouteFields | null> {
	const parts = (await c.space.readAll({ type: "Road", fields: { room: c.actor.room } }, { txn: c.txn })).map((e) => fieldsOf<RoadFields>(e));
	const near = parts.find((p) => p.state === "build" && p.cells.some((q) => Math.max(Math.abs(q.x - c.actor.x), Math.abs(q.y - c.actor.y)) <= SITE_REACH));
	if (!near) return null;
	const e = await c.space.takeIfExists({ type: "Route", fields: { routeId: near.routeId } }, NO_WAIT, { txn: c.txn });
	return e ? fieldsOf<RouteFields>(e) : null;
}

/** Whoever helps: NPCs and figures may give at most half (as at a site, build.ts credit). */
function credit(c: CommandCtx, r: RouteFields, n: number): number {
	const total = r.needs.reduce((a, x) => a + x.count, 0) + r.workNeed, others = Object.entries(r.by).filter(([k]) => k.startsWith("~")).reduce((a, [, v]) => a + v, 0);
	if (!human(c)) n = Math.max(0, Math.min(n, Math.floor(total / 2) - others));
	if (!n) throw new CommandError("Diese Straße bauen Menschen; Helfer haben ihren Teil schon getan.");
	const key = human(c) ? c.actor.name : `~${c.actor.name}`;
	r.by = { ...r.by, [key]: (r.by[key] ?? 0) + n };
	return n;
}

/** Writes the road back after a delivery or work; when nothing is missing it stands. */
async function settleRoute(c: CommandCtx, r: RouteFields): Promise<void> {
	if (r.needs.every((n) => n.have >= n.count) && r.work >= r.workNeed) {
		const def = defOf(c.world)!, keep = def.keepSetting ? ((await setting(c.space, def.keepSetting).catch(() => undefined)) ?? def.keepWorldMs / WORLD_DAY) * WORLD_DAY : def.keepWorldMs;
		r.state = "built"; r.untilWorldMs = (await decayNowOf(c.space, c.txn)) + keep;
		await roadSave(c.space, c.txn!, r);
		for (const room of r.rooms) await msg(c, "*", "world", `Die Straße zwischen ${r.names[0]} und ${r.names[1]} ist fertig. Karren fahren jetzt auf ihr.`, { room });
		return;
	}
	await roadSave(c.space, c.txn!, r);
}

/** `liefere` beside a road under construction (build.ts falls through to it when no site is near). */
export async function routeDeliver(c: CommandCtx, r: RouteFields, what: string, count: number | null): Promise<void> {
	const hits = itemsNamed(c.world, await inventory(c), what.replace(ARTICLE, ""));
	if (!hits.length) throw new NotUnderstood(`Du trägst nichts, was „${what.slice(0, 30)}“ heißt.`);
	const proto = hits[0]!.f.proto, need = r.needs.find((n) => n.proto === proto);
	if (!need) throw new CommandError(`Die Straße braucht kein ${hits[0]!.f.name}. Es fehlen ${missingOf(r).join(", ") || "nur noch Hände"}.`);
	const open = need.count - need.have;
	if (open <= 0) throw new CommandError(`${need.name} hat die Straße genug. Es fehlen ${missingOf(r).join(", ")}.`);
	const mine = (await inventory(c)).filter((i) => i.f.proto === proto);
	let n = Math.min(count ?? open, open, mine.length);
	if (n <= 0) throw new CommandError(`Du hast kein ${need.name}.`);
	n = credit(c, r, n);
	for (const it of mine.slice(0, n)) if (!(await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn }))) throw new CommandError(`${it.f.name} ist gerade nicht greifbar; bitte noch einmal.`);
	need.have += n;
	await msg(c, c.actor.charId, "info", `Du lieferst ${plural(n, `Stück ${need.name}`, `Stück ${need.name}`)} an die Straße zwischen ${r.names[0]} und ${r.names[1]}.${missingOf(r).length ? ` Es fehlen noch ${missingOf(r).join(", ")}.` : ""}`);
	await settleRoute(c, r);
}

/** `arbeite` beside a road under construction: one work, which paves the next stretch. */
export async function routeWork(c: CommandCtx, r: RouteFields): Promise<void> {
	const { now, rest } = await rested(c);
	if (r.work >= r.workNeed) throw new CommandError(`An der Straße ist die Arbeit getan; es fehlen nur noch ${missingOf(r).join(", ")}.`);
	credit(c, r, 1);
	r.work += 1;
	await tire(c, now, rest);
	await msg(c, "*", "emote", `${c.actor.name} pflastert an der Straße zwischen ${r.names[0]} und ${r.names[1]} (${r.work}/${r.workNeed}).`);
	await settleRoute(c, r);
}

/** The rooms one door away on the same island. */
async function neighbours(c: CommandCtx): Promise<Array<{ exit: ExitFields; room: string; name: string }>> {
	const island = islandOfRoom(c.world, c.actor.room), seen = new Set<string>(), out: Array<{ exit: ExitFields; room: string; name: string }> = [];
	for (const e of await c.space.readAll({ type: "Exit", fields: { location: c.actor.room } }, { txn: c.txn })) {
		const x = fieldsOf<ExitFields>(e);
		if (seen.has(x.destination) || islandOfRoom(c.world, x.destination) !== island || x.destination === c.actor.room) continue;
		seen.add(x.destination); out.push({ exit: x, room: x.destination, name: nameOf(c.world, x.destination) });
	}
	return out;
}

async function plan(c: CommandCtx, word: string): Promise<void> {
	const def = defOf(c.world)!;
	if (!c.account || c.account.guest) throw new CommandError("Straßen planen registrierte Spieler; registriere dich.");
	const island = islandOfRoom(c.world, c.actor.room);
	if (!island) throw new CommandError("Hier wird keine Straße gebaut.");
	const epoch = await epochOf(c.space, islandOf(c.world, c.actor.room), c.txn);
	if (epoch < def.epoch) throw new CommandError(`Straßen gibt es erst ab ${epochName(c.world, def.epoch)}; diese Insel ist noch ${epochName(c.world, epoch)}.`);
	await needRank(c, "siedler", "Straßen planen");
	const near = await neighbours(c), w = word.trim().toLowerCase().replace(ARTICLE, "").replace(/^(?:nach|zu|zum|zur|to)\s+/, "");
	if (!w) throw new NotUnderstood(near.length ? `Wohin? Von hier geht es nach ${near.map((n) => n.name).join(", ")}: „straße plane <ort>“.` : "Von hier führt kein Weg zu einem anderen Ort dieser Insel.");
	const to = near.find((n) => n.name.toLowerCase() === w || n.room === w || n.name.toLowerCase().startsWith(w));
	if (!to) throw new NotUnderstood(`Dorthin führt von hier kein Weg auf dieser Insel.${near.length ? ` Von hier geht es nach ${near.map((n) => n.name).join(", ")}.` : ""}`);
	const pair = pairOf(c.actor.room, to.room), old = (await routesOf(c.space, c.txn)).find((r) => r.pair === pair);
	if (old) throw new CommandError(old.state === "vote" ? `Über eine Straße nach ${to.name} wird schon abgestimmt (${votesOf(old)}).` : old.state === "build" ? `Eine Straße nach ${to.name} wird schon gebaut; es fehlen ${missingOf(old).join(", ")}.` : `Nach ${to.name} führt schon eine Straße.`);
	// the trace: from the middle of this room to its door, from where one arrives there to the middle of that room
	const here = await roomOf(c), there = await roomOf(c, to.room);
	const fire = (room: string) => c.world.beacons.find((b) => b.room === room);
	const blockedA = await blockedIn(c.space, c.world, here.roomId), blockedB = await blockedIn(c.space, c.world, there.roomId);
	const startA = middleOf(c.world, here, fire(here.roomId)).find((p) => !blockedA.has(cellKey(p)));
	const legA = startA ? trace(c.world, here.ground, startA, [{ x: to.exit.x, y: to.exit.y }], blockedA) : null;
	const legB = trace(c.world, there.ground, to.exit.arrive, middleOf(c.world, there, fire(there.roomId)).filter((p) => !blockedB.has(cellKey(p))), blockedB);
	if (!legA || !legB) throw new CommandError(`Zwischen hier und ${to.name} ist kein freier Weg für eine Straße; etwas ist zugebaut.`);
	const cells = [...legA.map((p) => ({ room: here.roomId, ...p })), ...legB.map((p) => ({ room: there.roomId, ...p }))];
	const stone = c.world.prototypes.find((p) => p.key === def.stone)?.name ?? def.stone, wood = c.world.prototypes.find((p) => p.key === def.woodProto)?.name ?? def.woodProto;
	const voters = await votersOf(c.space, c.world, [here.roomId, there.roomId], c.txn), now = await decayNowOf(c.space, c.txn);
	const me = c.account.accountId, others = voters.filter((v) => v !== me);
	const r: RouteFields = {
		routeId: `road-${randomBytes(6).toString("hex")}`, pair, island, rooms: [here.roomId, there.roomId], names: [here.name, there.name], cells,
		state: others.length ? "vote" : "build", planner: c.actor.charId, plannerName: c.actor.name, accountId: me,
		voters, yes: voters.includes(me) ? [me] : [], no: [], ...(voters.includes(me) ? { votedBy: [c.actor.charId] } : {}), voteUntil: now + def.voteWorldMs,
		needs: [{ proto: def.stone, name: stone, count: Math.ceil(cells.length / def.stonePer), have: 0 }, ...(def.wood ? [{ proto: def.woodProto, name: wood, count: def.wood, have: 0 }] : [])],
		work: 0, workNeed: Math.max(def.minWork, Math.ceil(cells.length / def.workPer)), by: {}, untilWorldMs: others.length ? now + def.voteWorldMs : now + def.siteWorldMs, at: now, points: def.points,
	};
	await roadSave(c.space, c.txn!, r);
	const cost = `${cells.length} Felder; es braucht ${missingOf(r).join(", ")}`;
	if (r.state === "vote") {
		for (const room of r.rooms) await msg(c, "*", "world", `${c.actor.name} plant eine Straße zwischen ${r.names[0]} und ${r.names[1]} (${cost}). Die Siedler beider Orte stimmen mit „straße ja“ oder „straße nein“ ab, ${days(def.voteWorldMs)} lang.`, { room });
		await askVoters(c, r);
	} else for (const room of r.rooms) await msg(c, "*", "world", `${c.actor.name} plant eine Straße zwischen ${r.names[0]} und ${r.names[1]} (${cost}); hier wohnt sonst niemand, der abstimmt, also wird gleich gebaut: liefern und mitarbeiten neben der Trasse.`, { room });
}

async function vote(c: CommandCtx, yes: boolean, word: string): Promise<void> {
	const all = (await routesOf(c.space, c.txn)).filter((r) => r.state === "vote" && r.rooms.includes(c.actor.room));
	if (!all.length) throw new CommandError("Hier wird über keine Straße abgestimmt.");
	const w = word.trim().toLowerCase().replace(/^(?:nach|zu|zum|zur|to)\s+/, "");
	const pick = w ? all.filter((r) => r.names.some((n) => n.toLowerCase().startsWith(w))) : all;
	if (pick.length !== 1) throw new NotUnderstood(`Über welche Straße? ${all.map((r) => `„straße ${yes ? "ja" : "nein"} ${r.names[r.rooms[0] === c.actor.room ? 1 : 0]}“`).join(", ")}.`);
	const e = await c.space.takeIfExists({ type: "Route", fields: { routeId: pick[0]!.routeId } }, NO_WAIT, { txn: c.txn });
	if (!e) throw new CommandError("Die Abstimmung ist gerade vorbei; „straße“ zeigt, wie es steht.");
	const r = fieldsOf<RouteFields>(e), me = c.account?.accountId ?? "";
	if (!r.voters.includes(me)) throw new CommandError(`Über diese Straße stimmen die Siedler von ${r.names[0]} und ${r.names[1]} ab (wer dort eine Hütte hat oder als Siedler aufgenommen ist).`);
	// one vote each, and it stands
	if (r.yes.includes(me) || r.no.includes(me)) throw new CommandError(`Du hast schon ${r.yes.includes(me) ? "für" : "gegen"} diese Straße gestimmt; jeder stimmt nur einmal (${votesOf(r)}).`);
	(yes ? r.yes : r.no).push(me);
	r.votedBy = [...(r.votedBy ?? []), c.actor.charId];
	await msg(c, c.actor.charId, "info", `Du stimmst ${yes ? "für" : "gegen"} die Straße zwischen ${r.names[0]} und ${r.names[1]} (${votesOf(r)}).`);
	const now = await decayNowOf(c.space, c.txn);
	if (!(await decide(c.space, c.world, c.txn!, r, now, true, (room, text) => msg(c, "*", "world", text, { room })))) await roadSave(c.space, c.txn!, r);
}

async function mend(c: CommandCtx): Promise<void> {
	const def = defOf(c.world)!;
	const parts = (await c.space.readAll({ type: "Road", fields: { room: c.actor.room } }, { txn: c.txn })).map((e) => fieldsOf<RoadFields>(e));
	const near = parts.find((p) => p.state === "built" && p.cells.some((q) => Math.max(Math.abs(q.x - c.actor.x), Math.abs(q.y - c.actor.y)) <= SITE_REACH));
	if (!near) throw new CommandError("Neben dir ist keine fertige Straße.");
	const e = await c.space.takeIfExists({ type: "Route", fields: { routeId: near.routeId } }, NO_WAIT, { txn: c.txn });
	if (!e) throw new CommandError("Die Straße ist gerade nicht greifbar; bitte noch einmal.");
	const r = fieldsOf<RouteFields>(e), pack = await inventory(c);
	for (const n of def.repair) if (pack.filter((i) => i.f.proto === n.proto).length < n.count) throw new CommandError(`Zum Ausbessern brauchst du ${def.repair.map((x) => `${x.count} ${c.world.prototypes.find((p) => p.key === x.proto)?.name ?? x.proto}`).join(", ")}.`);
	for (const n of def.repair) for (const it of pack.filter((i) => i.f.proto === n.proto).slice(0, n.count)) await c.space.takeIfExists({ type: "Item", fields: { itemId: it.f.itemId, location: c.actor.charId } }, NO_WAIT, { txn: c.txn });
	const keep = def.keepSetting ? ((await setting(c.space, def.keepSetting).catch(() => undefined)) ?? def.keepWorldMs / WORLD_DAY) * WORLD_DAY : def.keepWorldMs;
	r.untilWorldMs = (await decayNowOf(c.space, c.txn)) + keep;
	await roadSave(c.space, c.txn!, r);
	await msg(c, "*", "info", `${c.actor.name} bessert die Straße zwischen ${r.names[0]} und ${r.names[1]} aus; sie hält wieder ${days(keep)}.`);
}

async function show(c: CommandCtx): Promise<void> {
	const all = (await routesOf(c.space, c.txn)).filter((r) => r.rooms.includes(c.actor.room)), now = await decayNowOf(c.space, c.txn);
	const near = (await neighbours(c)).filter((n) => !all.some((r) => r.rooms.includes(n.room)));
	const lines = all.map((r) => {
		const to = r.names[r.rooms[0] === c.actor.room ? 1 : 0];
		if (r.state === "vote") return `Straße nach ${to}: Abstimmung (${votesOf(r)}), noch ${days(r.voteUntil - now)}; geplant von ${r.plannerName}. „straße ja“ oder „straße nein“.`;
		if (r.state === "build") return `Straße nach ${to}: wird gebaut, es fehlen ${missingOf(r).join(", ")}; noch ${days(r.untilWorldMs - now)} Zeit. Neben der Trasse „liefere stein“ und „arbeite“.`;
		return `Straße nach ${to}: fertig, hält noch ${days(r.untilWorldMs - now)} („straße repariere“ bessert sie aus).`;
	});
	if (near.length && defOf(c.world)) lines.push(`Ohne Straße: ${near.map((n) => n.name).join(", ")} („straße plane <ort>“).`);
	await msg(c, c.actor.charId, "info", lines.length ? lines.join("\n") : "Von hier führt kein Weg zu einem anderen Ort dieser Insel.");
}

export const strasse: Command = {
	key: "straße", aliases: ["strasse", "straßen", "strassen", "road", "roads"],
	help: "straße – die Straßen hier; straße plane <ort> (eine Straße von hier zur Mitte des Nachbarorts planen), straße ja|nein [ort] (als Siedler abstimmen, einmal), straße repariere",
	async func(c, arg) {
		if (!defOf(c.world)) throw new CommandError("In dieser Welt gibt es keine Straßen.");
		const m = /^(\S+)\s*(.*)$/.exec(arg.trim());
		const verb = m?.[1]?.toLowerCase() ?? "";
		if (!verb) return show(c);
		if (["plane", "plan", "planen"].includes(verb)) return plan(c, m![2]!);
		if (["ja", "yes", "dafür", "dafuer", "für", "fuer"].includes(verb)) return vote(c, true, m![2]!);
		if (["nein", "no", "dagegen", "gegen"].includes(verb)) return vote(c, false, m![2]!);
		if (["repariere", "repair", "ausbessern", "bessere"].includes(verb)) return mend(c);
		throw new NotUnderstood("So geht es: straße, straße plane <ort>, straße ja, straße nein, straße repariere");
	},
};

/** Votes whose time is up are decided by the votes cast; a road not built in time and a road that decayed go. The single
 *  road cells of old are swept by build.ts buildSweep. */
export async function roadTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<void> {
	if (!defOf(w)) return;
	const now = await decayNowOf(space);
	for (const old of await routesOf(space)) {
		const due = old.state === "vote" ? old.voteUntil <= now : old.untilWorldMs <= now;
		if (!due) continue;
		const txn = (await space.createTransaction(10_000)).id;
		try {
			const e = await space.takeIfExists({ type: "Route", fields: { routeId: old.routeId } }, NO_WAIT, { txn });
			if (!e) { await space.abort(txn); continue; }
			const r = fieldsOf<RouteFields>(e);
			const say = async (room: string, text: string) => { const m = { room, to: "*", kind: "world" as const, text, from: "", at: timeNow() }; await space.write({ type: "Msg", fields: m as never }, txn, leaseMs, await msgOptions(space, m)); };
			if (r.state === "vote") await decide(space, w, txn, r, now, false, say);
			else {
				await roadGone(space, txn, r.routeId);
				for (const room of r.rooms) await say(room, r.state === "build" ? `Die Straße zwischen ${r.names[0]} und ${r.names[1]} wurde nicht rechtzeitig fertig; die Trasse ist aufgegeben.` : `Die Straße zwischen ${r.names[0]} und ${r.names[1]} ist verfallen; Karren fahren dort nicht mehr.`);
			}
			await space.commit(txn);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
}
