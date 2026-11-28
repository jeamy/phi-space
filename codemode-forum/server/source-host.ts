// The sources process: the only process that sees repositories. It answers the reading calls of the agents
// (SourceRequest, SourceResult) on a block's source packs, read-only: list a directory, read lines of a file, search
// for a text. It also opens a repository pack when a task is created: it resolves the branch or commit, writes the
// pack's index into the space (SourceIndex pages) and says what it holds. Only this process gets the repositories'
// paths (FORUM_REPOS), as only the model process gets credentials; the others know a repository by its name.
// Uploaded documents lie in the space (SourceFile pages); it reads them from there.
//
//   FORUM_SPACE=unix:/tmp/codemode-forum-space.sock   (default) or tcp:host:4180
//   FORUM_REPOS=name=/abs/path,other=/abs/path        the local git repositories it offers (default: none)
//   FORUM_GIT_HOSTS=github.com,git.example.org        hosts a remote repository may be fetched from (default: none),
//   FORUM_GIT_MAX_MB (200), FORUM_GIT_TIMEOUT_S (60), FORUM_GIT_CACHE (.local/git-cache): remote.ts
//   FORUM_FILES_SOCKET=/path/agent.sock               spaces-files' agent socket for this host (default: none, no workspaces);
//   FORUM_FILES_TENANT, FORUM_FILES_HOST              the tenant and host peer it stands for, shown to a room's owner
//   FORUM_FILES_PAGE=https://files.example            the spaces-files page, linked beside the files it has and FORUM
//                                                     does not show (it has no address of a single file)
//                                                     for registering the room's agent (files.ts; FORUM_FILES_MAX_*)
//   FORUM_SEARCH_PER_DAY=100                          web searches a day for all rooms together (research.ts; 0: none).
//                                                     The search goes to DuckDuckGo only (search.ts); no page is opened.
//   FORUM_TEST_SEARCH_MODULE=tests/search-fake.ts     tests only (FORUM_TEST=1): its post() answers instead of DuckDuckGo
// It is the only process that talks to spaces-files: a room's link is checked and a task's copy of the linked folders
// taken here (FilesRequest, FilesResult; files.ts).
import "./env.ts";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { NO_WAIT, TransactionError, type SpaceLike } from "phi-spaces";
import { answer, denied, docsPack, gitPack, indexHash, reposOf, resolveCommit, type IndexEntry, type Pack, type PlanSource, type SourceCall, type SourceId } from "./sources.ts";
import { agentOf, fileNotes, freeName, kindOf, pictureKind, PICTURE_TYPES, PREVIEW_BYTES, workspacePath, type PreviewAnswer, UPLOAD, type UploadAnswer, type SaveAnswer, type ConflictAnswer, type PlanSave, type UploadDone, folderName, walkFolders, walkedIndex, type CheckAnswer, type FilesRequest, type FilesResult, type RoomLink, type SnapshotAnswer } from "./files.ts";
import { FilesAgentClient, FilesError } from "./files-client.ts";
import { askPdf } from "./sandbox-host.ts";
import { takeQuota } from "./quota.ts";
import { webSearch } from "./search.ts";
import { researchOn, resultsText, searchesPerDay, type WebResult } from "./research.ts";
import { fetchRemote, gitHosts, hasCommit, remoteDir, remoteName, remoteUrl } from "./remote.ts";
import { announce, awaitWork, connectSpace, DEFAULT_SPACE, keepAlive } from "./space.ts";

/** A request to the sources process. `open`: a repository (by its name in FORUM_REPOS, or a remote one by its https
 *  address, `url`) at a branch, tag or commit, for the block's pack; the others: one reading call on a pack of the
 *  block. */
export type SourceRequest = { requestId: string; session: string; blockId: string; ts: number } & (
	| { op: "open"; repo?: string; url?: string; ref: string; ttl: number }
	| { op: "call"; sourceId: SourceId; call: SourceCall });
/** Its answer. `text`: what a reading call returned (also what the caller got wrong); `opened`: the pack. An `error`
 *  is a failure of the request itself (no such repository, the pack is gone). */
export type SourceResult = { requestId: string; session: string; ok: boolean; text?: string; opened?: Pick<PlanSource, "name" | "url" | "commit" | "ref" | "files" | "bytes" | "indexHash">; error?: string; ts: number };

/** How long a search result is kept: long enough for the documents that cite it to bring it into the register. */
const WEB_RESULT_MS = 90 * 24 * 3600_000;
/** A request's transaction lease, renewed while it is answered: a sources process that dies holds its request this
 *  long (FORUM_SOURCE_LEASE_MS, default 20 s). */
const LEASE_MS = Math.max(1000, Number(process.env.FORUM_SOURCE_LEASE_MS || 20_000));
const RESULT_LEASE_MS = 10 * 60_000;
/** The entries of an index page: a page stays well under the space's 64 KiB an entry. */
const INDEX_PAGE_BYTES = 40_000;

/** Test only (FORUM_TEST=1): the first request of FORUM_TEST_SOURCE_PAUSE writes that file and holds here, with the
 *  request taken, until the test kills the process. */
async function holdBeforeAnswer(name = "FORUM_TEST_SOURCE_PAUSE"): Promise<void> {
	const marker = process.env[name];
	if (process.env.FORUM_TEST !== "1" || !marker || existsSync(marker)) return;
	writeFileSync(marker, "holding");
	await new Promise<void>(() => {});
}

/** The index of a pack as pages for the space. */
export function indexPages(index: IndexEntry[]): IndexEntry[][] {
	const pages: IndexEntry[][] = [[]];
	let bytes = 0;
	for (const e of index) {
		const n = Buffer.byteLength(e[0]) + 16;
		if (bytes + n > INDEX_PAGE_BYTES && pages.at(-1)!.length) { pages.push([]); bytes = 0; }
		pages.at(-1)!.push(e); bytes += n;
	}
	return pages;
}

export async function startSourceHost(o: { space?: string; parallel?: number } = {}) {
	const conn = connectSpace(o.space);
	const space = conn.space;
	const repos = reposOf(), hosts = gitHosts();
	const filesSocket = process.env.FORUM_FILES_SOCKET || "";
	const page = /^https:\/\/[^\s"'<>]+$/.test(process.env.FORUM_FILES_PAGE ?? "") ? process.env.FORUM_FILES_PAGE! : undefined;
	const files = filesSocket ? { tenant: process.env.FORUM_FILES_TENANT || "?", host: process.env.FORUM_FILES_HOST || "?", ...(page ? { page } : {}) } : null;
	const presence = announce(space, "sources");
	const open = new Set<string>();
	let stopping = false;
	const halt = new AbortController();
	// packs opened lately: a repository by name and commit, a block's documents by the hash of their index
	const packs = new Map<string, Promise<Pack>>();
	const cached = (key: string, make: () => Promise<Pack>) => {
		let p = packs.get(key);
		if (!p) { if (packs.size >= 32) packs.delete(packs.keys().next().value!); p = make(); packs.set(key, p); p.catch(() => packs.delete(key)); }
		return p;
	};
	const repoPath = (name: string) => { const path = repos.get(name); if (!path) throw new Error(`This sources process has no repository called ${name}`); return path; };

	/** SourceInfo: the names of the repositories this process offers (renewed every 10 s), for the page of an admin. */
	const procId = randomBytes(6).toString("hex");
	let infoLease: string | null = null;
	const publish = async () => {
		try {
			if (infoLease) { try { await space.renew(infoLease, 30_000); return; } catch { infoLease = null; } }
			infoLease = (await space.write({ type: "SourceInfo", fields: { procId, repos: [...repos.keys()].sort(), hosts, files, ts: Date.now() } }, null, 30_000)).id;
		} catch (e) { if (!stopping) console.error("[sources] publishing the repositories failed", (e as Error).message); }
	};
	await publish();
	const beat = setInterval(() => void publish(), 10_000); beat.unref?.();

	const packOf = async (req: SourceRequest & { op: "call" }): Promise<Pack> => {
		const src = (await space.readIfExists({ type: "PlanSource", fields: { session: req.session, blockId: req.blockId, sourceId: req.sourceId } }, NO_WAIT))?.fields as unknown as PlanSource | undefined;
		if (!src) throw new Error("This task has no such source");
		if (src.kind === "repo" && src.url) return cached(`remote:${src.url}@${src.commit}`, async () => {
			// a remote repository lies in this process's cache; one that is gone from there (another machine, a cleared
			// cache) is fetched again at the task's commit, while its host is still allowed
			const url = remoteUrl(src.url, hosts), dir = remoteDir(url);
			if (!(await hasCommit(dir, src.commit!))) {
				const again = await fetchRemote(url, src.commit!).catch((e) => { throw new Error(`the repository is not in this sources process's cache and could not be fetched again (${(e as Error).message})`); });
				if (again.commit !== src.commit) throw new Error("the repository fetched again is not at the task's commit");
			}
			return gitPack(dir, src.commit!);
		});
		if (src.kind === "repo") return cached(`repo:${src.name}@${src.commit}`, () => gitPack(repoPath(src.name), src.commit!));
		// the notes people wrote about files without text are read anew each time: they may change after the copy
		if (src.kind === "files" || src.kind === "room") return cached(`${src.kind}:${req.session}:${req.blockId}:${src.copy}`, async () => {
			// the task's copy of the workspace folders, or of the room's other documents: its index and its text files
			const key = { session: req.session, blockId: req.blockId, sourceId: src.kind, copy: src.copy ?? "" };
			const index = (await space.readAll({ type: "SourceIndex", fields: key }, { limit: 2000 })).sort((a, b) => Number(a.fields.part) - Number(b.fields.part)).flatMap((e) => (e.fields as unknown as { paths: IndexEntry[] }).paths);
			const parts = (await space.readAll({ type: "SourceFile", fields: key }, { limit: 2000 })).map((e) => e.fields as unknown as { path: string; part: number; text: string });
			const by = new Map<string, string[]>();
			for (const p of parts.sort((a, b) => a.part - b.part)) by.set(p.path, [...(by.get(p.path) ?? []), p.text]);
			const texts = new Map([...by].map(([path, t]) => [path, Buffer.from(t.join(""), "utf8")]));
			return { index, read: async (path: string) => texts.get(path) ?? Buffer.alloc(0) };
		}).then(async (p) => (src.kind === "files" ? { ...p, notes: await fileNotes(space, req.session) } : p));
		return cached(`docs:${req.session}:${req.blockId}:${src.indexHash}`, async () => {
			// the uploaded documents: the parts without a source of their own (a workspace copy's carry `sourceId`)
			const parts = (await space.readAll({ type: "SourceFile", fields: { session: req.session, blockId: req.blockId } }, { limit: 2000 })).map((e) => e.fields as unknown as { path: string; part: number; text: string; sourceId?: string }).filter((p) => !p.sourceId);
			const by = new Map<string, string[]>();
			for (const p of parts.sort((a, b) => a.part - b.part)) by.set(p.path, [...(by.get(p.path) ?? []), p.text]);
			return docsPack([...by].map(([path, texts]) => ({ path, text: texts.join("") })));
		});
	};

	// the web search's transport in the tests (FORUM_TEST=1 only): a module whose `post` answers like DuckDuckGo
	const fakePost = process.env.FORUM_TEST === "1" && process.env.FORUM_TEST_SEARCH_MODULE ? ((await import(pathToFileURL(fileURLToPath(new URL("../" + process.env.FORUM_TEST_SEARCH_MODULE, import.meta.url))).href)) as { post: NonNullable<Parameters<typeof webSearch>[1]>["post"] }).post : undefined;
	/** `web`: a search, when research is on for the room and the day's searches are not used up; each result kept as a
	 *  WebResult with who asked. A refusal is the answer the model reads, not a failure of its work. */
	const web = async (req: SourceRequest & { op: "call" }, txn: string): Promise<string> => {
		const call = req.call as Extract<SourceCall, { op: "web" }>, query = call.query.replace(/\s+/g, " ").trim().slice(0, 200);
		if (!(await researchOn(space, req.session))) return "Web search is switched off for this room.";
		if (!query) return "A web search needs words to search for.";
		const perDay = searchesPerDay();
		let results;
		try { results = await webSearch(query, { allowed: async () => perDay > 0 && (await takeQuota(space, "search", { perDay })).ok, ...(fakePost ? { post: fakePost } : {}) }); }
		catch (e) { return `The web search did not answer: ${String((e as Error).message ?? e).replace(/CODEMODE_SEARCH_PER_DAY/, "FORUM_SEARCH_PER_DAY").slice(0, 200)}`; }
		for (const x of results) await space.write({ type: "WebResult", fields: { session: req.session, blockId: req.blockId, query, url: x.url, title: x.title, snippet: x.snippet, by: call.by ?? "a model", ts: Date.now() } satisfies WebResult as never }, txn, WEB_RESULT_MS);
		return resultsText(query, results);
	};

	/** One request: taken, answered and the answer written in one transaction. */
	const answerOne = async (): Promise<boolean> => {
		if (!(await awaitWork(space, { type: "SourceRequest" }, halt.signal))) return false; // idle: waiting holds nothing
		const t = await space.createTransaction(LEASE_MS);
		open.add(t.id);
		const stop = keepAlive(space, t.id, LEASE_MS);
		try {
			const e = await space.take({ type: "SourceRequest" }, NO_WAIT, { txn: t.id });
			if (!e) { await space.abort(t.id); return false; }
			const req = e.fields as unknown as SourceRequest;
			await holdBeforeAnswer();
			let result: Omit<SourceResult, "requestId" | "session" | "ts">;
			try {
				if (req.op === "open") {
					// a remote repository is fetched now, once: one commit into this process's cache (remote.ts)
					const url = req.url ? remoteUrl(req.url, hosts) : undefined, name = url ? remoteName(url) : String(req.repo ?? "");
					const fetched = url ? await fetchRemote(url, req.ref) : undefined;
					const path = fetched?.dir ?? repoPath(name), commit = fetched?.commit ?? (await resolveCommit(path, req.ref));
					const pack = await cached(url ? `remote:${url}@${commit}` : `repo:${name}@${commit}`, () => gitPack(path, commit));
					if (!pack.index.length) throw new Error(`${name} at ${req.ref} has no text file to read`);
					const pages = indexPages(pack.index);
					for (const [part, paths] of pages.entries()) await space.write({ type: "SourceIndex", fields: { session: req.session, blockId: req.blockId, sourceId: "repo", part, parts: pages.length, paths } as never }, t.id, req.ttl);
					result = { ok: true, opened: { name, ...(url ? { url } : {}), commit, ref: req.ref, files: pack.index.length, bytes: pack.index.reduce((n, [, size]) => n + size, 0), indexHash: indexHash(pack.index) } };
				} else if (req.call.op === "web") result = { ok: true, text: await web(req, t.id) };
				else result = { ok: true, text: await answer(await packOf(req), req.call) };
			} catch (err) { result = { ok: false, error: String((err as Error).message ?? err).slice(0, 300) }; }
			await space.write({ type: "SourceResult", fields: { requestId: req.requestId, session: req.session, ...result, ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
			await space.commit(t.id);
			return true;
		} catch (e) {
			await space.abort(t.id).catch(() => {});
			if (e instanceof TransactionError) return true;
			throw e;
		} finally { stop(); open.delete(t.id); }
	};
	const worker = async () => {
		while (!stopping) {
			try { await answerOne(); }
			catch (e) { if (stopping) return; console.error("[sources] request failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
		}
	};
	const loops = Array.from({ length: Math.max(1, o.parallel ?? Number(process.env.FORUM_SOURCE_PARALLEL ?? 4)) }, () => worker());
	if (files) loops.push(...Array.from({ length: 2 }, () => filesWorker()));

	// ---- spaces-files (files.ts): the room's agent checks what it sees and takes a task's copy ----
	const clientFor = (room: string) => new FilesAgentClient({ path: filesSocket, agent: agentOf(room), retries: 2 });
	/** Says what went wrong with spaces-files in words for the room's owner, with spaces-files' own code. */
	const refusal = (e: unknown, what: string): { code: string; error: string } => {
		if (!(e instanceof FilesError)) return { code: "error", error: `${what}: ${String((e as Error)?.message ?? e).slice(0, 240)}` };
		const why = e.code === "unauthenticated" ? "the room's agent is not registered in spaces-files, or is disabled"
			: e.code === "notFound" ? "the room's agent cannot see it (not granted, revoked, or not there)"
			: e.code === "permissionDenied" ? "the room's agent may not do that there" : e.message;
		return { code: e.code, error: `${what}: ${why} (${e.code})` };
	};
	/** `check`: the workspaces the agent sees that it does not own, and each chosen folder: seen, and not owned. */
	const check = async (req: FilesRequest & { op: "check" }): Promise<CheckAnswer> => {
		const c = clientFor(req.session);
		try {
			let all: string[];
			try { all = await c.workspaces(); } catch (e) { throw Object.assign(new Error(refusal(e, "spaces-files").error), { code: (e as FilesError).code }); }
			// an agent's own home, and any workspace it owns, is no folder of the room: an owner could grant on
			const owns = async (ws: string, path: string) => { try { await c.call("listGrants", { workspace: ws, path: path || "." }); return true; } catch { return false; } };
			const workspaces: string[] = [];
			for (const ws of all.slice(0, 50)) if (!(await owns(ws, ""))) workspaces.push(ws);
			const folders: CheckAnswer["folders"] = [];
			for (const [role, f] of [["read", req.read], ["project", req.project]] as const) {
				if (!f) continue;
				let entries: number;
				try { entries = (await c.listPage(f.workspace, f.path || ".", null)).entries.length; }
				catch (e) { const r = refusal(e, folderName(f)); throw Object.assign(new Error(r.error), { code: r.code }); }
				if (await owns(f.workspace, f.path)) throw Object.assign(new Error(`${folderName(f)}: the room's agent owns it; a room must never be able to grant what it reads, so it is not linked`), { code: "ownerAgent" });
				folders.push({ role, ...f, entries });
			}
			return { agent: agentOf(req.session), workspaces, folders };
		} finally { c.close(); }
	};
	/** `snapshot`: the copy of the linked folders for a task, written in parts outside the transaction under a copy ID of
	 *  its own; parts of an attempt cut off before are removed first. `alive` turns false when the request's lease is
	 *  lost, so a walk that outlived it writes nothing more. */
	const snapshot = async (req: FilesRequest & { op: "snapshot" }, alive: () => boolean): Promise<SnapshotAnswer> => {
		const link = (await space.readIfExists({ type: "RoomLink", fields: { session: req.session } }, NO_WAIT))?.fields as unknown as RoomLink | undefined;
		if (!link) throw Object.assign(new Error("The room is not linked to a workspace"), { code: "notLinked" });
		const key = { session: req.session, blockId: req.blockId, sourceId: "files" };
		for (const type of ["SourceFile", "SourceIndex"]) while (await space.take({ type, fields: key }, NO_WAIT)) { /* an earlier attempt's */ }
		const c = clientFor(req.session);
		let walked;
		try { walked = await walkFolders(c, link, undefined, (bytes, lim) => askPdf(space, bytes, lim)); }
		catch (e) { const r = refusal(e, "The workspace"); throw Object.assign(new Error(e instanceof FilesError ? r.error : (e as Error).message), { code: r.code }); }
		finally { c.close(); }
		if (!walked.length) throw Object.assign(new Error("The linked folders hold no file"), { code: "empty" });
		const copy = `c${randomBytes(6).toString("hex")}`, at = { ...key, copy };
		const put = async (type: string, fields: Record<string, unknown>) => {
			if (!alive()) throw new Error("the request's lease was lost");
			await space.write({ type, fields: { ...at, ...fields } as never }, null, req.ttl);
		};
		let wrote = 0;
		for (const f of walked) if (f.text !== undefined) for (let part = 0; part === 0 || part * 12_000 < f.text.length; part++) {
			await put("SourceFile", { path: f.path, part, text: f.text.slice(part * 12_000, (part + 1) * 12_000) });
			if (++wrote === 1) await holdBeforeAnswer("FORUM_TEST_FILES_PAUSE");
		}
		const index = walkedIndex(walked), pages = indexPages(index);
		for (const [part, paths] of pages.entries()) await put("SourceIndex", { part, parts: pages.length, paths });
		const texts = walked.filter((f) => f.text !== undefined);
		return { copy, files: walked.length, texts: texts.length, bytes: walked.reduce((n, f) => n + f.size, 0), textBytes: texts.reduce((n, f) => n + f.size, 0), indexHash: indexHash(index), tenant: link.tenant };
	};
	/** `upload`, its first step: the file's name in `material/` of the project folder (the first free one) and the
	 *  operation ID, kept in the request before anything is written. */
	const nameUpload = async (req: FilesRequest & { op: "upload" }): Promise<{ path: string; opId: string }> => {
		const link = (await space.readIfExists({ type: "RoomLink", fields: { session: req.session } }, NO_WAIT))?.fields as unknown as RoomLink | undefined;
		if (!link) throw Object.assign(new Error("The room is not linked to a workspace"), { code: "notLinked" });
		const c = clientFor(req.session), dir = [link.project.path, "material"].filter(Boolean).join("/");
		try {
			const taken = new Set<string>();
			try { for (let cursor: string | null = null, first = true; first || cursor; first = false) { const page = await c.listPage(link.project.workspace, dir, cursor); cursor = page.next; for (const e of page.entries) taken.add(e.name); } }
			catch (e) { if ((e as FilesError).code !== "notFound") throw e; }
			return { path: `${dir}/${freeName(req.name, taken)}`, opId: await c.operationId() };
		} catch (e) { const r = refusal(e, folderName(link.project)); throw Object.assign(new Error(r.error), { code: r.code }); }
		finally { c.close(); }
	};
	/** `upload`, its second step: the bytes from their parts, the folder made if it is not there, the write under the
	 *  request's operation ID (sent again, spaces-files answers from its receipt). A name taken meanwhile is
	 *  `versionConflict`: null, the request is named anew. */
	const doUpload = async (req: FilesRequest & { op: "upload"; path: string; opId: string }): Promise<UploadAnswer | null> => {
		const link = (await space.readIfExists({ type: "RoomLink", fields: { session: req.session } }, NO_WAIT))?.fields as unknown as RoomLink | undefined;
		if (!link) throw Object.assign(new Error("The room is not linked to a workspace"), { code: "notLinked" });
		const parts = (await space.readAll({ type: "UploadPart", fields: { session: req.session, uploadId: req.uploadId } }, { limit: req.parts + 2 })).map((e) => e.fields as { part: number; data: string }).sort((a, b) => a.part - b.part);
		const bytes = Buffer.from(parts.map((p) => p.data).join(""), "base64");
		if (parts.length !== req.parts || createHash("sha256").update(bytes).digest("hex") !== req.hash) throw Object.assign(new Error("The file arrived incomplete; send it again"), { code: "incomplete" });
		const c = clientFor(req.session), dir = req.path.slice(0, req.path.lastIndexOf("/"));
		try {
			try { await c.mkdir(link.project.workspace, dir); } catch (e) { if ((e as FilesError).code !== "alreadyExists") throw e; }
			const { version } = await c.write(link.project.workspace, req.path, bytes, 0, req.opId);
			await holdBeforeAnswer("FORUM_TEST_UPLOAD_PAUSE");
			return { workspace: link.project.workspace, path: req.path, version, kind: kindOf(bytes), bytes: bytes.length };
		} catch (e) {
			if ((e as FilesError).code === "versionConflict" || (e as FilesError).code === "alreadyExists") return null;
			const r = refusal(e, folderName(link.project)); throw Object.assign(new Error(r.error), { code: r.code });
		} finally { c.close(); }
	};
	/** `save`, its second step: the exported bytes from their parts, written against the version the last save
	 *  returned under the request's operation ID (sent again after a crash, spaces-files answers from its receipt). A
	 *  file changed or removed meanwhile is not touched: the answer is the conflict, with the workspace's text. */
	const doSave = async (req: FilesRequest & { op: "save"; opId: string }): Promise<{ save: SaveAnswer } | { conflict: ConflictAnswer }> => {
		const link = (await space.readIfExists({ type: "RoomLink", fields: { session: req.session } }, NO_WAIT))?.fields as unknown as RoomLink | undefined;
		if (!link) throw Object.assign(new Error("The room is not linked to a workspace"), { code: "notLinked" });
		const parts = (await space.readAll({ type: "UploadPart", fields: { session: req.session, uploadId: req.saveId } }, { limit: req.parts + 2 })).map((e) => e.fields as { part: number; data: string }).sort((a, b) => a.part - b.part);
		const bytes = Buffer.from(parts.map((p) => p.data).join(""), "base64");
		if (parts.length !== req.parts || createHash("sha256").update(bytes).digest("hex") !== req.hash) throw Object.assign(new Error("The document arrived incomplete; save again"), { code: "incomplete" });
		const ws = link.project.workspace, c = clientFor(req.session);
		await holdBeforeAnswer("FORUM_TEST_SAVE_PAUSE");
		try {
			const { version } = await c.write(ws, req.path, bytes, req.expected, req.opId);
			await holdBeforeAnswer("FORUM_TEST_SAVED_PAUSE");
			return { save: { workspace: ws, path: req.path, version, bytes: bytes.length } };
		} catch (e) {
			const code = (e as FilesError).code;
			if (code !== "versionConflict" && code !== "alreadyExists" && code !== "notFound") { const r = refusal(e, folderName(link.project)); throw Object.assign(new Error(r.error), { code: r.code }); }
			// the file as it is now; not found while the project folder is still seen: removed in the workspace
			let now: { bytes: Buffer; version: number } | null = null;
			try { now = await c.read(ws, req.path); }
			catch (err) {
				if ((err as FilesError).code !== "notFound") { const r = refusal(err, folderName(link.project)); throw Object.assign(new Error(r.error), { code: r.code }); }
				try { await c.listPage(ws, link.project.path || ".", null); }
				catch (gone) { const r = refusal(gone, folderName(link.project)); throw Object.assign(new Error(r.error), { code: r.code }); }
			}
			if (!now) return { conflict: { workspace: ws, path: req.path, version: 0, parts: 0, bytes: 0, gone: true } };
			if (now.bytes.length > PREVIEW_BYTES || kindOf(now.bytes) !== "text") return { conflict: { workspace: ws, path: req.path, version: now.version, parts: 0, bytes: now.bytes.length, tooLarge: true } };
			const data = now.bytes.toString("base64"), n = Math.ceil(data.length / UPLOAD.part);
			for (let part = 0; part < n; part++) await space.write({ type: "PreviewPart", fields: { session: req.session, previewId: req.saveId, part, data: data.slice(part * UPLOAD.part, (part + 1) * UPLOAD.part) } }, null, 600_000);
			return { conflict: { workspace: ws, path: req.path, version: now.version, parts: n, bytes: now.bytes.length } };
		} finally { c.close(); }
	};
	/** `preview`: a picture of the linked folders as it is now, its bytes in PreviewPart entries (outside the
	 *  transaction, ten minutes); anything but a picture is refused. */
	const preview = async (req: FilesRequest & { op: "preview" }): Promise<PreviewAnswer> => {
		const link = (await space.readIfExists({ type: "RoomLink", fields: { session: req.session } }, NO_WAIT))?.fields as unknown as RoomLink | undefined;
		if (!link) throw Object.assign(new Error("The room is not linked to a workspace"), { code: "notLinked" });
		const at = workspacePath(link, req.path);
		if (!at || denied(req.path)) throw Object.assign(new Error("Not a file of the linked folders"), { code: "notFound" });
		const c = clientFor(req.session);
		try {
			const { bytes, version } = await c.read(at.workspace, at.path);
			const kind = pictureKind(at.path, bytes);
			if (req.want === "pdf" ? kind !== "pdf" : req.want === "text" ? kind !== "text" : !PICTURE_TYPES[kind]) throw Object.assign(new Error(`${req.path} is no ${req.want ?? "picture"} (${kind})`), { code: req.want ? "wrongKind" : "notPicture" });
			if (bytes.length > PREVIEW_BYTES) throw Object.assign(new Error(`${req.path} is larger than ${PREVIEW_BYTES / 1024 / 1024} MB`), { code: "tooLarge" });
			const data = bytes.toString("base64"), parts = Math.ceil(data.length / UPLOAD.part);
			for (let part = 0; part < parts; part++) await space.write({ type: "PreviewPart", fields: { session: req.session, previewId: req.previewId, part, data: data.slice(part * UPLOAD.part, (part + 1) * UPLOAD.part) } }, null, 600_000);
			return { kind, parts, bytes: bytes.length, version };
		} catch (e) {
			if ((e as { code?: string }).code && !(e instanceof FilesError)) throw e;
			const r = refusal(e, req.path); throw Object.assign(new Error(r.error), { code: r.code });
		} finally { c.close(); }
	};
	/** One FilesRequest: taken in a transaction whose lease is renewed while it is answered, the answer written in it. */
	async function filesOne(): Promise<boolean> {
		if (!(await awaitWork(space, { type: "FilesRequest" }, halt.signal))) return false;
		const t = await space.createTransaction(LEASE_MS);
		open.add(t.id);
		let lost = false;
		const renew = setInterval(() => void space.renew(t.id, LEASE_MS).catch(() => { lost = true; }), Math.max(500, Math.floor(LEASE_MS / 3)));
		renew.unref?.();
		try {
			const e = await space.take({ type: "FilesRequest" }, NO_WAIT, { txn: t.id });
			if (!e) { await space.abort(t.id); return false; }
			const req = e.fields as unknown as FilesRequest;
			let result: Omit<FilesResult, "requestId" | "session" | "ts">;
			// an upload without its name and operation ID gets both first, and is put back with them (committed before
			// anything is written); one whose name was taken meanwhile is named anew
			if (req.op === "upload" && (!req.opId || !req.path)) {
				let named: { path: string; opId: string } | null = null;
				try { named = await nameUpload(req); } catch (err) { result = { ok: false, code: (err as { code?: string }).code ?? "error", error: String((err as Error).message ?? err).slice(0, 400) }; }
				if (named) await space.write({ type: "FilesRequest", fields: { ...req, ...named } as never }, t.id, req.ttl);
				else await space.write({ type: "FilesResult", fields: { requestId: req.requestId, session: req.session, ...result!, ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
				await space.commit(t.id);
				return true;
			}
			// a save draws its operation ID first and is put back with it (committed before the write)
			if (req.op === "save" && !req.opId) {
				const c = clientFor(req.session);
				let opId: string | null = null;
				try { opId = await c.operationId(); } catch (err) { const r = refusal(err, "spaces-files"); result = { ok: false, code: r.code, error: r.error }; } finally { c.close(); }
				if (opId) await space.write({ type: "FilesRequest", fields: { ...req, opId } as never }, t.id, req.ttl);
				else await space.write({ type: "FilesResult", fields: { requestId: req.requestId, session: req.session, ...result!, ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
				await space.commit(t.id);
				return true;
			}
			if (req.op === "save") {
				let done: Awaited<ReturnType<typeof doSave>> | null = null;
				try { done = await doSave(req as FilesRequest & { op: "save"; opId: string }); }
				catch (err) { result = { ok: false, code: (err as { code?: string }).code ?? "error", error: String((err as Error).message ?? err).slice(0, 400) }; }
				if (done && "save" in done) {
					result = { ok: true, save: done.save };
					const saved: PlanSave = { session: req.session, blockId: req.blockId, saveId: req.saveId, table: req.table, docVersion: req.docVersion, workspace: done.save.workspace, path: done.save.path, fileVersion: done.save.version, bytes: done.save.bytes, by: req.by, ts: Date.now() };
					await space.write({ type: "PlanSave", fields: saved as never }, t.id, req.keep);
					await space.write({ type: "ForumLine", fields: { session: req.session, text: req.blockId === "register" ? `${req.by} saved the register of sources (${req.docVersion} sources) to ${done.save.workspace}/${done.save.path} (file version ${done.save.version})` : `${req.by} saved version ${req.docVersion} of a document to ${done.save.workspace}/${done.save.path} (file version ${done.save.version})`, ts: Date.now() } }, t.id, req.keep);
				} else if (done) result = { ok: false, code: "versionConflict", error: done.conflict.gone ? `${done.conflict.path} was removed in the workspace since the last save` : `${done.conflict.path} was changed in the workspace (now version ${done.conflict.version}); nothing was overwritten`, conflict: done.conflict };
				await space.write({ type: "FilesResult", fields: { requestId: req.requestId, session: req.session, ...result!, ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
				await space.commit(t.id);
				while (await space.take({ type: "UploadPart", fields: { session: req.session, uploadId: req.saveId } }, NO_WAIT).catch(() => null)) { /* every part */ }
				return true;
			}
			if (req.op === "upload") {
				let done: UploadAnswer | null = null;
				try { done = await doUpload(req as FilesRequest & { op: "upload"; path: string; opId: string }); if (!done) await space.write({ type: "FilesRequest", fields: { ...req, path: undefined, opId: undefined } as never }, t.id, req.ttl); }
				catch (err) { result = { ok: false, code: (err as { code?: string }).code ?? "error", error: String((err as Error).message ?? err).slice(0, 400) }; }
				if (done) {
					result = { ok: true, upload: done };
					await space.write({ type: "UploadDone", fields: { session: req.session, uploadId: req.uploadId, by: req.by, ...done, ts: Date.now() } satisfies UploadDone as never }, t.id, 24 * 3600_000);
					await space.write({ type: "ForumLine", fields: { session: req.session, text: `${req.by} uploaded ${req.name} to ${done.workspace}/${done.path} (${done.kind}, ${Math.ceil(done.bytes / 1000)} kB)`, ts: Date.now() } }, t.id, req.ttl);
				}
				if (done || result!) await space.write({ type: "FilesResult", fields: { requestId: req.requestId, session: req.session, ...result!, ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
				await space.commit(t.id);
				if (done || result!) while (await space.take({ type: "UploadPart", fields: { session: req.session, uploadId: req.uploadId } }, NO_WAIT).catch(() => null)) { /* every part */ }
				return true;
			}
			try {
				result = req.op === "check" ? { ok: true, check: await check(req) } : req.op === "preview" ? { ok: true, preview: await preview(req) } : { ok: true, snapshot: await snapshot(req as FilesRequest & { op: "snapshot" }, () => !lost && !stopping) };
			} catch (err) { result = { ok: false, code: (err as { code?: string }).code ?? "error", error: String((err as Error).message ?? err).slice(0, 400) }; }
			await space.write({ type: "FilesResult", fields: { requestId: req.requestId, session: req.session, ...result, ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
			await space.commit(t.id);
			return true;
		} catch (e) {
			await space.abort(t.id).catch(() => {});
			if (e instanceof TransactionError) return true;
			throw e;
		} finally { clearInterval(renew); open.delete(t.id); }
	}
	async function filesWorker() {
		while (!stopping) {
			try { await filesOne(); }
			catch (e) { if (stopping) return; console.error("[sources] files request failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
		}
	}
	return {
		repos: [...repos.keys()], hosts, files,
		async close() {
			stopping = true; halt.abort(); clearInterval(beat);
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 3000))]);
			if (infoLease) await space.cancel(infoLease).catch(() => {});
			await presence.stop(); conn.close();
		},
	};
}

/** How long a caller waits for the sources process (FORUM_SOURCE_WAIT_S, default 30 s). */
export const sourceWaitMs = () => Math.max(1000, Number(process.env.FORUM_SOURCE_WAIT_S || 30) * 1000);

/** Asks the sources process and waits for its answer. A request nobody took in time is withdrawn; then, and when the
 *  process says the request failed, it throws. */
export async function askSources(space: SpaceLike, req: SourceRequest, waitMs = sourceWaitMs()): Promise<SourceResult> {
	await space.write({ type: "SourceRequest", fields: req as never }, null, waitMs + 60_000);
	const tmpl = { type: "SourceResult", fields: { requestId: req.requestId } };
	let r = null as Awaited<ReturnType<SpaceLike["take"]>>;
	for (const end = Date.now() + waitMs; !r && Date.now() < end; ) r = await space.take(tmpl, Math.min(20_000, Math.max(1, end - Date.now())));
	if (!r) {
		const withdrawn = await space.take({ type: "SourceRequest", fields: { requestId: req.requestId } }, NO_WAIT).catch(() => null);
		throw new Error(withdrawn ? "no sources process answered (is one running?)" : "the sources process did not answer in time");
	}
	const res = r.fields as unknown as SourceResult;
	if (!res.ok) throw new Error(res.error ?? "the sources process refused the request");
	return res;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const host = await startSourceHost();
	console.log(`[sources] reading for ${process.env.FORUM_SPACE || DEFAULT_SPACE}; repositories: ${host.repos.join(", ") || "none"}; remote hosts: ${host.hosts.join(", ") || "none"}; spaces-files: ${host.files ? `${host.files.tenant} as ${host.files.host}` : "none"}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 4000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
