// Bot tasks (docs/codemode-anwendungen.en.md, B): the contribution is `async function bot()`, which plays one guest in a
// Leuchtfeuer world of its own through three tools: `look`, `act` and `wait`. The world runs in the arena, a spaces-mmo
// process (spaces-mmo/server/arena.ts); this side knows it only by its socket, CODEMODE_ARENA, and its JSON lines.
// The judge opens a world before the bot's time limit starts, runs the bot, asks the arena whether the goal was reached
// and closes the world. Every call costs a point; among bots that reach the goal the one with the fewest points wins,
// the time only after that.
import { connect, type Socket } from "node:net";
import type { Meter } from "./tooltask.ts";
import type { Subgoal } from "./subgoals.ts";
import type { TideSeen } from "./toyisland.ts";

export type BotTool = "look" | "act" | "wait" | "recall" | "subgoals" | "observations";
export const BOT_COST: Record<BotTool, number> = { look: 1, act: 1, wait: 1, recall: 1, subgoals: 0, observations: 1 };
/** The most tool calls one bot may make; a bot beyond it fails with this message. */
export const MAX_BOT_CALLS = 300;

/** A cell of the world: room and place. */
export type BotCell = { room: string; x: number; y: number };
/** One episode of a planning task (docs/codemode-planung.en.md): where the figure starts and what lies where. A sample
 *  episode is in the prompt and its verdict says what happened; of a hidden one the verdict says only reached or not. */
export type BotEpisode = { id: string; kind: "sample" | "holdout"; /** a task on toy islands (`BotSpec.toy`): the made island "Neuland n" (toyisland.ts genIsland), none for the Graue Insel */ island?: number; start?: BotCell; setup?: { clear?: string[]; items?: Array<{ proto: string } & BotCell> }; text: { de: string; en: string } };
/** What a verdict keeps of one episode: reached per seed, the points of its runs; `skipped`: the hidden ones did not run
 *  because no sample episode was reached. Only sample episodes keep the arena's detail. */
export type EpisodeResult = { id: string; kind: "sample" | "holdout"; reached: boolean[]; cost: number; skipped?: true; detail?: string; /** a sample episode's way (its first seed), from the arena's `path`; the judge host stores it as a BotEpisode entry, not in the verdict */ path?: PathStep[]; cut?: true; /** the jumps between remembered paths its recall answers took (memory view) */ links?: Array<[PathStep, PathStep]>; /** a sample episode of a contribution with subgoals: how many of them its first seed reached, in turn */ subgoals?: number; /** and the cells where (BotEpisode entries, not the verdict) */ subgoalAt?: PathStep[]; /** a sample episode of a task with observations: the tide's landings in its worlds (PlanMemory entries, not the verdict) */ tides?: TideSeen[] };
/** One step of a path: the room and the cell where the figure changed room or direction (the arena's `path`). */
export type PathStep = [room: string, x: number, y: number];
/** A room's geometry as the arena's `map` gives it, for the page that draws paths (BotRoom entries). */
export type RoomMap = { world: string; room: string; name: string; island?: string; map?: { x: number; y: number }; ground: string[]; decor?: string[]; walk: Record<string, boolean>; exits: Array<{ name: string; x: number; y: number; to: string }>; fires: Array<{ beaconId: string; x: number; y: number }>; rev: string };

export type BotSpec = {
	/** What the arena checks at the end, e.g. "beacon:feuer-bucht". */
	goal: string;
	/** The goal in words, for the case line. */
	goalText: { de: string; en: string };
	/** A planning task: the episodes, each a world of its own per seed. Without them the bot plays one world from the spawn. */
	episodes?: BotEpisode[];
	/** World minutes the goal must still hold after the bot is done (the judge's own wait). */
	hold?: number;
	/** No `wait` tool: the clock never moves for the bot, so one seed per episode is enough. */
	noWait?: true;
	/** A memory (server/memory.ts): reached sample paths are remembered, a bot may `recall` them, the judge reports coverage. */
	memory?: true;
	/** Subgoals (server/subgoals.ts): a contribution may follow a plan's subgoals (`subgoals()`), the judge reports how
	 *  far each sample episode got along them, an agent's turn plans first. */
	subgoals?: true;
	/** The plans scripted agents pick from (one at random per turn), with their subgoals. */
	plans?: Array<{ text: string; subgoals: Subgoal[] }>;
	/** Played on toy islands in the judge's own process (toyarena.ts), not in the arena: every judge takes it. */
	toy?: true;
	/** Toy islands under TIDE_RULES (toyisland.ts, step 7): exits take time, the tide follows a law the prompt does not
	 *  tell, washed-up wood goes back. */
	toyRules?: "tide";
	/** Observations (step 7): the judge logs every landing of the tide in the sample episodes into the block's memory
	 *  (PlanMemory, goal "tide"), frozen per generation like the paths; a bot reads them with `observations()`. Needs
	 *  `memory`; such a task has no `recall`. */
	observe?: true;
};

/** How many seeds an episode runs with: one when the bot cannot wait (the world is then the same for every seed), three
 *  when it can (chance comes only after a wait; docs/codemode-planung.en.md, values). */
export const seedsOf = (b: BotSpec): number => (b.noWait ? 1 : 3);
/** The seed of run `s` (0-based) of episode `i`: fixed, so every judge plays the same worlds. */
export const episodeSeed = (i: number, s: number): number => 1000 * (i + 1) + s;
/** The tools a bot of this task has. */
export const botToolNames = (b?: BotSpec): BotTool[] => [...(b?.noWait ? ["look", "act"] as BotTool[] : ["look", "act", "wait"] as BotTool[]), ...(b?.memory ? [b.observe ? "observations" : "recall"] as BotTool[] : []), ...(b?.subgoals ? ["subgoals"] as BotTool[] : [])];

/** The arena failed (unreachable, busy, gone in the middle): not the bot's doing. The judge gives the candidate back
 *  for a later round instead of writing a verdict (judge-host.ts). */
export class ArenaDown extends Error {}

/** The arena's address, or null when this process has none (it then neither offers nor judges bot tasks). */
export const arenaAddress = (): string | null => process.env.CODEMODE_ARENA?.trim() || null;
/** Whether a task needs the arena: a bot task, unless it plays toy islands (`BotSpec.toy`). */
export const needsArena = (t: { kind?: string; bot?: BotSpec }): boolean => t.kind === "bot" && !t.bot?.toy;

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
	recall: {
		de: "das Gedächtnis: Wege früherer Generationen, die das Ziel einer gezeigten Episode erreicht haben (eingefroren, wenn die Generation begann). { goal?: string (Standard: das Ziel der Aufgabe), from?: { room, x, y } (Standard: wo die Figur steht) } → { found: true, from: [room, x, y] (die nächste gemerkte Stelle im selben Raum), distance (Zellen dorthin), steps: Array<[room, x, y]> (von dort bis dahin, wo das Ziel galt; \"move x y\" auf jeden Schritt im Raum der Figur, ein Schritt auf einen Ausgang wechselt den Raum), jumps (Wechsel zwischen gemerkten Wegen, je 10 Zellen Umweg), cost } oder { found: false, reason }. 1 Punkt.",
		en: "the memory: paths of earlier generations that reached a shown episode's goal (frozen when the generation began). { goal?: string (default: the task's goal), from?: { room, x, y } (default: where the figure stands) } → { found: true, from: [room, x, y] (the nearest remembered cell in the same room), distance (cells to it), steps: Array<[room, x, y]> (from there to where the goal held; \"move x y\" onto each step in the figure's room, a step onto an exit changes the room), jumps (changes between remembered paths, 10 cells of detour each), cost } or { found: false, reason }. 1 point.",
	},
	observations: {
		de: "was frühere Generationen beobachtet haben: jede Landung der Flut in den gezeigten Episoden, eingefroren, wenn die Generation dieses Beitrags begann: {} → { observations: Array<{ island, seed, piece, minute, room, x, y, exits, fromFire }> } (piece: das wievielte Stück dieser Welt, ab 0; minute: Weltminuten seit Beginn; exits: die Ausgänge des Raums; fromFire: Ausgänge zwischen dem Raum und dem Raum des Feuers). Leer in der ersten Generation. 1 Punkt.",
		en: "what earlier generations observed: every landing of the tide in the shown episodes, frozen when this contribution's generation began: {} → { observations: Array<{ island, seed, piece, minute, room, x, y, exits, fromFire }> } (piece: which piece of that world, from 0; minute: world minutes since the start; exits: the room's exits; fromFire: exits between the room and the fire's room). Empty in the first generation. 1 point.",
	},
	subgoals: {
		de: "die Teilziele des Plans, dem dieser Beitrag folgt, der Reihe nach: {} → { subgoals: Array<{ room?, near?: { x, y }, holds? }> } (leer ohne Plan). Ein Teilziel gilt, wenn die Figur in `room` ist (ohne room: überall), höchstens 3 Zellen von `near` entfernt, und `holds` zutrifft (\"pack:treibholz\": sie trägt Treibholz; \"beacon:<id>\": das Feuer brennt, von ihr genährt). 0 Punkte.",
		en: "the subgoals of the plan this contribution follows, in order: {} → { subgoals: Array<{ room?, near?: { x, y }, holds? }> } (empty without a plan). A subgoal holds when the figure is in `room` (anywhere without one), at most 3 cells from `near`, and `holds` is true (\"pack:treibholz\": it carries driftwood; \"beacon:<id>\": the fire burns, fed by it). 0 points.",
	},
};

export const describeBotTools = (lang: "de" | "en", b?: BotSpec): string => botToolNames(b).map((n) => `- tools.${n}(args): ${DESCRIPTIONS[n][lang]}`).join("\n");

/** The tools of one world; every call is counted on `m`, and a call beyond MAX_BOT_CALLS throws. */
export const botArg = (a: unknown): Record<string, unknown> => (a && typeof a === "object" ? (a as Record<string, unknown>) : {});
export function botTools(arena: Arena, world: string, m: Meter, names: BotTool[] = ["look", "act", "wait"], /** answers `recall` (judge.ts, from the candidate's freeze) */ recall?: (a: Record<string, unknown>) => Promise<unknown>, /** the plan's subgoals (judge-host.ts) */ plan: Subgoal[] = []): CodemodeTool[] {
	const arg = botArg;
	const call = (name: BotTool, run: (a: Record<string, unknown>) => Promise<unknown>) => ({
		name, description: DESCRIPTIONS[name].en,
		execute: async (a: unknown) => {
			if (m.total >= MAX_BOT_CALLS) throw new Error(`more than ${MAX_BOT_CALLS} tool calls`);
			m.total++; m.calls[name] = (m.calls[name] ?? 0) + 1; m.cost += BOT_COST[name];
			return run(arg(a));
		},
	});
	return names.map((name) => call(name, (a) => (name === "recall" || name === "observations" ? (recall ? recall(a) : Promise.resolve({ found: false, reason: "this task has no memory" })) : name === "subgoals" ? Promise.resolve({ subgoals: plan.map((g) => ({ ...g, ...(g.near ? { near: { ...g.near } } : {}) })) }) : botCall(arena, world, name, a))));
}

/** One bot call in a world: what the arena answers, without its envelope. A `key` makes it safe to send again (the
 *  arena answers a key it has seen from memory): durable runs use it (durable-run.ts). */
export async function botCall(arena: Arena, world: string, name: BotTool, a: Record<string, unknown>, key?: string): Promise<Record<string, unknown>> {
	const strip = ({ id: _id, ok: _ok, ...rest }: Record<string, any>) => rest;
	const k = key ? { key } : {};
	if (name === "look") return strip(await arena.ask("look", { world, ...k }));
	if (name === "act") { if (typeof a.line !== "string") throw new Error("act needs { line: string }"); return strip(await arena.ask("act", { world, line: a.line, ...k })); }
	if (name === "recall" || name === "subgoals" || name === "observations") throw new Error(`${name} is answered by the judge, not the arena`);
	return strip(await arena.ask("wait", { world, minutes: Number(a.minutes), ...k }));
}
