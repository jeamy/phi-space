// The discussion of a plan task: how the models talk to each other and to the person
// (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 6).
//
//   PlanMessage   one contribution: a question (to a model, to all, or to the person), an answer, a proposal, a vote on
//                 a proposal (agree or disagree, with its reason), an objection, a note, or a model's understanding of
//                 the brief at the kickoff. A thread is a first message and what refers to it.
//   PlanDecision  a proposal more than half of the models at the table agreed to. Binding for the work that follows.
//
// Messages are text in a fixed form, one a line, which every model can write (parseMessages); a model call may return
// its work and messages together. What a person writes is a message too, and outranks a decision.
import { randomBytes } from "node:crypto";
import type { SpaceLike } from "phi-spaces";

export const TALK_LIMITS = { text: 2000, perModelRound: 12, thread: 8, kickoff: 4, shownBytes: 12_000, understanding: 800 };
export type MessageKind = "understanding" | "question" | "answer" | "proposal" | "vote" | "objection" | "note";
/** `to`: a model's label, "all" or "person" (questions). `thread`: the id of the message it refers to (its own id for a
 *  first message). `stance`: a vote's. `model` is "human" for a person, whose name is `author`. */
export type PlanMessage = { session: string; blockId: string; table: string; runId?: string; msgId: string; thread: string; kind: MessageKind; author: string; model: string; to?: string; stance?: "agree" | "disagree"; sectionId?: string; text: string; round: number; ts: number };
export type PlanDecision = { session: string; blockId: string; table: string; thread: string; text: string; proposer: string; agreed: string[]; against: string[]; of: number; ts: number };
/** A message as a model wrote it, before it is kept: whom it addresses is still a name at the table. */
export type Said = { kind: Exclude<MessageKind, "understanding">; to?: string; thread?: string; stance?: "agree" | "disagree"; text: string };

/** The table a person's messages are kept under: they belong to the block, and every table reads them. */
export const PERSON_TABLE = "*";
export const newMsgId = () => randomBytes(2).toString("hex");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** The message lines of a model's answer: `question to M2: …`, `question to person: …`, `question: …` (to all),
 *  `proposal: …`, `note: …`, `objection: …`, `answer #id: …`, `agree #id: …`, `disagree #id: …`. A line that is none of
 *  these continues the message before it. */
export function parseMessages(text: string): Said[] {
	const out: Said[] = [];
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const line = raw.trim().replace(/^[-*]\s+/, "");
		const m = /^(question|proposal|note|objection|answer|agree|disagree)\b\s*(?:to\s+(M\d+|all|person|the person))?\s*(?:(?:on|to)?\s*#([0-9a-f]{4}))?\s*:\s*(.*)$/i.exec(line);
		if (!m) { if (out.length && line) out.at(-1)!.text += `\n${line}`; continue; }
		const word = m[1]!.toLowerCase(), to = m[2] ? (/person/i.test(m[2]) ? "person" : m[2].toLowerCase() === "all" ? "all" : m[2].toUpperCase()) : undefined;
		const kind = word === "agree" || word === "disagree" ? "vote" : (word as Said["kind"]);
		if ((kind === "vote" || kind === "answer") && !m[3]) continue; // a vote or an answer without its thread says nothing
		out.push({ kind, ...(kind === "question" ? { to: to ?? "all" } : {}), ...(m[3] ? { thread: m[3].toLowerCase() } : {}), ...(kind === "vote" ? { stance: word as "agree" | "disagree" } : {}), text: m[4]!.trim() });
	}
	return out.map((s) => ({ ...s, text: clip(s.text.trim(), TALK_LIMITS.text) })).filter((s) => s.text || s.kind === "vote");
}

/** A kickoff answer: the model's understanding of the brief, then its messages (after a line MESSAGES). */
export function parseKickoff(text: string): { understanding: string; messages: Said[] } {
	const body = text.replace(/\r\n/g, "\n").trim().replace(/^UNDERSTANDING:?\s*\n?/i, "");
	const cut = /^MESSAGES:?\s*$/im.exec(body);
	const understanding = clip((cut ? body.slice(0, cut.index) : body).trim(), TALK_LIMITS.text);
	if (!understanding) throw new Error("the kickoff answer says nothing about the brief");
	return { understanding, messages: cut ? parseMessages(body.slice(cut.index + cut[0].length)).filter((m) => m.kind === "question" || m.kind === "proposal" || m.kind === "note").slice(0, TALK_LIMITS.kickoff) : [] };
}

const key = (d: { session: string; blockId: string; table: string }) => ({ session: d.session, blockId: d.blockId, table: d.table });
/** The messages of a table's discussion, oldest first. */
export async function messagesOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, txn: string | null = null): Promise<PlanMessage[]> {
	// what the person says is said to every table of the block (PERSON_TABLE)
	const rows = [...(await space.readAll({ type: "PlanMessage", fields: key(d) }, { limit: 2000, txn })), ...(d.table === PERSON_TABLE ? [] : await space.readAll({ type: "PlanMessage", fields: { ...key(d), table: PERSON_TABLE } }, { limit: 500, txn }))];
	return rows.map((e) => e.fields as unknown as PlanMessage).sort((a, b) => a.ts - b.ts || a.msgId.localeCompare(b.msgId));
}
export async function decisionsOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, txn: string | null = null): Promise<PlanDecision[]> {
	return (await space.readAll({ type: "PlanDecision", fields: key(d) }, { limit: 500, txn })).map((e) => e.fields as unknown as PlanDecision).sort((a, b) => a.ts - b.ts);
}

/** Keeps what a model said, in `txn`: names at the table become models, a reference must name a thread there is, a
 *  thread takes at most eight messages, and a model at most twelve a round. Returns what was kept. */
export async function keep(space: SpaceLike, txn: string, ttl: number, d: { session: string; blockId: string; table: string }, who: { author: string; model: string; runId: string; round: number; aliases: Record<string, string>; sectionId?: string }, said: Array<Said | { kind: "understanding"; text: string }>): Promise<PlanMessage[]> {
	const all = await messagesOf(space, d, txn), byId = new Map(all.map((m) => [m.msgId, m]));
	let mine = all.filter((m) => m.model === who.model && m.runId === who.runId && m.round === who.round).length;
	const modelOf = (alias: string) => Object.entries(who.aliases).find(([, a]) => a === alias)?.[0];
	const kept: PlanMessage[] = [];
	for (const s of said) {
		if (mine >= TALK_LIMITS.perModelRound) break;
		const root = "thread" in s && s.thread ? byId.get(s.thread) : undefined;
		if ("thread" in s && s.thread && (!root || all.filter((m) => m.thread === root.thread).length + kept.filter((m) => m.thread === root.thread).length >= TALK_LIMITS.thread)) continue;
		// one vote a model and proposal, and none on a proposal of its own
		if (s.kind === "vote" && (!root || root.kind !== "proposal" || root.model === who.model || [...all, ...kept].some((m) => m.kind === "vote" && m.thread === root.thread && m.model === who.model))) continue;
		let to: string | undefined;
		if (s.kind === "question") { to = s.to === "person" || s.to === "all" || !s.to ? s.to ?? "all" : modelOf(s.to); if (!to || to === who.model) continue; }
		const msgId = newMsgId();
		const m: PlanMessage = { ...key(d), runId: who.runId, msgId, thread: root?.thread ?? msgId, kind: s.kind, author: who.author, model: who.model, ...(to ? { to } : {}), ...("stance" in s && s.stance ? { stance: s.stance } : {}), ...(who.sectionId ? { sectionId: who.sectionId } : {}), text: s.text, round: who.round, ts: Date.now() + kept.length };
		await space.write({ type: "PlanMessage", fields: m as never }, txn, ttl);
		kept.push(m); byId.set(msgId, m); mine++;
	}
	return kept;
}

/** A question's addressee among the models at the table: the model it names, or for a question to all the next one
 *  after the asker by the names at the table. */
export const answerer = (q: PlanMessage, present: string[], aliases: Record<string, string>): string | null => {
	if (q.to === "person" || !q.to) return null;
	if (q.to !== "all") return present.includes(q.to) ? q.to : null;
	const order = [...present].sort((a, b) => (aliases[a] ?? "").localeCompare(aliases[b] ?? "")), at = order.indexOf(q.model);
	return order.length > 1 ? order[(at + 1) % order.length]! : null;
};

/** What each model at the table owes a reply to: the questions it must answer and the proposals of others it has not
 *  voted on (by thread id). And the questions to the person nobody answered yet. */
export function owed(messages: PlanMessage[], present: string[], aliases: Record<string, string>): { byModel: Map<string, string[]>; person: string[] } {
	const byModel = new Map<string, string[]>(), person: string[] = [];
	const add = (model: string, thread: string) => byModel.set(model, [...(byModel.get(model) ?? []), thread]);
	for (const m of messages) {
		const replies = messages.filter((x) => x.thread === m.thread && x.msgId !== m.msgId);
		if (m.kind === "question") {
			if (m.to === "person") { if (!replies.some((x) => x.model === "human")) person.push(m.thread); continue; }
			const who = answerer(m, present, aliases);
			if (who && !replies.some((x) => x.kind === "answer" && (x.model === who || x.model === "human"))) add(who, m.thread);
		} else if (m.kind === "proposal") for (const model of present) if (model !== m.model && !replies.some((x) => x.kind === "vote" && x.model === model)) add(model, m.thread);
	}
	return { byModel, person };
}

/** The proposals that have a majority and no decision yet: more than half of the `present` models agree, the
 *  proposer among them. */
export function decide(messages: PlanMessage[], decided: PlanDecision[], present: string[], d: { session: string; blockId: string; table: string }): PlanDecision[] {
	const out: PlanDecision[] = [];
	for (const p of messages.filter((m) => m.kind === "proposal" && present.includes(m.model))) {
		if (decided.some((x) => x.thread === p.thread)) continue;
		const votes = messages.filter((m) => m.kind === "vote" && m.thread === p.thread && present.includes(m.model));
		const agreed = [p.model, ...votes.filter((v) => v.stance === "agree").map((v) => v.model)], against = votes.filter((v) => v.stance === "disagree").map((v) => v.model);
		if (agreed.length * 2 > present.length) out.push({ ...key(d), thread: p.thread, text: p.text, proposer: p.model, agreed, against, of: present.length, ts: Date.now() + out.length });
	}
	return out;
}

/** How a message's author is called in a prompt: its name at the table of this run, the person, or someone who is not
 *  at the table any more. */
export const nameOf = (m: { model: string; author: string }, aliases: Record<string, string>) => (m.model === "human" ? "the person" : aliases[m.model] ?? "an earlier participant");

/** The discussion for a prompt: the decisions (binding), what the person said (it outranks them), the questions to the
 *  person nobody answered (assumptions to make and to name), what the others understood, and the open threads. */
export function discussionText(messages: PlanMessage[], decisions: PlanDecision[], aliases: Record<string, string>, me: string): string[] {
	const parts: string[] = [], said = (m: PlanMessage) => `${nameOf(m, aliases)}: ${m.text}`;
	const human = messages.filter((m) => m.model === "human");
	if (human.length) parts.push(`The person said (this outranks any decision of the table):\n${human.map((m) => { const q = m.thread !== m.msgId ? messages.find((x) => x.msgId === m.thread) : undefined; return `- ${q ? `to "${clip(q.text, 160)}": ` : ""}${m.text}`; }).join("\n")}`);
	if (decisions.length) parts.push(`Decided by a majority of the table (binding for your work):\n${decisions.map((x) => `- ${x.text} (${x.agreed.length} of ${x.of} agreed)`).join("\n")}`);
	const unanswered = messages.filter((m) => m.kind === "question" && m.to === "person" && !messages.some((x) => x.thread === m.thread && x.model === "human"));
	if (unanswered.length) parts.push(`Questions to the person that got no answer. Make a sensible assumption for each and name it as an assumption in the plan:\n${unanswered.map((m) => `- ${m.text}`).join("\n")}`);
	// each model's newest one, by their names at the table, not by who spoke first: the same prompt whatever the order
	// of the answers
	const others = messages.filter((m, i) => m.kind === "understanding" && m.model !== me && aliases[m.model] && !messages.slice(i + 1).some((x) => x.kind === "understanding" && x.model === m.model)).sort((a, b) => aliases[a.model]!.localeCompare(aliases[b.model]!));
	if (others.length) parts.push(`How the others understand the brief:\n${others.map((m) => `- ${nameOf(m, aliases)}: ${clip(m.text.replace(/\s+/g, " "), TALK_LIMITS.understanding)}`).join("\n")}`);
	const threads = messages.filter((m) => m.thread === m.msgId && m.kind !== "understanding" && m.model !== "human" && !decisions.some((x) => x.thread === m.thread) && !(m.kind === "question" && m.to === "person"));
	if (threads.length) parts.push(`The table's discussion so far (each thread with its id):\n${threads.slice(-20).map((t) => [`#${t.msgId} ${t.kind}${t.to && t.to !== "all" ? ` to ${aliases[t.to] ?? "someone"}` : ""} by ${said(t)}`, ...messages.filter((x) => x.thread === t.thread && x.msgId !== t.msgId).map((x) => `   ${x.kind === "vote" ? `${nameOf(x, aliases)} ${x.stance}s${x.text ? `: ${x.text}` : ""}` : `${x.kind} by ${said(x)}`}`)].join("\n")).join("\n")}`);
	let room = TALK_LIMITS.shownBytes;
	return parts.filter((p) => (room -= Buffer.byteLength(p)) >= 0);
}
