import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {openNodeJsonlStorage} from '@earendil-works/pi-durable/storage/jsonl/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {startService,startQuarantineReplicas,serveRegister,signedReplicaPeer,socketTransport,openSyncSpace,type SyncSpace,validateFederationPolicy,FederationRouting,provisionFileSigner,replicaConfigNotice,signReplicaConfigNotice,adoptReplicaConfigNotice,startMaintenance,createSpace,installBootGuard,BootBlocked,readmitSpace,installAdmittedPermit,type SpaceBootPermit,PrimarySyncJournal,PrimarySyncBlocked,CommitSealed,primarySyncStorage,recoverPrimarySync,materializeSyncHistory,PiSpaces,Space,core,SqliteRecoveryRegister,SimulatorFencing,ReplicaTransitionBlocked,unconfiguredFencing,releaseHostToQuarantine,fenceHostBoot,assertSyncPrimary,assertSyncStandby,assertQuarantine,degradeToSingle,promote,setStandby,type PrimarySyncConfig,type PrimarySyncPeer,type RecoveryRegister,type StandbyTarget} from '../src/index.ts';
import {BACKENDS,PersistentHome,ctx} from './support/persistent.ts';
const config:PrimarySyncConfig={spaceId:'sync-space',authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s'};
const permit=(c:PrimarySyncConfig,role:'primary'|'standby',inc:string)=>({state:'active',authorityId:c.authorityId,dataIncarnation:inc,role,primaryEpoch:c.primaryEpoch,replicaConfigVersion:c.replicaConfigVersion,durability:c.durability??'sync',transitionId:'genesis'});
/** Register wrapper that fails the next boot CAS for one host: the crash between a local transition and the external permit. */
class FlakyRegister implements RecoveryRegister{
 failNext:string|null=null;readonly inner:SqliteRecoveryRegister;constructor(inner:SqliteRecoveryRegister){this.inner=inner;}
 get<T extends import('../src/core.ts').Json>(k:string){return this.inner.get<T>(k);}
 async compareAndSet<T extends import('../src/core.ts').Json>(k:string,e:number|null,v:T){if(this.failNext===k){this.failNext=null;throw Error('crash before boot CAS');}return this.inner.compareAndSet(k,e,v);}
}
async function setup(backend:typeof BACKENDS[number]){
 const pHome=new PersistentHome(backend),sHome=new PersistentHome(backend),register=new FlakyRegister(new SqliteRecoveryRegister(join(pHome.dir,'register.sqlite')));
 await register.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{[config.spaceId]:permit(config,'primary','inc')}});
 await register.compareAndSet('boot:s',null,{hostId:'s',state:'active',spaces:{[config.spaceId]:permit(config,'standby','inc')}});
 const pJournal=new PrimarySyncJournal(join(pHome.dir,'journal.sqlite'),config);
 const sJournal=new PrimarySyncJournal(join(sHome.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(register,'s')});
 let partitioned=false,loseAck=false;const peer:PrimarySyncPeer={accept:async i=>{if(partitioned)throw Error('standby unreachable');const ack=await sJournal.accept(i);if(loseAck){loseAck=false;throw Error('lost standby ACK');}return ack;}};
 const raw=pHome.storage.bind(pHome);
 pHome.storage=async()=>{const st=await raw();await recoverPrimarySync(st,pJournal,peer,ctx,assertSyncPrimary(register,'p',pJournal));return primarySyncStorage(st,pJournal,peer,{assertPrimary:assertSyncPrimary(register,'p',pJournal)});};
 const dispose=async()=>{pJournal.close();sJournal.close();await pHome.dispose();await sHome.dispose();};
 return {pHome,sHome,register,pJournal,sJournal,raw,partition:(v:boolean)=>{partitioned=v;},loseAck:()=>{loseAck=true;},dispose};
}
const target=(hostId:string,journal:PrimarySyncJournal,register:RecoveryRegister):StandbyTarget=>({hostId,head:async()=>journal.head(),catchUp:i=>journal.catchUp(i,assertQuarantine(register,hostId)),accept:i=>journal.accept(i)});

for(const backend of BACKENDS){
 test(`${backend}: promotion and degradeToSingle refuse simulator claims and unconfigured provider adapters without changing state`,async()=>{
  const t=await setup(backend);
  try{
   const h=await t.pHome.open();await new PiSpaces(h,ctx).write({type:'Work',fields:{n:1}},null,core.FOREVER);await t.pHome.close(h);
   const sim=new SimulatorFencing(),proof=await sim.fence('p','primary lost'),sStorage=await t.sHome.storage(),head=t.sJournal.head();
   const base={storage:sStorage,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc',ctx,recoveryId:'promote-1',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1};
   // A refused transition stays open (and pauses business seals) until it is abandoned; it sealed nothing.
   const refused=async(id:string,run:Promise<unknown>,why:RegExp)=>{await assert.rejects(run,why);assert.deepEqual(t.sJournal.openTransitionIds(),[id]);t.sJournal.abandonTransition(id);assert.deepEqual(t.sJournal.openTransitionIds(),[]);};
   await refused('promote-1',promote({...base,adapter:sim,proof}),/simulator fencing claim is no evidence/);
   await refused('promote-2',promote({...base,recoveryId:'promote-2',adapter:unconfiguredFencing('cloud','netcup'),proof:{...proof,kind:'cloud'}}),/netcup fencing is not configured/);
   await refused('promote-3',promote({...base,recoveryId:'promote-3',adapter:sim,proof:{...proof,hostId:'s'},allowSimulator:true}),/no verified fencing proof for p/);
   await assert.rejects(promote({...base,adapter:sim,proof,allowSimulator:true}),/abandoned; use a new ID/);
   await refused('promote-4',promote({...base,recoveryId:'promote-4',dataIncarnation:'other',adapter:sim,proof,allowSimulator:true}),/shared by its replicas/);
   assert.equal((await t.register.get<any>('boot:p'))!.value.state,'active','a refused incarnation fences nothing');
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
   const o={storage,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,recoveryId:'degrade-1',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true};
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
   await assert.rejects(promote({storage:stale,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc',ctx,recoveryId:'stale-promote',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof:pProof,allowSimulator:true}),/standby boot permit/);
   await stale.close(ctx);await sim.release('p');assert.equal(t.sJournal.config.primaryReplica,'p');
   // setStandby: the old standby journal is no empty target, a fresh quarantined replica is.
   await releaseHostToQuarantine(t.register,'s','rejoin-s');
   const fresh=new PersistentHome(backend),fJournal=new PrimarySyncJournal(join(fresh.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(t.register,'s')});
   try{
    await t.pHome.close(h);let st=await t.raw();
    await assert.rejects(setStandby({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,transitionId:'standby-old',target:target('s',t.sJournal,t.register),targetDataIncarnation:'inc'}),/empty target/);
    // A second transition cannot start while the refused one is open.
    await assert.rejects(setStandby({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,transitionId:'standby-1',target:target('s',fJournal,t.register),targetDataIncarnation:'inc'}),/standby-old is still open/);
    t.pJournal.abandonTransition('standby-old');
    const so={storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,transitionId:'standby-1',target:target('s',fJournal,t.register),targetDataIncarnation:'inc'};
    t.register.failNext='boot:s';await assert.rejects(setStandby(so),/crash before boot CAS/);
    assert.equal(t.pJournal.config.standbyReplica,'s');assert.equal((await t.register.get<any>('boot:s'))!.value.state,'quarantine');
    await st.close(ctx);st=await t.raw();const res=await setStandby({...so,storage:st});await st.close(ctx);
    assert.deepEqual({d:res.config.durability,v:res.config.replicaConfigVersion,e:res.config.primaryEpoch},{d:'sync',v:3,e:2});
    const sBoot2=(await t.register.get<any>('boot:s'))!.value;assert.equal(sBoot2.state,'active');assert.equal(sBoot2.spaces[config.spaceId].role,'standby');assert.equal(sBoot2.spaces[config.spaceId].dataIncarnation,'inc');
    // Sync writes resume against the new standby; its materialized storage equals the primary.
    const raw=t.raw;t.pHome.storage=async()=>primarySyncStorage(await raw(),t.pJournal,fJournal,{assertPrimary:assertSyncPrimary(t.register,'p',t.pJournal)});
    h=await t.pHome.open();await client().write({type:'Work',fields:{n:4}},null,core.FOREVER);assert.equal(fJournal.head().hash,t.pJournal.head().hash);
    const fs=await fresh.storage();await materializeSyncHistory(fs,fJournal,ctx);await fs.close(ctx);const fh=await fresh.open();
    assert.deepEqual(await fh.snapshot(Space,ctx),await h.snapshot(Space,ctx));await fresh.close(fh);await t.pHome.close(h);
   }finally{fJournal.close();await fresh.dispose();}
  }finally{await t.dispose();}
 });

 test(`${backend}: a candidate the standby accepted, ACK lost, then the primary dies and degrades: it takes effect once with its result; an old proof after setStandby is refused`,async()=>{
  const t=await setup(backend);
  try{
   let h=await t.pHome.open();const c=()=>new PiSpaces(h,ctx),principal={peerId:'peer-a'};
   const {generation}=await c().issueGeneration(principal,{primaryEpoch:1}),request={principal,generation,requestId:'w1'};
   t.loseAck();await assert.rejects(c().write({type:'Work',fields:{n:1}},null,core.FOREVER,{request}),CommitSealed);
   const candidate=t.pJournal.head();assert.deepEqual(t.sJournal.head(),candidate,'the standby holds the candidate');
   await t.pHome.close(h).catch(()=>{});// the primary dies; then the standby is lost as well
   t.partition(true);
   const sim=new SimulatorFencing(),proof=await sim.fence('s','standby lost'),st=await t.raw();
   const o={storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,recoveryId:'degrade-ack',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true};
   const done=await degradeToSingle(o);await st.close(ctx);
   assert.deepEqual(done.recoveredCommitted,[candidate.revision]);
   h=await t.pHome.open();
   assert.equal(await c().count({type:'Work'}),1,'exactly once');
   const lease=await c().write({type:'Work',fields:{n:1}},null,core.FOREVER,{request});
   assert.ok(lease,'the retry gets the stored result, no miss or abort');assert.equal((await c().pollOperation(request)).state,'done');
   assert.equal(await c().count({type:'Work'}),1);await t.pHome.close(h);
   // setStandby brings s back; the proof from before its release no longer verifies and authorizes nothing.
   await releaseHostToQuarantine(t.register,'s','rejoin-s',sim);
   const fresh=new PersistentHome(backend),fJournal=new PrimarySyncJournal(join(fresh.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(t.register,'s')});
   try{
    let st2=await t.raw();
    await setStandby({storage:st2,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,transitionId:'standby-back',target:target('s',fJournal,t.register),targetDataIncarnation:'inc'});await st2.close(ctx);
    st2=await t.raw();
    await assert.rejects(degradeToSingle({...o,storage:st2,recoveryId:'degrade-stale',expectedPrimaryEpoch:2,expectedReplicaConfigVersion:3}),/no verified fencing proof for s/);
    await st2.close(ctx);
    assert.equal(t.pJournal.config.durability,'sync');assert.equal((await t.register.get<any>('boot:s'))!.value.state,'active','the stale proof fenced nothing');
   }finally{fJournal.close();await fresh.dispose();}
  }finally{await t.dispose();}
 });

 test(`${backend}: setStandby whose confirming ACK is lost admits no write until the same transition completes`,async()=>{
  const t=await setup(backend);
  try{
   let h=await t.pHome.open();await new PiSpaces(h,ctx).write({type:'Work',fields:{n:1}},null,core.FOREVER);await t.pHome.close(h);
   t.partition(true);
   const sim=new SimulatorFencing(),st=await t.raw();
   await degradeToSingle({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,recoveryId:'degrade-1',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof:await sim.fence('s','standby lost'),allowSimulator:true});await st.close(ctx);
   await releaseHostToQuarantine(t.register,'s','rejoin-s',sim);
   const fresh=new PersistentHome(backend),fJournal=new PrimarySyncJournal(join(fresh.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(t.register,'s')});
   try{
    // The target accepts the confirming entry, but its ACK never arrives.
    let lose=true;const base=target('s',fJournal,t.register),flaky:StandbyTarget={...base,accept:async i=>{const ack=await base.accept(i);if(lose&&i.revision===t.pJournal.head().revision){lose=false;throw Error('lost ACK');}return ack;}};
    const so={journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,transitionId:'standby-1',target:flaky,targetDataIncarnation:'inc'};
    let st2=await t.raw();await assert.rejects(setStandby({...so,storage:st2}),/durably sealed/);await st2.close(ctx);
    assert.deepEqual(t.pJournal.openTransitionIds(),['standby-1']);
    assert.equal((await t.register.get<any>('boot:s'))!.value.state,'quarantine','no permit while the outcome is unclear');
    // Restart: no write before the same transition is completed; another transition cannot start.
    await assert.rejects(t.pHome.open().then(x=>new PiSpaces(x,ctx).write({type:'Blocked',fields:{}},null,core.FOREVER)));
    st2=await t.raw();
    await assert.rejects(setStandby({...so,storage:st2,transitionId:'standby-2'}),/standby-1 is still open/);
    const res=await setStandby({...so,storage:st2});await st2.close(ctx);
    assert.deepEqual([res.config.durability,res.config.standbyReplica],['sync','s']);assert.deepEqual(fJournal.head(),t.pJournal.head());
    assert.equal((await t.register.get<any>('boot:s'))!.value.state,'active');
    // The excluded old replica cannot promote: its standby permit was replaced by the new one's configuration.
    const old=await t.sHome.storage();
    await assert.rejects(promote({storage:old,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc',ctx,recoveryId:'promote-old',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof:await sim.fence('p','x'),allowSimulator:true}),/permit|configuration/);
    await old.close(ctx);await sim.release('p');
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
   const o={storage:sRaw,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc',ctx,recoveryId:'promote-s',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true};
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
   await assert.rejects(setStandby({storage:st,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc',ctx,transitionId:'standby-p',target:target('p',t.pJournal,t.register),targetDataIncarnation:'inc'}),/empty target/);
   await st.close(ctx);
  }finally{await t.dispose();}
 });
 test(`${backend}: setStandby seals nothing and keeps the target quarantined when the primary is fenced during catch-up`,async()=>{
  const t=await setup(backend);
  try{
   const h=await t.pHome.open();await new PiSpaces(h,ctx).write({type:'Work',fields:{n:1}},null,core.FOREVER);await t.pHome.close(h);
   const sim=new SimulatorFencing(),proof=await sim.fence('s','standby lost');let st=await t.raw();
   await degradeToSingle({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,recoveryId:'degrade-1',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true});
   await releaseHostToQuarantine(t.register,'s','rejoin-s');const head=t.pJournal.head();
   const fresh=new PersistentHome(backend),fJournal=new PrimarySyncJournal(join(fresh.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(t.register,'s')});
   try{
    const inner=target('s',fJournal,t.register);let fenced=false;
    const racing:StandbyTarget={...inner,catchUp:async i=>{if(!fenced){fenced=true;await fenceHostBoot(t.register,'p','fence-p');}return inner.catchUp(i);}};
    await assert.rejects(setStandby({storage:st,journal:t.pJournal,register:t.register,hostId:'p',dataIncarnation:'inc',ctx,transitionId:'standby-1',target:racing,targetDataIncarnation:'inc'}),/boot permit/);
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
  await promote({storage:st,journal:t.sJournal,register:t.register,hostId:'s',dataIncarnation:'inc',ctx,recoveryId:'promote-s',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,adapter:sim,proof,allowSimulator:true});await st.close(ctx);
  const control=await rh.commit(tx=>createSpace(tx,'control',1),ctx),o={controlSpaceId:control.spaceId,authorityId:config.authorityId,register:t.register,issuerKey};
  await rh.commit(async tx=>{const d=await tx.doc(FederationRouting,control.spaceId,null);
   d.policy={authorityId:config.authorityId,policyVersion:1,completionProfiles:[],default:{mode:'local',member:'local'},
    rules:[{type:'Synced',mode:'sync',variant:'primary',member:'replicated',primaryReplica:'p',standbyReplica:'s',replicaConfigVersion:1,durability:'sync'},{type:'Plain',mode:'local',member:'local'}]};
   d.members={local:{id:'local',state:'active',target:{hostId:'router',spaceId:'local-space',authorityId:config.authorityId,dataIncarnation:'inc-l',primaryEpoch:1}},
    replicated:{id:'replicated',state:'active',target:{hostId:'p',spaceId:config.spaceId,authorityId:config.authorityId,dataIncarnation:'inc',primaryEpoch:1},replication:{primaryReplica:'p',standbyReplica:'s',replicaConfigVersion:1,durability:'sync'}}};},ctx);
  const routing=async()=>structuredClone((await rh.snapshot(FederationRouting,control.spaceId,ctx))!);const before=await routing();
  const notice=replicaConfigNotice(t.sJournal,'promote-s','inc');
  assert.deepEqual(notice,{authorityId:config.authorityId,spaceId:config.spaceId,recoveryId:'promote-s',primaryReplica:'s',standbyReplica:'p',primaryEpoch:2,replicaConfigVersion:2,durability:'sync',dataIncarnation:'inc'});
  // The fenced old primary still holds an enrolled key, but the register does not admit it.
  await assert.rejects(adoptReplicaConfigNotice(rh,ctx,o,await signReplicaConfigNotice({...notice,primaryReplica:'p',standbyReplica:'s',primaryEpoch:5,replicaConfigVersion:5,dataIncarnation:'inc'},keys.p)),/register does not admit/);
  await assert.rejects(adoptReplicaConfigNotice(rh,ctx,o,{...await signReplicaConfigNotice(notice,keys.p),issuer:'s'}),/not signed by its primary/);
  assert.deepEqual(await routing(),before,'refused notices change nothing');
  const signed=await signReplicaConfigNotice(notice,keys.s),first=await adoptReplicaConfigNotice(rh,ctx,o,signed);
  assert.deepEqual(first,{adopted:true,memberId:'replicated',policyVersion:2});
  const after=await routing(),m=after.members.replicated!;
  assert.deepEqual(m.target,{hostId:'s',spaceId:config.spaceId,authorityId:config.authorityId,dataIncarnation:'inc',primaryEpoch:2});
  assert.deepEqual(m.replication,{primaryReplica:'s',standbyReplica:'p',replicaConfigVersion:2,durability:'sync',recoveryId:'promote-s'});
  assert.deepEqual(after.policy!.rules[0],{type:'Synced',mode:'sync',variant:'primary',member:'replicated',primaryReplica:'s',standbyReplica:'p',replicaConfigVersion:2,durability:'sync'});
  const strip=(r:any)=>({...r,policy:{...r.policy,policyVersion:0,rules:[null,...r.policy.rules.slice(1)]},members:{...r.members,replicated:{...r.members.replicated,target:null,replication:null}}});
  assert.deepEqual(strip(after),strip(before),'only replication, target, the primary rule of the Member and policyVersion changed');
  // Rule and Member replica configuration agree before and after; a drifted rule is refused by the validator.
  validateFederationPolicy(before.policy!,before.members,null,new Set(),true);validateFederationPolicy(after.policy!,after.members,before.policy,new Set(),true);
  assert.throws(()=>validateFederationPolicy(before.policy!,after.members,null,new Set(),true),/disagrees with the member replica configuration/);
  // Idempotent; conflicting or stale notices are refused.
  assert.deepEqual(await adoptReplicaConfigNotice(rh,ctx,o,signed),{adopted:false,memberId:'replicated',policyVersion:2});
  await assert.rejects(adoptReplicaConfigNotice(rh,ctx,o,await signReplicaConfigNotice({...notice,recoveryId:'other'},keys.s)),/conflicting notice/);
  await assert.rejects(adoptReplicaConfigNotice(rh,ctx,o,await signReplicaConfigNotice({...notice,primaryEpoch:1,replicaConfigVersion:1},keys.s)),/register does not admit|stale/);
  assert.throws(()=>replicaConfigNotice(t.sJournal,'unknown',''),/completed transition/);
  // A restart keeps the adopted configuration.
  await router.close(rh);rh=await router.open();assert.equal((await rh.snapshot(FederationRouting,control.spaceId,ctx))!.policy!.policyVersion,2);
 }finally{await router.close(rh);await router.dispose();await t.dispose();}
});

for(const backend of BACKENDS)test(`${backend}: openSyncSpace serves a primary/sync Space from its own store, replicates to the standby and binds the boot guard`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-space-')),reg=new SqliteRecoveryRegister(join(dir,'external.sqlite'));
 const keys={p:provisionFileSigner(join(dir,'p.json')),s:provisionFileSigner(join(dir,'s.json'))},ip={p:'127.0.0.2',s:'127.0.0.3'},port=17533+(backend==='jsonl'?0:1);
 const spaceId='sp-0b7e6f1a-1111-4222-8333-944445555666',incarnation='0a1b2c3d';
 const genesis:PrimarySyncConfig={spaceId,authorityId:config.authorityId,primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s',durability:'sync'};
 const permit=(role:'primary'|'standby')=>({state:'active',authorityId:config.authorityId,dataIncarnation:incarnation,role,primaryEpoch:1,replicaConfigVersion:1,durability:'sync',transitionId:'provisioned'});
 await reg.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{[spaceId]:permit('primary')}});await reg.compareAndSet('boot:s',null,{hostId:'s',state:'active',spaces:{[spaceId]:permit('standby')}});
 const installed={p:new SqliteRecoveryRegister(join(dir,'installed-p.sqlite')),s:new SqliteRecoveryRegister(join(dir,'installed-s.sqlite'))};
 const homes={p:new PersistentHome(backend),s:new PersistentHome(backend)};
 const open=(h:'p'|'s')=>openSyncSpace({config:{alias:'jobs-sync',spaceId,incarnation,dir:join(homes[h].dir,'sync'),genesis,port,peers:[{hostId:h==='p'?'s':'p',algorithm:'ed25519',publicKey:keys[h==='p'?'s':'p'].publicKey,ip:ip[h==='p'?'s':'p']}]},
  hostId:h,authorityId:config.authorityId,bindIp:ip[h],signer:keys[h],external:reg,installed:installed[h],ctx,
  openStorage:async path=>backend==='sqlite'?openNodeSqliteStorage(path):openNodeJsonlStorage(path+'.d',ctx),openHarness:async st=>Harness.open(st,{models:createModels(),registry:createRegistry()},ctx)});
 let s:SyncSpace|undefined,p:SyncSpace|undefined;
 try{
  s=await open('s');assert.equal(s.role(),'standby');assert.equal(s.harness,undefined,'a standby serves no business calls');
  p=await open('p');assert.equal(p.role(),'primary');
  const jobs=()=>new PiSpaces(p!.harness!,ctx,Date.now,undefined,undefined,{space:'jobs-sync'});
  for(let n=0;n<3;n++)await jobs().write({type:'Job',fields:{n}},null,core.FOREVER);
  assert.deepEqual(s.journal.head(),p.journal.head(),'every commit is confirmed by the standby');assert.equal(await jobs().count({type:'Job'}),3);
  // Reaper and delivery on a sync Harness: idle ticks are no sync decisions; with the standby down the start does not throw.
  let stop=await startService(p.harness!,ctx,{space:'jobs-sync',retryMs:20});await new Promise(r=>setTimeout(r,150));
  const before=p.journal.head().revision;await jobs().write({type:'Job',fields:{n:99}},null,core.FOREVER);assert.equal(p.journal.head().revision,before+1,'idle maintenance sealed nothing');await stop();
  const job99=(await jobs().readAll({type:'Job',fields:{n:99}}))[0]!;await jobs().take({type:'Job',fields:{n:99}},0);void job99;
  await s.close();s=undefined;stop=await startService(p.harness!,ctx,{space:'jobs-sync',retryMs:20});await new Promise(r=>setTimeout(r,150));await stop();
  assert.equal(p.journal.head().revision,p.journal.appliedRevision,'no candidate was sealed by idle maintenance without a standby');
  await p.close();p=undefined;s=await open('s');p=await open('p');
  assert.equal(await p.notice(),null,'no notice without a completed transition');
  await p.close();p=await open('p');assert.equal(await jobs().count({type:'Job'}),3,'the dedicated store survives a restart');await jobs().write({type:'Job',fields:{n:3}},null,core.FOREVER);
  // The boot guard follows the external permit of exactly this replica configuration.
  const b=(await reg.get<any>('boot:p'))!;await reg.compareAndSet('boot:p',b.version,{...b.value,spaces:{[spaceId]:{...permit('primary'),replicaConfigVersion:2}}});
  await assert.rejects(jobs().write({type:'Job',fields:{n:4}},null,core.FOREVER),/boot permit|replica configuration|lacks matching/);
  // Reopening copies the new external permit; it still disagrees with the journal configuration, so writes stay blocked.
  await p.close();p=undefined;p=await open('p');await assert.rejects(jobs().write({type:'Job',fields:{n:4}},null,core.FOREVER),/boot permit|replica configuration|lacks matching/);
  const b2=(await reg.get<any>('boot:p'))!;await reg.compareAndSet('boot:p',b2.version,{...b2.value,spaces:{[spaceId]:permit('primary')}});
  await p.close();p=undefined;p=await open('p');await jobs().write({type:'Job',fields:{n:5}},null,core.FOREVER);assert.equal(await jobs().count({type:'Job'}),5,'after the permit returns, the reopened primary installs it and serves again');
 }finally{await p?.close().catch(()=>{});await s?.close();reg.close();installed.p.close();installed.s.close();await homes.p.dispose();await homes.s.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('the policy validator admits primary rules of replicated Members and merge rules only with a matching entry replication',()=>{
 const target=(h:string)=>({hostId:h,spaceId:'sp-'+h,authorityId:'a',dataIncarnation:'i',primaryEpoch:1});
 const table:any={m:{id:'m',state:'active',target:target('p'),replication:{primaryReplica:'p',standbyReplica:'s',replicaConfigVersion:1,durability:'sync'}},plain:{id:'plain',state:'active',target:target('x')}};
 const policy=(rules:any[])=>({authorityId:'a',policyVersion:1,completionProfiles:[],default:{mode:'local' as const,member:'plain'},rules});
 const primary={type:'Synced',mode:'sync',variant:'primary',member:'m',primaryReplica:'p',standbyReplica:'s',replicaConfigVersion:1,durability:'sync'};
 validateFederationPolicy(policy([primary]),table);
 assert.throws(()=>validateFederationPolicy(policy([{...primary,member:'plain'}]),table),/sync activation requires phase 3/);
 assert.throws(()=>validateFederationPolicy(policy([{...primary,replicaConfigVersion:2}]),table),/disagrees with the member replica configuration/);
 const merged={type:'Merged',mode:'sync',variant:'lww',members:['plain'],semantics:'state',keyFields:['k']};
 assert.throws(()=>validateFederationPolicy(policy([merged]),table),/lacks a matching entry replication/);
 table.plain.entryReplication={replicaId:'x',incarnation:'i',rules:[{type:'Merged',variant:'lww',keyFields:['k']}]};validateFederationPolicy(policy([merged]),table);
 // A primary Member never serves a merge rule (two replication paths for the same entries).
 table.m.entryReplication={replicaId:'p',incarnation:'i',rules:[{type:'Merged',variant:'lww',keyFields:['k']}]};
 assert.throws(()=>validateFederationPolicy(policy([{...merged,members:['m']}]),table),/primary member cannot be expand or merge member/);
});

test('a quarantined host opens only replica listeners, accepts catch-up and reports when it is active again',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'quarantine-')),reg=new SqliteRecoveryRegister(join(dir,'external.sqlite')),sock=join(dir,'register.sock'),server=await serveRegister(reg,sock,{writable:true});
 const keys={p:provisionFileSigner(join(dir,'p.json')),s:provisionFileSigner(join(dir,'s.json'))},spaceId='sp-0b7e6f1a-2222-4222-8333-944445555666',port=17541;
 const genesis:PrimarySyncConfig={spaceId,authorityId:config.authorityId,primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s',durability:'sync'};
 const file=join(dir,'federation.json');writeFileSync(file,JSON.stringify({hostId:'p',peerId:'peer-p',authorityId:config.authorityId,controlHostId:'c',controlSpaceId:'x',mode:'member',listen:{host:'127.0.0.2',port:7421},keyFile:join(dir,'p.json'),registerReadSocket:sock,installedRegisterFile:join(dir,'installed.sqlite'),management:{url:'x',tokenFile:'x'},control:{address:{host:'x',port:1},algorithm:'ed25519',publicKey:'x'},
  syncSpaces:[{alias:'jobs-sync',spaceId,incarnation:'0a1b2c3d',dir:join(dir,'sync'),genesis,port,peers:[{hostId:'s',algorithm:'ed25519',publicKey:keys.s.publicKey,ip:'127.0.0.3'}]}]}),{mode:0o600});
 const factories={openSyncStorage:(path:string)=>openNodeSqliteStorage(path),openSyncHarness:(st:any)=>Harness.open(st,{models:createModels(),registry:createRegistry()},ctx)};
 let q:Awaited<ReturnType<typeof startQuarantineReplicas>>|undefined;
 try{
  await reg.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{}});
  await assert.rejects(startQuarantineReplicas(ctx,file,factories),/not in quarantine/);
  const b=(await reg.get<any>('boot:p'))!;await reg.compareAndSet('boot:p',b.version,{...b.value,state:'quarantine'});
  q=await startQuarantineReplicas(ctx,file,factories,{pollMs:20});
  assert.equal(q.spaces.length,1);assert.equal(q.spaces[0]!.harness,undefined,'the old primary serves nothing in quarantine');
  // The new primary s replays history onto the quarantined replica through the signed transport.
  const sJournal=new PrimarySyncJournal(join(dir,'s-journal.sqlite'),{...genesis,primaryReplica:'p'});
  const t=socketTransport({host:'127.0.0.2',port},{localAddress:'127.0.0.3'}),peer=signedReplicaPeer({transport:t,signer:keys.s,self:'s',remote:{hostId:'p',algorithm:'ed25519',publicKey:keys.p.publicKey}});
  try{assert.equal((await peer.head()).revision,0,'reachable and empty');}finally{t.close();sJournal.close();}
  const active=q.untilActive();const b2=(await reg.get<any>('boot:p'))!;await reg.compareAndSet('boot:p',b2.version,{...b2.value,state:'active'});
  assert.equal(await active,true);
 }finally{await q?.close();await server.close();reg.close();rmSync(dir,{recursive:true,force:true});}
});
