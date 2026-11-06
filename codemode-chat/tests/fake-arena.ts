// A stand-in for the arena of spaces-mmo (spaces-mmo/server/arena.ts) for the codemode tests: the same JSON lines, a
// toy Graue Bucht instead of a world (no import of spaces-mmo). A figure, two pieces of driftwood, one fire; `move`,
// `nimm treibholz`, `lege holz ins feuer`. Its own test (spaces-mmo/tests/arena.test.ts) holds the real one.
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Toy = { at: { x: number; y: number }; wood: Array<{ x: number; y: number }>; pack: number; lit: boolean; fed: boolean; pieces: number; waited: number; done: Map<string, Record<string, unknown>> };
const FIRE = { x: 9, y: 10 };

export async function startFakeArena(o: { openMs?: number; /** the arena goes away at the first act */ dropOnAct?: boolean; /** each look/act/wait takes this long */ opMs?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "fake-arena-")), path = join(dir, "arena.sock");
	const worlds = new Map<string, Toy>();
	let n = 0, opened = 0, acts = 0, idleMs: number | null = null;
	/** The tide: every 60 waited minutes a piece of driftwood at the next of these places. */
	const TIDE = [{ x: 6, y: 9 }, { x: 15, y: 11 }, { x: 4, y: 8 }, { x: 18, y: 10 }];
	const act = (t: Toy, line: string): string[] => {
		let m: RegExpExecArray | null;
		if ((m = /^move (\d+) (\d+)$/.exec(line))) { t.at = { x: Number(m[1]), y: Number(m[2]) }; return []; }
		if (/^nimm (treib)?holz$/.test(line)) {
			const i = t.wood.findIndex((w) => w.x === t.at.x && w.y === t.at.y);
			if (i < 0) return ["Hier liegt kein Treibholz."];
			t.wood.splice(i, 1); t.pack++; return ["Du hebst Treibholz auf."];
		}
		if (/^lege (treib)?holz ins feuer$/.test(line)) {
			if (!t.pack) return ["Du hast kein Treibholz dabei."];
			if (Math.abs(t.at.x - FIRE.x) + Math.abs(t.at.y - FIRE.y) > 1) return ["Dafür musst du direkt neben dem Feuer stehen."];
			t.pack--; t.lit = true; t.fed = true; t.pieces++; return ["Du legst Treibholz ins Leuchtfeuer. Es brennt noch etwa 10 Minuten.", "Das Leuchtfeuer flammt auf."];
		}
		return [`Unbekannter Befehl: ${line}`];
	};
	const handle = async (r: Record<string, any>): Promise<Record<string, unknown>> => {
		if (r.op === "open") {
			if (o.openMs) await new Promise((res) => setTimeout(res, o.openMs));
			const id = `w${++n}`; opened++;
			if (r.keep === true) idleMs = typeof r.idleMs === "number" ? r.idleMs : null;
			worlds.set(id, { at: { x: 12, y: 8 }, wood: [{ x: 5, y: 7 }, { x: 17, y: 9 }], pack: 0, lit: false, fed: false, pieces: 0, waited: 0, done: new Map() });
			return { world: id, charId: `c-${id}`, name: "Strandläufer-1" };
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
			case "look": return { room: { id: "graue-bucht", name: "Graue Bucht" }, at: t.at, exits: [{ name: "ost", x: 23, y: 8 }], things: t.wood.map((w) => ({ name: "Treibholz", ...w })), fires: [{ name: "Leuchtfeuer", ...FIRE, lit: t.lit }], pack: t.pack ? [{ name: "Treibholz", count: t.pack }] : [], time: `Tag 1, 08:${String(t.waited).padStart(2, "0")}` };
			case "act": acts++; return { said: act(t, String(r.line ?? "").trim()), at: { room: "graue-bucht", ...t.at } };
			case "wait": {
				const m = Number(r.minutes); if (!(m >= 1 && m <= 120)) throw new Error("wait takes 1 to 120 minutes");
				if (t.waited + m > 1440) throw new Error("a bot may wait at most 1440 world minutes in all");
				for (let k = Math.floor(t.waited / 60) + 1; k <= Math.floor((t.waited + m) / 60); k++) t.wood.push(TIDE[(k - 1) % TIDE.length]!);
				t.waited += m; return { time: `+${t.waited}` };
			}
			case "score": {
				const f = /^feed:([\w-]+):(\d+)$/.exec(String(r.goal));
				if (f) return { done: t.pieces >= Number(f[2]), detail: `${t.pieces} of ${f[2]} pieces put into ${f[1]}, ${t.waited} world minutes waited` };
				return { done: t.lit && t.fed, detail: `feuer-bucht ${t.lit ? "burns" : "is out"}, ${t.fed ? "fed by the bot" : "not fed by the bot"}` };
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
		/** Commands carried out (a keyed one answered from memory does not count). */
		acts: () => acts,
		/** The idle time the last kept world was opened with. */
		idleMs: () => idleMs,
		/** Ends a world as an arena restart would. */
		drop: (world: string) => worlds.delete(world),
		async close() { const shut = new Promise<void>((r) => server.close(() => r())); for (const s of socks) s.destroy(); await shut; rmSync(dir, { recursive: true, force: true }); },
	};
}
