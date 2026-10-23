// Real process death and reopen; simulated RPC identity, not overlay or power-loss proof.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {StoreFaults} from '../../../src/store/sqlite.ts';
import {BACKGROUND_CONTEXT as ctx} from '../../../src/context.ts';
import {PhiSpaces,argHash,rpcDomain,core,Registry,spaceDoc,SpaceService,StaticIdentity,FederatedSpace,FederationPending,
 RouterController,RouterJournal,partitionRouterId,type RouterStep,type RouterReceipt,type RouterTarget,
 type FederationIO,type RoutingState,OwnSyncStore,type OwnStoreHost} from '../../../src/index.ts';

const boundaries=['candidate','winner','completed','ack','rpc'] as const;
const phases=['before','after'] as const;
const principal={peerId:'process-crash-fixture'},now=()=>100000,id='retained-race';
const [mode,home,backend,boundary,phase]=process.argv.slice(2);
if(!mode){
 const dir=mkdtempSync(join(tmpdir(),'pi-process-crashes-')),cases=[];
 try{
  for(const b of ['own-sqlite'])for(const point of boundaries)for(const edge of phases){
   const path=join(dir,`${b}-${point}-${edge}`);mkdirSync(path);
   const run=(m:string)=>spawnSync(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),m,path,b,point,edge],{encoding:'utf8',timeout:60000,maxBuffer:2**20});
   for(const m of ['prepare','crash','recover','verify']){
    const r=run(m);assert.ifError(r.error);
    if(m==='crash'){assert.equal(r.signal,'SIGKILL',r.stderr);assert.equal(r.status,null);}
    else assert.equal(r.status,0,`${b}/${point}/${edge}/${m}: ${r.stderr}\n${r.stdout}`);
   }
   const killed=JSON.parse(readFileSync(join(path,'killed.json'),'utf8'));
   assert.equal(killed.boundary,point);assert.equal(killed.phase,edge);
   cases.push({backend:b,boundary:point,phase:edge,signal:'SIGKILL',...JSON.parse(readFileSync(join(path,'verified.json'),'utf8'))});
   console.log(JSON.stringify({stage:'case',...cases.at(-1)}));
  }
  console.log(JSON.stringify({passed:true,cases:cases.length,transport:'in-process',clock:'fixed',overlay:false,powerLoss:false,results:cases}));
 }finally{rmSync(dir,{recursive:true,force:true});}
}else{
 assert.ok(['prepare','crash','recover','verify'].includes(mode));assert.ok(home);assert.ok(['own-sqlite'].includes(backend!));
 assert.ok(boundaries.includes(boundary as any));assert.ok(phases.includes(phase as any));
 const hosts=new Map<string,OwnStoreHost>();
 const kill=()=>{writeFileSync(join(home!,'killed.json'),JSON.stringify({boundary,phase}));process.kill(process.pid,'SIGKILL');throw Error('SIGKILL returned');};
 // The root's store stops the process at the selected boundary: the commit that records the candidate, the winner or the
 // completed operation (its federation-operations document compared with the stored head); before it or once durable.
 const open=async(name:string):Promise<OwnStoreHost>=>{
  const path=join(home!,name);mkdirSync(path,{recursive:true});
  if(name!=='root'||mode!=='crash'||!['candidate','winner','completed'].includes(boundary!))return new OwnSyncStore(join(path,'space.sqlite')).openHost();
  const matches=(v:string)=>v.includes('"operations"')&&(boundary==='candidate'?v.includes('"candidates"')&&v.includes('"event"')&&!v.includes('"winner"'):boundary==='winner'?v.includes('"winner"')&&!v.includes('"phase":"done"'):v.includes('"phase":"done"'));
  let store:OwnSyncStore,armed=false;
  const faults:StoreFaults={
   take:ops=>{
    for(const op of ops)if(op.t==='doc'&&op.kind==='phi-spaces.federation-operations'){const before=store.head(op.kind,op.key);if(matches(op.value)&&!matches(JSON.stringify(before??{})))armed=true;}
    if(armed&&phase==='before')kill();
    return undefined;
   },
   written:()=>{if(armed)kill();},
  };
  store=new OwnSyncStore(join(path,'space.sqlite'),{faults});
  return store.openHost();
 };
 try{
  for(const name of ['root','a','b','c'])hosts.set(name,await open(name));
  const client=(name:string)=>new PhiSpaces(hosts.get(name)!,ctx,now,undefined,undefined,{authorityId:'authority-1'});
  const targets=Object.fromEntries(['a','b','c'].map(name=>[name,{hostId:name,spaceId:'space-'+name,authorityId:'authority-1',dataIncarnation:'inc-'+name,primaryEpoch:1}]));
  if(mode==='prepare')for(const name of ['a','b','c'])await hosts.get(name)!.commit(async tx=>{
   const s=await spaceDoc(tx,undefined,now()),r=await tx.doc(Registry),t=targets[name]!;
   r.hostId=name;r.hostKey='fixture-key-'+name;r.defaultSpaceId=t.spaceId;r.aliases={default:t.spaceId};
   r.spaces={[t.spaceId]:{spaceId:t.spaceId,alias:'default',incarnation:t.dataIncarnation,createdAt:now()}};
   s.spaceId=t.spaceId;s.incarnation=t.dataIncarnation;s.primaryEpoch=1;
  },ctx);
  const services=Object.fromEntries(['a','b','c'].map(name=>[name,new SpaceService({host:hosts.get(name)!,ctx,identity:new StaticIdentity({[principal.peerId]:{principal,roles:['admin']}}),hostId:name,authorityId:'authority-1',primaryEpoch:1,now,maxPollMs:1,authorize:async call=>({validUntil:core.FOREVER,roles:['admin'],canExecutePending:()=>true,check:()=>{},allowClosedWaiter:call.method==='lease'&&call.args?.action==='cancel'&&!!call.frame?.delegation})})]));
  const receipt=(s:Readonly<RouterStep>,view:any):RouterReceipt=>({target:structuredClone(s.target),principal:structuredClone(s.principal),method:s.method,generation:s.generation,requestId:s.requestId,argHash:s.argHash,
   outcome:view.state==='notAdmitted'?'notAdmitted':view.error?'failed':view.state==='done'?'done':view.state==='cancelled'?'cancelled':'pending',...(view.result===undefined?{}:{result:view.result}),...(view.error?{evidence:view.error.code}:{})});
  // Resolve through the exact wire domain, including waiter registration and lease arguments.
  const target:RouterTarget={protocol:'phi-spaces-rpc-v1',resolve:async s=>{const d=rpcDomain({method:s.method,args:s.args as any},s.principal);return receipt(s,await client(s.target.hostId).resolveOperation({principal:s.principal,generation:s.generation,requestId:s.requestId},d.method,argHash(d.method,d.args),s.target.primaryEpoch));},invoke:async s=>{
   const r=await services[s.target.hostId]!.handle({method:s.method,space:s.target.spaceId,request:{generation:s.generation,requestId:s.requestId},frame:{authorityId:s.target.authorityId,primaryEpoch:s.target.primaryEpoch,...(s.targetRequest?{delegation:{} as core.Json}:{})},args:s.args},{peerId:principal.peerId});
   assert.equal(r.ok,true,JSON.stringify(r));return receipt(s,await client(s.target.hostId).pollOperation({principal:s.principal,generation:s.generation,requestId:s.requestId}));
  }};
  const state:RoutingState={policy:{authorityId:'authority-1',policyVersion:1,default:{mode:'local',member:'a'},completionProfiles:[],rules:[{type:'Job',mode:'expand',by:'capacity',members:['a','b','c']}]},members:Object.fromEntries(['a','b','c'].map((name,n)=>[name,{id:name,target:targets[name]!,state:'active',capacity:{free:10-n,at:now()}}]))};
  const io:FederationIO={step:async(member,p,method,args,policyVersion,origin)=>({target:targets[member]!,principal:p,generation:(await client(member).issueGeneration(p)).generation,method,args,policyVersion,...(origin?{targetRequest:{requestId:origin.requestId,requestGeneration:origin.generation,method:origin.method,argumentHash:origin.argHash,policyVersion:policyVersion!}}:{})}),
   snapshot:async(member,_p,template,txn)=>({entries:await client(member).readAll(template,{txn}),revision:0}),
   events:async(member,p)=>{const page=await client(member).events(p);return{epoch:page.mailboxEpoch,events:page.events,gap:!!page.gap};},
   ack:async(member,p,epoch,seq)=>{if(mode==='crash'&&boundary==='ack'&&phase==='before')kill();await client(member).ack(p,epoch,seq);if(mode==='crash'&&boundary==='ack')kill();},
   txnActive:async(member,_p,txn)=>{const s=await hosts.get(member)!.commit(async tx=>core.plain(await spaceDoc(tx,undefined,now())),ctx);return !!s?.txns[txn]&&s.txns[txn]!.expires>now();}};
  const options={host:hosts.get('root')!,ctx,authorityId:'authority-1',target,assertAuthority:async()=>{},now,
   checkpoint:async(point:'beforeSend'|'afterReply')=>{if(mode==='crash'&&boundary==='rpc'&&point===(phase==='before'?'beforeSend':'afterReply'))kill();}};
  const router=new RouterController({...options,routerId:'federated-router'}),partitionRouters=Array.from({length:8},(_,n)=>new RouterController({...options,routerId:partitionRouterId('federation',n)}));
  for(const r of [router,...partitionRouters])await r.recover();
  const f=new FederatedSpace({host:hosts.get('root')!,ctx,id:'federation',router,journalPartitions:8,partitionRouters,state:async()=>state,io,assertAuthority:async()=>{},now});await f.initializeJournals();
  const retainedSteps=async()=>{const retained:Record<string,unknown>={};for(const r of partitionRouters){const journal=await hosts.get('root')!.snapshot(RouterJournal,r.journalId,ctx);for(const commandId of Object.keys(journal?.refs??{})){const command=(await r.get(commandId))!;retained[commandId]=command.steps.map(s=>({target:s.target,principal:s.principal,generation:s.generation,requestId:s.requestId,method:s.method,argHash:s.argHash,args:s.args,targetRequest:s.targetRequest??null}));}}return retained;};
  if(mode==='prepare'){
   await assert.rejects(f.takeWaiting({type:'Job'},10000,5000,{id,principal}),FederationPending);
   for(const member of ['a','b','c'])await client(member).write({type:'Job',fields:{member}});
   writeFileSync(join(home!,'retained-requests.json'),JSON.stringify(await retainedSteps()));
  }else{
   let result:any;for(let attempt=0;attempt<6;attempt++){try{result=await f.resume(id);break;}catch(error){if(!(error instanceof FederationPending)||mode==='crash')throw error;}}assert.ok(result,'bounded same-Parent recovery did not finish');assert.equal(result.fields.member,'a');
   if(mode==='crash')throw Error('selected crash boundary was not reached');
   if(mode==='recover')writeFileSync(join(home!,'result.json'),JSON.stringify(result));
   else assert.deepEqual(result,JSON.parse(readFileSync(join(home!,'result.json'),'utf8')));
   const original=JSON.parse(readFileSync(join(home!,'retained-requests.json'),'utf8')),current=await retainedSteps();
   assert.ok(Object.keys(original).length>=3);for(const [commandId,steps] of Object.entries(original))assert.deepEqual(current[commandId],steps,'retained target/request identity changed');
   let entries=0;
   for(const member of ['a','b','c']){const s=await hosts.get(member)!.commit(async tx=>core.plain(await spaceDoc(tx,undefined,now())),ctx);entries+=await client(member).count();assert.equal(Object.keys(s!.txns).length,0);assert.equal((await client(member).events(principal)).events.length,0);}
   assert.equal(entries,2,'one winner consumed, two losers returned');
   for(const r of partitionRouters)assert.deepEqual((await hosts.get('root')!.snapshot(RouterJournal,r.journalId,ctx))?.future??{},{});
   if(mode==='verify')writeFileSync(join(home!,'verified.json'),JSON.stringify({winner:'a',retainedEntries:entries,transactions:0,mailboxEvents:0,futureReservations:0,replayStable:true,originalRequestsPreserved:true}));
  }
 }finally{for(const h of hosts.values())await h.close(ctx);}
}
