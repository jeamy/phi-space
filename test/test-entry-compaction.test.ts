// lww/set step 4 (docs/ap3-replikation.md): stable stream positions and compaction of replicated entry histories.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {EntryReplicationController,EntryReplicas,EntryReplicationPump,type EntryMutation,type EntryReplicationSource} from '../src/index.ts';
import {positionsOf} from '../src/entry-replication.ts';
import {ctx} from './support/persistent.ts';

const P={peerId:'peer-p'};
const rules=[{type:'Sensor',variant:'lww' as const,keyFields:['sensorId']},{type:'Fact',variant:'set' as const}];
const members=['a','b','c'].map(r=>({replicaId:r,incarnation:'i-'+r}));
const fact=(n:number):EntryMutation=>({kind:'add',type:'Fact',fields:{n,pad:'x'.repeat(300)},owner:P,expiresAt:null});

async function fixture(fn:(o:{host:Harness;node:(r:string)=>EntryReplicationController;tick:(ms?:number)=>void;now:()=>number})=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'entry-compaction-'));
 const host=await Harness.open(await openNodeSqliteStorage(join(dir,'replicas.sqlite')),{models:createModels(),registry:createRegistry()},ctx);let clock=1_700_000_000_000;
 const nodes=new Map<string,EntryReplicationController>();
 const node=(r:string)=>{let n=nodes.get(r);if(!n){n=new EntryReplicationController({host,ctx,config:{spaceId:'sp-merge',authorityId:'authority',replicaId:r,incarnation:'i-'+r,members,rules},authorize:async()=>{},assertActive:async()=>{},now:()=>clock,clockUncertaintyMs:()=>0});nodes.set(r,n);}return n;};
 try{await fn({host,node,tick:(ms=10)=>{clock+=ms;},now:()=>clock});}finally{try{await host.close(ctx);}catch{}rmSync(dir,{recursive:true,force:true});}
}
const direct=(c:EntryReplicationController,pageBytes?:number):EntryReplicationSource=>({describe:()=>c.describeStream(),changes:(after,max)=>c.streamChanges(after,pageBytes??max)});

test('stream positions: without dropped runs a position is the index plus one; runs are skipped and never reused',()=>{
 assert.deepEqual(positionsOf(4),[1,2,3,4]);
 assert.deepEqual(positionsOf(4,[[2,3]]),[1,4,5,6]);
 assert.deepEqual(positionsOf(3,[[1,1],[3,5]]),[2,6,7]);
 assert.deepEqual(positionsOf(0,[[1,2]]),[]);
});

test('a peer keeps its cursor across removed positions: later pages name their positions and new changes continue the count',()=>fixture(async o=>{
 const a=o.node('a'),b=o.node('b');
 for(let n=1;n<=5;n++){await a.mutate('f'+n,fact(n));o.tick();}
 const identity=(await a.describeStream()).source;
 // b takes one page (position 1) through the stream; positions 2 and 3 reach it on another path.
 await b.startStreamImport(identity);const first=await a.streamChanges(0,1400);assert.equal(first.events.length,1);assert.equal(first.positions,undefined,'contiguous pages keep the old wire form');
 await b.importStreamPage(first);await b.importChanges((await a.changes(1,256*1024)).events.slice(0,2));
 // What compaction does to the stored history: events at positions 2 and 3 leave, the run records them.
 await o.host.commit(async tx=>{const s=await tx.doc(EntryReplicas,a.documentKey,null);s.events.splice(1,2);s.dropped=[[2,3]];},ctx);
 assert.equal((await a.describeStream()).revision,5,'the head position stays');
 const page=await a.streamChanges(1,1400);assert.deepEqual(page.positions,[4]);assert.equal(page.next,4);assert.equal(page.more,true);
 const fromInside=await a.streamChanges(2,256*1024);assert.deepEqual(fromInside.positions,[4,5]);assert.equal(fromInside.next,5);
 const pump=new EntryReplicationPump({target:b,source:direct(a,1400),identity});
 for(let n=0;n<4&&(await pump.step()).more;n++);
 assert.equal((await b.streamImportStatus(identity))!.cursor,5);
 await a.mutate('f6',fact(6));assert.equal((await a.describeStream()).revision,6);
 const sixth=await a.streamChanges(5,256*1024);assert.equal(sixth.positions,undefined);assert.equal(sixth.next,6);
 await pump.step();assert.equal((await b.streamImportStatus(identity))!.cursor,6);
 assert.deepEqual((await b.read()).map(v=>v.fields.n),[1,2,3,4,5,6]);
 // A dropped tail: the page is empty but moves the cursor to the head.
 await o.host.commit(async tx=>{const s=await tx.doc(EntryReplicas,a.documentKey,null);s.events.splice(3,1);s.dropped=[[2,3],[6,6]];},ctx);
 await a.mutate('f7',fact(7));const c=o.node('c');await c.startStreamImport(identity);
 const tail=await a.streamChanges(5,256*1024);assert.deepEqual(tail.positions,[7]);
 await o.host.commit(async tx=>{const s=await tx.doc(EntryReplicas,a.documentKey,null);s.events.splice(3,1);s.dropped=[[2,3],[6,7]];},ctx);
 const empty=await a.streamChanges(5,256*1024);assert.deepEqual([empty.events.length,empty.next,empty.more],[0,7,false]);
 await c.importStreamPage(await a.streamChanges(0,256*1024));assert.equal((await c.streamImportStatus(identity))!.cursor,7);
 // Tampering with positions is refused.
 const forged={...await a.streamChanges(0,256*1024)};forged.positions=[1,1,4,5];await assert.rejects(c.importStreamPage(forged),/range or hash/);
}));

// ---- compaction (4b-4d) ----
type Node=EntryReplicationController;
const Q={peerId:'peer-q'},ADMIN={peerId:'admin'};
const viewOf=async(c:Node)=>(await c.read()).map(v=>JSON.stringify([v.id,v.type,v.fields,v.owner,v.expiresAt]));
/** Pulls `from` into `to` through the stream until idle (records `from`'s vector on the way). */
async function sync(from:Node,to:Node,shadow?:Node){
 let page:import('../src/index.ts').EntryStreamPage|undefined;
 const source:EntryReplicationSource={describe:()=>from.describeStream(),changes:async(after,max)=>page=await from.streamChanges(after,max)};
 const pump=new EntryReplicationPump({target:to,source,identity:(await from.describeStream()).source});
 // The shadow gets exactly the changes `to` got, so it is what `to` would hold without compaction.
 for(let n=0;n<64;n++){const r=await pump.step();if(shadow&&r.status==='applied')await shadow.importChanges(page!.events);if(!r.more)return;}throw new Error('stream did not settle');
}
async function settle(nodes:Node[],shadows:Array<Node|undefined>=[]){for(let round=0;round<3;round++)for(const from of nodes)for(const [i,to] of nodes.entries())if(from!==to)await sync(from,to,shadows[i]);}
function rng(seed:number){let x=seed>>>0||1;return ()=>{x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;return x/4294967296;};}

async function compactionFixture(fn:(o:{host:Harness;node:(r:string,retainMs?:number)=>Node;reference:(name?:string)=>Node;tick:(ms?:number)=>void;now:()=>number})=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'entry-compaction-'));
 const host=await Harness.open(await openNodeSqliteStorage(join(dir,'replicas.sqlite')),{models:createModels(),registry:createRegistry()},ctx);let clock=1_700_000_000_000;
 const nodes=new Map<string,Node>(),now=()=>clock;
 const make=(replicaId:string,ms:typeof members,retainMs?:number)=>new EntryReplicationController({host,ctx,config:{spaceId:'sp-merge',authorityId:'authority',replicaId,incarnation:'i-'+replicaId,members:ms,rules},authorize:async()=>{},assertActive:async()=>{},now,clockUncertaintyMs:()=>0,...(retainMs===undefined?{}:{requestRetentionMs:retainMs})});
 const node=(r:string,retainMs?:number)=>{let n=nodes.get(r);if(!n){n=make(r,members,retainMs);nodes.set(r,n);}return n;};
 // The reference never compacts and gets every change directly; it has its own (larger) membership, so no stream binding.
 const refs=new Map<string,Node>(),reference=(name='ref')=>{let r=refs.get(name);if(!r){r=make(name,[...members,{replicaId:name,incarnation:'i-'+name}]);refs.set(name,r);}return r;};
 try{await fn({host,node,reference,tick:(ms=10)=>{clock+=ms;},now});}finally{try{await host.close(ctx);}catch{}rmSync(dir,{recursive:true,force:true});}
}
const historyOf=async(host:Harness,c:Node)=>(await host.snapshot(EntryReplicas,c.documentKey,ctx));

for(const [seed,all] of [[1,false],[7,false],[42,false],[3,true],[11,true],[1234,true],[98765,true],[31337,true]] as const)test(`random operations and deliveries (seed ${seed}, ${all?'every replica compacts':'c never compacts'}): replicas converge to the non-compacting reference`,()=>compactionFixture(async o=>{
 const rand=rng(seed),pick=<T,>(xs:T[])=>xs[Math.floor(rand()*xs.length)]!;
 const names=['a','b','c'],nodes=names.map(r=>o.node(r,0)),compacting=new Set(all?[0,1,2]:[0,1]),shadows=names.map(r=>o.reference('shadow-'+r));
 // Compaction must never change what a replica shows, now or after any later input: compare with its shadow every step.
 const same=async(k:number,when:string)=>assert.deepEqual(await viewOf(nodes[k]!),await viewOf(shadows[k]!),`replica ${names[k]} differs from its shadow ${when}`);
 const created:import('../src/entry-replication.ts').ReplicatedEntryChange[]=[];let req=0,compactions=0,dropped=0,erased=false;
 for(let step=0;step<160;step++){
  const i=Math.floor(rand()*3),x=nodes[i]!,roll=rand(),owner=rand()<0.5?P:Q,exp=rand()<0.3?o.now()+Math.floor(rand()*120_000):null;
  try{
   const own=async(e:Promise<import('../src/entry-replication.ts').ReplicatedEntryChange>)=>{const c=await e;created.push(c);await shadows[i]!.importChanges([c]);};
   if(roll<0.18)await own(x.mutate('r'+req++,{kind:'put',type:'Sensor',fields:{sensorId:pick(['s1','s2','s3']),v:step},owner,expiresAt:exp}));
   else if(roll<0.28)await own(x.mutate('r'+req++,{kind:'delete',type:'Sensor',fields:{sensorId:pick(['s1','s2','s3'])},owner}));
   else if(roll<0.42)await own(x.mutate('r'+req++,{kind:'add',type:'Fact',fields:{n:step%5},owner,expiresAt:exp}));
   else if(roll<0.52){const facts=(await x.read()).filter(v=>v.type==='Fact');if(facts.length)await own(x.mutate('r'+req++,{kind:'remove',type:'Fact',tags:[...new Set([pick(facts).id,pick(facts).id])],owner}));}
   else if(roll<0.60){const facts=(await x.read()).filter(v=>v.type==='Fact');if(facts.length){const f=pick(facts);await own(x.mutate('r'+req++,{kind:'renew',type:'Fact',tag:f.id,fields:f.fields,owner:f.owner,expiresAt:rand()<0.5?null:o.now()+90_000}));}}
   else if(roll<0.62&&!erased&&step>60){erased=true;await own(x.erasePrincipal('r'+req++,P,ADMIN));}
   else if(roll<0.88){const j=(i+1+Math.floor(rand()*2))%3;await sync(nodes[j]!,x,shadows[i]);}
   else if(compacting.has(i)){const r=await x.compact('c'+req++);if(r.dropped){compactions++;dropped+=r.dropped;}}
  }catch(e){if(!(e instanceof Error)||!/renewal requires|local remove/.test(e.message))throw e;}
  o.tick(Math.floor(rand()*20_000));
  for(const k of compacting)await same(k,`after step ${step}`);
 }
 o.tick(200_000);await settle(nodes,shadows);
 for(const n of compacting){const r=await nodes[n]!.compact('final-'+n);dropped+=r.dropped;if(r.dropped)compactions++;}
 await settle(nodes,shadows);for(const k of compacting)await same(k,'at the end');
 const ref=o.reference();for(let k=0;k<created.length;k+=40)await ref.importChanges(created.slice(k,k+40));
 const expected=await viewOf(ref);
 for(const [k,n] of nodes.entries())assert.deepEqual(await viewOf(n),expected,`replica ${names[k]} differs from the reference`);
 assert.ok(compactions>0&&dropped>0,`compaction removed something (compactions ${compactions}, dropped ${dropped})`);
 const kept=(await historyOf(o.host,nodes[0]!))!;const logicalA=(await nodes[0]!.changes(0,256*1024));
 assert.ok(logicalA.events.length<(await ref.changes(0,256*1024)).events.length,'the compacting replica holds fewer events than the reference');
 assert.ok(kept.floor&&Object.keys(kept.floor).length,'a floor is installed');
}));

const tagOf=(e:import('../src/entry-replication.ts').ReplicatedEntryChange)=>JSON.stringify([e.originReplicaId,e.incarnation,e.seq]);
/** `to` records the vectors `froms` advertise now. */
const recordAt=async(to:Node,...froms:Node[])=>{for(const f of froms)await to.recordPeerVector(await f.describeStream());};
const refView=async(o:{reference:(n?:string)=>Node},name:string,events:import('../src/entry-replication.ts').ReplicatedEntryChange[])=>{const r=o.reference(name);await r.importChanges(events);return viewOf(r);};

test('compaction waits for a vector from every member, refuses a lagging or regressed one, and keeps what is not yet stable',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 const t=await a.mutate('t',{kind:'add',type:'Fact',fields:{n:1},owner:P,expiresAt:null});o.tick();
 const r=await a.mutate('r',{kind:'remove',type:'Fact',tags:[tagOf(t)],owner:P});o.tick();
 assert.match((await a.compactionStatus()).blocked!,/no vector recorded from member b/);
 await sync(a,b);await recordAt(a,b);assert.match((await a.compactionStatus()).blocked!,/member c/,'a silent member blocks compaction');
 await recordAt(a,c);let status=await a.compactionStatus();assert.equal(status.blocked,null);assert.equal(status.droppable,0,'c lags: nothing is stable yet');
 assert.deepEqual(await a.compact('nothing'),{dropped:0,status});
 await sync(a,c);await recordAt(a,c);status=await a.compactionStatus();assert.equal(status.droppable,2,'add and remove are stable now');
 // b wrote something a has not seen: a must not compact while b's own changes are missing here.
 await b.mutate('b1',{kind:'add',type:'Fact',fields:{n:2},owner:Q,expiresAt:null});await recordAt(a,b);
 assert.match((await a.compactionStatus()).blocked!,/changes of member b are still missing/);
 await sync(b,a);const before=await viewOf(a),bytesBefore=JSON.stringify(await historyOf(o.host,a)).length;
 const result=await a.compact('first');assert.equal(result.dropped,2);assert.deepEqual(await viewOf(a),before);
 assert.ok(JSON.stringify(await historyOf(o.host,a)).length<bytesBefore,'the stored history shrinks');
 // Re-delivered compacted changes are recognised below the floor and stay away.
 assert.deepEqual((await a.importChanges([t,r])).added,0);assert.deepEqual((await a.importChanges([t])).added,0);assert.deepEqual(await viewOf(a),before);
 // c streams from a with its old cursor and still converges; b's stream into a keeps working.
 await sync(a,c);await sync(b,a);assert.deepEqual(await viewOf(c),before);
 // A peer that reports less than before (restored without a new incarnation) stops compaction.
 const lower=await c.describeStream();for(const k of Object.keys(lower.vector!))lower.vector![k]=0;await a.recordPeerVector(lower);
 assert.match((await a.compactionStatus()).blocked!,/regressed|lower vector/);
}));

test('a remove stays while one of its tags is not yet stable',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 const t=await b.mutate('t',{kind:'add',type:'Fact',fields:{n:1},owner:Q,expiresAt:null});o.tick();await sync(b,a);
 const r=await a.mutate('r',{kind:'remove',type:'Fact',tags:[tagOf(t)],owner:Q});o.tick();
 // c gets the remove without the tag; b gets the remove. The remove is stable, the tag is not (c lacks it).
 await c.importChanges([r]);await b.importChanges([r]);await recordAt(a,b,c);
 const before=await viewOf(a);await a.compact('x');assert.deepEqual(await viewOf(a),before,'the tag must not come back');
 assert.deepEqual(await viewOf(a),await refView(o,'ref-r',[t,r]));
 await sync(b,c);await recordAt(a,c);assert.equal((await a.compact('y')).dropped,2,'once the tag is stable both go');assert.deepEqual(await viewOf(a),before);
}));

test('a lww tombstone goes only with every older version; a concurrent older put cannot come back',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 const old=await c.mutate('p',{kind:'put',type:'Sensor',fields:{sensorId:'s1',v:'old'},owner:Q,expiresAt:null});o.tick();
 const w=await a.mutate('w',{kind:'delete',type:'Sensor',fields:{sensorId:'s1'},owner:Q});o.tick();
 await sync(a,b);await sync(a,c);await recordAt(a,b,c);
 // c's own older put is not here yet: refused (condition 2), so the tombstone stays until it arrives.
 assert.match((await a.compactionStatus()).blocked!,/member c/);
 await sync(c,a);assert.equal((await a.compact('x')).dropped,0,'b lacks the older put: it is not stable');
 await sync(c,b);await recordAt(a,b);assert.equal((await a.compact('y')).dropped,2);
 await a.importChanges([old]);assert.deepEqual(await viewOf(a),await refView(o,'ref-w',[old,w]));assert.deepEqual(await viewOf(a),[]);
}));

test('an erased tag stays while a renewal of it remains, so a later erase still hides the renewal',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 const t=await a.mutate('t',{kind:'add',type:'Fact',fields:{n:'secret'},owner:P,expiresAt:null});o.tick();await sync(a,b);await sync(a,c);
 const r=await a.mutate('r',{kind:'remove',type:'Fact',tags:[tagOf(t)],owner:Q});o.tick();await sync(a,c);await recordAt(a,c);
 const x=await c.erasePrincipal('x',P,ADMIN);o.tick();// after c's recorded vector; reaches a only later
 const rn=await b.mutate('rn',{kind:'renew',type:'Fact',tag:tagOf(t),fields:{n:'secret'},owner:P,expiresAt:null});o.tick();// concurrent with the remove
 await sync(b,a);await sync(a,b);await recordAt(a,b);
 await a.compact('x');await sync(c,a);
 assert.deepEqual(await viewOf(a),await refView(o,'ref-x',[t,r,x,rn]),'the renewal is hidden as without compaction');assert.deepEqual(await viewOf(a),[]);
}));

test('an expired tag goes only once every member reported after its expiry',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 const t=await a.mutate('t',{kind:'add',type:'Fact',fields:{n:'secret'},owner:P,expiresAt:o.now()+10_000});o.tick();await sync(a,b);await sync(a,c);await recordAt(a,b,c);
 const x=await c.erasePrincipal('x',P,ADMIN);o.tick();
 const rn=await b.mutate('rn',{kind:'renew',type:'Fact',tag:tagOf(t),fields:{n:'secret'},owner:P,expiresAt:null});
 o.tick(80_000);assert.equal((await a.compact('early')).dropped,0,'the recorded vectors predate the expiry');
 await sync(b,a);await sync(c,a);assert.deepEqual(await viewOf(a),await refView(o,'ref-e',[t,x,rn]));assert.deepEqual(await viewOf(a),[]);
}));

test('own changes stay for the request retention, so a retry returns the original change',()=>compactionFixture(async o=>{
 const a=o.node('a',3_600_000),b=o.node('b'),c=o.node('c');
 const m:EntryMutation={kind:'delete',type:'Sensor',fields:{sensorId:'s9'},owner:Q},first=await a.mutate('del',m);o.tick();
 await sync(a,b);await sync(a,c);await recordAt(a,b,c);assert.equal((await a.compactionStatus()).droppable,0);
 assert.deepEqual(await a.mutate('del',m),first);
 o.tick(3_600_001);assert.equal((await a.compact('late')).dropped,1,'after the retention the tombstone goes');
}));

test('snapshots after compaction: a compacted source seeds the stream at its head, an old snapshot cannot bring removed changes back',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 const t=await a.mutate('t',{kind:'add',type:'Fact',fields:{n:1},owner:Q,expiresAt:null});o.tick();
 await a.mutate('r',{kind:'remove',type:'Fact',tags:[tagOf(t)],owner:Q});o.tick();
 await a.mutate('k',{kind:'add',type:'Fact',fields:{n:2},owner:Q,expiresAt:null});o.tick();
 await sync(a,b);await sync(a,c);await recordAt(a,b,c);
 const transfer=async(from:Node,to:Node)=>{const m=await from.startSnapshot();await to.beginSnapshotImport(m);for(let p=0;p<m.pageCount;p++)await to.importSnapshotPage(m.id,await from.snapshotPage(m.id,p));return {m,result:await to.finishSnapshotImport(m.id)};};
 assert.equal((await a.compact('x')).dropped,2);const view=await viewOf(a);
 // b never compacted: its snapshot holds the removed add and remove; installed on a they stay away.
 const fromB=await transfer(b,a);assert.equal(fromB.result.added,0);assert.deepEqual(await viewOf(a),view);
 assert.equal((await a.changes(0,256*1024)).events.length,1,'only the live add is in the logical history');
 // a's snapshot has one event at head position 3; b seeds a stream from it at 3.
 const fromA=await transfer(a,b);assert.deepEqual([fromA.m.eventCount,fromA.m.revision],[1,3]);
 const identity=(await a.describeStream()).source;assert.equal((await b.startStreamImport(identity,fromA.m.id)).cursor,3);
 await a.mutate('k2',{kind:'add',type:'Fact',fields:{n:3},owner:Q,expiresAt:null});await sync(a,b);assert.deepEqual(await viewOf(b),await viewOf(a));
}));

test('periodic compaction keeps working: old generation receipts are forgotten',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 for(let round=0;round<20;round++){
  await b.mutate('p'+round,{kind:'put',type:'Sensor',fields:{sensorId:'k'+round,v:round},owner:Q,expiresAt:null});
  await b.mutate('d'+round,{kind:'delete',type:'Sensor',fields:{sensorId:'k'+round},owner:Q});
  await settle([a,b,c]);await recordAt(a,b,c);o.tick(61_000);
  assert.equal((await a.compact('round-'+round)).dropped,2,`round ${round}`);
 }
}));

test('an erase arriving while a compaction copies aborts that generation; the next one succeeds',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 await a.mutate('keep',{kind:'add',type:'Fact',fields:{n:'secret'},owner:P,expiresAt:null});
 // Live entries keep the copied prefix several pages long; the put/delete pairs are what goes.
 for(let n=0;n<20;n++)await b.mutate('live'+n,{kind:'put',type:'Sensor',fields:{sensorId:'live'+n,pad:'x'.repeat(2000)},owner:Q,expiresAt:null});
 for(let n=0;n<40;n++)await b.mutate('f'+n,{kind:'put',type:'Sensor',fields:{sensorId:'k'+n},owner:Q,expiresAt:null});
 for(let n=0;n<40;n++)await b.mutate('g'+n,{kind:'delete',type:'Sensor',fields:{sensorId:'k'+n},owner:Q});
 await settle([a,b,c]);await recordAt(a,b,c);
 const job=await a.startCompaction('first',4096);assert.ok(job.manifest.pageCount>2);await a.advanceSnapshotMaintenance('first');
 await c.erasePrincipal('x',P,ADMIN);await sync(c,a);// redacts a retained event of the copied prefix
 await assert.rejects(a.advanceSnapshotMaintenance('first'),/prefix changed/);
 const r=await a.compact('second');assert.equal(r.dropped,0,'the stale generation is aborted');
 assert.equal((await a.snapshotMaintenanceStatus()),null);
 await settle([a,b,c]);await recordAt(a,b,c);assert.ok((await a.compact('third')).dropped>=80);
 assert.equal((await viewOf(a)).length,20,'only the live entries remain');
 assert.equal((await a.erasureStatus()).complete,true,'the aborted pages and the old generation are gone');
}));

test('a live entry renewed again and again keeps only its latest renewal once the chain is stable',()=>compactionFixture(async o=>{
 const [a,b,c]=['a','b','c'].map(r=>o.node(r,0)) as [Node,Node,Node];
 let tag=tagOf(await a.mutate('t',{kind:'add',type:'Fact',fields:{n:1},owner:Q,expiresAt:o.now()+100_000}));
 for(let n=0;n<5;n++){o.tick(50_000);tag=tagOf(await a.mutate('rn'+n,{kind:'renew',type:'Fact',tag,fields:{n:1},owner:Q,expiresAt:o.now()+100_000}));}
 await settle([a,b,c]);await recordAt(a,b,c);const view=await viewOf(a);assert.equal(view.length,1);
 assert.equal((await a.compact('x')).dropped,5);assert.deepEqual(await viewOf(a),view);assert.equal((await a.changes(0,256*1024)).events.length,1);
}));
