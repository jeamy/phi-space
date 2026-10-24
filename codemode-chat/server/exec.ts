// ▶ through the space: the web process asks (ExecRequest), a judge process runs the contribution in its sandbox
// (runner.ts) and writes what happens as numbered ExecEvent entries, which the web process streams to the page in
// order. The page's Stop is an ExecStop entry the judge watches for. While a run is in progress the judge keeps an
// ExecRun entry. Nothing is scored, and nothing here outlives a few minutes.
//
//   ExecRequest  { execId, session, candidateId, call }   taken by a judge process with a free runner
//   ExecEvent    { execId, seq, evs }                      the events of one flush, seq 0, 1, 2 …
//   ExecStop     { execId }                                the page stopped the run
//   ExecRun      { execId, session, host }                 a run in progress (renewed while it runs)
import { randomBytes } from "node:crypto";
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import type { Codemode } from "./judge.ts";
import { execTarget } from "./room.ts";
import { EXEC_TIMEOUT_MS, execRunning, execute, type ExecEvent } from "./runner.ts";
import { awaitWork, keepAlive } from "./space.ts";

export type ExecRequest = { execId: string; session: string; candidateId: string; call: string; ts: number };

/** How long the events of a run stay for the web process to fetch, and how long a request waits for a judge. */
const EVENT_LEASE_MS = 5 * 60_000, REQUEST_LEASE_MS = 60_000;
/** Events are written together every FLUSH_MS, or sooner when they reach FLUSH_BYTES (an entry holds at most 64 KiB). */
const FLUSH_MS = 100, FLUSH_BYTES = 32 * 1024;
/** Runs one judge process carries at once (the runner's own limit). */
const PARALLEL = 2;
/** How long the web process waits for a judge to take a request before it says none is there. */
export const EXEC_PICKUP_MS = 10_000;

// ---- the judge's side ----

/** Takes requests while this process has a free runner and runs each; `close()` stops taking and aborts the runs. */
export function serveExec(space: SpaceLike, cm: Codemode, host: string): { close: () => Promise<void> } {
	let stopping = false, txn: string | null = null;
	const runs = new Set<AbortController>(), halt = new AbortController();
	const loop = (async () => {
		while (!stopping) {
			if (execRunning() >= PARALLEL) { await new Promise((r) => setTimeout(r, 200)); continue; }
			try {
				// idle, it waits holding nothing (awaitWork); the take is under a transaction a shutdown aborts
				if (!(await awaitWork(space, { type: "ExecRequest" }, halt.signal))) continue;
				const t = await space.createTransaction(30_000);
				txn = t.id;
				const e = await space.take({ type: "ExecRequest" }, NO_WAIT, { txn: t.id }).finally(() => { txn = null; });
				if (!e) { await space.abort(t.id).catch(() => {}); continue; }
				await space.commit(t.id);
				const ac = new AbortController();
				runs.add(ac);
				void runOne(space, cm, host, e.fields as unknown as ExecRequest, ac).finally(() => runs.delete(ac));
			} catch (err) { if (!stopping) { console.error("[judge] taking a run failed", (err as Error).message); await new Promise((r) => setTimeout(r, 1000)); } }
		}
	})();
	return {
		async close() {
			stopping = true; halt.abort();
			if (txn) await space.abort(txn).catch(() => {});
			for (const ac of runs) ac.abort();
			await Promise.race([loop, new Promise((r) => setTimeout(r, 2000))]);
		},
	};
}

/** One run: its events go out in flushes, an ExecStop aborts it, it always ends with an `end` event. */
async function runOne(space: SpaceLike, cm: Codemode, host: string, req: ExecRequest, ac: AbortController): Promise<void> {
	const run = await space.write({ type: "ExecRun", fields: { execId: req.execId, session: req.session, host } }, null, 30_000).catch(() => null);
	const stopRun = run ? keepAlive(space, run.id, 30_000) : () => {};
	let seq = 0, buffer: ExecEvent[] = [], bytes = 0, writing = Promise.resolve();
	const flush = () => {
		if (!buffer.length) return writing;
		const evs = buffer, n = seq++;
		buffer = []; bytes = 0;
		writing = writing.then(() => space.write({ type: "ExecEvent", fields: { execId: req.execId, seq: n, evs } as never }, null, EVENT_LEASE_MS).then(() => {}, (e) => console.error("[judge] an event of a run was lost", (e as Error).message)));
		return writing;
	};
	const emit = (e: ExecEvent) => { buffer.push(e); bytes += JSON.stringify(e).length; if (bytes >= FLUSH_BYTES) void flush(); };
	const timer = setInterval(() => void flush(), FLUSH_MS);
	const watch = setInterval(() => { void space.readIfExists({ type: "ExecStop", fields: { execId: req.execId } }, NO_WAIT).then((s) => { if (s) ac.abort(); }, () => {}); }, 300);
	try {
		const target = await execTarget(space, req.session, req.candidateId);
		if (!target) { emit({ t: "error", text: "Unknown contribution" }); emit({ t: "end", status: "error", ms: 0 }); }
		else emit(await execute(cm, target.task, target.source, req.call, emit, ac.signal));
	} catch (e) {
		emit({ t: "error", text: String((e as Error).message ?? e).slice(0, 300) });
		emit({ t: "end", status: "error", ms: 0 });
	} finally {
		clearInterval(timer); clearInterval(watch);
		await flush();
		stopRun();
		if (run) await space.cancel(run.id).catch(() => {});
		await space.take({ type: "ExecStop", fields: { execId: req.execId } }, NO_WAIT).catch(() => null);
	}
}

// ---- the web process's side ----

/** Asks for a run and yields its events in order until its `end`. Throws "no judge" when no judge process took the
 *  request in time (the request is withdrawn). `signal`: the page went away; the run is stopped. */
export async function* requestExec(space: SpaceLike, session: string, candidateId: string, call: string, signal: AbortSignal): AsyncGenerator<ExecEvent> {
	const execId = `x${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
	await space.write({ type: "ExecRequest", fields: { execId, session, candidateId, call, ts: Date.now() } }, null, REQUEST_LEASE_MS);
	const stop = () => void space.write({ type: "ExecStop", fields: { execId } }, null, 2 * 60_000).catch(() => {});
	signal.addEventListener("abort", stop);
	try {
		const start = Date.now();
		let first = true;
		for (let seq = 0; !signal.aborted; ) {
			const e = await space.take({ type: "ExecEvent", fields: { execId, seq } }, 2_000);
			if (!e) {
				// no judge took it: withdrawn (when it is still there) and said so
				if (first && Date.now() - start > EXEC_PICKUP_MS && (await space.take({ type: "ExecRequest", fields: { execId } }, NO_WAIT))) throw new Error("No judge process takes runs right now; try again in a moment");
				if (Date.now() - start > EXEC_TIMEOUT_MS + 30_000) { yield { t: "error", text: "the judge stopped answering" }; yield { t: "end", status: "error", ms: Date.now() - start }; return; }
				continue;
			}
			first = false; seq++;
			for (const ev of (e.fields as unknown as { evs: ExecEvent[] }).evs) { yield ev; if (ev.t === "end") return; }
		}
	} finally { signal.removeEventListener("abort", stop); }
}
