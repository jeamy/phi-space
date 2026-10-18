import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {copyFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {PrimarySyncJournal,PrimarySyncBlocked,CommitSealed,primarySyncStorage,recoverPrimarySync,materializeSyncHistory,PiSpaces,Space,core,type PrimarySyncPeer,type PrimaryCommitIntent,type PrimarySyncConfig} from '../src/index.ts';
import {canonicalJson} from '../src/canonical.ts';
import {SpaceService,StaticIdentity,DEFAULT_POLICY,RemoteSpace,inProcessTransport} from '../src/index.ts';
import {SyncBudgetExceeded} from '../src/commit-sealed.ts';
import {BACKENDS,PersistentHome,ctx} from './support/persistent.ts';
const config:PrimarySyncConfig={spaceId:'sync-space',authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s'};
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
for(const backend of BACKENDS){
 for(const failure of ['beforeAccept','lostAck','beforeData','lostDataAnswer'] as const)test(`${backend}: full sync ${failure} recovers the immutable sealed batch before new work, including claims and root`,async()=>{
  const home=new PersistentHome(backend),standbyHome=new PersistentHome(backend),raw=home.storage.bind(home);
  let primary=new PrimarySyncJournal(join(home.dir,'sync-journal.sqlite'),config),standby=new PrimarySyncJournal(join(standbyHome.dir,'sync-journal.sqlite'),config);let fault=false,active=true;
  const assertPrimary=async()=>{if(!active)throw new PrimarySyncBlocked('fenced');};
  const peer:PrimarySyncPeer={accept:async i=>{if(fault&&failure==='beforeAccept'){fault=false;throw Error('network unavailable');}const ack=await standby.accept(i);if(fault&&failure==='lostAck'){fault=false;throw Error('lost standby ACK');}return ack;}};
  home.storage=async()=>{const storage=await raw();await recoverPrimarySync(storage,primary,peer,ctx,assertPrimary);return primarySyncStorage(storage,primary,peer,{assertPrimary});};
  let host=await home.open();const client=()=>new PiSpaces(host,ctx);
  try{
   const {generation}=await client().issueGeneration({peerId:'subject'});const request={principal:{peerId:'subject'},generation,requestId:'confirmed-write'};
   assert.ok(primary.head().revision>=1,'initial documents are part of the replicated storage history');const before=primary.head().revision;
   if(failure==='beforeData')home.faults.arm('failBeforeCommit');else if(failure==='lostDataAnswer')home.faults.arm('loseAnswer');else fault=true;
   await assert.rejects(client().write({type:'Job',fields:{n:1}},null,core.FOREVER,{request}),CommitSealed);
   assert.equal(primary.head().revision,before+1);assert.equal(primary.appliedRevision,before);
   const sealed=primary.intent(before+1)!;assert.ok(sealed.deltas.some(w=>w.type.startsWith('document.')));
   await assert.rejects(client().write({type:'Job',fields:{n:2}}),/poisoned|resolve sealed/);
   // Authorization/deadlines of the sealed business decision are not reevaluated during recovery.
   await home.close(host);primary.close();standby.close();primary=new PrimarySyncJournal(join(home.dir,'sync-journal.sqlite'),config);standby=new PrimarySyncJournal(join(standbyHome.dir,'sync-journal.sqlite'),config);
   host=await home.open();assert.deepEqual(primary.intent(before+1),sealed);assert.equal(primary.appliedRevision,primary.head().revision);
   const lease=await client().write({type:'Job',fields:{n:1}},null,core.FOREVER,{request});assert.equal(await client().count({type:'Job'}),1);assert.equal((await client().pollOperation(request)).state,'done');
   assert.deepEqual(await client().write({type:'Job',fields:{n:1}},null,core.FOREVER,{request}),lease);
   await client().write({type:'Job',fields:{n:2}},null,core.FOREVER);
   // Every accepted decision, including claim replay and all singleton/family documents, is reconstructible.
   const standbyRaw=await standbyHome.storage();await materializeSyncHistory(standbyRaw,standby,ctx);await standbyRaw.close(ctx);const sh=await standbyHome.open();
   assert.deepEqual(await sh.snapshot(Space,ctx),await host.snapshot(Space,ctx));assert.equal(await new PiSpaces(sh,ctx).count({type:'Job'}),2);
   const transactions=await client().createTransaction(10000);await client().write({type:'Result',fields:{n:3}},transactions.id,core.FOREVER);await client().commit(transactions.id);
   // A stopped storage replica must be reopened after applying additional complete history.
   await standbyHome.close(sh);const sr=await standbyHome.storage();await materializeSyncHistory(sr,standby,ctx);await sr.close(ctx);const sh2=await standbyHome.open();assert.deepEqual(await sh2.snapshot(Space,ctx),await host.snapshot(Space,ctx));
   active=false;await assert.rejects(client().write({type:'Denied',fields:{}}),/fenced/);
  }finally{primary.close();standby.close();await home.dispose();await standbyHome.dispose();}
 });
 test(`${backend}: standby rejects gaps, forks, wrong configuration and false ACKs; accepted decisions survive journal reopen`,async()=>{
  const home=new PersistentHome(backend),standbyHome=new PersistentHome(backend),primary=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),config);let standby=new PrimarySyncJournal(join(standbyHome.dir,'journal.sqlite'),config),badAck=false;
  const raw=home.storage.bind(home);home.storage=async()=>primarySyncStorage(await raw(),primary,{accept:async i=>{const a=await standby.accept(i);return badAck?{...a,hash:'0'.repeat(64)}:a;}},{assertPrimary:async()=>{}});
  const host=await home.open();await new PiSpaces(host,ctx).issueGeneration({peerId:'subject'});const baseline=await host.snapshot(Space,ctx),applied=primary.appliedRevision;
  try{
   const first=primary.intent(1)!;assert.deepEqual(await standby.accept(first),{revision:1,hash:first.hash,configHash:primary.configHash});
   const changed=structuredClone(first);changed.validatedAt++;const {hash:_,...body}=changed;changed.hash=digest(body);await assert.rejects(standby.accept(changed),/immutable/);
   const gap=structuredClone(first);gap.revision=3;const marker=gap.deltas.at(-1)!;if(marker.type==='document.create'&&marker.content.kind==='base')marker.content.value.revision=3;const {hash:__,...g}=gap;gap.hash=digest(g);await assert.rejects(standby.accept(gap),/gap or fork/);
   const wrong={...first,config:{...config,standbyReplica:'other'}};await assert.rejects(standby.accept(wrong),/intent/);
   standby.close();standby=new PrimarySyncJournal(join(standbyHome.dir,'journal.sqlite'),config);assert.equal(standby.head().hash,first.hash);
   assert.throws(()=>new PrimarySyncJournal(join(home.dir,'journal.sqlite'),{...config,primaryEpoch:2}),/configuration changed/);
   badAck=true;await assert.rejects(new PiSpaces(host,ctx).write({type:'NotConfirmed',fields:{}}),CommitSealed);assert.equal(primary.appliedRevision,applied);await assert.rejects(host.snapshot(Space,ctx),/poisoned/);
  }finally{primary.close();standby.close();await home.dispose();await standbyHome.dispose();}
 });
}
for(const backend of BACKENDS){
 for(const fault of ['failBeforeCommit','loseAnswer'] as const)test(`${backend}: standby materialization ${fault} reopens at an exact accepted prefix without duplicating storage effects`,async()=>{
  const home=new PersistentHome(backend),replica=new PersistentHome(backend),p=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),config),s=new PrimarySyncJournal(join(replica.dir,'journal.sqlite'),config),raw=home.storage.bind(home);
  home.storage=async()=>primarySyncStorage(await raw(),p,s,{assertPrimary:async()=>{}});
  try{
   const h=await home.open(),client=new PiSpaces(h,ctx);await client.write({type:'Work',fields:{n:1}},null,core.FOREVER);await client.write({type:'Work',fields:{n:2}},null,core.FOREVER);
   let storage=await replica.storage();replica.faults.arm(fault);await assert.rejects(materializeSyncHistory(storage,s,ctx));await storage.close(ctx);
   storage=await replica.storage();await materializeSyncHistory(storage,s,ctx);await storage.close(ctx);const sh=await replica.open();
   assert.equal(s.appliedRevision,s.head().revision);assert.deepEqual(await sh.snapshot(Space,ctx),await h.snapshot(Space,ctx));
  }finally{p.close();s.close();await home.dispose();await replica.dispose();}
 });
 test(`${backend}: sync refuses a preexisting untracked domain, corrupted data marker, failed callback and oversized unsealed batch`,async()=>{
  const home=new PersistentHome(backend),replica=new PersistentHome(backend),p=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),config),s=new PrimarySyncJournal(join(replica.dir,'journal.sqlite'),config),raw=home.storage.bind(home);
  home.storage=async()=>primarySyncStorage(await raw(),p,s,{assertPrimary:async()=>{}});let h=await home.open();
  try{
   await assert.rejects(h.commit(async()=>{throw Error('decision validation failed');},ctx),/validation failed/);assert.equal(p.head().revision,0);
   await new PiSpaces(h,ctx).write({type:'Seed',fields:{n:1}},null,core.FOREVER);const revision=p.head().revision;await home.close(h);
   // Reopening with an empty journal must not turn existing application state into an unexplained base.
   const empty=new PrimarySyncJournal(join(home.dir,'empty-journal.sqlite'),config),storage=await raw();
   await assert.rejects(recoverPrimarySync(storage,empty,s,ctx,async()=>{}),/untracked/);empty.close();
   const marker=await storage.findDocument({kind:'pi-spaces.primary-sync-storage-marker',key:config.spaceId,scope:{kind:'session'}},'current',ctx);assert.ok(marker);
   const value=(await storage.document(marker.id,'current',ctx))!.value;
   await storage.commit([{type:'document.change',id:marker.id,content:{kind:'base',version:1,value:{...value,revision:9999}}}],ctx);
   await assert.rejects(recoverPrimarySync(storage,p,s,ctx,async()=>{}),/does not match/);await storage.close(ctx);assert.equal(p.head().revision,revision);
   const original=p.intent(1)!,large=structuredClone(original);large.deltas.push(...Array.from({length:30000},()=>original.deltas[0]!));
   await assert.rejects(s.accept(large),/oversized/);assert.equal(s.head().revision,revision);
   const damaged=join(home.dir,'damaged-journal.sqlite');copyFileSync(join(home.dir,'journal.sqlite'),damaged);const db=new DatabaseSync(damaged);db.exec("UPDATE sync_intents SET hash='corrupt' WHERE revision=1");db.close();assert.throws(()=>new PrimarySyncJournal(damaged,config),/index disagrees/);
  }finally{p.close();s.close();await home.dispose();await replica.dispose();}
 });
 test(`${backend}: a full sync history refuses the commit before sealing; the session keeps serving reads and smaller writes`,async()=>{
  const home=new PersistentHome(backend),replica=new PersistentHome(backend),bounds={maxIntentBytes:65_536,maxHistoryBytes:200_000};
  const p=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),config,bounds),s=new PrimarySyncJournal(join(replica.dir,'journal.sqlite'),config,bounds),raw=home.storage.bind(home);
  home.storage=async()=>primarySyncStorage(await raw(),p,s,{assertPrimary:async()=>{}});const h=await home.open();
  try{
   const ids=new StaticIdentity({'peer-a':{principal:{peerId:'peer-a'},roles:['member']}}),svc=new SpaceService({host:h,ctx,identity:ids,policy:DEFAULT_POLICY});
   const r=new RemoteSpace(inProcessTransport({handleText:(t,c)=>svc.handleText(t,c)},{peerId:'peer-a'}),{attempts:1});
   let n=0,refused:unknown;for(;n<1000&&!refused;n++)await r.write({type:'Job',fields:{n,pad:'x'.repeat(2000)}},null,core.FOREVER).catch(e=>{refused=e;});
   assert.ok(refused instanceof core.ResourceExhausted&&/journal: sync history is full/.test(refused.message),`ResourceExhausted, not Internal: ${refused}`);
   assert.deepEqual(s.head(),p.head(),'nothing sealed: no candidate, both replicas equal');assert.equal(p.appliedRevision,p.head().revision);
   await assert.rejects(new PiSpaces(h,ctx).write({type:'Job',fields:{pad:'x'.repeat(2000)}},null,core.FOREVER),SyncBudgetExceeded);
   assert.equal(await r.count({type:'Job'}),n-1,'reads still served');
   await r.write({type:'Small',fields:{}},null,core.FOREVER);assert.deepEqual(s.head(),p.head(),'a write that fits is still confirmed');
  }finally{await home.close(h).catch(()=>{});p.close();s.close();await home.dispose();await replica.dispose();}
 });
 test(`${backend}: a Space larger than a journal commit stays writable past the checkpoint interval and after a reload`,async()=>{
  const home=new PersistentHome(backend),replica=new PersistentHome(backend);
  const p=new PrimarySyncJournal(join(home.dir,'journal.sqlite'),config),s=new PrimarySyncJournal(join(replica.dir,'journal.sqlite'),config),raw=home.storage.bind(home);
  home.storage=async()=>primarySyncStorage(await raw(),p,s,{assertPrimary:async()=>{}});let h=await home.open();
  try{
   // Five entries of 60 KB: the Space document is larger than one journal commit (256 KiB) as a whole.
   for(let n=0;n<5;n++)await new PiSpaces(h,ctx).write({type:'Big',fields:{n,pad:'x'.repeat(60_000)}},null,core.FOREVER);
   for(let n=0;n<520;n++)await new PiSpaces(h,ctx).write({type:'Small',fields:{n}},null,core.FOREVER);
   await home.close(h);h=await home.open();// a reload counts every delta since the last base again
   for(let n=0;n<60;n++)await new PiSpaces(h,ctx).write({type:'Small',fields:{n:1000+n}},null,core.FOREVER);
   assert.equal(await new PiSpaces(h,ctx).count({type:'Small'}),580);assert.deepEqual(s.head(),p.head());
  }finally{await home.close(h).catch(()=>{});p.close();s.close();await home.dispose();await replica.dispose();}
 });
}
