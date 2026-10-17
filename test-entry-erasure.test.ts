// lww/set step 3 (docs/ap3-replikation.md): erasing a principal from replicated entry histories.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {EntryReplicationController,EntryReplicas,compactErasedSqlite} from './src/index.ts';
import {ctx} from './test/support/persistent.ts';

const P={peerId:'peer-p'},Q={peerId:'peer-q'},ADMIN={peerId:'admin'},SECRET='secret-of-p';
const rules=[{type:'Sensor',variant:'lww' as const,keyFields:['sensorId']},{type:'Fact',variant:'set' as const}];
const members=['a','b','c'].map(r=>({replicaId:r,incarnation:'i-'+r}));

async function fixture(fn:(o:{dir:string;file:string;host:Harness;node:(r:string)=>EntryReplicationController;tick:()=>void})=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'entry-erasure-')),file=join(dir,'replicas.sqlite');
 const host=await Harness.open(await openNodeSqliteStorage(file),{models:createModels(),registry:createRegistry()},ctx);let clock=1_700_000_000_000;
 const nodes=new Map<string,EntryReplicationController>();
 const node=(r:string)=>{let n=nodes.get(r);if(!n){n=new EntryReplicationController({host,ctx,config:{spaceId:'sp-merge',authorityId:'authority',replicaId:r,incarnation:'i-'+r,members,rules},authorize:async()=>{},assertActive:async()=>{},now:()=>clock,clockUncertaintyMs:()=>0});nodes.set(r,n);}return n;};
 try{await fn({dir,file,host,node,tick:()=>{clock+=10;}});}finally{try{await host.close(ctx);}catch{}rmSync(dir,{recursive:true,force:true});}
}
/** Imports every change of `from` into `to`, one change per import (the redacted forms may arrive before the erase). */
async function pull(from:EntryReplicationController,to:EntryReplicationController,onePerImport=false){
 const {events}=await from.changes(0,256*1024);
 if(onePerImport)for(const e of events)await to.importChanges([e]);else await to.importChanges(events);
}
const view=async(c:EntryReplicationController)=>(await c.read()).map(v=>({type:v.type,fields:v.fields,owner:v.owner.peerId})).sort((x,y)=>JSON.stringify(x)<JSON.stringify(y)?-1:1);
const stored=async(host:Harness,r:string)=>JSON.stringify(await host.snapshot(EntryReplicas,JSON.stringify(['sp-merge',r,'i-'+r]),ctx));

test('an erased principal disappears from every replica view and stored overlay, without resurrecting older versions',()=>fixture(async o=>{
 const a=o.node('a'),b=o.node('b'),c=o.node('c');
 await a.mutate('q-s1',{kind:'put',type:'Sensor',fields:{sensorId:'s1',v:'older-by-q'},owner:Q,expiresAt:null});o.tick();
 await a.mutate('p-s1',{kind:'put',type:'Sensor',fields:{sensorId:'s1',v:SECRET},owner:P,expiresAt:null});o.tick();
 await a.mutate('p-fact',{kind:'add',type:'Fact',fields:{note:SECRET},owner:P,expiresAt:null});o.tick();
 await a.mutate('q-s2',{kind:'put',type:'Sensor',fields:{sensorId:'s2',v:'q'},owner:Q,expiresAt:null});o.tick();
 await pull(a,c);// c holds the originals and goes offline
 const owned=await a.changeIdsOwnedBy(P);assert.equal(owned.length,2,'evidence for the Root journals: the changes of P');
 await a.erasePrincipal('erase-p',P,ADMIN);o.tick();
 // The erase is versioned: a later write by P survives (the admin flow revokes P's key first).
 const expected=[{type:'Sensor',fields:{sensorId:'s2',v:'q'},owner:'peer-q'}];
 assert.deepEqual(await view(a),expected,'s1 stays hidden: the redacted put still wins its key; no older version of q comes back');
 assert.ok(!(await stored(o.host,'a')).includes(SECRET),'the stored overlay of a holds no erased content');
 assert.deepEqual(await a.changeIdsOwnedBy(P),owned,'redacted changes keep their owner, so the evidence stays complete');
 // b gets the redacted forms one change at a time, before the erase itself arrives.
 await pull(a,b,true);assert.deepEqual(await view(b),expected);assert.ok(!(await stored(o.host,'b')).includes(SECRET));
 // c comes back with the originals: it adopts the redactions; its originals offered to b are recognised and dropped.
 await pull(c,b);assert.deepEqual(await view(b),expected,'originals arriving after their redaction are dropped');
 await pull(b,c);assert.deepEqual(await view(c),expected);assert.ok(!(await stored(o.host,'c')).includes(SECRET),'c replaced its originals');
 for(const r of [a,b,c])assert.equal((await r.erasureStatus()).complete,true);
}));

test('a renewal of an erased tag stays invisible and never stops an import',()=>fixture(async o=>{
 const a=o.node('a'),b=o.node('b');
 const added=await a.mutate('p-add',{kind:'add',type:'Fact',fields:{note:SECRET},owner:P,expiresAt:null});o.tick();
 await pull(a,b);
 await b.mutate('p-renew',{kind:'renew',type:'Fact',tag:JSON.stringify([added.originReplicaId,added.incarnation,added.seq]),fields:{note:SECRET},owner:P,expiresAt:null});
 await a.erasePrincipal('erase-p',P,ADMIN);o.tick();
 await pull(b,a);await pull(a,b);
 // The renewal on b is not earlier than the erase, yet it copies the erased tag's fields: it is redacted with it.
 assert.deepEqual(await view(a),[]);assert.deepEqual(await view(b),[]);
 assert.ok(!(await stored(o.host,'a')).includes(SECRET)&&!(await stored(o.host,'b')).includes(SECRET));
}));

test('snapshot segments are rebuilt from the redacted view and the compacted SQLite file holds no erased content',()=>fixture(async o=>{
 const a=o.node('a');
 await a.mutate('p-s1',{kind:'put',type:'Sensor',fields:{sensorId:'s1',v:SECRET},owner:P,expiresAt:null});o.tick();
 await a.mutate('q-s2',{kind:'put',type:'Sensor',fields:{sensorId:'s2',v:'q'},owner:Q,expiresAt:null});o.tick();
 // Move the history into snapshot segments first.
 let job=await a.startSnapshotMaintenance('m1');while(job.phase!=='completed')job=await a.advanceSnapshotMaintenance('m1');
 await a.erasePrincipal('erase-p',P,ADMIN);o.tick();
 const before=await a.erasureStatus();assert.ok(before.segmentsPending>0&&!before.complete,'segments still hold the original');
 assert.deepEqual(await view(a),[{type:'Sensor',fields:{sensorId:'s2',v:'q'},owner:'peer-q'}],'the logical view is redacted at once');
 assert.ok(!JSON.stringify((await a.changes(0,256*1024)).events).includes(SECRET),'exports are redacted at once');
 const after=await a.completeErasure('erase-p-local');assert.deepEqual(after,{erases:1,overlayPending:0,segmentsPending:0,transfersPending:0,complete:true});
 await o.host.close(ctx);
 const raw=()=>readFileSync(o.file).toString('latin1')+(()=>{try{return readFileSync(o.file+'-wal').toString('latin1');}catch{return '';}})();
 assert.ok(raw().includes(SECRET),'before compaction older revisions still hold the content (this is what compaction is for)');
 await compactErasedSqlite(o.file,async()=>{});
 assert.ok(!raw().includes(SECRET),'after the durable history compaction no byte of the erased content remains');
}));
