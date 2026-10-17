import test from 'node:test';
import assert from 'node:assert/strict';
import type net from 'node:net';
import { createHash } from 'node:crypto';
import { EntryReplicationController,EntryReplicationPump,EntryReplicationUnavailable,EntryStreamCursorConflict,ReplicationConflict,serveSpace,socketTransport,core,type EntryReplicationConfig,type EntryMutation,type EntryStreamPage,type EntryReplicationSource } from '../src/index.ts';
import { canonicalJson } from '../src/canonical.ts';
import { BACKENDS,PersistentHome,InjectedFault,ctx } from './support/persistent.ts';
const config=(replicaId:string):EntryReplicationConfig=>({spaceId:'stream-space',authorityId:'authority',replicaId,incarnation:'v1',members:['a','b','c'].map(replicaId=>({replicaId,incarnation:'v1'})),rules:[{type:'State',variant:'lww',keyFields:['key']},{type:'Fact',variant:'set'}]});
const fact=(n:number,pad=0):EntryMutation=>({kind:'add',type:'Fact',fields:{n,pad:'x'.repeat(pad)},owner:{peerId:'subject'},expiresAt:null});
const state=(n:number,expiresAt:number|null=null):EntryMutation=>({kind:'put',type:'State',fields:{key:'sensor',n},owner:{peerId:'subject'},expiresAt});
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const hashPage=(page:EntryStreamPage)=>({...page,sha256:digest({source:page.source,after:page.after,next:page.next,events:page.events})});
const direct=(node:()=>EntryReplicationController):EntryReplicationSource=>({describe:()=>node().describeStream(),changes:(after,max)=>node().streamChanges(after,max)});
for(const backend of BACKENDS){
 test(`${backend}: competing pull workers reload the winner's checkpoint rather than overlapping accepted ranges`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)],hosts=await Promise.all(homes.map(h=>h.open()));
  const nodes=hosts.map((host,i)=>new EntryReplicationController({host,ctx,config:config(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0}));const [a,b]=nodes as [EntryReplicationController,EntryReplicationController];
  try{
   for(let n=0;n<3;n++)await a.mutate('e-'+n,fact(n));const identity=(await a.describeStream()).source;
   const source:EntryReplicationSource={describe:()=>a.describeStream(),changes:async(after,max)=>{const page=await a.streamChanges(after,max);if(after===0){const winner=hashPage({...page,next:1,more:true,events:page.events.slice(0,1)});await b.importStreamPage(winner);}return page;}};
   const pump=new EntryReplicationPump({target:b,source,identity});const raced=await pump.step();assert.equal(raced.status,'raced');assert.equal(raced.cursor,1);assert.equal(raced.revision,null);
   const resumed=await pump.step();assert.equal(resumed.status,'applied');assert.equal(resumed.added,2);assert.equal(resumed.cursor,3);assert.deepEqual(await b.read(),await a.read());
  }finally{for(const home of homes)await home.dispose();}
 });
 for(const fault of ['failBeforeCommit','loseAnswer'] as const)test(`${backend}: ${fault} keeps stream events and cursor atomic at bootstrap and every page after reopen`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];let hosts=await Promise.all(homes.map(h=>h.open()));
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0});
  const reopen=async()=>{await homes[1]!.close(hosts[1]!);hosts[1]=await homes[1]!.open();};
  try{
   for(let n=0;n<4;n++)await node(0).mutate('seed-'+n,fact(n));const manifest=await node(0).startSnapshot();await node(1).beginSnapshotImport(manifest);
   for(let p=0;p<manifest.pageCount;p++)await node(1).importSnapshotPage(manifest.id,await node(0).snapshotPage(manifest.id,p));await node(1).finishSnapshotImport(manifest.id);
   const source=(await node(0).describeStream()).source;homes[1]!.faults.arm(fault);await assert.rejects(node(1).startStreamImport(source,manifest.id),InjectedFault);await reopen();
   assert.equal((await node(1).startStreamImport(source,manifest.id)).cursor,4);
   for(let n=4;n<24;n++)await node(0).mutate('later-'+n,fact(n,1000));let first:EntryStreamPage|undefined,last:EntryStreamPage|undefined,pages=0;
   for(;;){const checkpoint=(await node(1).streamImportStatus(source))!;const page=await node(0).streamChanges(checkpoint.cursor,4096);if(!page.events.length)break;
    first??=page;last=page;homes[1]!.faults.arm(fault);await assert.rejects(node(1).importStreamPage(page),InjectedFault);await reopen();
    const durable=(await node(1).streamImportStatus(source))!;assert.equal((await node(1).read()).length,durable.cursor,'data and checkpoint must describe the same committed prefix');
    assert.equal(durable.cursor,fault==='loseAnswer'?page.next:page.after);
    const result=await node(1).importStreamPage(page);assert.equal(result.cursor,page.next);assert.deepEqual(await node(1).importStreamPage(page),result);pages++;
   }
   assert.ok(pages>1);assert.deepEqual(await node(1).read(),await node(0).read());assert.equal((await node(1).streamImportStatus(source))!.cursor,24);
   await assert.rejects(node(1).importStreamPage(first!),EntryStreamCursorConflict);
   await node(1).importStreamPage(await node(0).streamChanges(24));assert.equal((await node(1).importStreamPage(last!)).cursor,24,'empty polls must retain the last replay receipt');
   assert.equal((await node(1).startStreamImport(source,manifest.id)).cursor,24,'old snapshot must never rewind the stream');assert.equal(homes[1]!.faults.fired,pages+1);
  }finally{for(const home of homes)await home.dispose();}
 });
 test(`${backend}: malformed ranges, changed source/content and mid-commit revocation advance neither data nor cursor`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];const originalStorage=homes[1]!.storage.bind(homes[1]!);let largestCommit=0;
  homes[1]!.storage=async()=>{const storage=await originalStorage();return new Proxy(storage,{get(t,k,r){const v=Reflect.get(t,k,r);if(k==='commit')return async(w:readonly import('@earendil-works/pi-durable').StorageWrite[],c:typeof ctx)=>{largestCommit=Math.max(largestCommit,Buffer.byteLength(JSON.stringify(w)));return t.commit(w,c);};return typeof v==='function'?v.bind(t):v;}});};
  const hosts=await Promise.all(homes.map(h=>h.open()));let allowed=true,revoke=0;
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(i?'b':'a'),authorize:async()=>{if(i&&revoke>0&&--revoke===0)allowed=false;if(i&&!allowed)throw Error('revoked');},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0,maxBatchBytes:i?32768:196608});
  try{
   await node(0).mutate('a',fact(1));await node(0).mutate('b',fact(2));const identity=(await node(0).describeStream()).source;await node(1).startStreamImport(identity);const initial=await node(1).streamImportStatus(identity),page=await node(0).streamChanges(0);
   const changed=structuredClone(page);changed.events[0]!.mutation.owner.peerId='forged';
   for(const bad of [changed,hashPage(changed),{...page,next:page.next+1},{...page,source:{...identity,incarnation:'retired'}}]){await assert.rejects(node(1).importStreamPage(bad));assert.deepEqual(await node(1).streamImportStatus(identity),initial);assert.equal((await node(1).read()).length,0);}
   await assert.rejects(node(1).importStreamPage(await node(0).streamChanges(1)),EntryStreamCursorConflict);
   revoke=3;await assert.rejects(node(1).importStreamPage(page),/revoked/);allowed=true;assert.equal((await node(1).read()).length,0);assert.deepEqual(await node(1).streamImportStatus(identity),initial);
   const results=await Promise.all([node(1).importStreamPage(page),node(1).importStreamPage(page)]);assert.deepEqual(results[0],results[1]);assert.equal((await node(1).read()).length,2);
   const equivocated=structuredClone(page);equivocated.events[0]!.mutation=fact(999);equivocated.events[0]!.argumentHash=digest(equivocated.events[0]!.mutation);await assert.rejects(node(1).importStreamPage(hashPage(equivocated)),/decided stream page changed/);
   // The same fixed range stays replayable when the source head grows.
   await node(0).mutate('c',fact(3));const newerHeader={...page,headRevision:3,more:true};assert.deepEqual(await node(1).importStreamPage(newerHeader),results[0]);
   await assert.rejects(node(1).startStreamImport(identity,'ss'+'0'.repeat(32)),/completed snapshot/);
   for(let n=3;n<16;n++)await node(0).mutate('sized-'+n,fact(n,1000));
   await node(1).importStreamPage(await node(0).streamChanges(2,8192));assert.ok(largestCommit<=32768,`joint data/cursor commit ${largestCommit} exceeds 32 KiB`);
   console.log(JSON.stringify({metric:'stream-commit',backend,largestCommitBytes:largestCommit,batchLimitBytes:32768}));
  }finally{for(const home of homes)await home.dispose();}
 });
 test(`${backend}: pull worker reconnects over real TCP, survives a lost source and resumes the durable cursor`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];const hosts=await Promise.all(homes.map(h=>h.open()));
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0});
  let server:Awaited<ReturnType<typeof serveSpace>>|undefined,wire:ReturnType<typeof socketTransport>|undefined;
  const service={handleText:async(text:string)=>{const call=JSON.parse(text);if(call.method==='describe')return JSON.stringify(await node(0).describeStream());if(call.method==='changes')return JSON.stringify(await node(0).streamChanges(call.after,call.max));throw Error('method not allowed');}};
  try{
   for(let n=0;n<10;n++)await node(0).mutate('before-'+n,fact(n,500));server=await serveSpace(service,{listen:{host:'127.0.0.1',port:0}});const port=(server.address() as net.AddressInfo).port;wire=socketTransport({host:'127.0.0.1',port});
   const request=async(call:unknown)=>{let response:string;try{response=await wire!.request(JSON.stringify(call));}catch{throw new EntryReplicationUnavailable('fixture source is offline');}return JSON.parse(response);};
   const source:EntryReplicationSource={describe:()=>request({method:'describe'}),changes:(after,max)=>request({method:'changes',after,max})},identity=(await node(0).describeStream()).source;
   const make=()=>new EntryReplicationPump({target:node(1),source,identity,pageBytes:4096,pollMs:10,retryMs:10,maxRetryMs:30,callTimeoutMs:5000});
   const initial=await make().step();assert.ok(initial.cursor>0&&initial.cursor<10);const before=(await node(1).streamImportStatus(identity))!.cursor;
   await server.close();server=undefined;await assert.rejects(make().step(),EntryReplicationUnavailable);assert.equal((await node(1).streamImportStatus(identity))!.cursor,before);
   for(let n=10;n<20;n++)await node(0).mutate('during-'+n,fact(n,500));wire.close();server=await serveSpace(service,{listen:{host:'127.0.0.1',port}});wire=socketTransport({host:'127.0.0.1',port});
   const stop=new AbortController();let unavailable=2,steps=0;
   const flaky:EntryReplicationSource={...source,describe:async()=>{if(unavailable-->0)throw new EntryReplicationUnavailable('temporary source read');return source.describe();}};
   const pump=new EntryReplicationPump({target:node(1),source:flaky,identity,pageBytes:4096,pollMs:10,retryMs:10,maxRetryMs:30,callTimeoutMs:5000,onProgress:r=>{steps++;if(r.cursor===20)stop.abort();}});
   const timeout=setTimeout(()=>stop.abort(),10000);try{await pump.run(stop.signal);}finally{clearTimeout(timeout);}
   assert.ok(steps>1);assert.equal((await node(1).streamImportStatus(identity))!.cursor,20);assert.deepEqual(await node(1).read(),await node(0).read());
  }finally{wire?.close();await server?.close();for(const home of homes)await home.dispose();}
 });
 test(`${backend}: bidirectional workers converge after partition without echo growth or expired-value resurrection`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];const hosts=await Promise.all(homes.map(h=>h.open()));let now=100000;
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
  try{
   await node(0).mutate('state-a',state(1));await node(1).mutate('state-b',state(2));await node(0).mutate('fact-a',fact(1));await node(1).mutate('fact-b',fact(2));
   const a=(await node(0).describeStream()).source,b=(await node(1).describeStream()).source;
   const pumps=[new EntryReplicationPump({target:node(1),source:direct(()=>node(0)),identity:a,pageBytes:4096}),new EntryReplicationPump({target:node(0),source:direct(()=>node(1)),identity:b,pageBytes:4096})];
   const converge=async()=>{for(let n=0;n<20;n++){const x=await pumps[0]!.step(),y=await pumps[1]!.step();if(x.status==='idle'&&y.status==='idle')return;}throw Error('echo loop did not converge');};
   await converge();assert.deepEqual(await node(0).read(),await node(1).read());
   now+=600000;await node(0).mutate('new-state-a',state(3));await node(1).mutate('new-state-b',state(4,now+1000));const seen=(await node(1).read()).find(e=>e.type==='Fact'&&e.fields.n===1)!;
   await node(1).mutate('remove',{kind:'remove',type:'Fact',tags:[seen.id],owner:{peerId:'subject'}});await node(0).mutate('concurrent-add',fact(1));await converge();assert.deepEqual(await node(0).read(),await node(1).read());
   const revisions=await Promise.all([node(0).describeStream(),node(1).describeStream()]);await converge();assert.deepEqual(await Promise.all([node(0).describeStream(),node(1).describeStream()]),revisions,'forwarding must not create changes');
   now+=1001;assert.ok(!(await node(0).read()).some(e=>e.type==='State'));assert.deepEqual(await node(0).read(),await node(1).read());assert.equal((await node(0).read()).filter(e=>e.type==='Fact').length,2);
  }finally{for(const home of homes)await home.dispose();}
 });
}
test('pull worker bounds source waits, aborts stalled reads and stops on permanent errors',async()=>{
 const home=new PersistentHome('sqlite'),host=await home.open();const target=new EntryReplicationController({host,ctx,config:config('a'),authorize:async()=>{},assertActive:async()=>{},clockUncertaintyMs:()=>0});const identity=(await target.describeStream()).source;
 try{
  const hung:EntryReplicationSource={describe:()=>new Promise(()=>{}),changes:()=>new Promise(()=>{})};
  const wrong:EntryReplicationSource={describe:async()=>({source:{...identity,replicaId:'other'},revision:0}),changes:()=>new Promise(()=>{})};
  await assert.rejects(new EntryReplicationPump({target,source:wrong,identity}).step(),/identity changed/);assert.equal(await target.streamImportStatus(identity),null);
  const pump=new EntryReplicationPump({target,source:hung,identity,callTimeoutMs:30});await assert.rejects(pump.step(),EntryReplicationUnavailable);assert.equal(await target.streamImportStatus(identity),null);
  const aborting:EntryReplicationSource={describe:signal=>new Promise((_,reject)=>{signal!.addEventListener('abort',()=>reject(Error('provider aborted')),{once:true});}),changes:()=>new Promise(()=>{})};
  await assert.rejects(new EntryReplicationPump({target,source:aborting,identity,callTimeoutMs:30}).step(),EntryReplicationUnavailable);
  const ac=new AbortController(),running=pump.run(ac.signal);setTimeout(()=>ac.abort(),10);await running;assert.equal(await target.streamImportStatus(identity),null);
  let attempts=0;const permanent:EntryReplicationSource={describe:async()=>{if(attempts++===0)throw new EntryReplicationUnavailable('retry once');throw Error('permission revoked');},changes:()=>new Promise(()=>{})};
  await assert.rejects(new EntryReplicationPump({target,source:permanent,identity,retryMs:10,maxRetryMs:20}).run(new AbortController().signal),/permission revoked/);assert.equal(attempts,2);
 }finally{await home.dispose();}
});
