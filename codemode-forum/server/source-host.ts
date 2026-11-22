// The sources process: the only process that sees repositories. It answers the reading calls of the agents
// (SourceRequest, SourceResult) on a block's source packs, read-only: list a directory, read lines of a file, search
// for a text. It also opens a repository pack when a task is created: it resolves the branch or commit, writes the
// pack's index into the space (SourceIndex pages) and says what it holds. Only this process gets the repositories'
// paths (FORUM_REPOS), as only the model process gets credentials; the others know a repository by its name.
// Uploaded documents lie in the space (SourceFile pages); it reads them from there.
//
//   FORUM_SPACE=unix:/tmp/codemode-forum-space.sock   (default) or tcp:host:4180
//   FORUM_REPOS=name=/abs/path,other=/abs/path        the local git repositories it offers (default: none)
import "./env.ts";
import { existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { NO_WAIT, TransactionError, type SpaceLike } from "phi-spaces";
import { answer, docsPack, gitPack, indexHash, reposOf, resolveCommit, type IndexEntry, type Pack, type PlanSource, type SourceCall } from "./sources.ts";
import { announce, awaitWork, connectSpace, DEFAULT_SPACE, keepAlive } from "./space.ts";

/** A request to the sources process. `open`: a repository (by its name in FORUM_REPOS) at a branch, tag or commit,
 *  for the block's pack; the others: one reading call on a pack of the block. */
export type SourceRequest = { requestId: string; session: string; blockId: string; ts: number } & (
	| { op: "open"; repo: string; ref: string; ttl: number }
	| { op: "call"; sourceId: "docs" | "repo"; call: SourceCall });
/** Its answer. `text`: what a reading call returned (also what the caller got wrong); `opened`: the pack. An `error`
 *  is a failure of the request itself (no such repository, the pack is gone). */
export type SourceResult = { requestId: string; session: string; ok: boolean; text?: string; opened?: Pick<PlanSource, "name" | "commit" | "ref" | "files" | "bytes" | "indexHash">; error?: string; ts: number };

/** A request's transaction lease, renewed while it is answered: a sources process that dies holds its request this
 *  long (FORUM_SOURCE_LEASE_MS, default 20 s). */
const LEASE_MS = Math.max(1000, Number(process.env.FORUM_SOURCE_LEASE_MS || 20_000));
const RESULT_LEASE_MS = 10 * 60_000;
/** The entries of an index page: a page stays well under the space's 64 KiB an entry. */
const INDEX_PAGE_BYTES = 40_000;

/** Test only (FORUM_TEST=1): the first request of FORUM_TEST_SOURCE_PAUSE writes that file and holds here, with the
 *  request taken, until the test kills the process. */
async function holdBeforeAnswer(): Promise<void> {
	const marker = process.env.FORUM_TEST_SOURCE_PAUSE;
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
	const repos = reposOf();
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
			infoLease = (await space.write({ type: "SourceInfo", fields: { procId, repos: [...repos.keys()].sort(), ts: Date.now() } }, null, 30_000)).id;
		} catch (e) { if (!stopping) console.error("[sources] publishing the repositories failed", (e as Error).message); }
	};
	await publish();
	const beat = setInterval(() => void publish(), 10_000); beat.unref?.();

	const packOf = async (req: SourceRequest & { op: "call" }): Promise<Pack> => {
		const src = (await space.readIfExists({ type: "PlanSource", fields: { session: req.session, blockId: req.blockId, sourceId: req.sourceId } }, NO_WAIT))?.fields as unknown as PlanSource | undefined;
		if (!src) throw new Error("This task has no such source");
		if (src.kind === "repo") return cached(`repo:${src.name}@${src.commit}`, () => gitPack(repoPath(src.name), src.commit!));
		return cached(`docs:${req.session}:${req.blockId}:${src.indexHash}`, async () => {
			const parts = (await space.readAll({ type: "SourceFile", fields: { session: req.session, blockId: req.blockId } }, { limit: 500 })).map((e) => e.fields as unknown as { path: string; part: number; text: string });
			const by = new Map<string, string[]>();
			for (const p of parts.sort((a, b) => a.part - b.part)) by.set(p.path, [...(by.get(p.path) ?? []), p.text]);
			return docsPack([...by].map(([path, texts]) => ({ path, text: texts.join("") })));
		});
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
					const path = repoPath(req.repo), commit = await resolveCommit(path, req.ref);
					const pack = await cached(`repo:${req.repo}@${commit}`, () => gitPack(path, commit));
					if (!pack.index.length) throw new Error(`${req.repo} at ${req.ref} has no text file to read`);
					const pages = indexPages(pack.index);
					for (const [part, paths] of pages.entries()) await space.write({ type: "SourceIndex", fields: { session: req.session, blockId: req.blockId, sourceId: "repo", part, parts: pages.length, paths } as never }, t.id, req.ttl);
					result = { ok: true, opened: { name: req.repo, commit, ref: req.ref, files: pack.index.length, bytes: pack.index.reduce((n, [, size]) => n + size, 0), indexHash: indexHash(pack.index) } };
				} else result = { ok: true, text: await answer(await packOf(req), req.call) };
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
	return {
		repos: [...repos.keys()],
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
	console.log(`[sources] reading for ${process.env.FORUM_SPACE || DEFAULT_SPACE}; repositories: ${host.repos.join(", ") || "none"}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 4000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
