// Operator-owned archive catalog and bounded retention; no assertion of secure media overwriting.
import type {RecoveryRegister} from './recovery-register.ts';
import type {ErasureBarrier} from './erasure-barrier.ts';
import {canonicalJson} from './canonical.ts';
export type ErasureArchive={id:string;sha256:string;epoch:number;kind:'backup'|'backend-history';state:'retained'|'quarantined'|'destroyed';deleteBefore?:number};
type Catalog={spaceId:string;artifacts:ErasureArchive[]};
const digest=(v:string)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export class ErasureArchiveController{
 private o:{register:RecoveryRegister;authorize:()=>Promise<void>;destroy:(artifact:Readonly<ErasureArchive>)=>Promise<void>;verifyDeletion:(spaceId:string,epoch:number,commandHash:string)=>Promise<void>;now?:()=>number};
 constructor(o:ErasureArchiveController['o']){this.o=o;}
 private now(){return(this.o.now??Date.now)();}
 private async catalog(spaceId:string){return await this.o.register.get<any>('erasure-archives:'+spaceId);}
 async registerArchive(spaceId:string,artifact:Omit<ErasureArchive,'state'|'deleteBefore'>){
  await this.o.authorize();if(!spaceId||spaceId.length>128||!artifact.id||artifact.id.length>128||!digest(artifact.sha256)||!Number.isSafeInteger(artifact.epoch)||artifact.epoch<0||!['backup','backend-history'].includes(artifact.kind))throw Error('invalid owned archive');
  const floor=await this.o.register.get<any>('erasure:'+spaceId);if(floor&&(floor.value.state!=='sealed'||floor.value.epoch!==artifact.epoch))throw Error('archive does not match completed deletion epoch');
  const current=await this.catalog(spaceId),catalog:Catalog=current?.value??{spaceId,artifacts:[]},old=catalog.artifacts.find(a=>a.id===artifact.id);if(old){if(canonicalJson({...old,state:undefined} as any)!==canonicalJson({...artifact,state:undefined} as any))throw Error('archive ID changed binding');return old;}
  if(catalog.artifacts.length>=128)throw Error('archive catalog is full');const a:ErasureArchive={...artifact,state:'retained'};catalog.artifacts.push(a);await this.o.authorize();await this.o.register.compareAndSet('erasure-archives:'+spaceId,current?.version??null,catalog as any);return a;
 }
 async begin(spaceId:string,commandHash:string,retentionMs:number){
  await this.o.authorize();if(!spaceId||spaceId.length>128||!digest(commandHash)||!Number.isSafeInteger(retentionMs)||retentionMs<0||retentionMs>86400000)throw Error('bounded deletion retention required');
  const old=await this.o.register.get<any>('erasure:'+spaceId);if(old?.value.commandHash===commandHash)return old.value;if(old?.value.state==='pending')throw Error('another deletion is pending');
  const v={spaceId,epoch:(old?.value.epoch??0)+1,state:'pending' as const,commandHash,archiveDeadline:this.now()+retentionMs,archivesPending:true};if(!Number.isSafeInteger(v.epoch))throw Error('deletion epoch exhausted');await this.o.register.compareAndSet('erasure:'+spaceId,old?.version??null,v);return v;
 }
 async quarantine(spaceId:string,commandHash:string){
  await this.o.authorize();const floor=await this.o.register.get<any>('erasure:'+spaceId);if(!floor||floor.value.commandHash!==commandHash)throw Error('unknown deletion');const current=await this.catalog(spaceId);if(!current)return;
  const catalog:Catalog=current.value;for(const a of catalog.artifacts)if(a.epoch<floor.value.epoch&&a.state!=='destroyed'){a.state='quarantined';a.deleteBefore=floor.value.archiveDeadline;}await this.o.register.compareAndSet('erasure-archives:'+spaceId,current.version,catalog as any);
 }
 async destroyDue(spaceId:string,commandHash:string,force=false){
  await this.o.authorize();const floor=await this.o.register.get<any>('erasure:'+spaceId);if(!floor||floor.value.commandHash!==commandHash)throw Error('unknown deletion');
  for(;;){const current=await this.catalog(spaceId);if(!current)break;const catalog:Catalog=current.value,a=catalog.artifacts.find(a=>a.epoch<floor.value.epoch&&a.state!=='destroyed'&&(force||this.now()>=(a.deleteBefore??floor.value.archiveDeadline)));if(!a)break;
   await this.o.authorize();await this.o.destroy(structuredClone(a));a.state='destroyed';await this.o.register.compareAndSet('erasure-archives:'+spaceId,current.version,catalog as any);
  }
 }
 async seal(spaceId:string,commandHash:string,completedEpoch:number){
  await this.o.authorize();const floor=await this.o.register.get<any>('erasure:'+spaceId);if(!floor||floor.value.commandHash!==commandHash||floor.value.epoch!==completedEpoch)throw Error('deletion receipt does not match floor');
  await this.o.verifyDeletion(spaceId,completedEpoch,commandHash);
  const catalog=await this.catalog(spaceId);const remaining=(catalog?.value.artifacts??[]).filter((a:ErasureArchive)=>a.epoch<completedEpoch&&a.state!=='destroyed');if(remaining.some((a:ErasureArchive)=>a.state!=='quarantined'))throw Error('old archive was not quarantined');
  const value={...floor.value,state:'sealed',archivesPending:remaining.length>0};await this.o.register.compareAndSet('erasure:'+spaceId,floor.version,value);return value as ErasureBarrier;
 }
 async assertRestore(spaceId:string,artifactId:string){
  const catalog=await this.catalog(spaceId),a=catalog?.value.artifacts.find((a:ErasureArchive)=>a.id===artifactId),floor=await this.o.register.get<any>('erasure:'+spaceId);if(!a||a.state!=='retained'||floor&&(floor.value.state!=='sealed'||a.epoch!==floor.value.epoch))throw Error('archive restore is blocked by deletion policy');return a as ErasureArchive;
 }
}
