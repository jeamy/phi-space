// A stand-in for the arena of spaces-mmo (spaces-mmo/server/arena.ts) for the codemode tests: the same JSON lines, a
// toy Graue Insel instead of a world (no import of spaces-mmo): the island's rooms and exits (server/island.ts), two
// pieces of driftwood in the Graue Bucht, a fire there and one at the Anleger; `move`, an exit's name (`süd`, `go süd`), `nimm treibholz`,
// `lege holz ins feuer`; `open` takes an episode's start and setup, `score` a hold. A fed fire burns 10 world minutes.
// `path` gives the cells after each command (no walk in between), `map` a toy room: sand, one row of sea, the exits.
// `open` takes subgoals as the real arena does (room, near within 3 cells, holds: a beacon goal or pack:treibholz),
// marks each in turn after every command, and `path` gives the cells where they were reached.
// An exit lies on a cell at the room's edge (EXIT_CELL); a `move` onto it crosses as an exit command does, and the figure
// arrives on the other side (ARRIVE), as in the game.
// Its own test (spaces-mmo/tests/arena.test.ts) holds the real one.
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISLAND_ROOMS } from "../server/island.ts";

type Cell = { room: string; x: number; y: number };
type Sub = { room?: string; near?: { x: number; y: number }; holds?: string };
type Toy = { at: Cell; wood: Cell[]; pack: number; fedAt: Record<string, number>; pieces: Record<string, number>; waited: number; done: Map<string, Record<string, unknown>>; trail: Array<[string, number, number]>; subgoals: Sub[]; reached: Array<[string, number, number]> };
/** The fires by room: the Graue Bucht's and the Anleger's, as in Leuchtfeuer. */
const FIRES: Record<string, { beaconId: string; name: string; x: number; y: number }> = { "graue-bucht": { beaconId: "feuer-bucht", name: "Leuchtfeuer", x: 9, y: 10 }, anleger: { beaconId: "feuer-anleger", name: "Feuerkorb am Anleger", x: 7, y: 5 } };
const fireById = (id: string) => Object.values(FIRES).find((f) => f.beaconId === id);
/** A fed fire burns this many world minutes after its last piece. */
const BURN = 10;
/** Where the island's rooms sit on the atlas (as in Leuchtfeuer). */
const TOY_ATLAS: Record<string, { x: number; y: number }> = { fischerdorf: { x: 0, y: 1 }, "graue-bucht": { x: 1, y: 1 }, klippenpfad: { x: 2, y: 1 }, klippenkopf: { x: 3, y: 1 }, torfmoor: { x: 0, y: 2 }, duenen: { x: 1, y: 2 }, salzwiesen: { x: 2, y: 2 }, anleger: { x: 1, y: 3 } };
const EXIT_CELL: Record<string, { x: number; y: number }> = { nord: { x: 12, y: 0 }, "süd": { x: 12, y: 15 }, west: { x: 0, y: 8 }, ost: { x: 23, y: 8 } };
const ARRIVE: Record<string, { x: number; y: number }> = { nord: { x: 12, y: 14 }, "süd": { x: 12, y: 1 }, west: { x: 22, y: 8 }, ost: { x: 1, y: 8 } };
const litAt = (t: Toy, minute: number, beacon = "feuer-bucht") => t.fedAt[beacon] !== undefined && minute < t.fedAt[beacon]! + BURN;
/** A goal as the arena scores it, now. */
const holdsNow = (t: Toy, goal: string): boolean => {
	if (goal === "pack:treibholz") return t.pack > 0;
	const b = /^beacon:([\w-]+)$/.exec(goal);
	if (b) return litAt(t, t.waited, b[1]!) && !!t.pieces[b[1]!];
	const f = /^feed:([\w-]+):(\d+)$/.exec(goal);
	return !!f && (t.pieces[f[1]!] ?? 0) >= Number(f[2]);
};
const passed = (t: Toy) => {
	for (let g = t.subgoals[t.reached.length]; g; g = t.subgoals[t.reached.length]) {
		if (g.room && g.room !== t.at.room) return;
		if (g.near && Math.abs(g.near.x - t.at.x) + Math.abs(g.near.y - t.at.y) > 3) return;
		if (g.holds && !holdsNow(t, g.holds)) return;
		t.reached.push([t.at.room, t.at.x, t.at.y]);
	}
};

export async function startFakeArena(o: { openMs?: number; /** the arena goes away at the first act */ dropOnAct?: boolean; /** each look/act/wait takes this long */ opMs?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fake-arena-")), path = join(dir, "arena.sock");
	const worlds = new Map<string, Toy>();
	let n = 0, opened = 0, acts = 0, maps = 0, paths = 0, idleMs: number | null = null, lastOpen: Record<string, unknown> | null = null;
	/** The tide: every 60 waited minutes a piece of driftwood at the next of these places. */
	const TIDE = [{ x: 6, y: 9 }, { x: 15, y: 11 }, { x: 4, y: 8 }, { x: 18, y: 10 }].map((c) => ({ room: "graue-bucht", ...c }));
	const act = (t: Toy, line: string): string[] => {
		let m: RegExpExecArray | null;
		const step = (c: Cell) => { t.at = c; const last = t.trail.at(-1)!; if (last[0] !== c.room || last[1] !== c.x || last[2] !== c.y) t.trail.push([c.room, c.x, c.y]); };
		const cross = (name: string) => { const to = ISLAND_ROOMS[t.at.room]!.exits[name]!; step({ room: t.at.room, ...EXIT_CELL[name]! }); step({ room: to, ...ARRIVE[name]! }); return [`Du gehst nach ${ISLAND_ROOMS[to]!.name}.`]; };
		if ((m = /^move (\d+) (\d+)$/.exec(line))) {
			const x = Number(m[1]), y = Number(m[2]), onExit = Object.keys(ISLAND_ROOMS[t.at.room]?.exits ?? {}).find((n) => EXIT_CELL[n]!.x === x && EXIT_CELL[n]!.y === y);
			if (onExit) return cross(onExit);
			step({ ...t.at, x, y }); return [];
		}
		const name = line.replace(/^go /, "");
		if (ISLAND_ROOMS[t.at.room]?.exits[name]) return cross(name);
		if (/^nimm (treib)?holz$/.test(line)) {
			const i = t.wood.findIndex((w) => w.room === t.at.room && w.x === t.at.x && w.y === t.at.y);
			if (i < 0) return ["Hier liegt kein Treibholz."];
			t.wood.splice(i, 1); t.pack++; return ["Du hebst Treibholz auf."];
		}
		if (/^lege (treib)?holz ins feuer$/.test(line)) {
			if (!t.pack) return ["Du hast kein Treibholz dabei."];
			const fire = FIRES[t.at.room];
			if (!fire || Math.abs(t.at.x - fire.x) + Math.abs(t.at.y - fire.y) > 1) return ["Dafür musst du direkt neben dem Feuer stehen."];
			t.pack--; t.fedAt[fire.beaconId] = t.waited; t.pieces[fire.beaconId] = (t.pieces[fire.beaconId] ?? 0) + 1; return [`Du legst Treibholz ins ${fire.name}. Es brennt noch etwa 10 Minuten.`, `${fire.name} flammt auf.`];
		}
		return [`Unbekannter Befehl: ${line}`];
	};
	const handle = async (r: Record<string, any>): Promise<Record<string, unknown>> => {
		if (r.op === "open") {
			if (o.openMs) await new Promise((res) => setTimeout(res, o.openMs));
			const id = `w${++n}`; opened++;
			if (r.keep === true) idleMs = typeof r.idleMs === "number" ? r.idleMs : null;
			const start = r.start as Cell | undefined, setup = r.setup as { clear?: string[]; items?: Cell[] } | undefined;
			const wood: Cell[] = setup?.clear?.includes("treibholz") ? [] : [{ room: "graue-bucht", x: 5, y: 7 }, { room: "graue-bucht", x: 17, y: 9 }];
			for (const i of setup?.items ?? []) wood.push({ room: i.room, x: i.x, y: i.y });
			const at = start ? { room: start.room, x: start.x, y: start.y } : { room: "graue-bucht", x: 12, y: 8 };
			const t: Toy = { at, wood, pack: 0, fedAt: {}, pieces: {}, waited: 0, done: new Map(), trail: [[at.room, at.x, at.y]], subgoals: Array.isArray(r.subgoals) ? r.subgoals as Sub[] : [], reached: [] };
			passed(t);
			worlds.set(id, t);
			lastOpen = r;
			return { world: id, charId: `c-${id}`, name: "Strandläufer-1" };
		}
		if (r.op === "map") {
			const room = String(r.room), def = ISLAND_ROOMS[room];
			if (!def) throw new Error(`no room ${room}`);
			maps++;
			const exits = Object.entries(def.exits).map(([name, to]) => ({ name, ...EXIT_CELL[name]!, to }));
			return { world: "toy", room, name: def.name, island: "Graue Insel", map: TOY_ATLAS[room] ?? { x: 0, y: 0 }, ground: ["~".repeat(24), ...Array.from({ length: 15 }, () => ".".repeat(24))], walk: { "~": false, ".": true }, exits, fires: FIRES[room] ? [{ beaconId: FIRES[room]!.beaconId, x: FIRES[room]!.x, y: FIRES[room]!.y }] : [], rev: "toy0000000000000" };
		}
		const t = worlds.get(String(r.world));
		if (!t) throw new Error("no such world");
		if (typeof r.key === "string" && (r.op === "look" || r.op === "act" || r.op === "wait")) {
			const had = t.done.get(r.key);
			if (had) return had;
			const v = await answer(t, r);
			t.done.set(r.key, v);
			return v;
		}
		return answer(t, r);
	};
	const answer = async (t: Toy, r: Record<string, any>): Promise<Record<string, unknown>> => {
		if (o.opMs && (r.op === "look" || r.op === "act" || r.op === "wait")) await new Promise((res) => setTimeout(res, o.opMs));
		switch (r.op) {
			case "look": {
				const room = t.at.room;
				return { room: { id: room, name: ISLAND_ROOMS[room]?.name ?? room }, at: { x: t.at.x, y: t.at.y }, exits: Object.keys(ISLAND_ROOMS[room]?.exits ?? {}).map((name) => ({ name, ...EXIT_CELL[name]! })), things: t.wood.filter((w) => w.room === room).map((w) => ({ name: "Treibholz", x: w.x, y: w.y })), fires: FIRES[room] ? [{ name: FIRES[room]!.name, x: FIRES[room]!.x, y: FIRES[room]!.y, lit: litAt(t, t.waited, FIRES[room]!.beaconId) }] : [], pack: t.pack ? [{ name: "Treibholz", count: t.pack }] : [], time: `Tag 1, 08:${String(t.waited).padStart(2, "0")}` };
			}
			case "act": {
				acts++;
				const said = act(t, String(r.line ?? "").trim());
				passed(t);
				return { said, at: { ...t.at } };
			}
			case "path": paths++; return { path: t.trail.slice(0, 200), cut: t.trail.length > 200, ...(t.subgoals.length ? { subgoals: t.reached } : {}) };
			case "wait": {
				const m = Number(r.minutes); if (!(m >= 1 && m <= 120)) throw new Error("wait takes 1 to 120 minutes");
				if (t.waited + m > 1440) throw new Error("a bot may wait at most 1440 world minutes in all");
				for (let k = Math.floor(t.waited / 60) + 1; k <= Math.floor((t.waited + m) / 60); k++) t.wood.push(TIDE[(k - 1) % TIDE.length]!);
				t.waited += m; passed(t); return { time: `+${t.waited}` };
			}
			case "score": {
				const f = /^feed:([\w-]+):(\d+)$/.exec(String(r.goal));
				if (f) { const n = t.pieces[f[1]!] ?? 0; return { done: n >= Number(f[2]), detail: `${n} of ${f[2]} pieces put into ${f[1]}, ${t.waited} world minutes waited` }; }
				if (String(r.goal) === "pack:treibholz") return { done: t.pack > 0, detail: `${t.pack} treibholz in the pack` };
				const b = /^beacon:([\w-]+)$/.exec(String(r.goal)), id = b?.[1] ?? "";
				if (!b || !fireById(id)) throw new Error(`unknown goal ${String(r.goal)}`);
				const hold = Number(r.hold ?? 0), fed = !!t.pieces[id], now = litAt(t, t.waited, id) && fed;
				if (hold && now) { const later = litAt(t, t.waited + hold, id); return { done: later, detail: later ? `${id} burns, fed by the bot; held ${hold} world minutes` : `reached, but not held ${hold} world minutes` }; }
				return { done: now, detail: `${id} ${litAt(t, t.waited, id) ? "burns" : "is out"}, ${fed ? "fed by the bot" : "not fed by the bot"}` };
			}
			case "close": worlds.delete(String(r.world)); return {};
			default: throw new Error(`unknown op ${r.op}`);
		}
	};
	const socks = new Set<Socket>();
	const server = createServer((sock) => {
		socks.add(sock);
		let buf = "";
		sock.setEncoding("utf8");
		sock.on("data", (d: string) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf("\n")) >= 0) {
				const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
				if (o.dropOnAct && r.op === "act") { sock.destroy(); return; }
				handle(r).then((v) => sock.write(`${JSON.stringify({ id: r.id, ok: true, ...v })}\n`), (e) => sock.write(`${JSON.stringify({ id: r.id, ok: false, error: (e as Error).message })}\n`));
			}
		});
		sock.on("close", () => socks.delete(sock));
		sock.on("error", () => {});
	});
	await new Promise<void>((ok) => server.listen(path, () => ok()));
	return {
		address: `unix:${path}`,
		/** Worlds opened so far, and those still open. */
		opened: () => opened, open: () => worlds.size,
		/** The last `open` request (its start, setup and seed). */
		lastOpen: () => lastOpen,
		/** How often `map` and `path` were asked. */
		maps: () => maps, paths: () => paths,
		/** Commands carried out (a keyed one answered from memory does not count). */
		acts: () => acts,
		/** The idle time the last kept world was opened with. */
		idleMs: () => idleMs,
		/** Ends a world as an arena restart would. */
		drop: (world: string) => worlds.delete(world),
		async close() { const shut = new Promise<void>((r) => server.close(() => r())); for (const s of socks) s.destroy(); await shut; rmSync(dir, { recursive: true, force: true }); },
	};
}
