// What a model call needs, rebuilt from the shared space by the model process (as codemode-chat/server/context.ts does).
// An agent asks for a call with references only (LlmCall: the kind, the model, the room, block and run, the section);
// the model process reads the task and the document itself and builds the prompt. So a call entry stays small whatever
// the room holds (the space caps an entry at 64 KiB).
//
// The kinds so far:
//   rollcall  the opening of a run: every model says that it is there.
//   outline   one model proposes the document's sections, each with a line on what it is to say.
//   draft     one model writes one section.
// The kinds of the joint work (kickoff, review, revise, ballot, …) follow with their phases.
import type { SpaceLike } from "phi-spaces";
import type { TextCall, Usage } from "./llm.ts";
import { cleanText, cleanTitle, DOC_LIMITS, fullDoc, headOf } from "./plandoc.ts";
import { criteriaOf, TASK_LIMITS, type PlanTask } from "./plantask.ts";
import type { RunEntry } from "./run.ts";
import { readExisting } from "./space.ts";

export type CallKind = "rollcall" | "outline" | "draft";
/** A request for a model call, as an agent writes it (and the model process takes it). */
export type LlmCall = {
	callId: string; session: string; runId?: string; kind: CallKind;
	/** The work item the call belongs to: its budget reservation. */
	itemId?: string;
	agent: number; model: string; lang: "de" | "en";
	/** outline and draft: the table whose document the call works on; draft: the section. */
	table?: string; sectionId?: string;
	/** Who started the run: a visitor's calls count against the day's allowance of their address. */
	client?: { ip: string; admin: boolean };
	ts: number;
};
/** The answer the model process writes for a call (`itemId`: the work item it belongs to, which removes it when its run
 *  is gone). `usage` on a failed call: what it used before it failed (a success has it in its value). */
export type LlmResultEntry = { callId: string; session: string; itemId?: string; ok: boolean; value?: Record<string, unknown>; error?: string; usage?: Usage; ts: number };

/** The longest text a roll call answer keeps. */
export const ROLLCALL_CHARS = 400;
/** Sections an outline has at least and at most; how long a section's line on what it is to say may be. */
export const OUTLINE = { min: 3, max: TASK_LIMITS.outline, intent: 300 };
/** How much of the document so far a draft call is shown. */
const CONTEXT_BYTES = 48_000;

const SYSTEM = "You are one of several AI models that work out a plan together in a forum: you discuss, propose, object and vote until a majority agrees the plan can be carried out. What you write is part of one shared document.";
const answerIn = (lang: "de" | "en") => (lang === "de" ? "Write in German." : "Write in English.");

/** What the task says, for a prompt: the brief, the criteria the plan is held against. */
const taskText = (t: PlanTask) => [`The brief:\n"""\n${t.brief}\n"""`, `The plan will be held against these criteria:\n${criteriaOf(t).map((c, i) => `${i + 1}. ${c}`).join("\n")}`].join("\n\n");

/** The prompt of a call, built from the space. */
export async function callPrompt(space: SpaceLike, call: LlmCall): Promise<TextCall> {
	const run = call.runId ? ((await readExisting(space, { type: "ForumRun", fields: { session: call.session, runId: call.runId } }))?.fields as unknown as RunEntry | undefined) : undefined;
	if (!run) throw new Error("the run is over");
	const aliases = run.params.aliases, me = aliases[call.model] ?? "a model", others = Object.values(aliases).filter((a) => a !== me).sort();
	const who = `You are ${me}. The other models at the table are ${others.join(", ")}. Nobody knows which model is behind which name.`;
	if (call.kind === "rollcall") return {
		model: call.model, system: SYSTEM, maxTokens: 200,
		user: [who, "This is the roll call before the work begins. Say in at most two sentences that you are there and what you pay attention to most when you judge whether a plan can be carried out.", `${answerIn(call.lang)} Plain text, no heading, no list.`].join("\n\n"),
	};
	const task = (await readExisting(space, { type: "PlanTask", fields: { session: call.session, blockId: run.params.blockId } }))?.fields as unknown as PlanTask | undefined;
	if (!task) throw new Error("the task is gone");
	if (call.kind === "outline") return {
		model: call.model, system: SYSTEM, maxTokens: 1200,
		user: [
			who, taskText(task),
			task.outline.length
				? `The person fixed the document's sections. Keep exactly these headings in this order:\n${task.outline.map((h) => `## ${h}`).join("\n")}`
				: `Propose the sections of the plan document: between ${OUTLINE.min} and ${OUTLINE.max}, in the order a reader needs them.`,
			`Answer with the outline only, in this form, one block per section:\n## <heading>\n<one or two sentences: what this section must say so that the plan can be carried out>\n\n${answerIn(call.lang)} No text before the first heading, no numbering in the headings.`,
		].join("\n\n"),
	};
	const d = { session: call.session, blockId: run.params.blockId, table: call.table ?? "" };
	const head = await headOf(space, d);
	const ref = head?.sections.find((s) => s.sectionId === call.sectionId);
	if (!head || !ref) throw new Error("the section is gone");
	const doc = await fullDoc(space, head);
	// the document so far: sections not yet written show what they are to say; beyond the limit only their headings
	let room = CONTEXT_BYTES;
	const sofar = doc.sections.map((s) => {
		const body = s.sectionId === ref.sectionId ? "(the section you write now)" : s.text;
		room -= Buffer.byteLength(body);
		return `## ${s.title}\n${room >= 0 ? body : "(left out here for length)"}`;
	}).join("\n\n");
	const mine = doc.sections.find((s) => s.sectionId === ref.sectionId)!;
	return {
		model: call.model, system: SYSTEM, maxTokens: 3000,
		user: [
			who, taskText(task),
			`The document so far (a section not yet written shows what it is to say):\n"""\n${sofar}\n"""`,
			`Write the section "${mine.title}". What it is to say: ${mine.rev === 1 ? mine.text : "(revise what is there)"}`,
			`Write the section's body only, as Markdown: no heading for the section itself (use ### inside it if needed), concrete enough to act on, nothing the other sections already say. At most ${Math.floor(DOC_LIMITS.sectionBytes / 1000)} kB. ${answerIn(call.lang)}`,
		].join("\n\n"),
	};
}

/** An outline as a model wrote it: the sections with what each is to say. Throws what is wrong with it; headings the
 *  task fixed must be there, in their order. */
export function parseOutline(text: string, fixed: string[] = []): Array<{ title: string; intent: string }> {
	const out: Array<{ title: string; intent: string }> = [];
	for (const block of text.replace(/\r\n/g, "\n").split(/^(?=#{1,3} )/m)) {
		const m = /^#{1,3} +(.+)\n?([\s\S]*)$/.exec(block);
		if (!m) continue; // text before the first heading
		const title = cleanTitle(m[1]!.replace(/^\d+[.)]\s*/, "")).slice(0, DOC_LIMITS.title), intent = cleanText(m[2]!).replace(/\s+/g, " ").slice(0, OUTLINE.intent);
		if (title) out.push({ title, intent: intent || "(nothing said yet)" });
	}
	if (fixed.length) {
		const got = new Map(out.map((s) => [s.title.toLowerCase(), s]));
		return fixed.map((h) => ({ title: h, intent: got.get(h.toLowerCase())?.intent ?? "(nothing said yet)" }));
	}
	if (out.length < OUTLINE.min) throw new Error(`the outline has ${out.length} sections; it needs at least ${OUTLINE.min}, each as "## heading" with a line below`);
	if (new Set(out.map((s) => s.title.toLowerCase())).size !== out.length) throw new Error("the outline names a heading twice");
	return out.slice(0, OUTLINE.max);
}

/** A section's body as a model wrote it: without a heading of its own, cut at a paragraph when it is too long. */
export function parseSection(text: string, title: string): string {
	let body = cleanText(text.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/m, "$1"));
	const first = /^#{1,3} +(.+)(?:\n|$)/.exec(body);
	if (first && cleanTitle(first[1]!).toLowerCase() === title.toLowerCase()) body = cleanText(body.slice(first[0].length));
	if (!body) throw new Error("the section is empty");
	while (Buffer.byteLength(body) > DOC_LIMITS.sectionBytes) {
		const cut = body.lastIndexOf("\n\n");
		body = cut > 0 ? body.slice(0, cut) : body.slice(0, Math.floor(body.length * 0.9));
	}
	return body;
}
