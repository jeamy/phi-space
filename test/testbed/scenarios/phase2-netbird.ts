// Isolated wire acceptance: real NetBird peers, key proofs, grants and delegation; fixture provisioning.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';
import {core,createSpace,spaceDoc,snapshotSpace,provisionFileSigner,loadFileSigner,privateFile,MemoryKeyDirectory,
 NetbirdDirectory,GateIdentity,SpaceService,ProvingService,startGate,GrantVerifier,GrantAuthority,DelegationVerifier,
 RouterLeaseAuthority,createFederationController,FederationRouting,socketTransport,RemoteSpace,
 FederationPending,type Transport,type FederationPolicy,type SignedRouterLease,type Principal,type PeerKeyRec,type Taken} from '../../../src/index.ts';

const [mode,configFile,memberId]=process.argv.slice(2);const config=JSON.parse(privateFile(configFile!).toString());
const home='/data',common='/shared',authorityId=config.authorityId,controlPeerId=config.root.peerId;
mkdirSync(home,{recursive:true,mode:0o700});
const policy:FederationPolicy={authorityId,policyVersion:1,default:{mode:'local',member:'a'},rules:['Load','SieveTask','SieveResult'].map(type=>({type,mode:'expand',by:{field:'taskId'},members:['a','b','c']})),completionProfiles:[{taskType:'SieveTask',resultTypes:['SieveResult'],equalFields:['taskId','rangeStart','rangeEnd'],maxResultCount:1,maxResultBytes:32768,maxLeaseMs:60000}]};
const host=await Harness.open(await openNodeSqliteStorage(join(home,'harness.sqlite')), {models:createModels(),registry:createRegistry()},ctx);
const directory=new NetbirdDirectory({url:config.managementUrl,token:privateFile('/secrets/management-token').toString().trim()});
const transports=new Map<string,Transport>();
type ProcessCrash={member:string;boundary:string;effect:string;generation:string;requestId:string;at:string};
const progressFile=join(home,'run-progress.json');
const progress=mode==='run'&&existsSync(progressFile)?JSON.parse(privateFile(progressFile).toString()):{authorityId,jobs:config.jobs,entries:config.entries,produced:0,done:[],workers:Array(6).fill(0),crashes:[],startedAt:Date.now(),inventoryVerified:false};
if(mode==='run'){if(config.processCrashes)assert.notEqual(process.pid,1,'process crash fixture requires a container init process');assert.equal(progress.authorityId,authorityId);assert.equal(progress.jobs,config.jobs);assert.equal(progress.entries,config.entries);}
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
const faults:Array<{member:string;boundary:string;effect:string;generation:string;requestId:string}>=[],faultSlots=new Set<string>();let retries=0;
function faultTransport(member:string,s:Transport):Transport{return{request:async text=>{
 const call=JSON.parse(text),effect=call.method==='txn'?'txn-'+call.args?.action:call.method==='write'?call.args?.entry?.type:call.method==='take'?'take':undefined;
 if(effect)crashAt(member,'beforeSend',call,effect);
 if(!config.rpcFaults||!['SieveTask','SieveResult','take','txn-begin','txn-commit'].includes(effect)||!call.request){const reply=await s.request(text);if(effect&&JSON.parse(reply).ok)crashAt(member,'afterReply',call,effect);if(config.rpcFaults&&['pollOperation','resolveOperation'].includes(call.method)&&!JSON.parse(reply).ok)console.log(JSON.stringify({stage:'resolution-error',member,error:JSON.parse(reply).error}));return reply;}
 const record=(boundary:string)=>({member,boundary,effect,generation:call.request.generation,requestId:call.request.requestId});
 const before=member+':'+effect+':beforeSend';
 if(config.rpcFaultBoundary!=='afterReply'&&!faultSlots.has(before)){faultSlots.add(before);faults.push(record('beforeSend'));throw new Error('fixture failure before RPC send');}
 const reply=await s.request(text),after=member+':'+effect+':afterReply';
 if(config.rpcFaultBoundary!=='beforeSend'&&JSON.parse(reply).ok&&!faultSlots.has(after)){faultSlots.add(after);faults.push(record('afterReply'));throw new Error('fixture discarded successful RPC reply');}
 return reply;
}};}
async function effect<T>(fn:()=>Promise<T>):Promise<T>{for(let n=0;n<6;n++){try{return await fn();}catch(e){if(!(e instanceof FederationPending))throw e;retries++;}}throw new Error('wire fixture exceeded bounded same-Parent retries');}
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
   const sid=(await host.commit(tx=>createSpace(tx,'jobs',Date.now()),ctx)).spaceId;
   await host.commit(async tx=>{const s=await spaceDoc(tx,sid,Date.now());core.setCompletionProfiles(s,policy.completionProfiles,Date.now());core.setLimits(s,{maxEntriesPerOwner:10000},Date.now());},ctx);
   const memberIndex=config.members.findIndex((x:any)=>x.id===m.id),background:number[]=[];
   for(let n=config.jobs;n<(config.entries??config.jobs);n++)if(n%3===memberIndex)background.push(n);
   for(let offset=0;offset<background.length;offset+=20)await host.commit(async tx=>{const s=await spaceDoc(tx,sid,Date.now());for(const n of background.slice(offset,offset+20))core.write(s,Date.now(),{type:'Load',fields:{n,payload:'x'.repeat(1024)}},null,core.FOREVER,'fixture-background');},ctx);
   await host.commit(async tx=>{(await spaceDoc(tx,sid,Date.now())).membership={memberId:m.id,authorityId,policy,state:'active',admissionVersion:1,transitionId:'isolated-wire-fixture'};},ctx);
   const verifier=new GrantVerifier({authorityId,issuerHostId:'ap2-control',publicKey:pub.controlPublicKey,algorithm:pub.controlAlgorithm});
   const delegation=new DelegationVerifier({host,ctx,authorityId,controlSpaceId:pub.controlSpaceId,supervisorPeerId:controlPeerId,supervisorKey:{algorithm:pub.controlAlgorithm,publicKey:pub.controlPublicKey},keys,grants:verifier,policy:async()=>({authorityId,policyVersion:1})});
   const identity=new GateIdentity();const service=new SpaceService({host,ctx,identity,hostId:m.hostId,authorityId,primaryEpoch:1,authorize:(call,id,conn)=>delegation.check(call,id,conn)});
   const gate=await startGate(new ProvingService(service,{gateHostId:m.hostId,keys}) as any,{listen:{host:m.ip,port:7423},directory,keys,groupRoles:{'space-ap2-test':['router','host','member']}});close=()=>gate.close();
   const s=await snapshotSpace(host,sid,ctx);writeFileSync(join(common,m.id+'.json'),JSON.stringify({hostId:m.hostId,spaceId:sid,dataIncarnation:s!.incarnation,authorityId,primaryEpoch:1}),{mode:0o600});
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
   atomicJson(progressFile,progress);console.log(JSON.stringify({stage:'root-started',produced:progress.produced,completed:done.size,priorCrashes:progress.crashes.length,routerEpoch:current.lease.routerEpoch,leaseId:current.lease.id}));
   const primes=(start:number,end:number)=>{const a:number[]=[];for(let n=Math.max(2,start);n<=end;n++){let ok=true;for(let d=2;d*d<=n;d++)if(n%d===0){ok=false;break;}if(ok)a.push(n);}return a;};
   for(let n=progress.produced;n<jobs;n++){await effect(()=>controller.space.write({type:'SieveTask',fields:{taskId:'wire-'+n,rangeStart:n*100+1,rangeEnd:(n+1)*100}},{id:'produce-'+n,principal:producer},core.FOREVER));progress.produced=n+1;atomicJson(progressFile,progress);if(n%100===99)console.log(JSON.stringify({stage:'written',jobs:n+1}));}
   if(!progress.inventoryVerified){const inventoryTasks=await controller.space.count({type:'SieveTask'},producer),inventoryBackground=await controller.space.count({type:'Load'},producer);
    assert.equal(inventoryTasks.count,jobs);assert.equal(inventoryBackground.count,(config.entries??jobs)-jobs);progress.inventoryVerified=true;atomicJson(progressFile,progress);
    console.log(JSON.stringify({stage:'inventory-ready',entries:inventoryTasks.count+inventoryBackground.count,jobs}));}

   const st=await controller.policy.state();
   await Promise.all(Array.from({length:6},async(_,w)=>{for(let n=w;n<jobs;n+=6){if(done.has(n))continue;const p={peerId:controlPeerId,agentId:'worker-'+w},taskId='wire-'+n;
    const targets=(await import('../../../src/index.ts')).searchMembers(policy,{type:'SieveTask',fields:{taskId}}),m=targets[0]!;assert.ok(st.members[m]);
    const txn=await effect(()=>controller.space.createTransaction(m,60000,{id:'begin-'+n,principal:p}));const task=await effect(()=>controller.space.take({type:'SieveTask',fields:{taskId}},{id:'take-'+n,principal:p,txn})) as Taken;assert.equal(task.fields.taskId,taskId);
    await effect(()=>controller.space.write({type:'SieveResult',fields:{...task.fields,primes:primes(Number(task.fields.rangeStart),Number(task.fields.rangeEnd))}},{id:'result-'+n,principal:p,txn},core.FOREVER));
    await effect(()=>controller.space.finishTransaction('begin-'+n,'commit',{id:'commit-'+n,principal:p}));assert.equal(done.has(n),false);done.add(n);workers[w]++;progress.done=[...done];atomicJson(progressFile,progress);if(done.size%100===0)console.log(JSON.stringify({stage:'completed',jobs:done.size}));
   }}));
   const results=await controller.space.readAll({type:'SieveResult'},producer);assert.equal(results.entries.length,jobs);assert.equal((await controller.space.readAll({type:'SieveTask'},producer)).entries.length,0);
   const actual=results.entries.flatMap(e=>e.fields.primes as number[]).sort((a,b)=>a-b);assert.deepEqual(actual,primes(1,jobs*100));assert.equal(new Set(results.entries.map(e=>e.fields.taskId)).size,jobs);assert.ok(workers.every(n=>n>0));
   assert.equal((await controller.space.count({type:'Load'},producer)).count,(config.entries??jobs)-jobs);
   if(config.rpcFaults)assert.equal(faultSlots.size,config.rpcFaultBoundary==='both'?30:15,'all requested RPC boundaries, five effect kinds and all three Members must be exercised');
   const expectedCrashes=config.processCrashes?config.processCrashEffects.length*config.processCrashMembers.length*(config.processCrashBoundary==='both'?2:1):0;assert.equal(progress.crashes.length,expectedCrashes,'all selected process boundaries must have killed the Root');assert.equal(done.size,jobs);
   const report={processCrashEffects:config.processCrashEffects,processCrashGapJobs:Math.floor(config.jobs/(config.processCrashEffects.length*config.processCrashMembers.length*2+10)),processCrashEffect:config.processCrashEffect,processCrashBoundary:config.processCrashBoundary,processCrashMembers:config.processCrashMembers,processCrashes:progress.crashes,routerEpoch:current.lease.routerEpoch,routerLeaseId:current.lease.id,stableWorkerAssignment:true,rpcFaults:!!config.rpcFaults,rpcFaultBoundary:config.rpcFaultBoundary,faults,sameParentRetries:retries,processCrashesExercised:!!config.processCrashes,mailboxAckFaultsExercised:false,passed:true,date:new Date().toISOString(),scope:'real-netbird-signed-wire-fixture',entries:config.entries??jobs,backgroundEntriesSeededLocally:(config.entries??jobs)-jobs,jobs,workers:6,workerJobs:workers,members:config.members.map((m:any)=>({id:m.id,peerId:m.peerId,ip:m.ip})),routerPeerId:controlPeerId,independentNetworkNamespaces:4,physicalServers:1,layerA:true,layerB:true,signedGrants:true,signedDelegation:true,signedRouterLease:true,fixtureProvisioning:true,independentBootRegisterExercised:false,productionServicesChanged:false,fullPhase2Accepted:false,primes:actual.length,sum:actual.reduce((a,b)=>a+b,0),elapsedMs:Date.now()-progress.startedAt};
   writeFileSync(join(common,'netbird-sieve.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }else throw new Error('use prepare, member or run');
 }
}finally{for(const s of sockets)s.close();if(close)await close();await host.close(ctx);}
