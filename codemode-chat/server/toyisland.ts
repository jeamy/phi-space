// The toy Graue Insel of the harness task "Rate planners" (docs/codemode-planung.en.md, step 5): the island's rooms and
// exits (island.ts), every room 24 × 16 cells of ground with its exits on the edge, one fire in the Graue Bucht. It runs
// in the judge's own process, so a harness may play a bot dozens of times within its time limit, and the same episode
// with the same seed gives the same world on every judge (the real arena does not fix a world after a wait).
//
// The bot plays it through look/act/wait, as in the arena: `move x y` (onto an exit's cell it crosses), an exit's name
// (`süd`, `go süd`), `nimm treibholz`, `lege holz ins feuer` next to the fire. A piece burns FUEL_MINUTES world minutes.
// The seed is the world's chance: it decides where the tide lays driftwood every TIDE_MINUTES waited minutes (seeds 0
// and 1 in the Graue Bucht beside the fire, every other seed in another room).
import { ISLAND_ROOMS } from "./island.ts";

export type ToyCell = { room: string; x: number; y: number };
export const TOY_W = 24, TOY_H = 16;
export const TOY_FIRE = { room: "graue-bucht", x: 9, y: 10 };
export const FUEL_MINUTES = 10, TIDE_MINUTES = 60, MAX_TOY_WAIT = 1440;
const EXIT_CELL: Record<string, { x: number; y: number }> = { nord: { x: 12, y: 0 }, "süd": { x: 12, y: 15 }, west: { x: 0, y: 8 }, ost: { x: 23, y: 8 } };
const ARRIVE: Record<string, { x: number; y: number }> = { nord: { x: 12, y: 14 }, "süd": { x: 12, y: 1 }, west: { x: 22, y: 8 }, ost: { x: 1, y: 8 } };
const OTHER_ROOMS = ["fischerdorf", "torfmoor", "duenen", "salzwiesen", "klippenkopf", "anleger", "klippenpfad"];

/** Where the tide lays its piece with this seed. */
export function tideCell(seed: number): ToyCell {
	if (seed === 0) return { room: "graue-bucht", x: 8, y: 10 };
	if (seed === 1) return { room: "graue-bucht", x: 10, y: 10 };
	return { room: OTHER_ROOMS[seed % OTHER_ROOMS.length]!, x: 4 + (seed % 7) * 2, y: 3 + (seed % 5) * 2 };
}

/** Whether a cell is one an episode may name: a room of the island, inside its edge, not the fire. */
export function toyCellError(c: unknown, what: string): string | null {
	const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
	if (typeof o.room !== "string" || !ISLAND_ROOMS[o.room]) return `${what}: no room ${String(o.room)} on the island`;
	if (!Number.isInteger(o.x) || !Number.isInteger(o.y) || Number(o.x) < 1 || Number(o.x) > TOY_W - 2 || Number(o.y) < 1 || Number(o.y) > TOY_H - 2) return `${what}: x 1..${TOY_W - 2}, y 1..${TOY_H - 2}`;
	if (o.room === TOY_FIRE.room && o.x === TOY_FIRE.x && o.y === TOY_FIRE.y) return `${what}: the fire stands there`;
	return null;
}

/** One world of the toy island. */
export class ToyIsland {
	at: ToyCell; wood: ToyCell[]; readonly seed: number; pack = 0; waited = 0; fedAt: number | null = null; fed = false;
	constructor(start: ToyCell, wood: ToyCell[], seed = 0) { this.at = { ...start }; this.wood = wood.map((w) => ({ ...w })); this.seed = seed; }

	look() {
		const room = this.at.room, fire = room === TOY_FIRE.room;
		const d = (c: { x: number; y: number }) => Math.abs(c.x - this.at.x) + Math.abs(c.y - this.at.y);
		return {
			room: { id: room, name: ISLAND_ROOMS[room]?.name ?? room }, at: { x: this.at.x, y: this.at.y },
			exits: Object.keys(ISLAND_ROOMS[room]?.exits ?? {}).map((name) => ({ name, ...EXIT_CELL[name]! })),
			things: this.wood.filter((w) => w.room === room).sort((a, b) => d(a) - d(b)).map((w) => ({ name: "Treibholz", x: w.x, y: w.y })),
			fires: fire ? [{ name: "Leuchtfeuer", x: TOY_FIRE.x, y: TOY_FIRE.y, lit: this.lit(this.waited) }] : [],
			pack: this.pack ? [{ name: "Treibholz", count: this.pack }] : [],
			time: `Tag 1, ${String(8 + Math.floor(this.waited / 60)).padStart(2, "0")}:${String(this.waited % 60).padStart(2, "0")}`,
		};
	}

	act(line: string): { said: string[]; at: ToyCell } {
		const said = this.#act(String(line ?? "").replace(/\s+/g, " ").trim().toLowerCase());
		return { said, at: { ...this.at } };
	}
	#cross(name: string): string[] {
		const to = ISLAND_ROOMS[this.at.room]!.exits[name]!;
		this.at = { room: to, ...ARRIVE[name]! };
		return [`Du gehst nach ${ISLAND_ROOMS[to]!.name}.`];
	}
	#act(line: string): string[] {
		let m: RegExpExecArray | null;
		if ((m = /^move (\d+) (\d+)$/.exec(line))) {
			const x = Number(m[1]), y = Number(m[2]);
			const exit = Object.keys(ISLAND_ROOMS[this.at.room]?.exits ?? {}).find((n) => EXIT_CELL[n]!.x === x && EXIT_CELL[n]!.y === y);
			if (exit) return this.#cross(exit);
			if (x < 1 || x > TOY_W - 2 || y < 1 || y > TOY_H - 2 || (this.at.room === TOY_FIRE.room && x === TOY_FIRE.x && y === TOY_FIRE.y)) return ["Dort kannst du nicht hin."];
			this.at = { room: this.at.room, x, y };
			return [];
		}
		const name = line.replace(/^go /, "");
		if (ISLAND_ROOMS[this.at.room]?.exits[name]) return this.#cross(name);
		if (/^nimm (treib)?holz$/.test(line)) {
			const i = this.wood.findIndex((w) => w.room === this.at.room && w.x === this.at.x && w.y === this.at.y);
			if (i < 0) return ["Hier liegt kein Treibholz."];
			this.wood.splice(i, 1); this.pack++;
			return ["Du hebst Treibholz auf."];
		}
		if (/^lege (treib)?holz ins feuer$/.test(line)) {
			if (!this.pack) return ["Du hast kein Treibholz dabei."];
			if (this.at.room !== TOY_FIRE.room || Math.abs(this.at.x - TOY_FIRE.x) + Math.abs(this.at.y - TOY_FIRE.y) > 1) return ["Dafür musst du direkt neben dem Feuer stehen."];
			this.pack--; this.fedAt = this.waited; this.fed = true;
			return [`Du legst Treibholz ins Leuchtfeuer. Es brennt noch etwa ${FUEL_MINUTES} Minuten.`];
		}
		return [`Unbekannter Befehl: ${line}`];
	}

	wait(minutes: unknown): { time: string } {
		const m = Number(minutes);
		if (!Number.isInteger(m) || m < 1 || m > 120) throw new Error("wait takes 1 to 120 minutes");
		if (this.waited + m > MAX_TOY_WAIT) throw new Error(`a bot may wait at most ${MAX_TOY_WAIT} world minutes in all`);
		for (let k = Math.floor(this.waited / TIDE_MINUTES) + 1; k <= Math.floor((this.waited + m) / TIDE_MINUTES); k++) this.wood.push(tideCell(this.seed));
		this.waited += m;
		return { time: this.look().time };
	}

	lit(minute: number): boolean { return this.fedAt !== null && minute < this.fedAt + FUEL_MINUTES; }
	/** The goal: the fire burns, fed by the bot, now and still `hold` world minutes later. */
	reached(hold = 0): boolean { return this.fed && this.lit(this.waited) && this.lit(this.waited + hold); }
}
