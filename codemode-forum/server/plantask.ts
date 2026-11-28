// A task of a room: a brief, the language of the document, optionally an outline to keep and criteria of the person's
// own (docs/gemeinsame-planung-plan-2026-11-22.en.md, sections 4 and 9). Its kind (docs/forum-seite-plan-2026-11-26.en.md,
// section 6, *A room is a project*): a plan, held against the forum's seven criteria, or a document (requirements, an
// architecture, a comparison), held against three that fit any document and the person's own. A document has a name,
// the file it is saved as.
export const TASK_LIMITS = { brief: 8000, outline: 20, heading: 120, criteria: 12, criterion: 200 };

/** A plan task as its block's PlanTask entry holds it. */
export type PlanTask = { session: string; blockId: string; brief: string; lang: "de" | "en";
	/** The kind of task; missing: a plan (every task before kinds was one). */
	kind?: "document";
	/** The document's name (a document has one; a plan may): the file it is saved as, `<name>.md`. */
	name?: string;
	/** Headings the document must keep, in this order; empty: the models propose the outline. */
	outline: string[];
	/** The person's own criteria, checked beside the fixed ones. */
	criteria: string[]; ts: number };

/** The criteria every plan is held against (section 9 of the plan). */
export const FIXED_CRITERIA = [
	"The plan answers the brief and names what it leaves out.",
	"Every step says what changes, where (files, modules, formats), and in which order.",
	"Dependencies between steps are named, and no step needs a later one.",
	"Every phase ends runnable and has a check that can fail.",
	"Risks and the way back are named for the steps that change stored data or shared servers.",
	"Open decisions are listed with a recommendation each, not hidden in the text.",
	"Effort and cost are estimated where the sources allow it, and marked as a guess where they do not.",
];
/** The criteria every document that is not a plan is held against, beside the person's own. */
export const DOCUMENT_CRITERIA = [
	"The document answers the brief and names what it leaves out.",
	"Every statement that rests on a source names that source.",
	"Open decisions are listed with a recommendation each, not hidden in the text.",
];
/** All criteria of a task: the fixed ones of its kind, then the person's. */
export const criteriaOf = (t: Pick<PlanTask, "criteria" | "kind">) => [...(t.kind === "document" ? DOCUMENT_CRITERIA : FIXED_CRITERIA), ...t.criteria];
/** A name a document is known by in the room and saved as: letters, digits, blanks, dashes, at most 60. */
export function taskName(raw: unknown): string | undefined {
	const n = String(raw ?? "").replace(/\.md$/i, "").replace(/\s+/g, " ").trim();
	if (!n) return undefined;
	if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u.test(n)) throw new Error("A document's name: letters, digits, blanks and dashes, at most 60, beginning with a letter or digit");
	return n;
}

/** Lines of a field that is a list (an array, or text with one item a line); list markers are dropped. */
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/\r?\n/) : []).map((l) => l.replace(/^\s*(?:[-*•]|#{1,6}|\d+[.)])\s*/, "").trim()).filter(Boolean);

/** What a person hands in, checked: the brief, the language, the outline and the criteria. Throws what is wrong. */
export function planTask(x: { brief?: unknown; lang?: unknown; outline?: unknown; criteria?: unknown; kind?: unknown; name?: unknown }): Pick<PlanTask, "brief" | "lang" | "outline" | "criteria" | "kind" | "name"> {
	const brief = String(x.brief ?? "").replace(/\r\n/g, "\n").trim();
	if (brief.length < 20) throw new Error("The brief needs at least 20 characters: say what the plan is for");
	if (brief.length > TASK_LIMITS.brief) throw new Error(`The brief has at most ${TASK_LIMITS.brief} characters`);
	const outline = lines(x.outline), criteria = lines(x.criteria);
	if (outline.length > TASK_LIMITS.outline || outline.some((h) => h.length > TASK_LIMITS.heading)) throw new Error(`An outline has at most ${TASK_LIMITS.outline} headings of up to ${TASK_LIMITS.heading} characters`);
	if (new Set(outline.map((h) => h.toLowerCase())).size !== outline.length) throw new Error("The outline names a heading twice");
	if (criteria.length > TASK_LIMITS.criteria || criteria.some((c) => c.length > TASK_LIMITS.criterion)) throw new Error(`At most ${TASK_LIMITS.criteria} criteria of up to ${TASK_LIMITS.criterion} characters`);
	const kind = x.kind === "document" ? "document" as const : undefined, name = taskName(x.name);
	if (x.kind !== undefined && x.kind !== null && x.kind !== "" && x.kind !== "plan" && x.kind !== "document") throw new Error("A task is a plan or a document");
	if (kind && !name) throw new Error("A document needs a name: the file it is saved as");
	return { brief, lang: x.lang === "de" ? "de" : "en", outline, criteria, ...(kind ? { kind } : {}), ...(name ? { name } : {}) };
}
