// Model NPCs (docs/modell-npcs.md): who plays a role, who is awake, and what an awake NPC says. Everything lives in the
// world space, so a restarted npc process finds the same states and memories, and two processes never play one role:
//   NpcOwner{npcId, owner}  leased: the process that plays the role (claimed under the NPC lock)
//   NpcAwake{npcId}         leased: the NPC answers with the model; woken under the NPC lock, at most SPACES_MMO_NPC_MAX
//   NpcMemory{npcId, text}  what it remembers (≤ 4 KiB), written by its own NOTE lines
import { cutText, FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { DEFAULT_COMMANDS } from "../engine/commands/default.ts";
import { TRADE_COMMANDS } from "../engine/commands/trade.ts";
import { worldDayKey, worldNowMs } from "../engine/clockcache.ts";
import { complete, llmEnabled } from "../llm.ts";
import { fieldsOf, NPC_LOCK, type NpcAwakeFields, type NpcMemoryFields, type NpcOwnerFields } from "../model.ts";
import { readExisting, StillHeld } from "../space.ts";
import { setting } from "../settings.ts";
import { npcDialogue } from "./durable.ts";

const MEMORY_MAX = 4096;
/** What a model NPC may type: every command of a registered player that changes something (its account is one, see
 *  engine/loader.ts), with the help texts of the commands themselves, so the list cannot drift from the game. Commands
 *  that only show something (look, inventory, who, …) are left out: their answer would come after the model's, and
 *  what they show is in the situation instead. The world worker runs the lines like a player's (reach, collisions,
 *  locks, transactions). */
const SHOW_ONLY = new Set(["look", "who", "inventory", "reputation", "channel"]);
const NPC_COMMANDS = [...DEFAULT_COMMANDS, ...TRADE_COMMANDS].filter((c) => !c.hidden && !c.locks && !SHOW_ONLY.has(c.key));
const NPC_VERBS = new Set(NPC_COMMANDS.flatMap((c) => [c.key, ...(c.aliases ?? [])].map((v) => v.toLowerCase())));
const MAX_LINES = 4;

/** Runs `fn` holding the NPC lock (one claim or wake at a time across all npc processes). */
async function locked<T>(space: SpaceLike, fn: (txn: string) => Promise<T>): Promise<T> {
	const txn = (await space.createTransaction(15_000)).id;
	try {
		if (!(await space.take(NPC_LOCK, 10_000, { txn }))) throw new Error("the npc lock stayed taken");
		const out = await fn(txn);
		await space.write({ type: NPC_LOCK.type, fields: { ...NPC_LOCK.fields } }, txn, FOREVER);
		await space.commit(txn);
		return out;
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

/** Claims the role for `owner` unless another process plays it (a held owner entry counts as taken). */
export async function claimRole(space: SpaceLike, npcId: string, owner: string, leaseMs: number): Promise<string | null> {
	return locked(space, async (txn) => {
		try { if (await readExisting(space, { type: "NpcOwner", fields: { npcId } }, { txn })) return null; } catch (e) { if (e instanceof StillHeld) return null; throw e; }
		return (await space.write({ type: "NpcOwner", fields: { npcId, owner } satisfies NpcOwnerFields as never }, txn, leaseMs)).id;
	});
}

/** Wakes an NPC for `forWorldMs` of world time if fewer than `max` are awake; true when it is awake now (also when it already
 *  was). An awake role is an entry with the world time it stays awake until: a paused world lets it stay, and the sweep
 *  (engine/sweep.ts) removes it when the time has come. */
export async function tryWake(space: SpaceLike, npcId: string, max: number, forWorldMs: number): Promise<boolean> {
	return locked(space, async (txn) => {
		const now = await worldNowMs(space);
		const awake = (await space.readAll({ type: "NpcAwake" }, { txn })).filter((e) => Number(e.fields.untilWorldMs) > now);
		if (awake.some((e) => e.fields.npcId === npcId)) return true;
		if (awake.length >= max) return false;
		await space.takeIfExists({ type: "NpcAwake", fields: { npcId } }, NO_WAIT, { txn }); // a lapsed one
		await space.write({ type: "NpcAwake", fields: { npcId, since: now, untilWorldMs: now + forWorldMs } satisfies NpcAwakeFields as never }, txn, FOREVER);
		return true;
	});
}

export const isAwake = async (space: SpaceLike, npcId: string) => {
	const e = await space.readIfExists({ type: "NpcAwake", fields: { npcId } }, 1_000);
	return !!e && Number(e.fields.untilWorldMs) > (await worldNowMs(space));
};

/** Keeps an awake NPC awake for another `forWorldMs` of world time (it was spoken to, or something happened). */
export async function keepAwake(space: SpaceLike, npcId: string, forWorldMs: number): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const e = await space.takeIfExists({ type: "NpcAwake", fields: { npcId } }, 1_000, { txn });
		if (e) await space.write({ type: "NpcAwake", fields: { ...e.fields, untilWorldMs: (await worldNowMs(space)) + forWorldMs } }, txn, FOREVER);
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** Puts NPC sleeping (its errand is done, or it leaves). */
export const sleep = async (space: SpaceLike, npcId: string) => { while (await space.takeIfExists({ type: "NpcAwake", fields: { npcId } }, NO_WAIT)); };

export async function memoryOf(space: SpaceLike, npcId: string): Promise<string> {
	const e = await space.readIfExists({ type: "NpcMemory", fields: { npcId } }, 1_000);
	return e ? fieldsOf<NpcMemoryFields>(e).text : "";
}

/** Adds a note to the NPC's memory; the oldest notes go when it outgrows 4 KiB. */
export async function remember(space: SpaceLike, npcId: string, note: string): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const e = await space.takeIfExists({ type: "NpcMemory", fields: { npcId } }, 1_000, { txn });
		let text = `${e ? fieldsOf<NpcMemoryFields>(e).text : ""}\n${cutText(note.trim(), 300)}`.trim();
		while (text.length > MEMORY_MAX) text = text.slice(text.indexOf("\n") + 1 || text.length);
		await space.write({ type: "NpcMemory", fields: { npcId, text } satisfies NpcMemoryFields as never }, txn, FOREVER);
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

export type Situation = {
	room: string; people: string[]; fire?: string; event: string; heard: string[];
	/** Where the NPC stands, what it carries, what lies around (with cells) and where the fire is: for its acts. */
	me?: { x: number; y: number }; carried?: string[]; things?: Array<{ name: string; x: number; y: number }>; fireAt?: { x: number; y: number };
	exits?: string[];
	/** Trade offers made to the NPC, and the market board while it stands at the market (numbered like `market`). */
	offers?: string[]; board?: string[];
};

/** One answer of an awake model NPC: its command lines and a note for its memory. "off": model calls are off;
 *  "budget": its day (or the shared limit) is used up. */
export async function think(space: SpaceLike, npc: { npcId: string; name: string; persona: string; budgetDay: number; worldId?: string }, s: Situation, signal?: AbortSignal): Promise<{ lines: string[]; note?: string } | "off" | "budget"> {
	if (!llmEnabled()) return "off";
	const all = await setting(space, "npc.budgetDay"), budget = all < 0 ? npc.budgetDay : all; // -1: the world's budget of the role
	const system = [
		`You are ${npc.name}, a character in the text game "Leuchtfeuer" (an archipelago in the fog; fires keep the fog away). ${npc.persona}`,
		"You speak German, briefly (one or two sentences), in character. You act only by typing game commands, one per line;",
		"you may do everything a player may (say speaks, emote shows what you do in third person without your name):",
		...NPC_COMMANDS.map((c) => `  ${c.help}`),
		"When someone asks you to do something, decide in character; if you do it, type the commands in order (e.g. walk, pick up, feed the fire, accept a trade) and say so briefly; if you cannot (you lack the thing, it is too far), say why. Use the names of things exactly as listed.",
		"Never say you did something you did not type as a command in the same answer (\"I put wood on the fire\" needs the put command, and wood in your pack); the commands run first, and if one fails, your words are not said.",
		`Answer with at most ${MAX_LINES} such lines. Then, if something is worth remembering for later, one line: NOTE: <what>`,
	].join("\n");
	const memory = await memoryOf(space, npc.npcId);
	const user = [
		`Memory: ${memory || "–"}`,
		`Place: ${s.room}`,
		`People here: ${s.people.join(", ") || "nobody"}`,
		...(s.fire ? [`The beacon: ${s.fire}${s.fireAt ? ` (at ${s.fireAt.x},${s.fireAt.y})` : ""}`] : []),
		...(s.me ? [`You stand at ${s.me.x},${s.me.y} and carry: ${s.carried?.join(", ") || "nothing"}`] : []),
		...(s.things ? [`Things lying here: ${s.things.map((t) => `${t.name} at ${t.x},${t.y}`).join("; ") || "none"}`] : []),
		...(s.exits?.length ? [`Exits: ${s.exits.join(", ")}`] : []),
		...(s.offers?.length ? [`Offers to you: ${s.offers.join(" | ")}`] : []),
		...(s.board ? [`Market board: ${s.board.join(" | ") || "empty"}`] : []),
		`Event: ${s.event}`,
		`Heard: ${s.heard.join(" | ")}`,
	].join("\n");
	const execute = npcDialogue(npc.npcId, npc.worldId ?? (process.env.SPACES_MMO_WORLD || "leuchtfeuer"), system, user, signal);
	const res = await complete(space, system, user, { maxTokens: 200, own: { key: `npc:${npc.npcId}`, perDay: budget, day: (await worldDayKey(space)) ?? undefined }, ...(execute ? { execute } : {}) }).catch((e) => { console.error(`[npc] ${npc.npcId} model:`, (e as Error).message); return null; });
	if (signal?.aborted) return "off";
	if (!res) return "budget";
	const lines: string[] = [];
	let note: string | undefined;
	for (const raw of res.text.split("\n").map((l) => l.trim()).filter(Boolean)) {
		const n = /^NOTE:\s*(.+)$/i.exec(raw);
		if (n) { note = n[1]; continue; }
		const verb = raw.split(/\s+/)[0]!.toLowerCase();
		if (NPC_VERBS.has(verb) && lines.length < MAX_LINES) lines.push(raw.slice(0, 300));
	}
	return { lines, ...(note ? { note } : {}) };
}
