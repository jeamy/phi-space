// Limits every model process shares through the space: model calls per minute and per day, web searches per day. One
// admission at a time per limit (its QuotaLock, taken under a transaction and written back), and every admitted use is
// a QuotaUse entry, counted per minute and per day in that same transaction. So two model processes never both take
// the last call of a day. A day is the UTC calendar day.
import type { SpaceLike } from "phi-spaces";
import { StillHeld, takeExisting } from "./space.ts";
import { today } from "./limits.ts";

/** How long an admitted use counts (a day and a margin; a minute's count needs far less). */
const USE_LEASE_MS = 26 * 3600_000;
const LOCK_LEASE_MS = 15_000;

export type QuotaLimits = { perMin?: number; perDay?: number };
/** `ok`: one use admitted and counted. `day`: the day's uses are taken. `retryMs`: the minute's uses are taken, the
 *  next minute starts in that time. */
export type QuotaAnswer = { ok: true } | { ok: false; day: true } | { ok: false; retryMs: number };

/** Admits one use of the limit `key` (0 or missing: no limit of that kind). */
export async function takeQuota(space: SpaceLike, key: string, l: QuotaLimits): Promise<QuotaAnswer> {
	for (let tries = 0; ; tries++) {
		const t = await space.createTransaction(LOCK_LEASE_MS);
		try {
			const lock = { type: "QuotaLock", fields: { key } };
			const took = !!(await takeExisting(space, lock, { txn: t.id }));
			// the first use of this limit makes its lock (unique: of two processes doing so at once, one tries again)
			if (!took) await space.write({ type: "QuotaLock", fields: { key, ts: Date.now() } }, t.id, USE_LEASE_MS, { unique: ["key"] });
			const now = Date.now(), day = today(), minute = Math.floor(now / 60_000);
			let answer: QuotaAnswer = { ok: true };
			if (l.perDay && (await space.count({ type: "QuotaUse", fields: { key, day } }, t.id)) >= l.perDay) answer = { ok: false, day: true };
			else if (l.perMin && (await space.count({ type: "QuotaUse", fields: { key, minute } }, t.id)) >= l.perMin) answer = { ok: false, retryMs: (minute + 1) * 60_000 - now };
			else await space.write({ type: "QuotaUse", fields: { key, day, minute, ts: now } }, t.id, USE_LEASE_MS);
			if (took) await space.write({ type: "QuotaLock", fields: { key, ts: now } }, t.id, USE_LEASE_MS);
			await space.commit(t.id);
			return answer;
		} catch (e) {
			await space.abort(t.id).catch(() => {});
			// held by another process for long, or made by another one at the same moment: try again
			if (tries < 20 && (e instanceof StillHeld || /unique/i.test((e as Error).message))) continue;
			throw e;
		}
	}
}

/** Waits for one admitted use: a full minute waits for the next one; a used-up day throws `dayError`. */
export async function awaitQuota(space: SpaceLike, key: string, l: QuotaLimits, dayError: string): Promise<void> {
	for (;;) {
		const a = await takeQuota(space, key, l);
		if (a.ok) return;
		if ("day" in a) throw new Error(dayError);
		await new Promise((r) => setTimeout(r, Math.max(250, a.retryMs)));
	}
}
