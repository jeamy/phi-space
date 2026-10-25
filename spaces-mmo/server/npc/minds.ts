// Model NPCs (docs/modell-npcs.md): who plays a role, who is awake, and what an awake NPC says. Everything lives in the
// world space, so a restarted npc process finds the same states and memories, and two processes never play one role:
//   NpcOwner{npcId, owner}  leased: the process that plays the role (claimed under the NPC lock)
//   NpcAwake{npcId}         leased: the NPC answers with the model; woken under the NPC lock, at most SPACES_MMO_NPC_MAX
//   NpcMemory{npcId, text}  what it remembers (≤ 4 KiB), written by its own NOTE lines
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { complete, llmEnabled } from "../llm.ts";
import { fieldsOf, NPC_LOCK, type NpcAwakeFields, type NpcMemoryFields, type NpcOwnerFields } from "../model.ts";
import { readExisting, StillHeld } from "../space.ts";

const MEMORY_MAX = 4096;
/** What a model NPC may type: talk and gestures (it acts in the world through people, not by taking things). */
const NPC_VERBS = new Set(["say", "sag", "sage", "emote", "pose", "geste"]);

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

/** Wakes an NPC if fewer than `max` are awake; true when it is awake now (also when it already was). */
export async function tryWake(space: SpaceLike, npcId: string, max: number, leaseMs: number): Promise<boolean> {
	return locked(space, async (txn) => {
		if (await space.readIfExists({ type: "NpcAwake", fields: { npcId } }, NO_WAIT, { txn })) return true;
		if ((await space.count({ type: "NpcAwake" }, txn)) >= max) return false;
		await space.write({ type: "NpcAwake", fields: { npcId, since: Date.now() } satisfies NpcAwakeFields as never }, txn, leaseMs);
		return true;
	});
}

export const isAwake = async (space: SpaceLike, npcId: string) => !!(await space.readIfExists({ type: "NpcAwake", fields: { npcId } }, 1_000));

/** Keeps an awake NPC awake for another `leaseMs` (it was spoken to, or something happened). */
export async function keepAwake(space: SpaceLike, npcId: string, leaseMs: number): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const e = await space.takeIfExists({ type: "NpcAwake", fields: { npcId } }, 1_000, { txn });
		if (e) await space.write({ type: "NpcAwake", fields: e.fields }, txn, leaseMs);
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
		let text = `${e ? fieldsOf<NpcMemoryFields>(e).text : ""}\n${note.trim().slice(0, 300)}`.trim();
		while (text.length > MEMORY_MAX) text = text.slice(text.indexOf("\n") + 1 || text.length);
		await space.write({ type: "NpcMemory", fields: { npcId, text } satisfies NpcMemoryFields as never }, txn, FOREVER);
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

export type Situation = { room: string; people: string[]; fire?: string; event: string; heard: string[] };

/** One answer of an awake model NPC: its lines (say/emote only) and a note for its memory. "off": model calls are off;
 *  "budget": its day (or the shared limit) is used up. */
export async function think(space: SpaceLike, npc: { npcId: string; name: string; persona: string; budgetDay: number }, s: Situation): Promise<{ lines: string[]; note?: string } | "off" | "budget"> {
	if (!llmEnabled()) return "off";
	const budget = Number(process.env.SPACES_MMO_NPC_BUDGET_DAY ?? npc.budgetDay);
	const system = [
		`You are ${npc.name}, a character in the text game "Leuchtfeuer" (an archipelago in the fog; fires keep the fog away). ${npc.persona}`,
		"You speak German, briefly (one or two sentences), in character. You act only by typing game commands, one per line:",
		"  say <text>     to speak", "  emote <text>   to show what you do (third person, without your name)",
		"Answer with one or two such lines. Then, if something is worth remembering for later, one line: NOTE: <what>",
	].join("\n");
	const memory = await memoryOf(space, npc.npcId);
	const user = [
		`Memory: ${memory || "–"}`,
		`Place: ${s.room}`,
		`People here: ${s.people.join(", ") || "nobody"}`,
		...(s.fire ? [`The beacon: ${s.fire}`] : []),
		`Event: ${s.event}`,
		`Heard: ${s.heard.join(" | ")}`,
	].join("\n");
	const res = await complete(space, system, user, { maxTokens: 200, own: { key: `npc:${npc.npcId}`, perDay: budget } }).catch((e) => { console.error(`[npc] ${npc.npcId} model:`, (e as Error).message); return null; });
	if (!res) return "budget";
	const lines: string[] = [];
	let note: string | undefined;
	for (const raw of res.text.split("\n").map((l) => l.trim()).filter(Boolean)) {
		const n = /^NOTE:\s*(.+)$/i.exec(raw);
		if (n) { note = n[1]; continue; }
		const verb = raw.split(/\s+/)[0]!.toLowerCase();
		if (NPC_VERBS.has(verb) && lines.length < 2) lines.push(raw.slice(0, 300));
	}
	return { lines, ...(note ? { note } : {}) };
}
