// Fixed journal topology. IDs are retained; partitions are never reassigned or resized.
import {createHash} from 'node:crypto';
import {defineDocFamily} from '@earendil-works/pi-durable';
import {canonicalJson} from './canonical.ts';

export const FederationJournalLayout = defineDocFamily<{
    partitions: number|null; routerIds: string[]|null;
    reconciliation?: {hostId:string;spaceId:string;oldIncarnation:string;recoveryId:string}
}, null>({kind:'pi-spaces.federation-journal-layout',version:1,scope:'session',family:true,
    initial:()=>({partitions:null,routerIds:null})});
export function validateJournalPartitions(n:number):void {
    if(!Number.isSafeInteger(n)||n<1||n>1024)throw new TypeError('journalPartitions must be 1..1024');
}
export function operationPartition(id:string,n:number):number {
    validateJournalPartitions(n);
    return parseInt(createHash('sha256').update(canonicalJson(id)).digest('hex').slice(0,8),16)%n;
}
export function parentJournalKey(id:string,n:number,partition:number):string {
    validateJournalPartitions(n);
    if(!Number.isInteger(partition)||partition<0||partition>=n)throw new TypeError('invalid journal partition');
    return n===1?id:createHash('sha256').update(canonicalJson([id,'parent-partition-v1',partition])).digest('hex');
}
export function partitionRouterId(id:string,partition:number):string {
    return 'partition-'+createHash('sha256').update(canonicalJson([id,'router-partition-v1',partition])).digest('hex');
}
