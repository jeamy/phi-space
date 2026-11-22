// What table B adds to the writing (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 7): several models write at
// the same time.
//
//   PlanOutline    an outline one model proposes. The table picks one (OutlinePick: each model names the one it
//                  prefers among the others'), and that one becomes the document's first version.
//   PlanObjection  a defect a model found in a section when it reviewed the document: the section, the defect, what
//                  would resolve it, a quote. Open until a revision of that section takes it up.
//
// An objection is text in a fixed form, one a line (parseReview), like the messages of the discussion.
import type { SpaceLike } from "phi-spaces";

export const REVIEW_LIMITS = { objections: 6, text: 600 };
export type PlanOutline = { session: string; blockId: string; table: string; runId: string; model: string; author: string; sections: Array<{ title: string; intent: string }>; ts: number };
export type OutlinePick = { session: string; blockId: string; table: string; runId: string; model: string; choice: string; ts: number };
/** `state`: open until a revision of its section took it up (resolved, `revisedIn`: that version), or declined when the
 *  reviser left the section as it was. With its next ballot the one who raised it says what became of it: confirmed,
 *  open again (`reopened` counts how often), or withdrawn. A note was never blocking (ballots.ts). `model` is "human"
 *  for a person's objection, which no reviser can decline. */
export type PlanObjection = { session: string; blockId: string; table: string; runId: string; objId: string; sectionId: string; defect: string; fix: string; quote?: string; author: string; model: string; round: number; state: "open" | "resolved" | "confirmed" | "declined" | "withdrawn" | "note"; revisedIn?: number; reopened?: number; ts: number };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** A review as a model wrote it: its objections, each `objection on "<section title>": <defect> | fix: <what would
 *  resolve it> | quote: "<words of the plan>"`. One that names no section of the document, or no fix, is none. What
 *  follows a line MESSAGES is for the discussion (talk.ts). */
export function parseReview(text: string, sections: Array<{ sectionId: string; title: string }>): { objections: Array<{ sectionId: string; defect: string; fix: string; quote?: string }>; messages: string } {
	const body = text.replace(/\r\n/g, "\n"), cut = /^MESSAGES:?\s*$/im.exec(body);
	const objections: Array<{ sectionId: string; defect: string; fix: string; quote?: string }> = [];
	for (const raw of (cut ? body.slice(0, cut.index) : body).split("\n")) {
		const m = /^[-*\s]*objection\s+on\s+["“]([^"”]+)["”]\s*:\s*(.+)$/i.exec(raw.trim());
		if (!m) continue;
		const section = sections.find((s) => s.title.toLowerCase() === m[1]!.trim().toLowerCase());
		const parts = m[2]!.split(/\s*\|\s*(?=(?:fix|quote)\s*:)/i);
		const fix = parts.find((p) => /^fix\s*:/i.test(p))?.replace(/^fix\s*:\s*/i, "").trim(), quote = parts.find((p) => /^quote\s*:/i.test(p))?.replace(/^quote\s*:\s*/i, "").trim().replace(/^["“](.*)["”]$/, "$1");
		const defect = parts[0]!.trim();
		if (!section || !defect || !fix) continue;
		objections.push({ sectionId: section.sectionId, defect: clip(defect, REVIEW_LIMITS.text), fix: clip(fix, REVIEW_LIMITS.text), ...(quote ? { quote: clip(quote, 300) } : {}) });
		if (objections.length >= REVIEW_LIMITS.objections) break;
	}
	return { objections, messages: cut ? body.slice(cut.index + cut[0].length) : "" };
}

/** The outline a model picked: the name at the table of the one who proposed it (`PICK M2`). */
export const parsePick = (text: string): string | null => /\bPICK\s*:?\s*(M\d+)\b/i.exec(text)?.[1]?.toUpperCase() ?? null;

const key = (d: { session: string; blockId: string; table: string }) => ({ session: d.session, blockId: d.blockId, table: d.table });
export async function outlinesOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, runId: string, txn: string | null = null): Promise<PlanOutline[]> {
	return (await space.readAll({ type: "PlanOutline", fields: { ...key(d), runId } }, { limit: 20, txn })).map((e) => e.fields as unknown as PlanOutline).sort((a, b) => a.ts - b.ts);
}
export async function objectionsOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, txn: string | null = null): Promise<PlanObjection[]> {
	return (await space.readAll({ type: "PlanObjection", fields: key(d) }, { limit: 1000, txn })).map((e) => e.fields as unknown as PlanObjection).sort((a, b) => a.ts - b.ts || a.objId.localeCompare(b.objId));
}

/** The outline the table picked: the one most models named; among equals the one whose proposer comes first at the
 *  table. Without a pick the first proposer's. */
export function pickedOutline(outlines: PlanOutline[], picks: OutlinePick[], aliases: Record<string, string>): PlanOutline | null {
	const votes = (o: PlanOutline) => picks.filter((p) => p.choice === o.model && p.model !== o.model).length;
	return [...outlines].sort((a, b) => votes(b) - votes(a) || (aliases[a.model] ?? "").localeCompare(aliases[b.model] ?? ""))[0] ?? null;
}

/** The sections dealt out among the models at the table, in turn, beginning with `first`. */
export function deal(sectionIds: string[], present: string[], aliases: Record<string, string>, first: string): Record<string, string> {
	const order = [...present].sort((a, b) => (aliases[a] ?? "").localeCompare(aliases[b] ?? "")), at = Math.max(0, order.indexOf(first));
	return Object.fromEntries(sectionIds.map((id, i) => [id, order[(at + i) % order.length]!]));
}
