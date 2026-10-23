// Durable Member load evidence. Does not substitute for virtual-Router/NetBird system acceptance.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {core,claims,principalId,hrw,createSpace,spaceDoc,snapshotSpace,type FederationPolicy} from '../../../src/index.ts';
import {PersistentHome,ctx} from '../../support/persistent.ts';

const output=process.argv[2]??'/tmp/pi-phase2-load';mkdirSync(output,{recursive:true});
const homes=[0,1,2].map(()=>new PersistentHome()),hosts=await Promise.all(homes.map(h=>h.open()));
const members=['a','b','c'],spaces:string[]=[],gens:Array<Record<string,string>>=[],latencies:number[]=[];
const now=()=>Date.now(),started=performance.now();let peakRss=process.memoryUsage().rss,requestSeq=0;
const policy:FederationPolicy={authorityId:'load-authority',policyVersion:1,default:{mode:'local',member:'a'},rules:['Load','SieveTask','SieveResult'].map(type=>({type,mode:'expand',by:{field:'taskId'},members})),completionProfiles:[{taskType:'SieveTask',resultTypes:['SieveResult'],equalFields:['taskId','rangeStart','rangeEnd'],maxResultCount:1,maxResultBytes:32768,maxLeaseMs:60000}]};
function primes(start:number,end:number){const out:number[]=[];for(let n=Math.max(2,start);n<=end;n++){let ok=true;for(let d=2;d*d<=n;d++)if(n%d===0){ok=false;break;}if(ok)out.push(n);}return out;}
const quantify=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b);return{count:a.length,p95Ms:a[Math.floor((a.length-1)*.95)]??0,p99Ms:a[Math.floor((a.length-1)*.99)]??0,maxMs:a.at(-1)??0};};
try{
 for(let i=0;i<3;i++){
  spaces[i]=(await hosts[i]!.commit(tx=>createSpace(tx,'load',now()),ctx)).spaceId;gens[i]={};
  await hosts[i]!.commit(async tx=>{const s=await spaceDoc(tx,spaces[i]!,now());s.membership={memberId:members[i]!,authorityId:policy.authorityId,policy,state:'active',admissionVersion:1,transitionId:'load-fixture'};core.setCompletionProfiles(s,policy.completionProfiles,now());
   for(const peerId of ['producer',...Array.from({length:6},(_,n)=>'worker-'+n)]) gens[i]![peerId]=claims.issueGeneration(s,now(),{peerId}).generation;
   core.setLimits(s,{maxEntriesPerOwner:10000},now());
  },ctx);
 }
 const routed:Array<Array<{type:string;fields:core.Fields}>>=[[],[],[]];
 for(let n=0;n<10000;n++){const taskId='load-'+n,member=hrw(taskId,members);routed[members.indexOf(member)]!.push(n<1000?{type:'SieveTask',fields:{taskId,rangeStart:n*100+1,rangeEnd:(n+1)*100}}:{type:'Load',fields:{taskId,n,payload:'x'.repeat(1024)}});}
 const principal={peerId:'producer'};
 // Final frame/commit/generation boundary checks use the admitted limits, including history.
 const s=core.initialState();s.spaceId='budget';s.incarnation='1';const g=claims.issueGeneration(s,0,principal);
 assert.throws(()=>claims.admit(s,g.admitUntil+1,{principal,generation:g.generation,requestId:'late'},'write',{},g.admitUntil+2),claims.RequestExpired);
 const limits=core.limitsOf(s);assert.throws(()=>core.write(s,0,{type:'TooLarge',fields:{payload:'x'.repeat(limits.maxEntryBytes)}},null,1000,principalId(principal)),core.LimitError);

 for(let i=0;i<3;i++)for(let k=0;k<routed[i]!.length;k+=20){const begin=performance.now();const batch=routed[i]!.slice(k,k+20);await hosts[i]!.commit(async tx=>{const s=await spaceDoc(tx,spaces[i]!,now());for(const entry of batch){const ref={principal,generation:gens[i]!.producer!,requestId:'entry-'+String(entry.fields.n??entry.fields.taskId)};const admitted=claims.admit(s,now(),ref,'write',{entry},now()+60000,512);const value=core.write(s,now(),entry,null,core.FOREVER,principalId(principal));claims.decide(s,now(),admitted.key,{state:'done',result:value as any});}},ctx);latencies.push((performance.now()-begin)/batch.length);peakRss=Math.max(peakRss,process.memoryUsage().rss);}
 const before=await Promise.all(hosts.map((h,i)=>snapshotSpace(h,spaces[i]!,ctx)));assert.equal(before.reduce((n,s)=>n+core.list(s!,now(),null).length,0),10000);
 const docsBefore=before.map(s=>({entries:s!.entries.length,fullDocumentBytes:Buffer.byteLength(JSON.stringify(s)),claimBytes:core.claimBytes(s!),streamBytes:s!.stream?.bytes??0}));
 console.log(JSON.stringify({stage:'entries-written',entries:10000,docsBefore}));
 const completed=new Set<string>(),workerLatency:number[]=[];
 await Promise.all(Array.from({length:6},async(_,worker)=>{
  const i=worker%3,p={peerId:'worker-'+worker},owner=principalId(p);
  for(;;){const begin=performance.now();let task:core.EntryRec|undefined,txn:string|undefined;
   await hosts[i]!.commit(async tx=>{const s=await spaceDoc(tx,spaces[i]!,now());const first=core.list(s,now(),{type:'SieveTask'})[0];if(!first)return;
    txn=core.createTxn(s,now(),60000,owner).id;
    const ref={principal:p,generation:gens[i]![p.peerId]!,requestId:'take-'+(++requestSeq)},a=claims.admit(s,now(),ref,'take',{id:first.id,txn},now()+60000,4096);
    const taken=core.probe(s,now(),{type:'SieveTask',id:first.id},txn,true,owner);if(taken.status!=='found'){core.abortTxn(s,now(),txn,owner);txn=undefined;return;}task=core.plain(taken.entry);claims.decide(s,now(),a.key,{state:'done',result:core.view(taken.entry,s.spaceId) as any});
   },ctx);
   if(!task||!txn)break;
   const fields={...task.fields,primes:primes(Number(task.fields.rangeStart),Number(task.fields.rangeEnd))};
   await hosts[i]!.commit(async tx=>{const s=await spaceDoc(tx,spaces[i]!,now());const w={principal:p,generation:gens[i]![p.peerId]!,requestId:'result-'+String(task!.fields.taskId)};const a=claims.admit(s,now(),w,'write',{fields,txn:txn!},now()+60000,512);
    const l=core.write(s,now(),{type:'SieveResult',fields},txn!,core.FOREVER,owner);claims.decide(s,now(),a.key,{state:'done',result:l as any});
    const cr={...w,requestId:'commit-'+String(task!.fields.taskId)},b=claims.admit(s,now(),cr,'txn',{action:'commit',id:txn!},now()+60000,512);core.commitTxn(s,now(),txn!,owner);claims.decide(s,now(),b.key,{state:'done',result:null});
   },ctx);
   assert.equal(completed.has(String(task.fields.taskId)),false,'one destructive commit per task');completed.add(String(task.fields.taskId));workerLatency.push(performance.now()-begin);peakRss=Math.max(peakRss,process.memoryUsage().rss);
  }
 }));
 assert.equal(completed.size,1000);
 const after=await Promise.all(hosts.map((h,i)=>snapshotSpace(h,spaces[i]!,ctx))),results=after.flatMap(s=>core.list(s!,now(),{type:'SieveResult'}));assert.equal(results.length,1000);assert.equal(after.reduce((n,s)=>n+core.list(s!,now(),{type:'SieveTask'}).length,0),0);
 const actual=results.flatMap(e=>e.fields.primes as number[]).sort((a,b)=>a-b);assert.deepEqual(actual,primes(1,100000));
 const report={passed:true,scope:'persistent-member-load',fullPhase2Accepted:false,backend:'sqlite',entries:10000,members:3,workers:6,jobs:1000,primes:actual.length,sum:actual.reduce((n,p)=>n+p,0),elapsedMs:performance.now()-started,sampledPeakRssBytes:peakRss,writeBatchMeanPerEntryLatency:quantify(latencies),taskLatency:quantify(workerLatency),docsBefore,docsAfter:after.map(s=>({fullDocumentBytes:Buffer.byteLength(JSON.stringify(s)),claimsBytes:core.claimBytes(s!),streamBytes:s!.stream?.bytes??0})),replicationLag:'not applicable: phase-2 single Members',limits:{maxFrameBytes:limits.maxFrameBytes,maxCommitBytes:limits.maxCommitBytes,generationAdmitMs:limits.generationAdmitMs},remaining:['virtual Router journal scalability','real NetBird three-Member sieve','full crash boundary matrix']};
 writeFileSync(join(output,'member-load.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{for(const home of homes)await home.dispose();}
