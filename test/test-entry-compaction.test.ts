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
