import test from 'node:test';import assert from 'node:assert/strict';
import {DataAdminController} from './src/data-admin.ts';import * as core from './src/core.ts';import * as claims from './src/claims.ts';
import {principalId,appendMail} from './src/mailbox.ts';import {snapshotPage} from './src/snapshot.ts';
import {createSpace,spaceDoc,snapshotSpace} from './src/spaces.ts';import {BACKENDS,ctx,PersistentHome} from './test/support/persistent.ts';
for(const backend of BACKENDS)test(`${backend}: scoped, audited purge and principal erasure reject replay and old snapshots`,async()=>{
 const home=new PersistentHome(backend);try{
 const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'jobs',1000),ctx)).spaceId,p={peerId:'alice'},q={peerId:'bob'};
 let authorized=false;const admin=new DataAdminController({host,ctx,assertAuthority:async()=>{},authorize:async()=>{if(!authorized)throw new core.PermissionError('separate admin scope required');},now:()=>1002});
 const ref=await host.commit(async tx=>{const s=await spaceDoc(tx,sid,1000);core.setCompletionProfiles(s,[{taskType:'Task',resultTypes:['Result'],equalFields:['n'],maxResultCount:1}],1000);
 const g=claims.issueGeneration(s,1000,p),ref={principal:p,generation:g.generation,requestId:'old'};const admitted=claims.admit(s,1000,ref,'write',{entry:'secret'},2000,4096);
 const l=core.write(s,1000,{type:'Task',fields:{n:1,secret:'personal'}},null,core.FOREVER,principalId(p));core.write(s,1000,{type:'Task',fields:{n:2}},null,core.FOREVER,principalId(p));
 const entry=core.list(s,1000,{id:l.id})[0]!;claims.decide(s,1000,admitted.key,{state:'done',result:entry as any});
 appendMail(s,p,{kind:'waiter',eventId:'w',seq:1,target:principalId(p),handback:null,entry},1000);appendMail(s,q,{kind:'waiter',eventId:'x',seq:1,target:principalId(q),handback:null,entry},1000);return ref;},ctx);
 let s=(await snapshotSpace(host,sid,ctx))!;const page=snapshotPage(host,s,1000,null,{maxBytes:350},principalId(q));assert.ok(page.next);
 await assert.rejects(admin.execute('deny','purgeTasks',sid,'admin',{type:'Task'}),core.PermissionError);authorized=true;
 const res=await admin.execute('erase','deletePrincipal',sid,'admin',p);assert.equal(res.count,2);
 s=(await snapshotSpace(host,sid,ctx))!;assert.equal(JSON.stringify(s).includes('personal'),false);assert.equal(Object.keys(s.rpc!.claims).length,0);assert.equal(Object.keys(s.rpc!.generations).length,0);assert.equal(s.mailboxes!.boxes[principalId(p)],undefined);assert.ok(s.mailboxes!.boxes[principalId(q)]!.gap);
 assert.throws(()=>claims.admit(s,1002,ref,'write',{entry:'secret'},2000),claims.RequestExpired);
 assert.throws(()=>snapshotPage(host,s,1002,null,{after:page.next},principalId(q)),core.SnapshotExpired);
 assert.deepEqual(await admin.execute('erase','deletePrincipal',sid,'admin',p),res);
 await assert.rejects(admin.execute('erase','deletePrincipal',sid,'admin',q),/changed/);
 await host.commit(async tx=>core.write(await spaceDoc(tx,sid,1003),1003,{type:'Task',fields:{n:3}},null,core.FOREVER),ctx);
 assert.equal((await admin.execute('purge','purgeTasks',sid,'admin',{type:'Task'})).count,1);
 }finally{await home.dispose();}
});

for(const backend of BACKENDS)test(`${backend}: large deletion resumes bounded commits and excludes concurrent writers`,async(t)=>{
 const home=new PersistentHome(backend);try{
 let host=await home.open(),allowed=true;
 const sid=(await host.commit(tx=>createSpace(tx,'bulk',1000),ctx)).spaceId,p={peerId:'bulk-owner'},q={peerId:'unrelated'},owner=principalId(p);
 let generation='';
 await host.commit(async tx=>{generation=claims.issueGeneration(await spaceDoc(tx,sid,1000),1000,p).generation;},ctx);
 for(let start=0;start<240;start+=12)await host.commit(async tx=>{
  const s=await spaceDoc(tx,sid,1000);
  for(let n=start;n<start+12;n++){
   const entry=core.write(s,1000,{type:'Private',fields:{n,secret:'erase-me-'+('x'.repeat(2048))}},null,core.FOREVER,owner);
   const ref={principal:p,generation,requestId:'private-'+n},a=claims.admit(s,1000,ref,'write',{n},2000,4096);
   claims.decide(s,1000,a.key,{state:'done',result:core.list(s,1000,{id:entry.id})[0] as any});
  }
 },ctx);
 await host.commit(async tx=>{const s=await spaceDoc(tx,sid,1000);core.write(s,1000,{type:'Keep',fields:{value:'unrelated'}},null,core.FOREVER,principalId(q));core.setLimits(s,{maxCommitBytes:4096},1000);},ctx);
 const make=()=>new DataAdminController({host,ctx,assertAuthority:async()=>{},authorize:async()=>{if(!allowed)throw new core.PermissionError('scope revoked');},now:()=>1001});let admin=make();
 await admin.startDeletion('bulk-delete',sid,'admin',p);
 let state=(await snapshotSpace(host,sid,ctx))!;assert.ok(state.adminMaintenance);
 assert.throws(()=>core.write(core.plain(state),1001,{type:'Race',fields:{}},null,10000,principalId(q)),/administrative deletion/);
 assert.throws(()=>core.createTxn(core.plain(state),1001,1000),core.PermissionError);
 assert.throws(()=>claims.issueGeneration(core.plain(state),1001,p),core.PermissionError);
 assert.throws(()=>core.list(state,1001),core.PermissionError);
 const sizes:number[]=[];
 home.faults.arm('loseAnswer',writes=>{const deltas=writes.filter(w=>w.type==='document.change'&&w.content.kind==='delta');if(deltas.length)sizes.push(Buffer.byteLength(JSON.stringify(deltas)));return false;});
 let result=await admin.advanceDeletion('bulk-delete',sid,'admin',p);
 assert.notEqual(result.phase,'completed');allowed=false;await assert.rejects(admin.advanceDeletion('bulk-delete',sid,'admin',p),core.PermissionError);allowed=true;
 home.faults.disarm();home.crash(host);host=await home.open();admin=make();
 home.faults.arm('loseAnswer',writes=>{const deltas=writes.filter(w=>w.type==='document.change'&&w.content.kind==='delta');if(deltas.length)sizes.push(Buffer.byteLength(JSON.stringify(deltas)));return false;});
 while(result.phase!=='completed')result=await admin.advanceDeletion('bulk-delete',sid,'admin',p);
 home.faults.disarm();assert.equal(result.count,240);assert.ok(result.batches>30);assert.ok(sizes.length>30);assert.ok(Math.max(...sizes)<=4096,'persisted mutation deltas exceed the configured budget');t.diagnostic(`batches=${result.batches}; maxPersistedMutationDeltaBytes=${Math.max(...sizes)}; budget=4096`);
 state=(await snapshotSpace(host,sid,ctx))!;assert.equal(state.adminMaintenance,undefined);assert.equal(core.list(state,1001).length,1);assert.equal(core.list(state,1001)[0]!.type,'Keep');assert.equal(JSON.stringify(state).includes('erase-me'),false);
 assert.throws(()=>claims.admit(core.plain(state),1001,{principal:p,generation,requestId:'private-0'},'write',{n:0},2000),claims.RequestExpired);
 assert.equal((await admin.execute('bulk-delete','deletePrincipal',sid,'admin',p)).count,240);
 await host.commit(async tx=>core.write(await spaceDoc(tx,sid,1002),1002,{type:'After',fields:{}},null,core.FOREVER,principalId(q)),ctx);
 }finally{await home.dispose();}
});

for(const backend of BACKENDS)for(const fault of ['failBeforeCommit','loseAnswer'] as const)for(const stage of ['registrations','mailboxes','claims','generations','entries','history'] as const)
 test(`${backend}: deletion ${fault} at ${stage} resumes without replay or premature admission`,async()=>{
 const home=new PersistentHome(backend);try{
 let host=await home.open();const sid=(await host.commit(tx=>createSpace(tx,'fault',1000),ctx)).spaceId,p={peerId:'victim'};
 await host.commit(async tx=>{const s=await spaceDoc(tx,sid,1000);core.write(s,1000,{type:'Secret',fields:{private:true}},null,core.FOREVER,principalId(p));},ctx);
 const make=()=>new DataAdminController({host,ctx,assertAuthority:async()=>{},authorize:async()=>{},now:()=>1001});let admin=make();
 let result=await admin.startDeletion('crash-delete',sid,'admin',p);
 while(result.phase!==stage)result=await admin.advanceDeletion('crash-delete',sid,'admin',p);
 home.faults.arm(fault);await assert.rejects(admin.advanceDeletion('crash-delete',sid,'admin',p),/injected/);assert.equal(home.faults.fired,1);
 home.crash(host);host=await home.open();admin=make();
 const completed=await admin.execute('crash-delete','deletePrincipal',sid,'admin',p);assert.equal(completed.count,1);
 const state=(await snapshotSpace(host,sid,ctx))!;assert.equal(state.entries.length,0);assert.equal(state.adminMaintenance,undefined);
 assert.deepEqual(await admin.execute('crash-delete','deletePrincipal',sid,'admin',p),completed);
 }finally{await home.dispose();}
});

for(const backend of BACKENDS)test(`${backend}: restore tuple and conflicting admin command keep an incomplete deletion fenced`,async()=>{
 const home=new PersistentHome(backend);try{
 const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'tuple',1000),ctx)).spaceId,p={peerId:'owner'};
 await host.commit(async tx=>core.write(await spaceDoc(tx,sid,1000),1000,{type:'Secret',fields:{private:true}},null,core.FOREVER,principalId(p)),ctx);
 const admin=new DataAdminController({host,ctx,assertAuthority:async()=>{},authorize:async()=>{},now:()=>1001});
 await admin.startDeletion('tuple-delete',sid,'admin',p);
 await assert.rejects(admin.startDeletion('other-delete',sid,'admin',p),core.PermissionError);
 await assert.rejects(admin.startDeletion('tuple-delete',sid,'admin',{peerId:'another'}),/changed/);
 await host.commit(async tx=>{(await spaceDoc(tx,sid,1001)).acceptedAuthorityId='replacement-authority';},ctx);
 await assert.rejects(admin.advanceDeletion('tuple-delete',sid,'admin',p),/restore review/);
 const state=(await snapshotSpace(host,sid,ctx))!;assert.ok(state.adminMaintenance);assert.equal(state.entries.length,1);
 }finally{await home.dispose();}
});

for(const backend of BACKENDS)test(`${backend}: completed deletion never reports fresh success for restored data`,async()=>{
 const home=new PersistentHome(backend);try{
 const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'replay',1000),ctx)).spaceId,p={peerId:'owner'};
 const admin=new DataAdminController({host,ctx,assertAuthority:async()=>{},authorize:async()=>{},now:()=>1001});
 await admin.execute('old-delete','deletePrincipal',sid,'admin',p);
 await host.commit(async tx=>{const s=await spaceDoc(tx,sid,1001);s.incarnation='restored-data';core.write(s,1001,{type:'Restored',fields:{private:true}},null,core.FOREVER,principalId(p));},ctx);
 await assert.rejects(admin.execute('old-delete','deletePrincipal',sid,'admin',p),/restore review/);
 assert.equal((await snapshotSpace(host,sid,ctx))!.entries.length,1);
 assert.equal((await admin.execute('new-delete','deletePrincipal',sid,'admin',p)).count,1);
 }finally{await home.dispose();}
});

for(const backend of BACKENDS)test(`${backend}: scope revoked at the final decision check rolls back a deletion batch`,async()=>{
 const home=new PersistentHome(backend);try{
 const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'scope',1000),ctx)).spaceId,p={peerId:'owner'};
 await host.commit(async tx=>core.write(await spaceDoc(tx,sid,1000),1000,{type:'Secret',fields:{private:true}},null,core.FOREVER,principalId(p)),ctx);
 let calls=0,denyAt=Infinity;const admin=new DataAdminController({host,ctx,assertAuthority:async()=>{},authorize:async()=>{if(++calls===denyAt)throw new core.PermissionError('scope revoked before commit');},now:()=>1001});
 calls=0;denyAt=3;await assert.rejects(admin.startDeletion('scope-delete',sid,'admin',p),core.PermissionError);
 assert.equal((await snapshotSpace(host,sid,ctx))!.adminMaintenance,undefined);
 denyAt=Infinity;let result=await admin.startDeletion('scope-delete',sid,'admin',p);
 while(result.phase!=='entries')result=await admin.advanceDeletion('scope-delete',sid,'admin',p);
 calls=0;denyAt=3;await assert.rejects(admin.advanceDeletion('scope-delete',sid,'admin',p),core.PermissionError);
 const state=(await snapshotSpace(host,sid,ctx))!;assert.equal(state.entries.length,1);assert.ok(state.adminMaintenance);
 denyAt=Infinity;assert.equal((await admin.execute('scope-delete','deletePrincipal',sid,'admin',p)).count,1);
 }finally{await home.dispose();}
});

for(const backend of BACKENDS)test(`${backend}: admin commands reject alias targets and oversized audit actors without a fence`,async()=>{
 const home=new PersistentHome(backend);try{
 const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'alias',1000),ctx)).spaceId,p={peerId:'owner'};
 const admin=new DataAdminController({host,ctx,assertAuthority:async()=>{},authorize:async()=>{},now:()=>1001});
 await assert.rejects(admin.startDeletion('alias-delete','alias','admin',p),/immutable Space ID/);
 await assert.rejects(admin.startDeletion('long-actor',sid,'x'.repeat(1025),p),core.IllegalArgumentError);
 assert.equal((await snapshotSpace(host,sid,ctx))!.adminMaintenance,undefined);
 }finally{await home.dispose();}
});
