// The plan document in the space: versions of sections, never one text (an entry holds at most 64 KiB, a commit
// 192 KiB; docs/gemeinsame-planung-plan-2026-11-22.en.md, section 4).
//
//   PlanSection  one revision of one section: its text, the revision it builds on, who wrote it.
//   PlanDoc      one version of a table's document: the ordered sections, each by id and revision.
//
// A new version writes only the sections that changed; the others are named by the revision they have. Two guards
// make concurrent writers safe, both `unique` fields:
//   - a section revision names the revision it builds on (`slot`: block, table, section, base). Of two writers of the
//     same section only the first gets in; the second is told the newer text (StaleSection) and works with that.
//   - a document version has one number (`slot`: block, table, version). Writers of different sections of the same
//     version do not exclude each other: the second one takes the next number, built on the first one's version.
import { createHash } from "node:crypto";
import { UniqueConflict, type SpaceLike } from "phi-spaces";

export const DOC_LIMITS = { sectionBytes: 24_000, docBytes: 96_000, sections: 40, title: 120 };

export type SectionRef = { sectionId: string; rev: number; title: string; hash: string; bytes: number;
	/** Who wrote this revision. */
	author: string; model: string };
export type PlanDoc = { session: string; blockId: string; table: string; version: number; slot: string;
	/** Who made this version, and which sections it changed. */
	author: string; model: string; changed: string[]; sections: SectionRef[]; bytes: number; ts: number };
export type PlanSection = { session: string; blockId: string; table: string; sectionId: string; rev: number; base: number; slot: string; title: string; text: string; hash: string; author: string; model: string; ts: number };
/** A document with its texts. */
export type FullDoc = Omit<PlanDoc, "sections"> & { sections: Array<SectionRef & { text: string }> };

/** A change of one section: a new revision of an existing one (`base`: the revision it was written against), or a new
 *  section (no `sectionId`), placed after `after` (a section id; null or missing: at the end, "": at the start). */
export type SectionChange = { sectionId?: string; base?: number; title?: string; text: string; after?: string | null };
/** What a writer asks for: changes, sections to drop, and optionally the whole order (ids; new ones by `sectionId`). */
export type Revision = { changes: SectionChange[]; remove?: string[]; order?: string[] };
export type Writer = { author: string; model: string };

/** Another writer revised the section first: `current` is what it is now. */
export class StaleSection extends Error {
	current: SectionRef & { text: string };
	constructor(current: SectionRef & { text: string }) { super(`section ${current.sectionId} was revised meanwhile (now revision ${current.rev})`); this.current = current; }
}
/** The change does not fit the document (a limit, an unknown section). */
export class DocRefused extends Error {}

const bytesOf = (s: string) => Buffer.byteLength(s, "utf8");
const hashOf = (title: string, text: string) => createHash("sha256").update(`${title}\n\n${text}`).digest("hex").slice(0, 16);
const key = (d: { session: string; blockId: string; table: string }) => ({ session: d.session, blockId: d.blockId, table: d.table });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A short id for a new section, unique in its document. */
const newId = (taken: Set<string>) => { for (let n = taken.size + 1; ; n++) { const id = `s${n}`; if (!taken.has(id)) { taken.add(id); return id; } } };

/** A title as the document keeps it: one line, no heading marks. */
export const cleanTitle = (t: string) => t.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
/** A section's text as the document keeps it. */
export const cleanText = (t: string) => t.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

/** The versions a table's document has (their numbers, oldest first, with who made each and what it changed). */
export async function versionsOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, txn: string | null = null): Promise<PlanDoc[]> {
	return (await space.readAll({ type: "PlanDoc", fields: key(d) }, { limit: 2000, txn })).map((e) => e.fields as unknown as PlanDoc).sort((a, b) => a.version - b.version);
}
/** The newest version of a table's document (null: none yet), or the one with number `version`. */
export async function headOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, version?: number, txn: string | null = null): Promise<PlanDoc | null> {
	if (version !== undefined) return ((await space.readAll({ type: "PlanDoc", fields: { ...key(d), version } }, { limit: 1, txn }))[0]?.fields as unknown as PlanDoc | undefined) ?? null;
	return (await versionsOf(space, d, txn)).at(-1) ?? null;
}
/** One revision of a section, with its text. */
export async function sectionOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, sectionId: string, rev: number, txn: string | null = null): Promise<PlanSection | null> {
	return ((await space.readAll({ type: "PlanSection", fields: { ...key(d), sectionId, rev } }, { limit: 1, txn }))[0]?.fields as unknown as PlanSection | undefined) ?? null;
}
/** A version with the texts of its sections. */
export async function fullDoc(space: SpaceLike, doc: PlanDoc, txn: string | null = null): Promise<FullDoc> {
	const sections = await Promise.all(doc.sections.map(async (ref) => ({ ...ref, text: (await sectionOf(space, doc, ref.sectionId, ref.rev, txn))?.text ?? "" })));
	return { ...doc, sections };
}

/** The document as Markdown: every section under its heading. */
export const renderMarkdown = (doc: FullDoc, title?: string): string => [...(title ? [`# ${title}`] : []), ...doc.sections.map((s) => `## ${s.title}\n\n${s.text}`.trimEnd())].join("\n\n") + "\n";

/** Writes a new version of a table's document in `txn`: the first one when there is none. Only the changed sections
 *  are written. One call per transaction. Throws StaleSection when a section was revised since the revision the change
 *  names, or is being revised by a transaction still open: the caller then aborts `txn` (the version's number may
 *  already be written in it) and works again with the newer text. Throws DocRefused when a limit is passed, before
 *  anything is written. Concurrent writers of other sections are waited for, up to `waitMs`. */
export async function writeVersion(space: SpaceLike, txn: string, ttl: number, d: { session: string; blockId: string; table: string }, who: Writer, r: Revision, waitMs = 20_000): Promise<PlanDoc> {
	for (const end = Date.now() + waitMs; ; ) {
		const head = await headOf(space, d);
		const next = build(d, who, head, r);
		// stale before anything is written: the section's newest revision is not the one the change was written against
		for (const c of r.changes) {
			if (!c.sectionId) continue;
			const now = head!.sections.find((s) => s.sectionId === c.sectionId)!;
			if (c.base !== undefined && c.base !== now.rev) throw new StaleSection({ ...now, text: (await sectionOf(space, d, now.sectionId, now.rev))?.text ?? "" });
		}
		// the version's number first: whoever gets it writes this version (another writer's number is taken at once, also
		// while its transaction is open; this one then builds on that version when it is there)
		try { await space.write({ type: "PlanDoc", fields: next.doc as never }, txn, ttl, { unique: ["slot"] }); }
		catch (e) {
			if (!(e instanceof UniqueConflict)) throw e;
			if (Date.now() > end) throw new Error("the document is busy: another writer holds its next version");
			await pause(150);
			continue;
		}
		for (const s of next.sections) {
			try { await space.write({ type: "PlanSection", fields: s as never }, txn, ttl, { unique: ["slot"] }); }
			catch (e) {
				if (!(e instanceof UniqueConflict)) throw e;
				// written by a transaction that is still open, or committed since the head was read
				const now = (await headOf(space, d))?.sections.find((x) => x.sectionId === s.sectionId);
				throw new StaleSection(now && now.rev !== s.base ? { ...now, text: (await sectionOf(space, d, now.sectionId, now.rev))?.text ?? "" } : { sectionId: s.sectionId, rev: s.base, title: s.title, hash: "", bytes: 0, author: "", model: "", text: "" });
			}
		}
		return next.doc;
	}
}

/** The next version from the head and a revision: the document entry and the section entries to write. */
function build(d: { session: string; blockId: string; table: string }, who: Writer, head: PlanDoc | null, r: Revision): { doc: PlanDoc; sections: PlanSection[] } {
	const refs = new Map((head?.sections ?? []).map((s) => [s.sectionId, s]));
	let order = (head?.sections ?? []).map((s) => s.sectionId);
	const taken = new Set(order), written: PlanSection[] = [], ts = Date.now();
	for (const id of r.remove ?? []) { if (!refs.has(id)) throw new DocRefused(`unknown section ${id}`); refs.delete(id); order = order.filter((x) => x !== id); }
	for (const c of r.changes) {
		const old = c.sectionId ? refs.get(c.sectionId) : undefined;
		if (c.sectionId && !old) throw new DocRefused(`unknown section ${c.sectionId}`);
		const title = cleanTitle(c.title ?? old?.title ?? ""), text = cleanText(c.text);
		if (!title) throw new DocRefused("a section needs a title");
		if (title.length > DOC_LIMITS.title) throw new DocRefused(`a section title has at most ${DOC_LIMITS.title} characters`);
		if (bytesOf(text) > DOC_LIMITS.sectionBytes) throw new DocRefused(`section "${title}" has ${bytesOf(text)} bytes; a section holds at most ${DOC_LIMITS.sectionBytes}`);
		const sectionId = old?.sectionId ?? newId(taken), base = old?.rev ?? 0, hash = hashOf(title, text);
		if (old && old.hash === hash) continue; // nothing changed: no new revision
		written.push({ ...key(d), sectionId, rev: base + 1, base, slot: `${d.blockId}:${d.table}:${sectionId}:${base}`, title, text, hash, author: who.author, model: who.model, ts });
		refs.set(sectionId, { sectionId, rev: base + 1, title, hash, bytes: bytesOf(text), author: who.author, model: who.model });
		if (!old) {
			const at = c.after === "" ? 0 : c.after ? order.indexOf(c.after) + 1 : order.length;
			order.splice(c.after && at === 0 ? order.length : at, 0, sectionId);
		}
	}
	if (r.order) {
		if (r.order.length !== order.length || new Set(r.order).size !== order.length || r.order.some((id) => !refs.has(id))) throw new DocRefused("the order must name every section once");
		order = r.order;
	}
	if (!written.length && !(r.remove?.length) && !r.order) throw new DocRefused("nothing changed");
	if (order.length > DOC_LIMITS.sections) throw new DocRefused(`a document has at most ${DOC_LIMITS.sections} sections`);
	if (!order.length) throw new DocRefused("a document needs a section");
	const sections = order.map((id) => refs.get(id)!);
	if (new Set(sections.map((s) => s.title.toLowerCase())).size !== sections.length) throw new DocRefused("two sections have the same title");
	const bytes = sections.reduce((n, s) => n + s.bytes + bytesOf(s.title) + 6, 0);
	if (bytes > DOC_LIMITS.docBytes) throw new DocRefused(`the document would have ${bytes} bytes; it holds at most ${DOC_LIMITS.docBytes}`);
	const version = (head?.version ?? 0) + 1;
	return { doc: { ...key(d), version, slot: `${d.blockId}:${d.table}:${version}`, author: who.author, model: who.model, changed: written.map((s) => s.sectionId), sections, bytes, ts }, sections: written };
}
