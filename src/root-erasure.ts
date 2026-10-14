// Exclusive, fenced history maintenance. It does not erase backend history or authorize live Data effects.
import {createHash} from 'node:crypto';
import type {Context} from '@earendil-works/chord';
import {canonicalJson} from './canonical.ts';
import type {SpaceHost} from './client.ts';
import type {Principal} from './claims.ts';
import {FederationJournalLayout,parentJournalKey} from './federation-journals.ts';
import {FederationOperations} from './federated-space.ts';
import {RouterCommands,RouterJournal} from './router.ts';
import {RootErasures,ErasedEntryDigests,type RootErasureOperation} from './root-erasure-doc.ts';
import {RoutingConflict} from './routing-semantics.ts';
export {RootErasures} from './root-erasure-doc.ts';
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value as any)).digest('hex');
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const evidenceKey=(root:string,id:string,digest:string)=>hash([root,id,'entry-digests',digest.slice(0,2)]);
export class RootHistoryErasure {
 private o:{host:SpaceHost;ctx:Context;federationId:string;authorize:()=>Promise<void>;assertExclusiveFenced:()=>Promise<void>};
 constructor(o:RootHistoryErasure['o']){this.o=o;}
 private async check(){await this.o.authorize();await this.o.assertExclusiveFenced();}
 async start(id:string,principal:Principal){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)||['constructor','prototype','__proto__'].includes(id)||!principal||typeof principal.peerId!=='string'||!principal.peerId||principal.peerId.length>128||principal.agentId!==undefined&&(typeof principal.agentId!=='string'||!principal.agentId||principal.agentId.length>128)||Object.keys(principal).some(k=>!['peerId','agentId'].includes(k)))throw new RoutingConflict('invalid Root erasure identity');
  await this.check();return this.o.host.commit(async tx=>{
   await this.check();const ledger=await tx.doc(RootErasures,this.o.federationId,null),h=hash([id,principal]),old=ledger.operations[id];if(old){if(old.hash!==h)throw new RoutingConflict('Root erasure ID changed principal');return copy(old);}
   if(Object.values(ledger.operations).some(o=>o.phase!=='completed')||Object.keys(ledger.operations).length>=32)throw new RoutingConflict('Root erasure already active or history full');
   const layout=await tx.doc(FederationJournalLayout,this.o.federationId,null);if(!layout.partitions||!layout.routerIds||layout.reconciliation)throw new RoutingConflict('Root erasure requires settled journal topology');
   const routerIds=[...new Set([this.o.federationId,...layout.routerIds])];for(const router of routerIds){const j=await tx.doc(RouterJournal,router,null);if(Object.keys(j.future??{}).length||Object.values(j.refs).some(r=>!['completed','failed'].includes(r.state)))throw new RoutingConflict('Root Child work must settle before erasure');}
   const parents:any[]=[];for(let n=0;n<layout.partitions;n++){const d=await tx.doc(FederationOperations,parentJournalKey(this.o.federationId,layout.partitions,n),null);parents.push(...Object.values(d.operations));}
   if(parents.some(p=>p.phase!=='done')||parents.some(p=>!p.erased&&p.kind==='txn'&&p.args?.action==='begin'&&!parents.some(done=>done.kind==='txn'&&done.args?.originId===p.id&&['commit','abort'].includes(done.args?.action))))throw new RoutingConflict('Root Parent work must settle before erasure');
   const op:RootErasureOperation={hash:h,subjectHash:hash(principal),principal:copy(principal),phase:'collecting',partition:0,cursor:0,parents:0,children:0,routerIds,partitions:layout.partitions};ledger.operations[id]=op;await this.check();return copy(op);
  },this.o.ctx);
 }
 /** Ingest IDs captured from the fenced Member before local erasure. Only hashes remain in Root metadata. */
 async addEntryEvidence(id:string,entryIds:string[]){
  if(!Array.isArray(entryIds)||entryIds.length>32||entryIds.some(v=>typeof v!=='string'||!v||v.length>256))throw new RoutingConflict('bounded entry evidence required');await this.check();
  await this.o.host.commit(async tx=>{await this.check();const op=(await tx.doc(RootErasures,this.o.federationId,null)).operations[id];if(!op||op.phase!=='collecting')throw new RoutingConflict('entry evidence is sealed');for(const entryId of entryIds){const d=hash(entryId),s=await tx.doc(ErasedEntryDigests,evidenceKey(this.o.federationId,id,d),null);s.digests[d]=true;if(Object.keys(s.digests).length>1024)throw new RoutingConflict('entry evidence shard is full');}await this.check();},this.o.ctx);
 }
 async advance(id:string){
  await this.check();return this.o.host.commit(async tx=>{
   await this.check();const ledger=await tx.doc(RootErasures,this.o.federationId,null),op=ledger.operations[id];if(!op)throw new RoutingConflict('unknown Root erasure');if(op.phase==='completed')return copy(op);
   const layout=await tx.doc(FederationJournalLayout,this.o.federationId,null);if(layout.partitions!==op.partitions||layout.reconciliation||hash([...new Set([this.o.federationId,...layout.routerIds??[]])])!==hash(op.routerIds))throw new RoutingConflict('Root erasure topology changed; remain fenced');
   const own=(p:Principal)=>hash(p)===op.subjectHash;
   const remember=async(entryId:string)=>{const d=hash(entryId);(await tx.doc(ErasedEntryDigests,evidenceKey(this.o.federationId,id,d),null)).digests[d]=true;};
   const affected=async(v:any):Promise<boolean>=>{if(!v||typeof v!=='object')return false;if(typeof v.id==='string'){const d=hash(v.id);if((await tx.doc(ErasedEntryDigests,evidenceKey(this.o.federationId,id,d),null)).digests[d])return true;}for(const x of Object.values(v))if(await affected(x))return true;return false;};
   if(op.phase==='collecting'){
    const d=await tx.doc(FederationOperations,parentJournalKey(this.o.federationId,op.partitions,op.partition),null);for(const p of Object.values(d.operations))if(!p.erased&&own(p.principal)&&p.kind==='write'&&typeof (p.result as any)?.id==='string')await remember((p.result as any).id);
    op.partition++;if(op.partition===op.partitions){op.phase='children';op.partition=0;op.cursor=0;}
   }else if(op.phase==='children'){
    const router=op.routerIds[op.partition]!,j=await tx.doc(RouterJournal,router,null),ids=Object.keys(j.refs).sort(),childId=ids[op.cursor];
    if(childId){const d=await tx.doc(RouterCommands,hash([router,childId]),null),c=d.command;if(!c||!['completed','failed'].includes(c.state))throw new RoutingConflict('Child history changed; remain fenced');
     if(!c.erased&&(c.steps.some(s=>own(s.principal))||await affected(c.steps))){c.erased={commandId:id,originalHash:c.hash,subjectHash:op.subjectHash};c.steps=[];c.reviews=[];c.state='completed';j.refs[childId]!.state='completed';op.children++;}op.cursor++;
    }else{op.partition++;op.cursor=0;if(op.partition===op.routerIds.length){op.phase='parents';op.partition=0;}}
   }else{
    const router=layout.routerIds![op.partition]!,d=await tx.doc(FederationOperations,parentJournalKey(this.o.federationId,op.partitions,op.partition),null),ids=Object.keys(d.operations).sort(),parentId=ids[op.cursor];
    if(parentId){const p=d.operations[parentId]!;if(p.phase!=='done')throw new RoutingConflict('Parent history changed; remain fenced');let childErased=false;for(const child of [...Object.values(p.children),...Object.values(p.registrations)])if((await tx.doc(RouterCommands,hash([router,child]),null)).command?.erased)childErased=true;
     if(!p.erased&&(own(p.principal)||childErased||await affected([p.result,p.candidates,p.winner]))){const erased={commandId:id,originalHash:p.hash,subjectHash:op.subjectHash};const placeholder=own(p.principal)?{peerId:'erased'}:copy(p.principal);d.operations[parentId]={id:p.id,hash:p.hash,principal:placeholder,policyVersion:p.policyVersion,members:copy(p.members),kind:p.kind,args:null,phase:'done',children:{},registrations:{},cursor:p.members.length,candidates:{},erased};op.parents++;}op.cursor++;
    }else{op.partition++;op.cursor=0;if(op.partition===op.partitions){op.phase='completed';delete op.principal;}}
   }
   await this.check();return copy(op);
  },this.o.ctx);
 }
 async execute(id:string,principal:Principal){await this.start(id,principal);for(;;){const op=await this.advance(id);if(op.phase==='completed')return op;}}
}
