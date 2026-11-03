// The play-through of epochs 1 to 4 (docs/siedeln.en.md, "Order"): players play every function of each epoch over the
// game socket, as the page does, and a report says per function whether it worked. The world is set up for it through
// its region spaces (the operator's settings, things into a pack, a building placed beside a player), so each check
// tests its command, not a long way there; one hut is built the whole way (stake out, deliver, work).
//
//   npm run test:play                          a fresh world of its own (in memory, the four regions, a web process)
//   PLAY_URL=http://192.168.8.28:3910 \
//   PLAY_SPACES=west=tcp:127.0.0.1:3960,nord=tcp:127.0.0.1:3962,ost=tcp:127.0.0.1:3963,sued=tcp:127.0.0.1:3964 \
//   npm run test:play                          against a running world (the local test bed): it changes that world,
//                                              puts the settings it changed back and takes the buildings it placed
//   PLAY_ONLY=kontor,karren                    only the checks whose name contains one of these
//   PLAY_OUT=/tmp/mmo-play.json                the report as JSON as well
//
// Model calls stay off (SPACES_MMO_LLM is not set here). The exit code is 1 when a check failed.
import "../test-env.ts";
import { writeFileSync } from "node:fs";
import { FOREVER, type SpaceLike } from "phi-spaces";
import { startServer as startWeb } from "../../server/index.ts";
import { connectSpace } from "../../server/space.ts";
import { saveSettings } from "../../server/settings.ts";
import { loadWorld, walkable } from "../../server/engine/world.ts";
import { resolvePrototype, spawn } from "../../server/engine/prototypes.ts";
import { readClock } from "../../server/engine/clock.ts";
import { worldNow } from "../../server/engine/worldtime.ts";
import { worldNowOf } from "../../server/engine/clock.ts";
import { coversOf } from "../../server/engine/fire.ts";
import { PATH } from "../../server/engine/commands/build.ts";
import { linerOf, shipComes } from "../../server/engine/liner.ts";
import { trainIn } from "../../server/engine/rail.ts";
import type { BuildingFields, CartFields, CharacterFields } from "../../server/model.ts";
import type { ServerFrame } from "../../server/gateway.ts";
import { Player, startRegions } from "../stack.ts";

const w = await loadWorld();
const ONLY = (process.env.PLAY_ONLY ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const REMOTE = !!process.env.PLAY_URL;
/** How long every process takes to read a saved setting anew (5 s in a running world, 0.3 s in a fresh one). */
const SETTLE_MS = REMOTE ? 6_000 : 1_000;
const REGIONS = (w.regions ?? []).map((g) => g.regionId);

// ---- the world: a fresh one, or the one named -------------------------------------------------------------------
type World = { url: string; space: (region: string) => SpaceLike; close(): Promise<void> };
async function open(): Promise<World> {
	if (process.env.PLAY_URL) {
		const conns = new Map((process.env.PLAY_SPACES ?? "").split(",").filter(Boolean).map((kv) => { const [id, addr] = kv.split("="); return [id!, connectSpace(addr!)] as const; }));
		if (!conns.has("west")) throw new Error("PLAY_SPACES names no space for the region west");
		return { url: process.env.PLAY_URL, space: (id) => conns.get(id)!.space, async close() { for (const c of conns.values()) c.close(); } };
	}
	// a world hour is 36 s, the settings are read every 0.3 s, nobody else plays
	const r = await startRegions({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.01", SPACES_MMO_SETTINGS_MS: "300", SPACES_MMO_NPCS: "" } });
	const web = await startWeb({ port: 0, space: "unix:/nowhere", accounts: r.accounts, regions: r.list });
	return { url: web.url, space: r.space, async close() { await web.close(); await r.close(); } };
}

// ---- the report --------------------------------------------------------------------------------------------------
type Result = { epoch: number; name: string; ok: boolean; skipped?: boolean; ms: number; detail: string };
/** A check that cannot run in this world (a running world where something else stands in the way): not a failure. */
class Skip extends Error {}
const results: Result[] = [];
let epochNow = 1;
/** The players' pages: what they received piles up (every change of the world is a frame); before each check only the
 *  latest are kept, so a long run does not grow without end. */
const pages: Player[] = [];
async function check(name: string, run: () => Promise<string | void>): Promise<void> {
	if (ONLY.length && !ONLY.some((o) => name.toLowerCase().includes(o))) return;
	for (const p of pages) if (p.frames.length > 500) p.frames = p.frames.slice(-200);
	const t = Date.now();
	try {
		const detail = (await run()) ?? "";
		results.push({ epoch: epochNow, name, ok: true, ms: Date.now() - t, detail });
		console.log(`  ok    ${name}${detail ? ` – ${detail}` : ""}`);
	} catch (e) {
		const detail = (e as Error).message.slice(0, 600);
		if (e instanceof Skip) { results.push({ epoch: epochNow, name, ok: true, skipped: true, ms: Date.now() - t, detail }); console.log(`  –     ${name} – übersprungen: ${detail}`); return; }
		results.push({ epoch: epochNow, name, ok: false, ms: Date.now() - t, detail });
		console.log(`  FEHLER ${name} – ${detail}`);
	}
}

// ---- players -----------------------------------------------------------------------------------------------------
type P = { p: Player; me: string; name: string; account: string };
/** What a player was told since frame `from`, without the world's news (tide, storms, fog). */
const texts = (p: Player, from: number) => p.frames.slice(from).flatMap((f) => (f.t === "msg" && f.m.kind !== "world" && !/^\[hafen\]|^Die Flut spült/.test(f.m.text) ? [f.m.text] : []));
/** Sends a line and waits for a message matching `want`; an error message that does not match ends the wait at once. */
async function does(who: P, line: string, want: RegExp, ms = 20_000): Promise<string> {
	const from = who.p.frames.length;
	who.p.send(line);
	const end = Date.now() + ms;
	for (;;) {
		const seen = who.p.frames.slice(from);
		const hit = seen.find((f) => f.t === "msg" && want.test(f.m.text)) as Extract<ServerFrame, { t: "msg" }> | undefined;
		if (hit) return hit.m.text;
		const err = seen.find((f) => f.t === "msg" && f.m.kind === "error") as Extract<ServerFrame, { t: "msg" }> | undefined;
		if (err) throw new Error(`„${line}“: ${err.m.text}`);
		if (Date.now() > end) throw new Error(`„${line}“: no answer like ${want}; heard: ${texts(who.p, from).slice(-6).join(" | ") || "nothing"}`);
		await new Promise((r) => setTimeout(r, 30));
	}
}
let world: World;
const west = () => world.space("west");
/** A registered player in the west (newcomers start in the regions in turn: one registers until one starts there). */
async function join(name: string): Promise<P> {
	for (let i = 0; i < 8; i++) {
		const p = new Player(world.url), n = i ? `${name}${i}` : name;
		const r = await p.post("/api/register", { name: n, password: "durchspiel-123" });
		if (r.status !== 200) throw new Error(`register ${n}: ${r.status} ${JSON.stringify(r.body)}`);
		const hello = await p.play();
		const ch = (await west().readAll({ type: "Character", fields: { charId: hello.me.charId } }))[0]?.fields as unknown as CharacterFields | undefined;
		if (ch) { pages.push(p); return { p, me: hello.me.charId, name: n, account: ch.accountId }; }
		await p.leave();
	}
	throw new Error("no newcomer started in the west");
}
const charOf = async (who: P) => (await west().readAll({ type: "Character", fields: { charId: who.me } }))[0]?.fields as unknown as CharacterFields | undefined;
/** Things into a pack (or a chest: any location). */
async function give(where: string, proto: string, n = 1): Promise<void> {
	const p = await resolvePrototype(west(), proto);
	if (!p) throw new Error(`no prototype ${proto}`);
	for (let i = 0; i < n; i++) await spawn(west(), null, w, p, { location: where, x: -1, y: -1 });
}
const count = (where: string, proto: string) => west().count({ type: "Item", fields: { location: where, proto } });
/** Walks to a cell and waits until the server has the figure there. */
async function goTo(who: P, x: number, y: number): Promise<void> {
	who.p.send(`move ${x} ${y}`);
	const end = Date.now() + 20_000;
	for (;;) {
		const c = await charOf(who);
		if (c && c.x === x && c.y === y) return;
		if (Date.now() > end) throw new Error(`could not walk to ${x} ${y} (at ${c?.x} ${c?.y})`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
/** A building of `who` placed right of where they stand (the check is about its use, not its building). */
async function place(who: P, plan: string, over: Partial<BuildingFields> = {}): Promise<BuildingFields> {
	const def = w.building!.plans.find((p) => p.key === plan)!, c = (await charOf(who))!;
	const b: BuildingFields = { buildId: `play-${plan}-${Date.now().toString(36)}`, plan, name: def.name, room: c.room, x: c.x + 1, y: c.y, w: 1, h: 1, owner: who.me, ownerName: who.name, accountId: who.account, beaconId: "feuer-bucht", points: def.points, by: {}, untilWorldMs: FOREVER, builtAt: 0, ...over };
	await west().write({ type: "Building", fields: b as never }, null, FOREVER);
	return b;
}
/** How much slower the world's clock runs than the fresh one's (a world hour of 36 s): the waits for the world grow by it. */
let slower = 1;
/** Waits until `ok` holds, at most `ms` (on the fresh world's clock). */
async function until(what: string, ok: () => Promise<boolean>, ms = 60_000): Promise<void> {
	const end = Date.now() + ms * slower;
	let slow = 0;
	for (;;) {
		const t = Date.now();
		if (await ok()) return;
		slow = Math.max(slow, Date.now() - t);
		if (Date.now() > end) throw new Error(`waited in vain: ${what} (the slowest look took ${slow} ms)`);
		await new Promise((r) => setTimeout(r, 1_000));
	}
}
async function unplace(b: BuildingFields): Promise<void> {
	for (const e of await west().readAll({ type: "Building", fields: { buildId: b.buildId } })) await west().takeIfExists({ id: e.id }, 0);
}
async function setEpoch(n: number): Promise<void> {
	epochNow = n;
	for (const id of REGIONS) await saveSettings(world.space(id), { "epoch.force": n });
	await new Promise((r) => setTimeout(r, SETTLE_MS)); // every process reads the settings anew
}
/** The top left cell of a free `fw`×`fh` area in `room` (walkable, nothing standing or lying, no figure, away from exits and
 *  fires, no paved way: nothing is built on one; `siteMargin` cells from any building site: delivering and working reach
 *  two); `tile` asks for that ground. */
async function freeRect(room: string, fw: number, fh: number, tile?: string, siteMargin = 3): Promise<{ x: number; y: number }> {
	const def = w.rooms.find((r) => r.roomId === room)!, taken = new Set<string>();
	const mark = (x: number, y: number, rw = 1, rh = 1, m = 0) => { for (let i = x - m; i < x + rw + m; i++) for (let j = y - m; j < y + rh + m; j++) taken.add(`${i},${j}`); };
	for (const type of ["Building", "Site", "Ruin", "Bed", "Field", "Scenery"]) for (const e of await west().readAll({ type, fields: { room } })) mark(Number(e.fields.x), Number(e.fields.y), Number(e.fields.w ?? 1), Number(e.fields.h ?? 1), type === "Site" ? siteMargin : 0);
	for (const e of await west().readAll({ type: "Plot", fields: { room } })) mark(Number(e.fields.x), Number(e.fields.y));
	for (const e of await west().readAll({ type: "Exit", fields: { location: room } })) mark(Number(e.fields.x), Number(e.fields.y), 1, 1, 2);
	for (const b of w.beacons.filter((x) => x.room === room)) mark(b.x, b.y, 1, 1, 2);
	// only a figure that is online holds its cell (engine/occupancy.ts): the players of earlier runs, gone, block nothing
	const live = new Set((await west().readAll({ type: "Session" })).map((e) => String(e.fields.charId)));
	for (const e of await west().readAll({ type: "Character", fields: { room } })) if (live.has(String(e.fields.charId))) mark(Number(e.fields.x), Number(e.fields.y));
	for (let y = 0; y + fh <= def.ground.length; y++) for (let x = 0; x + fw <= def.ground[0]!.length; x++) {
		let ok = true;
		for (let j = y; j < y + fh && ok; j++) for (let i = x; i < x + fw && ok; i++) ok = walkable(w, def.ground, i, j) && def.ground[j]![i] !== PATH && !taken.has(`${i},${j}`) && (!tile || def.ground[j]![i] === tile);
		if (ok) return { x, y };
	}
	throw new Skip(`in ${def.name} ist kein freier Platz von ${fw}×${fh}`);
}
/** Walks onto a free cell beside (x, y). */
async function goNear(who: P, x: number, y: number): Promise<void> {
	let last: Error | null = null;
	for (const [dx, dy] of [[-1, 0], [1, 0], [0, 1], [0, -1], [-1, 1], [1, 1], [-1, -1], [1, -1]] as const) {
		try { return await goTo(who, x + dx, y + dy); } catch (e) { last = e as Error; }
	}
	throw last!;
}
/** Through an exit into the next room (a fire lit from outside clears the fog only with its next step: asked again). */
async function through(who: P, exit: string, room: string): Promise<void> {
	await until(`in ${room}`, async () => { if ((await charOf(who))?.room === room) return true; who.p.send(`go ${exit}`); return false; }, 60_000);
}
/** The rooms a check may go to: the bay, and the cliff path one way east of it (a running world's bay can be full). */
const ROOMS = ["graue-bucht", "klippenpfad"] as const;
/** A free area in the first of `ROOMS` that has one; a skip when none has. */
async function roomWith(fw: number, fh: number): Promise<{ room: string; x: number; y: number }> {
	let why = "";
	for (const room of ROOMS) { try { return { room, ...(await freeRect(room, fw, fh)) }; } catch (e) { if (!(e instanceof Skip)) throw e; why = e.message; } }
	throw new Skip(why);
}
/** Walks `who` from the bay to `room` (the bay itself or the cliff path) and back again after `run`. */
async function inRoom<T>(who: P, room: string, run: () => Promise<T>, back: () => Promise<void>): Promise<T> {
	if (room !== "graue-bucht") await through(who, "ost", room);
	try { return await run(); }
	finally { if ((await charOf(who))?.room !== "graue-bucht") await through(who, "west", "graue-bucht"); await back(); }
}
/** The saved settings of every region, to put back when a running world was played in. */
async function settingsNow(): Promise<Map<string, Array<Record<string, unknown>>>> {
	return new Map(await Promise.all(REGIONS.map(async (id) => [id, (await world.space(id).readAll({ type: "Setting" })).map((e) => e.fields)] as const)));
}
async function putSettingsBack(saved: Map<string, Array<Record<string, unknown>>>): Promise<void> {
	for (const [id, fields] of saved) {
		const s = world.space(id);
		for (const e of await s.readAll({ type: "Setting" })) await s.takeIfExists({ id: e.id }, 0);
		for (const f of fields) await s.write({ type: "Setting", fields: f as never }, null, FOREVER);
	}
}
/** What the play-through placed (its buildings are named play-…), taken away again. */
async function tidyUp(players: P[] = []): Promise<number> {
	let n = 0;
	for (const e of await west().readAll({ type: "Building" })) if (String(e.fields.buildId).startsWith("play-") && (await west().takeIfExists({ id: e.id }, 0))) n++;
	// and what its players built (the hut), left staked out (a check that failed half-way) or set down (the carts): a
	// running world's bay and roads fill up
	const mine = new Set(players.map((p) => p.account));
	for (const type of ["Building", "Site", "Cart"]) for (const e of await west().readAll({ type })) {
		if (!mine.has(String(e.fields.accountId)) || !(await west().takeIfExists({ id: e.id }, 0))) continue;
		n++;
		// a cart's load lies at it; a building's or site's cells (Plot `of`) stay taken otherwise
		if (type === "Cart") for (const item of await west().readAll({ type: "Item", fields: { location: String(e.fields.cartId) } })) await west().takeIfExists({ id: item.id }, 0);
		else for (const cell of await west().readAll({ type: "Plot", fields: { of: String(e.fields.buildId ?? e.fields.siteId) } })) await west().takeIfExists({ id: cell.id }, 0);
	}
	return n;
}
async function lightFires(): Promise<void> {
	const clock = await readClock(west()), now = worldNow(clock);
	for (const b of w.beacons.filter((x) => ["feuer-bucht", "feuer-anleger"].includes(x.beaconId))) {
		for (const e of await west().readAll({ type: "Flame", fields: { beaconId: b.beaconId } })) await west().takeIfExists({ id: e.id }, 0);
		await west().write({ type: "Flame", fields: { beaconId: b.beaconId, until: now + 3 * 3600_000 * clock.rate, litAt: now } as never }, null, FOREVER);
	}
}

// ---- the play-through --------------------------------------------------------------------------------------------
world = await open();
// stopped by hand: the world's processes go too, none is left running
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { void world.close().finally(() => process.exit(130)); });
let failed = false;
const savedSettings = await settingsNow();
let players: P[] = [];
try {
	slower = Math.max(1, 100 / (await readClock(west())).rate);
	for (const id of REGIONS) await saveSettings(world.space(id), { "work.rest": 0, "cmd.burst": 1_000, "cmd.perSec": 100 });
	await new Promise((r) => setTimeout(r, SETTLE_MS));
	await lightFires();
	const tag = [...Date.now().toString(36).slice(-4)].map((ch) => (/\d/.test(ch) ? "abcdefghij"[Number(ch)] : ch)).join(""); // letters only: names take no digits
	const a = await join(`Ada${tag}`), b = await join(`Bo${tag}`);
	players = [a, b];
	console.log(`Durchspiel mit ${a.name} und ${b.name} auf ${world.url}`);
	// a free corner of the bay: A works at (x+2, y+1) with the buildings placed right of her and her hut staked out below,
	// B waits under it, or comes up to (x+2, y) beside them
	// (a full bay, as a running world's: a smaller corner, at last one beside a site)
	// each layout: its size, the distance it keeps from sites, the column A, B and the buildings use, and B's waiting row
	let base: { x: number; y: number; dx: number; restY: number } | null = null;
	for (const [fw, fh, m, dx, restY] of [[5, 5, 3, 2, 4], [3, 4, 3, 0, 3], [3, 3, 3, 0, 2], [3, 4, 0, 0, 3], [3, 3, 0, 0, 2]] as const) {
		try { base = { ...(await freeRect("graue-bucht", fw, fh, undefined, m)), dx, restY }; break; } catch (e) { if (!(e instanceof Skip)) throw e; }
	}
	if (!base) throw new Error("in der Bucht ist kein Platz für das Durchspiel");
	const home = { x: base.x + base.dx, y: base.y + 1 }, rest = { x: base.x + base.dx, y: base.y + base.restY }, beside = { x: base.x + base.dx, y: base.y };
	const atHome = () => goTo(a, home.x, home.y);
	await atHome(); await goTo(b, rest.x, rest.y);

	console.log("Epoche 1: Fischerdorf");
	await setEpoch(1);
	await check("epoche", async () => (await does(a, "epoche", /Epoche|Fischerdorf/)).slice(0, 80));
	await check("hütte bauen (abstecken, liefern, arbeiten)", async () => {
		const def = w.building!.plans.find((p) => p.key === "huette")!;
		for (const n of def.needs) await give(a.me, n.proto, n.count);
		await does(a, "bau hütte", /steckt eine Baustelle ab/);
		// delivering and working go to the site in reach: a site of someone else as near (a full bay) would take them
		const sites = (await west().readAll({ type: "Site", fields: { room: "graue-bucht" } })).map((e) => e.fields as unknown as { accountId: string; x: number; y: number; w: number; h: number; plan: string });
		const me = (await charOf(a))!, reach = (f: { x: number; y: number; w: number; h: number }) => Math.max(0, f.x - me.x, me.x - (f.x + f.w - 1)) <= 2 && Math.max(0, f.y - me.y, me.y - (f.y + f.h - 1)) <= 2;
		const foreign = sites.find((f) => f.accountId !== a.account && reach(f));
		if (foreign) throw new Skip(`neben der Baustelle liegt eine fremde (${foreign.plan}); die Bucht ist zu voll`);
		for (const n of def.needs) await does(a, `liefere ${n.count} ${w.prototypes.find((p) => p.key === n.proto)!.name}`, /lieferst|liefert/);
		// the two take turns; each point is told as „… arbeitet an der Hütte (n/20)“, the last one finishes it
		let last = "";
		for (let i = 0; i < def.work * 2; i++) {
			const t = last = await does(i % 2 ? b : a, "arbeite", /arbeitet an der|ruhst/);
			const other = /arbeitet an der (?!Hütte)(\S+)/.exec(t);
			if (other) throw new Error(`the work went to another site (${other[1]}): a site of someone else is as near`);
			const m = /arbeitet an der Hütte \((\d+)\/(\d+)\)/.exec(t);
			if (m && m[1] === m[2]) break;
		}
		const built = (await west().readAll({ type: "Building", fields: { accountId: a.account, plan: "huette" } })).length;
		if (!built) throw new Error(`no hut after the work; the last answer: ${last}`);
		return `${def.work} Arbeitspunkte`;
	});
	await check("truhe: verstauen, ansehen, entnehmen", async () => {
		await give(a.me, "muschel", 3);
		await does(a, "verstaue 3 muschel", /Truhe|verstaust/);
		await does(a, "truhe", /In der Truhe/);
		await does(a, "entnimm 2 muschel", /nimmst|Truhe/);
	});
	await check("feuer: holz nachlegen", async () => {
		const fire = w.beacons.find((x) => x.beaconId === "feuer-bucht")!;
		await goNear(a, fire.x, fire.y);
		await give(a.me, "treibholz", 1);
		await does(a, "put treibholz in feuer", /legst .* ins|brennt/);
		await atHome();
	});
	await check("tausch: anbieten und annehmen", async () => {
		await give(a.me, "muschel", 1); await give(b.me, w.currency, 1);
		await does(a, `offer muschel an ${b.name} für münze`, /bietet|bietest/);
		await does(b, "accept", /Tausch|tauscht|angenommen/);
	});
	await check("marktbrett: anbieten und kaufen", async () => {
		await give(a.me, "muschel", 1); await give(b.me, w.currency, 3);
		await does(a, "market biete muschel für 2", /Marktbrett|bietet|hängt/);
		const board = await does(b, "market", /\d+\./);
		const nr = /(\d+)\.\s*[^;]*Muschel/.exec(board)?.[1] ?? "1";
		await does(b, `market kaufe ${nr}`, /kaufst|gekauft/);
	});
	await check("regentonne: wasser schöpfen", async () => {
		const t = await place(a, "regentonne");
		await give(a.me, "wasserkanne", 1);
		await does(a, "schöpfe", /Kanne|Wasser/);
		await unplace(t);
	});
	await check("beet: umgraben, pflanzen, gießen", async () => {
		await give(a.me, "spaten", 1); await give(a.me, "samen-moehre", 1);
		const area = await roomWith(5, 5);
		await inRoom(a, area.room, async () => {
			await goTo(a, area.x + 2, area.y + 2);
			await does(a, "umgraben", /Beet/);
			await does(a, "pflanze samen-moehre", /setzt|pflanzt|Beet/);
			await does(a, "gieße", /gießt|gegossen|Kanne/);
		}, atHome);
		return area.room === "graue-bucht" ? "" : "im Klippenpfad";
	});
	await check("steg: netz auswerfen", async () => {
		const s = await place(a, "steg");
		await give(a.me, "netz", 1);
		await does(a, "wirf netz", /aus dem Wasser|Netz/);
		await unplace(s);
	});
	await check("räucherei: räucherfisch, netz aufs gestell", async () => {
		const r = await place(a, "raeucherei");
		await give(a.me, "fisch", 2); await give(a.me, "treibholz", 1); await give(a.me, "netz", 1);
		await does(a, "craft räucherfisch", /Räucherfisch/);
		await does(a, "verstaue netz", /Truhe|verstaust|Gestell/);
		await unplace(r);
	});
	await check("essen", async () => { await give(a.me, "brot", 1); await does(a, "iss brot", /satt|isst/); });
	await check("handwerk: tangseil", async () => { await give(a.me, "tang", 4); await does(a, "craft tangseil", /Tangseil/); });
	await check("hühnerstall: einstallen, füttern, ansehen", async () => {
		const s = await place(a, "huehnerstall");
		await give(a.me, "huhn", 1); await give(a.me, "weizen", 1);
		await does(a, "einstallen huhn", /Stall|stallst/);
		await does(a, "füttere", /füttert|fütterst|satt/);
		await does(a, "stall", /Huhn|Hühner|Stall/);
		await unplace(s);
	});
	await check("wild verscheuchen", async () => {
		const c = (await charOf(a))!;
		await west().write({ type: "Animal", fields: { animalId: `hase-play-${tag}`, kind: "hase", name: "Hase", room: c.room, x: c.x + 1, y: c.y + 1, bedId: "none", eatsAtWorldMs: FOREVER, at: 0 } as never }, null, FOREVER);
		await does(a, "scheuche hase", /scheucht/);
	});

	console.log("Epoche 2: Dorf");
	await setEpoch(2);
	await check("werkstatt: bohle und karren", async () => {
		const x = await place(a, "werkstatt");
		await give(a.me, "muschelmesser", 1); await give(a.me, "treibholz", 2); await give(a.me, "tauwerk", 1); await give(a.me, "bohle", 4);
		await does(a, "craft bohle", /Bohle/);
		await does(a, "craft karren", /Karren/);
		await unplace(x);
	});
	await check("lagerhaus: einlagern und ansehen", async () => {
		const x = await place(a, "lagerhaus");
		await give(a.me, "stein", 2);
		await does(a, "verstaue 2 stein", /Lager|verstaust|Truhe/);
		await does(a, "lager", /Lager/);
		await unplace(x);
	});
	await check("windmühle: korn mahlen", async () => {
		const x = await place(a, "windmuehle");
		await give(a.me, "weizen", 2);
		await does(a, "mahle 2 weizen", /Mühle|mahlt|Mehl/);
		await unplace(x);
	});
	await check("backhaus: brot backen", async () => {
		const x = await place(a, "backhaus");
		await give(a.me, "mehl", 2); await give(a.me, "wasserkanne", 1); await give(a.me, "treibholz", 1);
		await does(a, "backe brot", /Brot/);
		await unplace(x);
	});
	await check("webstuhl: tuch weben", async () => {
		const x = await place(a, "webstuhl");
		await give(a.me, "wolle", 3); await give(a.me, "spindel", 1);
		await does(a, "craft tuch", /Tuch/);
		await unplace(x);
	});
	await check("steinbruch: stein brechen", async () => {
		const x = await place(a, "steinbruch");
		await give(a.me, "spitzhacke", 1);
		await does(a, "breche", /Stein/);
		await unplace(x);
	});
	await check("lehmgrube: lehm stechen", async () => {
		const x = await place(a, "lehmgrube");
		await give(a.me, "spaten", 1);
		await does(a, "steche", /Lehm/);
		await unplace(x);
	});
	await check("ziegelei: ziegel brennen", async () => {
		const x = await place(a, "ziegelei");
		await give(a.me, "lehm", 3); await give(a.me, "treibholz", 1);
		await does(a, "craft ziegel", /Ziegel/);
		await unplace(x);
	});
	await check("kapelle: opfern", async () => {
		const x = await place(a, "kapelle");
		await give(a.me, "perle", 1);
		await does(a, "opfere perle", /opfer|Segen|halb/i);
		await unplace(x);
	});
	await check("gehege: ein schaf einstallen", async () => {
		const x = await place(a, "gehege");
		await give(a.me, "schaf", 1);
		await does(a, "einstallen schaf", /bringt ein Schaf/);
		await unplace(x);
	});
	await check("acker: anlegen und bestellen", async () => {
		await give(a.me, "spaten", 1); await give(a.me, "gerste", 4);
		// standing at the top of a free 6×6, the field goes below
		const area = await roomWith(6, 6);
		await inRoom(a, area.room, async () => {
			await goTo(a, area.x + 2, area.y + 1);
			await does(a, "flur anlegen", /bricht einen Acker um/);
			await does(a, "bestelle gerste", /Gerste|Saat|bestell/);
		}, atHome);
		return area.room === "graue-bucht" ? "" : "im Klippenpfad";
	});
	// where the settlement is founded: the first of ROOMS without one (a running world's bay may have one)
	let town: string | null = null;
	await check("siedlung gründen", async () => {
		const room = (await Promise.all(ROOMS.map(async (r) => [r, await west().count({ type: "Settlement", fields: { room: r } })] as const))).find(([, n]) => !n)?.[0];
		if (!room) throw new Skip("in der Bucht und im Klippenpfad gibt es schon eine Siedlung");
		// three huts of two owners in that room (wherever there is room; the check is about founding)
		for (const [who, i] of [[a, 1], [b, 2], [b, 3]] as const) await place(who, "huette", { room, ...(await freeRect(room, 2, 2).catch(() => ({ x: i * 3, y: 1 }))), w: 2, h: 2, buildId: `play-hut-${i}-${tag}` });
		await inRoom(a, room, async () => {
			await does(a, `siedlung gründen Durchspiel${tag}`, /gründet die Siedlung/);
			town = room;
			await does(a, `siedlung aufnehmen ${b.name}`, /nimmt|aufgenommen|gehört/);
		}, atHome);
		return room === "graue-bucht" ? "" : "im Klippenpfad";
	});
	const exit = { x: 23, y: 8 }; // the bay's way east to the cliff path
	let road: BuildingFields | null = null;
	await check("straße und karren", async () => {
		road = await place(a, "strasse", { x: exit.x, y: exit.y - 1, buildId: `play-road-${tag}` });
		await give(a.me, "karren", 1); await give(a.me, "treibholz", 1);
		await does(a, "karren stelle", /Karren ab/);
		await does(a, "karren lade treibholz", /auf dem Karren/);
		await does(a, "karren fahre klippenpfad", /schickst/);
		await until("the cart in the cliff path", async () => (await west().readAll({ type: "Cart", fields: { accountId: a.account } })).some((e) => (e.fields as unknown as CartFields).room === "klippenpfad"), 120_000);
		return "angekommen";
	});

	console.log("Epoche 3: Stadt");
	await setEpoch(3);
	await check("rathaus: antrag und abstimmung", async () => {
		const room = town;
		if (!room) throw new Skip("keine eigene Siedlung (siedlung gründen)");
		// both settlers go there: the hall beside A, B votes from where she stands
		return await inRoom(b, room, () => inRoom(a, room, async () => {
			const hall = await freeRect(room, 3, 1);
			await goTo(a, hall.x, hall.y);
			const x = await place(a, "rathaus");
			// a motion still open there (a running world played in before: a vote lasts a world day) is voted on as it is
			let open = false;
			try { await does(a, "antrag steuer 2", /beantragt im Rathaus/); }
			catch (e) { if (!/schon ein Antrag/.test((e as Error).message)) throw e; open = true; }
			await does(b, "stimme ja", /Deine Stimme zählt/);
			await unplace(x);
			return open;
		}, atHome), () => goTo(b, rest.x, rest.y)).then((open) => [room === "graue-bucht" ? "" : "im Klippenpfad", open ? "ein Antrag lief schon, abgestimmt" : ""].filter(Boolean).join("; "));
	});
	await check("kaufhaus: einlegen, verkaufen, kaufen", async () => {
		const x = await place(a, "kaufhaus");
		await goTo(b, beside.x, beside.y);
		await give(a.me, w.currency, 6); await give(b.me, "fisch", 2); await give(b.me, w.currency, 10);
		await does(a, "laden einlegen 6", /Kasse|legst/);
		await does(b, "laden verkaufe fisch", /verkaufst/);
		await does(b, "laden kaufe fisch", /kaufst/);
		await does(b, "laden", /Regal/);
		await unplace(x);
		await goTo(b, rest.x, rest.y);
	});
	await check("kontor: kredit, tilgen, wechsel weitergeben und einlösen", async () => {
		const x = await place(a, "kontor");
		await goTo(b, beside.x, beside.y);
		await give(x.buildId, w.currency, 10); await give(a.me, "perle", 1); await give(a.me, w.currency, 12);
		await does(a, "kredit 5 gegen perle", /Du leihst/);
		await does(a, "tilge", /Pfand wieder/);
		await does(a, "wechsel 10", /schreibt dir einen Wechsel über 10/);
		await does(a, `give wechsel an ${b.name}`, /gibst|gibt/);
		const before = await count(b.me, w.currency);
		await does(b, "wechsel einlösen", /zahlt dir den Wechsel aus: 10 Münzen/);
		if ((await count(b.me, w.currency)) - before !== 10) throw new Error("the bill paid out the wrong sum");
		await unplace(x);
		await goTo(b, rest.x, rest.y);
	});
	await check("leuchtturm: mehr licht, mehr räume", async () => {
		const t = await place(a, "leuchtturm", { room: "klippenpfad", x: 2, y: 2, buildId: `play-tower-${tag}` });
		const cover = await coversOf(west(), w);
		if (!cover.get("feuer-bucht")!.includes("klippenkopf")) throw new Error(`the bay's fire covers ${cover.get("feuer-bucht")!.join(", ")}`);
		await unplace(t);
		return "Feuer der Bucht reicht bis Klippenkopf";
	});
	await check("park: pflegen", async () => {
		const x = await place(a, "park");
		await give(a.me, "strandnelke", 1);
		await does(a, "pflege", /Park|Ruf|setzt/);
		await unplace(x);
	});
	await check("brauerei: bier", async () => {
		const x = await place(a, "brauerei");
		await give(a.me, "gerste", 3); await give(a.me, "hopfen", 1); await give(a.me, "wasserkanne", 1);
		await does(a, "craft bier", /Bier/);
		await unplace(x);
	});
	await check("strand: sand schaufeln, glashütte: glas", async () => {
		await give(a.me, "spaten", 1);
		const beach = await freeRect("graue-bucht", 1, 1, w.sand!.tile);
		await goTo(a, beach.x, beach.y);
		await does(a, "schaufle", /Sand/);
		await atHome();
		const x = await place(a, "glashuette");
		await give(a.me, "sand", 3); await give(a.me, "treibholz", 2);
		await does(a, "craft glas", /Glas/);
		await unplace(x);
	});
	await check("werft: segelboot", async () => {
		const x = await place(a, "werft");
		await give(a.me, "bohle", 10); await give(a.me, "leinen", 4); await give(a.me, "tauwerk", 2);
		await does(a, "craft segelboot", /Segelboot/);
		await unplace(x);
	});
	await check("steg: luke laden und entladen, rudern", async () => {
		const s = await place(a, "steg", { buildId: `play-jetty-${tag}` });
		const far = await place(a, "steg", { room: "klippenpfad", x: 3, y: 3, buildId: `play-jetty2-${tag}` });
		await give(a.me, "ruderboot", 1); await give(a.me, "muschel", 2);
		await does(a, "luke lade 2 muschel", /Luke/);
		await does(a, "luke", /Luke/);
		await does(a, "luke entlade alle", /Luke|nimmst/);
		await does(a, "rudere klippenpfad", /legst am Steg an/);
		await until("at the cliff path", async () => (await charOf(a))?.room === "klippenpfad", 20_000);
		await through(a, "west", "graue-bucht");
		await atHome();
		await unplace(s); await unplace(far);
	});

	console.log("Epoche 4: Netz");
	await setEpoch(4);
	await check("inselbahn: fahrplan, fahrt, fracht", async () => {
		// a station that stands (a running world has some), else one placed where none is staked out (one to a room)
		const plan = w.rail!.plan, stationIn = async (room: string) => (await west().readAll({ type: "Building", fields: { room, plan } }))[0]?.fields as unknown as BuildingFields | undefined;
		const staked = async (room: string) => (await west().count({ type: "Site", fields: { room, plan } })) > 0;
		const station = async (room: string, id: string) => (await stationIn(room)) ?? (await staked(room) ? null : await place(a, plan, { room, ...(await freeRect(room, 3, 3)), w: 3, h: 2, buildId: `play-${id}-${tag}` }));
		const s2 = await station("klippenkopf", "st2");
		let from: string | null = null, s1: BuildingFields | null = null;
		for (const r of ROOMS) { s1 = await station(r, "st1"); if (s1) { from = r; break; } }
		if (!s1 || !s2 || !from) throw new Skip("ein Bahnhof wird dort erst gebaut");
		const fromName = w.rooms.find((r) => r.roomId === from)!.name;
		await inRoom(a, from, async () => {
		await goNear(a, s1.x + 1, s1.y + s1.h);
		await does(a, "zug", /Der Zug fährt nach: .*Klippenkopf/);
		// the train stands the first half of each period; a command goes only while it does, so each waits for a train with
		// a few world minutes still to stand (in a fresh world ten world minutes are six seconds)
		const every = w.rail!.everyWorldMs!, train = () => until("the train at the platform", async () => { const at = ((await worldNowOf(west())) ?? 0) % every; return trainIn(at, every) === 0 && every / 2 - at > 4 * 60_000; }, 600_000);
		await give(a.me, w.currency, 3); await give(a.me, "muschel", 2);
		await train();
		await does(a, "zug sende 2 muschel nach klippenkopf", /als Fracht nach Klippenkopf/);
		await train();
		await does(a, "zug klippenkopf", /steigst/);
		await until("in Klippenkopf", async () => (await charOf(a))?.room === "klippenkopf", 20_000);
		await does(a, "zug abholen", /Fracht vom Bahnsteig/);
		await train();
		await does(a, `zug ${fromName.toLowerCase()}`, /steigst/);
		await until(`back in ${fromName}`, async () => (await charOf(a))?.room === from, 20_000);
		}, atHome);
		return from === "graue-bucht" ? "" : "ab dem Klippenpfad";
	});
	await check("karren pendelt zwischen zwei truhen", async () => {
		const c = (await west().readAll({ type: "Cart", fields: { accountId: a.account } }))[0]?.fields as unknown as CartFields | undefined;
		if (!c) throw new Error("no cart (the check of epoch 2 failed)");
		// it stands in the cliff path, where it went in epoch 2: a hut there with wood in its chest, one in the bay; its owner
		// walks to it and sends it back and forth
		const hutHere = await place(a, "huette", { room: c.room, ...(await freeRect(c.room, 2, 2)), w: 2, h: 2, buildId: `play-hut-far-${tag}` });
		const hutBay = await place(a, "huette", { room: "graue-bucht", ...(await freeRect("graue-bucht", 2, 2)), w: 2, h: 2, buildId: `play-hut-home-${tag}` });
		await give(hutHere.buildId, "treibholz", 3);
		await through(a, "ost", c.room);
		await goNear(a, c.x, c.y);
		await does(a, "karren pendel graue bucht mit treibholz", /pendelt jetzt zwischen/);
		// a cart goes on in the world's garden job: it loads, goes, unloads
		// it unloads into the first of A's chests in the bay that has room: all of them count
		const inBay = async () => { let n = 0; for (const e of await west().readAll({ type: "Building", fields: { room: "graue-bucht", accountId: a.account } })) n += await count(String(e.fields.buildId), "treibholz"); return n; };
		const before = await inBay();
		try { await until("the wood in a hut in the bay", async () => (await inBay()) >= before + 3, 600_000); }
		catch (e) { const now = (await west().readAll({ type: "Cart", fields: { cartId: c.cartId } }))[0]?.fields; throw new Error(`${(e as Error).message}; the cart: ${JSON.stringify(now)}; on it: ${await west().count({ type: "Item", fields: { location: c.cartId } })}`); }
		await does(a, "karren halt", /pendelt nicht mehr/);
		await through(a, "west", "graue-bucht");
		await atHome();
		return `${(await inBay()) - before} Treibholz in die Bucht gebracht`;
	});
	await check("signalfeuer: eine kette teilt das licht zweier feuer", async () => {
		// one in the cliff path in the bay's fire, one on the cliff head in the landing's: a chain of two fires
		await lightFires();
		const one = await place(a, "signalfeuer", { room: "klippenpfad", ...(await freeRect("klippenpfad", 1, 1)), buildId: `play-signal-1-${tag}`, beaconId: "feuer-bucht" });
		const two = await place(a, "signalfeuer", { room: "klippenkopf", ...(await freeRect("klippenkopf", 1, 1)), buildId: `play-signal-2-${tag}`, beaconId: "feuer-anleger" });
		try {
			await does(a, "signalfeuer", /die Kette brennt/);
			if (!(await coversOf(west(), w)).get("feuer-bucht")!.includes("anleger")) throw new Error("the bay's fire does not share the landing's light");
			// the world's fire job counts the island's run
			const island = w.rooms.find((r) => r.roomId === "graue-bucht")!.island!;
			await until("the island's run of the chain", async () => Number((await west().readAll({ type: "FireChain", fields: { island } }))[0]?.fields.since ?? 0) > 0, 60_000);
		} finally { await unplace(one); await unplace(two); }
		return "Feuer der Bucht und am Anleger teilen ihr Licht";
	});
	await check("großes schiff: fahrplan", async () => (await does(a, "fahrplan", /große Schiff/)).slice(0, 100));
	await check("großes schiff: einschiffen und ankommen", async () => {
		const t = linerOf(w)!, here = t.stops.findIndex((x) => x.room === "graue-bucht");
		await until("the ship in the bay", async () => shipComes(t, (await worldNowOf(west())) ?? 0, here) === 0, 900_000);
		await give(b.me, w.currency, w.liner!.fare);
		const to = t.stops[(here + 1) % t.stops.length]!;
		const isl = w.rooms.find((r) => r.roomId === to.room)!.island!;
		await does(b, `einschiffen ${isl}`, /an Bord|legt ab|fährst/);
		await until("landed", async () => (await Promise.all((w.regions ?? []).map((g) => world.space(g.regionId).readAll({ type: "Character", fields: { charId: b.me } })))).flat().some((e) => !(e.fields as unknown as CharacterFields).aboard && (e.fields as unknown as CharacterFields).room === to.room), 900_000);
		return `nach ${to.room}`;
	});
	await check("beamen", async () => (await does(a, "beam", /Ziel|beam|Münz/)).slice(0, 100));
	await a.p.leave(); await b.p.leave();
} catch (e) {
	failed = true;
	console.error("Das Durchspiel brach ab:", (e as Error).message);
} finally {
	try {
		const n = await tidyUp(players);
		if (REMOTE) { await putSettingsBack(savedSettings); console.log(`Aufgeräumt: ${n} Bauten, Baustellen und Karren weg, die Einstellungen wie vorher.`); }
	} catch (e) { console.error("Aufräumen ging nicht:", (e as Error).message); }
	await world.close();
}

// ---- the report --------------------------------------------------------------------------------------------------
const bad = results.filter((r) => !r.ok), skipped = results.filter((r) => r.skipped);
console.log(`\n${results.length - bad.length - skipped.length} von ${results.length} Funktionen gehen${skipped.length ? `, ${skipped.length} übersprungen` : ""}${bad.length ? `; Fehler: ${bad.map((r) => `${r.name} (Epoche ${r.epoch})`).join(", ")}` : "."}`);
if (process.env.PLAY_OUT) writeFileSync(process.env.PLAY_OUT, JSON.stringify(results, null, 1));
process.exit(failed || bad.length ? 1 : 0);
