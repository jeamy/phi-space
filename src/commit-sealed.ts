// The error of a primary/sync commit that is durably sealed but not confirmed (docs/abnahme/ap3-primary-sync.md). Its own
// module, so the space service can recognise it without loading the journal (node:sqlite) or the store behind it.
export class CommitSealed extends Error{
 readonly revision:number;readonly hash:string;
 constructor(intent:{revision:number;hash:string},cause?:unknown){super('commit is durably sealed; resolve this candidate before admitting new work',{cause});this.revision=intent.revision;this.hash=intent.hash;}
}
const SYNC_BUDGET = Symbol.for('phi-spaces.sync-budget-exceeded');
/** Marks a commit refused before sealing because the sync journal's budget is used up: nothing was written, the host
 *  stays usable. The storage layer's error carries the mark (SyncBudgetExceeded in store/legacy.ts). */
export const markSyncBudgetExceeded = <E extends Error>(e: E): E => Object.assign(e, { [SYNC_BUDGET]: true });
export const isSyncBudgetExceeded = (e: unknown): e is Error => e instanceof Error && (e as unknown as Record<symbol, unknown>)[SYNC_BUDGET] === true;
