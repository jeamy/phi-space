// Operator-provisioned, persistent testbed daemon. Uses real NetBird management and independent boot records.
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, lstatSync, readdirSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import {createHash} from "node:crypto";
import {AsyncLocalStorage} from "node:async_hooks";
import {staleOwnerLock,procStartTime,clearStaleOwnerLock} from "./owner-lock.ts";
import {ProvingService,EntryReplicationController,lastConfigTransition,promotionEvidence,releaseHostToQuarantine,openSyncSpace,bootstrapPrimarySync,captureStore,primarySyncStorage,recoverPrimarySync,assertSyncPrimary,startQuarantineReplicas,BootBlocked,PrimarySyncJournal,assertSyncStandby,promote,degradeToSingle,setStandby,TlsRecoveryRegister as SyncRegister,TlsFencing,signedReplicaPeer,materializeSyncHistory,canonicalJson as syncCanonical} from "../../src/index.ts";
import { provisionFileSigner, loadFileSigner, privateFile, PiSpaces, bootstrapEnroll, hashToken, SqliteRecoveryRegister, listSpaces, spaceDoc, createSpace, startConfiguredFederation, startRecoveryOnly, startMemberRecoveryOnly, RemoteSpace, socketTransport, core, searchMembers, canonicalJson, type Taken, type FederationConfig, TlsRecoveryRegister, DataAdminController, RootHistoryErasure, RootErasures, snapshotSpace, FederationPending, FederationOperations, parentJournalKey, operationPartition } from "../../src/index.ts";
const [mode, home="/data/phase1b"] = process.argv.slice(2);
mkdirSync(home,{recursive:true,mode:0o700});
if(mode==="recovery-call") {
 let text="";for await(const part of process.stdin){text+=part.toString();if(Buffer.byteLength(text)>256*1024)throw new Error("recovery envelope exceeds budget");}JSON.parse(text);
 const normal=JSON.parse(privateFile(join(home,"federation.json")).toString()),recovery=normal.recovery??JSON.parse(privateFile(join(home,"recovery.json")).toString());
 const socket=socketTransport({path:recovery.path});try{process.stdout.write(await socket.request(text));}finally{socket.close();}process.exit(0);
}
if(mode==="release") {
 // Releases a fenced host into quarantine (boot CAS, then the fencing adapter unlocks and starts it), run on the
 // other replica host whose certificate holds the register and fencing rights. No owner lock, no Harness.
 let text="";for await(const part of process.stdin){text+=part.toString();if(Buffer.byteLength(text)>16384)throw new Error("release input exceeds budget");}
 const q=JSON.parse(text),register=new SyncRegister(q.controlRegister);
 try{const b=await releaseHostToQuarantine(register,q.hostId,q.recoveryId,new TlsFencing(q.fencing));console.log(JSON.stringify({hostId:q.hostId,state:b.state}));}finally{register.close();}
 process.exit(0);
}
if(mode==="enroll-key") {
 // An additional key of this host (e.g. the native Root's router and host keys), enrolled at the control gate while the
 // daemon runs: no owner lock, no Harness. The private key is created here and never leaves the host.
 let text="";for await(const part of process.stdin){text+=part.toString();if(Buffer.byteLength(text)>4096)throw new Error("enrollment input exceeds budget");}
 const q=JSON.parse(text),config=JSON.parse(privateFile(join(home,"federation.json")).toString());
 if(typeof q.token!=="string"||typeof q.keyName!=="string"||!/^[a-z][a-z0-9-]{0,31}$/.test(q.keyName))throw new Error("enroll-key needs a token and a bounded keyName");
 mkdirSync(join(home,"root"),{recursive:true,mode:0o700});const keyFile=join(home,"root",q.keyName+".json"),signer=existsSync(keyFile)?loadFileSigner(keyFile):provisionFileSigner(keyFile,"ed25519");
 // q.control: another control host than the configured one (a future control host enrolls at the current one).
 const control=q.control??{address:config.control.address,hostId:config.controlHostId};
 const socket=socketTransport(control.address,{localAddress:config.listen.host,connectTimeoutMs:8000});let remote:RemoteSpace;remote=new RemoteSpace(socket,{space:"control",signer,ownPeerId:config.peerId,expectedGateHostId:control.hostId,grantProvider:()=>remote.requestGrant()});
 try{console.log(JSON.stringify({keyFile,keyId:signer.keyId,algorithm:signer.algorithm,publicKey:signer.publicKey,result:await remote.enroll(q.token.trim())}));}finally{socket.close();}process.exit(0);
}
if (["stop","status","fence"].includes(mode)) {
 const restart=join(home,"restart.lock"),ownerFile=join(home,"owner.lock");
 const processes=()=>readdirSync('/proc').filter(v=>/^[0-9]+$/.test(v)).filter(v=>{try{const args=readFileSync(`/proc/${v}/cmdline`,'utf8').split('\0');return args[1]===join(home,'federation-host.mjs')&&args[2]==='run'&&(args[3]===undefined||args[3]===''||args[3]===home);}catch{return false;}}).map(Number);
 if(mode==="fence") { let lockFd;try{lockFd=openSync(restart,'wx',0o600);writeFileSync(lockFd,JSON.stringify({at:Date.now(),reason:'F15-single-testbed-recovery'})+'\n');fsyncSync(lockFd);}catch(e){if((e as any).code!=='EEXIST')throw e;}finally{if(lockFd!==undefined)closeSync(lockFd);}const dirFd=openSync(home,'r');try{fsyncSync(dirFd);}finally{closeSync(dirFd);} }
 if(mode!=="status") {const running=processes();if(running.length){const owner=JSON.parse(privateFile(ownerFile).toString());if(owner.mode!=='run'||running.length!==1||owner.pid!==running[0])throw new Error('normal runtime ownership disagrees with process inventory');process.kill(owner.pid,'SIGTERM');const deadline=Date.now()+60000;while(processes().length){if(Date.now()>=deadline)throw new Error('normal runtime did not stop');await new Promise(r=>setTimeout(r,50));}}}
 let restartLocked=false;try{const stat=lstatSync(restart);restartLocked=stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0;}catch{}
 console.log(JSON.stringify({normalStopped:processes().length===0,restartLocked}));process.exit(0);
}
if(mode==="sync-head"){
 // Read-only journal view of every primary/sync Space; safe while the daemon runs.
 const cfg=JSON.parse(privateFile(join(home,"federation.json")).toString());
 const out=(cfg.syncSpaces??[]).map((c:any)=>{const j=new PrimarySyncJournal(join(c.dir,"journal.sqlite"),c.genesis);try{return{alias:c.alias,head:j.head(),applied:j.appliedRevision,config:j.config,open:j.openTransitionIds(),recoveredCommitted:j.recoveredCommitted};}finally{j.close();}});
 console.log(JSON.stringify(out));process.exit(0);
}
const configFile=join(home,"federation.json"), installed=new SqliteRecoveryRegister(join(home,"installed.sqlite"));
if (["recovery","member-recovery"].includes(mode) && !existsSync(join(home,"restart.lock"))) throw new Error("recovery requires a persistent restart lock");
if (mode==="run" && existsSync(join(home,"restart.lock"))) throw new Error("persistent recovery restart lock blocks the normal daemon");
// One harness writer. A lock whose process is provably gone (earlier boot, or no process with its PID and start time)
// is cleared by the daemon itself; anything else stays for the operator.
const bootId=(()=>{try{return readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();}catch{return null;}})(),startTime=procStartTime('self');
const lock=join(home,"owner.lock");
if(existsSync(lock)){try{const text=privateFile(lock).toString(),old=JSON.parse(text),why=staleOwnerLock(old,{bootId,pid:process.pid,startTime:procStartTime});if(why&&clearStaleOwnerLock(lock,text)){console.error(JSON.stringify({staleOwnerLockCleared:{pid:old.pid,mode:old.mode,reason:why,...(why==='previousBoot'?{previousBoot:old.bootId}:{})}}));}}catch(e){if(!(e instanceof SyntaxError))throw e;}}
const fd=openSync(lock,"wx",0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,mode,bootId,startTime})+'\n');closeSync(fd);
const releaseLock=()=>{try{unlinkSync(lock);}catch{}};
// SIGTERM is caught from here on: a stop during startup lets the mode finish starting and then clean up (release the
// lock) instead of killing the process with its lock in place. A second signal kills as before (the handler is once).
let restartExit=false;let terminated=false;const terminate=new Promise<void>(resolve=>{const f=()=>{terminated=true;resolve();};process.once("SIGTERM",f);process.once("SIGINT",f);});
// 3.8: a host's main store on primary/sync (the control host). Only `run` serves it, `main-sync` administers it with
// the daemon stopped; every other mode would bypass its journal and is refused.
const mainCfg=existsSync(configFile)?JSON.parse(privateFile(configFile).toString()).mainSync:undefined;
if(mode==="replica-listen"){
 // A replica of another host's main store (control standby): journal and signed listener only, no Harness, no gate.
 try{
  const rc=JSON.parse(privateFile(join(home,"replica.json")).toString()),external=new SyncRegister(rc.registerTls);
  const sp=await openSyncSpace({config:rc.replica,hostId:rc.hostId,authorityId:rc.replica.genesis.authorityId,bindIp:rc.listen.host,signer:loadFileSigner(rc.keyFile),external,installed,ctx,openStorage:p=>openNodeSqliteStorage(p),openHarness:async()=>{throw new Error("no Harness on a replica listener");},listenOnly:true});
  console.log(JSON.stringify({replicaListening:true,alias:rc.replica.alias,head:sp.journal.head()}));
  await terminate;
  await sp.close();external.close();
 }finally{installed.close();releaseLock();}
 process.exit(0);
}
if(mode==="main-sync"){
 // Operator tool for the main store on primary/sync, daemon stopped: bootstrap, status, degrade, set-standby.
 let result:any;
 try{
  if(!mainCfg)throw new Error("no mainSync provisioning");
  let text="";for await(const part of process.stdin){text+=part.toString();if(Buffer.byteLength(text)>65536)throw new Error("main-sync input exceeds budget");}
  const q=JSON.parse(text),cfg=JSON.parse(privateFile(configFile).toString()),reader=new SyncRegister(cfg.registerTls);
  const journal=new PrimarySyncJournal(join(mainCfg.dir,"journal.sqlite"),mainCfg.genesis,{self:cfg.hostId,assertStandby:assertSyncStandby(reader,cfg.hostId)}),st=await openNodeSqliteStorage(join(home,"harness.sqlite"));
  try{
   const status=()=>({head:journal.head(),applied:journal.appliedRevision,config:journal.config,open:journal.openTransitionIds()});
   if(q.op==="status")result={...status(),...(q.digest?{storeHash:(await captureStore(st,ctx)).digest}:{})};
   else if(q.op==="bootstrap")result={...(await bootstrapPrimarySync(st,journal,ctx)),...status()};
   else if(q.op==="wipe"){
    // An excluded old primary sets its history aside before it becomes a setStandby target in quarantine.
    const b=await reader.get<any>("boot:"+cfg.hostId);if(b?.value.state==="active")throw new Error("an active host keeps its history; wipe only a fenced or quarantined replica");
    await st.close(ctx);journal.close();const fs=await import("node:fs"),stamp=Date.now(),asideDir=mainCfg.dir+".aside-"+stamp;fs.renameSync(mainCfg.dir,asideDir);
    for(const f of ["harness.sqlite","harness.sqlite-wal","harness.sqlite-shm"])if(fs.existsSync(join(home,f)))fs.renameSync(join(home,f),join(home,f+".aside-"+stamp));
    result={aside:asideDir};
   }
   else if(["degrade","set-standby","promote"].includes(q.op)){
    // Step 6 (v3 5.3.1): the next start aligns the routing policy before serving; nothing may block that afterwards.
    const profiles=await st.findDocument({kind:"pi-spaces.profile-transitions",key:cfg.controlSpaceId,scope:{kind:"session"}},"current",ctx),open=profiles&&Object.values((await st.document(profiles.id,"current",ctx))?.value?.operations??{}).some((op:any)=>op.phase!=="completed");
    if(open)throw new Error("an open profile transition blocks the policy step of a control transition");
    const register=new SyncRegister(q.controlRegister),siblings:string[]=q.siblings??[];
    try{
     const base={storage:st,journal,register,hostId:cfg.hostId,dataIncarnation:q.dataIncarnation,ctx,siblingSpaces:siblings};
     // The replica to fence is the other one: before a promotion the primary, once it is applied (resumed) the standby.
     const other=(n:string|null|undefined)=>{if(!n||n===cfg.hostId)throw new Error("refusing to fence this host itself");return n;};
     if(q.op==="promote"){const adapter=new TlsFencing(q.fencing),c=journal.config,proof=await adapter.fence(other(c.primaryReplica===cfg.hostId?c.standbyReplica:c.primaryReplica),`promote ${q.tid}`);
      result={...(await promote({...base,recoveryId:q.tid,expectedPrimaryEpoch:q.epoch,expectedReplicaConfigVersion:q.version,adapter,proof})),proof:{kind:proof.kind,evidence:proof.evidence}};}
     else if(q.op==="degrade"){const adapter=new TlsFencing(q.fencing),proof=await adapter.fence(other(journal.config.standbyReplica),`degrade ${q.tid}`);
      result={...(await degradeToSingle({...base,recoveryId:q.tid,expectedPrimaryEpoch:q.epoch,expectedReplicaConfigVersion:q.version,adapter,proof})),proof:{kind:proof.kind,evidence:proof.evidence}};}
     else{const peer=mainCfg.peers.find((x:any)=>x.hostId===q.target);if(!peer)throw new Error("unpinned target");const t=socketTransport({host:peer.ip,port:mainCfg.port},{localAddress:cfg.listen.host,connectTimeoutMs:8000,maxFrameBytes:1<<20});
      try{result=await setStandby({...base,transitionId:q.tid,target:signedReplicaPeer({transport:t,signer:loadFileSigner(cfg.keyFile),self:cfg.hostId,remote:peer}),targetDataIncarnation:q.dataIncarnation});}finally{t.close();}}
    }finally{register.close();}
   }else throw new Error("unknown main-sync op");
  }finally{try{await st.close(ctx);}catch{}try{journal.close();}catch{}reader.close();}
  console.log(JSON.stringify(result));
 }finally{installed.close();releaseLock();}
 process.exit(0);
}
if(mainCfg&&mode!=="run")throw new Error("a primary/sync main store opens only in run or main-sync");
if(mainCfg&&mode==="run"){
 // A replica of the main store (standby, quarantined setStandby target, or a host that lost control by promotion):
 // journal and signed listener only, no Harness and no gate. Once a promotion makes it primary, the next start serves.
 const cfg=JSON.parse(privateFile(configFile).toString()),external=new SyncRegister(cfg.registerTls);
 const probe=new PrimarySyncJournal(join(mainCfg.dir,"journal.sqlite"),mainCfg.genesis,{self:cfg.hostId}),primary=probe.config.primaryReplica;probe.close();
 const boot=(await external.get<any>("boot:"+cfg.hostId))?.value;
 if(primary!==cfg.hostId||boot?.state==="quarantine"){
  try{
   if(!mainCfg.incarnation)throw new Error("a main store replica needs mainSync.incarnation (data incarnation of the control Space)");
   const sp=await openSyncSpace({config:{alias:"control-main",spaceId:mainCfg.genesis.spaceId,incarnation:mainCfg.incarnation,dir:mainCfg.dir,genesis:mainCfg.genesis,port:mainCfg.port,peers:mainCfg.peers},hostId:cfg.hostId,authorityId:mainCfg.genesis.authorityId,bindIp:cfg.listen.host,signer:loadFileSigner(cfg.keyFile),external,installed,ctx,openStorage:p=>openNodeSqliteStorage(p),openHarness:async()=>{throw new Error("no Harness on a main store replica");},listenOnly:true});
   console.log(JSON.stringify({mainReplicaListening:true,boot:boot?.state??null,head:sp.journal.head(),config:sp.journal.config}));
   await terminate;await sp.close();
  }finally{external.close();installed.close();releaseLock();}
  process.exit(0);
 }
 external.close();
}
let mainJournal:PrimarySyncJournal|undefined;
// Handles of the main store beside its Harness; open ones keep the event loop alive after SIGTERM (seen on host-a:
// a sync-mode daemon released its owner lock but never exited while its standby transport stayed open).
const mainHandles:Array<()=>void>=[];
const openMain=async()=>{
 const cfg=JSON.parse(privateFile(configFile).toString()),external=new SyncRegister(cfg.registerTls);
 mainHandles.push(()=>external.close());
 mainJournal=new PrimarySyncJournal(join(mainCfg.dir,"journal.sqlite"),mainCfg.genesis,{self:cfg.hostId,assertStandby:assertSyncStandby(external,cfg.hostId)});
 mainHandles.push(()=>mainJournal!.close());
 if(mainJournal.config.primaryReplica!==cfg.hostId)throw new BootBlocked("this host is not the primary of its main store");
 const standby=mainJournal.config.durability==="single"?undefined:mainCfg.peers.find((x:any)=>x.hostId===mainJournal!.config.standbyReplica);
 if(mainJournal.config.durability!=="single"&&!standby)throw new BootBlocked("the standby of the main store is not provisioned");
 const transport=standby?socketTransport({host:standby.ip,port:mainCfg.port},{localAddress:cfg.listen.host,connectTimeoutMs:8000,maxFrameBytes:1<<20}):undefined;
 if(transport)mainHandles.push(()=>transport.close());
 const peer=transport?signedReplicaPeer({transport,signer:loadFileSigner(cfg.keyFile),self:cfg.hostId,remote:standby}):null;
 const raw=await openNodeSqliteStorage(join(home,"harness.sqlite")),assert=assertSyncPrimary(external,cfg.hostId,mainJournal);
 await recoverPrimarySync(raw,mainJournal,peer,ctx,assert);
 return Harness.open(primarySyncStorage(raw,mainJournal,peer,{assertPrimary:assert}),{models:createModels(),registry:createRegistry()},ctx);
};
const h=mainCfg?await openMain():await Harness.open(await openNodeSqliteStorage(join(home,"harness.sqlite")),{models:createModels(),registry:createRegistry()},ctx);
let runtime:Awaited<ReturnType<typeof startConfiguredFederation>>|undefined;
let recovery:Awaited<ReturnType<typeof startRecoveryOnly>>|undefined;
const cleanup=async()=>{await recovery?.close();await runtime?.close();await h.close(ctx);for(const close of mainHandles.splice(0).reverse()){try{close();}catch{}}installed.close();unlinkSync(lock);};
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
  let input='';for await(const part of process.stdin)input+=part.toString();if(Buffer.byteLength(input)>256*1024)throw Error('private erasure input exceeds budget');const q=JSON.parse(input),cfg=JSON.parse(privateFile(configFile).toString()) as FederationConfig;if(!cfg.registerTls)throw Error('private erasure requires independent TLS register');const external=new TlsRecoveryRegister(cfg.registerTls),erCfg=(cfg as any).entryReplication;
  // The erased Space: the Membership Space, a merge Member's replicated Space, or the control Space.
  const sid=cfg.membership?.spaceId??(erCfg&&cfg.mode==='member'?(await listSpaces(h,ctx)).find(i=>i.alias===erCfg.space||i.spaceId===erCfg.space)?.spaceId??cfg.controlSpaceId:cfg.controlSpaceId);
  const fenced=async()=>{const b=await external.get<any>('boot:'+cfg.hostId),s=await snapshotSpace(h,sid,ctx),owner=JSON.parse(privateFile(lock).toString());if(owner.pid!==process.pid||owner.mode!==mode||b?.value.state!=='fenced'||b.value.hostId!==cfg.hostId||b.value.spaces?.[sid]?.authorityId!==cfg.authorityId||b.value.spaces?.[sid]?.dataIncarnation!==s?.incarnation)throw Error('private erasure requires exclusive matching fenced host');};
  const admin=new DataAdminController({host:h,ctx,authorize:async()=>fenced(),assertAuthority:fenced});
  // lww/set: the replicated entry history of this host is erased in the same exclusive, fenced procedure.
  const er=(cfg as any).entryReplication,merge=er?new EntryReplicationController({host:h,ctx,config:{spaceId:er.spaceId,authorityId:cfg.authorityId,replicaId:er.replicaId,incarnation:er.incarnation,members:er.members,rules:er.rules},authorize:async()=>fenced(),assertActive:fenced,clockUncertaintyMs:()=>er.clockUncertaintyMs??1000}):undefined;
  try{
   await fenced();let result:any;
   if(mode==='erase-evidence'){const s=(await snapshotSpace(h,sid,ctx))!,pid=canonicalJson([q.principal.peerId,q.principal.agentId??null]);result={spaceId:sid,entryIds:[...new Set([...s.entries.filter(e=>e.owner===pid).map(e=>e.id),...Object.values(s.rpc?.claims??{}).filter(c=>canonicalJson(c.principal as any)===canonicalJson(q.principal)&&c.method==='write'&&typeof(c.result as any)?.id==='string').map(c=>(c.result as any).id),...(merge?await merge.changeIdsOwnedBy(q.principal):[])])]};}
   else if(mode==='erase-local'){result=await admin.execute(q.id,'deletePrincipal',sid,'exclusive-offline-operator',q.principal);
    if(merge){await merge.erasePrincipal(q.id,q.principal,{peerId:'exclusive-offline-operator'});result={...result,merge:await merge.completeErasure(q.id+'-merge')};}}
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
  console.log(JSON.stringify({recoveryReady:true}));await terminate;
 }else if(mode==="run"){
  // Testbed-only timing, scoped to an explicit read-only diagnostic action. No request contents or credentials.
  type Timing={calls:number;ms:number};const timings=new AsyncLocalStorage<Record<string,Timing>>();
  const observe=(object:any,name:string,label:string)=>{const original=object[name];object[name]=async function(...args:any[]){const bucket=timings.getStore(),start=performance.now();try{return await original.apply(this,args);}finally{if(bucket){const t=bucket[label]??={calls:0,ms:0};t.calls++;t.ms+=performance.now()-start;}}};};
  for(const method of ['get','getMany'])observe(TlsRecoveryRegister.prototype,method,'register.'+method);
  if(process.env.PI_SPACES_TESTBED_TRACE==='1'){
   const send=(RemoteSpace.prototype as any).send;(RemoteSpace.prototype as any).send=async function(...args:any[]){const bucket=timings.getStore(),label='wire.'+String(args[0]?.method??'unknown'),start=performance.now();try{return await send.apply(this,args);}finally{if(bucket){const t=bucket[label]??={calls:0,ms:0};t.calls++;t.ms+=performance.now()-start;}}};
   const handle=ProvingService.prototype.handle;ProvingService.prototype.handle=async function(...args:Parameters<typeof handle>){const bucket:Record<string,Timing>={},start=performance.now();return timings.run(bucket,async()=>{try{return await handle.apply(this,args);}finally{console.log(JSON.stringify({timingCall:(args[0] as any)?.method??'unknown',elapsedMs:Math.round(performance.now()-start),timings:bucket}));}});};
  }


  const syncFactories={openSyncStorage:(path:string)=>openNodeSqliteStorage(path),openSyncHarness:(storage:any)=>Harness.open(storage,{models:createModels(),registry:createRegistry()},ctx),...(mainJournal?{mainReplica:()=>mainJournal!.config,mainTransition:()=>lastConfigTransition(mainJournal!),mainPromotionProof:(e:number)=>promotionEvidence(mainJournal!,e,JSON.parse(privateFile(configFile).toString()).hostId)}:{})};
  let quarantine:Awaited<ReturnType<typeof startQuarantineReplicas>>|undefined;
  if(JSON.parse(privateFile(configFile).toString()).syncSpaces?.length){try{quarantine=await startQuarantineReplicas(ctx,configFile,syncFactories);}catch(e){if(!(e instanceof BootBlocked)||!/not in quarantine/.test(e.message))throw e;}}
  if(quarantine){
   // Quarantine: only replica listeners for setStandby; the host leaves once the register says active again.
   console.log(JSON.stringify({quarantine:true,listeners:quarantine.spaces.map(sp=>sp.config.alias),failed:quarantine.failed}));
   const signal=terminate.then(()=>false);
   const active=await Promise.race([quarantine.untilActive(),signal]);await quarantine.close();
   console.log(JSON.stringify({leftQuarantine:active,next:active?"re-admit the other Spaces of this host, then start the normal daemon":"stopped"}));
  }else{
  runtime=await startConfiguredFederation(h,ctx,configFile,syncFactories);console.log(JSON.stringify({ready:true,hostId:runtime.config.hostId,address:runtime.address()}));
  for(const method of ["snapshot","commit"])observe(h,method,"host."+method);
  if(runtime.root){for(const method of ["step","invoke","resolve"])observe(runtime.root.rpc,method,"rpc."+method);for(const method of ["prepare","admit","finish"])observe(runtime.root.space,method,"root."+method);}
  const acceptFile=process.env.PI_SPACES_ROOT_ACCEPTANCE_FILE;
  if(acceptFile){
   if(!runtime.root)throw new Error('native Root acceptance requires explicit Root provisioning');const nativeConfig=runtime.config;let stopped=terminated;void terminate.then(()=>{stopped=true;});void runtime.controlChanged.then(c=>{console.log(JSON.stringify({controlHostChanged:c.targetHostId,recoveryId:c.recoveryId,restart:true}));restartExit=true;stopped=true;});
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
     }else if(command.action==='routed-write'){
      // Routed through the native Root (delegation to the Member that owns the type), e.g. a primary/sync Member.
      if(typeof command.type!=='string'||!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(command.type)||typeof command.requestId!=='string'||!/^[A-Za-z0-9._-]{1,64}$/.test(command.requestId))throw Error('bounded routed write required');
      const entry=await root.space.write({type:command.type,fields:{...(command.fields??{})}},{id:command.requestId,principal:{peerId:nativeConfig.peerId,agentId:'routed-probe'}},core.FOREVER);result={written:true,entry:(entry as any)?.id??null};
     }else if(command.action==='routed-count'){
      if(typeof command.type!=='string'||!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(command.type))throw Error('bounded routed count required');
      result=await root.space.count({type:command.type},{peerId:nativeConfig.peerId,agentId:'routed-probe'});
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
  }else{const changed=await Promise.race([terminate.then(()=>null),runtime.controlChanged]);if(changed){console.log(JSON.stringify({controlHostChanged:changed.targetHostId,recoveryId:changed.recoveryId,restart:true}));restartExit=true;}}
  }
 }else if(mode==="sync"){
  // Operator tool for one primary/sync Space, with the daemon stopped (this mode holds the owner lock).
  let text="";for await(const part of process.stdin){text+=part.toString();if(Buffer.byteLength(text)>65536)throw new Error("sync input exceeds budget");}
  const q=JSON.parse(text),cfg=JSON.parse(privateFile(configFile).toString()),c=(cfg.syncSpaces??[]).find((x:any)=>x.alias===q.alias);if(!c)throw new Error("unknown primary/sync Space");
  const reader=new SyncRegister(cfg.registerTls),journal=new PrimarySyncJournal(join(c.dir,"journal.sqlite"),c.genesis,{self:cfg.hostId,assertStandby:assertSyncStandby(reader,cfg.hostId)});
  const signer=loadFileSigner(cfg.keyFile),raw=async()=>openNodeSqliteStorage(join(c.dir,"harness.sqlite"));let result:any;
  try{
   const status=()=>({alias:c.alias,head:journal.head(),applied:journal.appliedRevision,config:journal.config,open:journal.openTransitionIds(),recoveredCommitted:journal.recoveredCommitted});
   if(q.op==="status"){
    result=status();
    if(q.materialize){const st=await raw();await materializeSyncHistory(st,journal,ctx);await st.close(ctx);const v=await Harness.open(await raw(),{models:createModels(),registry:createRegistry()},ctx);
     try{const sp=await snapshotSpace(v,c.spaceId,ctx);result.entries=sp?.entries.filter((e:any)=>e.type===q.countType).length??0;result.snapshot=createHash("sha256").update(syncCanonical(sp as any)).digest("hex");}finally{await v.close(ctx);}}
   }else if(["promote","degrade","set-standby"].includes(q.op)){
    const register=new SyncRegister(q.controlRegister),st=await raw();
    try{
     const base={storage:st,journal,register,hostId:cfg.hostId,dataIncarnation:c.incarnation,ctx};
     if(q.op==="set-standby"){const peer=c.peers.find((p:any)=>p.hostId===q.target);if(!peer)throw new Error("unpinned target");const t=socketTransport({host:peer.ip,port:c.port},{localAddress:cfg.listen.host,connectTimeoutMs:8000,maxFrameBytes:1<<20});
      try{result=await setStandby({...base,transitionId:q.tid,target:signedReplicaPeer({transport:t,signer,self:cfg.hostId,remote:peer}),targetDataIncarnation:c.incarnation});}finally{t.close();}}
     else if(q.op==="degrade"&&q.revokeStandbySpace===true){
      // A standby without a fencing adapter: only its permit for this Space is revoked (v3 5.3.1 step 2, 2026-10-17).
      if(q.fencing!==undefined)throw new Error("degrade takes either fencing or revokeStandbySpace");
      result=await degradeToSingle({...base,recoveryId:q.tid,expectedPrimaryEpoch:q.epoch,expectedReplicaConfigVersion:q.version,revokeStandbySpace:true});}
     else{const adapter=new TlsFencing(q.fencing),other=(q.op==="promote"?journal.config.primaryReplica:journal.config.standbyReplica)??"",proof=await adapter.fence(other,`${q.op} ${q.tid}`);
      result=q.op==="promote"?await promote({...base,recoveryId:q.tid,expectedPrimaryEpoch:q.epoch,expectedReplicaConfigVersion:q.version,adapter,proof}):await degradeToSingle({...base,recoveryId:q.tid,expectedPrimaryEpoch:q.epoch,expectedReplicaConfigVersion:q.version,adapter,proof});result={...result,proof:{kind:proof.kind,evidence:proof.evidence}};}
    }finally{await st.close(ctx);register.close();}
   }else if(q.op==="wipe"){
    const b=await reader.get<any>("boot:"+cfg.hostId);if(b?.value.state==="active")throw new Error("an active host keeps its history; wipe only a fenced or quarantined replica");
    journal.close();const aside=c.dir+".aside-"+Date.now();(await import("node:fs")).renameSync(c.dir,aside);result={aside};
   }else throw new Error("unknown sync op");
  }finally{try{journal.close();}catch{}reader.close();}
  console.log(JSON.stringify(result));
 }else throw new Error("use provision, bootstrap, enroll, recovery, run, sync or sync-head");
}finally{await cleanup();}
// Every handle should be closed by now; an overlooked one must not keep a stopped daemon alive without its lock.
// 75: the control host changed; the unit restarts the daemon (Restart=on-failure), which then uses the new endpoint.
process.exit(restartExit?75:0);
