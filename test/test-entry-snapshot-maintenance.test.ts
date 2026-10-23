import test from 'node:test';
import assert from 'node:assert/strict';
import { EntryReplicationController,EntryReplicationPump,EntryReplicas,ReplicationConflict,core,type EntryReplicationConfig,type EntryMutation } from '../src/index.ts';
import { EntrySnapshotTransfers } from '../src/entry-replication-transfer.ts';
import { BACKENDS,PersistentHome,InjectedFault,ctx } from './support/persistent.ts';
const config=(replicaId:string):EntryReplicationConfig=>({spaceId:'maintenance-space',authorityId:'authority',replicaId,incarnation:'v1',members:['a','b'].map(replicaId=>({replicaId,incarnation:'v1'})),rules:[{type:'State',variant:'lww',keyFields:['key']},{type:'Fact',variant:'set'}]});
const historyOf=async(node:EntryReplicationController)=>{const events=[];let cursor=0;for(;;){const page=await node.streamChanges(cursor,8192);events.push(...page.events);cursor=page.next;if(!page.more)return events;}};
const fact=(n:number,pad=0):EntryMutation=>({kind:'add',type:'Fact',fields:{n,pad:'x'.repeat(pad)},owner:{peerId:'subject'},expiresAt:null});
for(const backend of BACKENDS){
 for(const fault of ['failBeforeCommit','loseAnswer'] as const)test(`${backend}: maintenance ${fault} at copy/publication/retirement resumes with unchanged history, cursor and requests`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];let hosts=await Promise.all(homes.map(h=>h.open()));let now=1000,largest=0,armed=false;
  const storage=homes[1]!.storage.bind(homes[1]!);homes[1]!.faults.observe(w=>{if(armed)largest=Math.max(largest,Buffer.byteLength(JSON.stringify(w)));});
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0,maxBatchBytes:32768});
  const reopen=async()=>{await homes[1]!.close(hosts[1]!);hosts[1]=await homes[1]!.open();};
  try{
   for(let n=0;n<12;n++)await node(0).mutate('e-'+n,fact(n,500));
   await node(0).mutate('state-old',{kind:'put',type:'State',fields:{key:'sensor',n:1},owner:{peerId:'subject'},expiresAt:null});
   await node(0).mutate('state-delete',{kind:'delete',type:'State',fields:{key:'sensor'},owner:{peerId:'subject'}});
   const tag=await node(0).mutate('removed-add',fact(90));await node(0).mutate('remove',{kind:'remove',type:'Fact',tags:[JSON.stringify([tag.originReplicaId,tag.incarnation,tag.seq])],owner:{peerId:'subject'}});
   const m=await node(0).startSnapshot(4096);await node(1).beginSnapshotImport(m);for(let n=0;n<m.pageCount;n++)await node(1).importSnapshotPage(m.id,await node(0).snapshotPage(m.id,n));await node(1).finishSnapshotImport(m.id);
   const identity=(await node(0).describeStream()).source;await node(1).startStreamImport(identity,m.id);
   const own=await node(1).mutate('own',fact(-1));const history=await historyOf(node(1));
   homes[1]!.faults.arm(fault);await assert.rejects(node(1).startSnapshotMaintenance('job',4096),InjectedFault);await reopen();armed=true;
   let job=await node(1).startSnapshotMaintenance('job',4096);assert.deepEqual(await node(1).startSnapshotMaintenance('job',4096),job);
   await node(1).mutate('during',fact(-2));const expected=[...history,(await node(1).changes(history.length)).events[0]!];
   let steps=0;
   while(job.phase!=='completed'){
    homes[1]!.faults.arm(fault);await assert.rejects(node(1).advanceSnapshotMaintenance('job'),InjectedFault);await reopen();
    job=(await node(1).snapshotMaintenanceStatus())!;assert.deepEqual(await historyOf(node(1)),expected,'readable history survives every fault boundary');
    assert.equal((await node(1).streamImportStatus(identity))!.cursor,m.revision);
    if(job.phase!=='completed')job=await node(1).advanceSnapshotMaintenance('job');assert.ok(++steps<100);
   }
   assert.deepEqual(await node(1).advanceSnapshotMaintenance('job'),job);
   assert.deepEqual(await node(1).mutate('own',fact(-1)),own,'origin request receipt survives consolidation');
   await node(1).importChanges([tag]);assert.ok(!(await node(1).read()).some(e=>e.fields.n===90),'removed tag remains removed');
   assert.ok(!(await node(1).read()).some(e=>e.type==='State'),'tombstone remains authoritative');
   assert.equal((await node(1).snapshotImportStatus(m.id)).phase,'retired');
   await assert.rejects(node(1).forgetSnapshotReceipt(m.id),/not expired/);now+=60001;
   assert.equal(await node(1).forgetSnapshotReceipt(m.id),true);assert.equal(await node(1).forgetSnapshotReceipt(m.id),false);
   await assert.rejects(node(1).beginSnapshotImport(m),core.SnapshotExpired);
   // Existing durable seed remains valid after its expired receipt is intentionally forgotten.
   await node(0).mutate('later',fact(77));const pump=new EntryReplicationPump({target:node(1),source:{describe:()=>node(0).describeStream(),changes:(after,max)=>node(0).streamChanges(after,max)},identity,snapshotId:m.id,pageBytes:4096});
   assert.equal((await pump.step()).cursor,m.revision+1);assert.ok((await node(1).read()).some(e=>e.fields.n===77));
   const base=await hosts[1]!.snapshot(EntryReplicas,node(1).documentKey,ctx);assert.equal(base!.segments!.length,1);
   assert.ok(largest<=32768,`actual maintenance commit ${largest} exceeds bound`);
   console.log(JSON.stringify({metric:'snapshot-maintenance',backend,fault,largestCommitBytes:largest,batchLimitBytes:32768,steps}));
  }finally{for(const home of homes)await home.dispose();}
 });
 test(`${backend}: maintenance replaces a large overlay without a large commit, repeated generations release capacity and preserve stream ordering`,async()=>{
  const home=new PersistentHome(backend);let largest=0,measure=false,now=1000;const storage=home.storage.bind(home);
  home.faults.observe(w=>{if(measure)largest=Math.max(largest,Buffer.byteLength(JSON.stringify(w)));});
  const host=await home.open(),node=new EntryReplicationController({host,ctx,config:config('a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0,maxHistoryBytes:512*1024,maxBatchBytes:32768});
  try{
   for(let n=0;n<72;n++)await node.mutate('large-'+n,fact(n,4096));const history=(await node.describeStream()).revision;const events=[];
   for(let cursor=0;cursor<history;){const p=await node.streamChanges(cursor,12000);events.push(...p.events);cursor=p.next;}
   for(let pass=0;pass<3;pass++){
    measure=true;let job=await node.startSnapshotMaintenance('job-'+pass,8192);const prior=await host.snapshot(EntrySnapshotTransfers,node.documentKey,ctx);
    const reserved=prior!.transfers[job.manifest.id]!.reservedBytes;
    while(job.phase!=='completed')job=await node.advanceSnapshotMaintenance('job-'+pass);
    const ledger=await host.snapshot(EntrySnapshotTransfers,node.documentKey,ctx);assert.equal(ledger!.retainedBytes,reserved);
    const after=[];for(let cursor=0;cursor<history;){const p=await node.streamChanges(cursor,12000);after.push(...p.events);cursor=p.next;}assert.deepEqual(after,events);
    assert.equal((await host.snapshot(EntryReplicas,node.documentKey,ctx))!.events.length,0);
    now+=60001;for(const [id,t]of Object.entries(ledger!.transfers))if(t.phase==='retired')await node.forgetSnapshotReceipt(id);
    assert.equal(Object.keys((await host.snapshot(EntrySnapshotTransfers,node.documentKey,ctx))!.transfers).length,1);
   }
   assert.equal((await node.read()).length,72);assert.ok(largest<=32768,`large-prefix removal emitted ${largest} bytes`);
   console.log(JSON.stringify({metric:'snapshot-maintenance-large',backend,events:72,largestCommitBytes:largest,batchLimitBytes:32768,generations:3}));
  }finally{await home.dispose();}
 });
 test(`${backend}: maintenance admission, authorization and expiry checks fail closed without losing live generations`,async()=>{
  const home=new PersistentHome(backend),host=await home.open();let now=1000,allowed=true,revoke=0;
  const node=()=>new EntryReplicationController({host,ctx,config:config('a'),authorize:async()=>{if(revoke>0&&--revoke===0)allowed=false;if(!allowed)throw Error('revoked');},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
  try{
   await node().mutate('e',fact(1));const m=await node().startSnapshot(4096);await node().beginSnapshotImport(m);
   await assert.rejects(node().startSnapshotMaintenance('job',4096),/existing snapshot/);let aborted=await node().abortSnapshotImport(m.id);while(aborted.phase!=='aborted')aborted=await node().abortSnapshotImport(m.id);
   let job=await node().startSnapshotMaintenance('job',4096);await assert.rejects(node().startSnapshotMaintenance('job',2048),/changed page budget/);await assert.rejects(node().startSnapshotMaintenance('other',4096),/another snapshot/);
   const fresh=await node().startSnapshot(4096);await assert.rejects(node().beginSnapshotImport(fresh),/maintenance is active/);
   const before=await node().snapshotMaintenanceStatus();revoke=3;await assert.rejects(node().advanceSnapshotMaintenance('job'),/revoked/);allowed=true;assert.deepEqual(await node().snapshotMaintenanceStatus(),before);
   while(job.phase!=='completed')job=await node().advanceSnapshotMaintenance('job');await assert.rejects(node().forgetSnapshotReceipt(job.manifest.id),/live/);
   now+=60001;assert.equal(await node().forgetSnapshotReceipt(m.id),true);assert.equal((await node().read()).length,1);
  }finally{await home.dispose();}
 });
}
