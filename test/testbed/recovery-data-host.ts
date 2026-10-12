// Administrative testbed process: private backup or exclusive data recovery, with no normal gate or agents.
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { privateFile, loadFileSigner, TlsRecoveryRegister, SqliteRecoveryRegister, listSpaces, snapshotSpace, startConfiguredRecovery, PiSpaces, type FederationConfig, type PrivateRecoveryConfig } from '../../src/index.ts';
const [mode,home,alias="jobs"]=process.argv.slice(2);if(!home||!['backup','run','inspect'].includes(mode))throw new Error('use backup|run|inspect PRIVATE_HOME');
if(mode==='backup'){
 if(!['jobs','control'].includes(alias))throw new Error('backup alias must be jobs or control');
 const folder=join(home,'acceptance-backup');mkdirSync(folder,{recursive:true,mode:0o700});
 const database=new DatabaseSync(join(home,'harness.sqlite'),{readOnly:true});try{await backup(database,join(folder,'harness.sqlite'));chmodSync(join(folder,'harness.sqlite'),0o600);}finally{database.close();}
 const copy=mkdtempSync(join(folder,'snapshot-'));const {copyFileSync}=await import('node:fs');copyFileSync(join(folder,'harness.sqlite'),join(copy,'harness.sqlite'));
 const h=await Harness.open(await openNodeSqliteStorage(join(copy,'harness.sqlite')),{models:createModels(),registry:createRegistry()},ctx);
 try{const info=(await listSpaces(h,ctx)).find(s=>s.alias===alias);if(!info)throw new Error('requested space missing');const state=await snapshotSpace(h,info.spaceId,ctx);writeFileSync(join(folder,alias+'.json'),JSON.stringify(state)+'\n',{mode:0o600});console.log(JSON.stringify({spaceId:info.spaceId,incarnation:info.incarnation,primaryEpoch:state?.primaryEpoch??1,entries:state?.entries.length}));}finally{await h.close(ctx);rmSync(copy,{recursive:true,force:true});}
}else{
 const config=JSON.parse(privateFile(join(home,'federation.json')).toString()) as FederationConfig;
 const recovery=JSON.parse(privateFile(join(home,'recovery.json')).toString()) as PrivateRecoveryConfig;
 const stopped=()=>!readdirSync('/proc').filter(v=>/^[0-9]+$/.test(v)).some(v=>{try{const args=readFileSync(`/proc/${v}/cmdline`,'utf8').split('\0');return args[1]===join(home,'federation-host.mjs')&&args[2]==='run';}catch{return false;}});
 if(!existsSync(join(home,'restart.lock'))||!stopped())throw new Error('stopped and restart-locked target required');
 const lock=join(home,'owner.lock'),fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,mode:'data-recovery'})+'\n');closeSync(fd);
 const installed=new SqliteRecoveryRegister(config.installedRegisterFile),external=new TlsRecoveryRegister(config.registerTls!);
 let h:Harness|undefined,service:Awaited<ReturnType<typeof startConfiguredRecovery>>|undefined;
 try{
  h=await Harness.open(await openNodeSqliteStorage(join(home,'harness.sqlite')),{models:createModels(),registry:createRegistry()},ctx);
  if(!stopped())throw new Error('normal target restarted while opening recovery storage');
  if(mode==='inspect'){
   const info=(await listSpaces(h,ctx)).find(s=>s.alias==='jobs');if(!info)throw new Error('jobs space missing');const state=await snapshotSpace(h,info.spaceId,ctx);
   const local=new PiSpaces(h,ctx,Date.now,undefined,undefined,{space:'jobs'}),objects=await local.readAll({type:'AcceptanceObject'}),taken=await local.take({type:'AcceptanceObject'},0);
   if(objects.length!==1||taken!==null||!state?.entries.every(e=>e.restoredUnverified))throw new Error('restored data quarantine is not intact');
   console.log(JSON.stringify({restoredObjectsReadable:true,quarantineBlocksTake:true,objects:objects.length,space:info.spaceId,incarnation:state.incarnation}));
  }else{
  service=await startConfiguredRecovery(h,{commit:h.commit.bind(h),snapshot:h.snapshot.bind(h)},ctx,{...config,signer:loadFileSigner(config.keyFile),controlKey:{algorithm:config.control.algorithm,publicKey:config.control.publicKey},config:recovery,external,installed});
  console.log(JSON.stringify({dataRecoveryReady:true,hostId:config.hostId}));await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
  }
 }finally{await service?.close();await h?.close(ctx);installed.close();external.close();unlinkSync(lock);}
}
