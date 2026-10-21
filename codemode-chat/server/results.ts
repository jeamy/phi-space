// A block's result in the space: its best code (CodeBest) and the archived result (CodeEarlier) that later, similar
// tasks get as material. Whoever changes them does so inside its own transaction, so a crash in between leaves both as
// they were. CodeBest is the lock: a writer takes it (takeIfExists waits while another transaction holds it), and the
// first CodeBest of a block is written `unique`, so of two judges that both find none, the second tries again.
// CodeBest names the verdict (candidate and time) and carries no code: the code is in the CodeScore and the archive,
// and a judge's commit (verdict, best, archive) has to fit the space's commit limit.
import { FOREVER, NO_WAIT, type SpaceLike } from "../../src/index.ts";
import { isText, type Task } from "./tasks.ts";

/** Accepted results kept as material for later tasks (one per block); the oldest give way. */
export const EARLIER_CAP = 1000;
const envNumber = (name: string, dflt: number) => { const raw = process.env[name]; const n = raw === undefined || raw.trim() === "" ? dflt : Number(raw); return Number.isFinite(n) && n >= 0 ? n : dflt; };
/** How long an accepted result stays as material for later tasks (CODEMODE_EARLIER_DAYS, default 30; 0 = always). */
export const earlierLeaseMs = () => { const d = envNumber("CODEMODE_EARLIER_DAYS", 30); return d === 0 ? FOREVER : Math.max(60_000, Math.round(d * 86_400_000)); };

/** A verdict time that can stand in a ranking: finite and not negative. */
export const validMs = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
export type BestCode = { candidateId: string; ms: number; source: string };
const WAIT_MS = 10_000;
const isUnique = (e: unknown) => /unique entry already exists/i.test((e as Error)?.message ?? "");

/** Replaces a block's archived result in `txn` (null: there is none, the entry goes). */
export async function archive(space: SpaceLike, txn: string | null, session: string, blockId: string, task: Task, r: { result: string; by: string; human?: boolean } | null): Promise<void> {
	while (await space.takeIfExists({ type: "CodeEarlier", fields: { session, blockId } }, WAIT_MS, { txn }));
	if (!r || !r.result.trim()) return;
	await space.write({ type: "CodeEarlier", fields: { session, blockId, kind: isText(task) ? "text" : "code", taskId: task.id, fn: task.fn, question: task.prompt.en, result: r.result, by: r.by, ...(r.human ? { human: true } : {}), ts: Date.now() } }, txn, earlierLeaseMs());
}

/** Keeps the archive at EARLIER_CAP entries: the oldest give way (best effort, outside any transaction). */
export async function trimArchive(space: SpaceLike): Promise<void> {
	const all = { type: "CodeEarlier" };
	const n = await space.count(all);
	if (n <= EARLIER_CAP) return;
	const old = (await space.readAll(all, { limit: n })).sort((a, b) => Number((a.fields as { ts: number }).ts) - Number((b.fields as { ts: number }).ts));
	for (const e of old.slice(0, n - EARLIER_CAP)) await space.take({ id: e.id }, NO_WAIT);
}

/** Sets a block's best code in `txn`. `offer`: a new correct verdict, kept only when it is faster than the best there
 *  (ties keep the earlier one); `replace`: the best recomputed (after a veto), null for none. The archive follows.
 *  Returns whether the best changed. */
export async function setBest(space: SpaceLike, txn: string, session: string, blockId: string, task: Task, ttl: number, change: { offer: BestCode } | { replace: BestCode | null }): Promise<boolean> {
	for (let tries = 0; tries < 5; tries++) {
		const held = await space.takeIfExists({ type: "CodeBest", fields: { session, blockId } }, WAIT_MS, { txn });
		const cur = held?.fields as { candidateId?: string; ms?: unknown; source?: string } | undefined;
		const next = "replace" in change ? change.replace : cur && validMs(cur.ms) && cur.ms <= change.offer.ms ? null : change.offer;
		if ("offer" in change && !next) { await space.write({ type: "CodeBest", fields: cur as never }, txn, ttl); return false; } // not faster: put it back
		if (!next) { await archive(space, txn, session, blockId, task, null); return !!held; }
		try {
			await space.write({ type: "CodeBest", fields: { session, blockId, candidateId: next.candidateId, ms: next.ms } }, txn, ttl, held ? {} : { unique: ["session", "blockId"] });
		} catch (e) {
			if (!held && isUnique(e)) continue; // another writer made the first one meanwhile: take that one now
			throw e;
		}
		await archive(space, txn, session, blockId, task, { result: next.source, by: `the best correct code there, ${next.ms} ms` });
		return true;
	}
	throw new Error("CodeBest stayed contended");
}
