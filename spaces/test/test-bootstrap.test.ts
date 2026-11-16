import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync,copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {OwnSyncStore} from '../src/store/sync-sqlite.ts';
import {PrimarySyncJournal,PrimarySyncBlocked,bootstrapPrimarySync,captureStore,materializeSyncHistory,primarySyncStorage,recoverPrimarySync,PhiSpaces,Space,core,createSpace,listSpaces,snapshotSpace,canonicalJson,type PrimarySyncConfig} from '../src/index.ts';
import {BACKENDS,freePort,PersistentHome,ctx} from './support/persistent.ts';
import {plainDoc} from './support/host.ts';

const single:PrimarySyncConfig={spaceId:'bootstrapped',authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:null,durability:'single'};

/** An existing store with phi-spaces activity in the default and a named Space. */
async function existingStore(home:PersistentHome){
 const h=await home.open(),local=new PhiSpaces(h,ctx,()=>1000);
 await h.commit(tx=>createSpace(tx,'jobs',1000),ctx);
 for(let n=0;n<12;n++)await local.write({type:'Job',fields:{n,pad:'x'.repeat(400)}},null,core.FOREVER);
 const request={principal:{peerId:'worker'},...(await local.issueGeneration({peerId:'worker'})),requestId:'claimed'};
 await local.write({type:'Claimed',fields:{}},null,core.FOREVER,{request});
 await new PhiSpaces(h,ctx,()=>1000,undefined,undefined,{space:'jobs'}).write({type:'Named',fields:{}},null,core.FOREVER);
 await home.close(h);
}

for(const backend of BACKENDS){
 test(`${backend}: an existing store bootstraps in chunks; an empty replica replays it and holds exactly the captured store`,async()=>{
  const home=new PersistentHome(backend),replica=new PersistentHome(backend);
  try{
   await existingStore(home);
   const journal=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),single);let st=await home.storage();
   const before=await captureStore(st,ctx);
   assert.ok(before.writes.some(w=>w.t==='doc')&&before.writes.some(w=>w.t==='part'),'every record kind of the fixture is captured');
   const r=await bootstrapPrimarySync(st,journal,ctx,{chunkBytes:2000});
   assert.ok(r.revisions>2,'small chunks split the store');assert.equal(journal.appliedRevision,r.revisions);assert.equal(r.storeHash,before.digest);
   assert.equal((await captureStore(st,ctx)).digest,before.digest,'the primary keeps its data unchanged; only the marker was added');
   // A second call is a no-op; the store is now tracked and opens normally.
   assert.equal((await bootstrapPrimarySync(st,journal,ctx)).revisions,r.revisions);await recoverPrimarySync(st,journal,null,ctx,async()=>{});await st.close(ctx);
   // The empty replica receives the chain and materializes it; the last chunk verifies the store digest.
   const target=new PrimarySyncJournal(join(replica.dir,'journal.sqlite'),single);
   for(let n=1;n<=journal.head().revision;n++)await target.catchUp(journal.intent(n)!,async()=>{});
   const rs=await replica.storage();await materializeSyncHistory(rs,target,ctx);assert.equal((await captureStore(rs,ctx)).digest,before.digest);await rs.close(ctx);
   const rh=await replica.open();assert.equal(await new PhiSpaces(rh,ctx,()=>1000).count({type:'Job'}),12);assert.equal(await new PhiSpaces(rh,ctx,()=>1000,undefined,undefined,{space:'jobs'}).count({type:'Named'}),1);
   // compared as plain JSON while each host is open (the own store reads its claims from the disk)
   assert.deepEqual(plainDoc(await rh.snapshot(Space,ctx)),await (async()=>{const h=await home.open();try{return plainDoc(await h.snapshot(Space,ctx));}finally{await home.close(h);}})());
   // New IDs minted after the bootstrap do not collide with captured ones (the counter follows the largest ID).
   await new PhiSpaces(rh,ctx,()=>1000).write({type:'After',fields:{}},null,core.FOREVER);await replica.close(rh);
   // The primary continues under primary/sync storage after the bootstrap.
   const raw=home.storage.bind(home);home.storage=async()=>primarySyncStorage(await raw(),journal,null,{assertPrimary:async()=>{}});
   const ph=await home.open();await new PhiSpaces(ph,ctx,()=>1000).write({type:'Job',fields:{n:99}},null,core.FOREVER);assert.equal(journal.head().revision,r.revisions+1);await home.close(ph);
   journal.close();target.close();
  }finally{await home.dispose();await replica.dispose();}
 });

 test(`${backend}: a bootstrap resumes after a crash before its markers and refuses a store changed in between`,async()=>{
  const home=new PersistentHome(backend),other=new PersistentHome(backend);
  try{
   await existingStore(home);
   const journal=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),single);let st=await home.storage();
   home.faults.arm('failBeforeCommit');await assert.rejects(bootstrapPrimarySync(st,journal,ctx,{chunkBytes:16000}));await st.close(ctx);
   assert.ok(journal.head().revision>0&&journal.appliedRevision<journal.head().revision,'sealed but not marked');
   // Writes are refused until the bootstrap is complete.
   assert.throws(()=>journal.seal([{type:'document.retire',id:'x'} as any,{type:'document.retire',id:'y'} as any],1),/bootstrap is not complete|sealed candidate/);
   st=await home.storage();const r=await bootstrapPrimarySync(st,journal,ctx);assert.equal(journal.appliedRevision,r.revisions);await st.close(ctx);journal.close();
   // A store that changed after sealing is refused.
   await existingStore(other);const j2=new PrimarySyncJournal(join(other.dir,'journal.sqlite'),single);let s2=await other.storage();
   other.faults.arm('failBeforeCommit');await assert.rejects(bootstrapPrimarySync(s2,j2,ctx));await s2.close(ctx);
   const h=await other.open();await new PhiSpaces(h,ctx,()=>1000).write({type:'Sneaked',fields:{}},null,core.FOREVER);await other.close(h);
   s2=await other.storage();await assert.rejects(bootstrapPrimarySync(s2,j2,ctx),/changed since the bootstrap was sealed/);await s2.close(ctx);j2.close();
  }finally{await home.dispose();await other.dispose();}
 });

 test(`${backend}: bootstrap guards: single genesis only, no tracked store, no oversized record`,async()=>{
  const home=new PersistentHome(backend);
  try{
   await existingStore(home);let st=await home.storage();
   const sync=new PrimarySyncJournal(join(home.dir,'sync-journal.sqlite'),{...single,standbyReplica:'s',durability:'sync'});
   await assert.rejects(bootstrapPrimarySync(st,sync,ctx),/starts single/);sync.close();
   const journal=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),single);
   await assert.rejects(bootstrapPrimarySync(st,journal,ctx,{chunkBytes:64}),/exceeds the bootstrap chunk budget/);assert.equal(journal.head().revision,0);
   // An untracked store still cannot be opened as primary/sync without the explicit bootstrap.
   await assert.rejects(recoverPrimarySync(st,journal,null,ctx,async()=>{}),/empty dedicated storage domain/);
   await st.close(ctx);journal.close();
  }finally{await home.dispose();}
 });
}

const hostACopy=process.env.PHI_SPACES_BOOTSTRAP_COPY;
test('a copy of a real own control store bootstraps and replays with identical content',{skip:!hostACopy||!existsSync(hostACopy)?'set PHI_SPACES_BOOTSTRAP_COPY to an own store copy':false},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bootstrap-copy-'));
 try{
  copyFileSync(hostACopy!,join(dir,'primary.sqlite'));
  const journal=new PrimarySyncJournal(join(dir,'journal.sqlite'),single),st=new OwnSyncStore(join(dir,'primary.sqlite'));
  const r=await bootstrapPrimarySync(st,journal,ctx);await st.close(ctx);
  const target=new PrimarySyncJournal(join(dir,'target-journal.sqlite'),single);for(let n=1;n<=journal.head().revision;n++)await target.catchUp(journal.intent(n)!,async()=>{});
  const ts=new OwnSyncStore(join(dir,'replica.sqlite'));await materializeSyncHistory(ts,target,ctx);assert.equal((await captureStore(ts,ctx)).digest,r.storeHash);await ts.close(ctx);
  const open=async(f:string)=>new OwnSyncStore(join(dir,f)).openHost();
  const a=await open('primary.sqlite'),b=await open('replica.sqlite');
  try{const spaces=await listSpaces(a,ctx);assert.deepEqual(await listSpaces(b,ctx),spaces);for(const i of spaces)assert.equal(canonicalJson(await snapshotSpace(b,i.spaceId,ctx) as any),canonicalJson(await snapshotSpace(a,i.spaceId,ctx) as any),`Space ${i.alias} identical`);}
  finally{await a.close(ctx);await b.close(ctx);journal.close();target.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
void PrimarySyncBlocked;

for(const backend of BACKENDS)test(`${backend}: a control-like main store bootstraps, gains a standby, degrades with epoch 2 on every control path`,async()=>{
 const {SqliteRecoveryRegister,assertSyncPrimary,assertSyncStandby,installBootGuard,setStandby,degradeToSingle,SimulatorFencing,fenceHostBoot,openSyncSpace,signedReplicaPeer,socketTransport,provisionFileSigner,RouterLeaseAuthority,MemoryKeyDirectory,createFederationController}=await import('../src/index.ts');
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'control-sync-'));
 let listener:Awaited<ReturnType<typeof openSyncSpace>>|undefined;
 try{
  // A control host's main store: default Space plus the control Space.
  let h=await home.open();const control=await h.commit(tx=>createSpace(tx,'control',1000),ctx);await new PhiSpaces(h,ctx,()=>1000).write({type:'Default',fields:{}},null,core.FOREVER);
  await new PhiSpaces(h,ctx,()=>1000,undefined,undefined,{space:'control'}).write({type:'PeerKey',fields:{peerId:'x'}},null,core.FOREVER);
  const spaces=await listSpaces(h,ctx),def=spaces.find(i=>i.alias==='default')!;await home.close(h);
  const reg=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));
  const genesis:PrimarySyncConfig={spaceId:control.spaceId,authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'a',standbyReplica:null,durability:'single'};
  const permit=(inc:string,role:string,c:PrimarySyncConfig)=>({state:'active',authorityId:'authority',dataIncarnation:inc,role,primaryEpoch:c.primaryEpoch,replicaConfigVersion:c.replicaConfigVersion,durability:c.durability??'sync',transitionId:'provisioned'});
  await reg.compareAndSet('boot:a',null,{hostId:'a',state:'active',spaces:{[control.spaceId]:permit(control.incarnation,'primary',genesis),[def.spaceId]:permit(def.incarnation,'primary',genesis)}});
  await reg.compareAndSet('boot:n',null,{hostId:'n',state:'quarantine',spaces:{[control.spaceId]:{...permit(control.incarnation,'standby',genesis),state:'revoked'}}});
  // 1. Bootstrap under single durability.
  const journal=new PrimarySyncJournal(join(home.dir,'main-journal.sqlite'),genesis,{self:'a'});let st=await home.storage();
  const boot=await bootstrapPrimarySync(st,journal,ctx);assert.ok(boot.revisions>=1);
  // 2. setStandby to a listen-only replica of the main store (the control standby), siblings follow on a.
  const keys={a:provisionFileSigner(join(dir,'a.json')),n:provisionFileSigner(join(dir,'n.json'))},port=await freePort();
  listener=await openSyncSpace({config:{alias:'control-main',spaceId:control.spaceId,incarnation:control.incarnation,dir:join(dir,'replica'),genesis,port,peers:[{hostId:'a',algorithm:'ed25519',publicKey:keys.a.publicKey,ip:'127.0.0.2'}]},hostId:'n',authorityId:'authority',bindIp:'127.0.0.3',signer:keys.n,external:reg,installed:new SqliteRecoveryRegister(join(dir,'n-installed.sqlite')),ctx,openStorage:async()=>{throw Error('unused');},openHarness:async()=>{throw Error('unused');},listenOnly:true});
  const t=socketTransport({host:'127.0.0.3',port},{localAddress:'127.0.0.2'}),peer=signedReplicaPeer({transport:t,signer:keys.a,self:'a',remote:{hostId:'n',algorithm:'ed25519',publicKey:keys.n.publicKey}});
  const set=await setStandby({storage:st,journal,register:reg,hostId:'a',dataIncarnation:control.incarnation,ctx,transitionId:'control-standby',target:peer,targetDataIncarnation:control.incarnation,siblingSpaces:[def.spaceId]});
  assert.equal(set.config.standbyReplica,'n');
  const nb=(await reg.get<any>('boot:n'))!.value.spaces[def.spaceId];assert.deepEqual([nb.state,nb.role,nb.dataIncarnation,nb.replicaConfigVersion],['active','standby',def.incarnation,2],'the standby holds the sibling Space too');assert.equal(listener.journal.head().hash,journal.head().hash,'the control standby holds the whole chain incl. bootstrap');
  await st.close(ctx);
  // 3. The main Harness runs on primary/sync with the boot guard bound for every Space of the store.
  const raw=home.storage.bind(home);home.storage=async()=>primarySyncStorage(await raw(),journal,peer,{assertPrimary:assertSyncPrimary(reg,'a',journal)});
  for(const sp of [control,def]){const p=(await reg.get<any>('boot:a'))!.value.spaces[sp.spaceId];await installed.compareAndSet(`installed:a:${sp.spaceId}`,(await installed.get(`installed:a:${sp.spaceId}`))?.version??null,p);}
  h=await home.open();let stop=installBootGuard(h,ctx,{hostId:'a',authorityId:'authority',external:reg,installed,replicaConfig:()=>journal.config});
  await new PhiSpaces(h,ctx,()=>1000,undefined,undefined,{space:'control'}).write({type:'Command',fields:{n:1}},null,core.FOREVER);await new PhiSpaces(h,ctx,()=>1000).write({type:'Default',fields:{n:2}},null,core.FOREVER);
  assert.equal(listener.journal.head().hash,journal.head().hash,'every control write is confirmed by the standby');
  stop();await home.close(h);
  // 4. The standby is lost: degradeToSingle with a fencing proof; both Spaces follow to epoch 2.
  await listener.close();listener=undefined;t.close();
  const sim=new SimulatorFencing(),proof=await sim.fence('n','control standby lost');st=await raw();
  const d=await degradeToSingle({storage:st,journal,register:reg,hostId:'a',dataIncarnation:control.incarnation,ctx,recoveryId:'control-degrade',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:2,adapter:sim,proof,allowSimulator:true,siblingSpaces:[def.spaceId]});await st.close(ctx);
  assert.equal(d.config.primaryEpoch,2);const b=(await reg.get<any>('boot:a'))!.value;
  for(const id of [control.spaceId,def.spaceId])assert.deepEqual({e:b.spaces[id].primaryEpoch,v:b.spaces[id].replicaConfigVersion,d:b.spaces[id].durability,r:b.spaces[id].role},{e:2,v:3,d:'single',r:'primary'},`permit of ${id} follows`);
  assert.equal(b.spaces[def.spaceId].dataIncarnation,def.incarnation,'a sibling keeps its own incarnation');
  // 5. Every control path uses the journal epoch: guard, lease and hello.
  home.storage=async()=>primarySyncStorage(await raw(),journal,null,{assertPrimary:assertSyncPrimary(reg,'a',journal)});
  for(const sp of [control,def]){const p=(await reg.get<any>('boot:a'))!.value.spaces[sp.spaceId],cur=await installed.get(`installed:a:${sp.spaceId}`);await installed.compareAndSet(`installed:a:${sp.spaceId}`,cur!.version,p);}
  h=await home.open();stop=installBootGuard(h,ctx,{hostId:'a',authorityId:'authority',external:reg,installed,replicaConfig:()=>journal.config});
  await new PhiSpaces(h,ctx,()=>1000,undefined,undefined,{space:'control'}).write({type:'Command',fields:{n:3}},null,core.FOREVER);
  const router=provisionFileSigner(join(dir,'router.json')),keyDir=new MemoryKeyDirectory();keyDir.add({peerId:'router',keyId:router.keyId,algorithm:router.algorithm,publicKey:router.publicKey!,principal:'router',roles:['router'],scope:['*'],state:'active'});
  let clock=Date.now();const leases=new RouterLeaseAuthority({host:h,ctx,controlSpaceId:control.spaceId,authorityId:'authority',peerId:'a',signer:keys.a,keys:keyDir,assertAuthority:async()=>{},controlEpoch:()=>journal.config.primaryEpoch,now:()=>clock});
  const first=await leases.issue('router',router.keyId);assert.equal(first.lease.controlPrimaryEpoch,2,'the router lease carries the journal epoch');
  // A restarted Root renews its retained lease after the live entry expired: only the signed token proves ownership.
  clock+=120_000;const renewed=await leases.issue('router',router.keyId,{id:first.lease.id,routerEpoch:first.lease.routerEpoch,token:first});
  assert.deepEqual([renewed.lease.id,renewed.lease.routerEpoch,renewed.lease.controlPrimaryEpoch],[first.lease.id,first.lease.routerEpoch,2]);clock=Date.now();
  // The Root's journal guard compares the lease with the same journal epoch (host-a: the Space document still says 1).
  const controller=(controlEpoch?:()=>number)=>createFederationController({host:h,ctx,id:'root',journalPartitions:2,controlSpaceId:control.spaceId,authorityId:'authority',routerPeerId:'router',routerSigner:router,controlPeerId:'a',controlSigner:keys.a,controlPublicKey:keys.a.publicKey,
   transport:()=>{throw new Error('no Member');},memberPin:async()=>{throw new Error('no Member');},lease:()=>leases.issue('router',router.keyId),grant:async()=>{throw new Error('no grant');},assertAuthority:async()=>{},authorizeAdmin:async()=>{},...(controlEpoch?{controlEpoch}:{})});
  await assert.rejects(controller(),/superseded by Control/,'without the journal epoch the guard sees the Space document epoch');
  await controller(()=>journal.config.primaryEpoch);
  stop();await home.close(h);void fenceHostBoot;void assertSyncStandby;
  journal.close();reg.close();installed.close();
 }finally{await listener?.close().catch(()=>{});await home.dispose();rmSync(dir,{recursive:true,force:true});}
});
