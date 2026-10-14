// Independent deletion floor. Space snapshots cannot supply or lower this record.
import type {RecoveryRegister} from './recovery-register.ts';
import type {SpaceState} from './core.ts';
export type ErasureBarrier={spaceId:string;epoch:number;state:'pending'|'sealed';commandHash:string;archiveDeadline?:number;archivesPending?:boolean};
export async function checkErasureBarrier(register:RecoveryRegister,spaceId:string,state:Readonly<SpaceState>,now=Date.now()):Promise<number|null>{
 const record=await register.get<any>('erasure:'+spaceId);
 if(!record){if((state.erasureEpoch??0)!==0)throw Error('independent erasure barrier is missing');return null;}
 const v=record.value;
 if(v.spaceId!==spaceId||!Number.isSafeInteger(v.epoch)||v.epoch<1||v.state!=='sealed'||typeof v.commandHash!=='string'||!/^[a-f0-9]{64}$/.test(v.commandHash)||(state.erasureEpoch??0)!==v.epoch)throw Error('erasure barrier requires completed deletion at its current epoch');
 if(v.archivesPending===true&&(!Number.isSafeInteger(v.archiveDeadline)||now>=v.archiveDeadline))throw Error('archive deletion deadline expired; normal service remains fenced');
 return record.version;
}
