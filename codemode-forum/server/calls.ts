// What a model call needs, rebuilt from the shared space by the model process (as codemode-chat/server/context.ts does).
// An agent asks for a call with references only (LlmCall: the kind, the model, the room and run); the model process
// reads what the call works on itself and builds the prompt. So a call entry stays small whatever the room holds (the
// space caps an entry at 64 KiB).
//
// The kinds so far: "rollcall", the opening of a run, in which every model of the run says that it is there. The
// kinds of the plan work (kickoff, outline, draft, review, …) follow with their phases.
import type { SpaceLike } from "phi-spaces";
import type { TextCall, Usage } from "./llm.ts";
import type { RunEntry } from "./run.ts";
import { readExisting } from "./space.ts";

export type CallKind = "rollcall";
/** A request for a model call, as an agent writes it (and the model process takes it). */
export type LlmCall = {
	callId: string; session: string; runId?: string; kind: CallKind;
	/** The work item the call belongs to: its budget reservation. */
	itemId?: string;
	agent: number; model: string; lang: "de" | "en";
	/** Who started the run: a visitor's calls count against the day's allowance of their address. */
	client?: { ip: string; admin: boolean };
	ts: number;
};
/** The answer the model process writes for a call (`itemId`: the work item it belongs to, which removes it when its run
 *  is gone). `usage` on a failed call: what it used before it failed (a
 *  success has it in its value). */
export type LlmResultEntry = { callId: string; session: string; itemId?: string; ok: boolean; value?: Record<string, unknown>; error?: string; usage?: Usage; ts: number };

/** The longest text a roll call answer keeps. */
export const ROLLCALL_CHARS = 400;

/** The prompt of a call, built from the space. */
export async function callPrompt(space: SpaceLike, call: LlmCall): Promise<TextCall> {
	const run = call.runId ? ((await readExisting(space, { type: "ForumRun", fields: { session: call.session, runId: call.runId } }))?.fields as unknown as RunEntry | undefined) : undefined;
	if (!run) throw new Error("the run is over");
	const aliases = run.params.aliases, me = aliases[call.model] ?? "a model", others = Object.values(aliases).filter((a) => a !== me).sort();
	const answerIn = call.lang === "de" ? "Answer in German." : "Answer in English.";
	return {
		model: call.model,
		system: "You are one of several AI models that will work out a plan together in a forum: you discuss, propose, object and vote until a majority agrees the plan can be carried out.",
		user: [
			`You are ${me}. The other models at the table are ${others.join(", ")}. Nobody knows which model is behind which name.`,
			"This is the roll call before the work begins. Say in at most two sentences that you are there and what you pay attention to most when you judge whether a plan can be carried out.",
			`${answerIn} Plain text, no heading, no list.`,
		].join("\n\n"),
		maxTokens: 200,
	};
}
