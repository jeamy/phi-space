import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EntryReplicationController, EntryReplicas, ReplicationConflict, entryChangeId, advanceHybridClock, compareHybridClock, ReplicationClockError, RequestConflict, core, type EntryMutation, type ReplicatedEntryChange, type EntryReplicationConfig } from '../src/index.ts';
import { canonicalJson } from '../src/canonical.ts';
import { BACKENDS, PersistentHome, InjectedFault, ctx } from './support/persistent.ts';
const owner={peerId:'subject',agentId:'writer'};
const put=(value:number,expiresAt:number|null=null):EntryMutation=>({kind:'put',type:'State',fields:{key:'sensor',value},owner,expiresAt});
const add=(value:number):EntryMutation=>({kind:'add',type:'Fact',fields:{value},owner,expiresAt:null});
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const config=(replicaId:string,incarnation='v1'):EntryReplicationConfig=>({spaceId:'shared',authorityId:'authority',replicaId,incarnation,members:['a','b','c'].map(replicaId=>({replicaId,incarnation:'v1'})),rules:[{type:'State',variant:'lww',keyFields:['key']},{type:'Fact',variant:'set'}]});

test('hybrid clock orders local/remote ties, rejects invalid/future clocks and fails on exhaustion',()=>{
 assert.deepEqual(advanceHybridClock({physical:10,logical:2},10),{physical:10,logical:3});
 assert.deepEqual(advanceHybridClock({physical:10,logical:2},9,{physical:10,logical:8}),{physical:10,logical:9});
 assert.deepEqual(advanceHybridClock({physical:10,logical:2},20,{physical:15,logical:8}),{physical:20,logical:0});
 assert.ok(compareHybridClock({physical:10,logical:100},{physical:11,logical:0})<0);
 assert.deepEqual(advanceHybridClock({physical:0,logical:0},0,{physical:60000,logical:0}),{physical:60000,logical:1});
 assert.throws(()=>advanceHybridClock({physical:0,logical:0},0,{physical:60001,logical:0}),ReplicationClockError);
 assert.throws(()=>advanceHybridClock({physical:1,logical:Number.MAX_SAFE_INTEGER},1),ReplicationClockError);
 assert.throws(()=>advanceHybridClock({physical:1,logical:0},NaN),ReplicationClockError);
});

for(const backend of BACKENDS){
 test(`${backend}: ten-minute partition converges under reverse duplicate delivery; restart retains HLC, tombstones and add-wins tags`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend),new PersistentHome(backend)];
  let hosts=await Promise.all(homes.map(h=>h.open())),now=1000000;
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(['a','b','c'][i]!),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>2000});
  try{
   const a=await node(0).mutate('initial-a',put(1)),b=await node(1).mutate('initial-b',put(2));
   assert.equal(a.clock.physical,b.clock.physical);assert.equal(a.clock.logical,b.clock.logical);
   await node(0).importChanges([b]);await node(1).importChanges([a]);
   assert.equal((await node(0).read())[0]!.fields.value,2,'replica ID breaks identical HLC ties');
   const observed=await node(0).mutate('fact-before',add(1));await node(1).importChanges([observed]);
   // No exchange for ten simulated minutes. Removal sees only the original add; B adds concurrently.
   const deleted=await node(0).mutate('delete-state',{kind:'delete',type:'State',fields:{key:'sensor'},owner});
   const removed=await node(0).mutate('remove-observed',{kind:'remove',type:'Fact',tags:[entryChangeId(observed)],owner});
   const concurrent=await node(1).mutate('concurrent-add',add(1));
   now+=600000;
   const newer=await node(1).mutate('new-state',put(3,now+1000));
   const fromA=(await node(0).changes()).events,fromB=(await node(1).changes()).events;
   await node(0).importChanges([...fromB].reverse());await node(1).importChanges([...fromA].reverse());
   await node(2).importChanges([removed,deleted,newer,concurrent,b,a,observed]);
   for(let i=0;i<3;i++){const result=await node(i).importChanges([...fromA,...fromB]);assert.equal(result.added,0);}
   const visible=await node(0).read();assert.deepEqual(await node(1).read(),visible);assert.deepEqual(await node(2).read(),visible);
   assert.equal(visible.filter(e=>e.type==='Fact').length,1);assert.equal(visible.find(e=>e.type==='Fact')!.id,entryChangeId(concurrent));
   for(let i=0;i<3;i++){await homes[i]!.close(hosts[i]!);hosts[i]=await homes[i]!.open();}
   now+=1001;
   for(let i=0;i<3;i++)assert.deepEqual((await node(i).read()).map(e=>e.type),['Fact'],'expired winning state never reveals older unexpired versions');
   assert.deepEqual(await node(0).mutate('new-state-copy',put(4)),await node(0).mutate('new-state-copy',put(4)));
   await assert.rejects(node(0).mutate('new-state-copy',put(5)),RequestConflict);
   const next=await node(0).mutate('renewed-state',put(6,now+5000));assert.ok(compareHybridClock(next.clock,newer.clock)>0);
   assert.ok(next.seq>removed.seq);assert.deepEqual(next.mutation.owner,owner);
   await node(2).importChanges([next]);assert.equal((await node(2).read()).find(e=>e.type==='State')!.fields.value,6);
  }finally{for(const h of homes)await h.dispose();}
 });
 test(`${backend}: loss before/after actual commit reopens the same change without duplicate effect`,async()=>{
  const home=new PersistentHome(backend);let host=await home.open();let allowed=true,active=true,now=10000,uncertainty=2000;
  const node=()=>new EntryReplicationController({host,ctx,config:config('a'),authorize:async()=>{if(!allowed)throw Error('revoked');},assertActive:async()=>{if(!active)throw Error('fenced');},now:()=>now,clockUncertaintyMs:()=>uncertainty});
  try{
   for(const fault of ['failBeforeCommit','loseAnswer'] as const){
    const requestId='request-'+fault;home.faults.arm(fault);await assert.rejects(node().mutate(requestId,put(1)),InjectedFault);
    await home.close(host);host=await home.open();const event=await node().mutate(requestId,put(1));assert.deepEqual(await node().mutate(requestId,put(1)),event);
   }
   assert.equal((await node().changes()).events.length,2);
   allowed=false;await assert.rejects(node().mutate('no',put(1)),/revoked/);await assert.rejects(node().read(),/revoked/);allowed=true;
   active=false;await assert.rejects(node().importChanges([]),/fenced/);await assert.rejects(node().snapshot(),/fenced/);active=true;
   uncertainty=5000;await assert.rejects(node().mutate('clock-unsafe',put(1)),ReplicationClockError);await assert.rejects(node().read(),ReplicationClockError);uncertainty=2000;
   now-=5001;await assert.rejects(node().mutate('clock-backward',put(1)),ReplicationClockError);now+=6000;
   const resumed=await node().mutate('clock-safe',put(1));assert.equal(resumed.seq,3,'rejected operations consume no sequence');
  }finally{await home.dispose();}
 });
 test(`${backend}: atomic snapshots merge local writes and preserve removed/expired versions, gaps and dedup on reopen`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];let hosts=await Promise.all(homes.map(h=>h.open()));let now=100000;
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(i?'b':'a'),authorize:async()=>{},assertActive:async()=>{},now:()=>now,clockUncertaintyMs:()=>0});
  try{
   const first=await node(0).mutate('a',put(1)),second=await node(0).mutate('b',put(2,now+50));
   const fact=await node(0).mutate('fact',add(1));const remove=await node(0).mutate('remove',{kind:'remove',type:'Fact',tags:[entryChangeId(fact)],owner});
   const snapshot=await node(0).snapshot();const local=await node(1).mutate('local-fact',add(2));
   await node(1).importChanges([second]); // A high sequence must not mark a missing low sequence seen.
   assert.equal((await node(1).installSnapshot(snapshot)).added,3);assert.equal((await node(1).importChanges([first,remove])).added,0);
   const before=await hosts[1]!.snapshot(EntryReplicas,node(1).documentKey,ctx);
   for(const fault of ['failBeforeCommit','loseAnswer'] as const){
    const extra=await node(0).mutate('after-'+fault,add(3)),next=await node(0).snapshot();
    homes[1]!.faults.arm(fault);await assert.rejects(node(1).installSnapshot(next),InjectedFault);await homes[1]!.close(hosts[1]!);hosts[1]=await homes[1]!.open();
    await node(1).installSnapshot(next);assert.equal((await node(1).importChanges([extra])).added,0);
   }
   now+=51;const visible=await node(1).read();assert.ok(visible.some(e=>e.id===entryChangeId(local)));assert.ok(!visible.some(e=>e.type==='State'||e.id===entryChangeId(fact)));
   assert.ok(before!.events.some(e=>entryChangeId(e)===entryChangeId(remove)));
   const changed=structuredClone(snapshot);changed.events[0]!.mutation.owner.peerId='forged';await assert.rejects(node(1).installSnapshot(changed),/hash mismatch/);
   const wrong=structuredClone(snapshot);wrong.configHash='0'.repeat(64);await assert.rejects(node(1).installSnapshot(wrong),/binding changed/);
   // Byte-bounded pages concatenate without truncating/dropping a change.
   const all=(await node(1).changes()).events;let after=0,collected:ReplicatedEntryChange[]=[];
   do{const p=await node(1).changes(after,1200);assert.ok(Buffer.byteLength(JSON.stringify(p))<=1200);collected.push(...p.events);after=p.next;if(!p.more)break;}while(true);
   assert.deepEqual(collected,all);
  }finally{for(const h of homes)await h.dispose();}
 });
 test(`${backend}: import rejects retired identities, HLC equivocation, future clocks and cross-type removes atomically`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend)];const hosts=await Promise.all(homes.map(h=>h.open()));let authorized=true,calls=0,revokeOnImportCheck=0;
  const node=(i:number)=>new EntryReplicationController({host:hosts[i]!,ctx,config:config(i?'b':'a'),authorize:async action=>{calls++;if(action==='import'&&revokeOnImportCheck>0&&--revokeOnImportCheck===0)authorized=false;if(!authorized)throw Error('revoked');},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0});
  try{
   const good=await node(0).mutate('good',put(1));await node(1).importChanges([good]);const saved=await hosts[1]!.snapshot(EntryReplicas,node(1).documentKey,ctx);
   for(const mutate of [(e:ReplicatedEntryChange)=>{e.incarnation='retired';},(e:ReplicatedEntryChange)=>{e.seq++;},(e:ReplicatedEntryChange)=>{e.clock.physical=61001;},(e:ReplicatedEntryChange)=>{e.mutation.owner.peerId='changed';}]){
    const bad=structuredClone(good);mutate(bad);await assert.rejects(node(1).importChanges([bad]));assert.deepEqual(await hosts[1]!.snapshot(EntryReplicas,node(1).documentKey,ctx),saved);
   }
   const reused=structuredClone(good);reused.mutation=put(99);reused.argumentHash=digest(reused.mutation);await assert.rejects(node(1).importChanges([reused]),/immutable change ID reused/);
   const bogus={...structuredClone(good),seq:good.seq+1,clock:{physical:1000,logical:good.clock.logical+1},requestId:'bogus',mutation:{kind:'remove',type:'Fact',tags:[entryChangeId(good)],owner} as EntryMutation};bogus.argumentHash=digest(bogus.mutation);await assert.rejects(node(1).importChanges([bogus]),/non-add/);
   const next=await node(0).mutate('next',add(1));const bad=structuredClone(next);bad.incarnation='retired';await assert.rejects(node(1).importChanges([next,bad]));assert.deepEqual(await hosts[1]!.snapshot(EntryReplicas,node(1).documentKey,ctx),saved);
   revokeOnImportCheck=2;await assert.rejects(node(1).importChanges([next]),/revoked/);authorized=true;assert.ok(calls>10);assert.deepEqual(await hosts[1]!.snapshot(EntryReplicas,node(1).documentKey,ctx),saved);
   await assert.rejects(node(1).mutate('invalid-json',{...put(1),expiresAt:Infinity} as EntryMutation));
   const retired=config('b');retired.members[0]!.incarnation='v2';
   const changed=new EntryReplicationController({host:hosts[1]!,ctx,config:retired,authorize:async()=>{},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0});
   await assert.rejects(changed.read(),/explicit rebuild required/);
  }finally{for(const h of homes)await h.dispose();}
 });
 test(`${backend}: retained history and atomic batch caps backpressure instead of discarding deletion metadata`,async()=>{
  const home=new PersistentHome(backend),originalStorage=home.storage.bind(home);let largestCommit=0;
  home.faults.observe(w=>{largestCommit=Math.max(largestCommit,Buffer.byteLength(JSON.stringify(w)));});
  const host=await home.open();
  const node=new EntryReplicationController({host,ctx,config:config('a'),authorize:async()=>{},assertActive:async()=>{},now:()=>1000,clockUncertaintyMs:()=>0,maxHistoryBytes:16384,maxBatchBytes:32768});
  try{
   const tombstone=await node.mutate('delete',{kind:'delete',type:'State',fields:{key:'sensor'},owner});let accepted=1;
   for(let n=0;n<100;n++){try{await node.mutate('add-'+n,add(n));accepted++;}catch(e){assert.ok(e instanceof core.ResourceExhausted);break;}}
   assert.ok(accepted>1&&accepted<100);const stored=await host.snapshot(EntryReplicas,node.documentKey,ctx);assert.equal(stored!.events.length,accepted);assert.deepEqual(stored!.events[0],tombstone);
   await assert.rejects(node.snapshot(),core.ResourceExhausted);
   await assert.rejects(node.mutate('too-large',{kind:'add',type:'Fact',fields:{pad:'x'.repeat(64000)},owner,expiresAt:null}),core.ResourceExhausted);
   assert.equal((await host.snapshot(EntryReplicas,node.documentKey,ctx))!.events.length,accepted);assert.ok(largestCommit<=32768,`actual commit ${largestCommit} exceeds batch cap`);
  }finally{await home.dispose();}
 });
}
