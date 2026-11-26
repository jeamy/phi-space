// Both tables in one run (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 7): which way of working supplies
// the result.
//
//   PlanCompare       one model's blind comparison of the two tables' documents: which it prefers, why per criterion,
//                     and what each document does better than the other (a point names the section where that is and
//                     the section of the other document where it would belong).
//   PlanResult        the result of a run with both tables: a table and a version of its document.
//   PlanStrategyStat  how a run with both tables went: rounds, cost and approvals of each table, which was the base and
//                     why, what the final round took over, the result. The page adds them up over all runs.
//
// A model sees the documents as X and Y, without table or author; which table is X changes from model to model (by its
// name at the table), so a liking for the first one cancels out.
import type { SpaceLike } from "phi-spaces";

export type TableId = "A" | "B";
export const other = (t: TableId): TableId => (t === "A" ? "B" : "A");
export const COMPARE_LIMITS = { points: 3, final: 6, text: 400 };
export type Point = { table: TableId; from: string; fromTitle: string; into: string; intoTitle: string; text: string };
export type PlanCompare = { session: string; blockId: string; runId: string; model: string; author: string; prefer: TableId; criteria: Array<{ n: number; prefer: TableId; text: string }>; points: Point[]; ts: number };
export type PlanResult = { session: string; blockId: string; runId: string; table: TableId; version: number; ts: number };
export type TableStat = { rounds: number; tokens: number; costUsd: number; accepted: boolean; approvals: number; ended?: string };
export type PlanStrategyStat = { session: string; blockId: string; runId: string; models: string[]; tables: Partial<Record<TableId, TableStat>>;
	/** The table whose document was the base, and why: its version was the only one accepted, the comparison preferred
	 *  it, or it was the only document. */
	base: TableId; how: "accepted" | "compared" | "only"; prefer?: Record<TableId, number>;
	/** The final round: the points of the comparison, how many the table agreed to take over, and whether its ballot passed. */
	final?: { points: number; agreed: number; accepted: boolean }; result: { table: TableId; version: number }; ts: number };

/** Which table a model sees as X: A for the odd names at the table (M1, M3, …), B for the even ones. */
export const sides = (alias: string): { X: TableId; Y: TableId } => (Number(alias.replace(/\D/g, "")) % 2 === 0 ? { X: "B", Y: "A" } : { X: "A", Y: "B" });

type Sections = Array<{ sectionId: string; title: string }>;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** A comparison as a model wrote it: `PREFER: X` or `Y`; under CRITERIA a line per criterion, `2 Y: why`; then what
 *  each does better, `better X: what | from: "<heading in X>" | into: "<heading in Y>"`, at most three a document. A
 *  point that names no section of the one and of the other is none. Throws when it prefers neither. */
export function parseCompare(text: string, side: { X: TableId; Y: TableId }, docs: Record<TableId, Sections>): Pick<PlanCompare, "prefer" | "criteria" | "points"> {
	const body = text.replace(/\r\n/g, "\n"), to = (l: string) => side[l.toUpperCase() as "X" | "Y"];
	const pref = /^\W*PREFER\s*:?\s*\**\s*(X|Y)\b/im.exec(body)?.[1];
	if (!pref) throw new Error("the comparison prefers neither: its first line is PREFER: X or PREFER: Y");
	const criteria: PlanCompare["criteria"] = [], points: Point[] = [];
	const find = (t: TableId, title: string) => docs[t].find((s) => s.title.toLowerCase() === title.trim().toLowerCase());
	for (const raw of body.split("\n")) {
		const line = raw.trim().replace(/^[-*]\s+/, "");
		const c = /^(\d{1,2})[.)]?\s+(X|Y)\s*:\s*(.*)$/i.exec(line);
		if (c && !criteria.some((x) => x.n === Number(c[1]))) { criteria.push({ n: Number(c[1]), prefer: to(c[2]!), text: clip(c[3]!.trim(), COMPARE_LIMITS.text) }); continue; }
		const b = /^better\s+(X|Y)\s*:\s*(.+)$/i.exec(line);
		if (!b) continue;
		const table = to(b[1]!), parts = b[2]!.split(/\s*\|\s*(?=(?:from|into)\s*:)/i), unq = (p?: string) => p?.replace(/^(?:from|into)\s*:\s*/i, "").trim().replace(/^["“](.*)["”]$/, "$1");
		const from = find(table, unq(parts.find((p) => /^from\s*:/i.test(p))) ?? ""), into = find(other(table), unq(parts.find((p) => /^into\s*:/i.test(p))) ?? "");
		if (!from || !into || !parts[0]!.trim() || points.filter((p) => p.table === table).length >= COMPARE_LIMITS.points) continue;
		points.push({ table, from: from.sectionId, fromTitle: from.title, into: into.sectionId, intoTitle: into.title, text: clip(parts[0]!.trim(), COMPARE_LIMITS.text) });
	}
	return { prefer: to(pref), criteria: criteria.sort((a, b) => a.n - b.n), points };
}

/** The base of the final round. A table whose version alone was accepted is it. Else the comparison decides: the
 *  document more models prefer; among equals the table that spent less (then A). */
export function baseOf(o: { accepted: Record<TableId, boolean>; compares: Array<{ prefer: TableId }>; tokens: Record<TableId, number> }): { table: TableId; how: "accepted" | "compared"; prefer: Record<TableId, number> } {
	const prefer = { A: o.compares.filter((c) => c.prefer === "A").length, B: o.compares.filter((c) => c.prefer === "B").length };
	if (o.accepted.A !== o.accepted.B) return { table: o.accepted.A ? "A" : "B", how: "accepted", prefer };
	return { table: prefer.A !== prefer.B ? (prefer.A > prefer.B ? "A" : "B") : o.tokens.B < o.tokens.A ? "B" : "A", how: "compared", prefer };
}

/** What the final round is to consider: the points for the document that is not the base, one per pair of sections
 *  (the first named), at most six. */
export const pointsFor = (compares: PlanCompare[], base: TableId): Point[] => {
	const out: Point[] = [];
	for (const p of compares.flatMap((c) => c.points)) if (p.table !== base && !out.some((x) => x.from === p.from && x.into === p.into)) out.push(p);
	return out.slice(0, COMPARE_LIMITS.final);
};

export async function comparesOf(space: SpaceLike, session: string, runId: string, txn: string | null = null): Promise<PlanCompare[]> {
	return (await space.readAll({ type: "PlanCompare", fields: { session, runId } }, { limit: 20, txn })).map((e) => e.fields as unknown as PlanCompare).sort((a, b) => a.ts - b.ts);
}
export async function resultOf(space: SpaceLike, session: string, blockId: string): Promise<PlanResult | null> {
	return ((await space.readAll({ type: "PlanResult", fields: { session, blockId } }, { limit: 20 })).map((e) => e.fields as unknown as PlanResult).sort((a, b) => b.ts - a.ts)[0]) ?? null;
}
/** The standings over all runs with both tables: how often each table was the base of the result. */
export async function standings(space: SpaceLike): Promise<{ runs: number; A: number; B: number; tokens: Record<TableId, number> }> {
	const stats = (await space.readAll({ type: "PlanStrategyStat" }, { limit: 2000 })).map((e) => e.fields as unknown as PlanStrategyStat);
	const sum = (t: TableId) => stats.reduce((n, s) => n + (s.tables[t]?.tokens ?? 0), 0);
	return { runs: stats.length, A: stats.filter((s) => s.base === "A").length, B: stats.filter((s) => s.base === "B").length, tokens: { A: sum("A"), B: sum("B") } };
}
