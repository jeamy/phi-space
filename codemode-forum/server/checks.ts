// The mechanical checks of a plan document (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 9): what a program
// can tell about a plan without a model, run on every version before anyone votes on it. A text has no sandbox, but a
// plan over sources has facts:
//
//   path      every file or directory the plan names is in a source of the task, or the plan marks it as new;
//   quote     every line the plan quotes from a file is in that file;
//   section   the sections the person fixed are there, and every section is written;
//   phase     the plan names its phases, and each says how it is verified;
//   link      a link to another section leads to one;
//   size      the sections and the document are within their limits.
//
// The checks need a form they can read, which the writer is told (CONVENTIONS): paths in backticks, a new file marked
// "(new)" after its name, a quote as a line `> \`path\`: the line`, phases numbered "Phase 1", "Phase 2", ….
import { DOC_LIMITS, type FullDoc } from "./plandoc.ts";
import type { PlanTask } from "./plantask.ts";

export type CheckName = "path" | "quote" | "section" | "phase" | "link" | "size";
/** What a check found wrong: in which section (none: the document as a whole), and what would mend it. */
export type Failure = { check: CheckName; sectionId?: string; text: string };
/** The result of the checks of one version, as its PlanCheck entry holds it. `counted`: what was looked at. */
export type PlanCheck = { session: string; blockId: string; table: string; version: number; ok: boolean; failures: Failure[]; counted: { paths: number; quotes: number; phases: number; links: number }; ts: number };
/** The files of the task's sources, for the path and quote checks: every path, and the source it is in. */
export type SourceFiles = Map<string, string>;

/** What the writer is told, so that its text can be checked. */
export const CONVENTIONS = [
	"A program checks the document before anyone votes on it. Write so that it can:",
	"- Name files and directories in backticks, by their path from the top of the source, exactly as they are there. One the plan creates is marked right after its name: `path/to/new-file.ts` (new).",
	"- Quote a line of a source as a line of its own, in this form:  > `path/to/file.ts`: the line as it stands there",
	"- Number the phases of the plan (\"Phase 1\", \"Phase 2\", …) and say for each how it is verified: a test or a check that can fail.",
	"- Link another section as [its title](#its-title-in-lower-case-with-dashes).",
].join("\n");
/** The same for a document that is not a plan: it has no phases. */
export const DOCUMENT_CONVENTIONS = CONVENTIONS.split("\n").filter((l) => !l.startsWith("- Number the phases")).join("\n").replace("One the plan creates is marked", "One that does not exist yet is marked");
export const conventionsOf = (t: Pick<PlanTask, "kind">) => (t.kind === "document" ? DOCUMENT_CONVENTIONS : CONVENTIONS);

/** File endings by which a name without a slash counts as a file. */
const ENDINGS = /\.(tsx?|jsx?|mjs|cjs|json|md|markdown|rs|toml|css|scss|html?|ya?ml|sh|sql|py|go|java|kt|c|h|cpp|txt|csv|lock|svg|png|jpe?g|gif|webp|env|conf|ini|xml|proto|glsl|wgsl|vue|svelte)$/i;
const NEW = /^\s*\((?:new|neu|to be created|wird angelegt|entsteht)\b[^)]*\)/i;
const VERIFIED = /verif|\btest|check|prüf|pruef|abnahme|acceptance|nachweis|\bmess|measur/i;
const PHASE = /^[\s>#*|\-\d.)]*\**\s*(?:phase|step|stage|schritt|etappe|stufe)\s+(\d+)/i;

/** The anchor of a section title, as a link names it. */
export const anchorOf = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
/** The text without its fenced code blocks: what stands in them is an example, not a claim about the sources. */
const withoutFences = (text: string) => text.replace(/^```[\s\S]*?^```\s*$/gm, (b) => b.replace(/[^\n]/g, " "));

/** The directories of the sources: every prefix of a file's path. */
function dirsOf(files: SourceFiles): Set<string> {
	const dirs = new Set<string>();
	for (const path of files.keys()) for (let cut = path.indexOf("/"); cut > 0; cut = path.indexOf("/", cut + 1)) dirs.add(path.slice(0, cut));
	return dirs;
}

/** The backticked names of a text that are meant as paths of the sources, each with whether the plan marks it as new.
 *  A name counts as a path when it has no blank and no call or option in it, and either begins with a directory the
 *  sources have at their top, or ends like a file. */
export function pathsIn(text: string, tops: Set<string>): Array<{ path: string; isNew: boolean }> {
	const out: Array<{ path: string; isNew: boolean }> = [];
	for (const m of withoutFences(text).matchAll(/`([^`\n]+)`/g)) {
		const raw = m[1]!.trim(), path = raw.replace(/^\.\//, "").replace(/\/+$/, "").replace(/:\d+(-\d+)?$/, "");
		if (!/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(path) || /^\d/.test(path) && !path.includes("/") || path.startsWith("-")) continue;
		const first = path.split("/")[0]!;
		if (path.includes("/") ? !tops.has(first) && !ENDINGS.test(path) : !ENDINGS.test(path)) continue;
		const end = m.index + m[0].length; // the same place in the text itself: a fence is blanked out, not cut
		out.push({ path, isNew: NEW.test(text.slice(end, end + 60)) });
	}
	return out;
}

/** The quotes of a text: `> \`path\`: line`. */
export function quotesIn(text: string): Array<{ path: string; line: string }> {
	return [...withoutFences(text).matchAll(/^\s*>\s*`([^`\n]+)`\s*:\s*(.+)$/gm)].map((m) => ({ path: m[1]!.trim().replace(/^\.\//, "").replace(/:\d+(-\d+)?$/, ""), line: m[2]!.trim().replace(/^`(.*)`$/, "$1") }));
}

/** The phases a text names, each with the text up to the next one. */
export function phasesIn(text: string): Array<{ n: number; text: string }> {
	const out: Array<{ n: number; text: string }> = [];
	for (const line of withoutFences(text).split("\n")) {
		const m = PHASE.exec(line);
		if (m) out.push({ n: Number(m[1]), text: line }); else if (out.length) out.at(-1)!.text += `\n${line}`;
	}
	return out;
}

/** Runs the checks on a version. `files`: the task's source files (null: the task has no sources, and paths and
 *  quotes are not checked). `quoted`: whether a file of a source holds a line (asked of the sources process). */
export async function checkDoc(doc: FullDoc, task: Pick<PlanTask, "outline" | "kind">, files: SourceFiles | null, quoted: (source: string, path: string, line: string) => Promise<boolean>): Promise<Pick<PlanCheck, "ok" | "failures" | "counted">> {
	const failures: Failure[] = [], counted = { paths: 0, quotes: 0, phases: 0, links: 0 };
	const fail = (check: CheckName, text: string, sectionId?: string) => { if (failures.length < 60) failures.push({ check, ...(sectionId ? { sectionId } : {}), text }); };
	const dirs = files ? dirsOf(files) : new Set<string>(), tops = new Set([...(files?.keys() ?? [])].map((p) => p.split("/")[0]!));
	const names = new Map<string, number>(); // the last part of every path: a single name is a file when one ends with it
	for (const p of files?.keys() ?? []) { const n = p.split("/").at(-1)!; names.set(n, (names.get(n) ?? 0) + 1); }
	const anchors = new Set(doc.sections.map((s) => anchorOf(s.title)));
	// a plan without a repository among its sources (uploaded documents only) builds something new: every file it names
	// is one it creates, marked or not
	const repo = [...(files?.values() ?? [])].some((source) => source === "repo");

	// section: what the person fixed is there, and every section is written
	const titles = new Set(doc.sections.map((s) => s.title.toLowerCase()));
	for (const h of task.outline) if (!titles.has(h.toLowerCase())) fail("section", `The section "${h}" the person asked for is missing.`);
	for (const s of doc.sections) if (s.rev === 1 || !s.text.trim()) fail("section", `The section "${s.title}" is not written yet.`, s.sectionId);

	const phases: Array<{ n: number; text: string; sectionId: string }> = [];
	for (const s of doc.sections) {
		if (s.rev === 1) continue; // only says what it is to say
		// size
		if (Buffer.byteLength(s.text) > DOC_LIMITS.sectionBytes) fail("size", `The section "${s.title}" has ${Buffer.byteLength(s.text)} bytes; a section holds at most ${DOC_LIMITS.sectionBytes}.`, s.sectionId);
		// path
		if (files) {
			const seen = new Set<string>();
			for (const { path, isNew } of pathsIn(s.text, tops)) {
				if (seen.has(path)) continue;
				seen.add(path); counted.paths++;
				const there = files.has(path) || dirs.has(path) || (!path.includes("/") && names.has(path));
				if (!there && !isNew && repo) fail("path", `\`${path}\` is not in the sources. Name it as it is there, or mark it as new: \`${path}\` (new).`, s.sectionId);
				else if (there && isNew) fail("path", `\`${path}\` is marked as new, but it is in the sources already.`, s.sectionId);
			}
			// quote
			for (const q of quotesIn(s.text)) {
				counted.quotes++;
				const source = files.get(q.path);
				if (!source) fail("quote", `A line is quoted from \`${q.path}\`, which is not a file of the sources.`, s.sectionId);
				else if (!(await quoted(source, q.path, q.line))) fail("quote", `\`${q.path}\` has no line "${q.line.slice(0, 120)}". Quote it as it stands there, or do not quote.`, s.sectionId);
			}
		}
		// link
		for (const m of withoutFences(s.text).matchAll(/\]\(#([^)\s]*)\)/g)) { counted.links++; if (!anchors.has(m[1]!.toLowerCase())) fail("link", `The link #${m[1]} leads to no section. The sections are: ${[...anchors].map((a) => `#${a}`).join(", ")}.`, s.sectionId); }
		for (const p of phasesIn(s.text)) phases.push({ ...p, sectionId: s.sectionId });
	}
	// phase: there are some, and each says how it is verified (a plan's; a document of another kind has none to name)
	counted.phases = new Set(phases.map((p) => p.n)).size;
	const written = doc.sections.filter((s) => s.rev > 1);
	if (task.kind !== "document" && written.length && !phases.length) fail("phase", "The plan names no phases. Number them (\"Phase 1\", \"Phase 2\", …) and say for each how it is verified.", [...written].sort((a, b) => b.bytes - a.bytes)[0]!.sectionId);
	for (const n of task.kind === "document" ? [] : new Set(phases.map((p) => p.n))) {
		const of = phases.filter((p) => p.n === n);
		if (!of.some((p) => VERIFIED.test(p.text.replace(PHASE, "")))) fail("phase", `Phase ${n} does not say how it is verified: name a test or a check that can fail.`, of[0]!.sectionId);
	}
	// size
	if (doc.bytes > DOC_LIMITS.docBytes) fail("size", `The document has ${doc.bytes} bytes; it holds at most ${DOC_LIMITS.docBytes}.`);
	return { ok: failures.length === 0, failures, counted };
}
