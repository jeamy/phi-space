import test from "node:test";
import {createServer as createRawServer,connect as rawConnect} from "node:net";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SqliteRecoveryRegister, RegisterConflict, RecoveryBlocked, RecoveryCoordinator, MemberTransitionInstaller, PhiSpaces, core, Space, installBootGuard, BootBlocked, serveTlsRegister, TlsRecoveryRegister, ControlAckService, RecoveryReceipts, RecoveryClient, serveRecovery, generateKey, spaceDoc, createSpace, type RecoveryRegister } from "../src/index.ts";
import { forEachBackend, ctx } from "./support/persistent.ts";

test("member authority installation replays a lost external ACK, invalidates old generations and permits another recovery", async () => {
 await forEachBackend(async home => {
  let h = await home.open();
  const dir = mkdtempSync(join(tmpdir(), "phi-spaces-member-transition-")), external = new SqliteRecoveryRegister(join(dir,"external.sqlite")), installed = new SqliteRecoveryRegister(join(dir,"installed.sqlite")), operator = generateKey("ed25519","operator");
  let failAck = true, stopped = false;
  const flaky: RecoveryRegister = { get: external.get.bind(external), compareAndSet: async (key, version, value) => { if (key.startsWith("authority-ack:") && failAck) { failAck=false; throw new Error("lost ACK connection"); } return external.compareAndSet(key,version,value); } };
  try {
   const client = new PhiSpaces(h,ctx,()=>1);
   await client.write({type:"Task",fields:{n:1}},null,core.FOREVER);
   const generation=await client.issueGeneration({peerId:"worker"});
   await client.write({type:"Decided",fields:{retained:true}},null,core.FOREVER,{request:{principal:{peerId:"worker"},...generation,requestId:"decided"}});
   await client.beginOperation({type:"Future"},core.FOREVER,{request:{principal:{peerId:"worker"},...generation,requestId:"pending"}},true,false);
   const source=(await h.snapshot(Space,ctx))!, space=source.spaceId!;
   const permit={state:"active",authorityId:"old",dataIncarnation:source.incarnation!,primaryEpoch:7,role:"local",transitionId:"initial"};
   await h.commit(async tx => { (await spaceDoc(tx,space,1)).primaryEpoch=7; },ctx);
   await external.compareAndSet("boot:member",null,{hostId:"member",state:"active",spaces:{[space]:permit}});
   await installed.compareAndSet(`installed:member:${space}`,null,permit);
   await installed.compareAndSet("installed-authority:control",null,{authorityId:"old"});
   await external.compareAndSet("authority:control",null,{authorityId:"old",hostId:"lost-root",supervisorKey:"old-key",state:"active",lineage:{}});
   const proof=await new RecoveryCoordinator(external,operator.signer).reserve({recoveryId:"recovery-1",expectedAuthorityId:"old",controlSpaceId:"control",targetHostId:"new-root",supervisorKey:"new-key"},async hostId=>({hostId,restartLocked:true}));
   const installer=()=>new MemberTransitionInstaller({host:h,ctx,hostId:"member",external:flaky,installed,pinned:{algorithm:"ed25519",publicKey:operator.publicKey},assertQuiesced:async()=>({hostId:"member",normalStopped:stopped,restartLocked:true}),now:()=>1});
   await assert.rejects(installer().advance(proof),/must be stopped/); stopped=true;
   await installer().advance(proof); home.crash(h); h=await home.open();
   await assert.rejects(async()=>{for(let i=0;i<20;i++)if((await installer().advance(proof)).completed)break;},/lost ACK/);
   assert.ok(await installed.get("member-ack:recovery-1:member")); assert.equal(await external.get("authority-ack:recovery-1:member"),null);
   home.crash(h); h=await home.open();
   const resumed=await installer().advance(proof); assert.equal(resumed.completed,true); assert.deepEqual((await external.get<any>("authority-ack:recovery-1:member"))?.value,resumed.ack);
   let s=(await h.snapshot(Space,ctx))!;assert.equal(s.acceptedAuthorityId,proof.transition.newAuthorityId);assert.equal(s.primaryEpoch,1);assert.equal(s.entries[0]?.fields.n,1);assert.ok(s.restoredClaims && Object.keys(s.restoredClaims).length===1);assert.ok(s.invalidGenerations?.[generation.generation]);assert.equal(s.rpc?.claims && Object.keys(s.rpc.claims).length,1);assert.ok(Object.values(s.rpc!.claims)[0]!.orphanedAfterRestore);
   const guard=installBootGuard(h,ctx,{hostId:"member",authorityId:proof.transition.newAuthorityId,external,installed});
   await new PhiSpaces(h,ctx,()=>1).write({type:"New",fields:{}}); guard();
   const authority=(await external.get<any>("authority:control"))!;await external.compareAndSet("authority:control",authority.version,{...authority.value,state:"active"});
   const second=await new RecoveryCoordinator(external,operator.signer).reserve({recoveryId:"recovery-2",expectedAuthorityId:proof.transition.newAuthorityId,controlSpaceId:"control",targetHostId:"third-root",supervisorKey:"third-key"},async hostId=>({hostId,restartLocked:true}));
   for(let i=0;i<20;i++)if((await installer().advance(second)).completed)break;
   assert.equal((await h.snapshot(Space,ctx))?.acceptedAuthorityId,second.transition.newAuthorityId);
   await assert.rejects(installer().advance(proof),/no longer/);
   const stop=installBootGuard(h,ctx,{hostId:"member",authorityId:second.transition.newAuthorityId,external,installed});
   // A stale import with unchanged incarnation and epoch must still fail the outside-snapshot authority marker.
   stop(); await h.commit(async tx => { (await spaceDoc(tx,space,1)).acceptedAuthorityId="old"; },ctx);
   const staleGuard=installBootGuard(h,ctx,{hostId:"member",authorityId:second.transition.newAuthorityId,external,installed});
   try { await assert.rejects(new PhiSpaces(h,ctx,()=>1).count({type:"Task"}),BootBlocked); } finally { staleGuard(); }
  } finally { external.close();installed.close();rmSync(dir,{recursive:true,force:true}); }
 });
});

function certificates(dir:string){
 const openssl=(args:string[])=>execFileSync("openssl",args,{cwd:dir,stdio:"ignore"});
 openssl(["req","-x509","-newkey","rsa:2048","-nodes","-keyout","ca.key","-out","ca.crt","-days","2","-subj","/CN=Test Recovery CA"]);
 for(const name of ["server","reader","operator","scoped","unknown"]){
  openssl(["req","-newkey","rsa:2048","-nodes","-keyout",`${name}.key`,"-out",`${name}.csr`,"-subj",`/CN=${name}`]);
  writeFileSync(join(dir,`${name}.ext`),name==="server"?"subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n":"extendedKeyUsage=clientAuth\n",{mode:0o600});
  openssl(["x509","-req","-in",`${name}.csr`,"-CA","ca.crt","-CAkey","ca.key","-CAcreateserial","-out",`${name}.crt`,"-days","2","-extfile",`${name}.ext`]);
  chmodSync(join(dir,`${name}.key`),0o600);chmodSync(join(dir,`${name}.crt`),0o600);
 }
 chmodSync(join(dir,"ca.crt"),0o600);
 const identity=(name:string)=>({caFile:join(dir,"ca.crt"),certFile:join(dir,`${name}.crt`),keyFile:join(dir,`${name}.key`)});
 const fingerprint=(name:string)=>createHash("sha256").update(new X509Certificate(readFileSync(join(dir,`${name}.crt`))).raw).digest("hex");
 return {identity,fingerprint};
}

test("mutual TLS register separates readers, scoped writers and operators and persists CAS across restart",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"phi-spaces-tls-register-")),pki=certificates(dir);let db=new SqliteRecoveryRegister(join(dir,"register.sqlite"));
 const config={...pki.identity("server"),host:"127.0.0.1",port:0,peers:{[pki.fingerprint("reader")]:{operator:false},[pki.fingerprint("operator")]:{operator:true},[pki.fingerprint("scoped")]:{writeKeys:["boot:member"]}}};
 let server=await serveTlsRegister(db,config);
 const unixPath=join(dir,"register-tunnel.sock"),tunnelSockets=new Set<ReturnType<typeof rawConnect>>();
 const tunnel=createRawServer(socket=>{const upstream=rawConnect({host:"127.0.0.1",port:(server.address() as any).port});
  for(const current of [socket,upstream]){tunnelSockets.add(current);current.on("close",()=>tunnelSockets.delete(current));}
  socket.on("error",()=>upstream.destroy());upstream.on("error",()=>socket.destroy());socket.on("close",()=>upstream.destroy());upstream.on("close",()=>socket.destroy());socket.pipe(upstream).pipe(socket);
 });
 await new Promise<void>((resolve,reject)=>{tunnel.once("error",reject);tunnel.listen(unixPath,()=>{tunnel.off("error",reject);resolve();});});chmodSync(unixPath,0o600);
 const tunneled=new TlsRecoveryRegister({...pki.identity("reader"),host:"127.0.0.1",port:1,unixPath,serverName:"127.0.0.1",batchReads:true});
 assert.throws(()=>new TlsRecoveryRegister({...pki.identity("reader"),host:"127.0.0.1",port:1,unixPath}),/pinned TLS server name/);
 const client=(name:string)=>new TlsRecoveryRegister({...pki.identity(name),host:"127.0.0.1",port:(server.address() as any).port,timeoutMs:2000,batchReads:true});
 try{
  await client("operator").compareAndSet("authority:control",null,{authorityId:"a"});
  assert.equal((await client("reader").get<any>("authority:control"))?.value.authorityId,"a");
  await assert.rejects(client("reader").compareAndSet("authority:control",1,{authorityId:"forged"}),/no CAS permission/);
  await assert.rejects(client("operator").compareAndSet("authority:control",null,{}),RegisterConflict);
  await assert.rejects(client("unknown").get("authority:control"));
  await client("scoped").compareAndSet("boot:member",null,{state:"quarantine"});
  await assert.rejects(client("scoped").compareAndSet("authority:control",1,{}),/no CAS permission/);
  const batch=await client("reader").getMany(["authority:control","boot:member","missing"]);
  assert.equal((batch["authority:control"]!.value as any).authorityId,"a");
  assert.equal((batch["boot:member"]!.value as any).state,"quarantine");assert.equal(batch.missing,null);
  await assert.rejects(client("reader").getMany(Array.from({length:33},(_,i)=>"key:"+i)),RegisterConflict);
  await assert.rejects(client("unknown").getMany(["authority:control"]));
  // Fresh batches must observe changes; no authenticated connection or record is cached.
  await client("operator").compareAndSet("boot:member",1,{state:"fenced"});
  assert.equal(((await client("reader").getMany(["boot:member"]))["boot:member"]!.value as any).state,"fenced");
  assert.equal(((await tunneled.getMany(["boot:member"]))["boot:member"]!.value as any).state,"fenced");
  const readerPolicy=config.peers[pki.fingerprint("reader")];delete config.peers[pki.fingerprint("reader")];
  await assert.rejects(client("reader").getMany(["boot:member"]));
  await assert.rejects(tunneled.getMany(["boot:member"]));
  config.peers[pki.fingerprint("reader")]=readerPolicy;
  const erasure={spaceId:"jobs",epoch:1,state:"pending",commandHash:"a".repeat(64),archiveDeadline:2000,archivesPending:true};
  await client("operator").compareAndSet("erasure:jobs",null,erasure);
  await assert.rejects(client("operator").compareAndSet("erasure:jobs",1,{...erasure,epoch:0}),RegisterConflict);
  await assert.rejects(client("operator").compareAndSet("erasure-archives:jobs",null,{spaceId:"jobs",artifacts:[{id:"stale",sha256:"b".repeat(64),epoch:0,kind:"backup",state:"retained"}]}),RegisterConflict);
  assert.equal((await client("reader").get<any>("erasure:jobs"))?.version,1);
  await server.close();db.close();db=new SqliteRecoveryRegister(join(dir,"register.sqlite"));server=await serveTlsRegister(db,config);
  assert.equal((await client("reader").get<any>("authority:control"))?.value.authorityId,"a");
  const wrongName=new TlsRecoveryRegister({...pki.identity("reader"),host:"127.0.0.1",serverName:"untrusted.example",port:(server.address() as any).port});await assert.rejects(wrongName.get("authority:control"));
 }finally{for(const socket of tunnelSockets)socket.destroy();await new Promise<void>(resolve=>tunnel.close(()=>resolve()));await server.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test("signed control ACK is durable, rejects mismatched tuples and cannot bypass a fenced source",async()=>{
 await forEachBackend(async home=>{
  let h=await home.open();const dir=mkdtempSync(join(tmpdir(),"phi-spaces-control-ack-")),db=new SqliteRecoveryRegister(join(dir,"external.sqlite")),admin=generateKey("ed25519","admin"),member=generateKey("ed25519","member");
  const info=await h.commit(tx=>createSpace(tx,"control",1),ctx),space=info.spaceId;
  const args={recoveryId:"restore-data",space:"data",incarnation:"new-data",primaryEpoch:2,authorityId:"authority",targetHostId:"target",argsHash:"hash"};
  await db.compareAndSet(`authority:${space}`,null,{state:"active",hostId:"control-host",authorityId:"authority"});
  await db.compareAndSet("data-transition:data",null,{...args,state:"restoring",expectedDataIncarnation:"old-data",sourceHostId:"source"});
  await db.compareAndSet("boot:target",null,{state:"active",spaces:{data:{state:"revoked",authorityId:"authority",dataIncarnation:"old-data"}}});
  await db.compareAndSet("boot:source",null,{state:"fenced"});
  const service=()=>new ControlAckService({host:h,ctx,register:db,hostId:"control-host",authorityId:"authority",controlSpaceId:space,now:()=>1});
  const server=await serveRecovery({path:join(dir,"ack.sock"),hostId:"control-host",operator:{algorithm:"ed25519",publicKey:admin.publicKey},hostKey:async()=>({algorithm:"ed25519",publicKey:member.publicKey}),handle:async call=>{if(call.method!=="controlAck")throw new RecoveryBlocked("unsupported");return await service().acknowledge(call.args as any) as any;}}),client=new RecoveryClient(join(dir,"ack.sock"),{hostId:"control-host",signer:member.signer});
  try{
   assert.deepEqual(await client.call("controlAck",args),args);home.crash(h);h=await home.open();assert.deepEqual(await client.call("controlAck",args),args);assert.deepEqual((await h.snapshot(RecoveryReceipts,ctx))?.receipts[args.recoveryId],args);
   await assert.rejects(client.call("controlAck",{...args,incarnation:"other"}),/disagrees/);await assert.rejects(client.call("installAuthority",{}),/not authorized/);
   const source=(await db.get<any>("boot:source"))!;await db.compareAndSet("boot:source",source.version,{state:"active"});await assert.rejects(client.call("controlAck",args),/not independently fenced/);
  }finally{client.close();await server.close();db.close();rmSync(dir,{recursive:true,force:true});}
 });
});

test("control restore requires a new admin and every confirmed member ACK; retries retain one authority and closed old rights",async()=>{
 const {ControlRecoveryController,controlRecoveryHandler,createSpace,Registry,NamedSpace,claims}=await import("../src/index.ts");
 await forEachBackend(async home=>{
  let h=await home.open(),now=1,stopped=true;const dir=mkdtempSync(join(tmpdir(),"phi-spaces-control-restore-")),external=new SqliteRecoveryRegister(join(dir,"external.sqlite")),installed=new SqliteRecoveryRegister(join(dir,"installed.sqlite")),operator=generateKey("ed25519","operator"),supervisor=generateKey("ed25519","supervisor"),admin=generateKey("ecdsa-p256","new-admin");
  try{
   const info=await h.commit(tx=>createSpace(tx,"control",now),ctx),space=info.spaceId;
   const local=new PhiSpaces(h,ctx,()=>now,undefined,undefined,{space});
   await local.write({type:"PeerKey",fields:{peerId:"old-admin",keyId:"old-key",algorithm:"ed25519",publicKey:operator.publicKey,roles:["admin"],scope:["*"],state:"active"}},null,core.FOREVER);
   await local.write({type:"Member",fields:{hostId:"offline-member",state:"active"}},null,core.FOREVER);
   const source=core.plain((await h.snapshot(NamedSpace,space,ctx))!);
   const spaces:Record<string,any>={};for(const i of await (await import("../src/index.ts")).listSpaces(h,ctx)){const permit={state:"active",authorityId:"old",dataIncarnation:i.incarnation,primaryEpoch:1,role:"local",transitionId:"initial"};spaces[i.spaceId]=permit;await installed.compareAndSet(`installed:target:${i.spaceId}`,null,permit);}
   await installed.compareAndSet("installed-authority:"+space,null,{authorityId:"old"});await external.compareAndSet("boot:target",null,{hostId:"target",state:"active",spaces});await external.compareAndSet("authority:"+space,null,{authorityId:"old",hostId:"lost-source",supervisorKey:"old-supervisor",state:"active",lineage:{}});
   const options=()=>({host:h,ctx,hostId:"target",external,installed,operator:operator.signer,supervisor:supervisor.signer,loadSnapshot:async()=>source,verifyFence:async(hostId:string)=>({hostId,restartLocked:true}),assertQuiesced:async()=>({hostId:"target",normalStopped:stopped,restartLocked:true}),now:()=>now});
   const controller=()=>new ControlRecoveryController(options());const request={recoveryId:"control-1",controlSpaceId:space,snapshotRef:"control.json",expectedAuthorityId:"old",expectedDataIncarnation:source.incarnation!,expectedPrimaryEpoch:1,targetHostId:"target",confirmedMembers:["target","missing-member"]};
   const first=await controller().submit(request);await assert.rejects(controller().submit({...request,snapshotRef:"other.json"}),RegisterConflict);home.crash(h);h=await home.open();
   for(let i=0;i<30&&(await controller().status(request.recoveryId)).state!=="waiting";i++)await controller().advance(request.recoveryId);
   assert.equal((await controller().status(request.recoveryId)).state,"waiting");assert.equal((await external.get<any>("authority:"+space))?.value.state,"transitioning");
   await assert.rejects(controller().advance(request.recoveryId),/validity has not expired/);now=62001;await assert.rejects(controller().advance(request.recoveryId),/no matching durable/);
   const otherHome=new (await import("./support/persistent.ts")).PersistentHome(home.backend);const other=await otherHome.open(),otherInstalled=new SqliteRecoveryRegister(join(dir,"other-installed.sqlite"));
   try{
    const otherSpace=await other.commit(async tx=>core.plain(await spaceDoc(tx,undefined,now)),ctx),otherPermit={state:"active",authorityId:"old",dataIncarnation:otherSpace.incarnation!,primaryEpoch:1,role:"local",transitionId:"initial"};await otherInstalled.compareAndSet("installed-authority:"+space,null,{authorityId:"old"});await otherInstalled.compareAndSet(`installed:missing-member:${otherSpace.spaceId}`,null,otherPermit);await external.compareAndSet("boot:missing-member",null,{hostId:"missing-member",state:"active",spaces:{[otherSpace.spaceId!]:otherPermit}});
    const installer=new MemberTransitionInstaller({host:other,ctx,hostId:"missing-member",external,installed:otherInstalled,pinned:{algorithm:"ed25519",publicKey:operator.publicKey},assertQuiesced:async()=>({hostId:"missing-member",normalStopped:true,restartLocked:true}),now:()=>now});for(let i=0;i<20;i++)if((await installer.advance(first.proof)).completed)break;
    await assert.rejects(controller().advance(request.recoveryId),/first new admin/);
    const rpcMember=new MemberTransitionInstaller({...options(),pinned:{algorithm:"ed25519",publicKey:operator.publicKey}});
    const rpc=await serveRecovery({path:join(dir,"control.sock"),hostId:"target",operator:{algorithm:"ed25519",publicKey:operator.publicKey},supervisor:async()=>({algorithm:"ed25519",publicKey:supervisor.publicKey}),handle:async(c,r)=>controlRecoveryHandler(controller(),rpcMember)(c,r)}),client=new RecoveryClient(join(dir,"control.sock"),{hostId:"target",signer:operator.signer}),forbidden=new RecoveryClient(join(dir,"control.sock"),{hostId:"target",signer:supervisor.signer});
    try{await assert.rejects(forbidden.call("authorizeRecoveryKey",{recoveryId:request.recoveryId,key:{}}),/not authorized/);await client.call("authorizeRecoveryKey",{recoveryId:request.recoveryId,key:{peerId:"new-admin",publicKey:admin.publicKey,algorithm:"ecdsa-p256",roles:["admin"],scope:["*"]}});assert.equal((await client.call("advanceControlRestore",{recoveryId:request.recoveryId}) as any).state,"completed");}finally{client.close();forbidden.close();await rpc.close();}
    home.crash(h);h=await home.open();assert.equal((await controller().advance(request.recoveryId)).state,"completed");const restored=(await h.snapshot(NamedSpace,space,ctx))!;assert.notEqual(restored.incarnation,source.incarnation);assert.equal(restored.primaryEpoch,1);assert.deepEqual(restored.authorityCounters,{routerEpoch:1,policyVersion:1});assert.equal(core.list(restored,now,{type:"PeerKey",fields:{peerId:"old-admin"}})[0]!.fields.state,"revoked");assert.equal(core.list(restored,now,{type:"Member",fields:{hostId:"offline-member"}})[0]!.fields.state,"recoveryBlocked");assert.equal(core.list(restored,now,{type:"Bootstrap"})[0]!.fields.state,"closed");assert.equal((await external.get<any>("access:"+first.proof.transition.newAuthorityId))?.value.aOnlyAllowed,false);assert.equal((await external.get<any>("authority:"+space))?.value.state,"active");
   }finally{otherInstalled.close();await otherHome.dispose();}
  }finally{external.close();installed.close();rmSync(dir,{recursive:true,force:true});}
 });
});

test("control ACK rechecks the enrolled host key inside the receipt commit",async()=>{
 await forEachBackend(async home=>{
  const h=await home.open(),dir=mkdtempSync(join(tmpdir(),"phi-spaces-host-ack-")),db=new SqliteRecoveryRegister(join(dir,"external.sqlite")),key=generateKey("ed25519","host-app");
  const info=await h.commit(tx=>createSpace(tx,"control",1),ctx),service=new ControlAckService({host:h,ctx,register:db,hostId:"root",authorityId:"a",controlSpaceId:info.spaceId,now:()=>1}),args={recoveryId:"r",space:"data",incarnation:"new",primaryEpoch:2,authorityId:"a",targetHostId:"target",argsHash:"hash"};
  try{
   await db.compareAndSet(`authority:${info.spaceId}`,null,{state:"active",hostId:"root",authorityId:"a"});await db.compareAndSet("data-transition:data",null,{...args,state:"restoring",sourceHostId:"source",expectedDataIncarnation:"old"});await db.compareAndSet("boot:source",null,{state:"fenced"});await db.compareAndSet("boot:target",null,{state:"active",spaces:{data:{state:"revoked",authorityId:"a",dataIncarnation:"old"}}});await db.compareAndSet("host-key:target",null,{state:"active",authorityId:"a",peerId:"target-peer",keyId:"host-app",algorithm:"ed25519",publicKey:key.publicKey});
   await h.commit(async tx=>core.write(await spaceDoc(tx,info.spaceId,1),1,{type:"PeerKey",fields:{state:"active",peerId:"target-peer",keyId:"host-app",roles:["host"],scope:["*"],algorithm:"ed25519",publicKey:key.publicKey}},null,core.FOREVER),ctx);
   const call={hostId:"root",method:"controlAck",args,requestId:"rpc",issuedAt:1,expiresAt:60001};assert.ok(await service.hostKey(call));
   const {revokePeerKey}=await import("../src/index.ts");await revokePeerKey(h,ctx,"target-peer","host-app",()=>1);
   await assert.rejects(service.acknowledge(args,true),/host key changed/);assert.equal((await h.snapshot(RecoveryReceipts,ctx))?.receipts.r,undefined);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
 });
});
