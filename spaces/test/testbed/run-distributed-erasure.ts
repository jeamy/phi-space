// Exclusive operator CLI for the owned multi-host AP2 fixture. No server-side TypeScript.
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {privateFile,TlsRecoveryRegister,ErasureArchiveController,DistributedPrincipalErasure,canonicalJson,type DistributedErasurePlan,type ErasureParticipant,type RecoveryRegister} from '../../src/index.ts';
const [file,checkpoint]=process.argv.slice(2);if(!file||checkpoint&&checkpoint!=='--checkpoint-root')throw Error('private operator config required');
const encoded=privateFile(file).toString(),cfg=JSON.parse(encoded),plan=cfg.plan as DistributedErasurePlan;
const state=()=>JSON.parse(readFileSync(cfg.stateFile,'utf8'));
const manifest=state();if(!manifest.tag.startsWith('ap2-remaining-')||plan.participants.some(t=>t.authorityId!==manifest.authorityId))throw Error('explicit owned erasure scope required');
const members=Object.keys(cfg.participants);if(members.length!==plan.participants.length||members.some(m=>!plan.participants.some(t=>canonicalJson(t as any)===canonicalJson(cfg.participants[m]))))throw Error('erasure participant map changed');
const member=(t:ErasureParticipant)=>{const id=members.find(m=>cfg.participants[m].spaceId===t.spaceId);if(!id)throw Error('unknown pinned erasure target');return id;};
const rpc=(q:unknown)=>JSON.parse(execFileSync('python3',[resolve(dirname(fileURLToPath(import.meta.url)),'netbird/erasure-driver.py'),'--state',cfg.stateFile],{input:JSON.stringify(q),encoding:'utf8',maxBuffer:1024*1024,timeout:300000}));
const authorize=async()=>{if(privateFile(file).toString()!==encoded||state().authorityId!==manifest.authorityId)throw Error('owned erasure authorization changed');};
const tls=new TlsRecoveryRegister(cfg.register),allowed=new Set<string>(cfg.allowedKeys);
const register:RecoveryRegister={get:k=>tls.get(k),compareAndSet:async(k,v,x)=>{await authorize();if(!allowed.has(k))throw Error('register write outside pinned erasure scope');return tls.compareAndSet(k,v,x);}};
const binding=async(t:ErasureParticipant)=>{const record=await register.get<any>('boot:'+t.hostId),permit=record?.value.spaces?.[t.spaceId];if(!record||record.value.hostId!==t.hostId||permit?.authorityId!==t.authorityId||permit.dataIncarnation!==t.dataIncarnation||(permit.primaryEpoch??1)!==t.primaryEpoch)throw Error('erasure target boot binding changed');return record;};
const root=plan.participants.find(t=>t.root)!;
const authority=async()=>{const r=await register.get<any>('authority:'+root.spaceId);if(r?.value.authorityId!==root.authorityId||r.value.hostId!==root.hostId||r.value.supervisorKey!==manifest.provisions.root.publicKey)throw Error('erasure authority changed');return r;};
const assertFenced=async()=>{await authorize();if((await authority()).value.state!=='fenced')throw Error('Root authority must remain fenced');for(const t of plan.participants)if((await binding(t)).value.state!=='fenced')throw Error('all owned writers must remain independently fenced');rpc({action:'assertStopped'});};
const archives=new ErasureArchiveController({register,authorize,destroy:async artifact=>{const id=members.find(m=>artifact.id===plan.id+'-'+m);if(!id)throw Error('archive is outside owned command');rpc({action:'destroy',member:id,id:plan.id,sha256:artifact.sha256});},verifyDeletion:async(spaceId,epoch)=>{const t=plan.participants.find(t=>t.spaceId===spaceId);if(!t)throw Error('unknown completed erasure target');await assertFenced();const result=rpc({action:'audit',member:member(t)}),s=result.spaces.find((s:any)=>s.spaceId===spaceId);if(s?.erasureEpoch!==epoch||s.privacyEntries!==0||s.activeTransactions!==0||t.root&&!result.erasures.some((r:any)=>r.id===plan.id&&r.phase==='completed'))throw Error('deletion receipt or actual Member/Root state is incomplete');rpc({action:'verifyBytes',member:member(t),id:plan.id});}});
const data=()=>({id:plan.id,principal:plan.principal});
const coordinator=new DistributedPrincipalErasure({register,archives,authorize,driver:{
 fence:async()=>{
  const a=await authority();if(!['active','fenced'].includes(a.value.state))throw Error('unexpected Root authority state');if(a.value.state!=='fenced')await register.compareAndSet('authority:'+root.spaceId,a.version,{...a.value,state:'fenced'});
  for(const t of plan.participants){const b=await binding(t);if(!['active','fenced'].includes(b.value.state))throw Error('unexpected owned host state');if(b.value.state!=='fenced')await register.compareAndSet('boot:'+t.hostId,b.version,{...b.value,state:'fenced'});}
  rpc({action:'stop'});await assertFenced();
  for(const t of plan.participants){const artifact=rpc({action:'backup',member:member(t),id:plan.id}),floor=await register.get<any>('erasure:'+t.spaceId);await archives.registerArchive(t.spaceId,{...artifact,epoch:floor?.value.epoch??0});}
 },assertFenced,
 evidence:async t=>rpc({action:'offline',member:member(t),mode:'erase-evidence',data:data()}).entryIds,
 eraseLocal:async t=>{rpc({action:'offline',member:member(t),mode:'erase-local',data:data()});},
 eraseRoot:async(t,_,entryIds)=>{rpc({action:'offline',member:member(t),mode:'erase-root',data:{...data(),entryIds}});},
 stamp:async(t,_,epoch,commandHash)=>{const receipt=rpc({action:'offline',member:member(t),mode:'erase-stamp',data:{...data(),epoch,commandHash}});if(receipt.spaceId!==t.spaceId||receipt.epoch!==epoch||!receipt.completed)throw Error('incorrect local deletion stamp');rpc({action:'compact',member:member(t)});},
 release:async(_,epochs)=>{
  await authorize();const a=await authority();
  for(const t of plan.participants){const floor=await register.get<any>('erasure:'+t.spaceId);if(floor?.value.state!=='sealed'||floor.value.epoch!==epochs[t.spaceId]||floor.value.commandHash!==createHash('sha256').update(canonicalJson([plan.id,plan.principal] as any)).digest('hex')||floor.value.archivesPending)throw Error('all floors and archives must be complete before release');}
  // Durable installed permits were stamped offline before any independent boot is released.
  for(const t of plan.participants){const b=await binding(t);if(!['active','fenced'].includes(b.value.state))throw Error('owned boot state changed before release');const value={...b.value,state:'active',spaces:{...b.value.spaces,[t.spaceId]:{...b.value.spaces[t.spaceId],erasureEpoch:epochs[t.spaceId]}}};if(canonicalJson(value)!==canonicalJson(b.value))await register.compareAndSet('boot:'+t.hostId,b.version,value);}
  if(a.value.state==='fenced')await register.compareAndSet('authority:'+root.spaceId,a.version,{...a.value,state:'active'});else if(a.value.state!=='active')throw Error('unexpected release authority state');
  // Writers stay stopped until the durable coordinator receipt exists; a separate explicit start verifies it.
 }
}});
try{for(;;){const progress=await coordinator.advance(plan);console.log(JSON.stringify({id:plan.id,phase:progress.phase,cursor:progress.cursor,epochs:progress.epochs}));if(progress.phase==='completed'){const blocked:string[]=[];for(const m of members){let denied=false;try{await archives.assertRestore(cfg.participants[m].spaceId,plan.id+'-'+m);}catch(error){if(!(error instanceof Error)||error.message!=='archive restore is blocked by deletion policy')throw error;denied=true;}if(!denied)throw Error('obsolete archive restore unexpectedly allowed');blocked.push(m);}console.log(JSON.stringify({id:plan.id,oldArchiveRestoreBlocked:blocked}));break;}if(checkpoint&&progress.phase==='root')break;}}finally{tls.close();}
