// Read-only acceptance audit: copy closed fixture SQLite stores; never open originals for writing.
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {claims,RouterJournal,RouterController,FederationOperations,partitionRouterId,parentJournalKey,snapshotSpace,type RouterStep} from '../../../src/index.ts';
import {rpcDomain} from '../../../src/rpc-domain.ts';
const fixture=process.argv[2]!,output=process.argv[3]!;
const config=JSON.parse(readFileSync(join(fixture,'shared/config.json'),'utf8')),report=JSON.parse(readFileSync(join(fixture,'shared/netbird-sieve.json'),'utf8'));
assert.equal(report.passed,true);
const faultedRequests=report.processCrashesExercised?report.processCrashes:report.faults;
const expectedFaults=report.processCrashesExercised?(report.processCrashEffects??[report.processCrashEffect]).length*report.processCrashMembers.length*(report.processCrashBoundary==='both'?2:1):30;
if(!report.processCrashesExercised)assert.equal(report.rpcFaultBoundary,'both');
assert.equal(faultedRequests.length,expectedFaults);
const hosts:Harness[]=[];
async function copyStore(name:string){const dir=join('/tmp',name);mkdirSync(dir,{recursive:true});for(const suffix of ['','-wal','-shm']){const from=join(fixture,name,'harness.sqlite'+suffix);if(existsSync(from))copyFileSync(from,join(dir,'harness.sqlite'+suffix));}const host=await Harness.open(await openNodeSqliteStorage(join(dir,'harness.sqlite')),{models:createModels(),registry:createRegistry()},ctx);hosts.push(host);return host;}
try{
 const root=await copyStore('root'),readOnlyRoot=new Proxy(root,{get(target,property){if(property==='commit')return()=>{throw new Error('audit must never commit');};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}}),steps=new Map<string,RouterStep>();let parents=0,commands=0;
 for(let n=0;n<1024;n++){
  const id=partitionRouterId('ap2-netbird',n),index=await root.snapshot(RouterJournal,id,ctx);if(index)assert.equal(index.authorityId,config.authorityId);
  assert.equal(Object.keys(index?.future??{}).length,0,'unused future reservations must be released');
  const journal=await root.snapshot(FederationOperations,parentJournalKey('ap2-netbird',1024,n),ctx);
  for(const parent of Object.values(journal?.operations??{})){assert.equal(parent.phase,'done');parents++;}
  const router=new RouterController({host:readOnlyRoot,ctx,routerId:id,authorityId:config.authorityId,target:{protocol:'pi-spaces-rpc-v1',invoke:async()=>{throw new Error('audit must never send');},resolve:async()=>{throw new Error('audit must never resolve');}},assertAuthority:async()=>{}});
  for(const [id,ref] of Object.entries(index?.refs??{})){assert.equal(ref.state,'completed');const command=await router.get(id);assert.ok(command);assert.equal(command.hash,ref.hash);assert.equal(command.state,'completed');commands++;for(const step of command.steps){assert.equal(step.state,'done');const key=JSON.stringify([step.target.hostId,step.generation,step.requestId]);assert.equal(steps.has(key),false);steps.set(key,step);}}
 }
 assert.equal(parents,config.jobs*5);assert.equal(commands,config.jobs*5);
 let allClaimsChecked=0;
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
  for(const fault of faultedRequests.filter((f:any)=>f.member===member.id)){
   const step=steps.get(JSON.stringify([member.hostId,fault.generation,fault.requestId]));assert.ok(step,'faulted request must remain in its original completed journal');assert.deepEqual(step.target,target);
   const reference={principal:step.principal,generation:fault.generation,requestId:fault.requestId};const claim:claims.ClaimRec|undefined=space.rpc?.claims[claims.keyOf(space,reference)];assert.ok(claim,'original request must have a retained claim on original Member');
   const domain=rpcDomain({method:step.method,args:step.args as any},step.principal);assert.equal(claim.method,domain.method);assert.equal(claim.argHash,claims.argHash(domain.method,domain.args));assert.equal(claim.state,'done');assert.equal(claim.policyVersion,1);assert.deepEqual(claim.principal,step.principal);assert.equal(claim.principal.peerId,report.routerPeerId);
   const generation:claims.GenerationRec|undefined=space.rpc!.generations[fault.generation];assert.ok(generation);claims.validateGeneration(space,generation.issuedAt,reference);assert.equal(generation.spaceId,target.spaceId);assert.equal(generation.incarnation,target.dataIncarnation);assert.equal(generation.authorityId,target.authorityId);assert.equal(generation.primaryEpoch,target.primaryEpoch);
   checked.push({member:member.id,boundary:fault.boundary,requestId:fault.requestId,claimState:claim.state});
  }
 }
 assert.equal(allClaimsChecked,config.jobs*5);assert.equal(checked.length,expectedFaults);writeFileSync(output,JSON.stringify({passed:true,scope:'closed fixture journal and Member claim audit on private copies',sourceStoresOpenedReadOnly:true,parents,commands,allParentsAndChildrenDone:true,unusedFutureReservations:0,allOriginalClaimsChecked:allClaimsChecked,faultedClaimsChecked:checked.length,originalTargetIdentityAndArgumentHashesPreserved:true,checked},null,2)+'\n');console.log(JSON.stringify({passed:true,parents,commands,allOriginalClaimsChecked:allClaimsChecked,faultedClaimsChecked:checked.length}));
}finally{for(const host of hosts)await host.close(ctx);}
