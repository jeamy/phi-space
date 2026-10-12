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
