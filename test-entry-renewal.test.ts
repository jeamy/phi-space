import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EntryReplicationController,entryChangeId,ReplicationConflict,RequestConflict,type EntryMutation,type EntryReplicationConfig} from './src/index.ts';
import {canonicalJson} from './src/canonical.ts';
import {BACKENDS,PersistentHome,InjectedFault,ctx} from './test/support/persistent.ts';
const config=(replicaId:string):EntryReplicationConfig=>({spaceId:'renewal-space',authorityId:'authority',replicaId,incarnation:'v1',members:['a','b'].map(replicaId=>({replicaId,incarnation:'v1'})),rules:[{type:'Fact',variant:'set'}]});
const owner={peerId:'subject'},fields={n:1},add:EntryMutation={kind:'add',type:'Fact',fields,owner,expiresAt:2000};
for(const backend of BACKENDS){
 for(const fault of ['failBeforeCommit','loseAnswer'] as const)test(`${backend}: atomic set renewal ${fault} preserves a single new version and its original receipt after reopen`,async()=>{
  const home=new PersistentHome(backend);let host=await home.open(),now=1000;
  const node=()=>new EntryReplicationController({host,ctx,config:config('a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
  try{
   const original=await node().mutate('add',add),renew:EntryMutation={kind:'renew',type:'Fact',tag:entryChangeId(original),fields,owner,expiresAt:5000};
   home.faults.arm(fault);await assert.rejects(node().mutate('renew',renew),InjectedFault);await home.close(host);host=await home.open();
   const before=await node().read();assert.equal(before.length,1);assert.equal(before[0]!.expiresAt,fault==='loseAnswer'?5000:2000);
   const event=await node().mutate('renew',renew);assert.notEqual(entryChangeId(event),entryChangeId(original));assert.equal((await node().read()).length,1);assert.equal((await node().read())[0]!.id,entryChangeId(event));
   now=6000;assert.equal((await node().read()).length,0);assert.deepEqual(await node().mutate('renew',renew),event,'expired successful renewal returns its original decided version');
   await assert.rejects(node().mutate('renew',{...renew,expiresAt:9000}),RequestConflict);
  }finally{await home.dispose();}
 });
 test(`${backend}: concurrent renewal/remove is add-wins, out-of-order delivery converges and expired renewal never revives the old tag`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)],hosts=await Promise.all(homes.map(h=>h.open()));let now=1000;
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
  try{
   const original=await node(0).mutate('add',{...add,expiresAt:null});await node(1).importChanges([original]);
   const renewal=await node(0).mutate('renew',{kind:'renew',type:'Fact',tag:entryChangeId(original),fields,owner,expiresAt:3000});
   const removal=await node(1).mutate('remove',{kind:'remove',type:'Fact',tags:[entryChangeId(original)],owner});
   await node(0).importChanges([removal]);await node(1).importChanges([renewal]);assert.deepEqual(await node(0).read(),await node(1).read());assert.equal((await node(0).read()).length,1);
   now=4000;assert.equal((await node(0).read()).length,0,'permanent old version stays removed after renewal expiration');
   const lateHome=new PersistentHome(backend),lateHost=await lateHome.open(),late=new EntryReplicationController({host:lateHost,ctx,config:config('b'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
   try{await late.importChanges([renewal]);await late.importChanges([removal,original,renewal]);assert.deepEqual(await late.read(),await node(0).read());assert.equal((await late.changes()).events.length,3);}finally{await lateHome.dispose();}
  }finally{for(const h of homes)await h.dispose();}
 });
 test(`${backend}: renewal cannot change owner/fields, target an expired or removed tag, or smuggle invalid causal references`,async()=>{
  const home=new PersistentHome(backend),host=await home.open();let now=1000;
  const node=new EntryReplicationController({host,ctx,config:config('a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
  try{
   const original=await node.mutate('add',add),renew:EntryMutation={kind:'renew',type:'Fact',tag:entryChangeId(original),fields,owner,expiresAt:5000};
   await assert.rejects(node.mutate('owner',{...renew,owner:{peerId:'other'}}),ReplicationConflict);await assert.rejects(node.mutate('fields',{...renew,fields:{n:2}}),ReplicationConflict);
   const event=await node.mutate('renew',renew);await assert.rejects(node.mutate('twice',renew),ReplicationConflict);
   const bogus=structuredClone(event);if(bogus.mutation.kind!=='renew')throw Error('test renewal expected');bogus.mutation.tag=entryChangeId(bogus);bogus.argumentHash=createHash('sha256').update(canonicalJson(bogus.mutation as any)).digest('hex');
   await assert.rejects(node.importChanges([bogus]),/immutable/);
   const self=structuredClone(event);self.originReplicaId='b';self.seq=1;self.requestId='invalid-self';if(self.mutation.kind!=='renew')throw Error('renewal expected');self.mutation.tag=entryChangeId(self);self.argumentHash=createHash('sha256').update(canonicalJson(self.mutation as any)).digest('hex');await assert.rejects(node.importChanges([self]),/reference itself/);
   await node.mutate('remove-renewed',{kind:'remove',type:'Fact',tags:[entryChangeId(event)],owner});assert.equal((await node.read()).length,0);
   await assert.rejects(node.mutate('removed',{...renew,tag:entryChangeId(event)}),ReplicationConflict);
   const expiring=await node.mutate('expiring',add);now=3000;await assert.rejects(node.mutate('expired',{...renew,tag:entryChangeId(expiring)}),ReplicationConflict);
  }finally{await home.dispose();}
 });
}
