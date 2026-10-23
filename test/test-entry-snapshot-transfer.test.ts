import test from 'node:test';
import assert from 'node:assert/strict';
import { defineDocFamily } from '../src/store/documents.ts';
import { createHash } from 'node:crypto';
import { EntryReplicationController,EntryReplicas,EntrySnapshotTransfers,ReplicationConflict,core,type EntryReplicationConfig,type EntryMutation,type EntrySnapshotManifest,type EntrySnapshotPage } from '../src/index.ts';
import { BACKENDS,PersistentHome,InjectedFault,ctx } from './support/persistent.ts';
import { canonicalJson } from '../src/canonical.ts';
const cfg=(replicaId:string):EntryReplicationConfig=>({spaceId:'paged-space',authorityId:'authority',replicaId,incarnation:'v1',members:['a','b','c'].map(replicaId=>({replicaId,incarnation:'v1'})),rules:[{type:'State',variant:'lww',keyFields:['key']},{type:'Fact',variant:'set'}]});
const fact=(n:number,pad=0):EntryMutation=>({kind:'add',type:'Fact',fields:{n,pad:'x'.repeat(pad)},owner:{peerId:'subject'},expiresAt:null});
const sha=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
async function history(node:EntryReplicationController){const events:import('../src/index.ts').ReplicatedEntryChange[]=[];let after=0;for(;;){const page=await node.changes(after);events.push(...page.events);after=page.next;if(!page.more)return events;}}
const changePage=(p:EntrySnapshotPage)=>{const {sha256,...body}=p;return {...body,sha256:sha(body)};};
for(const backend of BACKENDS){
 test(`${backend}: version-one entry history migrates without changing IDs, HLC or existing entries`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];let hosts=await Promise.all(homes.map(h=>h.open()));
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:cfg('a'),authorize:async()=>{},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0});
  const Legacy=defineDocFamily<import('../src/entry-replication.ts').EntryReplicationState,null>({kind:'phi-spaces.entry-replica',version:1,scope:'session',family:true,initial:()=>({config:null,configHash:'',clock:{physical:0,logical:0},seq:0,lastWallTime:0,events:[]})});
  try{
   const event=await node(0).mutate('legacy',fact(1));const old=JSON.parse(JSON.stringify(await hosts[0]!.snapshot(EntryReplicas,node(0).documentKey,ctx)));delete old.segments;
   await hosts[1]!.commit(async tx=>{Object.assign(await tx.doc(Legacy,node(1).documentKey,null),old);},ctx);
   await homes[1]!.close(hosts[1]!);hosts[1]=await homes[1]!.open();assert.deepEqual(await node(1).mutate('legacy',fact(1)),event);
   const next=await node(1).mutate('after-migration',fact(2));assert.equal(next.seq,2);assert.equal((await node(1).read()).length,2);assert.deepEqual((await hosts[1]!.snapshot(EntryReplicas,node(1).documentKey,ctx))!.segments,[]);
  }finally{for(const home of homes)await home.dispose();}
 });
 test(`${backend}: large immutable pages stay invisible until atomic publication, preserve concurrent writes and stable cursors`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)],hosts=await Promise.all(homes.map(h=>h.open()));let now=100000;
  const nodes=hosts.map((host,i)=>new EntryReplicationController({host,ctx,config:cfg(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0}));const [source,target]=nodes as [EntryReplicationController,EntryReplicationController];
  try{
   for(let n=0;n<80;n++)await source.mutate('entry-'+n,fact(n,4096));
   const original=await source.mutate('state-old',{kind:'put',type:'State',fields:{key:'sensor',value:'old'},owner:{peerId:'subject'},expiresAt:null});
   await source.mutate('state-delete',{kind:'delete',type:'State',fields:{key:'sensor'},owner:{peerId:'subject'}});
   await assert.rejects(source.snapshot(),core.ResourceExhausted);
   await target.mutate('local-before',fact(-1));const manifest=await source.startSnapshot(20000);assert.ok(manifest.bytes>192*1024&&manifest.pageCount>10);
   const first=await source.snapshotPage(manifest.id,0);first.events[0]!.mutation.owner.peerId='caller-mutation';assert.notEqual((await source.snapshotPage(manifest.id,0)).events[0]!.mutation.owner.peerId,'caller-mutation');
   await target.beginSnapshotImport(manifest);await source.mutate('after-export',fact(999));
   for(let n=0;n<manifest.pageCount;n++){
    const page=await source.snapshotPage(manifest.id,n);assert.ok(Buffer.byteLength(JSON.stringify(page))<=manifest.pageBytes);
    await target.importSnapshotPage(manifest.id,page);assert.equal((await target.read()).filter(e=>(e.fields.n as number)>=0).length,0,'staging must not leak entries');
    if(n===0)await target.mutate('local-during',fact(-2));
   }
   await target.mutate('causally-after-pages',{kind:'put',type:'State',fields:{key:'sensor',value:'local-after-pages'},owner:{peerId:'subject'},expiresAt:null});
   const visibleBefore=(await history(target));const result=await target.finishSnapshotImport(manifest.id);assert.equal(result.sourceRevision,manifest.revision);assert.equal(result.added,82);
   assert.deepEqual((await history(target)).slice(0,visibleBefore.length),visibleBefore,'previous cursors keep their event ordering');
   const entries=await target.read();assert.equal(entries.length,83);assert.ok(entries.some(e=>e.fields.n===-2));assert.equal(entries.find(e=>e.type==='State')!.fields.value,'local-after-pages');assert.ok(!entries.some(e=>e.fields.n===999));
   const base=await hosts[1]!.snapshot(EntryReplicas,target.documentKey,ctx);assert.equal(base!.segments!.length,1);assert.equal(base!.events.length,3,'final commit publishes only a reference, not the large event array');
   await target.importChanges([original]);assert.equal((await target.read()).find(e=>e.type==='State')!.fields.value,'local-after-pages','late duplicate put cannot change the winner');
   const missed=await source.changes(result.sourceRevision);assert.equal(missed.events.length,1);await target.importChanges(missed.events);assert.ok((await target.read()).some(e=>e.fields.n===999));
   const cursor=(await history(target)).length;await target.mutate('after-install',fact(-3));assert.equal((await target.changes(cursor)).events[0]!.requestId,'after-install');
   const second=await source.startSnapshot(20000);await target.beginSnapshotImport(second);for(let n=0;n<second.pageCount;n++)await target.importSnapshotPage(second.id,await source.snapshotPage(second.id,n));
   const prior=(await history(target));assert.equal((await target.finishSnapshotImport(second.id)).added,0);assert.deepEqual((await history(target)),prior,'a duplicate full generation changes no cursor');
   console.log(JSON.stringify({metric:'snapshot-transfer',backend,bytes:manifest.bytes,pages:manifest.pageCount,sourceRevision:manifest.revision,localEntriesPreserved:3}));
  }finally{for(const home of homes)await home.dispose();}
 });
 for(const fault of ['failBeforeCommit','loseAnswer'] as const)test(`${backend}: ${fault} at begin, every page and publication resumes after reopen without double import`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];let hosts=await Promise.all(homes.map(h=>h.open()));let now=50000;
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:cfg(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
  const reopen=async()=>{await homes[1]!.close(hosts[1]!);hosts[1]=await homes[1]!.open();};
  try{
   for(let n=0;n<16;n++)await node(0).mutate('e-'+n,fact(n,1000));const m=await node(0).startSnapshot(4096),pages=await Promise.all(Array.from({length:m.pageCount},(_,n)=>node(0).snapshotPage(m.id,n)));
   homes[1]!.faults.arm(fault);await assert.rejects(node(1).beginSnapshotImport(m),InjectedFault);await reopen();await node(1).beginSnapshotImport(m);
   for(let n=0;n<pages.length;n++){
    homes[1]!.faults.arm(fault);await assert.rejects(node(1).importSnapshotPage(m.id,pages[n]!),InjectedFault);await reopen();
    const state=await node(1).importSnapshotPage(m.id,pages[n]!);assert.equal(state.nextPage,n+1);assert.equal((await node(1).read()).length,0);
    assert.deepEqual(await node(1).importSnapshotPage(m.id,pages[n]!),state);
   }
   // All pages are durable: source process loss and token expiry cannot invalidate publication.
   await homes[0]!.close(hosts[0]!);hosts[0]=await homes[0]!.open();now+=60001;await assert.rejects(node(0).snapshotPage(m.id,0),core.SnapshotExpired);
   homes[1]!.faults.arm(fault);await assert.rejects(node(1).finishSnapshotImport(m.id),InjectedFault);await reopen();
   const result=await node(1).finishSnapshotImport(m.id);assert.equal(result.added,16);assert.deepEqual(await node(1).finishSnapshotImport(m.id),result);assert.equal((await node(1).read()).length,16);
   const local=await node(1).mutate('local-after',fact(-1));await reopen();assert.deepEqual(await node(1).mutate('local-after',fact(-1)),local);
   assert.equal(homes[1]!.faults.fired,pages.length+2);assert.equal((await node(1).snapshotImportStatus(m.id)).phase,'completed');
  }finally{for(const home of homes)await home.dispose();}
 });
 test(`${backend}: bad pages, changed bindings and revocation leave active data and progress unchanged; abort resumes`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];let hosts=await Promise.all(homes.map(h=>h.open()));let allowed=true,active=true,revokeAfter=0,now=1000;
  const source=()=>new EntryReplicationController({host:hosts[0]!,ctx,config:cfg('a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
  const target=()=>new EntryReplicationController({host:hosts[1]!,ctx,config:cfg('b'),authorize:async()=>{if(revokeAfter>0&&--revokeAfter===0)allowed=false;if(!allowed)throw Error('revoked');},assertActive:async()=>{if(!active)throw Error('fenced');},now:()=>now,clockUncertaintyMs:()=>0});
  try{
   for(let n=0;n<6;n++)await source().mutate('e-'+n,fact(n,1000));const m=await source().startSnapshot(4096);await target().beginSnapshotImport(m);const initial=await target().snapshotImportStatus(m.id);
   const first=await source().snapshotPage(m.id,0),second=await source().snapshotPage(m.id,1),third=await source().snapshotPage(m.id,2);
   await assert.rejects(target().importSnapshotPage(m.id,second),ReplicationConflict);await assert.rejects(target().finishSnapshotImport(m.id),/incomplete/);
   const bad=structuredClone(first);bad.events[0]!.mutation.owner.peerId='changed';await assert.rejects(target().importSnapshotPage(m.id,bad),ReplicationConflict);
   assert.deepEqual(await target().snapshotImportStatus(m.id),initial);
   const wrong=structuredClone(m);wrong.rootHash='0'.repeat(64);await assert.rejects(target().beginSnapshotImport(wrong),/changed manifest/);
   revokeAfter=2;await assert.rejects(target().importSnapshotPage(m.id,first),/revoked/);allowed=true;assert.deepEqual(await target().snapshotImportStatus(m.id),initial);
   active=false;await assert.rejects(target().importSnapshotPage(m.id,first),/fenced/);active=true;
   await target().importSnapshotPage(m.id,first);const duplicate=structuredClone(first);duplicate.events[0]!.requestId='changed';await assert.rejects(target().importSnapshotPage(m.id,changePage(duplicate)),/duplicate page changed/);
   await target().importSnapshotPage(m.id,second);
   now+=60000;await assert.rejects(source().snapshotPage(m.id,2),core.SnapshotExpired);await assert.rejects(target().importSnapshotPage(m.id,third),core.SnapshotExpired);
   await assert.rejects(target().snapshotImportStatus('__proto__'),ReplicationConflict);
   homes[1]!.faults.arm('loseAnswer');await assert.rejects(target().abortSnapshotImport(m.id),InjectedFault);await homes[1]!.close(hosts[1]!);hosts[1]=await homes[1]!.open();
   let status=await target().snapshotImportStatus(m.id);while(status.phase!=='aborted')status=await target().abortSnapshotImport(m.id);assert.equal(status.phase,'aborted');
   assert.equal((await hosts[1]!.snapshot(EntrySnapshotTransfers,target().documentKey,ctx))!.retainedBytes,0);assert.equal((await target().read()).length,0);
   const fresh=await source().startSnapshot(4096);await target().beginSnapshotImport(fresh);
   const c=new EntryReplicationController({host:hosts[1]!,ctx,config:cfg('c'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
   const corrupt={...fresh,rootHash:'0'.repeat(64)};await c.beginSnapshotImport(corrupt);
   for(let n=0;n<fresh.pageCount-1;n++)await c.importSnapshotPage(fresh.id,await source().snapshotPage(fresh.id,n));
   await assert.rejects(c.importSnapshotPage(fresh.id,await source().snapshotPage(fresh.id,fresh.pageCount-1)),/final snapshot page/);
   assert.equal((await c.snapshotImportStatus(fresh.id)).nextPage,fresh.pageCount-1);assert.equal((await c.read()).length,0);
  }finally{for(const home of homes)await home.dispose();}
 });
 test(`${backend}: actual staging/head/overlay commits stay bounded; completed imports enforce retained-generation backpressure`,async()=>{
  const sourceHome=new PersistentHome(backend),targetHome=new PersistentHome(backend);const storage=targetHome.storage.bind(targetHome);let largest=0,publication=0,capture=false;
  targetHome.faults.observe(w=>{const n=Buffer.byteLength(JSON.stringify(w));largest=Math.max(largest,n);if(capture)publication=n;});
  const hosts=await Promise.all([sourceHome.open(),targetHome.open()]);const nodes=hosts.map((host,i)=>new EntryReplicationController({host,ctx,config:cfg(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0,maxHistoryBytes:128*1024,maxBatchBytes:32768}));const [a,b]=nodes as [EntryReplicationController,EntryReplicationController];
  try{
   for(let n=0;n<32;n++)await a.mutate('e-'+n,fact(n,1000));
   let completed=0;
   for(let pass=0;pass<16;pass++){
    const m=await a.startSnapshot(4096);try{await b.beginSnapshotImport(m);}catch(e){assert.ok(e instanceof core.ResourceExhausted);break;}
    for(let n=0;n<m.pageCount;n++)await b.importSnapshotPage(m.id,await a.snapshotPage(m.id,n));capture=true;await b.finishSnapshotImport(m.id);capture=false;completed++;
   }
   assert.ok(completed>1&&completed<16,'retained bytes eventually apply backpressure');assert.ok(largest<=32768,`actual commit ${largest} exceeds 32 KiB`);assert.ok(publication<12000,`publication copied large history: ${publication}`);
   await b.mutate('after',fact(100));assert.equal((await b.read()).length,33);console.log(JSON.stringify({metric:'snapshot-commits',backend,largestCommitBytes:largest,publicationBytes:publication,completedGenerations:completed,batchLimitBytes:32768}));
  }finally{await sourceHome.dispose();await targetHome.dispose();}
 });
}
