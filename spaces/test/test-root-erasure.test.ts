import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../src/canonical.ts';
import {RootHistoryErasure,RootErasures} from '../src/root-erasure.ts';
import {FederatedSpace,FederationOperations,FederationUnavailable} from '../src/federated-space.ts';
import {FederationJournalLayout} from '../src/federation-journals.ts';
import {RouterController,RouterCommands,RouterJournal} from '../src/router.ts';
import {ResultExpired} from '../src/claims.ts';
import {BACKENDS,PersistentHome,ctx} from './support/persistent.ts';
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
for(const backend of BACKENDS)test(`${backend}: fenced Root erasure clears subject/foreign cached payloads and retains retry tombstones across every commit fault`,async()=>{
 const home=new PersistentHome(backend);try{
  let host=await home.open(),fenced=true,effects=0;const principal={peerId:'subject',agentId:'private-agent'},foreign={peerId:'other'},target={hostId:'a',spaceId:'jobs',authorityId:'authority',dataIncarnation:'inc',primaryEpoch:1};
  const assertFenced=async()=>{if(!fenced)throw Error('exclusive fenced owner required');};
  const make=()=>new RootHistoryErasure({host,ctx,federationId:'root',authorize:async()=>{},assertExclusiveFenced:assertFenced});
  const router=()=>new RouterController({host,ctx,routerId:'root',authorityId:'authority',target:{protocol:'phi-spaces-rpc-v1',invoke:async()=>{effects++;throw Error('unexpected effect');},resolve:async()=>{effects++;throw Error('unexpected resolution');}},assertAuthority:async()=>{}});
  await host.commit(async tx=>{const layout=await tx.doc(FederationJournalLayout,'root',null);layout.partitions=1;layout.routerIds=['root'];},ctx);const initialRouter=router();await initialRouter.recover();
  const child=await initialRouter.submit({id:'owned-child',area:'jobs',steps:[{target,principal,generation:'generation',method:'write',args:{entry:{type:'Secret',fields:{value:'subject-payload'}}}}]});
  const other=await initialRouter.submit({id:'foreign-child',area:'jobs',steps:[{target,principal:foreign,generation:'foreign-generation',method:'read',args:{template:{type:'Secret'}}}]});
  await host.commit(async tx=>{
   for(const c of [child,other]){const d=await tx.doc(RouterCommands,hash(['root',c.id]),null);d.command!.state='completed';d.command!.steps[0]!.state='done';d.command!.steps[0]!.result=c.id==='owned-child'?{id:'deleted-entry'}:{id:'deleted-entry',fields:{value:'subject-payload'}};(await tx.doc(RouterJournal,'root',null)).refs[c.id]!.state='completed';}
   const d=await tx.doc(FederationOperations,'root',null);d.reservedBytes=4*128*1024;
   for(const [id,p,childId,result]of [['own-parent',principal,'owned-child',{id:'deleted-entry'}],['foreign-parent',foreign,'foreign-child',{id:'deleted-entry',fields:{value:'subject-payload'}}],['unaffected',foreign,'none',{value:'keep'}],['merge-read',foreign,'none',{state:'done',entry:{id:'["r-a","i-a",7]',type:'Fact',fields:{value:'subject-payload'},owner:principal,replicated:true},replicated:true}]] as const)d.operations[id]={id,hash:hash(id),principal:p,policyVersion:1,members:['a'],kind:'read',args:{template:{type:'Secret'}},phase:'done',children:childId==='none'?{}:{a:childId},registrations:{},cursor:1,candidates:{},result};
  },ctx);
  const f=()=>new FederatedSpace({host,ctx,id:'root',router:router(),state:async()=>({policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'a'},rules:[],completionProfiles:[]},members:{a:{id:'a',state:'active',target}}}),io:{} as any,assertAuthority:async()=>{}});
  fenced=false;await assert.rejects(make().start('erase',principal),/exclusive fenced/);fenced=true;await make().start('erase',principal);await make().addEntryEvidence('erase',['deleted-entry']);await assert.rejects(make().start('erase',foreign),/changed principal/);await assert.rejects(f().resume('own-parent'),FederationUnavailable);
  let batches=0;
  while((await host.snapshot(RootErasures,'root',ctx))!.operations.erase!.phase!=='completed'){
   for(const fault of ['failBeforeCommit','loseAnswer'] as const){home.faults.arm(fault);await assert.rejects(make().advance('erase'),/injected:/);await home.close(host);host=await home.open();}
   batches++;assert.ok(batches<20);
  }
  const record=(await host.snapshot(RootErasures,'root',ctx))!.operations.erase!;assert.equal(record.parents,3,'the merge read is found by its owner, without an evidence ID');assert.equal(record.children,2);assert.equal(record.principal,undefined);assert.equal((await make().start('erase',principal)).phase,'completed');
  const parents=(await host.snapshot(FederationOperations,'root',ctx))!;assert.equal((parents.operations.unaffected!.result as any)?.value,'keep');for(const id of ['own-parent','foreign-parent','merge-read']){assert.ok(parents.operations[id]!.erased);await assert.rejects(f().resume(id),ResultExpired);}
  await router().recover();await assert.rejects(router().advance('owned-child'),/recovering/);const reopened=router();await reopened.recover();await assert.rejects(reopened.advance('owned-child'),ResultExpired);
  const serialized=JSON.stringify(parents)+JSON.stringify(record)+JSON.stringify((await host.snapshot(RouterCommands,hash(['root','owned-child']),ctx))!)+JSON.stringify((await host.snapshot(RouterCommands,hash(['root','foreign-child']),ctx))!);assert.ok(!serialized.includes('subject-payload'));assert.ok(!serialized.includes('private-agent'));assert.equal(effects,0);
  fenced=false;await assert.rejects(make().advance('erase'),/exclusive fenced/);
 }finally{await home.dispose();}
});
