// When a plan counts as agreed (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 9). In every round each model
// at the table writes one ballot on the newest version: one vote per model, however many agents it has.
//
//   PlanBallot  a model's vote on a version: approve or reject, every criterion rated, each "met" backed by words of
//               the plan. An approval counts only when every criterion is met with words that are in the plan, the
//               model raises no new objection, and none of its own objections is still standing.
//   PlanAccept  the accepted version of a table's document, by a majority of the table or by the person.
//
// With its ballot a model also says what became of its earlier objections (resolved, not resolved, withdrawn) and
// raises new ones. From the third round on a new objection blocks only when it is against a section that changed
// since the model's last ballot; otherwise it is kept as a note. That keeps the target from moving for ever.
import type { SpaceLike } from "phi-spaces";
import { parseReview, type PlanObjection } from "./review.ts";

export type Rated = { n: number; met: boolean; text: string;
	/** For a "met": whether its words are in the plan. */
	backed?: boolean };
export type PlanBallot = { session: string; blockId: string; table: string; runId: string; round: number; version: number; slot: string; model: string; author: string;
	/** What the model wrote, and whether it counts as an approval (see above); if not, why. */
	vote: "approve" | "reject"; counts: boolean; why?: string; criteria: Rated[]; ts: number };
export type PlanAccept = { session: string; blockId: string; table: string; version: number; by: "majority" | "person"; who?: string; approvals: string[]; of: number; round?: number; ts: number };
/** What a model says of an earlier objection of its own. */
export type Confirm = { objId: string; verdict: "resolved" | "open" | "withdrawn"; why?: string };

/** From this round on a new objection blocks only against a section that changed since the model's last ballot. */
export const SETTLED_FROM_ROUND = 3;

const norm = (s: string) => s.toLowerCase().replace(/[`*_"“”'’]/g, "").replace(/\s+/g, " ").trim();
/** Whether words a ballot quotes are in the plan (blanks, case and Markdown marks aside). At least three words: a
 *  word or two are in any text. */
export function quoted(plan: string, quote: string): boolean {
	const q = norm(quote.replace(/…|\.\.\./g, " "));
	return q.split(" ").length >= 3 && norm(plan).includes(q);
}

/** A ballot as a model wrote it: `BALLOT: APPROVE` or `REJECT`; under CRITERIA a line per criterion, `3 met: "words of
 *  the plan"` or `3 not met: what is missing`; under CONFIRM what became of its earlier objections, `#id resolved`,
 *  `#id not resolved: why`, `#id withdrawn`; then its objections and messages as in a review (review.ts). Throws when
 *  it names no vote. */
export function parseBallot(text: string, sections: Array<{ sectionId: string; title: string }>): { vote: "approve" | "reject"; criteria: Rated[]; confirm: Confirm[]; objections: ReturnType<typeof parseReview>["objections"]; messages: string } {
	const body = text.replace(/\r\n/g, "\n");
	const vote = /^\W*BALLOT\s*:?\s*\**\s*(APPROVE|REJECT)/im.exec(body)?.[1]?.toLowerCase() as "approve" | "reject" | undefined;
	if (!vote) throw new Error("the ballot names no vote: its first line is BALLOT: APPROVE or BALLOT: REJECT");
	const criteria: Rated[] = [], confirm: Confirm[] = [];
	for (const raw of body.split("\n")) {
		const line = raw.trim().replace(/^[-*]\s+/, "");
		const c = /^(\d{1,2})[.):]?\s+(not met|met)\s*:?\s*(.*)$/i.exec(line);
		if (c && !criteria.some((x) => x.n === Number(c[1]))) { criteria.push({ n: Number(c[1]), met: c[2]!.toLowerCase() === "met", text: c[3]!.trim().replace(/^["“](.*)["”]$/, "$1").slice(0, 400) }); continue; }
		const k = /^#(o[0-9a-f]{6,10})\s+(not resolved|resolved|withdrawn)\s*:?\s*(.*)$/i.exec(line);
		if (k && !confirm.some((x) => x.objId === k[1])) confirm.push({ objId: k[1]!, verdict: /^not/i.test(k[2]!) ? "open" : (k[2]!.toLowerCase() as "resolved" | "withdrawn"), ...(k[3] ? { why: k[3].slice(0, 400) } : {}) });
	}
	const review = parseReview(body, sections);
	return { vote, criteria: criteria.sort((a, b) => a.n - b.n), confirm, objections: review.objections, messages: review.messages };
}

/** Whether a ballot counts as an approval, and if not, why: it says approve, rates every criterion as met with words
 *  that are in the plan, raises no objection that blocks, and none of the model's own objections still stands. */
export function counts(b: { vote: "approve" | "reject"; criteria: Rated[] }, o: { criteria: number; blocking: number; standing: number }): { counts: boolean; why?: string } {
	if (b.vote !== "approve") return { counts: false };
	const missing = Array.from({ length: o.criteria }, (_, i) => i + 1).filter((n) => !b.criteria.some((c) => c.n === n));
	if (missing.length) return { counts: false, why: `it does not rate criterion ${missing.join(", ")}` };
	const unmet = b.criteria.filter((c) => !c.met).map((c) => c.n);
	if (unmet.length) return { counts: false, why: `it approves but rates criterion ${unmet.join(", ")} as not met` };
	const bare = b.criteria.filter((c) => c.met && !c.backed).map((c) => c.n);
	if (bare.length) return { counts: false, why: `the words it gives for criterion ${bare.join(", ")} are not in the plan` };
	if (o.blocking) return { counts: false, why: "it approves and objects at once" };
	if (o.standing) return { counts: false, why: "an objection of its own still stands (neither resolved nor withdrawn)" };
	return { counts: true };
}

/** Whether the table has agreed on a version, from the ballots of a round (one a model). Accepted when
 *   - more than half of the models at the table approve it (ballots that count; a model that owes the table an answer
 *     does not count until it gave it);
 *   - approval is not the authors' alone: of the sections that changed since the last round of ballots, at least one
 *     approving model wrote none; in the first round, where every section is new, each section needs an approver who
 *     did not write it;
 *   - nothing the checker or the person objected to is open (`barred`). */
export function tally(o: { present: string[]; ballots: Array<{ model: string; counts: boolean }>; owing: string[]; changed: Array<{ sectionId: string; model: string }>; first: boolean; barred: number }): { accepted: boolean; approvals: string[]; why?: string } {
	const approvals = [...new Set(o.ballots.filter((b) => b.counts && o.present.includes(b.model) && !o.owing.includes(b.model)).map((b) => b.model))];
	if (approvals.length * 2 <= o.present.length) return { accepted: false, approvals, why: `${approvals.length} of ${o.present.length} approve` };
	if (o.barred) return { accepted: false, approvals, why: "an objection of the checker or the person is open" };
	const authors = new Set(o.changed.map((c) => c.model));
	if (o.first ? o.changed.some((c) => !approvals.some((m) => m !== c.model)) : o.changed.length > 0 && approvals.every((m) => authors.has(m)))
		return { accepted: false, approvals, why: "only authors of the changed sections approve" };
	return { accepted: true, approvals };
}

/** A round's outcome as the run keeps it, to see when the table is stuck. */
export type RoundMark = { round: number; standing: string[]; approvals: number };
/** Stuck: two rounds in a row end with the same objections standing and no more approvals. */
export const stalled = (history: RoundMark[]): boolean => {
	const [a, b] = history.slice(-2);
	return !!a && !!b && b.standing.length > 0 && a.standing.join() === b.standing.join() && b.approvals <= a.approvals;
};

const key = (d: { session: string; blockId: string; table: string }) => ({ session: d.session, blockId: d.blockId, table: d.table });
export async function ballotsOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, txn: string | null = null): Promise<PlanBallot[]> {
	return (await space.readAll({ type: "PlanBallot", fields: key(d) }, { limit: 500, txn })).map((e) => e.fields as unknown as PlanBallot).sort((a, b) => a.ts - b.ts);
}
export async function acceptOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, txn: string | null = null): Promise<PlanAccept | null> {
	return ((await space.readAll({ type: "PlanAccept", fields: key(d) }, { limit: 5, txn })).map((e) => e.fields as unknown as PlanAccept).sort((a, b) => b.ts - a.ts)[0]) ?? null;
}
/** An objection that still stands for the one who raised it: open, or declined by a reviser and not withdrawn. */
export const stands = (o: PlanObjection) => o.state === "open" || o.state === "declined";
