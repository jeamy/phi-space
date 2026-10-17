// v3 6.2: after a promotion, an unknown request of an earlier epoch is answered NotCommitted only with promotion
// evidence and a durable negative claim; a late original call meets that claim and has no effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Harness,createRegistry,type Storage} from '@earendil-works/pi-durable';
import {createModels} from '@earendil-works/pi-ai/models';
import {PiSpaces,SpaceService,StaticIdentity,DEFAULT_POLICY,SimulatorFencing,promote,degradeToSingle,PrimarySyncJournal,primarySyncStorage,recoverPrimarySync,assertSyncPrimary,assertSyncStandby,core,type PrimarySyncConfig,type PrimarySyncPeer,type Reply} from '../src/index.ts';
import {SqliteRecoveryRegister} from '../src/recovery-register.ts';
import {promotionEvidence} from '../src/primary-sync.ts';
import * as claims from '../src/claims.ts';
import {createSpace} from '../src/spaces.ts';
import {BACKENDS,PersistentHome,ctx} from './support/persistent.ts';

const INC='0a1b2c3d',config:PrimarySyncConfig={spaceId:'sp-0d7e6f1a-1111-4222-8333-944445555888',authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s'};
const permit=(role:'primary'|'standby')=>({state:'active',authorityId:config.authorityId,dataIncarnation:INC,role,primaryEpoch:1,replicaConfigVersion:1,durability:'sync',transitionId:'genesis'});
const A={peerId:'peer-a'},ids=new StaticIdentity({'peer-a':{principal:A,roles:['member']}});
const ok=(r:Reply):any=>{assert.ok(r.ok,JSON.stringify(r));return (r as {ok:true;result:unknown}).result;};
const code=(r:Reply)=>r.ok?'ok':r.error.code;
const open=async(st:Storage)=>Harness.open(st,{models:createModels(),registry:createRegistry()},ctx);
const writeHash=(n:number)=>claims.argHash('write',{entry:{type:'Work',fields:{n}},txn:null,lease:core.FOREVER} as any);

for(const backend of BACKENDS)for(const created of [false,true])test(`${backend}${created?', created sync Space':''}: a request sealed only on the fenced old primary is NotCommitted on the promoted one; confirmed ones keep their result`,async()=>{
 const pHome=new PersistentHome(backend),sHome=new PersistentHome(backend),register=new SqliteRecoveryRegister(join(pHome.dir,'register.sqlite'));
 await register.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{[config.spaceId]:permit('primary')}});
 await register.compareAndSet('boot:s',null,{hostId:'s',state:'active',spaces:{[config.spaceId]:permit('standby')}});
 const pJournal=new PrimarySyncJournal(join(pHome.dir,'journal.sqlite'),config),sJournal=new PrimarySyncJournal(join(sHome.dir,'journal.sqlite'),config,{self:'s',assertStandby:assertSyncStandby(register,'s')});
 let partitioned=false;const peer:PrimarySyncPeer={accept:async i=>{if(partitioned)throw Error('standby unreachable');return sJournal.accept(i);}};
 try{
  // Epoch 1 on p: r1 is confirmed by the standby, r2 is sealed only on p (the standby is away), then p is lost.
  const pRaw=await pHome.storage();await recoverPrimarySync(pRaw,pJournal,peer,ctx,assertSyncPrimary(register,'p',pJournal));
  const ph=await open(primarySyncStorage(pRaw,pJournal,peer,{assertPrimary:assertSyncPrimary(register,'p',pJournal)}));
  // A Space created like a real primary/sync Space keeps the epoch of its creation in its document.
  if(created)await ph.commit(tx=>createSpace(tx,'jobs',1,{spaceId:config.spaceId,incarnation:INC}),ctx);
  const so=created?{space:'jobs'}:undefined,pc=new PiSpaces(ph,ctx,undefined,undefined,undefined,so),{generation}=await pc.issueGeneration(A,{primaryEpoch:1}),req=(requestId:string)=>({principal:A,generation,requestId});
  const r1=await pc.write({type:'Work',fields:{n:1}},null,core.FOREVER,{request:req('r1')});
  partitioned=true;await assert.rejects(pc.write({type:'Work',fields:{n:2}},null,core.FOREVER,{request:req('r2')}),/sealed/);
  assert.equal(pJournal.head().revision,pJournal.appliedRevision+1,'r2 is a candidate on p only');
  await ph.close(ctx).catch(()=>{});
  // s is promoted with p fenced, then degrades to single (epoch 3).
  const sim=new SimulatorFencing(),base={journal:sJournal,register,hostId:'s',dataIncarnation:INC,ctx,adapter:sim,allowSimulator:true as const};
  let st=await sHome.storage();await promote({...base,storage:st,recoveryId:'promote-s',expectedPrimaryEpoch:1,expectedReplicaConfigVersion:1,proof:await sim.fence('p','primary lost')});await st.close(ctx);
  st=await sHome.storage();await degradeToSingle({...base,storage:st,recoveryId:'degrade-s',expectedPrimaryEpoch:2,expectedReplicaConfigVersion:2,proof:await sim.fence('p','standby gone')});await st.close(ctx);
  assert.equal(sJournal.config.primaryEpoch,3);
  const sRaw=await sHome.storage(),assert_=assertSyncPrimary(register,'s',sJournal);await recoverPrimarySync(sRaw,sJournal,null,ctx,assert_);
  const sh=await open(primarySyncStorage(sRaw,sJournal,null,{assertPrimary:assert_}));
  let evidence=true;
  const service=new SpaceService({host:sh,ctx,identity:ids,policy:DEFAULT_POLICY,epochForSpace:async()=>sJournal.config.primaryEpoch,
   promotionProof:async(_space,epoch)=>evidence?promotionEvidence(sJournal,epoch,'s'):null});
  const resolve=(requestId:string,n:number,primaryEpoch=1)=>service.handle({method:'resolveOperation',...(so??{}),args:{targetRequest:{generation,requestId},method:'write',argumentHash:writeHash(n),primaryEpoch}} as any,{peerId:'peer-a'});
  // Without evidence the outcome stays unknown (the router keeps it for review).
  evidence=false;assert.equal(code(await resolve('r2',2)),'IncarnationChanged');evidence=true;
  // The confirmed request keeps its result across the promotion.
  const v1=ok(await resolve('r1',1));assert.equal(v1.state,'done');assert.deepEqual(v1.result,r1);
  // The request sealed only on p: a durable negative claim, NotCommitted.
  const v2=ok(await resolve('r2',2));assert.equal(v2.state,'done');assert.equal(v2.error.code,'NotCommitted');
  assert.deepEqual(ok(await resolve('r2',2)),v2,'repeatable');
  assert.equal(code(await resolve('r2',3)),'RequestConflict','other arguments under the same request ID');
  // A late original call meets the negative claim: no effect, ever.
  const sc=new PiSpaces(sh,ctx,undefined,undefined,undefined,so);
  await assert.rejects(sc.write({type:'Work',fields:{n:2}},null,core.FOREVER,{request:req('r2')}),claims.NotCommitted);
  assert.equal(await sc.count({type:'Work',fields:{n:2}}),0);assert.equal(await sc.count({type:'Work',fields:{n:1}}),1);
  const poll=ok(await service.handle({method:'pollOperation',...(so??{}),args:{targetRequest:{generation,requestId:'r2'}}} as any,{peerId:'peer-a'}));assert.equal(poll.error.code,'NotCommitted');
  // A request of the current epoch is not NotCommitted: it stays the plain current-epoch miss (retry the same request).
  const g3=(await sc.issueGeneration(A,{primaryEpoch:3})).generation;
  const v3=ok(await service.handle({method:'resolveOperation',...(so??{}),args:{targetRequest:{generation:g3,requestId:'r9'},method:'write',argumentHash:writeHash(9),primaryEpoch:3}} as any,{peerId:'peer-a'}));
  assert.equal(v3.state,'notAdmitted');
  // A generation of the current epoch cannot claim an earlier one.
  assert.equal(code(await service.handle({method:'resolveOperation',...(so??{}),args:{targetRequest:{generation:g3,requestId:'r8'},method:'write',argumentHash:writeHash(8),primaryEpoch:1}} as any,{peerId:'peer-a'})),'IncarnationChanged');
  // The evidence names every transition since the request's epoch; an epoch the chain does not reach gives none.
  const e=promotionEvidence(sJournal,1,'s')!;assert.deepEqual(e.transitions.map(t=>[t.config.primaryEpoch,t.config.primaryReplica,t.reason]),[[2,'s','promote-s'],[3,'s','degrade-s']]);
  assert.equal(promotionEvidence(sJournal,3,'s'),null);assert.equal(promotionEvidence(sJournal,1,'p'),null,'only the current primary can give it');
  // The old primary never applies its candidate: it is fenced.
  assert.equal(pJournal.appliedRevision+1,pJournal.head().revision);
  await sHome.close(sh);
 }finally{pJournal.close();sJournal.close();register.close();await pHome.dispose();await sHome.dispose();}
});

test('a negative claim needs an admitting generation and uninterrupted history',async()=>{
 const {MemoryStorage}=await import('@earendil-works/pi-durable');const h=await open(new MemoryStorage());let now=1000;
 const c=new PiSpaces(h,ctx,()=>now),proof='a'.repeat(64);
 try{
  const {generation,admitUntil}=await c.issueGeneration(A,{primaryEpoch:1}),r=(requestId:string)=>({principal:A,generation,requestId});
  await assert.rejects(c.resolveNotCommitted(r('x'),'write',writeHash(1),1,1,proof),claims.IncarnationChanged,'not an earlier epoch');
  const {Space}=await import('../src/doc.ts');
  await h.commit(async tx=>{(await tx.doc(Space)).restore={} as any;},ctx);
  await assert.rejects(c.resolveNotCommitted(r('x'),'write',writeHash(1),1,2,proof),claims.IncarnationChanged,'a restore interrupted the history');
  await h.commit(async tx=>{delete (await tx.doc(Space)).restore;},ctx);
  now=admitUntil+1;await assert.rejects(c.resolveNotCommitted(r('x'),'write',writeHash(1),1,2,proof),claims.RequestExpired,'the generation no longer admits: RequestExpired, never NotCommitted');
 }finally{await h.close(ctx);}
});
