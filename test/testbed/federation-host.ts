// Operator-provisioned, persistent testbed daemon. Uses real NetBird management and independent boot records.
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, lstatSync, readdirSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { provisionFileSigner, loadFileSigner, privateFile, PiSpaces, bootstrapEnroll, hashToken, SqliteRecoveryRegister, listSpaces, spaceDoc, createSpace, startConfiguredFederation, startRecoveryOnly, startMemberRecoveryOnly, RemoteSpace, socketTransport, core, type FederationConfig } from "../../src/index.ts";
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
   config={hostId:input.hostId,peerId:input.peerId,authorityId:input.authorityId,controlHostId:input.controlHostId,controlSpaceId:input.mode==="control"?spaces.find(s=>s.alias==="control")!.spaceId:input.controlSpaceId,mode:input.mode,listen:{host:input.ip,port:7421},keyFile:join(home,"signer.json"),installedRegisterFile:join(home,"installed.sqlite"),registerTls:{host:"207.180.233.218",port:17422,caFile:join(home,"pki/ca.crt"),certFile:join(home,"pki/reader.crt"),keyFile:join(home,"pki/reader.key")},management:{url:"https://spacebird.eibrain.org",tokenFile:join(home,"management-token")},control:{address:{host:input.controlIp,port:7421},algorithm:input.mode==="control"?signer.algorithm:input.controlAlgorithm,publicKey:input.mode==="control"?signer.publicKey:input.controlPublicKey}};
   writeFileSync(configFile,JSON.stringify(config)+'\n',{mode:0o600});
   for(const info of spaces)await installed.compareAndSet(`installed:${config.hostId}:${info.spaceId}`,null,{state:"active",authorityId:config.authorityId,dataIncarnation:info.incarnation,role:"local",transitionId:"bootstrap-20261011"});
   await installed.compareAndSet(`installed-authority:${config.controlSpaceId}`,null,{authorityId:config.authorityId});
   if(config.mode==="member")await new PiSpaces(h,ctx,Date.now,undefined,undefined,{space:"jobs"}).write({type:"AcceptanceObject",fields:{origin:config.hostId,n:1}},null,core.FOREVER);
  }
  const signer=loadFileSigner(config.keyFile),spaces:Record<string,any>={};for(const info of await listSpaces(h,ctx))spaces[info.spaceId]=(await installed.get<any>(`installed:${config.hostId}:${info.spaceId}`))!.value;
  console.log(JSON.stringify({hostId:config.hostId,peerId:config.peerId,controlSpaceId:config.controlSpaceId,publicKey:signer.publicKey,keyId:signer.keyId,algorithm:signer.algorithm,boot:{hostId:config.hostId,state:"active",spaces}}));
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
  runtime=await startConfiguredFederation(h,ctx,configFile);console.log(JSON.stringify({ready:true,hostId:runtime.config.hostId,address:runtime.address()}));
  await new Promise<void>(resolve=>{process.once("SIGTERM",resolve);process.once("SIGINT",resolve);});
 }else throw new Error("use provision, bootstrap, enroll, recovery or run");
}finally{await cleanup();}
