import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConfiguredRoot,SpaceKeyDirectory,PiSpaces,revokePeerKey,installBootGuard,MemoryKeyDirectory,provisionFileSigner,createSpace,spaceDoc,snapshotSpace,GateIdentity,GrantAuthority,RouterLeaseAuthority,SqliteRecoveryRegister,BootBlocked} from './src/index.ts';
import {BACKENDS,PersistentHome,ctx} from './test/support/persistent.ts';
for(const backend of BACKENDS)for(const batchAuthority of [false,true])test(`${backend}/${batchAuthority?'batched':'legacy'}: configured native Root retains lease and blocks invalid boot, key and lost lease`,async()=>{
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'configured-root-')),external=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));let root:Awaited<ReturnType<typeof createConfiguredRoot>>|undefined;
 try{
  const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'control',Date.now()),ctx)).spaceId,control=provisionFileSigner(join(dir,'control-key')),router=provisionFileSigner(join(dir,'router-key')),agentHost=provisionFileSigner(join(dir,'host-key')),keys=new MemoryKeyDirectory();
  const rec={peerId:'root-peer',keyId:router.keyId,algorithm:router.algorithm,publicKey:router.publicKey!,principal:'root',roles:['host','router','admin'],scope:['*'],state:'active' as const};keys.add(rec);keys.add({...rec,keyId:agentHost.keyId,algorithm:agentHost.algorithm,publicKey:agentHost.publicKey!,roles:['host']});
  const s=(await snapshotSpace(host,sid,ctx))!,permit={state:'active',authorityId:'authority',dataIncarnation:s.incarnation!,role:'local',primaryEpoch:1,transitionId:'provisioned'};
  await installed.compareAndSet('installed:root-host:'+sid,null,permit);await external.compareAndSet('boot:root-host',null,{hostId:'root-host',state:'active',spaces:{[sid]:permit}});await external.compareAndSet('authority:'+sid,null,{state:'active',authorityId:'authority'});
  let management=true;const directory={refresh:async()=>{if(!management)throw Error('management unavailable');},lookup:async(ip:string)=>{if(!management)throw Error('management unavailable');return ip==='127.0.0.1'?{id:'root-peer',name:'root',ip,connected:true,groups:['hosts']}:null;}};
  const identity=new GateIdentity(),grants=new GrantAuthority({authorityId:'authority',hostId:'root-host',signer:control,keys,identity,refreshIdentity:async c=>identity.authenticate(c)}),leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:sid,authorityId:'authority',peerId:'root-peer',signer:control,keys,assertAuthority:async()=>{}});
  const opts={host,ctx,hostId:'root-host',peerId:'root-peer',ownAddress:'127.0.0.1',authorityId:'authority',controlSpaceId:sid,controlSigner:control,keys,directory,groupRoles:{hosts:['host','router','admin']},external,installed,grants,leases,assertControl:async()=>{},...(batchAuthority?{checkControlAuthority:(record:any)=>{if(record?.value.state!=='active'||record.value.authorityId!=='authority')throw new BootBlocked('control authority changed');}}:{}),root:{id:'root',keyFile:join(dir,'router-key'),hostKeyFile:join(dir,'host-key'),leaseFile:join(dir,'root-lease'),journalPartitions:8,members:{}}};
  root=await createConfiguredRoot(opts);const first=JSON.parse((await import('node:fs')).readFileSync(opts.root.leaseFile,'utf8'));assert.equal(first.lease.routerEpoch,1);keys.add({...rec,state:'revoked'});await assert.rejects(root.space.initializeJournals(),/enrolled router key/);keys.add(rec);management=false;await assert.rejects(root.space.initializeJournals(),/management unavailable/);management=true;if(batchAuthority){const a=(await external.get<any>('authority:'+sid))!;await external.compareAndSet('authority:'+sid,a.version,{...a.value,state:'fenced'});await assert.rejects(root.space.initializeJournals(),/control authority changed/);const f=(await external.get<any>('authority:'+sid))!;await external.compareAndSet('authority:'+sid,f.version,a.value);}await root.space.initializeJournals();await root.close();root=undefined;
  root=await createConfiguredRoot(opts);const second=JSON.parse((await import('node:fs')).readFileSync(opts.root.leaseFile,'utf8'));assert.equal(second.lease.id,first.lease.id);assert.equal(second.lease.routerEpoch,first.lease.routerEpoch);
  const version=(await external.get('boot:root-host'))!.version;await external.compareAndSet('boot:root-host',version,{hostId:'root-host',state:'fenced',spaces:{[sid]:permit}});
  await assert.rejects(root.space.initializeJournals(),BootBlocked);await root.close();root=undefined;await assert.rejects(createConfiguredRoot(opts),BootBlocked);
  const fenced=(await external.get('boot:root-host'))!.version;await external.compareAndSet('boot:root-host',fenced,{hostId:'root-host',state:'active',spaces:{[sid]:permit}});
  management=false;await assert.rejects(createConfiguredRoot(opts),/management unavailable/);management=true;
  keys.add({...rec,state:'revoked'});await assert.rejects(createConfiguredRoot(opts),/enrolled router key/);keys.add(rec);
  unlinkSync(opts.root.leaseFile);await assert.rejects(createConfiguredRoot(opts),/lost its lease/);
 }finally{await root?.close();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});

for(const backend of BACKENDS)test(`${backend}: pinned Control keys observe revocation and normal snapshot fencing`,async()=>{
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'bound-control-keys-'));
 const external=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));let stop:(()=>void)|undefined;
 try{
  const host=await home.open(),info=await host.commit(tx=>createSpace(tx,'control',1000),ctx),key=provisionFileSigner(join(dir,'key'));
  await new PiSpaces(host,ctx,()=>1000,undefined,undefined,{space:info.spaceId}).write({type:'PeerKey',fields:{peerId:'peer',keyId:key.keyId,principal:'peer',algorithm:key.algorithm,publicKey:key.publicKey!,roles:['router'],scope:['*'],state:'active'}});
  const permit={state:'active',authorityId:'authority',dataIncarnation:info.incarnation,role:'local',transitionId:'fixture'};
  await external.compareAndSet('boot:host',null,{hostId:'host',state:'active',spaces:{[info.spaceId]:permit}});await installed.compareAndSet('installed:host:'+info.spaceId,null,permit);
  stop=installBootGuard(host,ctx,{hostId:'host',authorityId:'authority',external,installed});
  const keys=new SpaceKeyDirectory(host,ctx,()=>1000,info.spaceId);assert.equal((await keys.find('peer',key.keyId))?.state,'active');const inspected=await keys.inspect([{peerId:'peer',keyId:key.keyId}]);assert.equal(inspected.state?.spaceId,info.spaceId);assert.equal(inspected.keys[0]?.state,'active');assert.equal((await keys.findMany([{peerId:'peer',keyId:key.keyId},{peerId:'missing',keyId:key.keyId}]))[0]?.state,'active');assert.equal((await keys.findMany([{peerId:'missing',keyId:key.keyId}]))[0],null);
  await revokePeerKey(host,ctx,'peer',key.keyId,()=>1000);assert.equal((await keys.find('peer',key.keyId))?.state,'revoked');assert.equal((await keys.findMany([{peerId:'peer',keyId:key.keyId}]))[0]?.state,'revoked');
  const boot=(await external.get<any>('boot:host'))!;await external.compareAndSet('boot:host',boot.version,{...boot.value,state:'fenced'});
  await assert.rejects(keys.find('peer',key.keyId),BootBlocked);await assert.rejects(keys.findMany([{peerId:'peer',keyId:key.keyId}]),BootBlocked);await assert.rejects(keys.inspect([{peerId:'peer',keyId:key.keyId}]),BootBlocked);await assert.rejects(keys.findMany([]),TypeError);
 }finally{stop?.();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});
