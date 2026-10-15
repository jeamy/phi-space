import assert from 'node:assert/strict';
import test from 'node:test';

import {PiSpaces} from './src/client.ts';
import {Space} from './src/doc.ts';
import {TransportFailure} from './src/remote.ts';
import {PermissionError} from './src/core.ts';
import {createSpace} from './src/spaces.ts';
import {
    FederatedSpace,
    type FederationIO,
    FederationPending,
    FederationUnavailable
} from './src/federated-space.ts';
import {FederationJournalLayout,operationPartition,parentJournalKey,partitionRouterId} from './src/federation-journals.ts';
import {memberReferencesIn} from './src/federation-references.ts';
import {FederationOperations} from './src/federated-space.ts';
import {RouterController,RouterJournal,type RouterLimits} from './src/router.ts';
import {RoutingConflict, type RoutingState} from './src/routing-semantics.ts';
import {FederationSimulator} from './test/support/federation-simulator.ts';
import {BACKENDS, ctx, PersistentHome} from './test/support/persistent.ts';

const principal = {
    peerId : 'client',
    agentId : 'worker'
};
async function fixture(b: typeof BACKENDS[number], fn: (o: any) => Promise<void>, partitions=1,limits:Partial<RouterLimits>={}) {
    const sim = new FederationSimulator(b), home = new PersistentHome(b);
    try {
        await sim.add('a');
        await sim.add('b');
        if(partitions>1)await sim.add('c');
        let host = await home.open();
        const controlId=(await host.commit(tx=>createSpace(tx,"test-control",1000),ctx)).spaceId;
        const first = await sim.step('a', 'read', {});
        const p = first.principal;
        const state: RoutingState = {
            policy : {
                authorityId : 'authority-1',
                policyVersion : 1,
                default : {mode : 'local', member : 'a'},
                completionProfiles : [],
                rules : [ {type : 'Job', mode : 'expand', by : 'capacity', members : partitions>1?[ 'a', 'b', 'c' ]:[ 'a', 'b' ]} ]
            },
            members : Object.fromEntries([...sim.nodes ].map(
                ([ id, n ]) => [id, {
                    id,
                    target : n.binding,
                    state : 'active',
                    capacity : {free : id === 'a' ? 10 : 5, at : sim.clock.now('a')}
                }]))
        };
        const options = () => ({
            host,
            ctx,
            routerId : 'federated-router',
            authorityId : 'authority-1',
            target : sim,
            assertAuthority : async () => {},limits
        });
        let router = new RouterController(options());
        let partitionRouters=partitions===1?[router]:Array.from({length:partitions},(_,n)=>new RouterController({...options(),routerId:partitionRouterId('federation',n)}));
        for(const r of new Set([router,...partitionRouters]))await r.recover();
        const unavailable = new Set<string>();
        const io: FederationIO = {
            step : async (id, principal, method, args, policyVersion, origin) => {
                assert.deepEqual(principal, p);
                return {
                    ...await sim.step(id, method, args),
                    policyVersion,
                    ...(origin ? {
                        targetRequest : {
                            requestId : origin.requestId,
                            requestGeneration : origin.generation,
                            method : origin.method,
                            argumentHash : origin.argHash,
                            policyVersion : policyVersion!
                        }
                    }
                               : {})
                };
            },
            snapshot : async (id, _p, t, txn) => {
                if (unavailable.has(id))
                    throw Error('partition');
                const n = sim.nodes.get(id)!;
                return {
                    entries :
                        await new PiSpaces(n.host, ctx, () => sim.clock.now(id)).readAll(t, {txn}),
                    revision : (await n.host.snapshot(Space, ctx))!.rev
                };
            },
            events : async (id, p) => {
                const n = sim.nodes.get(id)!,
                      page = await new PiSpaces(n.host, ctx, () => sim.clock.now(id)).events(p);
                return {epoch : page.mailboxEpoch, events : page.events, gap : !!page.gap};
            },
            ack : async (id, p, e, s) => {
                await new PiSpaces(sim.nodes.get(id)!.host, ctx, () => sim.clock.now(id))
                    .ack(p, e, s);
            },
            txnActive : async (id, _p, t) => {
                const s = await sim.nodes.get(id)!.host.snapshot(Space, ctx);
                return !!s?.txns[t] && s.txns[t]!.expires > sim.clock.now(id);
            }
        };
        const make = () => new FederatedSpace({
            host,
            ctx,
            id : 'federation',
            router,
            journalPartitions:partitions,
            partitionRouters,
            state : async () => state,
            io,
            assertAuthority : async () => {},
            now : () => sim.clock.now('a')
        });
        let f = make();
        await f.initializeJournals();
        await fn({
            sim,
            home,
            controlId,
            state,
            p,
            io,
            unavailable,
            get host() {return host;},
            get partitionRouters(){return partitionRouters;},
            makeWith:(n:number)=>new FederatedSpace({host,ctx,id:"federation",router,journalPartitions:n,partitionRouters:Array.from({length:n},(_,i)=>new RouterController({...options(),routerId:partitionRouterId("federation",i)})),state:async()=>state,io,assertAuthority:async()=>{}}),
            get f() { return f; },
            reopen : async (beforeRecovery?:(host:any)=>Promise<void>) => {
                home.crash(host);
                host = await home.open();
                await beforeRecovery?.(host);
                router = new RouterController(options());
                partitionRouters=partitions===1?[router]:Array.from({length:partitions},(_,n)=>new RouterController({...options(),routerId:partitionRouterId('federation',n)}));
                for(const r of new Set([router,...partitionRouters]))await r.recover();
                f = make();await f.initializeJournals();
            }
        });
    } finally {
        await home.dispose();
        await sim.dispose();
    }
}
for (const b of BACKENDS) {
    test(`${b}: unknown take never reaches next Member; replay and Root reopen preserve winner`,
         () => fixture(b, async o => {
             await o.sim.seed('a', {n : 1});
             await o.sim.seed('b', {n : 2});
             o.sim.fault('a', {dropReply : true});
             await assert.rejects(o.f.take({type : 'Job'}, {id : 'take-1', principal : o.p}),
                                  FederationPending);
             assert.equal(
                 (await new PiSpaces(o.sim.nodes.get('b').host, ctx, () => o.sim.clock.now('a'))
                      .count()),
                 1);
             await o.reopen();
             const r = await o.f.resume('take-1');
             assert.equal(r.fields.n, 1);
             assert.deepEqual(await o.f.take({type : 'Job'}, {id : 'take-1', principal : o.p}), r);
             assert.equal(
                 await new PiSpaces(o.sim.nodes.get('b').host, ctx, () => o.sim.clock.now('a'))
                     .count(),
                 1);
         }));
    test(`${b}: confirmed miss advances; complete/partial snapshots and Txn binding`,
         () => fixture(b, async o => {
             await o.sim.seed('b', {n : 2});
             assert.equal(
                 (await o.f.take({type : 'Job'}, {id : 'take-2', principal : o.p})).fields.n, 2);
             await o.sim.seed('a', {n : 3});
             o.unavailable.add('b');
             await assert.rejects(o.f.readAll({type : 'Job'}, o.p), FederationUnavailable);
             const r = await o.f.readAll({type : 'Job'}, o.p, {allowPartial : true});
             assert.equal(r.complete, false);
             assert.deepEqual(r.missingMembers, [ 'b' ]);
             assert.equal(r.entries.length, 1);
             await assert.rejects(
                 o.f.take({type : 'Job'},
                          {id : 'cross', principal : o.p, txn : {member : 'a', id : 't'}}),
                 RoutingConflict);
         }));
    test(`${b}: selected capacity placement remains fixed on unknown outcome`,
         () => fixture(b, async o => {
             o.sim.fault('a', {dropReply : true});
             const e = {type : 'Job', fields : {n : 9}};
             await assert.rejects(o.f.write(e, {id : 'write-1', principal : o.p}),
                                  FederationPending);
             o.state.members.a.capacity.free = 1;
             o.state.members.b.capacity.free = 100;
             await o.reopen();
             await o.f.resume('write-1');
             assert.equal(
                 await new PiSpaces(o.sim.nodes.get('a').host, ctx, () => o.sim.clock.now('a'))
                     .count(),
                 1);
             assert.equal(
                 await new PiSpaces(o.sim.nodes.get('b').host, ctx, () => o.sim.clock.now('a'))
                     .count(),
                 0);
             await assert.rejects(
                 o.f.write({type : 'Job', fields : {n : 99}}, {id : 'write-1', principal : o.p}),
                 RoutingConflict);
         }));
    test(`${b}: waiting take does not cancel registrations before a winner`,
         () => fixture(b, async o => {
             await assert.rejects(
                 o.f.takeWaiting({type : 'Job'}, 10000, 5000, {id : 'race-1', principal : o.p}),
                 FederationPending);
             for (const n of o.sim.nodes.values())
                 assert.equal((await n.host.snapshot(Space, ctx)).waiters.length, 1);
             await o.reopen();
             await assert.rejects(o.f.resume('race-1'), FederationPending);
         }));
}

for (const b of BACKENDS)
    test(`${b}: two real waiter reservations produce one committed winner and one returned loser`,
         () => fixture(b, async o => {
             await assert.rejects(
                 o.f.takeWaiting({type : 'Job'}, 10000, 5000, {id : 'race-win', principal : o.p}),
                 FederationPending);
             await new PiSpaces(o.sim.nodes.get('a').host, ctx, () => o.sim.clock.now('a'))
                 .write({type : 'Job', fields : {n : 1}});
             await new PiSpaces(o.sim.nodes.get('b').host, ctx, () => o.sim.clock.now('b'))
                 .write({type : 'Job', fields : {n : 2}});
             const result = await o.f.resume('race-win');
             assert.equal(result.fields.n, 1);
             assert.equal(
                 await new PiSpaces(o.sim.nodes.get('a').host, ctx, () => o.sim.clock.now('a'))
                     .count(),
                 0);
             assert.equal(
                 await new PiSpaces(o.sim.nodes.get('b').host, ctx, () => o.sim.clock.now('b'))
                     .count(),
                 1);
             await o.reopen();
             assert.deepEqual(await o.f.resume('race-win'), result);
         }));

for (const b of BACKENDS)
    test(`${b}: lost winner commit response survives reopen without choosing another candidate`,
         () => fixture(b, async o => {
             await assert.rejects(
                 o.f.takeWaiting({type : 'Job'}, 10000, 5000, {id : 'race-lost', principal : o.p}),
                 FederationPending);
             for (const id of ['a', 'b'])
                 await new PiSpaces(o.sim.nodes.get(id).host, ctx, () => o.sim.clock.now(id))
                     .write({type : 'Job', fields : {member : id}});
             o.sim.fault('a', {dropReply : true});
             await assert.rejects(o.f.resume('race-lost'), FederationPending);
             await o.reopen();
             const r = await o.f.resume('race-lost');
             assert.equal(r.fields.member, 'a');
             assert.equal(
                 await new PiSpaces(o.sim.nodes.get('b').host, ctx, () => o.sim.clock.now('b'))
                     .count(),
                 1);
         }));

for (const b of BACKENDS)
    test(`${b}: transaction origin binds member, principal and finish request ID`,
         () => fixture(b, async o => {
             const txn = await o.f.createTransaction('a', 5000, {id : 'txn-1', principal : o.p});
             await o.f.write({type : 'Other', fields : {n : 1}},
                             {id : 'txn-write', principal : o.p, txn});
             assert.equal(
                 await new PiSpaces(o.sim.nodes.get('a').host, ctx, () => o.sim.clock.now('a'))
                     .count(),
                 0);
             await o.f.finishTransaction('txn-1', 'commit', {id : 'txn-finish', principal : o.p});
             assert.equal(
                 await new PiSpaces(o.sim.nodes.get('a').host, ctx, () => o.sim.clock.now('a'))
                     .count(),
                 1);
             await assert.rejects(
                 o.f.finishTransaction('txn-1', 'abort', {id : 'txn-finish', principal : o.p}),
                 RoutingConflict);
             await assert.rejects(
                 o.f.write({type : 'Other', fields : {n : 2}},
                           {id : 'foreign-txn', principal : {peerId : 'foreign'}, txn}),
                 RoutingConflict);
         }));

for(const b of BACKENDS)test(`${b}: waiting read returns a late entry without reserving or consuming it`,()=>fixture(b,async o=>{await assert.rejects(o.f.readWaiting({type:'Job'},10000,{id:'read-wait',principal:o.p}),FederationPending);await new PiSpaces(o.sim.nodes.get('b').host,ctx,()=>o.sim.clock.now('b')).write({type:'Job',fields:{n:7}});assert.equal((await o.f.resume('read-wait')).fields.n,7);assert.equal(await new PiSpaces(o.sim.nodes.get('b').host,ctx,()=>o.sim.clock.now('b')).count(),1);assert.equal(Object.keys((await o.sim.nodes.get('b').host.snapshot(Space,ctx)).txns).length,0);}));

for(const b of BACKENDS)test(`${b}: restored child and completed parent require review after target update`,async()=>fixture(b,async(o:any)=>{
 const q={id:"restore-parent",principal:o.p};await o.f.write({type:"Job",fields:{n:1}},q);
 const t={...o.state.members.a.target};o.state.members.a.target.dataIncarnation="restored";
 assert.deepEqual(await o.f.reconcileDataRestore({hostId:t.hostId,spaceId:t.spaceId,oldIncarnation:t.dataIncarnation,recoveryId:"restore-all"}),[q.id]);
 await assert.rejects(o.f.write({type:"Job",fields:{n:1}},q),/review/i);
}));

for(const b of BACKENDS)test(`${b}: bounded composite history denies admission without sending another effect`,async()=>fixture(b,async(o:any)=>{
 for(let n=0;n<16;n++)await o.f.write({type:'Job',fields:{n}},{id:'history-'+n,principal:o.p});
 await assert.rejects(o.f.write({type:'Job',fields:{n:16}},{id:'history-16',principal:o.p}),/history full/);
 const snapshot=await o.f.readAll({type:'Job'},o.p);assert.equal(snapshot.entries.length,16);
 await o.reopen();await o.f.write({type:'Job',fields:{n:0}},{id:'history-0',principal:o.p});
 assert.equal((await o.f.readAll({type:'Job'},o.p)).entries.length,16,'known ID resolves from durable history');
}));

for(const b of BACKENDS) {
 test(`${b}: partitioned history accepts 1000 fixed operations on three Members and retains retries after reopen`,()=>fixture(b,async o=>{
  for(let n=0;n<1000;n++) {
   for(const [i,id] of ['a','b','c'].entries())o.state.members[id].capacity.free=i===n%3?100:1;
   await o.f.write({type:'Job',fields:{n}},{id:'partition-load-'+n,principal:o.p});
  }
  assert.equal((await o.f.readAll({type:'Job'},o.p)).entries.length,1000);
  for(const id of ['a','b','c'])assert.ok(await new PiSpaces(o.sim.nodes.get(id).host,ctx,()=>o.sim.clock.now(id)).count()>300);
  await o.reopen();
  for(const n of [0,1,17,999])await o.f.write({type:'Job',fields:{n}},{id:'partition-load-'+n,principal:o.p});
  assert.equal((await o.f.readAll({type:'Job'},o.p)).entries.length,1000);
  await assert.rejects(o.f.write({type:'Job',fields:{n:9999}},{id:'partition-load-0',principal:o.p}),RoutingConflict);
  await assert.rejects(o.makeWith(128).initializeJournals(),/topology differs/);
  let total=0;for(let n=0;n<256;n++) {
   const d=await o.host.snapshot(FederationOperations,parentJournalKey('federation',256,n),ctx);
   if(d){assert.ok(Object.keys(d.operations).length<=16);assert.equal(d.reservedBytes,Object.keys(d.operations).length*128*1024);total+=Object.keys(d.operations).length;}
  }
  assert.equal(total,1000);
 },256));
 test(`${b}: cross-partition transaction origin and Root removal references remain bound`,()=>fixture(b,async o=>{
  const origin='partition-txn';let finish='partition-finish';while(operationPartition(origin,8)===operationPartition(finish,8))finish+='x';
  const txn=await o.f.createTransaction('a',5000,{id:origin,principal:o.p});
  const refs=()=>o.host.commit((tx:any)=>memberReferencesIn(tx,{controlSpaceId:o.controlId,routerId:'federated-router',federationId:'federation'},'a',o.state.members.a.target.spaceId),ctx);
  assert.equal(await refs(),true);
  await o.f.write({type:'Other',fields:{n:1}},{id:'partition-txn-write',principal:o.p,txn});
  await o.f.finishTransaction(origin,'commit',{id:finish,principal:o.p});
  assert.equal(await refs(),false);
  await o.reopen();await o.f.finishTransaction(origin,'commit',{id:finish,principal:o.p});
  assert.equal(await new PiSpaces(o.sim.nodes.get('a').host,ctx,()=>o.sim.clock.now('a')).count(),1);
 },8));
 test(`${b}: a full partition rejects new work while other partitions and known IDs still work`,()=>fixture(b,async o=>{
  const ids:string[]=[];for(let n=0;ids.length<17;n++)if(operationPartition('full-'+n,2)===0)ids.push('full-'+n);
  for(const id of ids.slice(0,16))await o.f.write({type:'Job',fields:{id}},{id,principal:o.p});
  await assert.rejects(o.f.write({type:'Job',fields:{id:ids[16]}},{id:ids[16],principal:o.p}),/history full/);
  let independent='other';while(operationPartition(independent,2)===0)independent+='x';
  await o.f.write({type:'Job',fields:{id:independent}},{id:independent,principal:o.p});
  await o.reopen();await o.f.write({type:'Job',fields:{id:ids[0]}},{id:ids[0],principal:o.p});
  assert.equal((await o.f.readAll({type:'Job'},o.p)).entries.length,17);
 },2));
 test(`${b}: existing legacy IDs cannot disappear behind a new partition topology`,()=>fixture(b,async o=>{
  await o.f.write({type:'Job',fields:{n:1}},{id:'legacy',principal:o.p});
  await assert.rejects(o.makeWith(2).initializeJournals(),/topology differs/);
  await o.host.commit(async(tx:any)=>{const d=await tx.doc(FederationJournalLayout,'federation',null);d.partitions=null;d.routerIds=null;},ctx);
  await assert.rejects(o.makeWith(2).initializeJournals(),/legacy history/);
  await o.f.write({type:'Job',fields:{n:1}},{id:'legacy',principal:o.p});
  assert.equal((await o.f.readAll({type:'Job'},o.p)).entries.length,1);
 }));
 for(const fault of ['failBeforeCommit','loseAnswer'] as const)
 test(`${b}: interrupted partition restore ${fault} fences all parents until replay completes`,()=>fixture(b,async o=>{
  for(let n=0;n<20;n++)await o.f.write({type:'Job',fields:{n}},{id:'restore-partition-'+n,principal:o.p});
  const target=o.state.members.a.target;
  const restore={hostId:target.hostId,spaceId:target.spaceId,oldIncarnation:target.dataIncarnation,recoveryId:'restore-partitions'};
  let count=0;o.home.faults.arm(fault,(writes:any[])=>writes.some(w=>w.type==='document.change' && w.content.kind==='delta' && JSON.stringify(w.content.ops).includes('"operations"'))&&++count===2);
  await assert.rejects(o.f.reconcileDataRestore(restore));assert.equal(o.home.faults.fired,1);
  await o.reopen();
  await assert.rejects(o.f.write({type:'Job',fields:{n:0}},{id:'restore-partition-0',principal:o.p}),/reconciliation is incomplete/);
  await assert.rejects(o.f.write({type:'Job',fields:{n:21}},{id:'new-during-review',principal:o.p}),/reconciliation is incomplete/);
  assert.equal((await o.host.snapshot(FederationJournalLayout,'federation',ctx)).reconciliation.recoveryId,restore.recoveryId);
  assert.equal((await o.f.reconcileDataRestore(restore)).length,20);
  await assert.rejects(o.f.write({type:'Job',fields:{n:0}},{id:'restore-partition-0',principal:o.p}),/review/);
 },8));
}

for(const b of BACKENDS)test(`${b}: lost partitioned effect reply recovers the same child without selecting a new Member`,()=>fixture(b,async o=>{
 o.sim.fault('a',{dropReply:true});
 const request={id:'partition-lost',principal:o.p},entry={type:'Job',fields:{n:1}};
 await assert.rejects(o.f.write(entry,request),FederationPending);
 o.state.members.a.capacity.free=1;o.state.members.b.capacity.free=100;
 await o.reopen();await o.f.write(entry,request);
 assert.equal(await new PiSpaces(o.sim.nodes.get('a').host,ctx,()=>o.sim.clock.now('a')).count(),1);
 assert.equal(await new PiSpaces(o.sim.nodes.get('b').host,ctx,()=>o.sim.clock.now('b')).count(),0);
},8));

for(const b of BACKENDS)for(const boundary of ['candidate','winner','completed','ack'] as const)for(const fault of ['failBeforeCommit','loseAnswer'] as const)
 test(`${b}: race ${boundary} ${fault} reopens with one winner and releases future reservations`,()=>fixture(b,async o=>{
  const id='race-boundary';await assert.rejects(o.f.takeWaiting({type:'Job'},10000,5000,{id,principal:o.p}),FederationPending);
  for(const member of ['a','b'])await new PiSpaces(o.sim.nodes.get(member).host,ctx,()=>o.sim.clock.now(member)).write({type:'Job',fields:{member}});
  let fired=false;const ack=o.io.ack;
  if(boundary==='ack')o.io.ack=async(...args:any[])=>{if(!fired&&fault==='failBeforeCommit'){fired=true;throw new Error('injected before ACK');}await ack(...args);if(!fired){fired=true;throw new Error('injected lost ACK reply');}};
  else o.home.faults.arm(fault,(writes:any[])=>writes.some(w=>w.type==='document.change'&&w.content.kind==='delta'&&JSON.stringify(w.content.ops).includes('"operations"')&&(boundary==='candidate'?JSON.stringify(w.content.ops).includes('"candidates"')&&JSON.stringify(w.content.ops).includes('"event"')&&!JSON.stringify(w.content.ops).includes('"winner"'):boundary==='winner'?JSON.stringify(w.content.ops).includes('"winner"')&&!JSON.stringify(w.content.ops).includes('"done"'):JSON.stringify(w.content.ops).includes('"phase":"done"'))));
  await assert.rejects(o.f.resume(id));assert.ok(fired||o.home.faults.fired===1,'the selected boundary must be interrupted');
  o.io.ack=ack;await o.reopen();const result=await o.f.resume(id);assert.equal(result.fields.member,'a');
  await o.reopen();assert.deepEqual(await o.f.resume(id),result);
  let entries=0;for(const member of ['a','b']){const h=o.sim.nodes.get(member).host;entries+=await new PiSpaces(h,ctx,()=>o.sim.clock.now(member)).count();assert.equal(Object.keys((await h.snapshot(Space,ctx)).txns).length,0);}
  assert.equal(entries,1,'exactly one committed winner and one returned loser');
  for(const r of o.partitionRouters){const journal=await o.host.snapshot(RouterJournal,r.journalId,ctx);assert.deepEqual(journal?.future??{},{});}
 },8));

for(const b of BACKENDS){
 test(`${b}: transport loss preparing a child retains the admitted Parent for same-ID recovery`,()=>fixture(b,async o=>{
  const step=o.io.step,request={id:'prepare-outage',principal:o.p},entry={type:'Job',fields:{n:1}};
  o.io.step=async()=>{throw new TransportFailure('Member unavailable during proof/generation');};
  await assert.rejects(o.f.write(entry,request),(e:any)=>e instanceof FederationPending&&e.requestId===request.id);
  const key=parentJournalKey('federation',8,operationPartition(request.id,8));
  const parent=(await o.host.snapshot(FederationOperations,key,ctx)).operations[request.id];
  assert.equal(parent.phase,'admitting');assert.deepEqual(parent.members,['a']);assert.deepEqual(parent.children,{});
  assert.equal(await new PiSpaces(o.sim.nodes.get('a').host,ctx,()=>o.sim.clock.now('a')).count(),0);
  await assert.rejects(o.f.write({...entry,fields:{n:2}},request),RoutingConflict);
  o.state.members.a.capacity.free=1;o.state.members.b.capacity.free=100;
  await o.reopen();o.io.step=step;await o.f.write(entry,request);await o.f.write(entry,request);
  assert.equal(await new PiSpaces(o.sim.nodes.get('a').host,ctx,()=>o.sim.clock.now('a')).count(),1);
  assert.equal(await new PiSpaces(o.sim.nodes.get('b').host,ctx,()=>o.sim.clock.now('b')).count(),0);
  const done=(await o.host.snapshot(FederationOperations,key,ctx)).operations[request.id];assert.equal(done.phase,'done');assert.deepEqual(done.targets,parent.targets);assert.equal(done.hash,parent.hash);
  for(const router of o.partitionRouters)assert.deepEqual((await o.host.snapshot(RouterJournal,router.journalId,ctx))?.future??{},{});
 },8));
 test(`${b}: child preparation does not turn authority or adapter errors into pending retries`,()=>fixture(b,async o=>{
  for(const [id,error] of [['denied',new PermissionError('revoked')],['adapter',new Error('invalid adapter')]] as const){
   o.io.step=async()=>{throw error;};await assert.rejects(o.f.write({type:'Job',fields:{id}},{id,principal:o.p}),(e:any)=>e===error);
  }
 }));
}

for(const b of BACKENDS)for(const kind of ['write','read','take','race'] as const)
 test(`${b}: ${kind} persists a definitive failed Child as review across reopen`,()=>fixture(b,async o=>{
  let invokes=0;o.sim.invoke=async(s:any)=>{invokes++;return{target:s.target,principal:s.principal,method:s.method,generation:s.generation,requestId:s.requestId,argHash:s.argHash,outcome:'failed',evidence:'TransactionError'};};
  const request={id:'failed-'+kind,principal:o.p},template={type:'Job'};
  const run=()=>kind==='write'?o.f.write({type:'Job',fields:{}},request):kind==='read'?o.f.read(template,request):kind==='take'?o.f.take(template,request):o.f.takeWaiting(template,10000,5000,request);
  await assert.rejects(run(),FederationUnavailable);assert.equal(invokes,1);
  const key=parentJournalKey('federation',8,operationPartition(request.id,8)),parent=(await o.host.snapshot(FederationOperations,key,ctx)).operations[request.id];assert.equal(parent.phase,'needsReview');
  await o.reopen();await assert.rejects(o.f.resume(request.id),FederationUnavailable);await assert.rejects(run(),FederationUnavailable);assert.equal(invokes,1);
 },8));

for(const b of BACKENDS)for(const boundary of ['admission','completion'] as const)for(const fault of ['failBeforeCommit','loseAnswer'] as const)
test(`${b}: atomic Parent/Child ${boundary} ${fault} preserves one original effect`,()=>fixture(b,async o=>{
 const request={id:'atomic-'+boundary+'-'+fault,principal:o.p},entry={type:'Job',fields:{n:1}};
 const matches=(writes:any[])=>writes.some(w=>w.type==='document.change'&&JSON.stringify(w.content).includes('"operations"')&&JSON.stringify(w.content).includes(boundary==='admission'?'"ready"':'"done"'))&&writes.some(w=>['document.create','document.change'].includes(w.type)&&JSON.stringify(w.content).includes('"command"')&&JSON.stringify(w.content).includes('"steps"'));
 o.home.faults.arm(fault,matches);await assert.rejects(o.f.write(entry,request));assert.equal(o.home.faults.fired,1,'the paired multi-document commit must be interrupted');
 const key=parentJournalKey('federation',8,operationPartition(request.id,8));let durablePhase:string|undefined;await o.reopen(async(host:any)=>{durablePhase=(await host.snapshot(FederationOperations,key,ctx)).operations[request.id].phase;});
 assert.equal(durablePhase,boundary==='admission'?(fault==='loseAnswer'?'ready':'admitting'):(fault==='loseAnswer'?'done':'ready'));
 const api=new PiSpaces(o.sim.nodes.get('a').host,ctx,()=>o.sim.clock.now('a'));assert.equal(await api.count(),boundary==='admission'?0:1);
 await o.reopen();const result=await o.f.write(entry,request);await o.reopen();assert.deepEqual(await o.f.write(entry,request),result);assert.equal(await api.count(),1);
 const claims=Object.values((await o.sim.nodes.get('a').host.snapshot(Space,ctx)).rpc.claims) as any[];assert.equal(claims.filter(c=>c.method==='write').length,1);
 for(const router of o.partitionRouters)assert.deepEqual((await o.host.snapshot(RouterJournal,router.journalId,ctx)).future??{},{});
},8));

for(const b of BACKENDS)for(const fault of ['failBeforeCommit','loseAnswer'] as const)
test(`${b}: Parent admission and child budget ${fault} commit or roll back together`,()=>fixture(b,async o=>{
 const request={id:'atomic-budget-'+fault,principal:o.p},entry={type:'Job',fields:{n:1}};
 o.home.faults.arm(fault,(writes:any[])=>writes.some(w=>['document.create','document.change'].includes(w.type)&&JSON.stringify(w.content).includes('"operations"')&&JSON.stringify(w.content).includes('"admitting"'))&&writes.some(w=>w.type==='document.change'&&JSON.stringify(w.content).includes('"future"')&&JSON.stringify(w.content).includes('"slots"')));
 await assert.rejects(o.f.write(entry,request));assert.equal(o.home.faults.fired,1);let parent:any,slots=0;
 await o.reopen(async(host:any)=>{parent=(await host.snapshot(FederationOperations,parentJournalKey('federation',8,operationPartition(request.id,8)),ctx))?.operations[request.id];for(const r of o.partitionRouters){const j=await host.snapshot(RouterJournal,r.journalId,ctx);slots+=Object.values(j?.future??{}).reduce((n:number,x:any)=>n+x.slots,0);}});
 assert.equal(!!parent,fault==='loseAnswer');assert.equal(slots,fault==='loseAnswer'?1:0);assert.equal(await new PiSpaces(o.sim.nodes.get('a').host,ctx,()=>o.sim.clock.now('a')).count(),0);
 await o.f.write(entry,request);await o.reopen();await o.f.write(entry,request);assert.equal(await new PiSpaces(o.sim.nodes.get('a').host,ctx,()=>o.sim.clock.now('a')).count(),1);
},8));

for(const b of BACKENDS)test(`${b}: large Parent stays on bounded separate commits when atomic room is insufficient`,()=>fixture(b,async o=>{
 let paired=0;o.home.faults.arm('failBeforeCommit',(writes:any[])=>{if(writes.some(w=>w.type==='document.change'&&JSON.stringify(w.content).includes('"operations"')&&/"ready"|"done"/.test(JSON.stringify(w.content)))&&writes.some(w=>['document.create','document.change'].includes(w.type)&&JSON.stringify(w.content).includes('"command"')&&JSON.stringify(w.content).includes('"steps"')))paired++;return false;});
 const request={id:'bounded-fallback',principal:o.p},entry={type:'Job',fields:{blob:'x'.repeat(27000)}};const result=await o.f.write(entry,request);assert.equal(paired,0);await o.reopen();assert.deepEqual(await o.f.write(entry,request),result);assert.equal(await new PiSpaces(o.sim.nodes.get('a').host,ctx,()=>o.sim.clock.now('a')).count(),1);
 for(const r of o.partitionRouters)assert.deepEqual((await o.host.snapshot(RouterJournal,r.journalId,ctx)).future??{},{});
},8,{maxCommitBytes:60000,maxIndexBytes:1024,defaultResultBytes:64}));
