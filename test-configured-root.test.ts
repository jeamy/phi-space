import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FederationRouting,ReplicaNoticeBoard,signReplicaConfigNotice,serveSpace,createConfiguredRoot,SpaceKeyDirectory,PiSpaces,revokePeerKey,installBootGuard,MemoryKeyDirectory,provisionFileSigner,createSpace,spaceDoc,snapshotSpace,GateIdentity,GrantAuthority,RouterLeaseAuthority,SqliteRecoveryRegister,BootBlocked} from './src/index.ts';
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

for(const backend of BACKENDS)test(`${backend}: native Root adopts a published ReplicaConfigNotice and routes the replicated Member to its new primary`,async()=>{
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'root-replica-')),external=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));
 let root:Awaited<ReturnType<typeof createConfiguredRoot>>|undefined;const servers:Awaited<ReturnType<typeof serveSpace>>[]=[],hits={p:0,s:0};
 try{
  const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'control',Date.now()),ctx)).spaceId,control=provisionFileSigner(join(dir,'control-key')),router=provisionFileSigner(join(dir,'router-key')),agentHost=provisionFileSigner(join(dir,'host-key')),pKey=provisionFileSigner(join(dir,'p-key')),sKey=provisionFileSigner(join(dir,'s-key')),keys=new MemoryKeyDirectory();
  const rec={peerId:'root-peer',keyId:router.keyId,algorithm:router.algorithm,publicKey:router.publicKey!,principal:'root',roles:['host','router','admin'],scope:['*'],state:'active' as const};keys.add(rec);keys.add({...rec,keyId:agentHost.keyId,algorithm:agentHost.algorithm,publicKey:agentHost.publicKey!,roles:['host']});
  const s=(await snapshotSpace(host,sid,ctx))!,permit={state:'active',authorityId:'authority',dataIncarnation:s.incarnation!,role:'local',primaryEpoch:1,transitionId:'provisioned'};
  await installed.compareAndSet('installed:root-host:'+sid,null,permit);await external.compareAndSet('boot:root-host',null,{hostId:'root-host',state:'active',spaces:{[sid]:permit}});
  const peers:Record<string,string>={'127.0.0.1':'root-peer','127.0.0.2':'p-peer','127.0.0.3':'s-peer'};
  const directory={refresh:async()=>{},lookup:async(ip:string)=>peers[ip]?{id:peers[ip]!,name:peers[ip]!,ip,connected:true,groups:['hosts']}:null};
  for(const [ip,name] of [['127.0.0.2','p'],['127.0.0.3','s']] as const)servers.push(await serveSpace({handleText:async()=>{hits[name]++;return JSON.stringify({id:0,ok:false,error:{code:'Unavailable',message:'counting fixture'}});}},{listen:{host:ip,port:0}}));
  const port=(i:number)=>(servers[i]!.address() as {port:number}).port,endpoint=(k:typeof pKey,peerId:string,ip:string,i:number)=>({peerId,keyId:k.keyId,algorithm:k.algorithm,publicKey:k.publicKey!,address:{host:ip,port:port(i)}});
  const target={hostId:'p',spaceId:'sync-space',authorityId:'authority',dataIncarnation:'inc-p',primaryEpoch:1};
  const identity=new GateIdentity(),grants=new GrantAuthority({authorityId:'authority',hostId:'root-host',signer:control,keys,identity,refreshIdentity:async c=>identity.authenticate(c)}),leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:sid,authorityId:'authority',peerId:'root-peer',signer:control,keys,assertAuthority:async()=>{}});
  const opts={host,ctx,hostId:'root-host',peerId:'root-peer',ownAddress:'127.0.0.1',authorityId:'authority',controlSpaceId:sid,controlSigner:control,keys,directory,groupRoles:{hosts:['host','router','admin']},external,installed,grants,leases,assertControl:async()=>{},
   root:{id:'root',keyFile:join(dir,'router-key'),hostKeyFile:join(dir,'host-key'),leaseFile:join(dir,'root-lease'),journalPartitions:8,statusIntervalMs:15000,members:{replicated:{target,...endpoint(pKey,'p-peer','127.0.0.2',0),replicas:{s:endpoint(sKey,'s-peer','127.0.0.3',1)}}}}};
  await host.commit(async tx=>{const d=await tx.doc(FederationRouting,sid,null);d.policy={authorityId:'authority',policyVersion:1,rules:[],completionProfiles:[],default:{mode:'local',member:'replicated'}};
   d.members={replicated:{id:'replicated',state:'active',target,replication:{primaryReplica:'p',standbyReplica:'s',replicaConfigVersion:1,durability:'sync'}}};},ctx);
  root=await createConfiguredRoot(opts);
  await root.directory!.refresh().catch(()=>{});assert.ok(hits.p>0&&hits.s===0,'before adoption the status probe goes to the provisioned primary');
  // s was promoted: the register admits it, it publishes its notice on the board in the control Space.
  await external.compareAndSet('boot:s',null,{hostId:'s',state:'active',spaces:{'sync-space':{state:'active',authorityId:'authority',dataIncarnation:'inc-s',role:'primary',primaryEpoch:2,replicaConfigVersion:2,durability:'sync',transitionId:'promote-s'}}});
  const notice={authorityId:'authority',spaceId:'sync-space',recoveryId:'promote-s',primaryReplica:'s',standbyReplica:'p',primaryEpoch:2,replicaConfigVersion:2,durability:'sync' as const,dataIncarnation:'inc-s'};
  const board=new ReplicaNoticeBoard({host,ctx,controlSpaceId:sid,assertAuthority:async()=>{}}),signed=await signReplicaConfigNotice(notice,sKey);
  await assert.rejects(board.publish(signed,{peerId:'p',roles:['host']}),/only the proven primary host/);
  // Real hosts prove a NetBird peer ID, not their host ID: the notice must be signed with exactly the proven key.
  await assert.rejects(board.publish(signed,{peerId:'s-peer',roles:['host'],key:{algorithm:pKey.algorithm,publicKey:pKey.publicKey!}}),/only the proven primary host/);
  assert.deepEqual(await board.publish(signed,{peerId:'s-peer',roles:['host'],key:{algorithm:sKey.algorithm,publicKey:sKey.publicKey!}}),{stored:true});
  assert.deepEqual(await board.publish(signed,{peerId:'s',roles:['host']}),{stored:false});
  const adopted=await root.adoptReplicaNotices();assert.deepEqual(adopted,{adopted:1,refused:[]});
  assert.equal((await host.snapshot(FederationRouting,sid,ctx))!.members.replicated!.target.hostId,'s');
  hits.p=0;hits.s=0;await root.directory!.refresh().catch(()=>{});assert.ok(hits.s>0&&hits.p===0,'after adoption the probe goes to the new primary');
  // A restarted Root accepts the persisted target on the provisioned replica host; adopting again is a no-op.
  await root.close();root=await createConfiguredRoot(opts);assert.deepEqual(await root.adoptReplicaNotices(),{adopted:0,refused:[]});
 }finally{await root?.close();for(const sv of servers)await sv.close();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});
