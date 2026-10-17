import test from 'node:test';
import assert from 'node:assert/strict';
import {CapabilityDirectory,MemberStatusDirectory} from '../src/capability-directory.ts';
import {FederationRouting} from '../src/federation-policy.ts';
import * as core from '../src/core.ts';
import {createSpace,spaceDoc,snapshotSpace} from '../src/spaces.ts';
import {BACKENDS,ctx,PersistentHome} from './support/persistent.ts';
for(const backend of BACKENDS)test(`${backend}: protected capabilities, bounded renewal, status expiry and no implicit Member`,async()=>{
 const home=new PersistentHome(backend);try{
 const host=await home.open();let now=100000;const sid=(await host.commit(tx=>createSpace(tx,'control',now),ctx)).spaceId;
 const directory=new CapabilityDirectory({host,ctx,spaceId:sid,assertAuthority:async()=>{},now:()=>now});
 const report={hostId:'a',resources:{cpu:4},tools:['sieve'],models:[],metrics:{free:200}};
 await assert.rejects(directory.heartbeat(report,{peerId:'b',roles:['host']}),core.PermissionError);
 await assert.rejects(directory.heartbeat(report,{peerId:'a',roles:['member']}),core.PermissionError);
 await directory.heartbeat(report,{peerId:'a',roles:['host']});now+=60000;await directory.heartbeat(report,{peerId:'a',roles:['host']});
 let s=(await snapshotSpace(host,sid,ctx))!;assert.equal(core.list(s,now,{type:'Capability'}).length,1);assert.equal(s.entries[0]!.expires,now+120000);
 assert.equal((await host.snapshot(FederationRouting,sid,ctx))?.members.a,undefined);
 assert.throws(()=>core.write(s,now,{type:'Business',types:['Business','Capability'],fields:{}},null,1000,'worker'),core.PermissionError);
 assert.throws(()=>core.probe(s,now,null,null,true,'worker'),core.PermissionError);
 assert.throws(()=>core.renew(s,now,s.entries[0]!.id,core.FOREVER,'worker'),core.PermissionError);
 const target={hostId:'a',spaceId:'jobs-a',authorityId:'authority',dataIncarnation:'1',primaryEpoch:1};
 await host.commit(async tx=>{(await tx.doc(FederationRouting,sid,null)).members.a={id:'a',state:'active',target};},ctx);
 let online=true,known=true;const statuses=new MemberStatusDirectory({host,ctx,controlSpaceId:sid,assertAuthority:async()=>{},now:()=>now,probe:async()=>{if(!online)throw Error('offline');return{revision:9,free:known?200:null,lag:null};}});
 await statuses.refresh();let routing=await host.snapshot(FederationRouting,sid,ctx);assert.deepEqual(routing!.members.a!.capabilities!.names,['sieve']);
 s=(await snapshotSpace(host,sid,ctx))!;assert.equal(core.list(s,now,{type:'MemberStatus'})[0]!.fields.reachable,true);
 known=false;await statuses.refresh();routing=await host.snapshot(FederationRouting,sid,ctx);assert.equal(routing!.members.a!.capacity,undefined);s=(await snapshotSpace(host,sid,ctx))!;assert.equal(core.list(s,now,{type:'MemberStatus'})[0]!.fields.reachable,true);
 online=false;now+=15000;await statuses.refresh();routing=await host.snapshot(FederationRouting,sid,ctx);assert.equal(routing!.members.a!.capacity,undefined);assert.equal(routing!.members.a!.capabilities,undefined);
 now+=120001;await host.commit(async tx=>core.settle(await spaceDoc(tx,sid,now),now),ctx);s=(await snapshotSpace(host,sid,ctx))!;assert.equal(core.list(s,now,{type:'Capability'}).length,0);assert.equal(core.list(s,now,{type:'MemberStatus'}).length,0);
 }finally{await home.dispose();}
});
