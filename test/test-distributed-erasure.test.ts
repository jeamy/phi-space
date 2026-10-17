import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteRecoveryRegister,type RecoveryRegister} from '../src/recovery-register.ts';
import {ErasureArchiveController} from '../src/erasure-archives.ts';
import {DistributedPrincipalErasure,type DistributedErasurePlan,type DistributedErasureDriver} from '../src/distributed-erasure.ts';
for(const lostAnswer of [false,true])test(`distributed erasure reopens after every coordinator ${lostAnswer?'lost answer':'pre-commit failure'} with all targets fenced until archives and receipts complete`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'pi-distributed-erasure-')),path=join(home,'independent.sqlite');let db=new SqliteRecoveryRegister(path),fail=false,allowed=true,fenced=false,releases=0;
 const plan:DistributedErasurePlan={id:'erase-1',principal:{peerId:'subject',agentId:'private-agent'},retentionMs:86400000,participants:['root','a','b'].map(id=>({hostId:id,spaceId:'space-'+id,authorityId:'authority',dataIncarnation:'inc-'+id,primaryEpoch:1,...(id==='root'?{root:true}:{})}))};
 const deleted=new Set<string>(),stamped=new Set<string>(),events:string[]=[],evidence=new Set<string>();let erasedRoot=false;
 const register:RecoveryRegister={get:key=>db.get(key),compareAndSet:async(key,version,value)=>{if(fail&&key.startsWith('erasure-command:')){fail=false;if(lostAnswer)await db.compareAndSet(key,version,value);throw Error('coordinator interrupted');}return db.compareAndSet(key,version,value);}};
 const authorize=async()=>{if(!allowed)throw Error('permission revoked');};
 const archives=()=>new ErasureArchiveController({register,authorize,destroy:async a=>{const p=join(home,a.id);if(existsSync(p))unlinkSync(p);},verifyDeletion:async sid=>{assert.ok(deleted.has(sid));assert.ok(stamped.has(sid));assert.ok(erasedRoot);}});
 const driver:DistributedErasureDriver={fence:async()=>{fenced=true;},assertFenced:async()=>{assert.ok(fenced);},evidence:async t=>{assert.equal(deleted.size,0,'collect all evidence before first deletion');evidence.add(t.spaceId);return['entry-'+t.spaceId];},eraseLocal:async t=>{assert.equal(evidence.size,3);for(const target of plan.participants)assert.equal((await db.get<any>('erasure:'+target.spaceId))?.value.state,'pending');deleted.add(t.spaceId);events.push('local');},eraseRoot:async(_,__,ids)=>{assert.equal(deleted.size,3);assert.equal(ids.length,3);erasedRoot=true;},stamp:async t=>{assert.ok(erasedRoot);stamped.add(t.spaceId);},release:async()=>{for(const t of plan.participants){assert.equal((await db.get<any>('erasure:'+t.spaceId))?.value.state,'sealed');assert.ok(!existsSync(join(home,t.spaceId)));}releases++;fenced=false;events.push('release');}};
 const controller=()=>new DistributedPrincipalErasure({register,archives:archives(),driver,authorize});
 try{
  for(const t of plan.participants){writeFileSync(join(home,t.spaceId),'old subject content');await archives().registerArchive(t.spaceId,{id:t.spaceId,sha256:'a'.repeat(64),epoch:0,kind:'backend-history'});}
  let result=await controller().advance(plan),steps=0;
  while(result.phase!=='completed'){
   if(result.phase==='releasing')break;
   fail=true;await assert.rejects(controller().advance(plan),/coordinator interrupted/);db.close();db=new SqliteRecoveryRegister(path);
   result=await controller().advance(plan);assert.ok(++steps<40);
  }
  allowed=false;await assert.rejects(controller().advance(plan),/permission revoked/);assert.equal(releases,0);allowed=true;
  result=await controller().execute(plan);assert.equal(result.phase,'completed');assert.deepEqual(result.entryIds,[]);assert.equal(events.at(-1),'release');assert.equal(releases,1);
  await controller().execute(plan);assert.equal(releases,1);await assert.rejects(controller().advance({...plan,principal:{peerId:'other'}}),/changed binding/);
  for(const t of plan.participants){assert.equal((await db.get<any>('erasure:'+t.spaceId))?.value.epoch,1);await assert.rejects(archives().assertRestore(t.spaceId,t.spaceId),/restore is blocked/);}
  assert.ok(!JSON.stringify((await db.get<any>('erasure-command:'+plan.id))!.value).includes('private-agent'));
 }finally{db.close();rmSync(home,{recursive:true,force:true});}
});
