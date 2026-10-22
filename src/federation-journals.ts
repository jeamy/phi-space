// Fixed journal topology. IDs are retained; partitions are never reassigned or resized.
import { defineDocFamily } from './store/documents.ts';
import {canonicalJson,digestJson} from './canonical.ts';

export const FederationJournalLayout = defineDocFamily<{
    partitions: number|null; routerIds: string[]|null;
    reconciliation?: {hostId:string;spaceId:string;oldIncarnation:string;recoveryId:string}
}, null>({kind:'phi-spaces.federation-journal-layout',version:1,scope:'session',family:true,
    initial:()=>({partitions:null,routerIds:null})});
export function validateJournalPartitions(n:number):void {
    if(!Number.isSafeInteger(n)||n<1||n>1024)throw new TypeError('journalPartitions must be 1..1024');
}
export function operationPartition(id:string,n:number):number {
    validateJournalPartitions(n);
    return parseInt(digestJson(id).slice(0,8),16)%n;
}
export function parentJournalKey(id:string,n:number,partition:number):string {
    validateJournalPartitions(n);
    if(!Number.isInteger(partition)||partition<0||partition>=n)throw new TypeError('invalid journal partition');
    return n===1?id:digestJson([id,'parent-partition-v1',partition]);
}
export function partitionRouterId(id:string,partition:number):string {
    return 'partition-'+digestJson([id,'router-partition-v1',partition]);
}
