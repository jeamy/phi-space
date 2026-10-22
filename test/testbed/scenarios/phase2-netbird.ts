// Isolated wire acceptance: real NetBird peers, key proofs, grants and delegation; fixture provisioning.
import {applyImmutable} from '@earendil-works/chord/delta';
import {journalTransitions} from './journal-checkpoints.ts';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as ctx} from '../../../src/context.ts';
import {core,claims,canonicalJson,principalId,FederationOperations,operationPartition,parentJournalKey,searchMembers,createSpace,spaceDoc,snapshotSpace,provisionFileSigner,loadFileSigner,privateFile,MemoryKeyDirectory,
 NetbirdDirectory,GateIdentity,SpaceService,ProvingService,startGate,GrantVerifier,GrantAuthority,DelegationVerifier,
 RouterLeaseAuthority,createFederationController,FederationRouting,socketTransport,RemoteSpace,
 FederationPending,type Transport,type FederationPolicy,type SignedRouterLease,type Principal,type PeerKeyRec,type Taken} from '../../../src/index.ts';

const [mode,configFile,memberId]=process.argv.slice(2);const config=JSON.parse(privateFile(configFile!).toString());
const home='/data',common='/shared',authorityId=config.authorityId,controlPeerId=config.root.peerId;
mkdirSync(home,{recursive:true,mode:0o700});
const policy:FederationPolicy={authorityId,policyVersion:1,default:{mode:'local',member:'a'},rules:['Load','SieveTask','SieveResult',...((config.ackCrashes||config.journalCrashes)?['AckProbe']:[])].map(type=>({type,mode:'expand',by:{field:'taskId'},members:['a','b','c']})),completionProfiles:[{taskType:'SieveTask',resultTypes:['SieveResult'],equalFields:['taskId','rangeStart','rangeEnd'],maxResultCount:1,maxResultBytes:32768,maxLeaseMs:60000}]};
let selectedJournal:()=>any=()=>undefined;
const rawStorage=await openNodeSqliteStorage(join(home,'harness.sqlite'));
const storage=new Proxy(rawStorage,{get(target,key){const value=Reflect.get(target,key);if(key!=='commit')return typeof value==='function'?value.bind(target):value;
 return async(writes:any[],context:typeof ctx)=>{
  const selected=selectedJournal();let match:any;
  if(selected&&!progress.crashes.some((f:any)=>f.parentId===selected.parentId)){
   const digest=(x:any)=>createHash('sha256').update(canonicalJson(x)).digest('hex'),child=(label:string)=>'f-'+digest([selected.parentId,label]);
   const childIds=new Set(['initial:a','initial:b','initial:c','winner-commit','cancel:a','cancel:b','cancel:c','abort:a','abort:b','abort:c'].map(child)),budgetId=child('budget');
   const states=new Map<number,any>();
   for(const w of writes){
    if(!['document.create','document.change'].includes(w.type))continue;
    let record:any,before:any,after:any;
    if(w.type==='document.create'){record=w.record;before=undefined;after=structuredClone(w.content.value);}
    else{const prior=states.get(w.id)??await target.document(w.id,'current',context);if(!prior)continue;record=prior.record;before=prior.value;after=w.content.kind==='base'?structuredClone(w.content.value):applyImmutable(before,w.content.ops);}
    const kind=record.kind;
    if(journalTransitions(kind,before,after,selected.parentId,childIds,budgetId).includes(selected.kind)){
     const select=(v:any)=>kind==='phi-spaces.federation-operations'?v?.operations?.[selected.parentId]??null:kind==='phi-spaces.router-command'?v?.command??null:{future:v?.future?.[budgetId]??null};
     match={documentId:record.id,documentKind:kind,documentKey:record.key,budgetId,before:select(before),plannedAfter:select(after),deltaHash:digest(w.content)};
    }
    states.set(record.id,{record,value:after});
   }
  }
  const kill=(commitSeq?:number)=>{const fault={...selected,effect:'journal',...match,commitSeq:commitSeq??null,activeWorkers,completedJobs:progress.done.length,at:new Date().toISOString()};progress.crashes.push(fault);atomicJson(progressFile,progress);console.log(JSON.stringify({stage:'root-sigkill',kind:fault.kind,boundary:fault.boundary,parentId:fault.parentId,effect:fault.effect,commitSeq:fault.commitSeq,activeWorkers,completedJobs:fault.completedJobs}));process.kill(process.pid,'SIGKILL');throw Error('SIGKILL returned');};
  if(match&&selected.boundary==='beforeCommit')kill();
  const seq=await target.commit(writes,context);
  if(match){const persisted=await target.document(match.documentId,'current',context);assert.ok(persisted);const v:any=persisted.value,readBack=match.documentKind==='phi-spaces.federation-operations'?v.operations?.[selected.parentId]??null:match.documentKind==='phi-spaces.router-command'?v.command??null:{future:v.future?.[match.budgetId]??null};assert.deepEqual(readBack,match.plannedAfter);kill(seq);}
  return seq;
 };
}});
const host=await Harness.open(storage, {models:createModels(),registry:createRegistry()},ctx);
const directory=new NetbirdDirectory({url:config.managementUrl,token:privateFile('/secrets/management-token').toString().trim()});
const transports=new Map<string,Transport>();
type ProcessCrash={member:string;boundary:string;effect:string;generation:string;requestId:string;at:string};
let activeWorkers=0;
const progressFile=join(home,'run-progress.json');
const progress=mode==='run'&&existsSync(progressFile)?JSON.parse(privateFile(progressFile).toString()):{authorityId,jobs:config.jobs,entries:config.entries,produced:0,done:[],workers:Array(6).fill(0),crashes:[],startedAt:Date.now(),inventoryVerified:false};
progress.ackCursor??=0;progress.ackResults??=[];selectedJournal=()=>mode==='run'&&config.journalCrashes?progress.activeJournalCase:undefined;
if(mode==='run'){if(config.processCrashes||config.ackCrashes||config.journalCrashes)assert.notEqual(process.pid,1,'process crash fixture requires a container init process');assert.equal(progress.authorityId,authorityId);assert.equal(progress.jobs,config.jobs);assert.equal(progress.entries,config.entries);}
function atomicJson(file:string,value:unknown){const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,file);}
function crashAt(member:string,boundary:string,call:any,effect:string){
 if(!config.processCrashes||!config.processCrashEffects.includes(effect)||!call.request)return;
 if(!config.processCrashMembers.includes(member))return;
 if(config.processCrashBoundary!=='both'&&boundary!==config.processCrashBoundary)return;
 if(progress.crashes.some((f:ProcessCrash)=>f.member===member&&f.boundary===boundary&&f.effect===effect))return;
 const taskCrashes=progress.crashes.filter((f:ProcessCrash)=>f.effect==='SieveTask').length;
 const gap=Math.floor(config.jobs/(config.processCrashEffects.length*config.processCrashMembers.length*2+10));
 if(effect==='SieveTask'){if(progress.produced<taskCrashes*gap)return;}else if(progress.done.length<(progress.crashes.length-taskCrashes)*gap)return;
 const fault:ProcessCrash={member,boundary,effect,generation:call.request.generation,requestId:call.request.requestId,at:new Date().toISOString()};
 progress.crashes.push(fault);atomicJson(progressFile,progress);
 console.log(JSON.stringify({stage:'root-sigkill',...fault}));process.kill(process.pid,'SIGKILL');throw new Error('SIGKILL returned');
}
async function crashAckAt(member:string,boundary:string,call:any){
 if(!config.ackCrashes||call.method!=='ack'||!call.request)return;
 const selected=progress.activeAckCase;if(!selected||selected.member!==member||selected.boundary!==boundary)return;
 if(progress.crashes.some((f:any)=>f.effect==='ack'&&f.parentId===selected.parentId))return;
 const journal=await host.snapshot(FederationOperations,parentJournalKey('ap2-netbird',1024,operationPartition(selected.parentId,1024)),ctx);
 const parent=journal?.operations[selected.parentId];assert.ok(parent);assert.deepEqual(call.frame.delegation.delegation.principal,parent.principal);
 const candidateKey=createHash('sha256').update(canonicalJson([member,call.args.mailboxEpoch,call.args.upTo])).digest('hex');
 const candidate=parent.candidates[candidateKey];assert.ok(candidate,'ACK must follow durable candidate persistence');
 assert.equal(candidate.member,member);assert.equal(candidate.event.eventId,parent.registrations[member]);
 assert.ok(parent.targets?.some(t=>t.spaceId===call.space&&t.hostId===config.members.find((m:any)=>m.id===member).hostId));
 const fault={member,boundary,effect:'ack',generation:call.request.generation,requestId:call.request.requestId,principal:parent.principal,target:parent.targets!.find(t=>t.hostId===config.members.find((m:any)=>m.id===member).hostId),argumentHash:call.frame.delegation.delegation.argumentHash,parentId:selected.parentId,candidateKey,candidate,mailboxEpoch:call.args.mailboxEpoch,upTo:call.args.upTo,activeWorkers,completedJobs:progress.done.length,at:new Date().toISOString()};
 progress.crashes.push(fault);atomicJson(progressFile,progress);console.log(JSON.stringify({stage:'root-sigkill',...fault}));process.kill(process.pid,'SIGKILL');throw new Error('SIGKILL returned');
}
const faults:Array<{member:string;boundary:string;effect:string;generation:string;requestId:string}>=[],faultSlots=new Set<string>();let retries=0;
function faultTransport(member:string,s:Transport):Transport{return{request:async text=>{
 const call=JSON.parse(text),effect=call.method==='txn'?'txn-'+call.args?.action:call.method==='write'?call.args?.entry?.type:call.method==='take'?'take':undefined;
 await crashAckAt(member,'beforeSend',call);
 if(effect)crashAt(member,'beforeSend',call,effect);
 if(!config.rpcFaults||!['SieveTask','SieveResult','take','txn-begin','txn-commit'].includes(effect)||!call.request){const reply=await s.request(text);if(config.ackCrashes&&!JSON.parse(reply).ok&&['challenge','prove','readPage'].includes(call.method))console.log(JSON.stringify({stage:'ack-wire-error',member,method:call.method,errorCode:JSON.parse(reply).error.code}));if(JSON.parse(reply).ok)await crashAckAt(member,'afterReply',call);if(effect&&JSON.parse(reply).ok)crashAt(member,'afterReply',call,effect);if(config.rpcFaults&&['pollOperation','resolveOperation'].includes(call.method)&&!JSON.parse(reply).ok)console.log(JSON.stringify({stage:'resolution-error',member,error:JSON.parse(reply).error}));return reply;}
 const record=(boundary:string)=>({member,boundary,effect,generation:call.request.generation,requestId:call.request.requestId});
 const before=member+':'+effect+':beforeSend';
 if(config.rpcFaultBoundary!=='afterReply'&&!faultSlots.has(before)){faultSlots.add(before);faults.push(record('beforeSend'));throw new Error('fixture failure before RPC send');}
 const reply=await s.request(text),after=member+':'+effect+':afterReply';
 if(config.rpcFaultBoundary!=='beforeSend'&&JSON.parse(reply).ok&&!faultSlots.has(after)){faultSlots.add(after);faults.push(record('afterReply'));throw new Error('fixture discarded successful RPC reply');}
 return reply;
}};}
async function effect<T>(fn:()=>Promise<T>):Promise<T>{const deadline=Date.now()+30000;for(let n=0;n<(config.memberCrashes?120:6);n++){try{return await fn();}catch(e){if(!(e instanceof FederationPending))throw e;retries++;if(config.memberCrashes&&Date.now()>=deadline)throw e;if(config.memberCrashes)await new Promise(r=>setTimeout(r,250));}}throw new Error('wire fixture exceeded bounded same-Parent retries');}
const keys=new MemoryKeyDirectory();let close:undefined|(()=>Promise<void>);const sockets:ReturnType<typeof socketTransport>[]=[];
try {
 if(mode==='prepare') {
  const control=provisionFileSigner(join(home,'control-key.json'),'ed25519'),router=provisionFileSigner(join(home,'router-key.json'),'ed25519');
  const controlSpaceId=(await host.commit(tx=>createSpace(tx,'control',Date.now()),ctx)).spaceId;
  const routerRecord:PeerKeyRec={peerId:controlPeerId,keyId:router.keyId,principal:'isolated-test-router',algorithm:router.algorithm,publicKey:router.publicKey,roles:['router','host','member'],scope:['*'],state:'active'};
  writeFileSync(join(common,'public.json'),JSON.stringify({controlSpaceId,controlPublicKey:control.publicKey,controlAlgorithm:control.algorithm,routerRecord}),{mode:0o600});
  console.log(JSON.stringify({prepared:true,controlSpaceId}));
 }else {
  const pub=JSON.parse(privateFile(join(common,'public.json')).toString());keys.add(pub.routerRecord);
  if(mode==='member') {
   const m=config.members.find((m:any)=>m.id===memberId);assert.ok(m);
   const targetFile=join(common,m.id+'.json'),retainedTarget=existsSync(targetFile)?JSON.parse(privateFile(targetFile).toString()):undefined;
   if(config.memberCrashes)assert.notEqual(process.pid,1,'Member crash fixture requires init');
   const sid=retainedTarget?.spaceId??(await host.commit(tx=>createSpace(tx,'jobs',Date.now()),ctx)).spaceId;
   if(!retainedTarget){
   await host.commit(async tx=>{const s=await spaceDoc(tx,sid,Date.now());core.setCompletionProfiles(s,policy.completionProfiles,Date.now());core.setLimits(s,{maxEntriesPerOwner:10000},Date.now());},ctx);
   const memberIndex=config.members.findIndex((x:any)=>x.id===m.id),background:number[]=[];
   for(let n=config.jobs;n<(config.entries??config.jobs);n++)if(n%3===memberIndex)background.push(n);
   for(let offset=0;offset<background.length;offset+=20)await host.commit(async tx=>{const s=await spaceDoc(tx,sid,Date.now());for(const n of background.slice(offset,offset+20))core.write(s,Date.now(),{type:'Load',fields:{n,payload:'x'.repeat(1024)}},null,core.FOREVER,'fixture-background');},ctx);
   await host.commit(async tx=>{(await spaceDoc(tx,sid,Date.now())).membership={memberId:m.id,authorityId,policy,state:'active',admissionVersion:1,transitionId:'isolated-wire-fixture'};},ctx);
   }else{const retainedSpace=await snapshotSpace(host,sid,ctx);assert.ok(retainedSpace);assert.deepEqual(retainedSpace.membership,{memberId:m.id,authorityId,policy,state:'active',admissionVersion:1,transitionId:'isolated-wire-fixture'});}
   const verifier=new GrantVerifier({authorityId,issuerHostId:'ap2-control',publicKey:pub.controlPublicKey,algorithm:pub.controlAlgorithm});
   const delegation=new DelegationVerifier({host,ctx,authorityId,controlSpaceId:pub.controlSpaceId,supervisorPeerId:controlPeerId,supervisorKey:{algorithm:pub.controlAlgorithm,publicKey:pub.controlPublicKey},keys,grants:verifier,policy:async()=>({authorityId,policyVersion:1})});
   const identity=new GateIdentity();const service=new SpaceService({host,ctx,identity,hostId:m.hostId,authorityId,primaryEpoch:1,authorize:(call,id,conn)=>delegation.check(call,id,conn)});
   if(config.memberCrashes){
    const crashFile=join(home,'member-crashes.json'),memberCrashes:any[]=existsSync(crashFile)?JSON.parse(privateFile(crashFile).toString()):[],originalHandle=service.handle.bind(service);
    const killAt=async(boundary:string,call:any,conn:any)=>{
     const effect=call?.method==='txn'?'txn-'+call.args?.action:call?.method==='write'?call.args?.entry?.type:call?.method==='take'?'take':undefined;
     if(!['SieveTask','SieveResult','take','txn-begin','txn-commit'].includes(effect)||!call.request||(conn.peerId!==controlPeerId||conn.state?.proof?.keyId!==pub.routerRecord.keyId))return;
     if(memberCrashes.some(f=>f.effect===effect&&f.boundary===boundary))return;
     const workload=JSON.parse(privateFile(join(common,'workload-progress.json')).toString()),gap=Math.floor(config.jobs/20);
     const prior=memberCrashes.filter(f=>effect==='SieveTask'?f.effect==='SieveTask':f.effect!=='SieveTask').length;
     if((effect==='SieveTask'?workload.produced:workload.completed)<prior*gap)return;
     const principal=call.frame.delegation.delegation.principal,reference={principal,...call.request},space=await snapshotSpace(host,sid,ctx);assert.ok(space);
     const claim=space.rpc?.claims[claims.keyOf(space,reference)];
     if(boundary==='beforeHandle')assert.equal(claim,undefined,'selected original request must not be admitted');
     else{assert.ok(claim);assert.equal(claim.state,'done');assert.equal(claim.error,undefined);assert.deepEqual(claim.principal,principal);assert.equal(claim.argHash,call.frame.delegation.delegation.argumentHash);}
     const fault={member:m.id,boundary,effect,generation:call.request.generation,requestId:call.request.requestId,principal,argumentHash:call.frame.delegation.delegation.argumentHash,target:retainedTarget??JSON.parse(privateFile(targetFile).toString()),claimState:claim?.state??'notAdmitted',activeWorkers:workload.activeWorkers,completedJobs:workload.completed,at:new Date().toISOString()};
     memberCrashes.push(fault);atomicJson(crashFile,memberCrashes);console.log(JSON.stringify({stage:'member-sigkill',...fault}));process.kill(process.pid,'SIGKILL');throw new Error('SIGKILL returned');
    };
    service.handle=async(call,conn,...rest)=>{await killAt('beforeHandle',call,conn);const reply=await originalHandle(call,conn,...rest);if(reply.ok)await killAt('afterCommit',call,conn);return reply;};
   }
   const gate=await startGate(new ProvingService(service,{gateHostId:m.hostId,keys}) as any,{listen:{host:m.ip,port:7423},directory,keys,groupRoles:{'space-ap2-test':['router','host','member']}});close=()=>gate.close();
   const s=await snapshotSpace(host,sid,ctx),target={hostId:m.hostId,spaceId:sid,dataIncarnation:s!.incarnation,authorityId,primaryEpoch:1};if(retainedTarget)assert.deepEqual(target,retainedTarget);else atomicJson(targetFile,target);
   atomicJson(join(home,'member-start.json'),{target,reopened:!!retainedTarget,at:new Date().toISOString()});
   console.log(JSON.stringify({ready:true,member:m.id,ip:m.ip}));await new Promise<void>(r=>{process.once('SIGTERM',r);process.once('SIGINT',r);});
  }else if(mode==='run') {
   const router=loadFileSigner(join(home,'router-key.json')),control=loadFileSigner(join(home,'control-key.json'));await directory.refresh();
   const local=await directory.lookup(config.root.ip);assert.equal(local?.id,controlPeerId);assert.ok(local!.groups.includes('space-ap2-test'));
   const leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:pub.controlSpaceId,authorityId,peerId:controlPeerId,signer:control,keys,assertAuthority:async()=>{}});
   const leaseFile=join(home,'router-lease.json');
   const retained:SignedRouterLease|undefined=existsSync(leaseFile)?JSON.parse(privateFile(leaseFile).toString()):undefined;
   let current:SignedRouterLease=await leases.issue(controlPeerId,router.keyId,retained?{id:retained.lease.id,routerEpoch:retained.lease.routerEpoch}:undefined);
   if(retained){assert.equal(current.lease.id,retained.lease.id);assert.equal(current.lease.routerEpoch,retained.lease.routerEpoch);}
   atomicJson(leaseFile,current);
   const lease=async()=>{if(Date.now()+15000>=current.lease.expiresAt){current=await leases.issue(controlPeerId,router.keyId,{id:current.lease.id,routerEpoch:current.lease.routerEpoch});atomicJson(leaseFile,current);}return current;};
   const identity=new GateIdentity(),conn:any={peerId:controlPeerId,credentials:{roles:['router','host','member']},state:{proof:{peerId:controlPeerId,keyId:router.keyId,roles:['router','host','member']}}};
   const grants=new GrantAuthority({authorityId,hostId:'ap2-control',signer:control,keys,identity,refreshIdentity:async()=>{const peer=await directory.lookup(config.root.ip);assert.equal(peer?.id,controlPeerId);assert.ok(peer!.groups.includes('space-ap2-test'));return identity.authenticate(conn);}});
   const controller=await createFederationController({host,ctx,id:'ap2-netbird',journalPartitions:1024,controlSpaceId:pub.controlSpaceId,authorityId,routerPeerId:controlPeerId,routerSigner:router,controlPeerId,controlSigner:control,controlPublicKey:control.publicKey,transport:id=>{const prior=transports.get(id);if(prior)return prior;const m=config.members.find((m:any)=>m.id===id),s=socketTransport({host:m.ip,port:7423});sockets.push(s);const t=faultTransport(id,s);transports.set(id,t);return t;},memberPin:async()=>{throw new Error('no membership changes in this fixture');},lease,grant:(p:Principal)=>grants.issue(conn,'effect',p.agentId),assertAuthority:async()=>{},authorizeAdmin:async()=>{}});
   if(!(await controller.policy.state()).policy){
    await host.commit(async tx=>{const d=await tx.doc(FederationRouting,pub.controlSpaceId,null);for(const m of config.members)d.members[m.id]={id:m.id,state:'active',target:JSON.parse(privateFile(join(common,m.id+'.json')).toString())};},ctx);
    await controller.policy.install(policy,0,async()=>{});
   }else{const state=await controller.policy.state();assert.deepEqual(state.policy,policy);for(const m of config.members)assert.deepEqual(state.members[m.id]!.target,JSON.parse(privateFile(join(common,m.id+'.json')).toString()));}
   const jobs=config.jobs??1000,producer={peerId:controlPeerId,agentId:'producer'},done=new Set<number>(progress.done),workers:number[]=progress.workers;
   const publishWorkload=()=>{if(config.memberCrashes)atomicJson(join(common,'workload-progress.json'),{produced:progress.produced,completed:done.size,activeWorkers});};publishWorkload();
   atomicJson(progressFile,progress);console.log(JSON.stringify({stage:'root-started',produced:progress.produced,completed:done.size,priorCrashes:progress.crashes.length,routerEpoch:current.lease.routerEpoch,leaseId:current.lease.id}));
   const primes=(start:number,end:number)=>{const a:number[]=[];for(let n=Math.max(2,start);n<=end;n++){let ok=true;for(let d=2;d*d<=n;d++)if(n%d===0){ok=false;break;}if(ok)a.push(n);}return a;};
   for(let n=progress.produced;n<jobs;n++){await effect(()=>controller.space.write({type:'SieveTask',fields:{taskId:'wire-'+n,rangeStart:n*100+1,rangeEnd:(n+1)*100}},{id:'produce-'+n,principal:producer},core.FOREVER));progress.produced=n+1;publishWorkload();atomicJson(progressFile,progress);if(n%100===99)console.log(JSON.stringify({stage:'written',jobs:n+1}));}
   if(!progress.inventoryVerified){const inventoryTasks=await controller.space.count({type:'SieveTask'},producer),inventoryBackground=await controller.space.count({type:'Load'},producer);
    assert.equal(inventoryTasks.count,jobs);assert.equal(inventoryBackground.count,(config.entries??jobs)-jobs);progress.inventoryVerified=true;atomicJson(progressFile,progress);
    console.log(JSON.stringify({stage:'inventory-ready',entries:inventoryTasks.count+inventoryBackground.count,jobs}));}

   const st=await controller.policy.state();
   const workerRun=Promise.all(Array.from({length:6},async(_,w)=>{activeWorkers++;publishWorkload();try{for(let n=w;n<jobs;n+=6){if(done.has(n))continue;const p={peerId:controlPeerId,agentId:'worker-'+w},taskId='wire-'+n;
    const targets=(await import('../../../src/index.ts')).searchMembers(policy,{type:'SieveTask',fields:{taskId}}),m=targets[0]!;assert.ok(st.members[m]);
    const txn=await effect(()=>controller.space.createTransaction(m,60000,{id:'begin-'+n,principal:p}));const task=await effect(()=>controller.space.take({type:'SieveTask',fields:{taskId}},{id:'take-'+n,principal:p,txn})) as Taken;assert.equal(task.fields.taskId,taskId);
    await effect(()=>controller.space.write({type:'SieveResult',fields:{...task.fields,primes:primes(Number(task.fields.rangeStart),Number(task.fields.rangeEnd))}},{id:'result-'+n,principal:p,txn},core.FOREVER));
    await effect(()=>controller.space.finishTransaction('begin-'+n,'commit',{id:'commit-'+n,principal:p}));assert.equal(done.has(n),false);done.add(n);workers[w]++;progress.done=[...done];publishWorkload();atomicJson(progressFile,progress);if(done.size%100===0)console.log(JSON.stringify({stage:'completed',jobs:done.size}));
   }}finally{activeWorkers--;publishWorkload();}}));
   const ackRun=async()=>{
    if(!config.ackCrashes&&!config.journalCrashes)return;
    const cases=config.journalCrashes?config.journalCrashKinds.flatMap((kind:string)=>['beforeCommit','afterCommit'].map(boundary=>({kind,boundary}))):config.members.flatMap((m:any)=>['beforeSend','afterReply'].map(boundary=>({member:m.id,boundary})));
    for(let i=progress.ackCursor;i<cases.length;i++){
     const selected={...cases[i],parentId:(config.journalCrashes?'journal-race-':'ack-race-')+i},p={peerId:controlPeerId,agentId:'ack-worker-'+i},probeId='ack-probe-'+i;
     if(config.journalCrashes)progress.activeJournalCase=selected;else progress.activeAckCase=selected;atomicJson(progressFile,progress);
     if(config.journalCrashes&&selected.kind==='parentCursor'){
      const request={id:selected.parentId,principal:p};assert.equal(await effect(()=>controller.space.read({type:'AckProbe',fields:{probeId}},request)),null);assert.equal(await controller.space.resume(selected.parentId),null);
      progress.ackResults.push({parentId:selected.parentId,kind:'read',journalKind:selected.kind,boundary:selected.boundary,replayStable:true});progress.ackCursor=i+1;delete progress.activeJournalCase;atomicJson(progressFile,progress);continue;
     }
     try{await controller.space.takeWaiting({type:'AckProbe',fields:{probeId}},60000,60000,{id:selected.parentId,principal:p});}catch(e){if(!(e instanceof FederationPending))throw e;}
     for(const m of config.members){
      let taskId='';for(let n=0;n<1000;n++){const key=probeId+'-'+n;if(searchMembers(policy,{type:'AckProbe',fields:{taskId:key}})[0]===m.id){taskId=key;break;}}assert.ok(taskId);
      await effect(()=>controller.space.write({type:'AckProbe',fields:{taskId,probeId,member:m.id}},{id:'ack-seed-'+i+'-'+m.id,principal:producer},core.FOREVER));
     }
     const winner=await effect(()=>controller.space.resume(selected.parentId)) as Taken;assert.equal(winner.fields.probeId,probeId);assert.equal(winner.fields.member,'a');
     assert.equal((await controller.space.readAll({type:'AckProbe',fields:{probeId}},producer)).entries.length,2,'one winner consumed and two losers returned');
     const replay=await controller.space.resume(selected.parentId);assert.deepEqual(replay,winner);
     for(const m of config.members){const target=st.members[m.id]!.target;const journal=await host.snapshot(FederationOperations,parentJournalKey('ap2-netbird',1024,operationPartition(selected.parentId,1024)),ctx);assert.ok(journal?.operations[selected.parentId]);const page=await controller.rpc.events(m.id,p,(await controller.partitionRouters[operationPartition(selected.parentId,1024)]!.get(journal.operations[selected.parentId]!.children[m.id]!))!.steps[0]!);assert.equal(page.events.length,0);assert.equal(page.gap,false);assert.ok(target);}
     progress.ackResults.push({parentId:selected.parentId,probeId,winner,kind:'race',journalKind:selected.kind,selectedMember:selected.member,boundary:selected.boundary,replayStable:true,remaining:2});progress.ackCursor=i+1;delete progress.activeAckCase;delete progress.activeJournalCase;atomicJson(progressFile,progress);console.log(JSON.stringify({stage:'ack-case-completed',case:i+1,completedJobs:done.size}));
    }
   };
   await Promise.all([workerRun,ackRun()]);
   const results=await controller.space.readAll({type:'SieveResult'},producer);assert.equal(results.entries.length,jobs);assert.equal((await controller.space.readAll({type:'SieveTask'},producer)).entries.length,0);
   const actual=results.entries.flatMap(e=>e.fields.primes as number[]).sort((a,b)=>a-b);assert.deepEqual(actual,primes(1,jobs*100));assert.equal(new Set(results.entries.map(e=>e.fields.taskId)).size,jobs);assert.ok(workers.every(n=>n>0));
   assert.equal((await controller.space.count({type:'Load'},producer)).count,(config.entries??jobs)-jobs);
   if(config.rpcFaults)assert.equal(faultSlots.size,config.rpcFaultBoundary==='both'?30:15,'all requested RPC boundaries, five effect kinds and all three Members must be exercised');
   const expectedCrashes=(config.processCrashes?config.processCrashEffects.length*config.processCrashMembers.length*(config.processCrashBoundary==='both'?2:1):0)+(config.ackCrashes?6:0)+(config.journalCrashes?config.journalCrashKinds.length*2:0);assert.equal(progress.crashes.length,expectedCrashes,'all selected process boundaries must have killed the Root');assert.equal(done.size,jobs);
   if(config.ackCrashes){assert.equal(progress.ackResults.length,6);assert.equal(new Set(progress.ackResults.map((r:any)=>r.winner.gid)).size,6);if(jobs===1000)assert.ok(progress.crashes.every((f:any)=>f.activeWorkers===6),'full ACK matrix must interrupt six running Workers');}
   if(config.journalCrashes){assert.equal(progress.ackResults.length,config.journalCrashKinds.length*2);if(jobs===1000)assert.ok(progress.crashes.every((f:any)=>f.activeWorkers===6),'journal matrix must interrupt six active Workers');}
   const memberFaults=config.memberCrashes?config.members.flatMap((m:any)=>JSON.parse(privateFile(join(common,m.id+'-crashes.json')).toString())):[];if(config.memberCrashes){assert.equal(memberFaults.length,30);assert.equal(new Set(memberFaults.map((f:any)=>[f.member,f.boundary,f.effect].join(':'))).size,30);if(jobs===1000)assert.ok(memberFaults.filter((f:any)=>f.effect!=='SieveTask').every((f:any)=>f.activeWorkers===6),'all Member worker-effect deaths must interrupt six running Workers');}
   const report={journalCommitCrashesExercised:!!config.journalCrashes,journalCrashKinds:config.journalCrashKinds,journalCrashesUnderWorkerLoad:config.journalCrashes?progress.crashes.every((f:any)=>f.activeWorkers===6):false,memberProcessCrashesExercised:!!config.memberCrashes,memberProcessCrashes:memberFaults,memberCrashesUnderWorkerLoad:config.memberCrashes?memberFaults.filter((f:any)=>f.effect!=='SieveTask').every((f:any)=>f.activeWorkers===6):false,ackProbes:progress.ackResults,expectedProcessCrashes:expectedCrashes+(config.memberCrashes?30:0),expectedRootProcessCrashes:expectedCrashes,ackCrashesUnderWorkerLoad:config.ackCrashes?progress.crashes.every((f:any)=>f.activeWorkers===6):false,processCrashEffects:config.processCrashEffects,processCrashGapJobs:Math.floor(config.jobs/(config.processCrashEffects.length*config.processCrashMembers.length*2+10)),processCrashEffect:config.processCrashEffect,processCrashBoundary:config.processCrashBoundary,processCrashMembers:config.processCrashMembers,processCrashes:progress.crashes,routerEpoch:current.lease.routerEpoch,routerLeaseId:current.lease.id,stableWorkerAssignment:true,rpcFaults:!!config.rpcFaults,rpcFaultBoundary:config.rpcFaultBoundary,faults,sameParentRetries:retries,processCrashesExercised:!!(config.processCrashes||config.ackCrashes||config.journalCrashes),mailboxAckFaultsExercised:!!config.ackCrashes,passed:true,date:new Date().toISOString(),scope:'real-netbird-signed-wire-fixture',entries:config.entries??jobs,backgroundEntriesSeededLocally:(config.entries??jobs)-jobs,jobs,workers:6,workerJobs:workers,members:config.members.map((m:any)=>({id:m.id,peerId:m.peerId,ip:m.ip})),routerPeerId:controlPeerId,independentNetworkNamespaces:4,physicalServers:1,layerA:true,layerB:true,signedGrants:true,signedDelegation:true,signedRouterLease:true,fixtureProvisioning:true,independentBootRegisterExercised:false,productionServicesChanged:false,fullPhase2Accepted:false,primes:actual.length,sum:actual.reduce((a,b)=>a+b,0),elapsedMs:Date.now()-progress.startedAt};
   writeFileSync(join(common,'netbird-sieve.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }else throw new Error('use prepare, member or run');
 }
}finally{for(const s of sockets)s.close();if(close)await close();await host.close(ctx);}
