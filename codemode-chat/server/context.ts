// What a model call needs, rebuilt from the shared space by the model process. An agent asks for a call with references
// only (LlmCall: the kind, the model, the agent, the room, block and run, the role and the attempt it works on); the
// model process reads the task, the team's attempts, notes and best code itself. So a call entry stays small whatever
// the room holds (the space caps an entry at 64 KiB, and the context of one call can be several times that).
import { HELD_WAIT_MS } from "./space.ts";
import type { SpaceLike } from "../../src/index.ts";
import type { Role, TeamContext } from "./llm.ts";
import { blockTask, teamView } from "./room.ts";

/** A request for a model call, as an agent writes it (and the model process takes it). */
export type LlmCall = {
	callId: string; session: string; blockId: string; runId?: string; kind: "contribute";
	agent: number; gen: number; model?: string; lang: "de" | "en";
	/** contribute: what the agent does this turn, and the attempt it works on (by id). */
	role?: Role; targetId?: string;
	/** Who started the run: a visitor's calls count against the day's allowance of their address. */
	client?: { ip: string; admin: boolean };
	ts: number;
};
/** The answer the model process writes for a call. */
export type LlmResultEntry = { callId: string; session: string; ok: boolean; value?: Record<string, unknown>; error?: string; ts: number };

/** The context of a contribution (a generation's turn): the task, the team's attempts with the one to work on, the
 *  rejected ones, the notes and the block's best code. Null when the block is gone. */
export async function contributeContext(space: SpaceLike, call: LlmCall): Promise<TeamContext | null> {
	const task = await blockTask(space, call.session, call.blockId);
	if (!task) return null;
	const view = await teamView(space, call.session, call.blockId, false);
	const target = call.targetId ? view.attempts.find((a) => a.candidateId === call.targetId) ?? null : null;
	const usable = view.attempts.filter((a) => !a.rejected);
	const best = (await space.readIfExists({ type: "CodeBest", fields: { session: call.session, blockId: call.blockId } }, HELD_WAIT_MS))?.fields as { candidateId: string; ms: number } | undefined;
	const bestSource = best ? usable.find((a) => a.candidateId === best.candidateId)?.source : undefined;
	return {
		task, lang: call.lang, agent: call.agent, gen: call.gen, ...(call.model ? { model: call.model } : {}),
		role: call.role ?? "explore", target: target && !target.rejected ? target : null,
		others: usable.filter((a) => a.candidateId !== call.targetId).slice(0, 3), rejected: view.attempts.filter((a) => a.rejected).slice(0, 3), notes: view.notes,
		best: best && bestSource !== undefined ? { source: bestSource, ms: best.ms } : null,
	};
}
