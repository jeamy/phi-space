// Local trusted admin effects. Scope authorization and effect/audit are checked in the same commit.
import type {Context} from '@earendil-works/chord';
import {defineDocFamily} from '@earendil-works/pi-durable';
import type {SpaceHost} from './client.ts';
import type {Principal} from './claims.ts';
import {canonicalJson} from './canonical.ts';
import {principalId} from './mailbox.ts';
import {spaceDoc} from './spaces.ts';
import * as core from './core.ts';
import {createHash} from 'node:crypto';
export const DataAdminJournal=defineDocFamily<{commands:Record<string,{hash:string;at:number;kind:string;admin:string;count:number}>},null>({kind:'pi-spaces.data-admin',version:1,scope:'session',family:true,initial:()=>({commands:{}})});
export class DataAdminController {
 private o:{host:SpaceHost;ctx:Context;assertAuthority:()=>Promise<void>;authorize:(admin:string,scope:'purgeTasks'|'deletePrincipal',spaceId:string)=>Promise<void>;now?:()=>number};
 constructor(o:DataAdminController['o']){this.o=o;}
 async execute(id:string,kind:'purgeTasks'|'deletePrincipal',spaceId:string,admin:string,input:core.Template|Principal) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)||['__proto__','constructor','prototype'].includes(id))throw new core.IllegalArgumentError('invalid admin command ID');
  const hash=createHash('sha256').update(canonicalJson({kind,spaceId,admin,input} as any)).digest('hex');
  await this.o.authorize(admin,kind,spaceId);await this.o.assertAuthority();
  return this.o.host.commit(async tx=>{
   await this.o.authorize(admin,kind,spaceId);await this.o.assertAuthority();
   const journal=await tx.doc(DataAdminJournal,spaceId,null),old=journal.commands[id];
   if(old){if(old.hash!==hash)throw new core.IllegalArgumentError('admin command ID changed');return core.plain(old);}
   if(Object.keys(journal.commands).length>=128)throw new core.ResourceExhausted('admin journal is full');
   const now=(this.o.now??Date.now)(),s=await spaceDoc(tx,spaceId,now);
   const count=kind==='purgeTasks'?core.purgeTasks(s,now,input as core.Template):deletePrincipalIn(s,now,input as Principal);
   const audit={hash,kind,admin,at:now,count};journal.commands[id]=audit;return audit;
  },this.o.ctx);
 }
}
function deletePrincipalIn(s:core.SpaceState,now:number,p:Principal):number {
 if(!p||typeof p.peerId!=='string'||!p.peerId||p.agentId!==undefined&&typeof p.agentId!=='string')throw new core.IllegalArgumentError('invalid deletion principal');
 // Quiescence is required until the distributed freeze/batch protocol is installed. Never erase a live reservation.
 if(Object.keys(s.txns).length||s.waiters.length||(s.jobs??[]).length)throw new core.TransactionError('principal deletion requires a quiescent Space');
 const pid=principalId(p),same=(q:Principal)=>principalId(q)===pid,ids=new Set(s.entries.filter(e=>e.owner===pid).map(e=>e.id));
 const before=core.plain(s);
 s.entries=s.entries.filter(e=>!ids.has(e.id));
 s.regs=s.regs.filter(r=>r.target!==pid&&(!r.consumer||!same(r.consumer)));
 for(const r of s.regs)if(r.pendingEntry&&ids.has(r.pendingEntry.id)){delete r.pendingEntry;r.pending=0;}
 s.outbox=s.outbox.filter(e=>e.target!==pid&&(!e.entry||!ids.has(e.entry.id)));
 for(const [key,b] of Object.entries(s.mailboxes?.boxes??{})){
  if(same(b.principal)){delete s.mailboxes!.boxes[key];continue;}
  // Removing a foreign mailbox item would silently rewrite sequence/ACK history. Fence its old epoch with an explicit gap.
  if(b.events.some(e=>e.event.entry&&ids.has(e.event.entry.id))) { b.gap={epoch:b.epoch,from:b.acked+1,to:b.next-1};b.epoch='deleted-'+createHash('sha256').update(b.epoch+String(now)).digest('hex');b.acked=b.next-1;b.delivered=b.acked;b.events=[];b.bytes=2; }
 }
 for(const claims of [s.rpc?.claims,s.restoredClaims])for(const [key,c] of Object.entries(claims??{})){
  if(same(c.principal)){delete claims![key];continue;}
  if(c.result!==undefined && [...ids].some(id=>JSON.stringify(c.result).includes(id))){delete c.result;c.resultExpired=true;delete c.reservedResultBytes;}
 }
 for(const [g,r]of Object.entries(s.rpc?.generations??{}))if(same(r.principal))delete s.rpc!.generations[g];
 if(s.rpc){s.rpc.bytes=Buffer.byteLength(JSON.stringify(s.rpc.claims))+Buffer.byteLength(JSON.stringify(s.rpc.generations));s.rpc.reservedBytes=Object.values(s.rpc.claims).reduce((n,c)=>n+(c.reservedResultBytes??0),0);}
 // Old stream pages and immutable snapshot tokens must not expose erased fields.
 s.snapshotEpoch=(s.snapshotEpoch??0)+1;
 if(s.stream){s.stream.floor=s.stream.rev;s.stream.log=[];s.stream.bytes=0;}
 core.seal(s);core.touch(s,now);
 const changed=Buffer.byteLength(JSON.stringify(before))+Buffer.byteLength(JSON.stringify(s));
 if(changed>core.limitsOf(s).maxCommitBytes)throw new core.ResourceExhausted('principal deletion needs the bounded batch protocol; no deletion was committed');
 return ids.size;
}
