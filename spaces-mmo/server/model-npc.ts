// What an awake model NPC says, answered in the model process (docs/rust-portierung.en.md, R8.0 item 2). The npc process
// has no model access: `think` (server/npc/minds.ts) writes a Think entry with the prompts it built, and this process takes
// it, makes the call (the durable dialogue of server/npc/durable.ts when it is on for that NPC, else the plain call) under
// the same limits (server/llm.ts: the NPC's day, the shared ones), and writes the text back as a Thought with the same
// `thinkId`. Thinks are answered side by side, up to SPACES_MMO_THINKS_AT_ONCE (default 8): an NPC's call never waits
// behind a translation or another NPC's call that takes long.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { complete } from "./llm.ts";
import { npcDialogue } from "./npc/durable.ts";
import { fieldsOf, type ThinkFields, type ThoughtFields } from "./model.ts";
import { awaitWork } from "./space.ts";

/** How long a Thought waits for the npc process that asked (it takes it at once, or gave up). */
const THOUGHT_LEASE_MS = 60_000;

/** The model's text for one Think, or null (calls off, no model, a limit reached, the call failed). */
export async function answerThink(space: SpaceLike, t: ThinkFields, signal?: AbortSignal): Promise<string | null> {
	const execute = npcDialogue(t.npcId, t.worldId, t.system, t.user, signal);
	const res = await complete(space, t.system, t.user, { maxTokens: t.maxTokens, own: { key: `npc:${t.npcId}`, perDay: t.perDay, ...(t.day ? { day: t.day } : {}) }, ...(execute ? { execute } : {}) })
		.catch((e) => { console.error(`[model] ${t.npcId}:`, (e as Error).message); return null; });
	return res?.text ?? null;
}

/** Answers the Thinks of `space` until `halt`. */
export async function serveThinks(space: SpaceLike, halt: AbortSignal): Promise<void> {
	const most = Math.max(1, Number(process.env.SPACES_MMO_THINKS_AT_ONCE ?? 8));
	const running = new Set<Promise<void>>();
	const answer = async (t: ThinkFields) => {
		const text = await answerThink(space, t, halt);
		if (halt.aborted) return;
		await space.write({ type: "Thought", fields: { thinkId: t.thinkId, ...(text !== null ? { text } : {}) } satisfies ThoughtFields as never }, null, THOUGHT_LEASE_MS);
	};
	while (!halt.aborted) {
		try {
			if (running.size >= most) { await Promise.race(running); continue; }
			// taken at once, not in a transaction held across the call: a process that dies mid-call loses the request, and
			// the npc process that waits for it gives up (an NPC that dozes off once)
			const e = await space.takeIfExists({ type: "Think" }, NO_WAIT);
			if (!e) { await awaitWork(space, { type: "Think" }, halt); continue; }
			const job: Promise<void> = answer(fieldsOf<ThinkFields>(e)).catch((err) => { if (!halt.aborted) console.error("[model] think:", (err as Error).message); }).finally(() => running.delete(job));
			running.add(job);
		} catch (err) { if (halt.aborted) break; console.error("[model] thinks:", (err as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
	}
	await Promise.allSettled(running);
}
