import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,existsSync,unlinkSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ErasureArchiveController} from '../src/erasure-archives.ts';
import {checkErasureBarrier} from '../src/erasure-barrier.ts';
import {RegisterConflict,SqliteRecoveryRegister} from '../src/recovery-register.ts';
import {installBootGuard,BootBlocked} from '../src/boot.ts';
import {createSpace,spaceDoc} from '../src/spaces.ts';
import {PhiSpaces} from '../src/client.ts';
import {BACKENDS,PersistentHome,ctx} from './support/persistent.ts';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
for(const backend of BACKENDS)test(`${backend}: independent deletion floor blocks stale restores, raced commits and overdue archives across reopen`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-erasure-policy-')),home=new PersistentHome(backend);let external=new SqliteRecoveryRegister(join(dir,'external.sqlite'));const installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));let stop:(()=>void)|undefined;
 try{
  let host=await home.open(),now=1000,deleted=false,allowed=true;const info=await host.commit(tx=>createSpace(tx,'jobs',1000),ctx),key='erasure:'+info.spaceId,backup=join(dir,'owned-backup.json');writeFileSync(backup,'subject-content',{mode:0o600});const artifact={id:'owned-backup',sha256:sha(readFileSync(backup)),epoch:0,kind:'backup' as const};
  const make=()=>new ErasureArchiveController({register:external,authorize:async()=>{if(!allowed)throw Error('operator permission revoked');},verifyDeletion:async()=>{if(!deleted)throw Error('local deletion receipt missing');},destroy:async a=>{assert.equal(a.id,'owned-backup');if(existsSync(backup)){assert.equal(sha(readFileSync(backup)),a.sha256);unlinkSync(backup);}},now:()=>now});
  await make().registerArchive(info.spaceId,artifact);await make().registerArchive(info.spaceId,artifact);assert.equal((await make().assertRestore(info.spaceId,'owned-backup')).sha256,artifact.sha256);
  const p={state:'active',authorityId:'authority',dataIncarnation:info.incarnation,role:'local',transitionId:'owned-fixture'};await installed.compareAndSet('installed:host:'+info.spaceId,null,p);await external.compareAndSet('boot:host',null,{hostId:'host',state:'active',spaces:{[info.spaceId]:p}});stop=installBootGuard(host,ctx,{hostId:'host',authorityId:'authority',external,installed,now:()=>now});const client=()=>new PhiSpaces(host,ctx,()=>now,undefined,undefined,{space:info.spaceId});await client().write({type:'Kept',fields:{}});
  await assert.rejects(host.commit(async tx=>{const s=await spaceDoc(tx,info.spaceId,now);s.entries[0]={...s.entries[0]!,fields:{...s.entries[0]!.fields,race:'must-roll-back'}};await make().begin(info.spaceId,sha('erase'),500);},ctx),/erasure barrier changed/);await assert.rejects(client().count(),BootBlocked);await assert.rejects(make().assertRestore(info.spaceId,'owned-backup'),/restore is blocked/);await make().quarantine(info.spaceId,sha('erase'));await assert.rejects(make().seal(info.spaceId,sha('erase'),1),/receipt missing/);
  stop();stop=undefined;await host.commit(async tx=>{const s=await spaceDoc(tx,info.spaceId,now);assert.equal(s.entries[0]!.fields.race,undefined);s.erasureEpoch=1;},ctx);deleted=true;const oldLocal=(await installed.get<any>('installed:host:'+info.spaceId))!;await installed.compareAndSet('installed:host:'+info.spaceId,oldLocal.version,{...p,erasureEpoch:1});const boot=(await external.get<any>('boot:host'))!;boot.value.spaces[info.spaceId].erasureEpoch=1;await external.compareAndSet('boot:host',boot.version,boot.value);await make().seal(info.spaceId,sha('erase'),1);
  await assert.rejects(checkErasureBarrier(external,info.spaceId,{entries:[],erasureEpoch:0} as any,now),/current epoch/);assert.equal(((await checkErasureBarrier(external,info.spaceId,{erasureEpoch:1} as any,now))??0)>0,true);
  external.close();external=new SqliteRecoveryRegister(join(dir,'external.sqlite'));await home.close(host);host=await home.open();stop=installBootGuard(host,ctx,{hostId:'host',authorityId:'authority',external,installed,now:()=>now});assert.equal(await client().count(),1);
  now=1500;await assert.rejects(checkErasureBarrier(external,info.spaceId,{erasureEpoch:1} as any,now),/deadline expired/);assert.ok(existsSync(backup));allowed=false;await assert.rejects(make().destroyDue(info.spaceId,sha('erase')),/permission revoked/);assert.ok(existsSync(backup));allowed=true;await make().destroyDue(info.spaceId,sha('erase'));assert.ok(!existsSync(backup));await make().seal(info.spaceId,sha('erase'),1);assert.equal(await client().count(),1);await assert.rejects(make().assertRestore(info.spaceId,'owned-backup'),/restore is blocked/);
 }finally{stop?.();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('register prevents floor rollback and late archive admission across independent writers and reopen', async () => {
 const dir=mkdtempSync(join(tmpdir(),'pi-erasure-cas-')),path=join(dir,'register.sqlite');
 let db=new SqliteRecoveryRegister(path);const other=new SqliteRecoveryRegister(path);
 const key='erasure:jobs',archiveKey='erasure-archives:jobs';
 const artifact={id:'backup',sha256:sha('private'),epoch:0,kind:'backup',state:'retained'};
 const floor={spaceId:'jobs',epoch:1,state:'pending',commandHash:sha('erase'),archiveDeadline:1500,archivesPending:true};
 const denied=async(key:string,value:any)=>{
  const prior=await db.get<any>(key);
  await assert.rejects(db.compareAndSet(key,prior?.version??null,value),RegisterConflict);
  assert.deepEqual(await db.get(key),prior,'rejected update must not change version or value');
 };
 try {
  // A backup writer has read an empty floor and prepared a catalog, then pauses.
  await other.get(key);
  await db.compareAndSet(key,null,floor);
  await denied(key,{...floor,epoch:0});
  await denied(key,{...floor,epoch:2});
  await denied(key,{...floor,commandHash:sha('replacement')});
  await denied(key,{...floor,archiveDeadline:9999});
  await denied(key,{...floor,archivesPending:false});
  await db.compareAndSet(key,1,{...floor,state:'sealed',archivesPending:false});
  await assert.rejects(other.compareAndSet(archiveKey,null,{spaceId:'jobs',artifacts:[artifact]}),RegisterConflict);
  assert.equal(await db.get(archiveKey),null);
  await denied(key,{...floor,state:'pending'});
  await denied(key,{...floor,state:'sealed',archivesPending:true});
  await denied(key,{...floor,state:'sealed',archivesPending:false,commandHash:sha('replacement')});
  const currentArtifact={...artifact,epoch:1};
  await db.compareAndSet(archiveKey,null,{spaceId:'jobs',artifacts:[currentArtifact]});
  const second={...floor,epoch:2,commandHash:sha('erase-again'),archiveDeadline:2000};
  await db.compareAndSet(key,2,second);
  await denied(key,{...second,state:'sealed',archivesPending:false});
  const quarantined={...currentArtifact,state:'quarantined',deleteBefore:2000};
  await db.compareAndSet(archiveKey,1,{spaceId:'jobs',artifacts:[quarantined]});
  await db.compareAndSet(key,3,{...second,state:'sealed'});
  await denied(key,{...second,epoch:3,state:'pending',commandHash:sha('extend-deadline')});
  await denied(archiveKey,{spaceId:'jobs',artifacts:[currentArtifact]});
  await denied(archiveKey,{spaceId:'jobs',artifacts:[]});
  await denied(archiveKey,{spaceId:'jobs',artifacts:[{...quarantined,sha256:sha('changed')}]});
  await denied(archiveKey,{spaceId:'jobs',artifacts:[{...quarantined,deleteBefore:9999}]});
  await db.compareAndSet(archiveKey,2,{spaceId:'jobs',artifacts:[{...quarantined,state:'destroyed'}]});
  await denied(archiveKey,{spaceId:'jobs',artifacts:[quarantined]});
  await db.compareAndSet(key,4,{...second,state:'sealed',archivesPending:false});
  db.close();db=new SqliteRecoveryRegister(path);
  await denied(key,{...floor,state:'sealed',archivesPending:false});
  await db.compareAndSet(key,5,{...second,epoch:3,commandHash:sha('third'),state:'pending'});
 } finally {other.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

for (const backend of BACKENDS) test(`${backend}: legacy register keeps final boot fencing after deletion reads`, async () => {
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'pi-legacy-fence-'));
 const external=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));
 let stop:(()=>void)|undefined;
 try {
  const host=await home.open(),space=await host.commit(tx=>createSpace(tx,'jobs',1000),ctx);
  const permit={state:'active',authorityId:'authority',dataIncarnation:space.incarnation,role:'local',transitionId:'test'};
  await installed.compareAndSet('installed:host:'+space.spaceId,null,permit);
  await external.compareAndSet('boot:host',null,{hostId:'host',state:'active',spaces:{[space.spaceId]:permit}});
  let floors=0,armed=false;
  const legacy={compareAndSet:external.compareAndSet.bind(external),get:async<T extends import('../src/core.ts').Json>(key:string)=>{
   const value=await external.get<T>(key);
   if(armed&&key==='erasure:'+space.spaceId&&++floors===2){const boot=(await external.get<any>('boot:host'))!;await external.compareAndSet('boot:host',boot.version,{...boot.value,state:'fenced'});}
   return value;
  }};
  stop=installBootGuard(host,ctx,{hostId:'host',authorityId:'authority',external:legacy,installed});
  armed=true;await assert.rejects(new PhiSpaces(host,ctx,()=>1000,undefined,undefined,{space:'jobs'}).write({type:'MustRollback',fields:{}}),BootBlocked);
  stop();stop=undefined;assert.equal(await new PhiSpaces(host,ctx,()=>1000,undefined,undefined,{space:'jobs'}).count(),0);
  const boot=(await external.get<any>('boot:host'))!;await external.compareAndSet('boot:host',boot.version,{...boot.value,state:'active'});floors=0;
  stop=installBootGuard(host,ctx,{hostId:'host',authorityId:'authority',external:legacy,installed});
  await assert.rejects(new PhiSpaces(host,ctx,()=>1000,undefined,undefined,{space:'jobs'}).count(),BootBlocked);
 } finally {stop?.();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});
