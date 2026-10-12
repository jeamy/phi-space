import assert from 'node:assert/strict';
import test from 'node:test';

import {PiSpaces} from './src/client.ts';
import {Space} from './src/doc.ts';
import {
    FederatedSpace,
    type FederationIO,
    FederationPending,
    FederationUnavailable
} from './src/federated-space.ts';
import {RouterController} from './src/router.ts';
import {RoutingConflict, type RoutingState} from './src/routing-semantics.ts';
import {FederationSimulator} from './test/support/federation-simulator.ts';
import {BACKENDS, ctx, PersistentHome} from './test/support/persistent.ts';

const principal = {
    peerId : 'client',
    agentId : 'worker'
};
async function fixture(b: typeof BACKENDS[number], fn: (o: any) => Promise<void>) {
    const sim = new FederationSimulator(b), home = new PersistentHome(b);
    try {
        await sim.add('a');
        await sim.add('b');
        let host = await home.open();
        const first = await sim.step('a', 'read', {});
        const p = first.principal;
        const state: RoutingState = {
            policy : {
                authorityId : 'authority-1',
                policyVersion : 1,
                default : {mode : 'local', member : 'a'},
                completionProfiles : [],
                rules : [ {type : 'Job', mode : 'expand', by : 'capacity', members : [ 'a', 'b' ]} ]
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
            assertAuthority : async () => {}
        });
        let router = new RouterController(options());
        await router.recover();
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
            state : async () => state,
            io,
            assertAuthority : async () => {},
            now : () => sim.clock.now('a')
        });
        let f = make();
        await fn({
            sim,
            home,
            state,
            p,
            io,
            unavailable,
            get f() { return f; },
            reopen : async () => {
                home.crash(host);
                host = await home.open();
                router = new RouterController(options());
                await router.recover();
                f = make();
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
