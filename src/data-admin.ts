// Trusted local admin effects. Successful batches and their progress commit atomically.
import type {Context} from './context.ts';
import { defineDocFamily } from './store/documents.ts';
import {createHash} from 'node:crypto';
import type {SpaceHost} from './client.ts';
import {claimPage,pendingClaims,setRestored,type ClaimRec,type Principal} from './claims.ts';
import {diskMapOf} from './store/types.ts';
import {canonicalJson,digestJson} from './canonical.ts';
import {principalId} from './mailbox.ts';
import {spaceDoc} from './spaces.ts';
import {seal as sealStream} from './stream.ts';
import * as core from './core.ts';
import { jsonBytes } from './json.ts';

type Phase = 'registrations'|'mailboxes'|'claims'|'generations'|'entries'|'history'|'completed';
type Audit = {hash:string;at:number;kind:'purgeTasks'|'deletePrincipal';admin:string;count:number};
type Command = Audit & {phase?:Phase;principal?:Principal;incarnation?:string|null;authorityId?:string|null;batches?:number;
 /** Claims on the disk: the key the claims phase handled last (walked in key order, not read whole each step). */
 claimKey?:string;
 /** Likewise for the historical claims (restoredClaims). */
 restoredKey?:string};
export const DataAdminJournal=defineDocFamily<{commands:Record<string,Command>},null>({
 kind:'phi-spaces.data-admin',version:1,scope:'session',family:true,initial:()=>({commands:{}})
});
const bytes=jsonBytes;
const audit=(c:Command):Audit=>({hash:c.hash,at:c.at,kind:c.kind,admin:c.admin,count:c.count});
function commandHash(id:string,kind:Audit['kind'],spaceId:string,admin:string,input:core.Template|Principal) {
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)||['__proto__','constructor','prototype'].includes(id))throw new core.IllegalArgumentError('invalid admin command ID');
 if(typeof spaceId!=='string'||!spaceId||spaceId.length>128||typeof admin!=='string'||!admin||admin.length>128)throw new core.IllegalArgumentError('invalid admin or Space identifier');
 if(!['purgeTasks','deletePrincipal'].includes(kind))throw new core.IllegalArgumentError('invalid admin command kind');
 return digestJson({kind,spaceId,admin,input} as any);
}
function validatePrincipal(p:Principal) {
 if(!p||typeof p.peerId!=='string'||!p.peerId||p.peerId.length>128||p.agentId!==undefined&&(typeof p.agentId!=='string'||!p.agentId||p.agentId.length>128)||Object.keys(p).some(k=>!['peerId','agentId'].includes(k)))throw new core.IllegalArgumentError('invalid deletion principal');
}
function assertTuple(c:Command,s:core.SpaceState) {
 if(c.incarnation!==undefined&&(c.incarnation!==(s.incarnation??null)||c.authorityId!==(s.acceptedAuthorityId??s.membership?.authorityId??null)))throw new core.TransactionError('deletion incarnation or authority changed; restore review required');
}
function stableSpace(s:core.SpaceState,id:string) {if(s.spaceId!==id)throw new core.IllegalArgumentError('admin commands require the immutable Space ID');}
function quiescent(s:core.SpaceState) {
 if(Object.keys(s.txns).length||s.waiters.length||(s.jobs??[]).length||(s.releaseQueue??[]).length||pendingClaims(s).length>0)throw new core.TransactionError('principal deletion requires a quiescent Space');
}
function reserveHeader(s:core.SpaceState,now:number,id:string) {
 if(!core.maintenanceStep(s,1024,now,'delete-principal:'+id))throw new core.ResourceExhausted('admin metadata exceeds maxCommitBytes');
}
export class DataAdminController {
 private o:{host:SpaceHost;ctx:Context;assertAuthority:()=>Promise<void>;authorize:(admin:string,scope:Audit['kind'],spaceId:string)=>Promise<void>;now?:()=>number};
 constructor(o:DataAdminController['o']){this.o=o;}
 private async check(admin:string,kind:Audit['kind'],sid:string) {await this.o.authorize(admin,kind,sid);await this.o.assertAuthority();}
 async execute(id:string,kind:Audit['kind'],spaceId:string,admin:string,input:core.Template|Principal):Promise<Audit> {
  const hash=commandHash(id,kind,spaceId,admin,input);
  if(kind==='deletePrincipal') {
   await this.startDeletion(id,spaceId,admin,input as Principal);
   for(;;) {const r=await this.advanceDeletion(id,spaceId,admin,input as Principal);if(r.phase==='completed')return audit(r);}
  }
  await this.check(admin,kind,spaceId);
  return this.o.host.commit(async tx=>{
   await this.check(admin,kind,spaceId);
   const d=await tx.doc(DataAdminJournal,spaceId,null),old=d.commands[id];
   if(old){if(old.hash!==hash)throw new core.IllegalArgumentError('admin command ID changed');const s=await spaceDoc(tx,spaceId,(this.o.now??Date.now)());stableSpace(s,spaceId);assertTuple(old,s);return audit(old);}
   if(Object.keys(d.commands).length>=128)throw new core.ResourceExhausted('admin journal is full');
   const now=(this.o.now??Date.now)(),s=await spaceDoc(tx,spaceId,now);stableSpace(s,spaceId);core.assertAdminIdle(s);
   reserveHeader(s,now,id);const c:Command={hash,kind,admin,at:now,count:core.purgeTasks(s,now,input as core.Template),incarnation:s.incarnation??null,authorityId:s.acceptedAuthorityId??s.membership?.authorityId??null};d.commands[id]=c;await this.check(admin,kind,spaceId);return audit(c);
  },this.o.ctx);
 }
 /** Explicit start/advance are also usable by a supervisor that resumes one batch at a time. */
 async startDeletion(id:string,spaceId:string,admin:string,p:Principal) {
  validatePrincipal(p);const hash=commandHash(id,'deletePrincipal',spaceId,admin,p);await this.check(admin,'deletePrincipal',spaceId);
  return this.o.host.commit(async tx=>{
   await this.check(admin,'deletePrincipal',spaceId);const d=await tx.doc(DataAdminJournal,spaceId,null),old=d.commands[id];
   if(old){if(old.hash!==hash)throw new core.IllegalArgumentError('admin command ID changed');const s=await spaceDoc(tx,spaceId,(this.o.now??Date.now)());stableSpace(s,spaceId);assertTuple(old,s);return { ...audit(old),phase:old.phase??'completed',batches:old.batches??0};}
   if(Object.keys(d.commands).length>=128)throw new core.ResourceExhausted('admin journal is full');
   const now=(this.o.now??Date.now)(),s=await spaceDoc(tx,spaceId,now);stableSpace(s,spaceId);core.assertAdminIdle(s);core.settle(s,now);quiescent(s);reserveHeader(s,now,id);
   s.adminMaintenance={commandId:id,hash};s.snapshotEpoch=(s.snapshotEpoch??0)+1;
   if(core.docBytes(s)>core.limitsOf(s).maxDocBytes)throw new core.ResourceExhausted('admin fence exceeds maxDocBytes');
   d.commands[id]={hash,kind:'deletePrincipal',admin,at:now,count:0,phase:'registrations',principal:core.plain(p),incarnation:s.incarnation??null,authorityId:s.acceptedAuthorityId??s.membership?.authorityId??null,batches:0};core.touch(s,now);
   await this.check(admin,'deletePrincipal',spaceId);
   return {...audit(d.commands[id]!),phase:'registrations' as Phase,batches:0};
  },this.o.ctx);
 }
 async advanceDeletion(id:string,spaceId:string,admin:string,p:Principal):Promise<Audit&{phase:Phase;batches:number}> {
  validatePrincipal(p);const hash=commandHash(id,'deletePrincipal',spaceId,admin,p);await this.check(admin,'deletePrincipal',spaceId);
  return this.o.host.commit(async tx=>{
   await this.check(admin,'deletePrincipal',spaceId);const d=await tx.doc(DataAdminJournal,spaceId,null),c=d.commands[id];
   if(!c)throw new core.IllegalArgumentError('unknown deletion command');if(c.hash!==hash)throw new core.IllegalArgumentError('admin command ID changed');
   const now=(this.o.now??Date.now)(),s=await spaceDoc(tx,spaceId,now);stableSpace(s,spaceId);assertTuple(c,s);
   if(!c.phase||c.phase==='completed')return {...audit(c),phase:'completed',batches:c.batches??0};
   if(s.adminMaintenance?.commandId!==id||s.adminMaintenance.hash!==hash||c.incarnation!==(s.incarnation??null)||c.authorityId!==(s.acceptedAuthorityId??s.membership?.authorityId??null))throw new core.TransactionError('deletion fence or incarnation changed; restore review required');
   quiescent(s);reserveHeader(s,now,id);eraseBatch(s,c,p,now,id);
   c.batches=(c.batches??0)+1;
   const phase=(c as Command).phase!;
   if(phase==='completed') {delete c.principal;delete s.adminMaintenance;delete s.maintenance;s.snapshotEpoch=(s.snapshotEpoch??0)+1;}
   core.touch(s,now);await this.check(admin,'deletePrincipal',spaceId);return {...audit(c),phase,batches:c.batches};
  },this.o.ctx);
 }
}
function eraseBatch(s:core.SpaceState,c:Command,p:Principal,now:number,id:string) {
 const pid=principalId(p),same=(q:Principal)=>principalId(q)===pid,ids=new Set(s.entries.filter(e=>e.owner===pid).map(e=>e.id));
 let mutations=0;
 // Removal ops encode tombstones/paths, not the old payload. Charge their bounded metadata, like ACK maintenance.
 const spend=(cost:number)=>{
  if(mutations>=32)return false;
  if(!core.maintenanceStep(s,cost,now,'delete-principal:'+id)){
   if(mutations===0)throw new core.ResourceExhausted('one deletion tombstone exceeds maxCommitBytes; operator review required');
   return false;
  }
  mutations++;return true;
 };
 const affected=(v:unknown):boolean=>typeof v==='string'?(v===pid||ids.has(v)):
  v!==null&&typeof v==='object'?Object.values(v).some(affected):false;
 switch(c.phase) {
  case 'registrations': {
   for(let i=s.regs.length-1;i>=0;i--){const r=s.regs[i]!;
    if(r.target===pid||r.consumer&&same(r.consumer)){if(!spend(256))return;s.regs.splice(i,1);}
    else if(r.pendingEntry&&ids.has(r.pendingEntry.id)){if(!spend(256))return;delete r.pendingEntry;r.pending=0;}
   }
   for(let i=s.outbox.length-1;i>=0;i--){const e=s.outbox[i]!;if(e.target===pid||e.entry&&ids.has(e.entry.id)){if(!spend(256))return;s.outbox.splice(i,1);}}
   c.phase='mailboxes';return;
  }
  case 'mailboxes': {
   for(const [key,b]of Object.entries(s.mailboxes?.boxes??{})) {
    if(same(b.principal)){if(!spend(256+bytes(key)))return;delete s.mailboxes!.boxes[key];}
    else if(b.events.some(e=>e.event.entry&&ids.has(e.event.entry.id))) {
     if(!spend(512+bytes(key)))return;
     b.gap={epoch:b.epoch,from:b.acked+1,to:b.next-1};b.epoch='deleted-'+createHash('sha256').update(b.epoch+id).digest('hex');b.acked=b.next-1;b.delivered=b.acked;b.events=[];b.bytes=2;
    }
   }
   c.phase='claims';return;
  }
  case 'claims': {
   // claims are values (a store may freeze them): a changed one is replaced. Claims on the disk are walked in key order
   // from the key handled last (c.claimKey) and keep their tally per change.
   {const claims=s.rpc?.claims;
    const disk=diskMapOf<ClaimRec>(claims),inRpc=true;
    const change=(key:string,before:ClaimRec,next:ClaimRec|undefined)=>{if(disk&&inRpc){s.rpc!.bytes=(s.rpc!.bytes??0)-bytes(before)+(next?bytes(next):-bytes(key)-2);s.rpc!.reservedBytes=Math.max(0,(s.rpc!.reservedBytes??0)-(before.reservedResultBytes??0));}if(next)claims![key]=next;else delete claims![key];};
    const handle=(key:string,claim:ClaimRec):boolean=>{
     if(same(claim.principal)){if(!spend(256+bytes(key)))return false;change(key,claim,undefined);}
     else if(claim.result!==undefined&&affected(claim.result)){if(!spend(256+bytes(key)))return false;const {result:_r,reservedResultBytes:_b,...rest}=claim;change(key,claim,{...rest,resultExpired:true});}
     return true;
    };
    if(disk){for(let page=disk.page(c.claimKey??null,64);page.length;page=disk.page(c.claimKey??null,64))for(const [key,claim]of page){if(!handle(key,claim))return;c.claimKey=key;}}
    else for(const [key,claim]of Object.entries(claims??{}))if(!handle(key,claim)){tally(s);return;}
   }
   // the historical claims: in key order from the key handled last (c.restoredKey), with their own tally
   for(let page=claimPage(s.restoredClaims,c.restoredKey??null,64);page.length;page=claimPage(s.restoredClaims,c.restoredKey??null,64))for(const [key,claim]of page){
    if(same(claim.principal)){if(!spend(256+bytes(key))){if(!diskMapOf(s.rpc?.claims))tally(s);return;}setRestored(s,key,undefined);}
    else if(claim.result!==undefined&&affected(claim.result)){if(!spend(256+bytes(key))){if(!diskMapOf(s.rpc?.claims))tally(s);return;}const {result:_r,reservedResultBytes:_b,...rest}=claim;setRestored(s,key,{...rest,resultExpired:true});}
    c.restoredKey=key;
   }
   if(!diskMapOf(s.rpc?.claims))tally(s);c.phase='generations';return;
  }
  case 'generations': {
   // with claims on the disk the tally is kept per change (tally would read every claim)
   const disk=!!diskMapOf(s.rpc?.claims);
   for(const [g,r]of Object.entries(s.rpc?.generations??{}))if(same(r.principal)){if(!spend(256+bytes(g))){if(!disk)tally(s);return;}if(disk)s.rpc!.bytes=(s.rpc!.bytes??0)-bytes(r)-bytes(g)-2;delete s.rpc!.generations[g];}
   if(!disk)tally(s);c.phase='entries';return;
  }
  case 'entries': {
   for(let i=s.entries.length-1;i>=0;i--)if(s.entries[i]!.owner===pid){if(!spend(256+bytes(s.entries[i]!.id)))return;s.entries.splice(i,1);c.count++;}
   c.phase='history';return;
  }
  case 'history': {
   if(!spend(512))return;
   if(s.stream){s.stream.floor=s.stream.rev;s.stream.log=[];s.stream.bytes=0;sealStream(s);}
   c.phase='completed';return;
  }
 }
}
function tally(s:core.SpaceState) {
 if(s.rpc){s.rpc.bytes=bytes(s.rpc.claims)+bytes(s.rpc.generations);s.rpc.reservedBytes=Object.values(s.rpc.claims).reduce((n,c)=>n+(c.reservedResultBytes??0),0);}
}
