import test from "node:test";
import { exerciseFederationRuntime } from "./support/federation-runtime.ts";
test("two persistent runtimes: bootstrap, boot authorization, grant-only data access, expiry/resolution, key rotation and reopen", exerciseFederationRuntime);

import assert from 'node:assert/strict';
import net from 'node:net';
import {startFederationHost,SpaceKeyDirectory,GrantVerifier,generateKey,createSpace,spaceDoc,core,PiSpaces} from '../src/index.ts';
import {BACKENDS,PersistentHome,ctx} from './support/persistent.ts';
for(const backend of BACKENDS)test(`${backend}: recovered Supervisor work can reach the guarded Control listener during host startup`,async()=>{
 const home=new PersistentHome(backend);let runtime:Awaited<ReturnType<typeof startFederationHost>>|undefined;
 try{
  let host=await home.open();const sid=(await host.commit(tx=>createSpace(tx,'control',1000),ctx)).spaceId;
  await host.commit(async tx=>{const s=await spaceDoc(tx,sid,1000);core.write(s,1000,{type:'PeerKey',fields:{peerId:'admin',principal:'admin',keyId:'k',state:'active',roles:['admin'],scope:['*'],algorithm:'ed25519',publicKey:'fixture'}},null,core.FOREVER);core.write(s,1000,{type:'Command',fields:{commandId:'profile-reopen',kind:'migrateProfiles',args:{policy:{}}}},null,core.FOREVER,'admin');},ctx);
  await home.close(host);host=await home.open();const reservation=net.createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=(reservation.address() as net.AddressInfo).port;await new Promise<void>((resolve,reject)=>reservation.close(e=>e?reject(e):resolve()));let reached=false;
  const signer=generateKey('ed25519','control'),keys=new SpaceKeyDirectory(host,ctx,()=>1000);
  runtime=await startFederationHost(host,ctx,{hostId:'root',authorityId:'authority',unsafeSkipBootGuardForTests:true,keys,verifier:new GrantVerifier({authorityId:'authority',issuerHostId:'root',publicKey:signer.publicKey,algorithm:'ed25519',now:()=>1000}),directory:{refresh:async()=>{},lookup:async()=>({id:'member',ip:'127.0.0.1',name:'member',connected:true,groups:[]})},listen:{host:'127.0.0.1',port},revalidateMs:0,now:()=>1000,control:{host,authority:{} as any,profiles:{execute:async()=>{await new Promise<void>((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.setTimeout(2000,()=>socket.destroy(Error('startup listener timeout')));socket.once('connect',()=>{reached=true;socket.destroy();resolve();});socket.once('error',reject);});return{phase:'completed'};}} as any}});
  assert.ok(reached,'initial recovered work must reach the real Control listener');const results=await new PiSpaces(host,ctx,()=>1000,undefined,undefined,{space:sid}).readAll({type:'Result',fields:{commandId:'profile-reopen'}});assert.equal(results.length,1);assert.equal(results[0]!.fields.state,'completed');
 }finally{await runtime?.close();await home.dispose();}
});
