import assert from 'node:assert/strict';
import test from 'node:test';

import {generateKey} from '../src/auth.ts';
import {PhiSpaces} from '../src/client.ts';
import {FOREVER} from '../src/core.ts';
import {FederationPolicyAuthority, FederationRouting} from '../src/federation-policy.ts';
import {GrantVerifier} from "../src/grants.ts";
import {
    MemberLifecycle,
    MembershipController,
    MembershipJournal,
    type MembershipTransport,
    signMembership
} from '../src/membership.ts';
import {RemoteSpace} from "../src/remote.ts";
import {
    type FederationMember,
    type FederationPolicy,
    MemberDrained,
    MigrationRequired,
    RoutingConflict
} from '../src/routing-semantics.ts';
import {startFederationHost} from "../src/runtime.ts";
import {socketTransport} from "../src/socket.ts";
import {createSpace, snapshotSpace, spaceDoc} from '../src/spaces.ts';
import {BACKENDS, ctx, PersistentHome} from './support/persistent.ts';

async function fixture(b: typeof BACKENDS[number], f: (o: any) => Promise<void>) {
    const homes = [ new PersistentHome(b), new PersistentHome(b), new PersistentHome(b) ];
    try {
        const [root, a, bh] = await Promise.all(homes.map(h => h.open()));
        let now = 100000;
        const clock = () => now,
              control = await root.commit(tx => createSpace(tx, 'control', now), ctx);
        const rootKey = generateKey('ed25519', 'control');
        const keys = [ generateKey('ed25519', 'a'), generateKey('ed25519', 'b') ];
        const members: Record < string, FederationMember >= {}, nodes: Record < string,
            MemberLifecycle >= {}, clients: Record < string, PhiSpaces >= {};
        for (const [i, host] of [a, bh].entries()) {
            const id = i ? 'b' : 'a',
                  s = await host.commit(tx => createSpace(tx, 'jobs', now), ctx);
            members[id] = {
                id,
                state : 'active',
                target : {
                    hostId : id,
                    spaceId : s.spaceId,
                    authorityId : 'authority',
                    dataIncarnation : s.incarnation,
                    primaryEpoch : 1
                }
            };
            nodes[id] = new MemberLifecycle({
                host,
                ctx,
                memberId : id,
                spaceId : s.spaceId,
                authorityId : 'authority',
                peerId : id,
                signer : keys[i]!.signer,
                controlPin :
                    {issuer : 'control', algorithm : 'ed25519', publicKey : rootKey.publicKey},
                assertAuthority : async () => {},
                now : clock
            });
            clients[id] = new PhiSpaces(host, ctx, clock, undefined, undefined, {space : s.spaceId});
        }
        let drop: string|undefined;
        let referenced = false;
        const transport: MembershipTransport = {
            apply : async (m, q) => {
                const r = await nodes[m.id]!.apply(q);
                if (drop === q.value.action) {
                    drop = undefined;
                    throw Error('lost committed reply');
                }
                return r;
            },
            pin : async m => ({
                issuer : m.id,
                algorithm : 'ed25519',
                publicKey : keys[m.id === 'a' ? 0 : 1]!.publicKey
            })
        };
        const make = () => new MembershipController({
            host : root,
            ctx,
            controlSpaceId : control.spaceId,
            authorityId : 'authority',
            peerId : 'control',
            signer : rootKey.signer,
            transport,
            assertAuthority : async () => {},
            authorize : async () => {},
            hasReferences : async () => referenced,
            hasReferencesIn : async () => referenced
        });
        const authority = new FederationPolicyAuthority({
            host : root,
            ctx,
            controlSpaceId : control.spaceId,
            authorityId : 'authority',
            peerId : 'control',
            signer : rootKey.signer,
            assertAuthority : async () => {}
        });
        await f({
            transport,
            homes,
            root,
            a,
            bh,
            members,
            nodes,
            clients,
            clock,
            setNow : (v: number) => now = v,
            drop : (s: string) => drop = s,
            ref : (v: boolean) => referenced = v,
            make,
            authority,
            control,
            rootKey,
            install : async (p: FederationPolicy) => {
                await authority.install(p, p.policyVersion - 1, async () => {});
                for (const id of ['a', 'b'])
                    await nodes[id]!.apply(await signMembership('instruction', {
                        id : 'policy-' + p.policyVersion,
                        memberId : id,
                        spaceId : members[id]!.target.spaceId,
                        authorityId : 'authority',
                        action : 'policy',
                        policy : p
                    },
                                                                'control', rootKey.signer));
            }
        });
    } finally {
        for (const h of homes)
            await h.dispose();
    }
}
for (const b of BACKENDS) {
    test(`${b}: add locks local writes across lost reply and replays stable transition`,
         () => fixture(b, async o => {
             await o.clients.a.write({type : 'Job', fields : {n : 1}}, null, FOREVER);
             o.drop('prepareAdd');
             await assert.rejects(o.make().execute('add-a', 'add', o.members.a));
             await assert.rejects(o.clients.a.write({type : 'Job', fields : {n : 2}}),
                                  MemberDrained);
             const r = await o.make().execute('add-a', 'add', o.members.a);
             assert.equal(r.phase, 'completed');
             assert.equal((await o.authority.state()).policy.rules[0].member, 'a');
             assert.equal(await o.clients.a.count(), 1);
             await assert.rejects(
                 o.clients.a.write({type : 'Job', types : [ 'Undeclared' ], fields : {}}),
                 RoutingConflict);
             assert.equal((await o.make().execute('add-a', 'add', o.members.a)).phase, 'completed');
         }));
    test(
        `${b}: draining allows only finite profile-bound completion; removal retains notify mailbox`,
        () => fixture(b, async o => {
            await o.make().execute('add-a', 'add', o.members.a);
            await o.make().execute('add-b', 'add', o.members.b);
            const p = (await o.authority.state()).policy;
            p.policyVersion++;
            p.rules = [
                {type : 'Task', mode : 'local', member : 'b'},
                {type : 'Result', mode : 'local', member : 'b'}
            ];
            p.completionProfiles = [ {
                taskType : 'Task',
                resultTypes : [ 'Result' ],
                equalFields : [ 'jobId' ],
                maxResultCount : 1,
                maxResultBytes : 4096,
                maxLeaseMs : 5000
            } ];
            await o.install(p);
            await o.clients.b.write({type : 'Task', fields : {jobId : 'j'}}, null, FOREVER);
            const consumer = {peerId : 'observer'};
            await new PhiSpaces(o.bh, ctx, o.clock, undefined, undefined, {
                space : o.members.b.target.spaceId,
                consumer
            }).notify({type : 'Task'}, {target : 'observer', lease : FOREVER});
            await o.make().execute('drain-b', 'drain', o.members.b);
            await assert.rejects(o.clients.b.write({type : 'Task', fields : {jobId : 'x'}}),
                                 MemberDrained);
            const txn = await o.clients.b.createTransaction(5000);
            await o.clients.b.take({type : 'Task'}, 0, {txn : txn.id});
            await assert.rejects(
                o.clients.b.write({type : 'Result', fields : {jobId : 'wrong'}}, txn.id),
                MemberDrained);
            await assert.rejects(o.clients.b.renew(txn.id, 60000), MemberDrained);
            await o.clients.b.write({type : 'Result', fields : {jobId : 'j'}}, txn.id, FOREVER);
            await o.clients.b.commit(txn.id);
            await o.clients.b.take({type : 'Result'}, 0);
            o.drop('detach');
            await assert.rejects(o.make().execute('remove-b', 'remove', o.members.b));
            await assert.rejects(o.clients.b.write({type : 'Result', fields : {jobId : 'j'}}),
                                 MemberDrained);
            assert.equal((await o.make().execute('remove-b', 'remove', o.members.b)).phase,
                         'completed');
            const page = await new PhiSpaces(o.bh, ctx, o.clock, undefined, undefined, {
                             space : o.members.b.target.spaceId,
                             consumer
                         }).events(consumer);
            assert.ok(page.events.some((i: any) => i.event.kind === 'registrationClosed' &&
                                                   i.event.reason === 'removing'));
            await new PhiSpaces(o.bh, ctx, o.clock, undefined, undefined, {
                space : o.members.b.target.spaceId,
                consumer
            }).ack(consumer, page.mailboxEpoch, page.next);
        }));
    test(`${b}: physical invisible entries and Root references block EmptyProof`,
         () => fixture(b, async o => {
             await o.make().execute('add-a', 'add', o.members.a);
             await o.make().execute('add-b', 'add', o.members.b);
             const txn = await o.clients.b.createTransaction(
                 5000); // free write routes default a and must be denied
             await assert.rejects(o.clients.b.write({type : 'Unruled', fields : {}}, txn.id),
                                  RoutingConflict);
             await o.make().execute('drain-b', 'drain', o.members.b);
             await assert.rejects(o.make().execute('remove-b', 'remove', o.members.b),
                                  RoutingConflict);
             await o.clients.b.abort(txn.id);
             o.ref(true);
             await assert.rejects(o.make().execute('remove-b', 'remove', o.members.b),
                                  RoutingConflict);
             o.ref(false);
             assert.equal((await o.make().execute('remove-b', 'remove', o.members.b)).phase,
                          'completed');
         }));
    test(
        `${b}: fixed HRW removal requires migration`,
        () => fixture(b, async o => {
            await o.make().execute('add-a', 'add', o.members.a);
            await o.make().execute('add-b', 'add', o.members.b);
            const p = (await o.authority.state()).policy;
            p.policyVersion++;
            p.rules =
                [ {type : 'Shard', mode : 'expand', by : {field : 'key'}, members : [ 'a', 'b' ]} ];
            await o.install(p);
            await o.make().execute('drain-b', 'drain', o.members.b);
            await assert.rejects(o.make().execute('remove-b', 'remove', o.members.b),
                                 MigrationRequired);
        }));
}

for (const backend of BACKENDS)
    test(`${backend}: composed Gate accepts only pinned signed membership instruction over TCP`,
         () => fixture(backend, async o => {
             const runtime = await startFederationHost(o.a, ctx, {
                 hostId : 'a',
                 authorityId : 'authority',
                 unsafeSkipBootGuardForTests : true,
                 groupRoles : {'space-hosts' : [ 'host' ]},
                 membership : o.nodes.a,
                 keys : {
                     find : async (peer, key) =>
                         peer === 'control' && key === o.rootKey.signer.keyId ? {
                             peerId : 'control',
                             principal : 'control',
                             keyId : key,
                             algorithm : 'ed25519',
                             publicKey : o.rootKey.publicKey,
                             state : 'active',
                             roles : [ 'host' ],
                             scope : [ '*' ]
                         }
                                                                              : null
                 },
                 verifier : new GrantVerifier({
                     authorityId : 'authority',
                     issuerHostId : 'control',
                     algorithm : 'ed25519',
                     publicKey : o.rootKey.publicKey,
                     now : o.clock
                 }),
                 directory : {
                     refresh : async () => {},
                     lookup : async ip => ip === '127.0.0.2' ? {
                         id : 'control',
                         name : 'control',
                         ip,
                         connected : true,
                         groups : [ 'space-hosts' ]
                     }
                                                             : null
                 },
                 listen : {host : '127.0.0.1', port : 0},
                 now : o.clock,
                 revalidateMs : 0
             });
             const socket =
                 socketTransport({host : '127.0.0.1', port : (runtime.address() as any).port},
                                 {localAddress : '127.0.0.2'});
             try {
                 const remote = new RemoteSpace(socket, {
                     space : o.members.a.target.spaceId,
                     signer : o.rootKey.signer,
                     ownPeerId : 'control',
                     expectedGateHostId : 'a',
                     now : o.clock,
                     attempts : 1
                 });
                 await remote.authenticate();
                 const q = await signMembership('instruction', {
                     id : 'tcp-add',
                     authorityId : 'authority',
                     memberId : 'a',
                     spaceId : o.members.a.target.spaceId,
                     action : 'prepareAdd' as const
                 },
                                                'control', o.rootKey.signer);
                 assert.equal((await remote.requestMembership(q)).value.state, 'adding');
                 await assert.rejects(remote.requestMembership({...q, signature : 'bad'}));
                 await assert.rejects(o.clients.a.write({type : 'Job', fields : {}}),
                                      MemberDrained);
             } finally {
                 socket.close();
                 await runtime.close();
             }
         }));

for (const b of BACKENDS)
    test(
        `${b}: conflicting stock is rejected before policy commit and local admission is safely restored`,
        () => fixture(b, async o => {
            await o.clients.a.write({type : 'Task', fields : {n : 1}}, null, FOREVER);
            await o.make().execute('add-a', 'add', o.members.a);
            await o.clients.b.write({type : 'Task', fields : {n : 2}}, null, FOREVER);
            const before = (await o.authority.state()).policy.policyVersion;
            o.drop('rejectAdd');
            await assert.rejects(o.make().execute('bad-add-b', 'add', o.members.b));
            const r = await o.make().execute('bad-add-b', 'add', o.members.b);
            assert.equal(r.phase, 'failed');
            assert.equal((await o.authority.state()).policy.policyVersion, before);
            assert.equal((await o.authority.state()).members.b, undefined);
            await o.clients.b.write({type : 'Local', fields : {n : 3}});
        }));

for (const b of BACKENDS)
    test(`${b}: a Root reference appearing after EmptyProof blocks the atomic removal commit`,
         () => fixture(b, async o => {
             await o.make().execute('add-a', 'add', o.members.a);
             await o.make().execute('add-b', 'add', o.members.b);
             await o.make().execute('drain-b', 'drain', o.members.b);
             let reference = true;
             const controller = new MembershipController({
                 host : o.root,
                 ctx,
                 controlSpaceId : o.control.spaceId,
                 authorityId : 'authority',
                 peerId : 'control',
                 signer : o.rootKey.signer,
                 transport : o.transport,
                 assertAuthority : async () => {},
                 authorize : async () => {},
                 hasReferences : async () => false,
                 hasReferencesIn : async () => reference
             });
             await assert.rejects(controller.execute('remove-race', 'remove', o.members.b),
                                  /Root still references Member at removal commit/);
             assert.equal((await o.authority.state()).members.b.state, 'draining');
             reference = false;
             assert.equal((await controller.execute('remove-race', 'remove', o.members.b)).phase,
                          'completed');
         }));

for(const backend of BACKENDS)test(`${backend}: identical signed Member policy avoids mutation but retains guarded reads and authority checks`,()=>fixture(backend,async o=>{
 await o.make().execute('same-policy-add','add',o.members.a);const token=await o.authority.signed();await o.nodes.a.installPolicy(token);
 let commits=0,snapshots=0,revoked=false,revokeOnSnapshot=false;
 const guarded=new Proxy(o.a,{get(target,key){if(key==='commit')return (...args:any[])=>{commits++;return target.commit(...args);};if(key==='snapshot')return async(...args:any[])=>{snapshots++;const value=await target.snapshot(...args);if(revokeOnSnapshot)revoked=true;return value;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}),node=new MemberLifecycle({...o.nodes.a.o,host:guarded,assertAuthority:async()=>{if(revoked)throw Error('authority revoked');}});
 await node.installPolicy(token);assert.equal(commits,0);assert.ok(snapshots>0);
 revokeOnSnapshot=true;await assert.rejects(node.installPolicy(token),/authority revoked/);assert.equal(commits,0);
 revoked=false;revokeOnSnapshot=false;await assert.rejects(node.installPolicy({...token,signature:'invalid'}),RoutingConflict);assert.equal(commits,0);
 const previous=(await snapshotSpace(o.a,o.members.a.target.spaceId,ctx))!.membership!;assert.equal(previous.policy!.policyVersion,token.policy.policyVersion);
}));

for (const backend of BACKENDS)
    test(`${backend}: a membership instruction naming a primary/sync Space reaches the lifecycle in its own store`,
         () => fixture(backend, async o => {
             const pin = {find : async (peer: string, key: string) => peer === 'control' && key === o.rootKey.signer.keyId ? {peerId : 'control', principal : 'control', keyId : key, algorithm : 'ed25519' as const, publicKey : o.rootKey.publicKey, state : 'active' as const, roles : [ 'host' ], scope : [ '*' ]} : null};
             const runtime = await startFederationHost(o.a, ctx, {
                 hostId : 'a', authorityId : 'authority', unsafeSkipBootGuardForTests : true, groupRoles : {'space-hosts' : [ 'host' ]},
                 // Only the replicated Space has a lifecycle here: the main store has none, as on a pure sync Member.
                 syncSpaces : [{spaceId : o.members.b.target.spaceId, alias : 'jobs-sync-b', host : o.bh, primaryEpoch : () => 1, membership : o.nodes.b}],
                 keys : pin,
                 verifier : new GrantVerifier({authorityId : 'authority', issuerHostId : 'control', algorithm : 'ed25519', publicKey : o.rootKey.publicKey, now : o.clock}),
                 directory : {refresh : async () => {}, lookup : async ip => ip === '127.0.0.2' ? {id : 'control', name : 'control', ip, connected : true, groups : [ 'space-hosts' ]} : null},
                 listen : {host : '127.0.0.1', port : 0}, now : o.clock, revalidateMs : 0
             });
             const socket = socketTransport({host : '127.0.0.1', port : (runtime.address() as any).port}, {localAddress : '127.0.0.2'});
             try {
                 const remote = new RemoteSpace(socket, {space : o.members.b.target.spaceId, signer : o.rootKey.signer, ownPeerId : 'control', expectedGateHostId : 'a', now : o.clock, attempts : 1});
                 await remote.authenticate();
                 const q = await signMembership('instruction', {id : 'sync-add', authorityId : 'authority', memberId : 'b', spaceId : o.members.b.target.spaceId, action : 'prepareAdd' as const}, 'control', o.rootKey.signer);
                 assert.equal((await remote.requestMembership(q)).value.state, 'adding');
                 await assert.rejects(o.clients.b.write({type : 'Job', fields : {}}), MemberDrained, 'the state landed in the Space of b, not in the main store');
                 await o.clients.a.write({type : 'Job', fields : {}});
                 // A sealed, unconfirmed commit of the sync Space: it is answered with CommitSealed through the real
                 // dispatch (business calls and membership instructions alike) until it is served again.
                 const entry = {spaceId : o.members.b.target.spaceId, alias : 'jobs-sync-b', host : o.bh, primaryEpoch : () => 1, membership : o.nodes.b};
                 await runtime.setSyncSpace({spaceId : entry.spaceId, alias : entry.alias, sealed : {revision : 7, hash : 'f'.repeat(64)}});
                 await assert.rejects(remote.count({type : 'Job'}), (e: any) => e?.code === 'CommitSealed');
                 const q2 = await signMembership('instruction', {id : 'sync-add-2', authorityId : 'authority', memberId : 'b', spaceId : entry.spaceId, action : 'prepareAdd' as const}, 'control', o.rootKey.signer);
                 await assert.rejects(remote.requestMembership(q2), (e: any) => e?.code === 'CommitSealed');
                 await assert.rejects(runtime.setSyncSpace({...entry, alias : 'other'}), /not provisioned/);
                 await runtime.setSyncSpace(entry);
                 await assert.rejects(remote.requestMembership(q2), /already managed or frozen/, 'served again: the instruction reaches the lifecycle of b');
                 await assert.rejects(remote.count({type : 'Job'}), /signed control grant/, 'business calls get the normal authorization again, not CommitSealed');
             } finally { socket.close(); await runtime.close(); }
         }));
