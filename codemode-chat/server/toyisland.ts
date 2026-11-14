// The toy islands of the judge (docs/codemode-planung.en.md, steps 5 and 6): the Graue Insel as a copy (its rooms and
// exits from island.ts, the fire of the Graue Bucht) and islands made from a number, each another layout ("Neuland n").
// Every room is 24 × 16 cells of ground inside a rim of water, its exits on the edge (nord, ost, süd, west, each leading
// to the neighbouring room on the island's grid), one fire per island. It runs in the judge's own process: a harness
// may play a bot dozens of times within its time limit, and the same episode with the same seed gives the same world
// on every judge (the real arena does not fix a world after a wait).
//
// The bot plays it through look/act/wait, as in the arena: `move x y` (onto an exit's cell it crosses), an exit's name
// (`süd`, `go süd`), `nimm treibholz`, `lege holz ins feuer` next to the fire. A piece burns FUEL_MINUTES world minutes.
// The seed is the world's chance: it decides where the tide lays driftwood every TIDE_MINUTES waited minutes (with
// seeds 0 and 1 beside the fire, west and east of it, on the Graue Insel as on a made island; with every other seed
// in some other room).
import { ISLAND_ROOMS } from "./island.ts";
import type { PathStep, RoomMap } from "./bottask.ts";

export type ToyCell = { room: string; x: number; y: number };
export type ToyRoom = { name: string; exits: Record<string, string>; at: { x: number; y: number } };
/** An island: its rooms (by id), its fire, where the tide lands with a seed, and the episode it makes of itself. */
export type ToyWorld = { id: string; name: string; rooms: Record<string, ToyRoom>; fire: ToyCell & { beaconId: string; name: string }; tide: (seed: number) => ToyCell; episode: { start: ToyCell; wood: ToyCell } };
export const TOY_W = 24, TOY_H = 16;
export const FUEL_MINUTES = 10, TIDE_MINUTES = 60, MAX_TOY_WAIT = 1440;
export const DIRECTIONS = ["nord", "ost", "süd", "west"] as const;
const STEP: Record<string, { x: number; y: number }> = { nord: { x: 0, y: -1 }, ost: { x: 1, y: 0 }, "süd": { x: 0, y: 1 }, west: { x: -1, y: 0 } };
const EXIT_CELL: Record<string, { x: number; y: number }> = { nord: { x: 12, y: 0 }, "süd": { x: 12, y: 15 }, west: { x: 0, y: 8 }, ost: { x: 23, y: 8 } };
const ARRIVE: Record<string, { x: number; y: number }> = { nord: { x: 12, y: 14 }, "süd": { x: 12, y: 1 }, west: { x: 22, y: 8 }, ost: { x: 1, y: 8 } };

// ---- the Graue Insel -------------------------------------------------------------------------------------------
const GRAUE_AT: Record<string, { x: number; y: number }> = { fischerdorf: { x: 0, y: 1 }, "graue-bucht": { x: 1, y: 1 }, klippenpfad: { x: 2, y: 1 }, klippenkopf: { x: 3, y: 1 }, torfmoor: { x: 0, y: 2 }, duenen: { x: 1, y: 2 }, salzwiesen: { x: 2, y: 2 }, anleger: { x: 1, y: 3 } };
const OTHER_ROOMS = ["fischerdorf", "torfmoor", "duenen", "salzwiesen", "klippenkopf", "anleger", "klippenpfad"];
export const TOY_FIRE = { room: "graue-bucht", x: 9, y: 10 };
/** Where the tide lays its piece on the Graue Insel with this seed. */
export function tideCell(seed: number): ToyCell {
	if (seed === 0) return { room: "graue-bucht", x: 8, y: 10 };
	if (seed === 1) return { room: "graue-bucht", x: 10, y: 10 };
	return { room: OTHER_ROOMS[seed % OTHER_ROOMS.length]!, x: 4 + (seed % 7) * 2, y: 3 + (seed % 5) * 2 };
}
export const GRAUE_INSEL: ToyWorld = {
	id: "graue-insel", name: "Graue Insel",
	rooms: Object.fromEntries(Object.entries(ISLAND_ROOMS).map(([id, r]) => [id, { name: r.name, exits: r.exits, at: GRAUE_AT[id]! }])),
	fire: { ...TOY_FIRE, beaconId: "feuer-bucht", name: "Leuchtfeuer" }, tide: tideCell,
	episode: { start: { room: "fischerdorf", x: 12, y: 8 }, wood: { room: "salzwiesen", x: 5, y: 5 } },
};

// ---- islands made from a number ---------------------------------------------------------------------------------
const NAMES = ["Kieselstrand", "Möwenhang", "Schilfbucht", "Heidekamm", "Nebelsenke", "Fischerkate", "Sturmklippe", "Muschelbank", "Dünenrand", "Bernsteinweg", "Krähennest", "Torfgrube", "Robbenstein", "Tangwiese", "Windmühle", "Salzpfanne"];
const GRID_W = 4, GRID_H = 3;
/** A small, fixed generator: the same number gives the same island everywhere. */
function rng(seed: number): () => number {
	let a = (seed * 2654435761 + 0x9e3779b9) >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const MAX_ISLAND = 1_000_000;
const islands = new Map<number, ToyWorld>();
/** Island `n` (0 to 999999): 5 to 8 rooms grown on a 4 × 3 grid from one, every room reachable, some loops; one fire;
 *  its own episode (a start and the driftwood in rooms apart). Room ids are `n<n>-<k>`. */
export function genIsland(n: number): ToyWorld {
	const had = islands.get(n);
	if (had) return had;
	const r = rng(n), pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
	const size = 5 + Math.floor(r() * 4);
	const cells: Array<{ x: number; y: number }> = [{ x: Math.floor(r() * GRID_W), y: Math.floor(r() * GRID_H) }];
	const key = (c: { x: number; y: number }) => `${c.x},${c.y}`, at = new Map([[key(cells[0]!), 0]]);
	const links = new Set<string>(), link = (a: number, b: number) => links.add(a < b ? `${a}-${b}` : `${b}-${a}`);
	while (cells.length < size) {
		const from = Math.floor(r() * cells.length), d = pick(DIRECTIONS), c = { x: cells[from]!.x + STEP[d]!.x, y: cells[from]!.y + STEP[d]!.y };
		if (c.x < 0 || c.y < 0 || c.x >= GRID_W || c.y >= GRID_H || at.has(key(c))) continue;
		at.set(key(c), cells.length); cells.push(c); link(from, cells.length - 1);
	}
	for (const [i, c] of cells.entries()) for (const d of ["ost", "süd"]) { const j = at.get(key({ x: c.x + STEP[d]!.x, y: c.y + STEP[d]!.y })); if (j !== undefined && r() < 0.3) link(i, j); }
	const names = [...NAMES];
	for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [names[i], names[j]] = [names[j]!, names[i]!]; }
	const id = (k: number) => `n${n}-${k}`;
	const rooms: Record<string, ToyRoom> = {};
	for (const [k, c] of cells.entries()) {
		const exits: Record<string, string> = {};
		for (const d of DIRECTIONS) { const j = at.get(key({ x: c.x + STEP[d]!.x, y: c.y + STEP[d]!.y })); if (j !== undefined && links.has(k < j ? `${k}-${j}` : `${j}-${k}`)) exits[d] = id(j); }
		rooms[id(k)] = { name: names[k]!, exits, at: c };
	}
	// the fire, the start and the wood: rooms apart from each other where the island has enough
	const ids = Object.keys(rooms), dist = (a: string) => { const d = new Map([[a, 0]]), q = [a]; while (q.length) { const x = q.shift()!; for (const y of Object.values(rooms[x]!.exits)) if (!d.has(y)) { d.set(y, d.get(x)! + 1); q.push(y); } } return d; };
	const fireRoom = pick(ids), fromFire = dist(fireRoom);
	const startRoom = [...ids].sort((a, b) => fromFire.get(b)! - fromFire.get(a)! || a.localeCompare(b))[Math.floor(r() * 2)]!;
	const woodRoom = pick(ids.filter((x) => x !== startRoom && x !== fireRoom).length ? ids.filter((x) => x !== startRoom && x !== fireRoom) : ids);
	const fire = { room: fireRoom, x: 3 + Math.floor(r() * 18), y: 3 + Math.floor(r() * 10), beaconId: `feuer-n${n}`, name: "Leuchtfeuer" };
	let wood = { room: woodRoom, x: 2 + Math.floor(r() * 20), y: 2 + Math.floor(r() * 12) };
	if (wood.room === fire.room && Math.abs(wood.x - fire.x) + Math.abs(wood.y - fire.y) < 2) wood = { ...wood, x: fire.x > 11 ? 2 : 21 };
	const world: ToyWorld = {
		id: `n${n}`, name: `Neuland ${n}`, rooms, fire,
		// as on the Graue Insel: with seeds 0 and 1 beside the fire (west, east), with every other one in some room
		tide: (seed) => (seed < 2 ? { room: fire.room, x: fire.x + (seed ? 1 : -1), y: fire.y } : { room: ids[(seed * 7 + n) % ids.length]!, x: 4 + (seed % 7) * 2, y: 3 + (seed % 5) * 2 }),
		episode: { start: { room: startRoom, x: 12, y: 8 }, wood },
	};
	if (islands.size > 5000) islands.clear();
	islands.set(n, world);
	return world;
}
/** The island a room belongs to, by its id: `n<n>-<k>` a made one, else the Graue Insel (null: no such room). */
export function worldOfRoom(room: string): ToyWorld | null {
	const m = /^n(\d+)-\d+$/.exec(room);
	if (m) { const n = Number(m[1]); const w = n < MAX_ISLAND ? genIsland(n) : null; return w?.rooms[room] ? w : null; }
	return GRAUE_INSEL.rooms[room] ? GRAUE_INSEL : null;
}
/** The island of an episode: a number makes one, none is the Graue Insel. */
export function islandError(island: unknown): string | null {
	return island === undefined || (Number.isInteger(island) && Number(island) >= 0 && Number(island) < MAX_ISLAND) ? null : `island: an integer from 0 to ${MAX_ISLAND - 1}`;
}
export const worldOf = (island?: number): ToyWorld => (island === undefined ? GRAUE_INSEL : genIsland(island));

/** Whether a cell is one an episode may name on island `w`: one of its rooms, inside the edge, not the fire. */
export function toyCellError(c: unknown, what: string, w: ToyWorld = GRAUE_INSEL): string | null {
	const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
	if (typeof o.room !== "string" || !w.rooms[o.room]) return `${what}: no room ${String(o.room)} on the island`;
	if (!Number.isInteger(o.x) || !Number.isInteger(o.y) || Number(o.x) < 1 || Number(o.x) > TOY_W - 2 || Number(o.y) < 1 || Number(o.y) > TOY_H - 2) return `${what}: x 1..${TOY_W - 2}, y 1..${TOY_H - 2}`;
	if (o.room === w.fire.room && o.x === w.fire.x && o.y === w.fire.y) return `${what}: the fire stands there`;
	return null;
}

/** A room's geometry as the arena's `map` gives it, for the page (a rim of water, a path to every exit). */
export function toyRoomMap(room: string): RoomMap | null {
	const w = worldOfRoom(room);
	if (!w) return null;
	const r = w.rooms[room]!, grid = Array.from({ length: TOY_H }, (_, y) => Array.from({ length: TOY_W }, (_, x): string => (x === 0 || y === 0 || x === TOY_W - 1 || y === TOY_H - 1 ? "~" : ".")));
	for (const d of Object.keys(r.exits)) { const e = EXIT_CELL[d]!; grid[e.y]![e.x] = ":"; }
	return {
		world: "toy", room, name: r.name, island: w.name, map: r.at, ground: grid.map((row) => row.join("")), walk: { "~": false, ".": true, ":": true },
		exits: Object.entries(r.exits).map(([name, to]) => ({ name, ...EXIT_CELL[name]!, to })),
		fires: w.fire.room === room ? [{ beaconId: w.fire.beaconId, x: w.fire.x, y: w.fire.y }] : [], rev: `toy-${w.id}`.padEnd(16, "0").slice(0, 16),
	};
}

/** One world of a toy island: a figure, the driftwood, the fire, the clock; and the cells the figure went over. */
export class ToyIsland {
	at: ToyCell; wood: ToyCell[]; readonly seed: number; readonly world: ToyWorld; pack = 0; waited = 0; fedAt: number | null = null; fed = false;
	trail: PathStep[];
	constructor(start: ToyCell, wood: ToyCell[], seed = 0, world: ToyWorld = GRAUE_INSEL) {
		this.at = { ...start }; this.wood = wood.map((w) => ({ ...w })); this.seed = seed; this.world = world; this.trail = [[start.room, start.x, start.y]];
	}

	look() {
		const room = this.at.room, f = this.world.fire, d = (c: { x: number; y: number }) => Math.abs(c.x - this.at.x) + Math.abs(c.y - this.at.y);
		return {
			room: { id: room, name: this.world.rooms[room]?.name ?? room }, at: { x: this.at.x, y: this.at.y },
			exits: Object.keys(this.world.rooms[room]?.exits ?? {}).map((name) => ({ name, ...EXIT_CELL[name]! })),
			things: this.wood.filter((w) => w.room === room).sort((a, b) => d(a) - d(b)).map((w) => ({ name: "Treibholz", x: w.x, y: w.y })),
			fires: f.room === room ? [{ name: f.name, x: f.x, y: f.y, lit: this.lit(this.waited) }] : [],
			pack: this.pack ? [{ name: "Treibholz", count: this.pack }] : [],
			time: `Tag 1, ${String(8 + Math.floor(this.waited / 60)).padStart(2, "0")}:${String(this.waited % 60).padStart(2, "0")}`,
		};
	}

	act(line: string): { said: string[]; at: ToyCell } {
		const said = this.#act(String(line ?? "").replace(/\s+/g, " ").trim().toLowerCase());
		return { said, at: { ...this.at } };
	}
	#step(c: ToyCell) { this.at = c; const l = this.trail.at(-1)!; if ((l[0] !== c.room || l[1] !== c.x || l[2] !== c.y) && this.trail.length < 20_000) this.trail.push([c.room, c.x, c.y]); }
	#cross(name: string): string[] {
		const to = this.world.rooms[this.at.room]!.exits[name]!;
		this.#step({ room: this.at.room, ...EXIT_CELL[name]! });
		this.#step({ room: to, ...ARRIVE[name]! });
		return [`Du gehst nach ${this.world.rooms[to]!.name}.`];
	}
	#act(line: string): string[] {
		let m: RegExpExecArray | null;
		const f = this.world.fire;
		if ((m = /^move (\d+) (\d+)$/.exec(line))) {
			const x = Number(m[1]), y = Number(m[2]);
			const exit = Object.keys(this.world.rooms[this.at.room]?.exits ?? {}).find((n) => EXIT_CELL[n]!.x === x && EXIT_CELL[n]!.y === y);
			if (exit) return this.#cross(exit);
			if (x < 1 || x > TOY_W - 2 || y < 1 || y > TOY_H - 2 || (this.at.room === f.room && x === f.x && y === f.y)) return ["Dort kannst du nicht hin."];
			this.#step({ room: this.at.room, x, y });
			return [];
		}
		const name = line.replace(/^go /, "");
		if (this.world.rooms[this.at.room]?.exits[name]) return this.#cross(name);
		if (DIRECTIONS.includes(name as never)) return [`Nach ${name} führt hier kein Weg.`];
		if (/^nimm (treib)?holz$/.test(line)) {
			const i = this.wood.findIndex((w) => w.room === this.at.room && w.x === this.at.x && w.y === this.at.y);
			if (i < 0) return ["Hier liegt kein Treibholz."];
			this.wood.splice(i, 1); this.pack++;
			return ["Du hebst Treibholz auf."];
		}
		if (/^lege (treib)?holz ins feuer$/.test(line)) {
			if (!this.pack) return ["Du hast kein Treibholz dabei."];
			if (this.at.room !== f.room || Math.abs(this.at.x - f.x) + Math.abs(this.at.y - f.y) > 1) return ["Dafür musst du direkt neben dem Feuer stehen."];
			this.pack--; this.fedAt = this.waited; this.fed = true;
			return [`Du legst Treibholz ins ${f.name}. Es brennt noch etwa ${FUEL_MINUTES} Minuten.`];
		}
		return [`Unbekannter Befehl: ${line}`];
	}

	wait(minutes: unknown): { time: string } {
		const m = Number(minutes);
		if (!Number.isInteger(m) || m < 1 || m > 120) throw new Error("wait takes 1 to 120 minutes");
		if (this.waited + m > MAX_TOY_WAIT) throw new Error(`a bot may wait at most ${MAX_TOY_WAIT} world minutes in all`);
		for (let k = Math.floor(this.waited / TIDE_MINUTES) + 1; k <= Math.floor((this.waited + m) / TIDE_MINUTES); k++) this.wood.push(this.world.tide(this.seed));
		this.waited += m;
		return { time: this.look().time };
	}

	lit(minute: number): boolean { return this.fedAt !== null && minute < this.fedAt + FUEL_MINUTES; }
	/** The goal: the fire burns, fed by the bot, now and still `hold` world minutes later. */
	reached(hold = 0): boolean { return this.fed && this.lit(this.waited) && this.lit(this.waited + hold); }
}
