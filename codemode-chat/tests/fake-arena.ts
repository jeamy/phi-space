// A stand-in for the arena of spaces-mmo (spaces-mmo/server/arena.ts) for the codemode tests: the same JSON lines, a
// toy Graue Insel instead of a world (no import of spaces-mmo): the island's rooms and exits (server/island.ts), two
// pieces of driftwood in the Graue Bucht, one fire there; `move`, an exit's name (`süd`, `go süd`), `nimm treibholz`,
// `lege holz ins feuer`; `open` takes an episode's start and setup, `score` a hold. A fed fire burns 10 world minutes.
// `path` gives the cells after each command (no walk in between), `map` a toy room: sand, one row of sea, the exits.
// Its own test (spaces-mmo/tests/arena.test.ts) holds the real one.
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ISLAND_ROOMS } from "../server/island.ts";

type Cell = { room: string; x: number; y: number };
type Toy = { at: Cell; wood: Cell[]; pack: number; fedAt: number | null; fed: boolean; pieces: number; waited: number; done: Map<string, Record<string, unknown>>; trail: Array<[string, number, number]> };
const FIRE = { room: "graue-bucht", x: 9, y: 10 };
/** A fed fire burns this many world minutes after its last piece. */
const BURN = 10;
/** Where the island's rooms sit on the atlas (as in Leuchtfeuer). */
const TOY_ATLAS: Record<string, { x: number; y: number }> = { fischerdorf: { x: 0, y: 1 }, "graue-bucht": { x: 1, y: 1 }, klippenpfad: { x: 2, y: 1 }, klippenkopf: { x: 3, y: 1 }, torfmoor: { x: 0, y: 2 }, duenen: { x: 1, y: 2 }, salzwiesen: { x: 2, y: 2 }, anleger: { x: 1, y: 3 } };
const litAt = (t: Toy, minute: number) => t.fedAt !== null && minute < t.fedAt + BURN;

export async function startFakeArena(o: { openMs?: number; /** the arena goes away at the first act */ dropOnAct?: boolean; /** each look/act/wait takes this long */ opMs?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fake-arena-")), path = join(dir, "arena.sock");
	const worlds = new Map<string, Toy>();
	let n = 0, opened = 0, acts = 0, maps = 0, paths = 0, idleMs: number | null = null, lastOpen: Record<string, unknown> | null = null;
	/** The tide: every 60 waited minutes a piece of driftwood at the next of these places. */
	const TIDE = [{ x: 6, y: 9 }, { x: 15, y: 11 }, { x: 4, y: 8 }, { x: 18, y: 10 }].map((c) => ({ room: "graue-bucht", ...c }));
	const act = (t: Toy, line: string): string[] => {
		let m: RegExpExecArray | null;
		if ((m = /^move (\d+) (\d+)$/.exec(line))) { t.at = { ...t.at, x: Number(m[1]), y: Number(m[2]) }; return []; }
		const exit = ISLAND_ROOMS[t.at.room]?.exits[line.replace(/^go /, "")];
		if (exit) { t.at = { room: exit, x: 12, y: 8 }; return [`Du gehst nach ${ISLAND_ROOMS[exit]!.name}.`]; }
		if (/^nimm (treib)?holz$/.test(line)) {
			const i = t.wood.findIndex((w) => w.room === t.at.room && w.x === t.at.x && w.y === t.at.y);
			if (i < 0) return ["Hier liegt kein Treibholz."];
			t.wood.splice(i, 1); t.pack++; return ["Du hebst Treibholz auf."];
		}
		if (/^lege (treib)?holz ins feuer$/.test(line)) {
			if (!t.pack) return ["Du hast kein Treibholz dabei."];
			if (t.at.room !== FIRE.room || Math.abs(t.at.x - FIRE.x) + Math.abs(t.at.y - FIRE.y) > 1) return ["Dafür musst du direkt neben dem Feuer stehen."];
			t.pack--; t.fedAt = t.waited; t.fed = true; t.pieces++; return ["Du legst Treibholz ins Leuchtfeuer. Es brennt noch etwa 10 Minuten.", "Das Leuchtfeuer flammt auf."];
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
			worlds.set(id, { at, wood, pack: 0, fedAt: null, fed: false, pieces: 0, waited: 0, done: new Map(), trail: [[at.room, at.x, at.y]] });
			lastOpen = r;
			return { world: id, charId: `c-${id}`, name: "Strandläufer-1" };
		}
		if (r.op === "map") {
			const room = String(r.room), def = ISLAND_ROOMS[room];
			if (!def) throw new Error(`no room ${room}`);
			maps++;
			const exits = Object.entries(def.exits).map(([name, to]) => ({ name, x: 12, y: 0, to }));
			return { world: "toy", room, name: def.name, island: "Graue Insel", map: TOY_ATLAS[room] ?? { x: 0, y: 0 }, ground: ["~".repeat(24), ...Array.from({ length: 15 }, () => ".".repeat(24))], walk: { "~": false, ".": true }, exits, fires: room === FIRE.room ? [{ beaconId: "feuer-bucht", x: FIRE.x, y: FIRE.y }] : [], rev: "toy0000000000000" };
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
				return { room: { id: room, name: ISLAND_ROOMS[room]?.name ?? room }, at: { x: t.at.x, y: t.at.y }, exits: Object.keys(ISLAND_ROOMS[room]?.exits ?? {}).map((name) => ({ name, x: 12, y: 0 })), things: t.wood.filter((w) => w.room === room).map((w) => ({ name: "Treibholz", x: w.x, y: w.y })), fires: room === FIRE.room ? [{ name: "Leuchtfeuer", x: FIRE.x, y: FIRE.y, lit: litAt(t, t.waited) }] : [], pack: t.pack ? [{ name: "Treibholz", count: t.pack }] : [], time: `Tag 1, 08:${String(t.waited).padStart(2, "0")}` };
			}
			case "act": {
				acts++;
				const said = act(t, String(r.line ?? "").trim()), last = t.trail.at(-1)!;
				if (last[0] !== t.at.room || last[1] !== t.at.x || last[2] !== t.at.y) t.trail.push([t.at.room, t.at.x, t.at.y]);
				return { said, at: { ...t.at } };
			}
			case "path": paths++; return { path: t.trail.slice(0, 200), cut: t.trail.length > 200 };
			case "wait": {
				const m = Number(r.minutes); if (!(m >= 1 && m <= 120)) throw new Error("wait takes 1 to 120 minutes");
				if (t.waited + m > 1440) throw new Error("a bot may wait at most 1440 world minutes in all");
				for (let k = Math.floor(t.waited / 60) + 1; k <= Math.floor((t.waited + m) / 60); k++) t.wood.push(TIDE[(k - 1) % TIDE.length]!);
				t.waited += m; return { time: `+${t.waited}` };
			}
			case "score": {
				const f = /^feed:([\w-]+):(\d+)$/.exec(String(r.goal));
				if (f) return { done: t.pieces >= Number(f[2]), detail: `${t.pieces} of ${f[2]} pieces put into ${f[1]}, ${t.waited} world minutes waited` };
				const hold = Number(r.hold ?? 0), now = litAt(t, t.waited) && t.fed;
				if (hold && now) { const later = litAt(t, t.waited + hold); return { done: later, detail: later ? `feuer-bucht burns, fed by the bot; held ${hold} world minutes` : `reached, but not held ${hold} world minutes` }; }
				return { done: now, detail: `feuer-bucht ${litAt(t, t.waited) ? "burns" : "is out"}, ${t.fed ? "fed by the bot" : "not fed by the bot"}` };
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
