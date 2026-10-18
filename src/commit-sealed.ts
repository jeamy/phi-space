// The error of a primary/sync commit that is durably sealed but not confirmed (docs/abnahme/ap3-primary-sync.md). Its own
// module, so the space service can recognise it without loading the journal (node:sqlite).
import {StorageRejected} from '@earendil-works/pi-durable';
export class CommitSealed extends Error{
 readonly revision:number;readonly hash:string;
 constructor(intent:{revision:number;hash:string},cause?:unknown){super('commit is durably sealed; resolve this candidate before admitting new work',{cause});this.revision=intent.revision;this.hash=intent.hash;}
}
/** A commit refused before sealing because the sync journal's budget is used up: nothing was written, the session stays usable. */
export class SyncBudgetExceeded extends StorageRejected{}
