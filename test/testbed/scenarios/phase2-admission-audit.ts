// Read-only acceptance audit: copy closed fixture SQLite stores; never open originals for writing.
import {journalTransitions} from './journal-checkpoints.ts';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as ctx} from '../../../src/context.ts';
import {core,claims,canonicalJson,principalId,RouterJournal,RouterController,FederationOperations,partitionRouterId,parentJournalKey,snapshotSpace,type RouterStep,type FederationOperation,type MailboxState} from '../../../src/index.ts';
import {rpcDomain} from '../../../src/rpc-domain.ts';
const fixture=process.argv[2]!,output=process.argv[3]!;
const config=JSON.parse(readFileSync(join(fixture,'shared/config.json'),'utf8')),report=JSON.parse(readFileSync(join(fixture,'shared/netbird-sieve.json'),'utf8'));
assert.equal(report.passed,true);
const allFaults=report.memberProcessCrashesExercised?report.memberProcessCrashes:report.processCrashesExercised?report.processCrashes:report.faults;
const ackFaults=allFaults.filter((f:any)=>f.effect==='ack'),journalFaults=allFaults.filter((f:any)=>f.effect==='journal'),faultedRequests=allFaults.filter((f:any)=>!['ack','journal'].includes(f.effect)),readProbes=(report.ackProbes??[]).filter((p:any)=>p.kind==='read'),probes=(report.ackProbes??[]).filter((p:any)=>p.kind!=='read');
const expectedFaults=report.journalCommitCrashesExercised?0:report.memberProcessCrashesExercised?30:report.mailboxAckFaultsExercised?0:report.processCrashesExercised?(report.processCrashEffects??[report.processCrashEffect]).length*report.processCrashMembers.length*(report.processCrashBoundary==='both'?2:1):30;
if(!report.processCrashesExercised&&!report.memberProcessCrashesExercised)assert.equal(report.rpcFaultBoundary,'both');
assert.equal(faultedRequests.length,expectedFaults);
if(report.mailboxAckFaultsExercised){assert.equal(ackFaults.length,6);assert.equal(probes.length,6);}
const hosts:Harness[]=[];
async function copyStore(name:string){const dir=join('/tmp',name);mkdirSync(dir,{recursive:true});for(const suffix of ['','-wal','-shm']){const from=join(fixture,name,'harness.sqlite'+suffix);if(existsSync(from))copyFileSync(from,join(dir,'harness.sqlite'+suffix));}const host=await Harness.open(await openNodeSqliteStorage(join(dir,'harness.sqlite')),{models:createModels(),registry:createRegistry()},ctx);hosts.push(host);return host;}
try{
 const root=await copyStore('root'),readOnlyRoot=new Proxy(root,{get(target,property){if(property==='commit')return()=>{throw new Error('audit must never commit');};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}}),steps=new Map<string,RouterStep>(),parentRecords=new Map<string,Readonly<FederationOperation>>();let parents=0,commands=0;
 for(let n=0;n<1024;n++){
  const id=partitionRouterId('ap2-netbird',n),index=await root.snapshot(RouterJournal,id,ctx);if(index)assert.equal(index.authorityId,config.authorityId);
  assert.equal(Object.keys(index?.future??{}).length,0,'unused future reservations must be released');
  const journal=await root.snapshot(FederationOperations,parentJournalKey('ap2-netbird',1024,n),ctx);
  for(const parent of Object.values(journal?.operations??{})){assert.equal(parent.phase,'done');parentRecords.set(parent.id,parent);parents++;}
  const router=new RouterController({host:readOnlyRoot,ctx,routerId:id,authorityId:config.authorityId,target:{protocol:'phi-spaces-rpc-v1',invoke:async()=>{throw new Error('audit must never send');},resolve:async()=>{throw new Error('audit must never resolve');}},assertAuthority:async()=>{}});
  for(const [id,ref] of Object.entries(index?.refs??{})){assert.equal(ref.state,'completed');const command=await router.get(id);assert.ok(command);assert.equal(command.hash,ref.hash);assert.equal(command.state,'completed');commands++;for(const step of command.steps){assert.equal(step.state,'done');const key=JSON.stringify([step.target.hostId,step.generation,step.requestId]);assert.equal(steps.has(key),false);steps.set(key,step);}}
 }
 assert.equal(parents,config.jobs*5+probes.length*4+readProbes.length);assert.equal(commands,config.jobs*5+probes.length*12+readProbes.length*3);
 const checkedJournals:any[]=[];
 if(report.journalCommitCrashesExercised){
  assert.equal(journalFaults.length,report.journalCrashKinds.length*2);
  assert.equal(new Set(journalFaults.map((f:any)=>f.kind+':'+f.boundary)).size,journalFaults.length);
  for(const fault of journalFaults){
   const parent=parentRecords.get(fault.parentId);assert.ok(parent);const cid=(label:string)=>'f-'+createHash('sha256').update(canonicalJson([fault.parentId,label])).digest('hex'),childIds=new Set(['initial:a','initial:b','initial:c','winner-commit','cancel:a','cancel:b','cancel:c','abort:a','abort:b','abort:c'].map(cid));
   const wrap=(v:any)=>fault.documentKind==='phi-spaces.federation-operations'?{operations:{[fault.parentId]:v}}:fault.documentKind==='phi-spaces.router-command'?{command:v}:{future:v?.future?{[fault.budgetId]:v.future}:{}};
   assert.ok(journalTransitions(fault.documentKind,wrap(fault.before),wrap(fault.plannedAfter),fault.parentId,childIds,fault.budgetId).includes(fault.kind));
   assert.equal(fault.commitSeq===null,fault.boundary==='beforeCommit');if(fault.boundary==='afterCommit')assert.ok(Number.isSafeInteger(fault.commitSeq)&&fault.commitSeq>0);
   if(fault.documentKind==='phi-spaces.federation-operations'){
    assert.equal(parent.hash,fault.plannedAfter.hash);assert.deepEqual(parent.principal,fault.plannedAfter.principal);assert.deepEqual(parent.targets,fault.plannedAfter.targets);
    if(fault.kind==='candidate'&&fault.boundary==='afterCommit')for(const [key,candidate]of Object.entries(fault.plannedAfter.candidates))assert.deepEqual(parent.candidates[key],candidate);
    if(fault.kind==='winner')assert.deepEqual(parent.winner,fault.plannedAfter.winner);
   }
   if(fault.documentKind==='phi-spaces.router-command'&&!(fault.kind==='childAcceptance'&&fault.boundary==='beforeCommit'))for(const old of fault.plannedAfter.steps){
    const actual=steps.get(JSON.stringify([old.target.hostId,old.generation,old.requestId]));assert.ok(actual,'durably accepted Child must keep the original request');for(const field of ['target','principal','method','args','argHash','generation','requestId'])assert.deepEqual((actual as any)[field],old[field]);
   }
   checkedJournals.push({kind:fault.kind,boundary:fault.boundary,parentId:fault.parentId,commitSeq:fault.commitSeq,originalParentPlanPreserved:true});
  }
 }
 for(const probe of readProbes){const p=parentRecords.get(probe.parentId);assert.ok(p);assert.equal(p.phase,'done');assert.equal(p.result,null);}
 let allClaimsChecked=0;
 const checkedAcks:Array<{member:string;boundary:string;parentId:string;claimState:string;durableCandidatePreserved:boolean}>=[];
 const checked:Array<{member:string;boundary:string;requestId:string;claimState:string}>=[];
 for(const member of config.members){
  const host=await copyStore(member.id),target=JSON.parse(readFileSync(join(fixture,'shared',member.id+'.json'),'utf8')),space=await snapshotSpace(host,target.spaceId,ctx);assert.ok(space);
  assert.equal(Object.keys(space.txns).length,0,'closed Member must have no active transactions');
  for(const step of [...steps.values()].filter(step=>step.target.hostId===member.hostId)){
   assert.deepEqual(step.target,target);
   const reference={principal:step.principal,generation:step.generation,requestId:step.requestId};
   const claim:claims.ClaimRec|undefined=space.rpc?.claims[claims.keyOf(space,reference)];assert.ok(claim,'every original journaled request must have a retained Member claim');
   const domain=rpcDomain({method:step.method,args:step.args as any},step.principal);
   assert.equal(claim.method,domain.method);assert.equal(claim.argHash,claims.argHash(domain.method,domain.args));assert.equal(claim.state,'done');assert.equal(claim.error,undefined);assert.equal(claim.policyVersion,1);assert.deepEqual(claim.principal,step.principal);
   const generation:claims.GenerationRec|undefined=space.rpc!.generations[step.generation];assert.ok(generation);claims.validateGeneration(space,generation.issuedAt,reference);assert.equal(generation.spaceId,target.spaceId);assert.equal(generation.incarnation,target.dataIncarnation);assert.equal(generation.authorityId,target.authorityId);assert.equal(generation.primaryEpoch,target.primaryEpoch);allClaimsChecked++;
  }
  for(const fault of ackFaults.filter((f:any)=>f.member===member.id)){
   assert.deepEqual(fault.target,target);
   const parent=parentRecords.get(fault.parentId);assert.ok(parent);assert.equal(parent.kind,'race');assert.equal(parent.phase,'done');assert.deepEqual(parent.principal,fault.principal);
   const key=createHash('sha256').update(canonicalJson([member.id,fault.mailboxEpoch,fault.upTo])).digest('hex');assert.equal(key,fault.candidateKey);assert.deepEqual(parent.candidates[key],fault.candidate,'candidate preceding ACK must remain durable');
   const probe=probes.find((p:any)=>p.parentId===fault.parentId);assert.ok(probe);assert.deepEqual(parent.result,probe.winner);assert.equal(probe.winner.fields.member,'a');assert.equal(probe.replayStable,true);
   const reference={principal:fault.principal,generation:fault.generation,requestId:fault.requestId},domain=rpcDomain({method:'ack',args:{mailboxEpoch:fault.mailboxEpoch,upTo:fault.upTo}},fault.principal);
   assert.equal(fault.argumentHash,claims.argHash(domain.method,domain.args));
   const generation:claims.GenerationRec|undefined=space.rpc?.generations[fault.generation];assert.ok(generation);claims.validateGeneration(space,generation.issuedAt,reference);assert.equal(generation.primaryEpoch,target.primaryEpoch);
   const claim:claims.ClaimRec|undefined=space.rpc?.claims[claims.keyOf(space,reference)];
   if(fault.boundary==='beforeSend')assert.equal(claim,undefined,'pre-send ACK request was never admitted');
   else{assert.ok(claim);assert.equal(claim.state,'done');assert.equal(claim.error,undefined);assert.equal(claim.method,'ack');assert.equal(claim.argHash,fault.argumentHash);assert.deepEqual(claim.principal,fault.principal);}
   const box:MailboxState['boxes'][string]|undefined=space.mailboxes?.boxes[principalId(fault.principal)];assert.ok(box);assert.equal(box.epoch,fault.mailboxEpoch);assert.ok(box.acked>=fault.upTo);assert.equal(box.events.length,0);assert.equal(box.gap,undefined);
   checkedAcks.push({member:member.id,boundary:fault.boundary,parentId:fault.parentId,claimState:claim?.state??'notAdmitted',durableCandidatePreserved:true});
  }
  for(const probe of probes){
   const parent=parentRecords.get(probe.parentId)!;const box:MailboxState['boxes'][string]|undefined=space.mailboxes?.boxes[principalId(parent.principal)];assert.ok(box);assert.equal(box.events.length,0);assert.equal(box.gap,undefined);
   const entries:core.EntryRec[]=space.entries.filter(e=>e.type==='AckProbe'&&e.fields.probeId===probe.probeId);assert.equal(entries.length,member.id==='a'?0:1);for(const e of entries){assert.equal(e.takenBy,null);assert.equal(e.writtenUnder,null);}
  }
  for(const fault of journalFaults.filter((f:any)=>f.kind==='childAcceptance'&&f.boundary==='beforeCommit'))for(const step of fault.plannedAfter.steps.filter((s:any)=>s.target.hostId===member.hostId)){
   const abandonedClaim:claims.ClaimRec|undefined=space.rpc?.claims[claims.keyOf(space,{principal:step.principal,generation:step.generation,requestId:step.requestId})];assert.equal(abandonedClaim,undefined,'a Child interrupted before durable admission must never dispatch its abandoned original request');
  }
  for(const fault of faultedRequests.filter((f:any)=>f.member===member.id)){
   const step=steps.get(JSON.stringify([member.hostId,fault.generation,fault.requestId]));assert.ok(step,'faulted request must remain in its original completed journal');assert.deepEqual(step.target,target);if(report.memberProcessCrashesExercised){assert.deepEqual(fault.target,target);assert.deepEqual(fault.principal,step.principal);assert.equal(fault.claimState,fault.boundary==='beforeHandle'?'notAdmitted':'done');}
   const reference={principal:step.principal,generation:fault.generation,requestId:fault.requestId};const claim:claims.ClaimRec|undefined=space.rpc?.claims[claims.keyOf(space,reference)];assert.ok(claim,'original request must have a retained claim on original Member');
   const domain=rpcDomain({method:step.method,args:step.args as any},step.principal);assert.equal(claim.method,domain.method);assert.equal(claim.argHash,claims.argHash(domain.method,domain.args));if(report.memberProcessCrashesExercised)assert.equal(claim.argHash,fault.argumentHash);assert.equal(claim.state,'done');assert.equal(claim.policyVersion,1);assert.deepEqual(claim.principal,step.principal);assert.equal(claim.principal.peerId,report.routerPeerId);
   const generation:claims.GenerationRec|undefined=space.rpc!.generations[fault.generation];assert.ok(generation);claims.validateGeneration(space,generation.issuedAt,reference);assert.equal(generation.spaceId,target.spaceId);assert.equal(generation.incarnation,target.dataIncarnation);assert.equal(generation.authorityId,target.authorityId);assert.equal(generation.primaryEpoch,target.primaryEpoch);
   checked.push({member:member.id,boundary:fault.boundary,requestId:fault.requestId,claimState:claim.state});
  }
 }
 assert.equal(allClaimsChecked,config.jobs*5+probes.length*12+readProbes.length*3);assert.equal(checkedAcks.length,ackFaults.length);assert.equal(checked.length,expectedFaults);writeFileSync(output,JSON.stringify({passed:true,scope:'closed fixture journal and Member claim audit on private copies',sourceStoresOpenedReadOnly:true,parents,commands,allParentsAndChildrenDone:true,unusedFutureReservations:0,allOriginalClaimsChecked:allClaimsChecked,ackBoundariesChecked:checkedAcks.length,checkedAcks,journalBoundariesChecked:checkedJournals.length,checkedJournals,faultedClaimsChecked:checked.length,originalTargetIdentityAndArgumentHashesPreserved:true,checked},null,2)+'\n');console.log(JSON.stringify({passed:true,parents,commands,allOriginalClaimsChecked:allClaimsChecked,ackBoundariesChecked:checkedAcks.length,checkedAcks,journalBoundariesChecked:checkedJournals.length,checkedJournals,faultedClaimsChecked:checked.length}));
}finally{for(const host of hosts)await host.close(ctx);}
