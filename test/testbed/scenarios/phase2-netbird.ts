// Isolated wire acceptance: real NetBird peers, key proofs, grants and delegation; fixture provisioning.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
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
const faults:Array<{member:string;boundary:string;effect:string;generation:string;requestId:string}>=[],faultSlots=new Set<string>();let retries=0;
function faultTransport(member:string,s:Transport):Transport{return{request:async text=>{
 const call=JSON.parse(text),effect=call.method==='txn'?'txn-'+call.args?.action:call.method==='write'?call.args?.entry?.type:call.method==='take'?'take':undefined;
 if(!config.rpcFaults||!['SieveTask','SieveResult','take','txn-begin','txn-commit'].includes(effect)||!call.request){const reply=await s.request(text);if(config.rpcFaults&&['pollOperation','resolveOperation'].includes(call.method)&&!JSON.parse(reply).ok)console.log(JSON.stringify({stage:'resolution-error',member,error:JSON.parse(reply).error}));return reply;}
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
   let current:SignedRouterLease=await leases.issue(controlPeerId,router.keyId);const lease=async()=>{if(Date.now()+15000>=current.lease.expiresAt)current=await leases.issue(controlPeerId,router.keyId,{id:current.lease.id,routerEpoch:current.lease.routerEpoch});return current;};
   const identity=new GateIdentity(),conn:any={peerId:controlPeerId,credentials:{roles:['router','host','member']},state:{proof:{peerId:controlPeerId,keyId:router.keyId,roles:['router','host','member']}}};
   const grants=new GrantAuthority({authorityId,hostId:'ap2-control',signer:control,keys,identity,refreshIdentity:async()=>{const peer=await directory.lookup(config.root.ip);assert.equal(peer?.id,controlPeerId);assert.ok(peer!.groups.includes('space-ap2-test'));return identity.authenticate(conn);}});
   const controller=await createFederationController({host,ctx,id:'ap2-netbird',journalPartitions:1024,controlSpaceId:pub.controlSpaceId,authorityId,routerPeerId:controlPeerId,routerSigner:router,controlPeerId,controlSigner:control,controlPublicKey:control.publicKey,transport:id=>{const prior=transports.get(id);if(prior)return prior;const m=config.members.find((m:any)=>m.id===id),s=socketTransport({host:m.ip,port:7423});sockets.push(s);const t=faultTransport(id,s);transports.set(id,t);return t;},memberPin:async()=>{throw new Error('no membership changes in this fixture');},lease,grant:(p:Principal)=>grants.issue(conn,'effect',p.agentId),assertAuthority:async()=>{},authorizeAdmin:async()=>{}});
   await host.commit(async tx=>{const d=await tx.doc(FederationRouting,pub.controlSpaceId,null);for(const m of config.members)d.members[m.id]={id:m.id,state:'active',target:JSON.parse(privateFile(join(common,m.id+'.json')).toString())};},ctx);
   await controller.policy.install(policy,0,async()=>{});
   const jobs=config.jobs??1000,producer={peerId:controlPeerId,agentId:'producer'},started=performance.now();let seq=0;const done=new Set<number>(),workers=Array(6).fill(0);
   const primes=(start:number,end:number)=>{const a:number[]=[];for(let n=Math.max(2,start);n<=end;n++){let ok=true;for(let d=2;d*d<=n;d++)if(n%d===0){ok=false;break;}if(ok)a.push(n);}return a;};
   for(let n=0;n<jobs;n++){await effect(()=>controller.space.write({type:'SieveTask',fields:{taskId:'wire-'+n,rangeStart:n*100+1,rangeEnd:(n+1)*100}},{id:'produce-'+n,principal:producer},core.FOREVER));if(n%100===99)console.log(JSON.stringify({stage:'written',jobs:n+1}));}
   const inventoryTasks=await controller.space.count({type:'SieveTask'},producer),inventoryBackground=await controller.space.count({type:'Load'},producer);
   assert.equal(inventoryTasks.count,jobs);assert.equal(inventoryBackground.count,(config.entries??jobs)-jobs);
   console.log(JSON.stringify({stage:'inventory-ready',entries:inventoryTasks.count+inventoryBackground.count,jobs}));
   const st=await controller.policy.state();
   await Promise.all(Array.from({length:6},async(_,w)=>{for(;;){const n=seq++;if(n>=jobs)return;const p={peerId:controlPeerId,agentId:'worker-'+w},taskId='wire-'+n;
    const targets=(await import('../../../src/index.ts')).searchMembers(policy,{type:'SieveTask',fields:{taskId}}),m=targets[0]!;assert.ok(st.members[m]);
    const txn=await effect(()=>controller.space.createTransaction(m,60000,{id:'begin-'+n,principal:p}));const task=await effect(()=>controller.space.take({type:'SieveTask',fields:{taskId}},{id:'take-'+n,principal:p,txn})) as Taken;assert.equal(task.fields.taskId,taskId);
    await effect(()=>controller.space.write({type:'SieveResult',fields:{...task.fields,primes:primes(Number(task.fields.rangeStart),Number(task.fields.rangeEnd))}},{id:'result-'+n,principal:p,txn},core.FOREVER));
    await effect(()=>controller.space.finishTransaction('begin-'+n,'commit',{id:'commit-'+n,principal:p}));assert.equal(done.has(n),false);done.add(n);workers[w]++;if(done.size%100===0)console.log(JSON.stringify({stage:'completed',jobs:done.size}));
   }}));
   const results=await controller.space.readAll({type:'SieveResult'},producer);assert.equal(results.entries.length,jobs);assert.equal((await controller.space.readAll({type:'SieveTask'},producer)).entries.length,0);
   const actual=results.entries.flatMap(e=>e.fields.primes as number[]).sort((a,b)=>a-b);assert.deepEqual(actual,primes(1,jobs*100));assert.equal(new Set(results.entries.map(e=>e.fields.taskId)).size,jobs);assert.ok(workers.every(n=>n>0));
   assert.equal((await controller.space.count({type:'Load'},producer)).count,(config.entries??jobs)-jobs);
   if(config.rpcFaults)assert.equal(faultSlots.size,config.rpcFaultBoundary==='both'?30:15,'all requested RPC boundaries, five effect kinds and all three Members must be exercised');
   const report={rpcFaults:!!config.rpcFaults,rpcFaultBoundary:config.rpcFaultBoundary,faults,sameParentRetries:retries,processCrashesExercised:false,mailboxAckFaultsExercised:false,passed:true,date:new Date().toISOString(),scope:'real-netbird-signed-wire-fixture',entries:config.entries??jobs,backgroundEntriesSeededLocally:(config.entries??jobs)-jobs,jobs,workers:6,workerJobs:workers,members:config.members.map((m:any)=>({id:m.id,peerId:m.peerId,ip:m.ip})),routerPeerId:controlPeerId,independentNetworkNamespaces:4,physicalServers:1,layerA:true,layerB:true,signedGrants:true,signedDelegation:true,signedRouterLease:true,fixtureProvisioning:true,independentBootRegisterExercised:false,productionServicesChanged:false,fullPhase2Accepted:false,primes:actual.length,sum:actual.reduce((a,b)=>a+b,0),elapsedMs:performance.now()-started};
   writeFileSync(join(common,'netbird-sieve.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  }else throw new Error('use prepare, member or run');
 }
}finally{for(const s of sockets)s.close();if(close)await close();await host.close(ctx);}
