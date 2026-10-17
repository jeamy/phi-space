import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,unlinkSync,readFileSync} from 'node:fs';
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
for(const backend of BACKENDS)test(`${backend}: native Root closes promptly while a Member status probe hangs`,async()=>{
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'root-close-')),external=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));
 let root:Awaited<ReturnType<typeof createConfiguredRoot>>|undefined;const servers:Awaited<ReturnType<typeof serveSpace>>[]=[],hits={p:0,s:0};
 try{
  const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'control',Date.now()),ctx)).spaceId,control=provisionFileSigner(join(dir,'control-key')),router=provisionFileSigner(join(dir,'router-key')),agentHost=provisionFileSigner(join(dir,'host-key')),pKey=provisionFileSigner(join(dir,'p-key')),sKey=provisionFileSigner(join(dir,'s-key')),keys=new MemoryKeyDirectory();
  const rec={peerId:'root-peer',keyId:router.keyId,algorithm:router.algorithm,publicKey:router.publicKey!,principal:'root',roles:['host','router','admin'],scope:['*'],state:'active' as const};keys.add(rec);keys.add({...rec,keyId:agentHost.keyId,algorithm:agentHost.algorithm,publicKey:agentHost.publicKey!,roles:['host']});
  const s=(await snapshotSpace(host,sid,ctx))!,permit={state:'active',authorityId:'authority',dataIncarnation:s.incarnation!,role:'local',primaryEpoch:1,transitionId:'provisioned'};
  await installed.compareAndSet('installed:root-host:'+sid,null,permit);await external.compareAndSet('boot:root-host',null,{hostId:'root-host',state:'active',spaces:{[sid]:permit}});
  const peers:Record<string,string>={'127.0.0.1':'root-peer','127.0.0.2':'p-peer','127.0.0.3':'s-peer'};
  const directory={refresh:async()=>{},lookup:async(ip:string)=>peers[ip]?{id:peers[ip]!,name:peers[ip]!,ip,connected:true,groups:['hosts']}:null};
  for(const [ip,name] of [['127.0.0.2','p'],['127.0.0.3','s']] as const)servers.push(await serveSpace({handleText:()=>{hits[name]++;return new Promise<string>(()=>{});}},{listen:{host:ip,port:0}}));
  const port=(i:number)=>(servers[i]!.address() as {port:number}).port,endpoint=(k:typeof pKey,peerId:string,ip:string,i:number)=>({peerId,keyId:k.keyId,algorithm:k.algorithm,publicKey:k.publicKey!,address:{host:ip,port:port(i)}});
  const target={hostId:'p',spaceId:'sync-space',authorityId:'authority',dataIncarnation:'inc-p',primaryEpoch:1};
  const identity=new GateIdentity(),grants=new GrantAuthority({authorityId:'authority',hostId:'root-host',signer:control,keys,identity,refreshIdentity:async c=>identity.authenticate(c)}),leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:sid,authorityId:'authority',peerId:'root-peer',signer:control,keys,assertAuthority:async()=>{}});
  const opts={host,ctx,hostId:'root-host',peerId:'root-peer',ownAddress:'127.0.0.1',authorityId:'authority',controlSpaceId:sid,controlSigner:control,keys,directory,groupRoles:{hosts:['host','router','admin']},external,installed,grants,leases,assertControl:async()=>{},
   root:{id:'root',keyFile:join(dir,'router-key'),hostKeyFile:join(dir,'host-key'),leaseFile:join(dir,'root-lease'),journalPartitions:8,statusIntervalMs:15000,members:{replicated:{target,...endpoint(pKey,'p-peer','127.0.0.2',0),replicas:{s:endpoint(sKey,'s-peer','127.0.0.3',1)}}}}};
  await host.commit(async tx=>{const d=await tx.doc(FederationRouting,sid,null);d.policy={authorityId:'authority',policyVersion:1,rules:[],completionProfiles:[],default:{mode:'local',member:'replicated'}};
   d.members={replicated:{id:'replicated',state:'active',target,replication:{primaryReplica:'p',standbyReplica:'s',replicaConfigVersion:1,durability:'sync'}}};},ctx);
  root=await createConfiguredRoot(opts);
  for(let i=0;i<100&&hits.p===0;i++)await new Promise(r=>setTimeout(r,20));assert.ok(hits.p>0,'the status probe reached the silent Member');
  const started=Date.now();await root.close();root=undefined;
  assert.ok(Date.now()-started<3000,`close took ${Date.now()-started} ms while the probe hung`);
 }finally{await root?.close();for(const sv of servers)await sv.close();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});

for(const backend of BACKENDS)test(`${backend}: control transition step 6 aligns the policy before a native Root restarts on a primary/sync main store`,async()=>{
 const {PrimarySyncJournal,bootstrapPrimarySync,primarySyncStorage,applyConfigTransition,lastConfigTransition,alignControlReplicaIn,ControlReplicaMarker,listSpaces}=await import('./src/index.ts');
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'root-step6-')),external=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));
 let root:Awaited<ReturnType<typeof createConfiguredRoot>>|undefined;const servers:Awaited<ReturnType<typeof serveSpace>>[]=[];const errors:string[]=[],origError=console.error;
 console.error=(...a:unknown[])=>{errors.push(a.map(String).join(' '));};
 try{
  let h=await home.open();const sid=(await h.commit(tx=>createSpace(tx,'control',Date.now()),ctx)).spaceId;await home.close(h);
  const genesis={spaceId:sid,authorityId:'authority',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'root-host',standbyReplica:null,durability:'single' as const};
  const journal=new PrimarySyncJournal(join(dir,'main-journal.sqlite'),genesis,{self:'root-host'});
  let st=await home.storage();await bootstrapPrimarySync(st,journal,ctx);await st.close(ctx);
  const raw=home.storage.bind(home);home.storage=async()=>primarySyncStorage(await raw(),journal,null,{assertPrimary:async()=>{}});
  h=await home.open();const s=(await snapshotSpace(h,sid,ctx))!;
  const permit=(e:number,v:number)=>({state:'active',authorityId:'authority',dataIncarnation:s.incarnation!,role:'primary',primaryEpoch:e,replicaConfigVersion:v,durability:'single',transitionId:'t'+v});
  const setPermit=async(e:number,v:number)=>{for(const [reg,key] of [[external,'boot:root-host'],[installed,'installed:root-host:'+sid]] as const){const cur=await reg.get<any>(key),p=permit(e,v);await reg.compareAndSet(key,cur?.version??null,key.startsWith('boot')?{hostId:'root-host',state:'active',spaces:{[sid]:p}}:p);}};
  await setPermit(1,1);
  const control=provisionFileSigner(join(dir,'control-key')),router=provisionFileSigner(join(dir,'router-key')),agentHost=provisionFileSigner(join(dir,'host-key')),pKey=provisionFileSigner(join(dir,'p-key')),keys=new MemoryKeyDirectory();
  const rec={peerId:'root-peer',keyId:router.keyId,algorithm:router.algorithm,publicKey:router.publicKey!,principal:'root',roles:['host','router','admin'],scope:['*'],state:'active' as const};keys.add(rec);keys.add({...rec,keyId:agentHost.keyId,algorithm:agentHost.algorithm,publicKey:agentHost.publicKey!,roles:['host']});
  keys.add({...rec,peerId:'p-peer',keyId:pKey.keyId,algorithm:pKey.algorithm,publicKey:pKey.publicKey!,roles:['host']});
  const peers:Record<string,string>={'127.0.0.1':'root-peer','127.0.0.2':'p-peer'};
  const directory={refresh:async()=>{},lookup:async(ip:string)=>peers[ip]?{id:peers[ip]!,name:peers[ip]!,ip,connected:true,groups:['hosts']}:null};
  servers.push(await serveSpace({handleText:async()=>JSON.stringify({id:0,ok:false,error:{code:'Unavailable',message:'fixture'}})},{listen:{host:'127.0.0.2',port:0}}));
  const target={hostId:'p',spaceId:'member-space',authorityId:'authority',dataIncarnation:'inc-p',primaryEpoch:1};
  await h.commit(async tx=>{const d=await tx.doc(FederationRouting,sid,null);d.policy={authorityId:'authority',policyVersion:1,rules:[],completionProfiles:[],default:{mode:'local',member:'m'}};d.members={m:{id:'m',state:'active',target}};
   const c=await spaceDoc(tx,sid,Date.now());c.authorityCounters={routerEpoch:0,policyVersion:1};},ctx);
  let clock=Date.now();
  const build=async(host:typeof h)=>{
   const identity=new GateIdentity(),grants=new GrantAuthority({authorityId:'authority',hostId:'root-host',signer:control,keys,identity,refreshIdentity:async c=>identity.authenticate(c)});
   const leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:sid,authorityId:'authority',peerId:'root-peer',signer:control,keys,assertAuthority:async()=>{},controlEpoch:()=>journal.config.primaryEpoch,now:()=>clock});
   return {leases,opts:{host,ctx,hostId:'root-host',peerId:'root-peer',ownAddress:'127.0.0.1',authorityId:'authority',controlSpaceId:sid,controlSigner:control,keys,directory,groupRoles:{hosts:['host','router','admin']},external,installed,grants,leases,assertControl:async()=>{},controlEpoch:()=>journal.config.primaryEpoch,
    root:{id:'root',keyFile:join(dir,'router-key'),hostKeyFile:join(dir,'host-key'),leaseFile:join(dir,'root-lease'),journalPartitions:2,statusIntervalMs:15000,members:{m:{target,peerId:'p-peer',keyId:pKey.keyId,algorithm:pKey.algorithm,publicKey:pKey.publicKey!,address:{host:'127.0.0.2',port:(servers[0]!.address() as {port:number}).port}}}}}};
  };
  root=await createConfiguredRoot((await build(h)).opts);await root.close();root=undefined;await home.close(h);
  const first=JSON.parse(readFileSync(join(dir,'root-lease'),'utf8'));assert.equal(first.lease.controlPrimaryEpoch,1);
  // degradeToSingle-like transition on the same primary: epoch 2, version 2, as a journal configuration entry.
  st=await raw();await applyConfigTransition(st,journal,{...journal.config,primaryEpoch:2,replicaConfigVersion:2},{reason:'control-degrade',ctx,assert:async()=>{}});await st.close(ctx);await setPermit(2,2);
  // Crash before the policy step: the Root cannot renew its epoch-1 lease.
  h=await home.open();clock+=120_000;
  await assert.rejects(createConfiguredRoot((await build(h)).opts),/no longer owns current epoch/);
  // Step 6: aligned exactly once, before anything serves.
  const t=lastConfigTransition(journal)!;assert.equal(t.transitionId,'control-degrade');
  const align=()=>h.commit(tx=>alignControlReplicaIn(tx,sid,'authority',{transitionId:t.transitionId,primaryEpoch:t.config.primaryEpoch,replicaConfigVersion:t.config.replicaConfigVersion,primaryReplica:t.config.primaryReplica},{primaryEpoch:t.previous.primaryEpoch,primaryReplica:t.previous.primaryReplica}),ctx);
  assert.deepEqual(await align(),{aligned:true,policyVersion:2});assert.deepEqual(await align(),{aligned:false,policyVersion:2});
  const m=(await h.snapshot(ControlReplicaMarker,sid,ctx))!;assert.deepEqual([m.fromEpoch,m.primaryEpoch,m.samePrimary],[1,2,true]);
  // The Root restarts after its live lease expired: the signed retained lease renews into epoch 2 with the same router epoch.
  const b=await build(h);root=await createConfiguredRoot(b.opts);
  const renewed=JSON.parse(readFileSync(join(dir,'root-lease'),'utf8'));assert.deepEqual([renewed.lease.id,renewed.lease.routerEpoch,renewed.lease.controlPrimaryEpoch],[first.lease.id,first.lease.routerEpoch,2]);
  for(let i=0;i<100&&!errors.some(e=>e.startsWith('Root epoch notice: m'));i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(errors.some(e=>e.startsWith('Root epoch notice: m')),'the Root tries to deliver the EpochNotice to the active Member');
  await root.close();root=undefined;
  // A primary change never lets an older lease renew: transition with a new primary, aligned, then renewal refused.
  await home.close(h);st=await raw();await applyConfigTransition(st,journal,{...journal.config,primaryEpoch:3,replicaConfigVersion:3,primaryReplica:'other-host'},{reason:'control-promote',ctx,assert:async()=>{}});await st.close(ctx);
  h=await home.open();const t2=lastConfigTransition(journal)!;
  await h.commit(tx=>alignControlReplicaIn(tx,sid,'authority',{transitionId:t2.transitionId,primaryEpoch:3,replicaConfigVersion:3,primaryReplica:'other-host'},{primaryEpoch:2,primaryReplica:'root-host'}),ctx);
  assert.equal((await h.snapshot(ControlReplicaMarker,sid,ctx))!.samePrimary,false);clock+=120_000;
  await assert.rejects((await build(h)).leases.issue('root-peer',router.keyId,{id:renewed.lease.id,routerEpoch:renewed.lease.routerEpoch,token:renewed}),/no longer owns current epoch/);
  void listSpaces;await home.close(h);journal.close();
 }finally{console.error=origError;await root?.close();for(const sv of servers)await sv.close();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});

for(const backend of BACKENDS)test(`${backend}: a new router takes an existing Root journal over only after the previous lease expired, with a higher router epoch`,async()=>{
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'root-takeover-')),external=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));
 let root:Awaited<ReturnType<typeof createConfiguredRoot>>|undefined;const servers:Awaited<ReturnType<typeof serveSpace>>[]=[];
 try{
  const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'control',Date.now()),ctx)).spaceId,control=provisionFileSigner(join(dir,'control-key')),agentHost=provisionFileSigner(join(dir,'host-key')),pKey=provisionFileSigner(join(dir,'p-key')),keys=new MemoryKeyDirectory();
  const routerA=provisionFileSigner(join(dir,'router-a')),routerB=provisionFileSigner(join(dir,'router-b'));
  const rec={peerId:'root-peer',keyId:routerA.keyId,algorithm:routerA.algorithm,publicKey:routerA.publicKey!,principal:'root',roles:['host','router','admin'],scope:['*'],state:'active' as const};
  keys.add(rec);keys.add({...rec,keyId:routerB.keyId,publicKey:routerB.publicKey!});keys.add({...rec,keyId:agentHost.keyId,algorithm:agentHost.algorithm,publicKey:agentHost.publicKey!,roles:['host']});keys.add({...rec,peerId:'p-peer',keyId:pKey.keyId,publicKey:pKey.publicKey!,roles:['host']});
  const s=(await snapshotSpace(host,sid,ctx))!,permit={state:'active',authorityId:'authority',dataIncarnation:s.incarnation!,role:'local',primaryEpoch:1,transitionId:'provisioned'};
  await installed.compareAndSet('installed:root-host:'+sid,null,permit);await external.compareAndSet('boot:root-host',null,{hostId:'root-host',state:'active',spaces:{[sid]:permit}});
  const peers:Record<string,string>={'127.0.0.1':'root-peer','127.0.0.2':'p-peer'};
  const directory={refresh:async()=>{},lookup:async(ip:string)=>peers[ip]?{id:peers[ip]!,name:peers[ip]!,ip,connected:true,groups:['hosts']}:null};
  servers.push(await serveSpace({handleText:async()=>JSON.stringify({id:0,ok:false,error:{code:'Unavailable',message:'fixture'}})},{listen:{host:'127.0.0.2',port:0}}));
  const target={hostId:'p',spaceId:'member-space',authorityId:'authority',dataIncarnation:'inc-p',primaryEpoch:1};
  await host.commit(async tx=>{const d=await tx.doc(FederationRouting,sid,null);d.policy={authorityId:'authority',policyVersion:1,rules:[],completionProfiles:[],default:{mode:'local',member:'m'}};d.members={m:{id:'m',state:'active',target}};
   const c=await spaceDoc(tx,sid,Date.now());c.authorityCounters={routerEpoch:0,policyVersion:1};},ctx);
  let clock=Date.now();
  const opts=(router:string,lease:string,extra:Record<string,unknown>={})=>{
   const identity=new GateIdentity(),grants=new GrantAuthority({authorityId:'authority',hostId:'root-host',signer:control,keys,identity,refreshIdentity:async c=>identity.authenticate(c)});
   const leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:sid,authorityId:'authority',peerId:'root-peer',signer:control,keys,assertAuthority:async()=>{},now:()=>clock});
   return {leases,o:{host,ctx,hostId:'root-host',peerId:'root-peer',ownAddress:'127.0.0.1',authorityId:'authority',controlSpaceId:sid,controlSigner:control,keys,directory,groupRoles:{hosts:['host','router','admin']},external,installed,grants,leases,assertControl:async()=>{},
    root:{id:'root',keyFile:join(dir,router),hostKeyFile:join(dir,'host-key'),leaseFile:join(dir,lease),journalPartitions:2,statusIntervalMs:15000,...extra,members:{m:{target,peerId:'p-peer',keyId:pKey.keyId,algorithm:pKey.algorithm,publicKey:pKey.publicKey!,address:{host:'127.0.0.2',port:(servers[0]!.address() as {port:number}).port}}}}}};
  };
  root=await createConfiguredRoot(opts('router-a','lease-a').o as any);await root.close();root=undefined;
  const a=JSON.parse(readFileSync(join(dir,'lease-a'),'utf8'));assert.equal(a.lease.routerEpoch,1);
  // Another router without its own lease: refused without takeover; with takeover it waits while the old lease is live.
  await assert.rejects(createConfiguredRoot(opts('router-b','lease-b').o as any),/lost its lease record/);
  await assert.rejects(createConfiguredRoot(opts('router-b','lease-b',{takeover:true,takeoverWaitMs:200}).o as any),/previous router lease is live/);
  // After expiry plus clock uncertainty the new router takes over with a higher router epoch.
  clock+=60_000+6_000;const b=opts('router-b','lease-b',{takeover:true});root=await createConfiguredRoot(b.o as any);
  const lb=JSON.parse(readFileSync(join(dir,'lease-b'),'utf8'));assert.deepEqual([lb.lease.routerEpoch,lb.lease.routerKeyId],[2,routerB.keyId]);
  assert.equal((await snapshotSpace(host,sid,ctx))!.authorityCounters!.routerEpoch,2);
  // The old router's retained lease never renews again.
  await assert.rejects(b.leases.issue('root-peer',routerA.keyId,{id:a.lease.id,routerEpoch:1,token:a}),/no longer owns current epoch/);
  await root.close();root=undefined;
  // The new router restarts from its own retained lease; takeover no longer applies.
  root=await createConfiguredRoot(opts('router-b','lease-b').o as any);assert.equal(JSON.parse(readFileSync(join(dir,'lease-b'),'utf8')).lease.routerEpoch,2);
  await root.close();root=undefined;
  // The way back: router A still holds its superseded lease. Without takeover it stays refused; with takeover it waits
  // while B's lease lives, then takes over with router epoch 3.
  await assert.rejects(createConfiguredRoot(opts('router-a','lease-a').o as any),/no longer owns current epoch/);
  await assert.rejects(createConfiguredRoot(opts('router-a','lease-a',{takeover:true,takeoverWaitMs:200}).o as any),/previous router lease is live/);
  clock+=60_000+6_000;root=await createConfiguredRoot(opts('router-a','lease-a',{takeover:true}).o as any);
  assert.deepEqual([JSON.parse(readFileSync(join(dir,'lease-a'),'utf8')).lease.routerEpoch,(await snapshotSpace(host,sid,ctx))!.authorityCounters!.routerEpoch],[3,3]);
 }finally{await root?.close();for(const sv of servers)await sv.close();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});
