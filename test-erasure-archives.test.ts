import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,unlinkSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ErasureArchiveController} from './src/erasure-archives.ts';
import {checkErasureBarrier} from './src/erasure-barrier.ts';
import {SqliteRecoveryRegister} from './src/recovery-register.ts';
import {installBootGuard,BootBlocked} from './src/boot.ts';
import {createSpace,spaceDoc} from './src/spaces.ts';
import {PiSpaces} from './src/client.ts';
import {BACKENDS,PersistentHome,ctx} from './test/support/persistent.ts';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
for(const backend of BACKENDS)test(`${backend}: independent deletion floor blocks stale restores, raced commits and overdue archives across reopen`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-erasure-policy-')),home=new PersistentHome(backend);let external=new SqliteRecoveryRegister(join(dir,'external.sqlite'));const installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));let stop:(()=>void)|undefined;
 try{
  let host=await home.open(),now=1000,deleted=false,allowed=true;const info=await host.commit(tx=>createSpace(tx,'jobs',1000),ctx),key='erasure:'+info.spaceId,backup=join(dir,'owned-backup.json');writeFileSync(backup,'subject-content',{mode:0o600});const artifact={id:'owned-backup',sha256:sha(readFileSync(backup)),epoch:0,kind:'backup' as const};
  const make=()=>new ErasureArchiveController({register:external,authorize:async()=>{if(!allowed)throw Error('operator permission revoked');},verifyDeletion:async()=>{if(!deleted)throw Error('local deletion receipt missing');},destroy:async a=>{assert.equal(a.id,'owned-backup');if(existsSync(backup)){assert.equal(sha(readFileSync(backup)),a.sha256);unlinkSync(backup);}},now:()=>now});
  await make().registerArchive(info.spaceId,artifact);await make().registerArchive(info.spaceId,artifact);assert.equal((await make().assertRestore(info.spaceId,'owned-backup')).sha256,artifact.sha256);
  const p={state:'active',authorityId:'authority',dataIncarnation:info.incarnation,role:'local',transitionId:'owned-fixture'};await installed.compareAndSet('installed:host:'+info.spaceId,null,p);await external.compareAndSet('boot:host',null,{hostId:'host',state:'active',spaces:{[info.spaceId]:p}});stop=installBootGuard(host,ctx,{hostId:'host',authorityId:'authority',external,installed,now:()=>now});const client=()=>new PiSpaces(host,ctx,()=>now,undefined,undefined,{space:info.spaceId});await client().write({type:'Kept',fields:{}});
  await assert.rejects(host.commit(async tx=>{const s=await spaceDoc(tx,info.spaceId,now);s.entries[0]!.fields.race='must-roll-back';await make().begin(info.spaceId,sha('erase'),500);},ctx),/erasure barrier changed/);await assert.rejects(client().count(),BootBlocked);await assert.rejects(make().assertRestore(info.spaceId,'owned-backup'),/restore is blocked/);await make().quarantine(info.spaceId,sha('erase'));await assert.rejects(make().seal(info.spaceId,sha('erase'),1),/receipt missing/);
  stop();stop=undefined;await host.commit(async tx=>{const s=await spaceDoc(tx,info.spaceId,now);assert.equal(s.entries[0]!.fields.race,undefined);s.erasureEpoch=1;},ctx);deleted=true;const oldLocal=(await installed.get<any>('installed:host:'+info.spaceId))!;await installed.compareAndSet('installed:host:'+info.spaceId,oldLocal.version,{...p,erasureEpoch:1});const boot=(await external.get<any>('boot:host'))!;boot.value.spaces[info.spaceId].erasureEpoch=1;await external.compareAndSet('boot:host',boot.version,boot.value);await make().seal(info.spaceId,sha('erase'),1);
  await assert.rejects(checkErasureBarrier(external,info.spaceId,{entries:[],erasureEpoch:0} as any,now),/current epoch/);assert.equal(((await checkErasureBarrier(external,info.spaceId,{erasureEpoch:1} as any,now))??0)>0,true);
  external.close();external=new SqliteRecoveryRegister(join(dir,'external.sqlite'));await home.close(host);host=await home.open();stop=installBootGuard(host,ctx,{hostId:'host',authorityId:'authority',external,installed,now:()=>now});assert.equal(await client().count(),1);
  now=1500;await assert.rejects(checkErasureBarrier(external,info.spaceId,{erasureEpoch:1} as any,now),/deadline expired/);assert.ok(existsSync(backup));allowed=false;await assert.rejects(make().destroyDue(info.spaceId,sha('erase')),/permission revoked/);assert.ok(existsSync(backup));allowed=true;await make().destroyDue(info.spaceId,sha('erase'));assert.ok(!existsSync(backup));await make().seal(info.spaceId,sha('erase'),1);assert.equal(await client().count(),1);await assert.rejects(make().assertRestore(info.spaceId,'owned-backup'),/restore is blocked/);
 }finally{stop?.();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});
