// The plan task, the forum's only kind of task: a brief, the language of the document, optionally an outline to keep
// and criteria of the person's own (docs/gemeinsame-planung-plan-2026-11-22.en.md, sections 4 and 9). Sources follow
// with phase 3.
export const TASK_LIMITS = { brief: 8000, outline: 20, heading: 120, criteria: 12, criterion: 200 };

/** A plan task as its block's PlanTask entry holds it. */
export type PlanTask = { session: string; blockId: string; brief: string; lang: "de" | "en";
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
/** All criteria of a task: the fixed ones, then the person's. */
export const criteriaOf = (t: Pick<PlanTask, "criteria">) => [...FIXED_CRITERIA, ...t.criteria];

/** Lines of a field that is a list (an array, or text with one item a line); list markers are dropped. */
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/\r?\n/) : []).map((l) => l.replace(/^\s*(?:[-*•]|#{1,6}|\d+[.)])\s*/, "").trim()).filter(Boolean);

/** What a person hands in, checked: the brief, the language, the outline and the criteria. Throws what is wrong. */
export function planTask(x: { brief?: unknown; lang?: unknown; outline?: unknown; criteria?: unknown }): Pick<PlanTask, "brief" | "lang" | "outline" | "criteria"> {
	const brief = String(x.brief ?? "").replace(/\r\n/g, "\n").trim();
	if (brief.length < 20) throw new Error("The brief needs at least 20 characters: say what the plan is for");
	if (brief.length > TASK_LIMITS.brief) throw new Error(`The brief has at most ${TASK_LIMITS.brief} characters`);
	const outline = lines(x.outline), criteria = lines(x.criteria);
	if (outline.length > TASK_LIMITS.outline || outline.some((h) => h.length > TASK_LIMITS.heading)) throw new Error(`An outline has at most ${TASK_LIMITS.outline} headings of up to ${TASK_LIMITS.heading} characters`);
	if (new Set(outline.map((h) => h.toLowerCase())).size !== outline.length) throw new Error("The outline names a heading twice");
	if (criteria.length > TASK_LIMITS.criteria || criteria.some((c) => c.length > TASK_LIMITS.criterion)) throw new Error(`At most ${TASK_LIMITS.criteria} criteria of up to ${TASK_LIMITS.criterion} characters`);
	return { brief, lang: x.lang === "de" ? "de" : "en", outline, criteria };
}
