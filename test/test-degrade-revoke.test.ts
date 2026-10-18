// degradeToSingle against a standby without a fencing adapter (v3 5.3.1 step 2, decided 2026-10-17): only the
// standby permit of this Space is revoked; the host and its other Spaces stay; setStandby can bring it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {PiSpaces,PrimarySyncJournal,primarySyncStorage,recoverPrimarySync,assertSyncPrimary,assertSyncStandby,assertQuarantine,degradeToSingle,promote,setStandby,SimulatorFencing,core,type PrimarySyncConfig,type PrimarySyncPeer} from '../src/index.ts';
import {SqliteRecoveryRegister} from '../src/recovery-register.ts';
import {revokeSpacePermit} from '../src/replica-control.ts';
import {BACKENDS,PersistentHome,ctx} from './support/persistent.ts';

const config:PrimarySyncConfig={spaceId:'sync-space',authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s'};
const permit=(role:'primary'|'standby'|'local')=>({state:'active',authorityId:config.authorityId,dataIncarnation:'inc',role,...(role==='local'?{}:{primaryEpoch:1,replicaConfigVersion:1,durability:'sync'}),transitionId:'genesis'});

for(const backend of BACKENDS)test(`${backend}: degradeToSingle without a fencing adapter revokes only the standby's permit for this Space; setStandby brings the active host back`,async()=>{
 const pHome=new PersistentHome(backend),sHome=new PersistentHome(backend),register=new SqliteRecoveryRegister(join(pHome.dir,'register.sqlite'));
 await register.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{[config.spaceId]:permit('primary')}});
 await register.compareAndSet('boot:s',null,{hostId:'s',state:'active',spaces:{[config.spaceId]:permit('standby'),'other-space':permit('local')}});
 const pJournal=new PrimarySyncJournal(join(pHome.dir,'journal.sqlite'),config);
 let sJournal=new PrimarySyncJournal(join(sHome.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(register,'s')});
 let partitioned=false;const peer:PrimarySyncPeer={accept:async i=>{if(partitioned)throw Error('standby unreachable');return sJournal.accept(i);}};
 try{
  let raw=await pHome.storage();await recoverPrimarySync(raw,pJournal,peer,ctx,assertSyncPrimary(register,'p',pJournal));
  let h=await pHome.open();await h.close(ctx);// (default Space exists)
  const ph=await (await import('@earendil-works/pi-durable')).Harness.open(primarySyncStorage(raw,pJournal,peer,{assertPrimary:assertSyncPrimary(register,'p',pJournal)}),{models:(await import('@earendil-works/pi-ai/models')).createModels(),registry:(await import('@earendil-works/pi-durable')).createRegistry()},ctx);
  await new PiSpaces(ph,ctx).write({type:'Work',fields:{n:1}},null,core.FOREVER);
  partitioned=true;await assert.rejects(new PiSpaces(ph,ctx).write({type:'Work',fields:{n:2}},null,core.FOREVER),/sealed/);
  await ph.close(ctx).catch(()=>{});
  // Both parameters or neither: refused.
  raw=await pHome.storage();
  const base={storage:raw,journal:pJournal,register,hostId:'p',dataIncarnation:'inc',ctx,expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1};
  await assert.rejects(degradeToSingle({...base,recoveryId:'d0'} as any),/fencing proof of the standby or revokeStandbySpace/);
  const sim=new SimulatorFencing();
  await assert.rejects(degradeToSingle({...base,recoveryId:'d0',revokeStandbySpace:true,adapter:sim,proof:await sim.fence('s','x')} as any),/fencing proof of the standby or revokeStandbySpace/);
  const done=await degradeToSingle({...base,recoveryId:'degrade-1',revokeStandbySpace:true});
  assert.deepEqual([done.config.durability,done.config.standbyReplica,done.config.primaryEpoch],['single',null,2]);
  assert.deepEqual(done.recoveredCommitted,[pJournal.head().revision-1],'the sealed candidate was completed locally');
  assert.deepEqual(await degradeToSingle({...base,recoveryId:'degrade-1',revokeStandbySpace:true}),done,'repeatable');
  await raw.close(ctx);
  const s=(await register.get<any>('boot:s'))!.value;
  assert.equal(s.state,'active','the standby host stays active');
  assert.equal(s.spaces[config.spaceId].state,'revoked');assert.equal(s.spaces['other-space'].state,'active','its other Spaces stay');
  // The excluded standby accepts nothing for this Space and cannot be promoted.
  partitioned=false;
  await assert.rejects(sJournal.accept(pJournal.intent(pJournal.head().revision-1)!),/permit/,'the candidate it never received is refused');
  const sStore=await sHome.storage();
  await assert.rejects(promote({storage:sStore,journal:sJournal,register,hostId:'s',dataIncarnation:'inc',ctx,recoveryId:'promote-s',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof:await sim.fence('p','x'),allowSimulator:true}),/permit/);
  await sStore.close(ctx);
  // The work goes on as single.
  raw=await pHome.storage();await recoverPrimarySync(raw,pJournal,null,ctx,assertSyncPrimary(register,'p',pJournal));
  const single=await (await import('@earendil-works/pi-durable')).Harness.open(primarySyncStorage(raw,pJournal,null,{assertPrimary:assertSyncPrimary(register,'p',pJournal)}),{models:(await import('@earendil-works/pi-ai/models')).createModels(),registry:(await import('@earendil-works/pi-durable')).createRegistry()},ctx);
  await new PiSpaces(single,ctx).write({type:'Work',fields:{n:3}},null,core.FOREVER);
  assert.equal(await new PiSpaces(single,ctx).count({type:'Work'}),3);
  await single.close(ctx);
  // Back as standby: the active host with the revoked permit is a setStandby target once its replica is emptied.
  sJournal.close();const fresh=join(sHome.dir,'journal-2.sqlite');sJournal=new PrimarySyncJournal(fresh,config,{self:'s',assertStandby:assertSyncStandby(register,'s')});
  await assert.rejects(assertQuarantine(register,'s')(),/quarantine/,'without the Space it is no target');
  await assertQuarantine(register,'s',config.spaceId)();
  raw=await pHome.storage();
  const target={hostId:'s',head:async()=>sJournal.head(),catchUp:(i:any)=>sJournal.catchUp(i,assertQuarantine(register,'s',config.spaceId)),accept:(i:any)=>sJournal.accept(i)};
  const back=await setStandby({storage:raw,journal:pJournal,register,hostId:'p',dataIncarnation:'inc',ctx,transitionId:'standby-again',target,targetDataIncarnation:'inc'});
  await raw.close(ctx);
  assert.deepEqual([back.config.durability,back.config.standbyReplica],['sync','s']);
  const s2=(await register.get<any>('boot:s'))!.value;
  assert.deepEqual([s2.state,s2.spaces[config.spaceId].state,s2.spaces[config.spaceId].role,s2.spaces['other-space'].state],['active','active','standby','active']);
  assert.deepEqual(sJournal.head(),pJournal.head(),'the standby holds the full history again');
  // revokeSpacePermit is idempotent and leaves the host state alone.
  await revokeSpacePermit(register,'s','other-space','t');await revokeSpacePermit(register,'s','other-space','t');
  assert.equal((await register.get<any>('boot:s'))!.value.state,'active');
  void h;
 }finally{pJournal.close();sJournal.close();register.close();await pHome.dispose();await sHome.dispose();}
});

test('the daemon path: an active standby with a revoked permit keeps serving its listener; after a wipe setStandby catches it up over the signed transport',async()=>{
 const {mkdtempSync,rmSync,renameSync}=await import('node:fs'),{tmpdir}=await import('node:os');
 const {Harness,createRegistry}=await import('@earendil-works/pi-durable'),{openNodeSqliteStorage}=await import('@earendil-works/pi-durable/storage/sqlite/node'),{createModels}=await import('@earendil-works/pi-ai/models');
 const {openSyncSpace,provisionFileSigner,signedReplicaPeer,socketTransport}=await import('../src/index.ts');
 const dir=mkdtempSync(join(tmpdir(),'degrade-revoke-')),reg=new SqliteRecoveryRegister(join(dir,'external.sqlite')),port=17571;
 const keys={p:provisionFileSigner(join(dir,'p.json')),s:provisionFileSigner(join(dir,'s.json'))},ip={p:'127.0.0.2',s:'127.0.0.3'};
 const spaceId='sp-0c7e6f1a-1111-4222-8333-944445555999',incarnation='0a1b2c3f',authorityId='authority';
 const genesis:PrimarySyncConfig={spaceId,authorityId,primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s',durability:'sync'};
 const sp=(role:'primary'|'standby')=>({state:'active',authorityId,dataIncarnation:incarnation,role,primaryEpoch:1,replicaConfigVersion:1,durability:'sync',transitionId:'provisioned'});
 await reg.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{[spaceId]:sp('primary')}});
 await reg.compareAndSet('boot:s',null,{hostId:'s',state:'active',spaces:{[spaceId]:sp('standby'),'other-space':permit('local')}});
 const installed={p:new SqliteRecoveryRegister(join(dir,'installed-p.sqlite')),s:new SqliteRecoveryRegister(join(dir,'installed-s.sqlite'))};
 const syncDir=(h:'p'|'s')=>join(dir,h,'sync'),other=(h:'p'|'s')=>h==='p'?'s':'p';
 const peerOf=(h:'p'|'s')=>({hostId:h,algorithm:'ed25519' as const,publicKey:keys[h].publicKey,ip:ip[h]});
 const open=(h:'p'|'s')=>openSyncSpace({config:{alias:'jobs-sync',spaceId,incarnation,dir:syncDir(h),genesis,port,peers:[peerOf(other(h))]},
  hostId:h,authorityId,bindIp:ip[h],signer:keys[h],external:reg,installed:installed[h],ctx,
  openStorage:async path=>openNodeSqliteStorage(path),openHarness:async st=>Harness.open(st,{models:createModels(),registry:createRegistry()},ctx)});
 const jobs=(h:any)=>new PiSpaces(h,ctx,Date.now,undefined,undefined,{space:'jobs-sync'});
 // Tool steps run with the daemon stopped, on the store files.
 const offline=async<T>(h:'p'|'s',f:(o:{storage:any;journal:PrimarySyncJournal})=>Promise<T>)=>{const journal=new PrimarySyncJournal(join(syncDir(h),'journal.sqlite'),genesis,{self:h,assertStandby:assertSyncStandby(reg,h)}),storage=await openNodeSqliteStorage(join(syncDir(h),'harness.sqlite'));try{return await f({storage,journal});}finally{await storage.close(ctx);journal.close();}};
 let p:any,s:any;
 try{
  s=await open('s');p=await open('p');
  await jobs(p.harness).write({type:'Job',fields:{n:1}},null,core.FOREVER);
  await s.close();s=undefined;await p.close();p=undefined;// the standby is lost; the primary's daemon stops for the tool
  const done=await offline('p',o=>degradeToSingle({...o,register:reg,hostId:'p',dataIncarnation:incarnation,ctx,recoveryId:'degrade-revoke',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,revokeStandbySpace:true}));
  assert.equal(done.config.durability,'single');
  const sBoot=(await reg.get<any>('boot:s'))!.value;assert.deepEqual([sBoot.state,sBoot.spaces[spaceId].state,sBoot.spaces['other-space'].state],['active','revoked','active']);
  // The excluded standby's old history is set aside; its normal daemon then opens the Space as a listener only.
  renameSync(syncDir('s'),syncDir('s')+'.aside');
  s=await open('s');assert.equal(s.harness,undefined,'not served');assert.equal(s.journal.head().revision,0);
  p=await open('p');await jobs(p.harness).write({type:'Job',fields:{n:2}},null,core.FOREVER);await p.close();p=undefined;
  // set-standby from the primary over the signed transport to the running standby daemon.
  const t=socketTransport({host:ip.s,port},{localAddress:ip.p,connectTimeoutMs:8000,maxFrameBytes:1<<20});
  try{
   const back=await offline('p',o=>setStandby({...o,register:reg,hostId:'p',dataIncarnation:incarnation,ctx,transitionId:'standby-back',target:signedReplicaPeer({transport:t,signer:keys.p,self:'p',remote:peerOf('s')}),targetDataIncarnation:incarnation}));
   assert.deepEqual([back.config.durability,back.config.standbyReplica],['sync','s']);
  }finally{t.close();}
  assert.equal((await reg.get<any>('boot:s'))!.value.spaces[spaceId].state,'active');
  // Sync again: the next write is confirmed by the same standby daemon, which holds the whole history.
  p=await open('p');await jobs(p.harness).write({type:'Job',fields:{n:3}},null,core.FOREVER);
  assert.deepEqual(s.journal.head(),p.journal.head());assert.equal(await jobs(p.harness).count({type:'Job'}),3);
 }finally{await p?.close().catch(()=>{});await s?.close().catch(()=>{});reg.close();installed.p.close();installed.s.close();rmSync(dir,{recursive:true,force:true});}
});
