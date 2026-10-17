import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync,copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {PrimarySyncJournal,PrimarySyncBlocked,bootstrapPrimarySync,captureStore,materializeSyncHistory,primarySyncStorage,recoverPrimarySync,PiSpaces,Space,core,createSpace,listSpaces,snapshotSpace,canonicalJson,type PrimarySyncConfig} from './src/index.ts';
import {BACKENDS,PersistentHome,ctx} from './test/support/persistent.ts';

const single:PrimarySyncConfig={spaceId:'bootstrapped',authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:null,durability:'single'};

/** An existing store with pi-spaces activity plus synthetic conversation records and a conversation document. */
async function existingStore(home:PersistentHome){
 const h=await home.open(),local=new PiSpaces(h,ctx,()=>1000);
 await h.commit(tx=>createSpace(tx,'jobs',1000),ctx);
 for(let n=0;n<12;n++)await local.write({type:'Job',fields:{n,pad:'x'.repeat(400)}},null,core.FOREVER);
 const request={principal:{peerId:'worker'},...(await local.issueGeneration({peerId:'worker'})),requestId:'claimed'};
 await local.write({type:'Claimed',fields:{}},null,core.FOREVER,{request});
 await new PiSpaces(h,ctx,()=>1000,undefined,undefined,{space:'jobs'}).write({type:'Named',fields:{}},null,core.FOREVER);
 await home.close(h);
 const st=await home.storage(),conv=await st.mintId<any>(),child=await st.mintId<any>(),e1=await st.mintId<any>(),e2=await st.mintId<any>(),doc=await st.mintId<any>();
 await st.commit([{type:'conversation',value:{id:conv}},{type:'entry',value:{id:e1,conversationId:conv,kind:'note',data:{n:1}}},{type:'entry',value:{id:e2,conversationId:conv,kind:'note',data:{n:2}}},
  {type:'conversation',value:{id:child,parent:{conversationId:conv,at:e1}}},
  {type:'document.create',record:{id:doc,kind:'fixture.conversation-doc',scope:{kind:'conversation',conversationId:conv},history:'latest',fork:'current'} as any,content:{version:1,kind:'base',value:{note:'kept'}}}],ctx);
 await st.close(ctx);
}

for(const backend of BACKENDS){
 test(`${backend}: an existing store bootstraps in chunks; an empty replica replays it and holds exactly the captured store`,async()=>{
  const home=new PersistentHome(backend),replica=new PersistentHome(backend);
  try{
   await existingStore(home);
   const journal=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),single);let st=await home.storage();
   const before=await captureStore(st,ctx);
   assert.ok(before.writes.some(w=>w.type==='conversation')&&before.writes.some(w=>w.type==='entry')&&before.writes.some(w=>w.type==='document.create'&&(w.record.scope as any).kind==='conversation'),'every record kind of the fixture is captured');
   const r=await bootstrapPrimarySync(st,journal,ctx,{chunkBytes:16000});
   assert.ok(r.revisions>2,'small chunks split the store');assert.equal(journal.appliedRevision,r.revisions);assert.equal(r.storeHash,before.digest);
   assert.equal((await captureStore(st,ctx)).digest,before.digest,'the primary keeps its data unchanged; only the marker was added');
   // A second call is a no-op; the store is now tracked and opens normally.
   assert.equal((await bootstrapPrimarySync(st,journal,ctx)).revisions,r.revisions);await recoverPrimarySync(st,journal,null,ctx,async()=>{});await st.close(ctx);
   // The empty replica receives the chain and materializes it; the last chunk verifies the store digest.
   const target=new PrimarySyncJournal(join(replica.dir,'journal.sqlite'),single);
   for(let n=1;n<=journal.head().revision;n++)await target.catchUp(journal.intent(n)!,async()=>{});
   const rs=await replica.storage();await materializeSyncHistory(rs,target,ctx);assert.equal((await captureStore(rs,ctx)).digest,before.digest);await rs.close(ctx);
   const rh=await replica.open();assert.equal(await new PiSpaces(rh,ctx,()=>1000).count({type:'Job'}),12);assert.equal(await new PiSpaces(rh,ctx,()=>1000,undefined,undefined,{space:'jobs'}).count({type:'Named'}),1);
   assert.deepEqual(await rh.snapshot(Space,ctx),await (async()=>{const h=await home.open();try{return await h.snapshot(Space,ctx);}finally{await home.close(h);}})());
   // New IDs minted after the bootstrap do not collide with captured ones (the counter follows the largest ID).
   await new PiSpaces(rh,ctx,()=>1000).write({type:'After',fields:{}},null,core.FOREVER);await replica.close(rh);
   // The primary continues under primary/sync storage after the bootstrap.
   const raw=home.storage.bind(home);home.storage=async()=>primarySyncStorage(await raw(),journal,null,{assertPrimary:async()=>{}});
   const ph=await home.open();await new PiSpaces(ph,ctx,()=>1000).write({type:'Job',fields:{n:99}},null,core.FOREVER);assert.equal(journal.head().revision,r.revisions+1);await home.close(ph);
   journal.close();target.close();
  }finally{await home.dispose();await replica.dispose();}
 });

 test(`${backend}: a bootstrap resumes after a crash before its markers and refuses a store changed in between`,async()=>{
  const home=new PersistentHome(backend),other=new PersistentHome(backend);
  try{
   await existingStore(home);
   const journal=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),single);let st=await home.storage();
   home.faults.arm('failBeforeCommit');await assert.rejects(bootstrapPrimarySync(st,journal,ctx,{chunkBytes:16000}));await st.close(ctx);
   assert.ok(journal.head().revision>0&&journal.appliedRevision<journal.head().revision,'sealed but not marked');
   // Writes are refused until the bootstrap is complete.
   assert.throws(()=>journal.seal([{type:'document.retire',id:'x'} as any,{type:'document.retire',id:'y'} as any],1),/bootstrap is not complete|sealed candidate/);
   st=await home.storage();const r=await bootstrapPrimarySync(st,journal,ctx);assert.equal(journal.appliedRevision,r.revisions);await st.close(ctx);journal.close();
   // A store that changed after sealing is refused.
   await existingStore(other);const j2=new PrimarySyncJournal(join(other.dir,'journal.sqlite'),single);let s2=await other.storage();
   other.faults.arm('failBeforeCommit');await assert.rejects(bootstrapPrimarySync(s2,j2,ctx));await s2.close(ctx);
   const h=await other.open();await new PiSpaces(h,ctx,()=>1000).write({type:'Sneaked',fields:{}},null,core.FOREVER);await other.close(h);
   s2=await other.storage();await assert.rejects(bootstrapPrimarySync(s2,j2,ctx),/changed since the bootstrap was sealed/);await s2.close(ctx);j2.close();
  }finally{await home.dispose();await other.dispose();}
 });

 test(`${backend}: bootstrap guards: single genesis only, no tracked store, no oversized record`,async()=>{
  const home=new PersistentHome(backend);
  try{
   await existingStore(home);let st=await home.storage();
   const sync=new PrimarySyncJournal(join(home.dir,'sync-journal.sqlite'),{...single,standbyReplica:'s',durability:'sync'});
   await assert.rejects(bootstrapPrimarySync(st,sync,ctx),/starts single/);sync.close();
   const journal=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),single);
   await assert.rejects(bootstrapPrimarySync(st,journal,ctx,{chunkBytes:64}),/exceeds the bootstrap chunk budget/);assert.equal(journal.head().revision,0);
   // An untracked store still cannot be opened as primary/sync without the explicit bootstrap.
   await assert.rejects(recoverPrimarySync(st,journal,null,ctx,async()=>{}),/empty dedicated storage domain/);
   await st.close(ctx);journal.close();
  }finally{await home.dispose();}
 });
}

const hostACopy=process.env.PI_SPACES_BOOTSTRAP_COPY;
test('a read-only copy of a real control store bootstraps and replays with identical content',{skip:!hostACopy||!existsSync(hostACopy)?'set PI_SPACES_BOOTSTRAP_COPY to a store copy':false},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bootstrap-copy-'));
 try{
  copyFileSync(hostACopy!,join(dir,'primary.sqlite'));
  const journal=new PrimarySyncJournal(join(dir,'journal.sqlite'),single),st=await openNodeSqliteStorage(join(dir,'primary.sqlite'));
  const r=await bootstrapPrimarySync(st,journal,ctx);await st.close(ctx);
  const target=new PrimarySyncJournal(join(dir,'target-journal.sqlite'),single);for(let n=1;n<=journal.head().revision;n++)await target.catchUp(journal.intent(n)!,async()=>{});
  const ts=await openNodeSqliteStorage(join(dir,'replica.sqlite'));await materializeSyncHistory(ts,target,ctx);assert.equal((await captureStore(ts,ctx)).digest,r.storeHash);await ts.close(ctx);
  const {Harness,createRegistry}=await import('@earendil-works/pi-durable'),{createModels}=await import('@earendil-works/pi-ai/models');
  const open=async(f:string)=>Harness.open(await openNodeSqliteStorage(join(dir,f)),{models:createModels(),registry:createRegistry()},ctx);
  const a=await open('primary.sqlite'),b=await open('replica.sqlite');
  try{const spaces=await listSpaces(a,ctx);assert.deepEqual(await listSpaces(b,ctx),spaces);for(const i of spaces)assert.equal(canonicalJson(await snapshotSpace(b,i.spaceId,ctx) as any),canonicalJson(await snapshotSpace(a,i.spaceId,ctx) as any),`Space ${i.alias} identical`);}
  finally{await a.close(ctx);await b.close(ctx);journal.close();target.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
void PrimarySyncBlocked;
