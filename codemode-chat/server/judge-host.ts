// The judge process: takes a CodeCandidate from the shared space under a transaction, runs it in this machine's
// sandbox and writes its CodeScore, and the block's new best code if it is one, in that same transaction. Nothing it
// knows lives in memory: a judge that dies lets its transaction lapse and the candidate comes back for another one.
// Run it on any host that reaches the space (CODEMODE_SPACE); several judge processes share the work by themselves.
//
//   CODEMODE_SPACE=unix:/tmp/codemode-space.sock   (default) or tcp:nano:3800
//   CODEMODE_JUDGES=2                              parallel judges in this process
//   CODEMODE_HOST_NAME=big                         name in the system bar and on the tiles (default: hostname)
import "./env.ts";
import { pathToFileURL } from "node:url";
import { NO_WAIT, TransactionError, type SpaceLike } from "phi-spaces";
import { judgeInSlot, loadCodemode, maxTimeoutMs, sandboxSlot, TIMEOUT_MS, verdictFields, type Codemode, type Verdict } from "./judge.ts";
import { setBest, trimArchive } from "./results.ts";
import { serveExec } from "./exec.ts";
import { announce, awaitWork, connectSpace, entryLeaseMs, hostFacts, keepAlive, readExisting, StillHeld, takeAll } from "./space.ts";
import { taskFromSpec } from "./tasks.ts";

/** A judge's transaction lease, renewed while it judges: a dead judge's candidate is back within this time
 *  (CODEMODE_JUDGE_LEASE_MS). The sandbox holds the judge's thread while the code runs, so no renewal comes during a
 *  case: by default the lease outlasts the longest time limit a task may set (CODEMODE_MAX_TIMEOUT_S) by 30 s. */
const TXN_LEASE_MS = process.env.CODEMODE_JUDGE_LEASE_MS ? Math.max(1000, Number(process.env.CODEMODE_JUDGE_LEASE_MS)) : maxTimeoutMs() + 30_000;

/** A judge that dies hard while judging (its process killed, the sandbox taking it down) leaves its JudgeStart marker
 *  behind; a candidate with this many of them gets a failed verdict instead of taking down the next judge too. */
const MAX_DEATHS = 2;
/** How long a JudgeStart marker counts. */
const START_LEASE_MS = 3600_000;

/** What a verdict carries over from its candidate besides the verdict: the run, the lineage, the usage. */
const lineageOf = (f: Record<string, any>) => Object.fromEntries(["role", "basedOn", "partner", "critiqueId", "proposalId", "usage", "runId"].filter((k) => f[k]).map((k) => [k, f[k]]));

/** One round: wait for a candidate, judge it, write the verdict. False when none came. `open` holds the transactions
 *  in progress, so a judge that is shut down can abort them: a waiting take is kept in the space (it outlives the
 *  process, even a restart of the space) and would otherwise catch the next candidate for a judge that is gone. */
export async function judgeOne(space: SpaceLike, cm: Codemode, host: string, ttl: number, open = new Set<string>(), halt?: AbortSignal): Promise<boolean> {
	// idle, the judge waits holding nothing; the transaction begins when there is a candidate (another judge may be first)
	if (!(await awaitWork(space, { type: "CodeCandidate" }, halt))) return false;
	const t = await space.createTransaction(TXN_LEASE_MS);
	open.add(t.id);
	const stop = keepAlive(space, t.id, TXN_LEASE_MS);
	let marker: string | null = null, stopMarker = () => {}, start: string | null = null, f: Record<string, any> | null = null;
	try {
		const c = await space.take({ type: "CodeCandidate" }, NO_WAIT, { txn: t.id });
		if (!c) { await space.abort(t.id); return false; }
		f = c.fields as Record<string, any>;
		const { session, blockId, candidateId } = f as { session: string; blockId?: string; candidateId: string };
		// the candidate is invisible while this transaction holds it: a marker keeps its tile on the page meanwhile
		// (renewed like the transaction, so a long time limit does not let it lapse while the judge is still at work)
		marker = (await space.write({ type: "CodeJudging", fields: { ...f, host } as never }, null, TXN_LEASE_MS * 2)).id;
		stopMarker = keepAlive(space, marker, TXN_LEASE_MS * 2);
		// a block that was deleted takes its candidates along: consumed, nothing written (a CodeTask another transaction
		// holds for a moment, a changed time limit, is waited for; one held beyond the wait is not taken for gone: the
		// candidate goes back)
		const taskEntry = async () => typeof blockId !== "string" ? null : (await readExisting(space, { type: "CodeTask", fields: { session, blockId } }, { txn: t.id }))?.fields as Record<string, unknown> | undefined ?? false;
		const alive = async () => (await taskEntry()) !== false;
		const deaths = await space.count({ type: "JudgeStart", fields: { session, candidateId } });
		if (deaths >= MAX_DEATHS) {
			if (await alive()) await space.write({ type: "CodeScore", fields: failedVerdict(f, host, `the judge stopped ${deaths} times while judging it`) as never }, t.id, ttl);
			await space.commit(t.id);
			await takeAll(space, { type: "JudgeStart", fields: { session, candidateId } });
			return true;
		}
		// cancelled when this round ends in any way but a hard death of this process
		start = (await space.write({ type: "JudgeStart", fields: { session, candidateId } }, null, START_LEASE_MS)).id;
		// the task: its block's CodeTask (a candidate from before carries its own spec; one without a block names a catalog task)
		const spec = f.custom !== undefined || typeof blockId !== "string" ? f : await taskEntry();
		const task = spec ? taskFromSpec(spec) : null;
		const v: Verdict | null = spec === false ? null : task ? await judgeInSlot(cm, task, String(f.source ?? "")) : { ok: false, ms: TIMEOUT_MS, error: "unknown task", passed: 0, total: 0, cases: [] };
		if (v && (await alive())) {
			await space.write({ type: "CodeScore", fields: { session, blockId, candidateId, author: f.author, via: f.via, host, gen: f.gen, ...lineageOf(f), ...verdictFields(v), source: f.source, ts: f.ts } as never }, t.id, ttl);
			// a correct verdict that beats the block's best (and no person rejected it) becomes the new best
			if (v.ok && task && typeof blockId === "string" && !(await space.readIfExists({ type: "CodeVeto", fields: { session, candidateId } }, NO_WAIT, { txn: t.id })))
				await setBest(space, t.id, session, blockId, task, ttl, { offer: { candidateId, ms: v.ms, source: String(f.source ?? "") } });
		}
		await space.commit(t.id);
		return true;
	} catch (e) {
		await space.abort(t.id).catch(() => {});
		if (e instanceof StillHeld) return true; // the block's task stayed held: the candidate is back for a later round
		// the transaction lapsed: the candidate is back for another try. A commit over the space's limits fails
		// with ResourceExhausted and would fail every time: that one goes to the failed verdict below
		if (e instanceof TransactionError) return true; // a limit of the space is ResourceExhausted, not a TransactionError
		// the verdict could not be stored (a limit of the space): the candidate is consumed with a short failed verdict,
		// or it would come back to every judge forever
		if (f) await failed(space, f, host, ttl, (e as Error).message).catch(() => { throw e; });
		else throw e;
		return true;
	} finally {
		stop(); open.delete(t.id);
		stopMarker();
		if (marker) await space.cancel(marker).catch(() => {});
		if (start) await space.cancel(start).catch(() => {});
	}
}

/** A failed verdict without code for a candidate that could not be judged; the run's barrier counts it (runId), lineage
 *  and usage stay with it. */
const failedVerdict = (f: Record<string, any>, host: string, error: string) => ({ session: f.session, blockId: f.blockId, candidateId: f.candidateId, author: f.author, via: f.via, host, gen: f.gen, ...lineageOf(f), ok: false, ms: TIMEOUT_MS, passed: 0, total: 0, cases: [], error, source: "", ts: f.ts });

/** Consumes a candidate whose verdict could not be stored, with a failed verdict that carries no code. */
async function failed(space: SpaceLike, f: Record<string, any>, host: string, ttl: number, why: string): Promise<void> {
	const t = await space.createTransaction(30_000);
	try {
		if (await space.take({ type: "CodeCandidate", fields: { session: f.session, candidateId: f.candidateId } }, NO_WAIT, { txn: t.id }))
			await space.write({ type: "CodeScore", fields: failedVerdict(f, host, `the verdict could not be stored: ${String(why).slice(0, 150)}`) as never }, t.id, ttl);
		await space.commit(t.id);
	} catch (e) { await space.abort(t.id).catch(() => {}); throw e; }
}

export async function startJudgeHost(o: { space?: string; judges?: number; cm?: Codemode } = {}) {
	const cm = o.cm ?? (await loadCodemode());
	if (!cm) throw new Error("@earendil-works/pi-codemode could not be loaded");
	const conn = connectSpace(o.space);
	const space = conn.space, host = hostFacts().name, ttl = entryLeaseMs();
	const presence = announce(space, "judge");
	let stopping = false, rounds = 0;
	const open = new Set<string>(), halt = new AbortController();
	const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
	/** A judge: the sandbox slot first, then the transaction. A failing round is logged and retried after a pause. */
	const worker = async () => {
		while (!stopping) {
			try {
				await sandboxSlot(() => judgeOne(space, cm, host, ttl, open, halt.signal));
				if (++rounds % 50 === 0) await trimArchive(space).catch(() => {});
			} catch (e) {
				if (stopping) return;
				console.error("[judge] round failed", (e as Error).message);
				await pause(1_000);
			}
		}
	};
	const loops = Array.from({ length: Math.max(1, o.judges ?? Number(process.env.CODEMODE_JUDGES ?? 2)) }, () => worker());
	// ▶ of the page: runs of contributions, apart from the judging (exec.ts)
	const runs = serveExec(space, cm, host);
	return {
		/** Stops the judges: their transactions are aborted (a candidate in judgement comes back at once, a waiting take
		 *  ends), then the process leaves the space. */
		async close() {
			stopping = true; halt.abort();
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await runs.close();
			await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 2000))]);
			await presence.stop(); conn.close();
		},
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const judge = await startJudgeHost();
	console.log(`[judge] ${hostFacts().name}: judging from ${process.env.CODEMODE_SPACE || "unix:/tmp/codemode-space.sock"}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await judge.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
