import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKey} from '../src/auth.ts';
import {PhiSpaces} from '../src/client.ts';
import {FOREVER} from '../src/core.ts';
import {FederationRouting,FederationPolicyAuthority} from '../src/federation-policy.ts';
import {ProfileTransitionController,ProfileTransitions} from '../src/profile-transition.ts';
import {MemberLifecycle,MembershipController,signMembership,type MembershipTransport} from '../src/membership.ts';
import {FederationOperations} from '../src/federated-space.ts';
import {MigrationRequired,MemberDrained,RoutingConflict,type FederationMember,type FederationPolicy} from '../src/routing-semantics.ts';
import {createSpace,snapshotSpace} from '../src/spaces.ts';
import {BACKENDS,PersistentHome,ctx} from './support/persistent.ts';

for(const backend of BACKENDS){
 test(`${backend}: profile transition freezes, survives lost replies/reopen and enforces changed completion`,async()=>{
  const homes=[new PersistentHome(backend),new PersistentHome(backend),new PersistentHome(backend)];
  try{
   let hosts=await Promise.all(homes.map(h=>h.open()));const rootKey=generateKey('ed25519','control'),keys=[generateKey('ed25519','a'),generateKey('ed25519','b')];
   const control=(await hosts[0]!.commit(tx=>createSpace(tx,'control',1000),ctx)).spaceId;
   const sids=await Promise.all(hosts.slice(1).map(h=>h.commit(tx=>createSpace(tx,'jobs',1000),ctx)));
   const members:Record<string,FederationMember>=Object.fromEntries(sids.map((s,i)=>[i?'b':'a',{id:i?'b':'a',state:'active',target:{hostId:i?'b':'a',spaceId:s.spaceId,authorityId:'authority',dataIncarnation:s.incarnation,primaryEpoch:1}}]));
   const policy:FederationPolicy={authorityId:'authority',policyVersion:1,default:{mode:'local',member:'a'},rules:[{type:'Task',mode:'expand',by:{field:'jobId'},members:['a','b']},{type:'Result',mode:'expand',by:{field:'jobId'},members:['a','b']}],completionProfiles:[{taskType:'Task',resultTypes:['Result'],equalFields:['jobId'],maxResultCount:1,maxResultBytes:4096,maxLeaseMs:5000}]};
   const next=structuredClone(policy);next.policyVersion=2;next.completionProfiles[0]!.maxResultCount=2;
   await hosts[0]!.commit(async tx=>{const s=await tx.doc(FederationRouting,control,null);s.policy=policy;s.members=members;},ctx);
   const node=(i:number)=>new MemberLifecycle({host:hosts[i+1]!,ctx,memberId:i?'b':'a',spaceId:sids[i]!.spaceId,authorityId:'authority',peerId:i?'b':'a',signer:keys[i]!.signer,controlPin:{issuer:'control',algorithm:'ed25519',publicKey:rootKey.publicKey},assertAuthority:async()=>{},now:()=>1000});
   for(let i=0;i<2;i++)for(const action of ['prepareAdd','activate'] as const)await node(i).apply(await signMembership('instruction',{id:'add-'+i,authorityId:'authority',memberId:i?'b':'a',spaceId:sids[i]!.spaceId,action,...(action==='activate'?{policy}:{})},'control',rootKey.signer));
   const client=(i:number)=>new PhiSpaces(hosts[i+1]!,ctx,()=>1000,undefined,undefined,{space:sids[i]!.spaceId});
   await client(0).write({type:'Other',fields:{kept:true}},null,FOREVER);
   let drop:string|undefined;
   const transport:MembershipTransport={pin:async m=>({issuer:m.id,algorithm:'ed25519',publicKey:keys[m.id==='a'?0:1]!.publicKey}),apply:async(m,q)=>{const r=await node(m.id==='a'?0:1).apply(q);if(drop===q.value.action){drop=undefined;throw Error('lost committed Member reply');}return r;}};
   const make=()=>new ProfileTransitionController({host:hosts[0]!,ctx,controlSpaceId:control,authorityId:'authority',federationId:'root',journalPartitions:1,peerId:'control',signer:rootKey.signer,transport,assertAuthority:async()=>{},authorize:async()=>{}});
   const authority=()=>new FederationPolicyAuthority({host:hosts[0]!,ctx,controlSpaceId:control,authorityId:'authority',peerId:'control',signer:rootKey.signer,assertAuthority:async()=>{}});
   await assert.rejects(authority().install(next,1,async()=>{}),MigrationRequired);
   await assert.rejects(node(0).apply(await signMembership('instruction',{id:'ordinary-change',authorityId:'authority',memberId:'a',spaceId:sids[0]!.spaceId,action:'policy',policy:next},'control',rootKey.signer)),MigrationRequired);
   await make().start('change',next);const changed=structuredClone(next);changed.default.member='b';await assert.rejects(make().start('change',changed),RoutingConflict);
   await assert.rejects(authority().install({...policy,policyVersion:2},1,async()=>{}),RoutingConflict);
   const membership=new MembershipController({host:hosts[0]!,ctx,controlSpaceId:control,authorityId:'authority',peerId:'control',signer:rootKey.signer,transport,assertAuthority:async()=>{},authorize:async()=>{},hasReferences:async()=>false,hasReferencesIn:async()=>false});await assert.rejects(membership.execute('drain-a','drain',members.a!),RoutingConflict);
   for(const action of ['profileFreeze','profileInstall','profileResume']){
    drop=action;await assert.rejects(make().execute('change',next),/lost committed Member reply/);
    for(let i=0;i<hosts.length;i++){await homes[i]!.close(hosts[i]!);hosts[i]=await homes[i]!.open();}
    if(action!=='profileResume')await assert.rejects(client(0).write({type:'Other',fields:{blocked:true}}),MemberDrained);
   }
   assert.equal((await make().execute('change',next)).phase,'completed');assert.equal((await hosts[0]!.snapshot(ProfileTransitions,control,ctx))!.operations.change!.phase,'completed');
   assert.deepEqual((await authority().state()).policy,next);assert.deepEqual((await authority().state()).members,members);assert.equal(await client(0).count({type:'Other'}),1);
   for(let i=0;i<2;i++){assert.equal((await snapshotSpace(hosts[i+1]!,sids[i]!.spaceId,ctx))!.membership!.state,'active');assert.deepEqual((await snapshotSpace(hosts[i+1]!,sids[i]!.spaceId,ctx))!.completionProfiles,next.completionProfiles);}
   await client(0).write({type:'Task',fields:{jobId:'job'}},null,FOREVER);const t=await client(0).createTransaction(5000);await client(0).take({type:'Task'},0,{txn:t.id});for(let n=0;n<2;n++)await client(0).write({type:'Result',fields:{jobId:'job',n}},t.id,FOREVER);await client(0).commit(t.id);assert.equal(await client(0).count({type:'Result'}),2);
   const third=structuredClone(next);third.policyVersion=3;third.completionProfiles[0]!.maxResultCount=1;await make().start('root-checkpoints',third);
   let commits=0;while((await hosts[0]!.snapshot(ProfileTransitions,control,ctx))!.operations['root-checkpoints']!.phase!=='completed'){
    for(const fault of ['failBeforeCommit','loseAnswer'] as const){homes[0]!.faults.arm(fault);await assert.rejects(make().advance('root-checkpoints'),/injected:/);await homes[0]!.close(hosts[0]!);hosts[0]=await homes[0]!.open();}
    commits++;assert.ok(commits<=7);
   }assert.equal(commits,7);assert.deepEqual((await authority().state()).policy,third);assert.equal(await client(0).count({type:'Result'}),2);
  }finally{for(const home of homes)await home.dispose();}
 });
 test(`${backend}: profile transition rejects unsettled Root transactions and affected Member Tasks`,async()=>{
  const home=new PersistentHome(backend),memberHome=new PersistentHome(backend);try{
   const host=await home.open(),mh=await memberHome.open(),key=generateKey('ed25519','control'),mk=generateKey('ed25519','a'),control=(await host.commit(tx=>createSpace(tx,'control',1000),ctx)).spaceId,s=await mh.commit(tx=>createSpace(tx,'jobs',1000),ctx);
   const m:FederationMember={id:'a',state:'active',target:{hostId:'a',spaceId:s.spaceId,authorityId:'authority',dataIncarnation:s.incarnation,primaryEpoch:1}},policy:FederationPolicy={authorityId:'authority',policyVersion:1,default:{mode:'local',member:'a'},rules:[{type:'Task',mode:'local',member:'a'},{type:'Result',mode:'local',member:'a'}],completionProfiles:[]},next=structuredClone(policy);next.policyVersion++;next.completionProfiles=[{taskType:'Task',resultTypes:['Result'],equalFields:['jobId'],maxResultCount:1,maxResultBytes:4096,maxLeaseMs:5000}];
   await host.commit(async tx=>{const d=await tx.doc(FederationRouting,control,null);d.policy=policy;d.members={a:m};const j=await tx.doc(FederationOperations,'root',null);j.operations.begin={id:'begin',kind:'txn',phase:'done',args:{action:'begin'},principal:{peerId:'client'}} as any;},ctx);
   const node=new MemberLifecycle({host:mh,ctx,memberId:'a',spaceId:s.spaceId,authorityId:'authority',peerId:'a',signer:mk.signer,controlPin:{issuer:'control',algorithm:'ed25519',publicKey:key.publicKey},assertAuthority:async()=>{},now:()=>1000});const make=()=>new ProfileTransitionController({host,ctx,controlSpaceId:control,authorityId:'authority',federationId:'root',journalPartitions:1,peerId:'control',signer:key.signer,transport:{pin:async()=>({issuer:'a',algorithm:'ed25519',publicKey:mk.publicKey}),apply:async(_,q)=>node.apply(q)},assertAuthority:async()=>{},authorize:async()=>{}});
   await assert.rejects(make().start('change',next),/Root work must settle/);assert.equal(Object.keys((await host.snapshot(ProfileTransitions,control,ctx))?.operations??{}).length,0);
   await host.commit(async tx=>{(await tx.doc(FederationOperations,'root',null)).operations.finish={id:'finish',kind:'txn',phase:'done',args:{action:'abort',originId:'begin'}} as any;},ctx);
   for(const action of ['prepareAdd','activate'] as const)await node.apply(await signMembership('instruction',{id:'add-a',authorityId:'authority',memberId:'a',spaceId:s.spaceId,action,...(action==='activate'?{policy}:{})},'control',key.signer));
   const client=new PhiSpaces(mh,ctx,()=>1000,undefined,undefined,{space:s.spaceId});await client.write({type:'Task',fields:{jobId:'job'}},null,FOREVER);await assert.rejects(make().execute('change',next),/no affected Tasks/);assert.equal((await host.snapshot(ProfileTransitions,control,ctx))!.operations.change!.phase,'freezing');assert.equal((await snapshotSpace(mh,s.spaceId,ctx))!.membership!.state,'active');
   await client.take({type:'Task'},0);assert.equal((await make().execute('change',next)).phase,'completed');
  }finally{await home.dispose();await memberHome.dispose();}
 });
}
