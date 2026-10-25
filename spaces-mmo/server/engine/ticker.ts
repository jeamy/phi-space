// Recurring jobs as entries (Evennia's Scripts and TickerHandler, docs/evennia-abbildung.md): a Ticker entry says when
// its job is due next. Every world worker looks; the one that takes a due ticker (in a transaction) runs the job and
// writes the ticker back with the next due time, so the job runs once however many workers there are. A worker that
// dies in the middle lets its transaction lapse and the ticker comes back to run again.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type TickerFields } from "../model.ts";

export type Job = { key: string; everyMs: number; run: () => Promise<void> };

/** Writes the tickers of `jobs` that are missing, first due one interval from now (a fresh world does not take a
 *  fog step the moment it starts). */
export async function ensureTickers(space: SpaceLike, jobs: Array<Pick<Job, "key" | "everyMs">>, txn: string | null = null): Promise<void> {
	for (const j of jobs) if (!(await space.readIfExists({ type: "Ticker", fields: { key: j.key } }, 2_000, txn ? { txn } : {}))) await space.write({ type: "Ticker", fields: { key: j.key, due: Date.now() + j.everyMs } satisfies TickerFields as never }, txn, FOREVER);
}

/** Runs every job whose ticker is due and free. Returns how long until the next one is due (at most `maxWaitMs`). */
export async function runDue(space: SpaceLike, jobs: Job[], o: { txnMs: number; maxWaitMs: number }): Promise<number> {
	let next = o.maxWaitMs;
	for (const e of await space.readAll({ type: "Ticker" })) {
		const t = fieldsOf<TickerFields>(e), job = jobs.find((j) => j.key === t.key);
		if (!job) continue;
		const wait = t.due - Date.now();
		if (wait > 0) { next = Math.min(next, wait); continue; }
		const txn = (await space.createTransaction(o.txnMs)).id;
		try {
			if (!(await space.takeIfExists({ type: "Ticker", id: e.id }, NO_WAIT, { txn }))) { await space.abort(txn); continue; } // another worker runs it
			try { await job.run(); } catch (err) { console.error(`[world] ticker ${job.key}:`, (err as Error).message); }
			await space.write({ type: "Ticker", fields: { key: t.key, due: Date.now() + job.everyMs } satisfies TickerFields as never }, txn, FOREVER);
			await space.commit(txn);
			next = Math.min(next, job.everyMs);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return Math.max(20, next);
}
