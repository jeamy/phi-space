import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConfiguredRoot,MemoryKeyDirectory,provisionFileSigner,createSpace,spaceDoc,snapshotSpace,GateIdentity,GrantAuthority,RouterLeaseAuthority,SqliteRecoveryRegister,BootBlocked} from './src/index.ts';
import {BACKENDS,PersistentHome,ctx} from './test/support/persistent.ts';
for(const backend of BACKENDS)test(`${backend}: configured native Root retains lease and blocks invalid boot, key and lost lease`,async()=>{
 const home=new PersistentHome(backend),dir=mkdtempSync(join(tmpdir(),'configured-root-')),external=new SqliteRecoveryRegister(join(dir,'external.sqlite')),installed=new SqliteRecoveryRegister(join(dir,'installed.sqlite'));let root:Awaited<ReturnType<typeof createConfiguredRoot>>|undefined;
 try{
  const host=await home.open(),sid=(await host.commit(tx=>createSpace(tx,'control',Date.now()),ctx)).spaceId,control=provisionFileSigner(join(dir,'control-key')),router=provisionFileSigner(join(dir,'router-key')),agentHost=provisionFileSigner(join(dir,'host-key')),keys=new MemoryKeyDirectory();
  const rec={peerId:'root-peer',keyId:router.keyId,algorithm:router.algorithm,publicKey:router.publicKey!,principal:'root',roles:['host','router','admin'],scope:['*'],state:'active' as const};keys.add(rec);keys.add({...rec,keyId:agentHost.keyId,algorithm:agentHost.algorithm,publicKey:agentHost.publicKey!,roles:['host']});
  const s=(await snapshotSpace(host,sid,ctx))!,permit={state:'active',authorityId:'authority',dataIncarnation:s.incarnation!,role:'local',primaryEpoch:1,transitionId:'provisioned'};
  await installed.compareAndSet('installed:root-host:'+sid,null,permit);await external.compareAndSet('boot:root-host',null,{hostId:'root-host',state:'active',spaces:{[sid]:permit}});
  let management=true;const directory={refresh:async()=>{if(!management)throw Error('management unavailable');},lookup:async(ip:string)=>{if(!management)throw Error('management unavailable');return ip==='127.0.0.1'?{id:'root-peer',name:'root',ip,connected:true,groups:['hosts']}:null;}};
  const identity=new GateIdentity(),grants=new GrantAuthority({authorityId:'authority',hostId:'root-host',signer:control,keys,identity,refreshIdentity:async c=>identity.authenticate(c)}),leases=new RouterLeaseAuthority({host,ctx,controlSpaceId:sid,authorityId:'authority',peerId:'root-peer',signer:control,keys,assertAuthority:async()=>{}});
  const opts={host,ctx,hostId:'root-host',peerId:'root-peer',ownAddress:'127.0.0.1',authorityId:'authority',controlSpaceId:sid,controlSigner:control,keys,directory,groupRoles:{hosts:['host','router','admin']},external,installed,grants,leases,assertControl:async()=>{},root:{id:'root',keyFile:join(dir,'router-key'),hostKeyFile:join(dir,'host-key'),leaseFile:join(dir,'root-lease'),journalPartitions:8,members:{}}};
  root=await createConfiguredRoot(opts);const first=JSON.parse((await import('node:fs')).readFileSync(opts.root.leaseFile,'utf8'));assert.equal(first.lease.routerEpoch,1);await root.close();root=undefined;
  root=await createConfiguredRoot(opts);const second=JSON.parse((await import('node:fs')).readFileSync(opts.root.leaseFile,'utf8'));assert.equal(second.lease.id,first.lease.id);assert.equal(second.lease.routerEpoch,first.lease.routerEpoch);
  const version=(await external.get('boot:root-host'))!.version;await external.compareAndSet('boot:root-host',version,{hostId:'root-host',state:'fenced',spaces:{[sid]:permit}});
  await assert.rejects(root.space.initializeJournals(),BootBlocked);await root.close();root=undefined;await assert.rejects(createConfiguredRoot(opts),BootBlocked);
  const fenced=(await external.get('boot:root-host'))!.version;await external.compareAndSet('boot:root-host',fenced,{hostId:'root-host',state:'active',spaces:{[sid]:permit}});
  management=false;await assert.rejects(createConfiguredRoot(opts),/management unavailable/);management=true;
  keys.add({...rec,state:'revoked'});await assert.rejects(createConfiguredRoot(opts),/enrolled router key/);keys.add(rec);
  unlinkSync(opts.root.leaseFile);await assert.rejects(createConfiguredRoot(opts),/lost its lease/);
 }finally{await root?.close();external.close();installed.close();await home.dispose();rmSync(dir,{recursive:true,force:true});}
});
