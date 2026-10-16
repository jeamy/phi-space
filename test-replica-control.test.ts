import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {FederationRouting,provisionFileSigner,replicaConfigNotice,signReplicaConfigNotice,adoptReplicaConfigNotice,startMaintenance,createSpace,installBootGuard,BootBlocked,readmitSpace,installAdmittedPermit,type SpaceBootPermit,PrimarySyncJournal,PrimarySyncBlocked,CommitSealed,primarySyncStorage,recoverPrimarySync,materializeSyncHistory,PiSpaces,Space,core,SqliteRecoveryRegister,SimulatorFencing,ReplicaTransitionBlocked,unconfiguredFencing,releaseHostToQuarantine,fenceHostBoot,assertSyncPrimary,assertSyncStandby,assertQuarantine,degradeToSingle,promote,setStandby,type PrimarySyncConfig,type PrimarySyncPeer,type RecoveryRegister,type StandbyTarget} from './src/index.ts';
import {BACKENDS,PersistentHome,ctx} from './test/support/persistent.ts';
const config:PrimarySyncConfig={spaceId:'sync-space',authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s'};
const permit=(c:PrimarySyncConfig,role:'primary'|'standby',inc:string)=>({state:'active',authorityId:c.authorityId,dataIncarnation:inc,role,primaryEpoch:c.primaryEpoch,replicaConfigVersion:c.replicaConfigVersion,durability:c.durability??'sync',transitionId:'genesis'});
/** Register wrapper that fails the next boot CAS for one host: the crash between a local transition and the external permit. */
class FlakyRegister implements RecoveryRegister{
 failNext:string|null=null;readonly inner:SqliteRecoveryRegister;constructor(inner:SqliteRecoveryRegister){this.inner=inner;}
 get<T extends import('./src/core.ts').Json>(k:string){return this.inner.get<T>(k);}
 async compareAndSet<T extends import('./src/core.ts').Json>(k:string,e:number|null,v:T){if(this.failNext===k){this.failNext=null;throw Error('crash before boot CAS');}return this.inner.compareAndSet(k,e,v);}
}
async function setup(backend:typeof BACKENDS[number]){
 const pHome=new PersistentHome(backend),sHome=new PersistentHome(backend),register=new FlakyRegister(new SqliteRecoveryRegister(join(pHome.dir,'register.sqlite')));
 await register.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{[config.spaceId]:permit(config,'primary','inc-p')}});
 await register.compareAndSet('boot:s',null,{hostId:'s',state:'active',spaces:{[config.spaceId]:permit(config,'standby','inc-s')}});
 const pJournal=new PrimarySyncJournal(join(pHome.dir,'journal.sqlite'),config);
 const sJournal=new PrimarySyncJournal(join(sHome.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(register,'s')});
 let partitioned=false;const peer:PrimarySyncPeer={accept:async i=>{if(partitioned)throw Error('standby unreachable');return sJournal.accept(i);}};
 const raw=pHome.storage.bind(pHome);
 pHome.storage=async()=>{const st=await raw();await recoverPrimarySync(st,pJournal,peer,ctx,assertSyncPrimary(register,'p',pJournal));return primarySyncStorage(st,pJournal,peer,{assertPrimary:assertSyncPrimary(register,'p',pJournal)});};
 const dispose=async()=>{pJournal.close();sJournal.close();await pHome.dispose();await sHome.dispose();};
 return {pHome,sHome,register,pJournal,sJournal,raw,partition:(v:boolean)=>{partitioned=v;},dispose};
}
const target=(hostId:string,journal:PrimarySyncJournal,register:RecoveryRegister):StandbyTarget=>({hostId,head:async()=>journal.head(),catchUp:i=>journal.catchUp(i,assertQuarantine(register,hostId)),accept:i=>journal.accept(i)});

for(const backend of BACKENDS){
 test(`${backend}: promotion and degradeToSingle refuse simulator claims and unconfigured provider adapters without changing state`,async()=>{
  const t=await setup(backend);
  try{
   const h=await t.pHome.open();await new PiSpaces(h,ctx).write({type:'Work',fields:{n:1}},null,core.FOREVER);await t.pHome.close(h);
   const sim=new SimulatorFencing(),proof=await sim.fence('p','primary lost'),sStorage=await t.sHome.storage(),head=t.sJournal.head();
   const base={storage:sStorage,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc-s',ctx,recoveryId:'promote-1',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1};
   // A refused transition stays open (and pauses business seals) until it is abandoned; it sealed nothing.
   const refused=async(id:string,run:Promise<unknown>,why:RegExp)=>{await assert.rejects(run,why);assert.deepEqual(t.sJournal.openTransitionIds(),[id]);t.sJournal.abandonTransition(id);assert.deepEqual(t.sJournal.openTransitionIds(),[]);};
   await refused('promote-1',promote({...base,adapter:sim,proof}),/simulator fencing claim is no evidence/);
   await refused('promote-2',promote({...base,recoveryId:'promote-2',adapter:unconfiguredFencing('cloud','netcup'),proof:{...proof,kind:'cloud'}}),/netcup fencing is not configured/);
   await refused('promote-3',promote({...base,recoveryId:'promote-3',adapter:sim,proof:{...proof,hostId:'s'},allowSimulator:true}),/no verified fencing proof for p/);
   await assert.rejects(promote({...base,adapter:sim,proof,allowSimulator:true}),/abandoned; use a new ID/);
   assert.deepEqual(t.sJournal.head(),head);assert.equal(t.sJournal.config.primaryReplica,'p');
   assert.equal((await t.register.get<any>('boot:p'))!.value.state,'active','no boot change without a verified proof');
   // A transition ID is bound to its arguments.
   await assert.rejects(promote({...base,expectedPrimaryEpoch:7,adapter:sim,proof,allowSimulator:true}),/used for another transition/);
   await sStorage.close(ctx);
  }finally{await t.dispose();}
 });

 test(`${backend}: degradeToSingle recovers the sealed candidate locally, survives a crash before the boot CAS and setStandby reinstalls an empty quarantined target`,async()=>{
  const t=await setup(backend);
  try{
   let h=await t.pHome.open();const client=()=>new PiSpaces(h,ctx);
   await client().write({type:'Work',fields:{n:1}},null,core.FOREVER);
   t.partition(true);await assert.rejects(client().write({type:'Work',fields:{n:2}},null,core.FOREVER),CommitSealed);
   const candidate=t.pJournal.head().revision;assert.equal(t.pJournal.appliedRevision,candidate-1);await t.pHome.close(h);
   // Without a fenced degradeToSingle the sync candidate cannot be resolved.
   await assert.rejects(t.pHome.open(),/standby unreachable/);
   const sim=new SimulatorFencing(),proof=await sim.fence('s','standby lost'),storage=await t.raw();
   t.register.failNext='boot:p';
   const o={storage,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc-p',ctx,recoveryId:'degrade-1',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true};
   await assert.rejects(degradeToSingle(o),/crash before boot CAS/);
   assert.deepEqual(t.pJournal.recoveredCommitted,[candidate]);assert.equal(t.pJournal.config.durability,'single');assert.equal(t.pJournal.config.primaryEpoch,2);
   const sBoot=(await t.register.get<any>('boot:s'))!.value;assert.equal(sBoot.state,'fenced');assert.equal(sBoot.spaces[config.spaceId].state,'revoked');
   // Local and external state disagree: writes stay blocked.
   await assert.rejects(assertSyncPrimary(t.register,'p',t.pJournal)(),PrimarySyncBlocked);
   await storage.close(ctx);await assert.rejects(t.pHome.open().then(x=>new PiSpaces(x,ctx).write({type:'Blocked',fields:{}})),/boot permit does not match/);
   const storage2=await t.raw(),done=await degradeToSingle({...o,storage:storage2});await storage2.close(ctx);
   assert.deepEqual(done.recoveredCommitted,[candidate]);assert.equal(done.config.standbyReplica,null);
   assert.equal((await t.register.get<any>('boot:p'))!.value.spaces[config.spaceId].replicaConfigVersion,2);
   h=await t.pHome.open();assert.equal(await client().count({type:'Work'}),2,'the recovered candidate is visible exactly once');
   await client().write({type:'Work',fields:{n:3}},null,core.FOREVER);
   assert.equal(t.pJournal.recoveredCommitted.length,1,'repeating the same recovery ID does not recover again');
   const again=await t.raw();await degradeToSingle({...o,storage:again});await again.close(ctx);assert.equal(t.pJournal.config.replicaConfigVersion,2);

   // A released standby with stale history must not promote itself: quarantine is no standby permit.
   await releaseHostToQuarantine(t.register,'s','rejoin-s',sim);assert.equal(await sim.verify(proof),false,'release lifts the simulated restart lock');
   const stale=await t.sHome.storage(),pProof=await sim.fence('p','primary lost later');
   await assert.rejects(promote({storage:stale,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc-s',ctx,recoveryId:'stale-promote',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof:pProof,allowSimulator:true}),/standby boot permit/);
   await stale.close(ctx);await sim.release('p');assert.equal(t.sJournal.config.primaryReplica,'p');
   // setStandby: the old standby journal is no empty target, a fresh quarantined replica is.
   await releaseHostToQuarantine(t.register,'s','rejoin-s');
   const fresh=new PersistentHome(backend),fJournal=new PrimarySyncJournal(join(fresh.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(t.register,'s')});
   try{
    await t.pHome.close(h);let st=await t.raw();
    await assert.rejects(setStandby({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc-p',ctx,transitionId:'standby-old',target:target('s',t.sJournal,t.register),targetDataIncarnation:'inc-s2'}),/empty target/);
    // A second transition cannot start while the refused one is open.
    await assert.rejects(setStandby({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc-p',ctx,transitionId:'standby-1',target:target('s',fJournal,t.register),targetDataIncarnation:'inc-s2'}),/standby-old is still open/);
    t.pJournal.abandonTransition('standby-old');
    const so={storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc-p',ctx,transitionId:'standby-1',target:target('s',fJournal,t.register),targetDataIncarnation:'inc-s2'};
    t.register.failNext='boot:s';await assert.rejects(setStandby(so),/crash before boot CAS/);
    assert.equal(t.pJournal.config.standbyReplica,'s');assert.equal((await t.register.get<any>('boot:s'))!.value.state,'quarantine');
    await st.close(ctx);st=await t.raw();const res=await setStandby({...so,storage:st});await st.close(ctx);
    assert.deepEqual({d:res.config.durability,v:res.config.replicaConfigVersion,e:res.config.primaryEpoch},{d:'sync',v:3,e:2});
    const sBoot2=(await t.register.get<any>('boot:s'))!.value;assert.equal(sBoot2.state,'active');assert.equal(sBoot2.spaces[config.spaceId].role,'standby');assert.equal(sBoot2.spaces[config.spaceId].dataIncarnation,'inc-s2');
    // Sync writes resume against the new standby; its materialized storage equals the primary.
    const raw=t.raw;t.pHome.storage=async()=>primarySyncStorage(await raw(),t.pJournal,fJournal,{assertPrimary:assertSyncPrimary(t.register,'p',t.pJournal)});
    h=await t.pHome.open();await client().write({type:'Work',fields:{n:4}},null,core.FOREVER);assert.equal(fJournal.head().hash,t.pJournal.head().hash);
    const fs=await fresh.storage();await materializeSyncHistory(fs,fJournal,ctx);await fs.close(ctx);const fh=await fresh.open();
    assert.deepEqual(await fh.snapshot(Space,ctx),await h.snapshot(Space,ctx));await fresh.close(fh);await t.pHome.close(h);
   }finally{fJournal.close();await fresh.dispose();}
  }finally{await t.dispose();}
 });

 test(`${backend}: promotion on the standby excludes the old primary's unaccepted candidate; the old primary is fenced and cannot rejoin with its fork`,async()=>{
  const t=await setup(backend);
  try{
   let h=await t.pHome.open();await new PiSpaces(h,ctx).write({type:'Work',fields:{n:1}},null,core.FOREVER);
   t.partition(true);await assert.rejects(new PiSpaces(h,ctx).write({type:'Fork',fields:{}},null,core.FOREVER),CommitSealed);await t.pHome.close(h);
   const fork=t.pJournal.intent(t.pJournal.head().revision)!;assert.equal(t.sJournal.intent(fork.revision),null);
   const sim=new SimulatorFencing(),proof=await sim.fence('p','primary lost');
   const sRaw=await t.sHome.storage();t.register.failNext='boot:s';
   const o={storage:sRaw,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc-s',ctx,recoveryId:'promote-s',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true};
   await assert.rejects(promote(o),/crash before boot CAS/);
   assert.equal((await t.register.get<any>('boot:p'))!.value.state,'fenced');
   await assert.rejects(assertSyncPrimary(t.register,'s',t.sJournal)(),/does not match/);
   const res=await promote(o);
   assert.deepEqual({p:res.config.primaryReplica,s:res.config.standbyReplica,e:res.config.primaryEpoch,v:res.config.replicaConfigVersion},{p:'s',s:'p',e:2,v:2});
   assert.notEqual(t.sJournal.intent(fork.revision)!.hash,fork.hash,'the fork is not part of the promoted history');
   // The old primary is fenced: neither its sync storage nor its candidate recovery may proceed.
   await assert.rejects(assertSyncPrimary(t.register,'p',t.pJournal)(),/boot permit/);
   // The promoted primary has no live standby yet: sync writes stay blocked until degradeToSingle with the same proof.
   const base=t.sHome.storage.bind(t.sHome);t.sHome.storage=async()=>primarySyncStorage(await base(),t.sJournal,null,{assertPrimary:assertSyncPrimary(t.register,'s',t.sJournal)});
   await sRaw.close(ctx);const sh=t.sHome;h=await sh.open();await assert.rejects(new PiSpaces(h,ctx).write({type:'Blocked',fields:{}}),/confirming standby/);await sh.close(h);
   const sRaw2=await base();await degradeToSingle({...o,storage:sRaw2,recoveryId:'degrade-s',expectedPrimaryEpoch:2,expectedReplicaConfigVersion:2});await sRaw2.close(ctx);
   h=await sh.open();const c=new PiSpaces(h,ctx);assert.equal(await c.count({type:'Fork'}),0);assert.equal(await c.count({type:'Work'}),1);
   await c.write({type:'After',fields:{}},null,core.FOREVER);await sh.close(h);
   // Rejoin: the old primary in quarantine still has its fork, so it is refused as setStandby target.
   await releaseHostToQuarantine(t.register,'p','rejoin-p');const st=await base();
   await assert.rejects(setStandby({storage:st,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc-s',ctx,transitionId:'standby-p',target:target('p',t.pJournal,t.register),targetDataIncarnation:'inc-p2'}),/empty target/);
   await st.close(ctx);
  }finally{await t.dispose();}
 });
 test(`${backend}: setStandby seals nothing and keeps the target quarantined when the primary is fenced during catch-up`,async()=>{
  const t=await setup(backend);
  try{
   const h=await t.pHome.open();await new PiSpaces(h,ctx).write({type:'Work',fields:{n:1}},null,core.FOREVER);await t.pHome.close(h);
   const sim=new SimulatorFencing(),proof=await sim.fence('s','standby lost');let st=await t.raw();
   await degradeToSingle({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc-p',ctx,recoveryId:'degrade-1',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true});
   await releaseHostToQuarantine(t.register,'s','rejoin-s');const head=t.pJournal.head();
   const fresh=new PersistentHome(backend),fJournal=new PrimarySyncJournal(join(fresh.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(t.register,'s')});
   try{
    const inner=target('s',fJournal,t.register);let fenced=false;
    const racing:StandbyTarget={...inner,catchUp:async i=>{if(!fenced){fenced=true;await fenceHostBoot(t.register,'p','fence-p');}return inner.catchUp(i);}};
    await assert.rejects(setStandby({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc-p',ctx,transitionId:'standby-1',target:racing,targetDataIncarnation:'inc-s2'}),/boot permit/);
    assert.deepEqual(t.pJournal.head(),head,'no transition was sealed');assert.equal((await t.register.get<any>('boot:s'))!.value.state,'quarantine');
    // The refused setStandby stays open and pauses the Space until it is resumed or abandoned.
    assert.deepEqual(t.pJournal.openTransitionIds(),['standby-1']);t.pJournal.abandonTransition('standby-1');assert.deepEqual(t.pJournal.openTransitionIds(),[]);
   }finally{await st.close(ctx);fJournal.close();await fresh.dispose();}
  }finally{await t.dispose();}
 });
}

for(const backend of BACKENDS)test(`${backend}: an open replica transition pauses every write source, including the reaper and lease renewals, until it completes`,async()=>{
 const single:PrimarySyncConfig={...config,standbyReplica:null,durability:'single'},home=new PersistentHome(backend),journal=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),single),raw=home.storage.bind(home);
 let now=1_000_000;home.storage=async()=>primarySyncStorage(await raw(),journal,null,{assertPrimary:async()=>{},now:()=>now});
 const errors:unknown[]=[];let h=await home.open(),stop=await startMaintenance(h,ctx,{now:()=>now,retryMs:20,onError:e=>errors.push(e)});
 const live=async()=>(await h.snapshot(Space,ctx))!.entries.map(e=>e.fields.n);
 try{
  const client=()=>new PiSpaces(h,ctx,()=>now);
  await client().write({type:'Lease',fields:{n:1}},null,500);const long=await client().write({type:'Lease',fields:{n:2}},null,60_000);
  journal.beginTransition('paused-1',{kind:'test',phase:'started',hash:'x'});
  // The refused seal ends the serving session (pi-durable poisons it); the transition runs with the service down.
  await assert.rejects(client().write({type:'Lease',fields:{n:3}},null,core.FOREVER),/paused-1 in progress; writes are paused/);
  now+=1000;await new Promise(r=>setTimeout(r,100));await stop();await home.close(h);
  // A restarted service (any write source) stays paused while the transition is open.
  h=await home.open();errors.length=0;stop=await startMaintenance(h,ctx,{now:()=>now,retryMs:20,onError:e=>errors.push(e)}).catch(e=>{errors.push(e);return async()=>{};});
  assert.ok(errors.some(e=>e instanceof PrimarySyncBlocked||/writes are paused/.test(String((e as Error)?.message))),'the reaper of a restarted service is paused too');
  await stop();await home.close(h);h=await home.open();
  await assert.rejects(client().renew(long.id,60_000),/writes are paused/);await home.close(h);
  assert.deepEqual((await (h=await home.open()).snapshot(Space,ctx))!.entries.map(e=>e.fields.n).sort(),[1,2],'the expired lease was not settled during the pause');
  assert.equal(journal.appliedRevision,journal.head().revision,'no business candidate was sealed during the pause');
  journal.saveTransition('paused-1',{kind:'test',phase:'completed',hash:'x'});
  stop=await startMaintenance(h,ctx,{now:()=>now,retryMs:20,onError:e=>errors.push(e)});
  for(let i=0;i<50&&(await live()).length!==1;i++)await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(await live(),[2],'after completion the reaper settles the expired lease exactly once');
  await client().write({type:'Lease',fields:{n:4}},null,core.FOREVER);
 }finally{await stop();await home.close(h);journal.close();await home.dispose();}
});

for(const backend of BACKENDS)test(`${backend}: the boot guard binds primary/sync Spaces to the journal configuration; other Spaces of a fenced host return one by one`,async()=>{
 const home=new PersistentHome(backend),reg=new SqliteRecoveryRegister(join(home.dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(home.dir,'installed.sqlite'));
 let h=await home.open(),stop:(()=>void)|undefined;
 try{
  const one=await h.commit(tx=>createSpace(tx,'one',1),ctx),sync=await h.commit(tx=>createSpace(tx,'sync',1),ctx);
  let current:PrimarySyncConfig={...config,spaceId:sync.spaceId,primaryReplica:'p',standbyReplica:'s'};
  const local:SpaceBootPermit={state:'active',authorityId:config.authorityId,dataIncarnation:one.incarnation,role:'local',transitionId:'bootstrap'};
  const primary=(c:PrimarySyncConfig):SpaceBootPermit=>({state:'active',authorityId:c.authorityId,dataIncarnation:sync.incarnation,role:'primary',primaryEpoch:c.primaryEpoch,replicaConfigVersion:c.replicaConfigVersion,durability:c.durability??'sync',transitionId:'bootstrap'});
  await reg.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{[one.spaceId]:local,[sync.spaceId]:primary(current)}} as any);
  const install=async()=>{for(const [id,inc] of [[one.spaceId,one.incarnation],[sync.spaceId,sync.incarnation]])await installAdmittedPermit({external:reg,installed,hostId:'p',spaceId:id,localDataIncarnation:inc}).catch(()=>{});};
  await install();
  const guard=()=>installBootGuard(h,ctx,{hostId:'p',authorityId:config.authorityId,external:reg,installed,replicaConfig:id=>id===sync.spaceId?current:null});stop=guard();
  const a=()=>new PiSpaces(h,ctx,()=>1,undefined,undefined,{space:'one'}),b=()=>new PiSpaces(h,ctx,()=>1,undefined,undefined,{space:'sync'});
  await a().write({type:'Ok',fields:{}},null,core.FOREVER);await b().write({type:'Ok',fields:{}},null,core.FOREVER);
  // The journal moved on (a transition committed locally) but the permit did not: the replicated Space is blocked.
  current={...current,primaryEpoch:2,replicaConfigVersion:2};
  await assert.rejects(b().write({type:'No',fields:{}}),/disagrees with the local replica configuration/);await a().write({type:'StillOk',fields:{}},null,core.FOREVER);
  await assert.rejects(b().read({type:'Ok'},0),/disagrees with the local replica configuration/);
  // A standby permit admits nothing, even with a matching configuration.
  let boot=(await reg.get<any>('boot:p'))!;boot.value.spaces[sync.spaceId]={...primary(current),role:'standby'};await reg.compareAndSet('boot:p',boot.version,boot.value);await install();
  await assert.rejects(b().count({type:'Ok'}),/standby permit admits no business work/);
  // Fence: every Space of the host is revoked.
  await fenceHostBoot(reg,'p','fence-p');await assert.rejects(a().count({type:'Ok'}),BootBlocked);
  // A transition brings back only its own Space (host active, sync permit at the new configuration).
  boot=(await reg.get<any>('boot:p'))!;await reg.compareAndSet('boot:p',boot.version,{...boot.value,state:'active',spaces:{...boot.value.spaces,[sync.spaceId]:primary(current)}});await install();
  assert.equal(await b().count({type:'Ok'}),1);await assert.rejects(a().count({type:'Ok'}),BootBlocked);
  // Re-admission of the other Space: operator side reactivates the revoked permit, the host installs it.
  await assert.rejects(readmitSpace(reg,'p',one.spaceId,{transitionId:'readmit-one',expectedDataIncarnation:'other'}),/not a revoked permit of incarnation other/);
  await assert.rejects(readmitSpace(reg,'p',sync.spaceId,{transitionId:'readmit-sync',expectedDataIncarnation:sync.incarnation}),/replicated Spaces return only through promote/);
  await readmitSpace(reg,'p',one.spaceId,{transitionId:'readmit-one',expectedDataIncarnation:one.incarnation});
  await assert.rejects(a().count({type:'Ok'}),BootBlocked,'external alone is not enough: the local installation still differs');
  await assert.rejects(installAdmittedPermit({external:reg,installed,hostId:'p',spaceId:one.spaceId,localDataIncarnation:'stale'}),/another data incarnation/);
  await install();assert.equal(await a().count({type:'StillOk'}),1);
  // Reboot: the guard is installed again and both Spaces keep their data and admission.
  stop();await home.close(h);h=await home.open();stop=guard();
  assert.equal(await a().count({type:'Ok'}),1);await b().write({type:'AfterReboot',fields:{}},null,core.FOREVER);assert.equal(await b().count({type:'AfterReboot'}),1);
 }finally{stop?.();await home.close(h);reg.close();installed.close();await home.dispose();}
});

for(const backend of BACKENDS)test(`${backend}: the router adopts a ReplicaConfigNotice only as admitted by the register, idempotently and without touching other routing state`,async()=>{
 const t=await setup(backend),router=new PersistentHome(backend),keyDir=join(router.dir,'keys');
 const keys={p:provisionFileSigner(join(keyDir,'p.json')),s:provisionFileSigner(join(keyDir,'s.json'))};
 const issuerKey=async(h:string)=>h==='p'||h==='s'?{algorithm:'ed25519' as const,publicKey:keys[h].publicKey}:null;
 let rh=await router.open();
 try{
  const h=await t.pHome.open();await new PiSpaces(h,ctx).write({type:'Work',fields:{n:1}},null,core.FOREVER);await t.pHome.close(h);
  const sim=new SimulatorFencing(),proof=await sim.fence('p','primary lost'),st=await t.sHome.storage();
  await promote({storage:st,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc-s',ctx,recoveryId:'promote-s',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true});await st.close(ctx);
  const control=await rh.commit(tx=>createSpace(tx,'control',1),ctx),o={controlSpaceId:control.spaceId,authorityId:config.authorityId,register:t.register,issuerKey};
  await rh.commit(async tx=>{const d=await tx.doc(FederationRouting,control.spaceId,null);
   d.policy={authorityId:config.authorityId,policyVersion:1,rules:[],completionProfiles:[],default:{mode:'local',member:'local'}};
   d.members={local:{id:'local',state:'active',target:{hostId:'router',spaceId:'local-space',authorityId:config.authorityId,dataIncarnation:'inc-l',primaryEpoch:1}},
    replicated:{id:'replicated',state:'active',target:{hostId:'p',spaceId:config.spaceId,authorityId:config.authorityId,dataIncarnation:'inc-p',primaryEpoch:1},replication:{primaryReplica:'p',standbyReplica:'s',replicaConfigVersion:1,durability:'sync'}}};},ctx);
  const routing=async()=>structuredClone((await rh.snapshot(FederationRouting,control.spaceId,ctx))!);const before=await routing();
  const notice=replicaConfigNotice(t.sJournal,'promote-s','inc-s');
  assert.deepEqual(notice,{authorityId:config.authorityId,spaceId:config.spaceId,recoveryId:'promote-s',primaryReplica:'s',standbyReplica:'p',primaryEpoch:2,replicaConfigVersion:2,durability:'sync',dataIncarnation:'inc-s'});
  // The fenced old primary still holds an enrolled key, but the register does not admit it.
  await assert.rejects(adoptReplicaConfigNotice(rh,ctx,o,await signReplicaConfigNotice({...notice,primaryReplica:'p',standbyReplica:'s',primaryEpoch:5,replicaConfigVersion:5,dataIncarnation:'inc-p'},keys.p)),/register does not admit/);
  await assert.rejects(adoptReplicaConfigNotice(rh,ctx,o,{...await signReplicaConfigNotice(notice,keys.p),issuer:'s'}),/not signed by its primary/);
  assert.deepEqual(await routing(),before,'refused notices change nothing');
  const signed=await signReplicaConfigNotice(notice,keys.s),first=await adoptReplicaConfigNotice(rh,ctx,o,signed);
  assert.deepEqual(first,{adopted:true,memberId:'replicated',policyVersion:2});
  const after=await routing(),m=after.members.replicated!;
  assert.deepEqual(m.target,{hostId:'s',spaceId:config.spaceId,authorityId:config.authorityId,dataIncarnation:'inc-s',primaryEpoch:2});
  assert.deepEqual(m.replication,{primaryReplica:'s',standbyReplica:'p',replicaConfigVersion:2,durability:'sync',recoveryId:'promote-s'});
  const strip=(r:any)=>({...r,policy:{...r.policy,policyVersion:0},members:{...r.members,replicated:{...r.members.replicated,target:null,replication:null}}});
  assert.deepEqual(strip(after),strip(before),'only replication, target and policyVersion changed');
  // Idempotent; conflicting or stale notices are refused.
  assert.deepEqual(await adoptReplicaConfigNotice(rh,ctx,o,signed),{adopted:false,memberId:'replicated',policyVersion:2});
  await assert.rejects(adoptReplicaConfigNotice(rh,ctx,o,await signReplicaConfigNotice({...notice,recoveryId:'other'},keys.s)),/conflicting notice/);
  await assert.rejects(adoptReplicaConfigNotice(rh,ctx,o,await signReplicaConfigNotice({...notice,primaryEpoch:1,replicaConfigVersion:1},keys.s)),/register does not admit|stale/);
  assert.throws(()=>replicaConfigNotice(t.sJournal,'unknown',''),/completed transition/);
  // A restart keeps the adopted configuration.
  await router.close(rh);rh=await router.open();assert.equal((await rh.snapshot(FederationRouting,control.spaceId,ctx))!.policy!.policyVersion,2);
 }finally{await router.close(rh);await router.dispose();await t.dispose();}
});
