// Operator-controlled phase 3 fixture: one primary/sync replica per host with its own journal and storage, the signed
// replica transport over the overlay, boot permits in the recovery register and a fencing adapter. Driven line by
// line over stdin ({op,...} -> one JSON answer per line). No normal service data; the federation daemon is untouched.
import {createInterface} from 'node:readline';
import {existsSync,mkdirSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as ctx} from '../../../src/context.ts';
import {PrimarySyncJournal,CommitSealed,primarySyncStorage,recoverPrimarySync,materializeSyncHistory,PhiSpaces,Space,core,SqliteRecoveryRegister,TlsRecoveryRegister,SimulatorFencing,TlsFencing,assertSyncPrimary,assertSyncStandby,assertQuarantine,degradeToSingle,promote,setStandby,serveSpace,socketTransport,loadFileSigner,signedReplicaPeer,replicaSyncHandler,canonicalJson,type PrimarySyncConfig,type FencingAdapter,type FenceProof,type ReplicaPin,type RecoveryRegister} from '../../../src/index.ts';

type Remote=ReplicaPin&{ip:string};
type Config={self:string;bindIp:string;port:number;signerFile:string;remotes:Remote[];genesis:PrimarySyncConfig;dataIncarnation:string;
 register:{sqlite:string}|{tls:ConstructorParameters<typeof TlsRecoveryRegister>[0]};fencing:{simulator:true}|{tls:ConstructorParameters<typeof TlsFencing>[0]}|null};
const [home,configFile]=process.argv.slice(2);if(!home||!configFile)throw Error('usage: phase3-sync-node <home> <config.json>');
const cfg:Config=JSON.parse((await import('node:fs')).readFileSync(configFile,'utf8'));
mkdirSync(home,{recursive:true,mode:0o700});
const signer=loadFileSigner(cfg.signerFile),register:RecoveryRegister='sqlite' in cfg.register?new SqliteRecoveryRegister(cfg.register.sqlite):new TlsRecoveryRegister(cfg.register.tls);
const adapter:FencingAdapter|null=!cfg.fencing?null:'simulator' in cfg.fencing?new SimulatorFencing():new TlsFencing(cfg.fencing.tls);
const sync=()=>join(home,'sync');
const openJournal=()=>{mkdirSync(sync(),{recursive:true,mode:0o700});return new PrimarySyncJournal(join(sync(),'journal.sqlite'),cfg.genesis,{self:cfg.self,assertStandby:assertSyncStandby(register,cfg.self)});};
const rawStorage=()=>openNodeSqliteStorage(join(sync(),'harness.sqlite'));
let journal=openJournal(),host:Harness|undefined,server:Awaited<ReturnType<typeof serveSpace>>|undefined,proof:FenceProof|null=null;
const transports:ReturnType<typeof socketTransport>[]=[];
const peerFor=(hostId:string|null)=>{if(!hostId)return null;const r=cfg.remotes.find(x=>x.hostId===hostId);if(!r)throw Error('unpinned replica '+hostId);const t=socketTransport({host:r.ip,port:cfg.port},{localAddress:cfg.bindIp==='127.0.0.1'?undefined:cfg.bindIp,connectTimeoutMs:8000,maxFrameBytes:1<<20});transports.push(t);return signedReplicaPeer({transport:t,signer,self:cfg.self,remote:r});};
const closeHost=async()=>{if(host){await host.close(ctx);host=undefined;}for(const t of transports.splice(0))t.close();};
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v as any)).digest('hex');
const common=(storage:Awaited<ReturnType<typeof rawStorage>>)=>({storage,journal,register,hostId:cfg.self,dataIncarnation:cfg.dataIncarnation,ctx,allowSimulator:adapter?.kind==='simulator'});
const withRaw=async<T>(run:(s:Awaited<ReturnType<typeof rawStorage>>)=>Promise<T>)=>{await closeHost();const s=await rawStorage();try{return await run(s);}finally{await s.close(ctx);}};
const status=()=>({self:cfg.self,head:journal.head(),applied:journal.appliedRevision,config:journal.config,recoveredCommitted:journal.recoveredCommitted});

async function handle(q:any):Promise<unknown>{
 switch(q.op){
  case 'listen':{if(server)return {listening:true};const ips=new Set(cfg.remotes.map(r=>r.ip));
   const handler=replicaSyncHandler({journal:()=>journal,signer,self:cfg.self,remotes:cfg.remotes,assertQuarantine:assertQuarantine(register,cfg.self)});
   server=await serveSpace({handleText:handler},{listen:{host:cfg.bindIp,port:cfg.port},connection:s=>ips.has(String(s.remoteAddress).replace(/^::ffff:/,''))?{}:null,maxConnections:4,maxFrameBytes:1<<20});return {listening:true};}
  case 'unlisten':{await server?.close();server=undefined;return {listening:false,at:Date.now()};}
  case 'open-primary':{await closeHost();const peer=journal.config.durability==='single'?null:peerFor(journal.config.standbyReplica),assert=assertSyncPrimary(register,cfg.self,journal),s=await rawStorage();
   await recoverPrimarySync(s,journal,peer,ctx,assert);host=await Harness.open(primarySyncStorage(s,journal,peer,{assertPrimary:assert}),{models:createModels(),registry:createRegistry()},ctx);return status();}
  case 'write':{if(!host)throw Error('open-primary first');const out:unknown[]=[];
   for(let n=0;n<(q.count??1);n++){try{const e=await new PhiSpaces(host,ctx).write({type:'SyncProbe',fields:{writer:cfg.self,label:q.label,n}},null,core.FOREVER);out.push({n,ok:true,id:(e as any).id??null});}
    catch(e){out.push({n,ok:false,sealed:e instanceof CommitSealed?{revision:e.revision,hash:e.hash}:null,error:(e as Error).message.slice(0,200)});if(q.stopOnError!==false)break;}}
   return {writes:out,...status()};}
  case 'close':{await closeHost();return status();}
  case 'status':return status();
  case 'state':{const h=host;if(h)return {...status(),entries:await new PhiSpaces(h,ctx).count({type:'SyncProbe'}),snapshot:digest(await h.snapshot(Space,ctx))};
   await closeHost();const s=await rawStorage();await materializeSyncHistory(s,journal,ctx);await s.close(ctx);
   const v=await Harness.open(await rawStorage(),{models:createModels(),registry:createRegistry()},ctx);try{return {...status(),entries:await new PhiSpaces(v,ctx).count({type:'SyncProbe'}),snapshot:digest(await v.snapshot(Space,ctx))};}finally{await v.close(ctx);}}
  case 'fence':{if(!adapter)throw Error('no fencing adapter on this host');proof=await adapter.fence(q.target,q.reason);writeFileSync(join(home,'proof.json'),JSON.stringify(proof),{mode:0o600});return proof;}
  case 'verify':return proof&&adapter?await adapter.verify(proof):null;
  case 'promote':{if(!adapter||!proof)throw Error('fence first');return withRaw(s=>promote({...common(s),recoveryId:q.tid,expectedPrimaryEpoch:q.epoch,expectedReplicaConfigVersion:q.version,adapter:adapter!,proof:proof!}));}
  case 'degrade':{if(!adapter||!proof)throw Error('fence first');return withRaw(s=>degradeToSingle({...common(s),recoveryId:q.tid,expectedPrimaryEpoch:q.epoch,expectedReplicaConfigVersion:q.version,adapter:adapter!,proof:proof!}));}
  case 'set-standby':return withRaw(s=>setStandby({...common(s),transitionId:q.tid,target:peerFor(q.target)!,targetDataIncarnation:q.targetIncarnation}));
  case 'wipe':{await closeHost();await server?.close();server=undefined;journal.close();const aside=join(home,'aside-'+Date.now());if(existsSync(sync()))renameSync(sync(),aside);journal=openJournal();return {aside,...status()};}
  case 'intent':{const i=journal.intent(q.revision);return i?{revision:i.revision,hash:i.hash,version:i.version}:null;}
  default:throw Error('unknown op');
 }
}
console.log(JSON.stringify({ready:true,...status()}));
const lines=createInterface({input:process.stdin});
for await(const line of lines){if(!line.trim())continue;let q:any={};try{q=JSON.parse(line);console.log(JSON.stringify({id:q.id,ok:true,result:await handle(q)}));}catch(e){console.log(JSON.stringify({id:q.id,ok:false,error:(e as Error).message.slice(0,300)}));}}
await closeHost();await server?.close();journal.close();
