// The register of sources (docs/forum-seite-plan-2026-11-26.en.md, section 6, phase 7): every source a task of the
// room used is an entry of the room, and a person adds one by hand with its address and a note.
//
//   SourceRef   one source: its kind (a repository, the workspace copy, an uploaded document, another document of the
//               room, or a link a person added), its address, title, licence as far as known, who brought it and the
//               tasks that read it; its state: proposed, accepted, or declined with the reason, and who said so.
//
// A source of a task is proposed when the task is created; the same source read by a second task is the same entry
// (its ID is the hash of its kind and address), so a retried create and a second task add nothing but the task.
// Which sections cite a source is not stored: it is worked out from the documents as they stand, by the conventions
// the writers are told (checks.ts: a path in backticks, a quoted line), so a revision never leaves it stale.
// Not here yet (phase 9, with research): a source questioned and voted on at the table, and the checker's report on
// claims of an accepted document that rest on a source not accepted.
import { createHash } from "node:crypto";
import { NO_WAIT, UniqueConflict, type SpaceLike } from "phi-spaces";
import { pathsIn, quotesIn } from "./checks.ts";
import type { PlanSource } from "./sources.ts";
import { normalUrl, urlsIn, type WebResult } from "./research.ts";

export type RefKind = "repo" | "files" | "docs" | "room" | "link";
export type RefState = "proposed" | "accepted" | "declined";
/** A task that read the source: by which of its sources, and, for a source of several files that are separate
 *  sources here (uploaded documents, the room's documents), the path. */
export type RefUse = { blockId: string; sourceId: PlanSource["sourceId"] | "web"; path?: string };
export type SourceRef = { session: string; refId: string; kind: RefKind; address: string; title: string; licence?: string; note?: string; by: string; uses: RefUse[]; state: RefState; reason?: string; decidedBy?: string; ts: number; decidedTs?: number };
/** Where a source is cited: the task, its document's name and the section's title. */
export type Cite = { blockId: string; doc: string; section: string };

export const REGISTER_LIMITS = { refs: 300, title: 200, address: 500, note: 1000, reason: 600, licence: 120, uses: 30, vote: 8 };
/** The pseudo-block the register is saved under (files.ts PlanSave): its file's versions are its own. */
export const REGISTER_BLOCK = "register";
/** A source is one entry per room (SourceRef, unique by session and refId). */
const UNIQUE = { unique: ["session", "refId"] };

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const refIdOf = (kind: RefKind, address: string) => `r${createHash("sha256").update(`${kind}\n${address}`).digest("hex").slice(0, 20)}`;

export async function refsOf(space: SpaceLike, session: string, txn?: string): Promise<SourceRef[]> {
	return (await space.readAll({ type: "SourceRef", fields: { session } }, { limit: REGISTER_LIMITS.refs + 10, ...(txn ? { txn } : {}) })).map((e) => e.fields as unknown as SourceRef).sort((a, b) => a.ts - b.ts || a.refId.localeCompare(b.refId));
}

/** The sources a new task brings, as the register names them. `docs`: the uploaded documents' paths; `room`: the
 *  room's documents read, each with its path and the version taken. */
export type RefItem = Pick<SourceRef, "kind" | "address" | "title"> & { use: RefUse; by?: string; note?: string };
export function refsOfTask(blockId: string, sources: PlanSource[], o: { docs: string[]; room: Array<{ path: string; blockId: string; version: number; how: string }> }): RefItem[] {
	const out: RefItem[] = [];
	for (const s of sources) {
		if (s.kind === "repo") out.push({ kind: "repo", address: s.url ? `${s.url}@${s.commit}` : `${s.name}@${s.commit}`, title: `${s.url ?? s.name} at ${String(s.commit).slice(0, 12)}`, use: { blockId, sourceId: "repo" } });
		else if (s.kind === "files") out.push({ kind: "files", address: `workspace:${s.tenant ?? ""}:${s.copy}`, title: `the room's workspace as copied for this task (${s.files} files)`, use: { blockId, sourceId: "files" } });
	}
	for (const path of o.docs) out.push({ kind: "docs", address: `upload:${blockId}:${path}`, title: path, use: { blockId, sourceId: "docs", path } });
	for (const r of o.room) out.push({ kind: "room", address: `room:${r.blockId}@${r.version}`, title: `${r.path}, version ${r.version} (${r.how})`, use: { blockId, sourceId: "room", path: r.path } });
	return out;
}

/** Proposes the sources of a task: a new one as proposed, one already there gets the task as a further use. */
export async function proposeRefs(space: SpaceLike, ttl: number, session: string, by: string, items: RefItem[]): Promise<void> {
	if (!items.length) return;
	// a new entry is unique per room and source: of two writers proposing it at once (two ballots, the page), one
	// tries again and then finds it
	for (const end = Date.now() + 15_000; ; ) {
		try { return await proposeOnce(space, ttl, session, by, items); }
		catch (e) { if (!(e instanceof UniqueConflict) || Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 50 + Math.random() * 100)); }
	}
}
async function proposeOnce(space: SpaceLike, ttl: number, session: string, by: string, items: RefItem[]): Promise<void> {
	const t = await space.createTransaction(10_000);
	try {
		let count = await space.count({ type: "SourceRef", fields: { session } });
		for (const it of items) {
			const refId = refIdOf(it.kind, it.address), had = (await space.take({ type: "SourceRef", fields: { session, refId } }, NO_WAIT, { txn: t.id }))?.fields as unknown as SourceRef | undefined;
			if (had) {
				const known = had.uses.some((u) => u.blockId === it.use.blockId && u.sourceId === it.use.sourceId && u.path === it.use.path);
				await space.write({ type: "SourceRef", fields: { ...had, uses: known ? had.uses : [...had.uses, it.use].slice(-REGISTER_LIMITS.uses) } as never }, t.id, ttl);
				continue;
			}
			if (count >= REGISTER_LIMITS.refs) break; // the register is full: the task reads it anyway, the register says nothing
			count++;
			const ref: SourceRef = { session, refId, kind: it.kind, address: clip(it.address, REGISTER_LIMITS.address), title: clip(it.title, REGISTER_LIMITS.title), by: it.by ?? by, ...(it.note ? { note: clip(it.note, REGISTER_LIMITS.note) } : {}), uses: [it.use], state: "proposed", ts: Date.now() };
			await space.write({ type: "SourceRef", fields: ref as never }, t.id, ttl, UNIQUE);
		}
		await space.commit(t.id);
	} catch (e) { await space.abort(t.id).catch(() => {}); throw e; }
}

/** A source a person adds by hand: an http(s) address with a title and a note. The same address again is the same
 *  entry (a retry after a lost reply): `again`. */
export async function addRef(space: SpaceLike, ttl: number, session: string, o: { address?: unknown; title?: unknown; note?: unknown; licence?: unknown; by: string }): Promise<{ ref: SourceRef; again: boolean }> {
	const address = clip(o.address, REGISTER_LIMITS.address);
	let url: URL;
	try { url = new URL(address); } catch { throw new Error("A source added by hand is named by its address (https://…)"); }
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("A source added by hand is named by its address (https://…)");
	const title = clip(o.title, REGISTER_LIMITS.title) || url.hostname;
	const refId = refIdOf("link", normalUrl(url.href) ?? url.href);
	const had = (await space.readIfExists({ type: "SourceRef", fields: { session, refId } }, NO_WAIT))?.fields as unknown as SourceRef | undefined;
	if (had) return { ref: had, again: true };
	if ((await space.count({ type: "SourceRef", fields: { session } })) >= REGISTER_LIMITS.refs) throw new Error(`A room's register holds at most ${REGISTER_LIMITS.refs} sources`);
	const ref: SourceRef = { session, refId, kind: "link", address: url.href, title, ...(clip(o.note, REGISTER_LIMITS.note) ? { note: clip(o.note, REGISTER_LIMITS.note) } : {}), ...(clip(o.licence, REGISTER_LIMITS.licence) ? { licence: clip(o.licence, REGISTER_LIMITS.licence) } : {}), by: o.by, uses: [], state: "proposed", ts: Date.now() };
	try { await space.write({ type: "SourceRef", fields: ref as never }, null, ttl, UNIQUE); }
	catch (e) {
		if (!(e instanceof UniqueConflict)) throw e;
		const now = (await space.readIfExists({ type: "SourceRef", fields: { session, refId } }, 5_000))?.fields as unknown as SourceRef | undefined;
		if (now) return { ref: now, again: true };
		throw new Error("The register is busy, try again");
	}
	return { ref, again: false };
}

/** A person's word on a source: accepted, declined (with the reason) or proposed again; the licence as found. */
export async function decideRef(space: SpaceLike, ttl: number, session: string, o: { refId?: unknown; state?: unknown; reason?: unknown; licence?: unknown; by: string }): Promise<{ ref: SourceRef; changed: boolean }> {
	const state = o.state, reason = clip(o.reason, REGISTER_LIMITS.reason);
	if (state !== "accepted" && state !== "declined" && state !== "proposed") throw new Error("state: accepted, declined or proposed");
	if (state === "declined" && !reason) throw new Error("A declined source needs the reason");
	const t = await space.createTransaction(10_000);
	try {
		const had = (await space.take({ type: "SourceRef", fields: { session, refId: String(o.refId ?? "") } }, NO_WAIT, { txn: t.id }))?.fields as unknown as SourceRef | undefined;
		if (!had) throw new Error("No such source in the register");
		const licence = o.licence === undefined ? had.licence : clip(o.licence, REGISTER_LIMITS.licence) || undefined;
		const { reason: _r, decidedBy: _d, decidedTs: _t, licence: _l, ...rest } = had;
		const ref: SourceRef = { ...rest, ...(licence ? { licence } : {}), state, ...(state === "declined" ? { reason } : {}), ...(state === "proposed" ? {} : { decidedBy: o.by, decidedTs: Date.now() }) };
		const changed = had.state !== ref.state || had.reason !== ref.reason || had.licence !== ref.licence;
		await space.write({ type: "SourceRef", fields: ref as never }, t.id, ttl);
		await space.commit(t.id);
		return { ref, changed };
	} catch (e) { await space.abort(t.id).catch(() => {}); throw e; }
}

/** The sections that cite each source, in the documents as given (each task's chosen version): a path of the task's
 *  sources in backticks or a quoted line names the source that file is in; a link is cited where its address stands. */
export function citesOf(refs: SourceRef[], docs: Array<{ blockId: string; doc: string; files: Map<string, string> | null; sections: Array<{ title: string; text: string }> }>): Map<string, Cite[]> {
	const out = new Map<string, Cite[]>(refs.map((r) => [r.refId, []]));
	for (const d of docs) {
		const tops = new Set([...(d.files?.keys() ?? [])].map((p) => p.split("/")[0]!));
		for (const s of d.sections) {
			const named = new Set([...pathsIn(s.text, tops).map((x) => x.path), ...quotesIn(s.text).map((x) => x.path)]);
			for (const r of refs) {
				const hit = r.kind === "link" ? urlsIn(s.text).includes(r.address)
					: r.uses.some((u) => u.blockId === d.blockId && [...named].some((p) => d.files?.get(p) === u.sourceId && (!u.path || u.path === p)));
				if (hit) out.get(r.refId)!.push({ blockId: d.blockId, doc: d.doc, section: s.title });
			}
		}
	}
	return out;
}

/** The addresses the documents cite that the register does not have yet, as links to propose: a result of a web search
 *  of the task with who found it and the query; any other with who wrote it and that it was named without a search (a
 *  model's memory: nobody has checked it). Nothing is fetched to name them. */
export function citedLinks(refs: SourceRef[], docs: Array<{ blockId: string; sections: Array<{ text: string; author: string; model: string }> }>, results: WebResult[]): RefItem[] {
	const have = new Set(refs.filter((r) => r.kind === "link").map((r) => r.address)), out = new Map<string, RefItem>();
	for (const d of docs) for (const s of d.sections) for (const url of urlsIn(s.text)) {
		if (have.has(url) || out.has(url)) continue;
		const found = results.find((x) => x.blockId === d.blockId && normalUrl(x.url) === url) ?? results.find((x) => normalUrl(x.url) === url);
		const u = new URL(url);
		out.set(url, found
			? { kind: "link", address: url, title: found.title || u.hostname, by: found.by, note: `found by a web search for "${found.query}"`, use: { blockId: found.blockId, sourceId: "web" } }
			: { kind: "link", address: url, title: `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`, by: s.model === "human" ? s.author : `${s.author} (${s.model})`, note: s.model === "human" ? "named by a person in the document" : "named without a search, from the model's memory: nobody has opened it", use: { blockId: d.blockId, sourceId: "web" } });
	}
	return [...out.values()];
}

/** The links a version cites that are still to be decided (proposed, or not in the register yet): what a ballot is
 *  asked about. A person's word stands: a source a person decided is not put to the table. */
export function linksToVote(refs: SourceRef[], blockId: string, sections: Array<{ text: string; author: string; model: string }>, results: WebResult[]): Array<{ address: string; title: string; by: string; note?: string }> {
	const cited = new Set(sections.flatMap((s) => urlsIn(s.text)));
	const known = refs.filter((r) => r.kind === "link" && r.state === "proposed" && cited.has(r.address)).map((r) => ({ address: r.address, title: r.title, by: r.by, ...(r.note ? { note: r.note } : {}) }));
	const fresh = citedLinks(refs, [{ blockId, sections }], results).map((r) => ({ address: r.address, title: r.title, by: r.by ?? "a model", ...(r.note ? { note: r.note } : {}) }));
	return [...known, ...fresh].slice(0, REGISTER_LIMITS.vote);
}
/** A model's word on a source in its ballot: `source <address> keep` or `source <address> question: <why>`. */
export function parseSourceVotes(text: string): Array<{ address: string; keep: boolean; why?: string }> {
	const out: Array<{ address: string; keep: boolean; why?: string }> = [];
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const m = /^\s*[-*]?\s*source\s+<?(https?:\/\/[^\s>]+?)>?\s*:?\s+(keep|question)\b\s*:?\s*(.*)$/i.exec(raw);
		const address = m && normalUrl(m[1]!.replace(/[.,;]+$/, ""));
		if (!m || !address || out.some((x) => x.address === address)) continue;
		const keep = m[2]!.toLowerCase() === "keep", why = m[3]!.trim().slice(0, REGISTER_LIMITS.reason);
		out.push({ address, keep, ...(!keep && why ? { why } : {}) });
	}
	return out;
}
/** A model's vote on a source in one round of ballots. */
export type SourceVote = { session: string; blockId: string; runId: string; round: number; address: string; model: string; keep: boolean; why?: string; ts: number };

/** The table's word on a source, from the votes of a round: more than half of the models at the table keep it
 *  (accepted) or question it (declined, with their reasons). A source a person decided is left as it is. */
export async function tableDecides(space: SpaceLike, txn: string, ttl: number, session: string, address: string, votes: SourceVote[], present: string[], aliases: Record<string, string>): Promise<SourceRef | null> {
	const keep = votes.filter((v) => v.keep), ask = votes.filter((v) => !v.keep), half = present.length / 2;
	const state = keep.length > half ? "accepted" : ask.length > half ? "declined" : null;
	if (!state) return null;
	const had = (await space.take({ type: "SourceRef", fields: { session, refId: refIdOf("link", address) } }, NO_WAIT, { txn }))?.fields as unknown as SourceRef | undefined;
	if (!had) return null;
	if (had.state !== "proposed") { await space.write({ type: "SourceRef", fields: had as never }, txn, ttl); return null; }
	const names = (vs: SourceVote[]) => vs.map((v) => aliases[v.model] ?? v.model).sort().join(", ");
	const ref: SourceRef = { ...had, state, decidedBy: `the table (${names(state === "accepted" ? keep : ask)} of ${present.length})`, decidedTs: Date.now(), ...(state === "declined" ? { reason: clip([...ask].sort((a, b) => (aliases[a.model] ?? a.model).localeCompare(aliases[b.model] ?? b.model)).map((v) => `${aliases[v.model] ?? v.model}: ${v.why ?? "questioned"}`).join("; "), REGISTER_LIMITS.reason) } : {}) };
	await space.write({ type: "SourceRef", fields: ref as never }, txn, ttl);
	return ref;
}

const T = {
	en: { title: "Sources", generated: (d: string) => `The register of sources of this room, written by codemode-forum on ${d}. No model wrote this file.`, none: "The room has no sources.", states: { accepted: "Accepted", proposed: "Proposed, not decided", declined: "Declined" }, kinds: { repo: "repository", files: "workspace", docs: "uploaded document", room: "document of the room", link: "link" }, by: "brought by", licence: "licence", noLicence: "licence not known", decided: (w: string) => `decided by ${w}`, reason: "reason", note: "note", cited: "cited in", notCited: "cited in no section" },
	de: { title: "Quellen", generated: (d: string) => `Das Quellenregister dieses Raums, geschrieben von codemode-forum am ${d}. Kein Modell hat diese Datei geschrieben.`, none: "Der Raum hat keine Quellen.", states: { accepted: "Angenommen", proposed: "Vorgeschlagen, nicht entschieden", declined: "Abgelehnt" }, kinds: { repo: "Repository", files: "Arbeitsbereich", docs: "hochgeladenes Dokument", room: "Dokument des Raums", link: "Link" }, by: "gebracht von", licence: "Lizenz", noLicence: "Lizenz unbekannt", decided: (w: string) => `entschieden von ${w}`, reason: "Grund", note: "Notiz", cited: "zitiert in", notCited: "in keinem Abschnitt zitiert" },
} as const;

/** The register as `sources.md`: every source by its state, with what is known of it and where it is cited. */
/** What a version cites that the room has not accepted (proposed or declined), with the sections that cite it: the
 *  report at an acceptance and in the export's appendix. */
export function unacceptedIn(refs: SourceRef[], blockId: string, files: Map<string, string> | null, sections: Array<{ title: string; text: string }>): Array<{ title: string; state: RefState; reason?: string; sections: string[] }> {
	const cites = citesOf(refs, [{ blockId, doc: "", files, sections }]);
	return refs.filter((r) => r.state !== "accepted" && cites.get(r.refId)!.length).map((r) => ({ title: r.title, state: r.state, ...(r.reason ? { reason: r.reason } : {}), sections: [...new Set(cites.get(r.refId)!.map((c) => c.section))] }));
}
/** The line in the room when a version is accepted that cites sources the room has not accepted. */
export const unacceptedLine = (version: number, not: Array<{ title: string; state: string }>) =>
	`Version ${version} cites ${not.length} source${not.length === 1 ? "" : "s"} the room has not accepted: ${not.map((u) => `"${u.title}" (${u.state})`).join(", ")}`.slice(0, 600);

export function registerMarkdown(refs: SourceRef[], cites: Map<string, Cite[]>, lang: "de" | "en", now = Date.now()): string {
	const t = T[lang] ?? T.en, one = (s: string) => s.replace(/\s+/g, " ").trim();
	const out = [`# ${t.title}`, "", t.generated(new Date(now).toISOString().slice(0, 10)), ""];
	if (!refs.length) out.push(t.none, "");
	for (const state of ["accepted", "proposed", "declined"] as const) {
		const rows = refs.filter((r) => r.state === state);
		if (!rows.length) continue;
		out.push(`## ${t.states[state]}`, "");
		for (const r of rows) {
			const where = cites.get(r.refId) ?? [];
			out.push(`- **${one(r.title)}** (${t.kinds[r.kind]})${r.kind === "link" ? ` <${r.address}>` : ""}`);
			out.push(`  ${t.by} ${one(r.by)}; ${r.licence ? `${t.licence}: ${one(r.licence)}` : t.noLicence}${r.decidedBy ? `; ${t.decided(one(r.decidedBy))}` : ""}`);
			if (r.reason) out.push(`  ${t.reason}: ${one(r.reason)}`);
			if (r.note) out.push(`  ${t.note}: ${one(r.note)}`);
			out.push(`  ${where.length ? `${t.cited}: ${[...new Set(where.map((c) => `${c.doc}, "${one(c.section)}"`))].join("; ")}` : t.notCited}`);
		}
		out.push("");
	}
	return out.join("\n");
}
