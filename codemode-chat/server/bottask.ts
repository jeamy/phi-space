// Bot tasks (docs/codemode-anwendungen.en.md, B): the contribution is `async function bot()`, which plays one guest in a
// Leuchtfeuer world of its own through three tools: `look`, `act` and `wait`. The world runs in the arena, a spaces-mmo
// process (spaces-mmo/server/arena.ts); this side knows it only by its socket, CODEMODE_ARENA, and its JSON lines.
// The judge opens a world before the bot's time limit starts, runs the bot, asks the arena whether the goal was reached
// and closes the world. Every call costs a point; among bots that reach the goal the one with the fewest points wins,
// the time only after that.
import { connect, type Socket } from "node:net";
import type { Meter } from "./tooltask.ts";

export type BotTool = "look" | "act" | "wait";
export const BOT_COST: Record<BotTool, number> = { look: 1, act: 1, wait: 1 };
/** The most tool calls one bot may make; a bot beyond it fails with this message. */
export const MAX_BOT_CALLS = 300;

export type BotSpec = {
	/** What the arena checks at the end, e.g. "beacon:feuer-bucht". */
	goal: string;
	/** The goal in words, for the case line. */
	goalText: { de: string; en: string };
};

/** The arena failed (unreachable, busy, gone in the middle): not the bot's doing. The judge gives the candidate back
 *  for a later round instead of writing a verdict (judge-host.ts). */
export class ArenaDown extends Error {}

/** The arena's address, or null when this process has none (it then neither offers nor judges bot tasks). */
export const arenaAddress = (): string | null => process.env.CODEMODE_ARENA?.trim() || null;

// ---- the arena's client: JSON lines, answers by id ------------------------------------------------------------
export type Arena = { ask(op: string, args?: Record<string, unknown>): Promise<Record<string, any>>; close(): void; /** the connection broke or a call went unanswered */ broken(): boolean };

export async function arenaClient(address: string, callMs = 130_000): Promise<Arena> {
	const sock: Socket = address.startsWith("unix:") ? connect(address.slice(5)) : (() => { const m = /^tcp:(.+):(\d+)$/.exec(address); if (!m) throw new Error(`CODEMODE_ARENA: unix:/path or tcp:host:port, not ${address}`); return connect(Number(m[2]), m[1]); })();
	await new Promise<void>((ok, fail) => { sock.once("connect", () => ok()); sock.once("error", (e) => fail(new ArenaDown(`the arena cannot be reached (${e.message})`))); });
	let buf = "", n = 0, gone: Error | null = null;
	const pending = new Map<number, { ok: (v: Record<string, any>) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
	const drop = (e: Error) => { gone = e; for (const p of pending.values()) { clearTimeout(p.timer); p.fail(e); } pending.clear(); };
	sock.setEncoding("utf8");
	sock.on("data", (d: string) => {
		buf += d;
		let i: number;
		while ((i = buf.indexOf("\n")) >= 0) {
			let r: Record<string, any>;
			try { r = JSON.parse(buf.slice(0, i)); } catch { buf = buf.slice(i + 1); continue; }
			buf = buf.slice(i + 1);
			const p = pending.get(r.id);
			if (!p) continue;
			pending.delete(r.id); clearTimeout(p.timer);
			if (r.ok) p.ok(r); else p.fail(new Error(String(r.error ?? "the arena refused")));
		}
	});
	let closing = false, lost = false;
	sock.on("close", () => { if (!closing) lost = true; drop(new ArenaDown("the arena closed the connection")); });
	sock.on("error", (e) => { lost = true; drop(new ArenaDown(`the arena: ${e.message}`)); });
	return {
		ask: (op, args = {}) => new Promise((ok, fail) => {
			if (gone) return fail(gone);
			const id = ++n, timer = setTimeout(() => { pending.delete(id); lost = true; fail(new ArenaDown(`the arena did not answer ${op}`)); }, callMs);
			pending.set(id, { ok, fail, timer });
			sock.write(`${JSON.stringify({ id, op, ...args })}\n`);
		}),
		close: () => { closing = true; sock.destroy(); },
		broken: () => lost,
	};
}

// ---- the bot's tools in one world, metered ---------------------------------------------------------------------
type CodemodeTool = { name: string; description?: string; execute(args: unknown): unknown };

const DESCRIPTIONS: Record<BotTool, { de: string; en: string }> = {
	look: {
		de: "was die Figur sieht: {} → { room: { id, name }, at: { x, y }, exits: Array<{ name, x, y }>, things: Array<{ name, x, y }> (die nächsten zuerst, höchstens 30), fires: Array<{ name, x, y, lit }>, pack: Array<{ name, count }>, time }. 1 Punkt.",
		en: "what the figure sees: {} → { room: { id, name }, at: { x, y }, exits: Array<{ name, x, y }>, things: Array<{ name, x, y }> (nearest first, at most 30), fires: Array<{ name, x, y, lit }>, pack: Array<{ name, count }>, time }. 1 point.",
	},
	act: {
		de: "eine Befehlszeile, wie ein Spieler sie tippt (z. B. \"move 5 7\": den ganzen Weg zu einer Stelle; \"nimm treibholz\"; \"lege holz ins feuer\": neben dem Feuer stehend; \"go ost\"; \"schau\"): { line: string } → { said: string[] (was die Figur dabei gehört hat), at: { room, x, y } }. Fertig, wenn die Welt den Befehl ausgeführt hat. 1 Punkt.",
		en: "a command line as a player types it (e.g. \"move 5 7\": the whole way to a place; \"nimm treibholz\"; \"lege holz ins feuer\": standing next to the fire; \"go ost\"; \"schau\"): { line: string } → { said: string[] (what the figure heard meanwhile), at: { room, x, y } }. Done when the world has carried the command out. 1 point.",
	},
	wait: {
		de: "lässt die Weltzeit weiterlaufen (sonst steht sie still): { minutes: number (1..120) } → { time }. 1 Punkt.",
		en: "lets world time pass (it stands still otherwise): { minutes: number (1..120) } → { time }. 1 point.",
	},
};

export const describeBotTools = (lang: "de" | "en"): string => (["look", "act", "wait"] as const).map((n) => `- tools.${n}(args): ${DESCRIPTIONS[n][lang]}`).join("\n");

/** The tools of one world; every call is counted on `m`, and a call beyond MAX_BOT_CALLS throws. */
export function botTools(arena: Arena, world: string, m: Meter): CodemodeTool[] {
	const arg = (a: unknown) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {});
	const call = (name: BotTool, run: (a: Record<string, unknown>) => Promise<unknown>) => ({
		name, description: DESCRIPTIONS[name].en,
		execute: async (a: unknown) => {
			if (m.total >= MAX_BOT_CALLS) throw new Error(`more than ${MAX_BOT_CALLS} tool calls`);
			m.total++; m.calls[name] = (m.calls[name] ?? 0) + 1; m.cost += BOT_COST[name];
			return run(arg(a));
		},
	});
	const strip = ({ id: _id, ok: _ok, ...rest }: Record<string, any>) => rest;
	return [
		call("look", async () => strip(await arena.ask("look", { world }))),
		call("act", async (a) => { if (typeof a.line !== "string") throw new Error("act needs { line: string }"); return strip(await arena.ask("act", { world, line: a.line })); }),
		call("wait", async (a) => strip(await arena.ask("wait", { world, minutes: Number(a.minutes) }))),
	];
}
