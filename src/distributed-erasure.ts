// Exclusive operator workflow. Each driver operation must be idempotent for commandHash.
// The independent register and exact target bindings survive a coordinator restart.
import {canonicalJson,digestJson} from './canonical.ts';
import type {Principal} from './claims.ts';
import type {RecoveryRegister} from './recovery-register.ts';
import type {TargetBinding} from './router.ts';
import {ErasureArchiveController} from './erasure-archives.ts';
export type ErasureParticipant = TargetBinding & {root?: boolean};
export type DistributedErasurePlan = {id:string;principal:Principal;participants:ErasureParticipant[];retentionMs:number};
type Phase='fencing'|'floors'|'evidence'|'local'|'root'|'stamp'|'archives'|'seal'|'releasing'|'completed';
type Progress={hash:string;commandHash:string;phase:Phase;cursor:number;epochs:Record<string,number>;entryIds:string[]};
export interface DistributedErasureDriver {
 /** Stop every writer and independently fence exactly these host/space/incarnation tuples. */
 fence(plan:Readonly<DistributedErasurePlan>):Promise<void>;
 /** Verify exclusive stopped writers AND current independent fences on every invocation. */
 assertFenced(plan:Readonly<DistributedErasurePlan>):Promise<void>;
 evidence(target:ErasureParticipant,plan:Readonly<DistributedErasurePlan>):Promise<string[]>;
 eraseLocal(target:ErasureParticipant,plan:Readonly<DistributedErasurePlan>):Promise<void>;
 eraseRoot(target:ErasureParticipant,plan:Readonly<DistributedErasurePlan>,entryIds:readonly string[]):Promise<void>;
 stamp(target:ErasureParticipant,plan:Readonly<DistributedErasurePlan>,epoch:number,commandHash:string):Promise<void>;
 /** Must recheck all sealed floors before resuming any writer; repeatable after partial release. */
 release(plan:Readonly<DistributedErasurePlan>,epochs:Readonly<Record<string,number>>):Promise<void>;
}
const digest=(v:unknown)=>digestJson(v as any);
const clone=<T>(v:T):T=>structuredClone(v);
export class DistributedPrincipalErasure {
 private o:{register:RecoveryRegister;archives:ErasureArchiveController;driver:DistributedErasureDriver;authorize:()=>Promise<void>};
 constructor(o:DistributedPrincipalErasure['o']){this.o=o;}
 private validate(p:DistributedErasurePlan){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(p.id)||!p.principal||typeof p.principal.peerId!=='string'||!p.principal.peerId||p.principal.peerId.length>128||p.principal.agentId!==undefined&&(typeof p.principal.agentId!=='string'||!p.principal.agentId||p.principal.agentId.length>128)||Object.keys(p.principal).some(k=>!['peerId','agentId'].includes(k))||!Number.isSafeInteger(p.retentionMs)||p.retentionMs<0||p.retentionMs>86400000||!p.participants.length||p.participants.length>32||p.participants.filter(t=>t.root).length!==1||new Set(p.participants.map(t=>t.spaceId)).size!==p.participants.length)throw Error('invalid distributed erasure plan');
  for(const t of p.participants)if(['hostId','spaceId','authorityId','dataIncarnation'].some(k=>typeof(t as any)[k]!=='string'||!(t as any)[k]||(t as any)[k].length>128)||!Number.isSafeInteger(t.primaryEpoch)||t.primaryEpoch<1||t.root!==undefined&&typeof t.root!=='boolean'||t.authorityId!==p.participants[0]!.authorityId)throw Error('invalid pinned erasure target');
 }
 async advance(input:DistributedErasurePlan){
  const p=clone(input);this.validate(p);await this.o.authorize();const key='erasure-command:'+p.id,record=await this.o.register.get<any>(key),hash=digest(p);
  if(record&&record.value.hash!==hash)throw Error('erasure command changed binding');
  if(!record){const initial:Progress={hash,commandHash:digest([p.id,p.principal]),phase:'fencing',cursor:0,epochs:{},entryIds:[]};await this.o.register.compareAndSet(key,null,initial as any);return clone(initial);}
  const s=clone(record.value) as Progress;if(s.phase==='completed')return s;
  const next=(phase:Phase)=>{s.phase=phase;s.cursor=0;};
  if(s.phase==='fencing'){await this.o.driver.fence(p);await this.o.driver.assertFenced(p);next('floors');}
  else if(s.phase==='releasing'){
   // Recheck the independent floor set even after a crash during partial release.
   for(const t of p.participants){const f=await this.o.register.get<any>('erasure:'+t.spaceId);if(f?.value.state!=='sealed'||f.value.commandHash!==s.commandHash||f.value.epoch!==s.epochs[t.spaceId])throw Error('all erasure floors must remain sealed before release');}
   await this.o.driver.release(p,s.epochs);s.entryIds=[];next('completed');
  }else{
   await this.o.driver.assertFenced(p);const phase=s.phase,t=p.participants[s.cursor]!;
   switch(s.phase){
    case 'floors':s.epochs[t.spaceId]=(await this.o.archives.begin(t.spaceId,s.commandHash,p.retentionMs)).epoch;break;
    case 'evidence':{const ids=await this.o.driver.evidence(t,p);if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!id||id.length>256))throw Error('invalid erasure evidence');s.entryIds=[...new Set([...s.entryIds,...ids])];if(s.entryIds.length>4096)throw Error('erasure evidence exceeds coordinator budget');break;}
    case 'local':await this.o.driver.eraseLocal(t,p);break;
    case 'root':await this.o.driver.eraseRoot(p.participants.find(t=>t.root)!,p,s.entryIds);next('stamp');break;
    case 'stamp':await this.o.driver.stamp(t,p,s.epochs[t.spaceId]!,s.commandHash);break;
    case 'archives':await this.o.archives.quarantine(t.spaceId,s.commandHash);await this.o.archives.destroyDue(t.spaceId,s.commandHash,true);break;
    case 'seal':await this.o.archives.seal(t.spaceId,s.commandHash,s.epochs[t.spaceId]!);break;
   }
   if(phase!=='root'){
    s.cursor++;if(s.cursor===p.participants.length){const phases:Phase[]=['floors','evidence','local','root','stamp','archives','seal','releasing'];next(phases[phases.indexOf(s.phase)+1]!);}
   }
   await this.o.driver.assertFenced(p);
  }
  await this.o.authorize();await this.o.register.compareAndSet(key,record.version,s as any);return clone(s);
 }
 async execute(plan:DistributedErasurePlan){for(;;){const result=await this.advance(plan);if(result.phase==='completed')return result;}}
}
