// Operator-provisioned, persistent testbed daemon. Uses real NetBird management and independent boot records.
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, lstatSync, readdirSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import {createHash} from "node:crypto";
import {AsyncLocalStorage} from "node:async_hooks";
import {ProvingService} from "../../src/index.ts";
import { provisionFileSigner, loadFileSigner, privateFile, PiSpaces, bootstrapEnroll, hashToken, SqliteRecoveryRegister, listSpaces, spaceDoc, createSpace, startConfiguredFederation, startRecoveryOnly, startMemberRecoveryOnly, RemoteSpace, socketTransport, core, searchMembers, canonicalJson, type Taken, type FederationConfig, TlsRecoveryRegister, DataAdminController, RootHistoryErasure, RootErasures, snapshotSpace, FederationPending, FederationOperations, parentJournalKey, operationPartition } from "../../src/index.ts";
const [mode, home="/data/phase1b"] = process.argv.slice(2);
mkdirSync(home,{recursive:true,mode:0o700});
if(mode==="recovery-call") {
 let text="";for await(const part of process.stdin){text+=part.toString();if(Buffer.byteLength(text)>256*1024)throw new Error("recovery envelope exceeds budget");}JSON.parse(text);
 const normal=JSON.parse(privateFile(join(home,"federation.json")).toString()),recovery=normal.recovery??JSON.parse(privateFile(join(home,"recovery.json")).toString());
 const socket=socketTransport({path:recovery.path});try{process.stdout.write(await socket.request(text));}finally{socket.close();}process.exit(0);
}
if (["stop","status","fence"].includes(mode)) {
 const restart=join(home,"restart.lock"),ownerFile=join(home,"owner.lock");
 const processes=()=>readdirSync('/proc').filter(v=>/^[0-9]+$/.test(v)).filter(v=>{try{const args=readFileSync(`/proc/${v}/cmdline`,'utf8').split('\0');return args[1]===join(home,'federation-host.mjs')&&args[2]==='run'&&(args[3]===undefined||args[3]===''||args[3]===home);}catch{return false;}}).map(Number);
 if(mode==="fence") { let lockFd;try{lockFd=openSync(restart,'wx',0o600);writeFileSync(lockFd,JSON.stringify({at:Date.now(),reason:'F15-single-testbed-recovery'})+'\n');fsyncSync(lockFd);}catch(e){if((e as any).code!=='EEXIST')throw e;}finally{if(lockFd!==undefined)closeSync(lockFd);}const dirFd=openSync(home,'r');try{fsyncSync(dirFd);}finally{closeSync(dirFd);} }
 if(mode!=="status") {const running=processes();if(running.length){const owner=JSON.parse(privateFile(ownerFile).toString());if(owner.mode!=='run'||running.length!==1||owner.pid!==running[0])throw new Error('normal runtime ownership disagrees with process inventory');process.kill(owner.pid,'SIGTERM');const deadline=Date.now()+15000;while(processes().length){if(Date.now()>=deadline)throw new Error('normal runtime did not stop');await new Promise(r=>setTimeout(r,50));}}}
 let restartLocked=false;try{const stat=lstatSync(restart);restartLocked=stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0;}catch{}
 console.log(JSON.stringify({normalStopped:processes().length===0,restartLocked}));process.exit(0);
}
const configFile=join(home,"federation.json"), installed=new SqliteRecoveryRegister(join(home,"installed.sqlite"));
if (["recovery","member-recovery"].includes(mode) && !existsSync(join(home,"restart.lock"))) throw new Error("recovery requires a persistent restart lock");
if (mode==="run" && existsSync(join(home,"restart.lock"))) throw new Error("persistent recovery restart lock blocks the normal daemon");
// One harness writer. The operator removes a stale owner lock only after proving that its process is gone.
const lock=join(home,"owner.lock");const fd=openSync(lock,"wx",0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,mode})+'\n');closeSync(fd);
const h=await Harness.open(await openNodeSqliteStorage(join(home,"harness.sqlite")),{models:createModels(),registry:createRegistry()},ctx);
let runtime:Awaited<ReturnType<typeof startConfiguredFederation>>|undefined;
let recovery:Awaited<ReturnType<typeof startRecoveryOnly>>|undefined;
const cleanup=async()=>{await recovery?.close();await runtime?.close();await h.close(ctx);installed.close();unlinkSync(lock);};
try{
 if(mode==="provision"){
  let text="";for await(const part of process.stdin){text+=part.toString();if(Buffer.byteLength(text)>65536)throw new Error("provisioning input exceeds budget");}
  const input=JSON.parse(text);let config: FederationConfig;
  if(existsSync(configFile)){config=JSON.parse(privateFile(configFile).toString());if(config.hostId!==input.hostId||config.authorityId!==input.authorityId)throw new Error("existing provisioning differs");}
  else{
   const signer=provisionFileSigner(join(home,"signer.json"));
   await h.commit(tx=>spaceDoc(tx,undefined,Date.now()),ctx);
   if(input.mode==="control")await bootstrapEnroll(h,ctx,{tokenHash:hashToken(input.bootstrapToken),allowedPeerId:input.bootstrapPeerId});
   else await h.commit(tx=>createSpace(tx,"jobs",Date.now()),ctx);
   const spaces=await listSpaces(h,ctx);
   config={hostId:input.hostId,peerId:input.peerId,authorityId:input.authorityId,controlHostId:input.controlHostId,controlSpaceId:input.mode==="control"?spaces.find(s=>s.alias==="control")!.spaceId:input.controlSpaceId,mode:input.mode,listen:{host:input.ip,port:input.port??7421},keyFile:join(home,"signer.json"),installedRegisterFile:join(home,"installed.sqlite"),registerTls:input.registerTls??{host:"207.180.233.218",port:17422,caFile:join(home,"pki/ca.crt"),certFile:join(home,"pki/reader.crt"),keyFile:join(home,"pki/reader.key")},management:{url:"https://spacebird.eibrain.org",tokenFile:join(home,"management-token")},control:{address:{host:input.controlIp,port:input.controlPort??input.port??7421},algorithm:input.mode==="control"?signer.algorithm:input.controlAlgorithm,publicKey:input.mode==="control"?signer.publicKey:input.controlPublicKey},...(input.groupRoles?{groupRoles:input.groupRoles}:{}),...(input.capabilities?{capabilities:input.capabilities}:{})};
   if(input.mode==="member"&&input.memberId)config.membership={memberId:input.memberId,spaceId:spaces.find(s=>s.alias==="jobs")!.spaceId};
   writeFileSync(configFile,JSON.stringify(config)+'\n',{mode:0o600});
   for(const info of spaces)await installed.compareAndSet(`installed:${config.hostId}:${info.spaceId}`,null,{state:"active",authorityId:config.authorityId,dataIncarnation:info.incarnation,role:"local",transitionId:"bootstrap-20261011"});
   await installed.compareAndSet(`installed-authority:${config.controlSpaceId}`,null,{authorityId:config.authorityId});
   if(config.mode==="member"&&input.seedAcceptance!==false)await new PiSpaces(h,ctx,Date.now,undefined,undefined,{space:"jobs"}).write({type:"AcceptanceObject",fields:{origin:config.hostId,n:1}},null,core.FOREVER);
  }
  const signer=loadFileSigner(config.keyFile),spaces:Record<string,any>={};for(const info of await listSpaces(h,ctx))spaces[info.spaceId]=(await installed.get<any>(`installed:${config.hostId}:${info.spaceId}`))!.value;
  console.log(JSON.stringify({hostId:config.hostId,peerId:config.peerId,controlSpaceId:config.controlSpaceId,publicKey:signer.publicKey,keyId:signer.keyId,algorithm:signer.algorithm,boot:{hostId:config.hostId,state:"active",spaces}}));
 }else if(['erase-local','erase-evidence','erase-root','erase-stamp'].includes(mode)){
  let input='';for await(const part of process.stdin)input+=part.toString();if(Buffer.byteLength(input)>256*1024)throw Error('private erasure input exceeds budget');const q=JSON.parse(input),cfg=JSON.parse(privateFile(configFile).toString()) as FederationConfig;if(!cfg.registerTls)throw Error('private erasure requires independent TLS register');const external=new TlsRecoveryRegister(cfg.registerTls),sid=cfg.membership?.spaceId??cfg.controlSpaceId;
  const fenced=async()=>{const b=await external.get<any>('boot:'+cfg.hostId),s=await snapshotSpace(h,sid,ctx),owner=JSON.parse(privateFile(lock).toString());if(owner.pid!==process.pid||owner.mode!==mode||b?.value.state!=='fenced'||b.value.hostId!==cfg.hostId||b.value.spaces?.[sid]?.authorityId!==cfg.authorityId||b.value.spaces?.[sid]?.dataIncarnation!==s?.incarnation)throw Error('private erasure requires exclusive matching fenced host');};
  const admin=new DataAdminController({host:h,ctx,authorize:async()=>fenced(),assertAuthority:fenced});
  try{
   await fenced();let result:any;
   if(mode==='erase-evidence'){const s=(await snapshotSpace(h,sid,ctx))!,pid=canonicalJson([q.principal.peerId,q.principal.agentId??null]);result={spaceId:sid,entryIds:[...new Set([...s.entries.filter(e=>e.owner===pid).map(e=>e.id),...Object.values(s.rpc?.claims??{}).filter(c=>canonicalJson(c.principal as any)===canonicalJson(q.principal)&&c.method==='write'&&typeof(c.result as any)?.id==='string').map(c=>(c.result as any).id)])]};}
   else if(mode==='erase-local')result=await admin.execute(q.id,'deletePrincipal',sid,'exclusive-offline-operator',q.principal);
   else if(mode==='erase-root'){if(!cfg.root)throw Error('Root history is not provisioned');const eraser=new RootHistoryErasure({host:h,ctx,federationId:cfg.root.id,authorize:fenced,assertExclusiveFenced:fenced});const started=await eraser.start(q.id,q.principal);if(started.phase==='collecting')for(let n=0;n<(q.entryIds??[]).length;n+=32)await eraser.addEntryEvidence(q.id,q.entryIds.slice(n,n+32));result=await eraser.execute(q.id,q.principal);}
   else{if(!Number.isSafeInteger(q.epoch)||q.epoch<1||q.commandHash!==createHash('sha256').update(canonicalJson([q.id,q.principal])).digest('hex'))throw Error('invalid bound deletion stamp');await admin.execute(q.id,'deletePrincipal',sid,'exclusive-offline-operator',q.principal);if(cfg.root&&(await h.snapshot(RootErasures,cfg.root.id,ctx))?.operations[q.id]?.phase!=='completed')throw Error('Root journal erasure is incomplete');const floor=await external.get<any>('erasure:'+sid);if(floor?.value.state!=='pending'||floor.value.commandHash!==q.commandHash||floor.value.epoch!==q.epoch)throw Error('deletion stamp requires matching independent pending floor');await h.commit(async tx=>{await fenced();const s=await spaceDoc(tx,sid,Date.now());if((s.erasureEpoch??0)>q.epoch)throw Error('deletion epoch cannot regress');s.erasureEpoch=q.epoch;await fenced();},ctx);const p=(await installed.get<any>(`installed:${cfg.hostId}:${sid}`))!;await installed.compareAndSet(`installed:${cfg.hostId}:${sid}`,p.version,{...p.value,erasureEpoch:q.epoch});result={spaceId:sid,epoch:q.epoch,completed:true};}
   console.log(JSON.stringify(result));
  }finally{external.close();}
 }else if(mode==="bootstrap"){
  let text="";for await(const part of process.stdin)text+=part.toString();if(Buffer.byteLength(text)>65536)throw new Error("bootstrap input exceeds budget");const input=JSON.parse(text);await bootstrapEnroll(h,ctx,{tokenHash:hashToken(input.token),allowedPeerId:input.peerId});console.log(JSON.stringify({bootstrapPrepared:true,peerId:input.peerId}));
 }else if(mode==="enroll"){
  const config=JSON.parse(privateFile(configFile).toString()),signer=loadFileSigner(config.keyFile);let token="";for await(const part of process.stdin)token+=part.toString();token=token.trim();
  const socket=socketTransport(config.control.address);let remote:RemoteSpace;remote=new RemoteSpace(socket,{space:"control",signer,ownPeerId:config.peerId,expectedGateHostId:config.controlHostId,grantProvider:()=>remote.requestGrant()});
  try{console.log(JSON.stringify(await remote.enroll(token)));}finally{socket.close();}
 }else if(mode==="recovery"||mode==="member-recovery"){
  recovery=await (mode==="recovery"?startRecoveryOnly:startMemberRecoveryOnly)(h,ctx,join(home,"recovery.json"),async()=>{const owner=JSON.parse(privateFile(lock).toString());return{hostId:JSON.parse(privateFile(configFile).toString()).hostId,normalStopped:["recovery","member-recovery"].includes(owner.mode)&&owner.pid===process.pid,restartLocked:existsSync(join(home,"restart.lock"))};});
  console.log(JSON.stringify({recoveryReady:true}));await new Promise<void>(resolve=>{process.once("SIGTERM",resolve);process.once("SIGINT",resolve);});
 }else if(mode==="run"){
  // Testbed-only timing, scoped to an explicit read-only diagnostic action. No request contents or credentials.
  type Timing={calls:number;ms:number};const timings=new AsyncLocalStorage<Record<string,Timing>>();
  const observe=(object:any,name:string,label:string)=>{const original=object[name];object[name]=async function(...args:any[]){const bucket=timings.getStore(),start=performance.now();try{return await original.apply(this,args);}finally{if(bucket){const t=bucket[label]??={calls:0,ms:0};t.calls++;t.ms+=performance.now()-start;}}};};
  for(const method of ['get','getMany'])observe(TlsRecoveryRegister.prototype,method,'register.'+method);
  if(process.env.PI_SPACES_TESTBED_TRACE==='1'){
   const send=(RemoteSpace.prototype as any).send;(RemoteSpace.prototype as any).send=async function(...args:any[]){const bucket=timings.getStore(),label='wire.'+String(args[0]?.method??'unknown'),start=performance.now();try{return await send.apply(this,args);}finally{if(bucket){const t=bucket[label]??={calls:0,ms:0};t.calls++;t.ms+=performance.now()-start;}}};
   const handle=ProvingService.prototype.handle;ProvingService.prototype.handle=async function(...args:Parameters<typeof handle>){const bucket:Record<string,Timing>={},start=performance.now();return timings.run(bucket,async()=>{try{return await handle.apply(this,args);}finally{console.log(JSON.stringify({timingCall:(args[0] as any)?.method??'unknown',elapsedMs:Math.round(performance.now()-start),timings:bucket}));}});};
  }


  runtime=await startConfiguredFederation(h,ctx,configFile);console.log(JSON.stringify({ready:true,hostId:runtime.config.hostId,address:runtime.address()}));
  for(const method of ["snapshot","commit"])observe(h,method,"host."+method);
  if(runtime.root){for(const method of ["step","invoke","resolve"])observe(runtime.root.rpc,method,"rpc."+method);for(const method of ["prepare","admit","finish"])observe(runtime.root.space,method,"root."+method);}
  const acceptFile=process.env.PI_SPACES_ROOT_ACCEPTANCE_FILE;
  if(acceptFile){
   if(!runtime.root)throw new Error('native Root acceptance requires explicit Root provisioning');const nativeConfig=runtime.config;let stopped=false;process.once('SIGTERM',()=>{stopped=true;});process.once('SIGINT',()=>{stopped=true;});
   while(!stopped){
    if(!existsSync(acceptFile)){await new Promise(r=>setTimeout(r,100));continue;}
    const command=JSON.parse(privateFile(acceptFile).toString());unlinkSync(acceptFile);const out=acceptFile+'.result';
    try{
     const root:NonNullable<Awaited<ReturnType<typeof startConfiguredFederation>>['root']>=runtime.root;let result:any;
     if(command.action==='initialized'){const state=await root.policy.state();if(!state.policy||Object.keys(state.members).length!==Object.keys(nativeConfig.root!.members).length||!state.policy.completionProfiles.some(p=>p.taskType==='SieveTask'))throw Error('Supervisor setup is incomplete');result={policyVersion:state.policy.policyVersion,members:Object.keys(state.members)};
     }else if(command.action==='diagnose'){
      const id=command.requestId??'native-produce-1',partition=operationPartition(id,nativeConfig.root!.journalPartitions),journal=await h.snapshot(FederationOperations,parentJournalKey(nativeConfig.root!.id,nativeConfig.root!.journalPartitions,partition),ctx),parent=journal?.operations[id];if(!parent)throw Error('unknown diagnostic Parent');const children=[];for(const childId of Object.values(parent.children)){const child=await root.partitionRouters[partition]!.get(childId);if(!child)throw Error('diagnostic Child missing');let resolution;try{resolution=await root.rpc.resolve(child.steps[0]!);}catch(e){resolution={error:e instanceof Error?e.message:String(e),code:e instanceof Error?e.constructor.name:'unknown'};}children.push({id:child.id,state:child.state,steps:child.steps.map(s=>({state:s.state,evidence:s.evidence,requestId:s.requestId})),resolution});}result={id,phase:parent.phase,children};
     }else if(command.action==='profile-flow'){
      const requestId=command.requestId??'native-diagnostic-read-1';if(!/^[A-Za-z0-9._-]{1,64}$/.test(requestId))throw Error('bounded diagnostic identity required');const bucket:Record<string,Timing>={},start=performance.now();const value=await timings.run(bucket,()=>root.space.read({type:'SieveTask',fields:{taskId:'native-optimized-1-0'}},{id:requestId,principal:{peerId:nativeConfig.peerId,agentId:'root-profile'}}));result={requestId,found:!!value,elapsedMs:Math.round(performance.now()-start),timings:bucket};
     }else if(command.action==='profile-failed'){
      const id=command.requestId??'native-optimized-1-result-0',partition=operationPartition(id,nativeConfig.root!.journalPartitions),journal=await h.snapshot(FederationOperations,parentJournalKey(nativeConfig.root!.id,nativeConfig.root!.journalPartitions,partition),ctx),parent=journal?.operations[id];if(!parent||parent.phase!=='needsReview')throw Error('explicit failed Parent required');const childId=Object.values(parent.children)[0]!;const bucket:Record<string,Timing>={},start=performance.now();const receipt=await timings.run(bucket,async()=>{const child=await root.partitionRouters[partition]!.get(childId);if(!child?.steps[0])throw Error('original Child required');return root.rpc.resolve(child.steps[0]);});result={requestId:id,outcome:receipt.outcome,evidence:receipt.evidence??null,elapsedMs:Math.round(performance.now()-start),timings:bucket};
     }else if(command.action==='profile-read'){
      const bucket:Record<string,Timing>={},start=performance.now();const counted=await timings.run(bucket,()=>root.space.count({type:'SieveTask',fields:{taskId:'native-0'}},{peerId:nativeConfig.peerId,agentId:'root-profile'}));result={elapsedMs:Math.round(performance.now()-start),count:counted.count,timings:bucket};
     }else if(command.action==='sieve'){
      const stable=async<T>(run:()=>Promise<T>):Promise<T>=>{const deadline=Date.now()+300000;for(let attempt=0;;attempt++){if(stopped)throw Error('owned acceptance interrupted at an operation boundary');try{return await run();}catch(e){if(Date.now()>=deadline||!(e instanceof Error)||!(e instanceof FederationPending)&&!/delegation expired before decision|grant expired before commit/.test(e.message))throw e;console.log(JSON.stringify({acceptance:command.id,retry:attempt+1,...(e instanceof FederationPending?{requestId:e.requestId}:{}),reason:e.message}));await new Promise(r=>setTimeout(r,100));}}};const jobs=command.jobs??12;if(!Number.isSafeInteger(jobs)||jobs<6||jobs>1000)throw Error('bounded native acceptance workload required');const runId=command.runId;if(runId!==undefined&&(typeof runId!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/).test(runId)))throw Error('bounded explicit run identity required');const prefix=runId??'native',runFields:Record<string,string>=runId?{runId}:{},policy=(await root.policy.state()).policy!,peerId=nativeConfig.peerId,p={peerId,agentId:'native-producer'},primes=(start:number,end:number)=>{const a:number[]=[];for(let n=Math.max(2,start);n<=end;n++){let ok=true;for(let d=2;d*d<=n;d++)if(n%d===0){ok=false;break;}if(ok)a.push(n);}return a;};
      for(let n=0;n<jobs;n++){const started=performance.now();await stable(()=>root.space.write({type:'SieveTask',fields:{taskId:prefix+'-'+n,rangeStart:n*100+1,rangeEnd:(n+1)*100,...runFields}},{id:prefix+'-produce-'+n,principal:p},core.FOREVER));console.log(JSON.stringify({acceptance:command.id,stage:'produce',job:n,elapsedMs:Math.round(performance.now()-started)}));}
      let workerTail:Promise<unknown>=Promise.resolve(),workerFailure:unknown;
      const serialTransaction=<T>(run:()=>Promise<T>)=>{const next=workerTail.then(()=>{if(workerFailure)throw workerFailure;return run();});workerTail=next.catch(e=>{workerFailure=e;});return next;};
      const outcomes=await Promise.allSettled(Array.from({length:6},async(_,w)=>{for(let n=w;n<jobs;n+=6)await serialTransaction(async()=>{
       const started=performance.now(),taskId=prefix+'-'+n,q={peerId,agentId:'native-worker-'+w},member=searchMembers(policy,{type:'SieveTask',fields:{taskId}})[0]!;
       const timed=async<T>(stage:string,run:()=>Promise<T>):Promise<T>=>{const at=performance.now();try{const value=await stable(run);console.log(JSON.stringify({acceptance:command.id,stage,job:n,worker:w,elapsedMs:Math.round(performance.now()-at)}));return value;}catch(e){console.log(JSON.stringify({acceptance:command.id,stage,job:n,failed:true,elapsedMs:Math.round(performance.now()-at)}));throw e;}};
       const txn=await timed('begin',()=>root.space.createTransaction(member,60000,{id:prefix+'-begin-'+n,principal:q}));
       const task=await timed('take',()=>root.space.take({type:'SieveTask',fields:{taskId}},{id:prefix+'-take-'+n,principal:q,txn})) as Taken|null;if(!task)throw Error('native task missing');
       await timed('result',()=>root.space.write({type:'SieveResult',fields:{...task.fields,primes:primes(Number(task.fields.rangeStart),Number(task.fields.rangeEnd))}},{id:prefix+'-result-'+n,principal:q,txn},core.FOREVER));
       await timed('commit',()=>root.space.finishTransaction(prefix+'-begin-'+n,'commit',{id:prefix+'-commit-'+n,principal:q}));
       console.log(JSON.stringify({acceptance:command.id,stage:'job-complete',job:n,worker:w,elapsedMs:Math.round(performance.now()-started)}));
      });}));const failed=outcomes.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
      const results=await root.space.readAll({type:'SieveResult',fields:runFields},p),values=results.entries.flatMap(e=>e.fields.primes as number[]).sort((a,b)=>a-b);if(results.entries.length!==jobs||new Set(results.entries.map(e=>e.fields.taskId)).size!==jobs||canonicalJson(values)!==canonicalJson(primes(1,jobs*100))||(await root.space.count({type:'SieveTask',fields:runFields},p)).count!==0)throw Error('native result comparison failed');result={...(runId?{runId}:{}),jobs,workers:6,maxInFlightTransactions:1,uniqueResults:jobs,primes:values.length,taskCount:0};
     }else if(command.action==='domain-write'){
      result=await root.space.write({type:'DomainProbe',fields:{nonce:'physical-domain-20261015'}},{id:'domain-probe-write',principal:{peerId:nativeConfig.peerId,agentId:'domain-probe'}},core.FOREVER);
     }else if(command.action==='domain-read'){
      const entry=await root.space.read({type:'DomainProbe',fields:{nonce:'physical-domain-20261015'}},{id:'domain-probe-read',principal:{peerId:nativeConfig.peerId,agentId:'domain-probe'}});const value=entry as unknown as {fields?:{nonce?:string}};if(value?.fields?.nonce!=='physical-domain-20261015')throw Error('cross-host persisted entry missing');result={found:true,nonce:value.fields.nonce};
     }else if(command.action==='domain-unavailable'){
      let unavailable=false;try{await root.space.count({type:'DomainProbe'},{peerId:nativeConfig.peerId,agentId:'domain-probe'});}catch{unavailable=true;}if(!unavailable)throw Error('stopped remote Member unexpectedly answered');const other=await root.space.count({type:'SieveTask',fields:{taskId:'domain-control-check'}},{peerId:nativeConfig.peerId,agentId:'domain-probe'});result={remoteUnavailable:unavailable,unaffectedCount:other.count};
     }else if(command.action==='erase-seed'){
      const policy=(await root.policy.state()).policy!,p={peerId:nativeConfig.peerId,agentId:'erase-subject'},other={peerId:nativeConfig.peerId,agentId:'erase-other'},found:Record<string,string>={};for(let n=0;n<10000&&Object.keys(found).length<3;n++){const taskId='privacy-probe-'+n,id=searchMembers(policy,{type:'SieveResult',fields:{taskId}})[0]!;found[id]??=taskId;}if(Object.keys(found).length!==3)throw Error('privacy probe must cover all three Members');const entryIds:string[]=[];for(const [member,taskId]of Object.entries(found))for(let n=0;n<3;n++){const lease=await root.space.write({type:'SieveResult',fields:{taskId,rangeStart:0,rangeEnd:0,deletionProbe:true,value:'privacy-probe-payload',n}},{id:'privacy-write-'+member+'-'+n,principal:p},core.FOREVER);entryIds.push((lease as any).id);}const taskId=Object.values(found)[0]!,template={type:'SieveResult',fields:{taskId,deletionProbe:true,n:0}};await root.space.read(template,{id:'privacy-read-own',principal:p});await root.space.read(template,{id:'privacy-read-foreign',principal:other});result={subject:p,entryIds,coveredMembers:Object.keys(found),foreignParent:'privacy-read-foreign',template};
     }else if(command.action==='erase-check'){
      const expired:Record<string,boolean>={};for(const id of ['privacy-write-a-0','privacy-read-own','privacy-read-foreign']){try{await root.space.resume(id);expired[id]=false;}catch(e){expired[id]=e instanceof Error&&e.constructor.name==='ResultExpired';}}if(Object.values(expired).some(v=>!v))throw Error('erased original Parent replay did not expire');const remaining=await root.space.readAll({type:'SieveResult',fields:{deletionProbe:true}},{peerId:nativeConfig.peerId,agentId:'erase-other'});if(remaining.entries.length)throw Error('principal Entries survived distributed deletion');result={originalParentReplayExpired:expired,remainingEntries:remaining.entries.length};
     }else if(command.action==='status'){await root.directory!.refresh();result={members:(await root.policy.state()).members};}
     else if(command.action==='boot-check'){await root.space.initializeJournals();result={allowed:true};}
     else throw Error('unknown private acceptance action');
     writeFileSync(out,JSON.stringify({id:command.id,passed:true,result})+'\n',{mode:0o600});
    }catch(e){writeFileSync(out,JSON.stringify({id:command.id,passed:false,error:e instanceof Error?e.message:String(e)})+'\n',{mode:0o600});}
   }
  }else await new Promise<void>(resolve=>{process.once("SIGTERM",resolve);process.once("SIGINT",resolve);});
 }else throw new Error("use provision, bootstrap, enroll, recovery or run");
}finally{await cleanup();}
