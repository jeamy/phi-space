// Full virtual-Router workload on real SQLite stores. Transport and identity are local fixtures.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {core,claims,principalId,hrw,createSpace,spaceDoc,snapshotSpace,PiSpaces,SpaceService,StaticIdentity,
    RouterController,FederatedSpace,FederationPending,FederationOperations,RouterJournal,
    parentJournalKey,partitionRouterId,operationPartition,rpcDomain,
    type FederationPolicy,type RoutingState,type RouterTarget,type RouterStep,type RouterReceipt,
    type FederationIO,type Principal,type Json,type Taken} from '../../../src/index.ts';
import {PersistentHome,ctx} from '../../support/persistent.ts';

const output=process.argv[2]??'/tmp/pi-phase2-router-load';mkdirSync(output,{recursive:true});
const entries=Number(process.env.PI_LOAD_ENTRIES??10000),jobs=Number(process.env.PI_LOAD_JOBS??1000),partitions=Number(process.env.PI_LOAD_PARTITIONS??1024);
assert.ok(Number.isSafeInteger(entries)&&Number.isSafeInteger(jobs)&&jobs>=6&&entries>=jobs&&entries<=10000);
const lossEvery=Math.min(137,Math.max(7,Math.floor(jobs*5/30)));
const members=['a','b','c'],principals=[{peerId:'producer'},...Array.from({length:6},(_,n)=>({peerId:'worker-'+n}))];
const homes=[0,1,2,3].map(()=>new PersistentHome('sqlite'));let hosts=await Promise.all(homes.map(h=>h.open()));
const now=()=>Date.now(),started=performance.now();let peakRss=process.memoryUsage().rss,invokes=0,lostReplies=0,retries=0;
const policy:FederationPolicy={authorityId:'load-authority',policyVersion:1,default:{mode:'local',member:'a'},rules:['Load','SieveTask','SieveResult'].map(type=>({type,mode:'expand',by:{field:'taskId'},members})),completionProfiles:[{taskType:'SieveTask',resultTypes:['SieveResult'],equalFields:['taskId','rangeStart','rangeEnd'],maxResultCount:1,maxResultBytes:32768,maxLeaseMs:60000}]};
const state:RoutingState={policy,members:{}},generations=new Map<string,string>(),spaces:string[]=[];
const quantify=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b);return{count:a.length,p95Ms:a[Math.floor((a.length-1)*.95)]??0,p99Ms:a[Math.floor((a.length-1)*.99)]??0,maxMs:a.at(-1)??0};};
function primes(start:number,end:number){const out:number[]=[];for(let n=Math.max(2,start);n<=end;n++){let ok=true;for(let d=2;d*d<=n;d++)if(n%d===0){ok=false;break;}if(ok)out.push(n);}return out;}
const sample=()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);};
const ids=Array.from({length:jobs},(_,n)=>['produce','begin','take','result','commit'].map(kind=>kind+'-'+n)).flat(),occupancy=Array(partitions).fill(0);
for(const id of ids)occupancy[operationPartition(id,partitions)]++;
assert.ok(Math.max(...occupancy)<=16,'preflight Parent partition budget');
const services:SpaceService[]=[];
function client(i:number,p?:Principal){return new PiSpaces(hosts[i]!,ctx,now,undefined,p?principalId(p):undefined,{space:spaces[i],authorityId:policy.authorityId,consumer:p});}
function receipt(s:Readonly<RouterStep>,outcome:RouterReceipt['outcome'],result?:Json,evidence?:string):RouterReceipt{return{target:s.target,principal:s.principal,method:s.method,generation:s.generation,requestId:s.requestId,argHash:s.argHash,outcome,...(result===undefined?{}:{result}),...(evidence?{evidence}:{})};}
const target:RouterTarget={protocol:'pi-spaces-rpc-v1',invoke:async s=>{
 const i=members.indexOf(s.target.hostId);assert.ok(i>=0);assert.deepEqual(s.target,state.members[s.target.hostId]!.target);
 const reply=await services[i]!.handle({method:s.method,space:s.target.spaceId,args:s.args,request:{generation:s.generation,requestId:s.requestId},frame:{authorityId:s.target.authorityId,primaryEpoch:s.target.primaryEpoch}}, {peerId:s.principal.peerId});
 if(!reply.ok)throw new Error('target RPC '+reply.error.code+': '+reply.error.message);
 invokes++;if(invokes%lossEvery===0){lostReplies++;throw new Error('injected reply loss after durable effect');}
 return target.resolve(s);
},resolve:async s=>{
 const i=members.indexOf(s.target.hostId),ref={principal:s.principal,generation:s.generation,requestId:s.requestId};
 const v=await client(i).pollOperation(ref),snap=await snapshotSpace(hosts[i]!,spaces[i]!,ctx),claim=snap!.rpc!.claims[claims.keyOf(snap!,ref)],domain=rpcDomain({method:s.method,args:s.args as any},s.principal);
 assert.equal(claim?.argHash,claims.argHash(domain.method,domain.args));
 if(v.resultExpired||v.unknownOutcome||v.restoredHistory)return receipt(s,'needsReview');
 return receipt(s,v.error?'failed':v.state==='done'?'done':v.state==='cancelled'?'cancelled':'pending',v.result,v.error?.code);
}};
const io:FederationIO={step:async(id,p,method,args,policyVersion)=>{
 const i=members.indexOf(id),key=id+':'+principalId(p);let generation=generations.get(key);
 if(!generation){generation=(await client(i).issueGeneration(p)).generation;generations.set(key,generation);}
 return{target:state.members[id]!.target,principal:p,generation,method,args,policyVersion};
},snapshot:async(id,p,t,txn)=>{const i=members.indexOf(id),s=await snapshotSpace(hosts[i]!,spaces[i]!,ctx);return{entries:await client(i,p).readAll(t,{txn}),revision:s!.stream?.rev??0};},
 events:async()=>{throw new Error('no waiting operations in this workload');},ack:async()=>{throw new Error('no mailbox operations in this workload');},txnActive:async(id,_p,txn)=>{const s=await snapshotSpace(hosts[members.indexOf(id)]!,spaces[members.indexOf(id)]!,ctx);return !!s?.txns[txn]&&s.txns[txn]!.expires>now();}};
let rootRouter!:RouterController,routers!:RouterController[],federation!:FederatedSpace;
async function root(){const options={host:hosts[3]!,ctx,authorityId:policy.authorityId,target,assertAuthority:async()=>{}};
 rootRouter=new RouterController({...options,routerId:'router-load'});routers=Array.from({length:partitions},(_,n)=>new RouterController({...options,routerId:partitionRouterId('router-load',n)}));
 federation=new FederatedSpace({host:hosts[3]!,ctx,id:'router-load',router:rootRouter,partitionRouters:routers,journalPartitions:partitions,state:async()=>state,io,assertAuthority:async()=>{},now});
 await federation.initializeJournals();await rootRouter.recover();for(const r of routers)await r.recover();
}
async function effect<T>(fn:()=>Promise<T>):Promise<T>{for(let attempt=0;attempt<4;attempt++){try{return await fn();}catch(e){if(!(e instanceof FederationPending))throw e;retries++;}}throw new Error('bounded retries exhausted for unresolved Parent');}
const timings={write:[] as number[],begin:[] as number[],take:[] as number[],result:[] as number[],commit:[] as number[],task:[] as number[]};
async function measured<T>(kind:keyof typeof timings,fn:()=>Promise<T>){const t=performance.now(),r=await effect(fn);timings[kind].push(performance.now()-t);sample();return r;}
try {
 for(let i=0;i<3;i++){
  spaces[i]=(await hosts[i]!.commit(tx=>createSpace(tx,'router-load',now()),ctx)).spaceId;
  await hosts[i]!.commit(async tx=>{const s=await spaceDoc(tx,spaces[i]!,now());s.membership={memberId:members[i]!,authorityId:policy.authorityId,policy,state:'active',admissionVersion:1,transitionId:'load-fixture'};core.setCompletionProfiles(s,policy.completionProfiles,now());core.setLimits(s,{maxEntriesPerOwner:10000},now());},ctx);
  const snap=await snapshotSpace(hosts[i]!,spaces[i]!,ctx);state.members[members[i]!]={id:members[i]!,state:'active',target:{hostId:members[i]!,spaceId:spaces[i]!,dataIncarnation:snap!.incarnation!,authorityId:policy.authorityId,primaryEpoch:1}};
  services[i]=new SpaceService({host:hosts[i]!,ctx,identity:new StaticIdentity(Object.fromEntries(principals.map(p=>[p.peerId,{principal:p,roles:['admin']}]))),hostId:members[i],authorityId:policy.authorityId,primaryEpoch:1,now});
 }
 await root();
 // Background inventory is seeded in bounded Member commits. Every job write and processing effect goes through the Root.
 const background:Array<core.EntryDraft[]>=[[],[],[]];for(let n=jobs;n<entries;n++){const taskId='load-'+n;background[members.indexOf(hrw(taskId,members))]!.push({type:'Load',fields:{taskId,n,payload:'x'.repeat(1024)}});}
 for(let i=0;i<3;i++)for(let k=0;k<background[i]!.length;k+=20){await hosts[i]!.commit(async tx=>{const s=await spaceDoc(tx,spaces[i]!,now());for(const e of background[i]!.slice(k,k+20))core.write(s,now(),e,null,core.FOREVER,principalId(principals[0]!));},ctx);sample();}
 for(let n=0;n<jobs;n++){await measured('write',()=>federation.write({type:'SieveTask',fields:{taskId:'job-'+n,rangeStart:n*100+1,rangeEnd:(n+1)*100}},{id:'produce-'+n,principal:principals[0]!},core.FOREVER));if(n%100===99)console.log(JSON.stringify({stage:'jobs-written',jobs:n+1,elapsedMs:performance.now()-started}));}
 const before=await Promise.all(hosts.slice(0,3).map((h,i)=>snapshotSpace(h,spaces[i]!,ctx)));assert.equal(before.reduce((n,s)=>n+core.list(s!,now(),null).length,0),entries);
 const docsBefore=before.map(s=>({entries:s!.entries.length,fullDocumentBytes:Buffer.byteLength(JSON.stringify(s)),claimsBytes:core.claimBytes(s!),streamBytes:s!.stream?.bytes??0}));
 console.log(JSON.stringify({stage:'inventory-ready',entries,jobs,docsBefore}));
 const completed=new Set<number>(),workerJobs=Array(6).fill(0);let next=0;
 await Promise.all(Array.from({length:6},async(_,worker)=>{for(;;){const n=next++;if(n>=jobs)return;const start=performance.now(),p=principals[worker+1]!,taskId='job-'+n,member=hrw(taskId,members),originId='begin-'+n;
  const txn=await measured('begin',()=>federation.createTransaction(member,60000,{id:originId,principal:p}));
  const task=await measured('take',()=>federation.take({type:'SieveTask',fields:{taskId}},{id:'take-'+n,principal:p,txn})) as Taken|null;assert.ok(task);assert.equal(task!.fields.taskId,taskId);
  const fields={...task!.fields,primes:primes(Number(task!.fields.rangeStart),Number(task!.fields.rangeEnd))};
  await measured('result',()=>federation.write({type:'SieveResult',fields},{id:'result-'+n,principal:p,txn},core.FOREVER));
  await measured('commit',()=>federation.finishTransaction(originId,'commit',{id:'commit-'+n,principal:p}));
  assert.equal(completed.has(n),false);completed.add(n);workerJobs[worker]++;timings.task.push(performance.now()-start);
  if(completed.size%100===0)console.log(JSON.stringify({stage:'jobs-completed',jobs:completed.size,elapsedMs:performance.now()-started,sampledPeakRssBytes:peakRss}));
 }}));
 assert.equal(completed.size,jobs);assert.ok(workerJobs.every(n=>n>0));
 const after=await Promise.all(hosts.slice(0,3).map((h,i)=>snapshotSpace(h,spaces[i]!,ctx))),results=after.flatMap(s=>core.list(s!,now(),{type:'SieveResult'}));assert.equal(results.length,jobs);assert.equal(after.reduce((n,s)=>n+core.list(s!,now(),{type:'SieveTask'}).length,0),0);
 const actual=results.flatMap(e=>e.fields.primes as number[]).sort((a,b)=>a-b);assert.deepEqual(actual,primes(1,jobs*100));assert.equal(new Set(results.map(e=>e.fields.taskId)).size,jobs);
 homes[3]!.crash(hosts[3]!);hosts[3]=await homes[3]!.open();await root();
 for(const n of [0,Math.floor(jobs/2),jobs-1]){await federation.write({type:'SieveTask',fields:{taskId:'job-'+n,rangeStart:n*100+1,rangeEnd:(n+1)*100}},{id:'produce-'+n,principal:principals[0]!},core.FOREVER);await federation.resume('commit-'+n);}
 assert.equal((await federation.readAll({type:'SieveResult'},principals[0]!)).entries.length,jobs);assert.equal((await federation.readAll({type:'SieveTask'},principals[0]!)).entries.length,0);
 const journal={parents:0,commands:0,parentDocumentBytes:0,routerIndexBytes:0,routerReservedBytes:0,maxParentsPerPartition:0,maxParentDocumentBytes:0,maxRouterIndexBytes:0};
 for(let n=0;n<partitions;n++){const d=await hosts[3]!.snapshot(FederationOperations,parentJournalKey('router-load',partitions,n),ctx),index=await hosts[3]!.snapshot(RouterJournal,routers[n]!.journalId,ctx);if(d){const count=Object.keys(d.operations).length,size=Buffer.byteLength(JSON.stringify(d));journal.parents+=count;journal.parentDocumentBytes+=size;journal.maxParentsPerPartition=Math.max(journal.maxParentsPerPartition,count);journal.maxParentDocumentBytes=Math.max(journal.maxParentDocumentBytes,size);assert.ok(Object.values(d.operations).every(op=>op.phase==='done'));}if(index){const size=Buffer.byteLength(JSON.stringify(index));journal.commands+=Object.keys(index.refs).length;journal.routerIndexBytes+=size;journal.maxRouterIndexBytes=Math.max(journal.maxRouterIndexBytes,size);journal.routerReservedBytes+=index.reservedBytes;assert.ok(Object.values(index.refs).every(ref=>ref.state==='completed'));}}
 assert.equal(journal.parents,jobs*5);assert.equal(journal.commands,jobs*5);assert.ok(lostReplies>0);assert.equal(retries,lostReplies);
 const report={passed:true,scope:'persistent-virtual-router-load',fullPhase2Accepted:false,transport:'in-process SpaceService with fixture identities (no NetBird/delegation)',backend:'sqlite',entries,jobs,members:3,workers:6,workerJobs,journalPartitions:partitions,backgroundEntriesSeededLocally:entries-jobs,jobEffectsThroughRouter:jobs*5,invokes,lostReplies,retries,lossEvery,rootReopenAndHistoricalRetryPassed:true,primes:actual.length,sum:actual.reduce((n,p)=>n+p,0),elapsedMs:performance.now()-started,sampledPeakRssBytes:peakRss,latencies:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,quantify(v)])),docsBefore,docsAfter:after.map(s=>({entries:s!.entries.length,fullDocumentBytes:Buffer.byteLength(JSON.stringify(s)),claimsBytes:core.claimBytes(s!),streamBytes:s!.stream?.bytes??0})),journal,limits:{maxFrameBytes:core.DEFAULT_LIMITS.maxFrameBytes,maxCommitBytes:core.DEFAULT_LIMITS.maxCommitBytes,generationAdmitMs:core.DEFAULT_LIMITS.generationAdmitMs},remaining:['real NetBird three-Member sieve','full crash boundary matrix','production composition provisioning']};
 writeFileSync(join(output,'router-load.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{for(const h of homes)await h.dispose();}
