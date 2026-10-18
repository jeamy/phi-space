// A sealed, unconfirmed primary/sync commit (docs/ap3-primary-sync.md, v3 6.2/7.2): clients see CommitSealed and keep
// asking about the same request; the host resolves the candidate with the standby and serves the Space again.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {openSyncSpace,provisionFileSigner,SpaceService,StaticIdentity,DEFAULT_POLICY,RemoteSpace,inProcessTransport,OutcomeUnknown,PhiSpaces,core,type SyncSpace,type PrimarySyncConfig,type Reply,type Connection} from '../src/index.ts';
import {SqliteRecoveryRegister} from '../src/recovery-register.ts';
import {CommitSealedPending} from '../src/remote.ts';
import {sealedResolver,sealedCandidateOf,type SealedSyncSpace} from '../src/sync-spaces.ts';
import {sealedReply} from '../src/service.ts';
import {ctx,freePort} from './support/persistent.ts';

const ids=new StaticIdentity({'peer-a':{principal:{peerId:'peer-a'},roles:['member']}});
type Svc={handleText(t:string,c:Connection):Promise<string>};

async function fixture(fn:(o:{open:(h:'p'|'s')=>Promise<SyncSpace>;reg:SqliteRecoveryRegister;spaceId:string;slowStandby:(on:boolean)=>void})=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'commit-sealed-')),reg=new SqliteRecoveryRegister(join(dir,'external.sqlite')),port=await freePort();
 const keys={p:provisionFileSigner(join(dir,'p.json')),s:provisionFileSigner(join(dir,'s.json'))},ip={p:'127.0.0.2',s:'127.0.0.3'};
 const spaceId='sp-0c7e6f1a-1111-4222-8333-944445555777',incarnation='0a1b2c3e',authorityId='authority';
 const genesis:PrimarySyncConfig={spaceId,authorityId,primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'s',durability:'sync'};
 const permit=(role:'primary'|'standby')=>({state:'active',authorityId,dataIncarnation:incarnation,role,primaryEpoch:1,replicaConfigVersion:1,durability:'sync',transitionId:'provisioned'});
 await reg.compareAndSet('boot:p',null,{hostId:'p',state:'active',spaces:{[spaceId]:permit('primary')}});await reg.compareAndSet('boot:s',null,{hostId:'s',state:'active',spaces:{[spaceId]:permit('standby')}});
 // The standby checks its permit before every ACK: slowing that check widens the window of a commit in flight.
 let slow=false;const slowReg={get:async(k:string)=>{if(slow)await new Promise(r=>setTimeout(r,300));return reg.get(k);},compareAndSet:(k:string,e:number|null,v:any)=>reg.compareAndSet(k,e,v)} as unknown as SqliteRecoveryRegister;
 const installed={p:new SqliteRecoveryRegister(join(dir,'installed-p.sqlite')),s:new SqliteRecoveryRegister(join(dir,'installed-s.sqlite'))};
 const open=(h:'p'|'s')=>openSyncSpace({config:{alias:'jobs-sync',spaceId,incarnation,dir:join(dir,h,'sync'),genesis,port,peers:[{hostId:h==='p'?'s':'p',algorithm:'ed25519',publicKey:keys[h==='p'?'s':'p'].publicKey,ip:ip[h==='p'?'s':'p']}]},
  hostId:h,authorityId,bindIp:ip[h],signer:keys[h],external:h==='s'?slowReg:reg,installed:installed[h],ctx,
  openStorage:async path=>openNodeSqliteStorage(path),openHarness:async st=>Harness.open(st,{models:createModels(),registry:createRegistry()},ctx)});
 try{await fn({open,reg,spaceId,slowStandby:on=>{slow=on;}});}finally{reg.close();installed.p.close();installed.s.close();rmSync(dir,{recursive:true,force:true});}
}
/** What the federation host does: the served service of the Space, swapped by the resolver. */
function host(p:()=>SyncSpace){
 let current:Svc;
 const resolver=sealedResolver<{host:Harness}>({retryMs:30,maxRetryMs:120,log:()=>{},serve:sp=>({host:sp.harness!}),
  set:async next=>{current='sealed' in next?sealed(next):served(next.host);}});
 const sealed=(u:SealedSyncSpace):Svc=>({handleText:async(_t,conn)=>JSON.stringify(await ids.authenticate(conn)?sealedReply(u.sealed):{ok:false,error:{code:'Unauthenticated',message:''}} as Reply)});
 const served=(h:Harness):Svc=>new SpaceService({host:h,ctx,identity:ids,policy:DEFAULT_POLICY,onSealed:()=>void resolver.resolve(p()),sealedCandidate:()=>sealedCandidateOf(p())});
 current=served(p().harness!);
 const remote=new RemoteSpace(inProcessTransport({handleText:(t,c)=>current.handleText(t,c)},{peerId:'peer-a'}),{space:'jobs-sync',attempts:1,backoffMs:1,sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,30)))});
 return {remote,resolver};
}
const until=async(f:()=>Promise<boolean>,what:string)=>{for(let n=0;n<200;n++){if(await f())return;await new Promise(r=>setTimeout(r,25));}assert.fail(`timed out: ${what}`);};

test('a sealed write answers CommitSealed; poll, retry and cancel stay pending; the host resolves it once the standby is back',()=>fixture(async o=>{
 let s:SyncSpace|undefined=await o.open('s'),p:SyncSpace|undefined=await o.open('p');
 try{
  const {remote,resolver}=host(()=>p!);
  await remote.write({type:'Job',fields:{n:1}},null,core.FOREVER);
  const generation=(await remote.requestGeneration()).generation,request={principal:{peerId:'peer-a'},generation,requestId:'w2'};
  await s.close();s=undefined;// the standby stops answering: the next commit is sealed, not confirmed
  const sealed=await remote.write({type:'Job',fields:{n:2}},null,core.FOREVER,{request}).then(()=>null,e=>e);
  assert.ok(sealed instanceof CommitSealedPending&&sealed instanceof OutcomeUnknown,`CommitSealed, not Internal: ${sealed}`);
  assert.deepEqual(sealed.request,{generation,requestId:'w2'},'the same request stays the one to resolve');
  assert.ok(sealedCandidateOf(p),'one candidate is sealed');
  await assert.rejects(remote.pollOperation(request),CommitSealedPending);
  await assert.rejects(remote.write({type:'Job',fields:{n:2}},null,core.FOREVER,{request}),CommitSealedPending);
  await assert.rejects(remote.cancelOperation(request,{request:{principal:{peerId:'peer-a'},generation,requestId:'c2'}}),CommitSealedPending,'cancel cannot decide a sealed candidate');
  await assert.rejects(remote.write({type:'Job',fields:{n:3}},null,core.FOREVER),CommitSealedPending,'new work waits as well');
  // A blocking take waits through the sealed phase and completes afterwards with the same request.
  const take=remote.take({type:'Job',fields:{n:1}},core.FOREVER);
  s=await o.open('s');
  await until(async()=>!!p!.harness&&!sealedCandidateOf(p!),'the resolver serves the Space again');
  const lease=await remote.write({type:'Job',fields:{n:2}},null,core.FOREVER,{request});
  assert.ok(lease,'the retry returns the original result');
  assert.equal((await remote.pollOperation(request)).state,'done');
  assert.equal((await take)?.fields.n,1,'the waiting take finished');
  const jobs=new PhiSpaces(p.harness!,ctx,Date.now,undefined,undefined,{space:'jobs-sync'});
  assert.equal(await jobs.count({type:'Job',fields:{n:2}}),1,'the sealed write took effect exactly once');
  assert.deepEqual(s.journal.head(),p.journal.head(),'the standby holds the candidate');
  await resolver.stop();
 }finally{await p?.close().catch(()=>{});await s?.close().catch(()=>{});}
}));

test('a host fenced while its candidate is unresolved stops trying and never applies it',()=>fixture(async o=>{
 let s:SyncSpace|undefined=await o.open('s');const p=await o.open('p');
 try{
  const {remote,resolver}=host(()=>p);
  await remote.write({type:'Job',fields:{n:1}},null,core.FOREVER);
  await s.close();s=undefined;
  await assert.rejects(remote.write({type:'Job',fields:{n:2}},null,core.FOREVER),CommitSealedPending);
  const head=p.journal.head().revision,applied=p.journal.appliedRevision;
  const b=(await o.reg.get<any>('boot:p'))!;await o.reg.compareAndSet('boot:p',b.version,{...b.value,state:'fenced'});
  s=await o.open('s');// the standby is back, but this host may no longer apply anything
  await resolver.resolve(p);// returns once the loop has ended
  assert.equal(p.harness,undefined);assert.equal(p.journal.appliedRevision,applied);assert.equal(p.journal.head().revision,head);
  assert.equal((await p.resolve()).state,'excluded');
  await assert.rejects(remote.pollOperation({generation:'g',requestId:'x'}),CommitSealedPending,'still answered as unresolved');
  await resolver.stop();
 }finally{await p.close().catch(()=>{});await s?.close().catch(()=>{});}
}));

test('a primary starting with an unresolved candidate and no standby stays unserved, then serves once the standby returns',()=>fixture(async o=>{
 let s:SyncSpace|undefined=await o.open('s'),p:SyncSpace|undefined=await o.open('p');
 try{
  const {remote}=host(()=>p!);
  await remote.write({type:'Job',fields:{n:1}},null,core.FOREVER);
  const request={principal:{peerId:'peer-a'},generation:(await remote.requestGeneration()).generation,requestId:'w2'};
  await s.close();s=undefined;// (issuing a generation is a commit too, so it comes first)
  await assert.rejects(remote.write({type:'Job',fields:{n:2}},null,core.FOREVER,{request}),CommitSealedPending);
  await p.close();p=undefined;
  p=await o.open('p');assert.equal(p.harness,undefined,'no Harness while the candidate is unresolved');assert.ok(sealedCandidateOf(p));
  assert.equal((await p.resolve()).state,'pending','the standby is still away');
  s=await o.open('s');assert.equal((await p.resolve()).state,'served');
  const jobs=new PhiSpaces(p.harness!,ctx,Date.now,undefined,undefined,{space:'jobs-sync'});
  assert.equal(await jobs.count({type:'Job',fields:{n:2}}),1,'the candidate was applied after the restart');
 }finally{await p?.close().catch(()=>{});await s?.close().catch(()=>{});}
}));

test('a commit in flight is not a sealed candidate: concurrent reads and polls are served normally',()=>fixture(async o=>{
 const s=await o.open('s'),p=await o.open('p');
 try{
  const {remote,resolver}=host(()=>p);const harness=p.harness;
  const request={principal:{peerId:'peer-a'},generation:(await remote.requestGeneration()).generation,requestId:'w1'};
  await remote.write({type:'Job',fields:{n:1}},null,core.FOREVER,{request});
  o.slowStandby(true);
  const inFlight=remote.write({type:'Job',fields:{n:2}},null,core.FOREVER);
  await new Promise(r=>setTimeout(r,60));
  assert.notEqual(p.journal.head().revision,p.journal.appliedRevision,'the second commit is sealed and waits for its ACK');
  for(let n=0;n<4;n++){
   assert.equal(await remote.count({type:'Job'}),1);
   assert.equal((await remote.readAll({type:'Job'})).length,1);
   assert.equal((await remote.pollOperation(request)).state,'done');
  }
  await inFlight;o.slowStandby(false);
  assert.equal(await remote.count({type:'Job'}),2);assert.equal(p.harness,harness,'still served on the same Harness');assert.equal(p.sealed(),null);
  await resolver.stop();
 }finally{await p.close().catch(()=>{});await s.close().catch(()=>{});}
}));
