// The checker process: runs the mechanical checks (checks.ts) on a version of a plan document, without a model. An
// agent asks for it when a draft is written (CheckRequest); the checker reads the version, the task and the index of
// the task's sources from the space, asks the sources process whether the quoted lines are where the plan says, and
// writes the result (a PlanCheck entry, kept with the version) and its answer in one transaction.
//
//   FORUM_SPACE=unix:/tmp/codemode-forum-space.sock   (default) or tcp:host:4180
import "./env.ts";
import { pathToFileURL } from "node:url";
import { NO_WAIT, TransactionError, type SpaceLike } from "phi-spaces";
import { checkDoc, type PlanCheck, type SourceFiles } from "./checks.ts";
import { fullDoc, headOf } from "./plandoc.ts";
import type { PlanTask } from "./plantask.ts";
import { askSources } from "./source-host.ts";
import type { SourceId } from "./sources.ts";
import { announce, awaitWork, connectSpace, DEFAULT_SPACE, keepAlive } from "./space.ts";

/** A request to check a table's document: its newest version, or the one `version` names. */
export type CheckRequest = { requestId: string; session: string; blockId: string; table: string; version?: number; ttl: number; ts: number };
export type CheckResult = { requestId: string; session: string; ok: boolean; check?: Omit<PlanCheck, "session">; error?: string; ts: number };

const LEASE_MS = Math.max(1000, Number(process.env.FORUM_CHECK_LEASE_MS || 30_000));
const RESULT_LEASE_MS = 10 * 60_000;

/** The files of a block's sources, from the index pages in the space; null when the block has no sources. */
export async function sourceFiles(space: SpaceLike, session: string, blockId: string): Promise<SourceFiles | null> {
	const copy = ((await space.readAll({ type: "PlanSource", fields: { session, blockId, sourceId: "files" } }, { limit: 1 }))[0]?.fields as { copy?: string } | undefined)?.copy;
	// a workspace copy's pages count only for the copy its PlanSource names (an attempt cut off may have left others)
	const pages = (await space.readAll({ type: "SourceIndex", fields: { session, blockId } }, { limit: 2000 })).map((e) => e.fields as unknown as { sourceId: string; copy?: string; paths: Array<[string, number]> }).filter((p) => p.sourceId !== "files" || p.copy === copy);
	if (!pages.length) return null;
	const files: SourceFiles = new Map();
	// the documents a person uploaded come first: a name that is in both is the document's
	for (const p of pages.sort((a, b) => a.sourceId.localeCompare(b.sourceId))) for (const [path] of p.paths) if (!files.has(path)) files.set(path, p.sourceId);
	// the task's pictures are named by their names (images.ts): one cited in backticks is no file the plan makes up
	for (const e of await space.readAll({ type: "TaskImage", fields: { session, blockId } }, { limit: 20 })) { const name = (e.fields as { name: string }).name; if (!files.has(name)) files.set(name, "picture"); }
	return files;
}

/** The check of a version, as the space has it (null: not checked). */
export async function checkOf(space: SpaceLike, d: { session: string; blockId: string; table: string }, version: number): Promise<PlanCheck | null> {
	return ((await space.readAll({ type: "PlanCheck", fields: { ...d, version } }, { limit: 1 }))[0]?.fields as unknown as PlanCheck | undefined) ?? null;
}

export async function startCheckHost(o: { space?: string } = {}) {
	const conn = connectSpace(o.space);
	const space = conn.space;
	const presence = announce(space, "checker");
	const open = new Set<string>();
	let stopping = false;
	const halt = new AbortController();

	const answerOne = async (): Promise<boolean> => {
		if (!(await awaitWork(space, { type: "CheckRequest" }, halt.signal))) return false;
		const t = await space.createTransaction(LEASE_MS);
		open.add(t.id);
		const stop = keepAlive(space, t.id, LEASE_MS);
		try {
			const e = await space.take({ type: "CheckRequest" }, NO_WAIT, { txn: t.id });
			if (!e) { await space.abort(t.id); return false; }
			const req = e.fields as unknown as CheckRequest;
			let result: Omit<CheckResult, "requestId" | "session" | "ts">;
			try {
				const d = { session: req.session, blockId: req.blockId, table: req.table };
				const doc = await headOf(space, d, req.version);
				const task = (await space.readIfExists({ type: "PlanTask", fields: { session: req.session, blockId: req.blockId } }, NO_WAIT))?.fields as unknown as PlanTask | undefined;
				if (!doc || !task) throw new Error("the document or its task is gone");
				// a line is in a file when a search for it in that file finds it (the sources process; fixed text, any case)
				const quoted = async (source: string, path: string, line: string) => source !== "picture" && !/^No line contains/.test((await askSources(space, { requestId: `${req.requestId}-q${Math.random().toString(36).slice(2, 8)}`, session: req.session, blockId: req.blockId, op: "call", sourceId: source as SourceId, call: { op: "search", query: line.slice(0, 200), glob: path }, ts: Date.now() })).text ?? "");
				const found = await checkDoc(await fullDoc(space, doc), task, await sourceFiles(space, req.session, req.blockId), quoted);
				const check: PlanCheck = { ...d, version: doc.version, ...found, ts: Date.now() };
				// one result a version: an earlier one of the same version is replaced
				for (let n = 0; n < 5 && (await space.take({ type: "PlanCheck", fields: { ...d, version: doc.version } }, NO_WAIT, { txn: t.id })); n++);
				await space.write({ type: "PlanCheck", fields: check as never }, t.id, req.ttl);
				const { session: _s, ...rest } = check;
				result = { ok: true, check: rest };
			} catch (err) { result = { ok: false, error: String((err as Error).message ?? err).slice(0, 300) }; }
			await space.write({ type: "CheckResult", fields: { requestId: req.requestId, session: req.session, ...result, ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
			await space.commit(t.id);
			return true;
		} catch (e) {
			await space.abort(t.id).catch(() => {});
			if (e instanceof TransactionError) return true;
			throw e;
		} finally { stop(); open.delete(t.id); }
	};
	const loops = [0, 1].map(async () => {
		while (!stopping) {
			try { await answerOne(); }
			catch (e) { if (stopping) return; console.error("[checker] request failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
		}
	});
	return {
		async close() {
			stopping = true; halt.abort();
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 3000))]);
			await presence.stop(); conn.close();
		},
	};
}

/** How long a caller waits for the checker (FORUM_CHECK_WAIT_S, default 60 s). */
export const checkWaitMs = () => Math.max(1000, Number(process.env.FORUM_CHECK_WAIT_S || 60) * 1000);

/** Asks the checker and waits for its result. A request nobody took in time is withdrawn; then, and when the checker
 *  says the check could not be made, it throws. */
export async function askChecker(space: SpaceLike, req: CheckRequest, waitMs = checkWaitMs()): Promise<Omit<PlanCheck, "session">> {
	await space.write({ type: "CheckRequest", fields: req as never }, null, waitMs + 60_000);
	const tmpl = { type: "CheckResult", fields: { requestId: req.requestId } };
	let r = null as Awaited<ReturnType<SpaceLike["take"]>>;
	for (const end = Date.now() + waitMs; !r && Date.now() < end; ) r = await space.take(tmpl, Math.min(20_000, Math.max(1, end - Date.now())));
	if (!r) {
		const withdrawn = await space.take({ type: "CheckRequest", fields: { requestId: req.requestId } }, NO_WAIT).catch(() => null);
		throw new Error(withdrawn ? "no checker process answered (is one running?)" : "the checker did not answer in time");
	}
	const res = r.fields as unknown as CheckResult;
	if (!res.ok || !res.check) throw new Error(res.error ?? "the check could not be made");
	return res.check;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const host = await startCheckHost();
	console.log(`[checker] checking for ${process.env.FORUM_SPACE || DEFAULT_SPACE}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 4000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
