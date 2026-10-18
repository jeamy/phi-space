import * as core from '../src/core.ts';
import assert from "node:assert/strict";
import test from "node:test";

import {generateKey, type KeyDirectory, type PeerKeyRec, ProvingService} from "../src/auth.ts";
import {argHash} from "../src/claims.ts";
import {PiSpaces} from "../src/client.ts";
import {FOREVER} from "../src/core.ts";
import {
    DelegationDenied,
    delegationForCall,
    DelegationVerifier,
    RouterLeaseAuthority,
    signDelegation,
    type TargetRequest
} from "../src/delegation.ts";
import {FederatedSpace, FederationPending} from "../src/federated-space.ts";
import {FederationPolicyAuthority, FederationRouting} from "../src/federation-policy.ts";
import {FederationRpc} from "../src/federation-rpc.ts";
import {GrantAuthority, GrantVerifier} from "../src/grants.ts";
import {RouterController} from "../src/router.ts";
import {rpcDomain} from "../src/rpc-domain.ts";
import {startFederationHost} from "../src/runtime.ts";
import {type Call, SpaceService, StaticIdentity} from "../src/service.ts";
import {serveSpace, socketTransport} from "../src/socket.ts";
import {createSpace, listSpaces, spaceDoc} from "../src/spaces.ts";
import {BACKENDS, ctx, InjectedFault, PersistentHome} from "./support/persistent.ts";

async function fixture(backend: typeof BACKENDS[number], f: (o: any) => Promise<void>) {
    const rootHome = new PersistentHome(backend), dataHome = new PersistentHome(backend);
    try {
        let root = await rootHome.open(), data = await dataHome.open(), now = 100000,
            policyVersion = 1;
        const clock = () => now, controlKey = generateKey("ed25519", "supervisor-key"),
              routerKey = generateKey("ecdsa-p256", "router-key"),
              userKey = generateKey("ed25519", "user-key");
        const records = new Map<string, PeerKeyRec>();
        for (const [peer, key, roles] of [[ "router", routerKey, [ "router" ] ],
                                          [ "user", userKey, [ "member" ] ]] as const)
            records.set(peer, {
                principal : peer,
                peerId : peer,
                keyId : key.signer.keyId,
                publicKey : key.publicKey,
                algorithm : key.signer.algorithm,
                roles : [...roles ],
                scope : [ "*" ],
                state : "active"
            });
        const keys: KeyDirectory = {
            find : async (p, k) => records.get(p)?.keyId === k ? records.get(p)! : null
        };
        const controlId = (await root.commit(tx => createSpace(tx, "control", now), ctx)).spaceId;
        await data.commit(tx => spaceDoc(tx, undefined, now), ctx);
        const info = (await listSpaces(data, ctx))[0]!;
        let replicaVersion: number | null = null, replicaEpoch = 1;
        const replicaConfig = (id: string) =>
            replicaVersion === null || id !== info.spaceId ? null : {replicaConfigVersion : replicaVersion, primaryEpoch : replicaEpoch};
        const userIdentity = {principal : {peerId : "user"}, roles : [ "member" ]};
        const authority = new GrantAuthority({
            authorityId : "authority",
            hostId : "control-host",
            signer : controlKey.signer,
            keys,
            identity : {authenticate : () => userIdentity},
            refreshIdentity : async () => userIdentity,
            now : clock
        });
        const grant = () =>
            authority.issue({peerId : "user", state : {proof : {keyId : userKey.signer.keyId}}});
        const grantVerifier = new GrantVerifier({
            authorityId : "authority",
            issuerHostId : "control-host",
            publicKey : controlKey.publicKey,
            algorithm : "ed25519",
            now : clock
        });
        let leases = new RouterLeaseAuthority({
            host : root,
            ctx,
            controlSpaceId : controlId,
            authorityId : "authority",
            peerId : "supervisor",
            signer : controlKey.signer,
            keys,
            assertAuthority : async () => {},
            now : clock
        });
        let verifier = new DelegationVerifier({
            host : data,
            ctx,
            authorityId : "authority",
            controlSpaceId : controlId,
            supervisorPeerId : "supervisor",
            supervisorKey : {algorithm : "ed25519", publicKey : controlKey.publicKey},
            keys,
            grants : grantVerifier,
            policy : async () => ({authorityId : "authority", policyVersion}),
            now : clock,
            replicaConfig
        });
        const conn = {peerId : "router", state : {proof : {keyId : routerKey.signer.keyId}}};
        const identity =
            new StaticIdentity({router : {principal : {peerId : "router"}, roles : [ "router" ]}});
        const service = (extra: Partial<import("../src/service.ts").SpaceServiceOptions> = {}) => new SpaceService({
            host : data,
            ctx,
            identity,
            hostId : "member",
            authorityId : "authority",
            primaryEpoch : 1,
            epochForSpace : async (space?: string) => replicaVersion !== null && space === info.spaceId ? replicaEpoch : 1,
            now : clock,
            maxPollMs : 1,
            authorize : (call, id, c) => verifier.check(call, id, c),
            ...extra
        });
        let lease = await leases.issue("router", routerKey.signer.keyId);
        let serial = 0;
        const signed = async (call: Call, targetRequest?: TargetRequest, override: any = {}) => {
            const g = await grant(),
                  d = delegationForCall({
                      call,
                      principal : userIdentity.principal,
                      lease,
                      policyVersion : targetRequest?.policyVersion ?? policyVersion,
                      spaceId : info.spaceId,
                      primaryEpoch : 1,
                      grant : g,
                      targetRequest,
                      now
                  });
            Object.assign(d, override);
            return {
                ...call,
                frame : {
                    authorityId : "authority",
                    primaryEpoch : 1,
                    grant : g as any,
                    delegation : await signDelegation(routerKey.signer, d) as any
                }
            };
        };
        const invoke = async (call: Call, targetRequest?: TargetRequest, override: any = {}) =>
            service().handle(await signed(call, targetRequest, override), conn);
        const gen = (await new PiSpaces(data, ctx, clock, undefined, undefined, {
                         authorityId : "authority"
                     }).issueGeneration(userIdentity.principal))
                        .generation;
        const call = (method: Call["method"], args: Call["args"] = {},
                      id = "r" + (++serial)): Call =>
            ({method, space : info.spaceId, args, request : {generation : gen, requestId : id}});
        const target = (c: Call, version = policyVersion): TargetRequest => {
            const domain = rpcDomain(c, userIdentity.principal);
            return {
                requestId : c.request!.requestId,
                requestGeneration : gen,
                method : domain.method,
                argumentHash : argHash(domain.method, domain.args),
                policyVersion : version
            };
        };
        await f({
            rootHome,
            dataHome,
            get root() { return root },
            get data() { return data },
            setNow : (v: number) => now = v,
            get now() { return now },
            setPolicy : (v: number) => policyVersion = v,
            setReplica : (v: number | null, epoch = 1) => { replicaVersion = v; replicaEpoch = epoch; },
            records,
            keys,
            leases,
            get lease() { return lease },
            setLease : (l: any) => lease = l,
            verifier,
            service,
            conn,
            signed,
            invoke,
            call,
            target,
            info,
            clock,
            controlId,
            grant,
            routerKey,
            controlKey,
            reopenData : async () => {
                dataHome.crash(data);
                data = await dataHome.open();
                verifier = new DelegationVerifier({
                    host : data,
                    ctx,
                    authorityId : "authority",
                    controlSpaceId : controlId,
                    supervisorPeerId : "supervisor",
                    supervisorKey : {algorithm : "ed25519", publicKey : controlKey.publicKey},
                    keys,
                    grants : grantVerifier,
                    policy : async () => ({authorityId : "authority", policyVersion}),
                    now : clock,
                    replicaConfig
                });
            }
        });
    } finally {
        await rootHome.dispose();
        await dataHome.dispose();
    }
}
for (const backend of BACKENDS) {
    test(
        `${backend}: signed delegation executes as original principal and deduplicates after restart`,
        () => fixture(backend, async o => {
            await new PiSpaces(o.data, ctx, o.clock)
                .write({type : "Job", fields : {n : 1}}, null, FOREVER);
            const c = o.call("take", {template : {type : "Job"}, waitMs : 0}, "take");
            const first = await o.invoke(c);
            assert.ok(first.ok, JSON.stringify(first));
            assert.equal(first.result.entry.fields.n, 1);
            await o.reopenData();
            const replay = await o.invoke(c);
            assert.deepEqual(replay, first);
            assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 0);
            const poll = await o.invoke({
                method : "pollOperation",
                space : o.info.spaceId,
                args : {targetRequest : c.request, waitMs : 0}
            },
                                        o.target(c));
            assert.ok(poll.ok);
            assert.equal(poll.result.result.fields.n, 1);
        }));
    test(
        `${backend}: authority, audience, principal, operation, request, hashes and expiry are bound`,
        () => fixture(backend, async o => {
            const c = o.call("write", {entry : {type : "Job", fields : {}}});
            for (const override of [{targetSpace : "foreign"}, {principal : {peerId : "foreign"}},
                                    {operation : "take"}, {requestId : "foreign"},
                                    {requestGeneration : "foreign"}, {argumentHash : "bad"},
                                    {expiresAt : o.now + 120000}]) {
                const r = await o.invoke(c, undefined, override);
                assert.equal(r.ok, false, JSON.stringify(override));
            }
            const t = await o.signed(c);
            t.frame.delegation.delegation.routerLease.lease.authorityId = "foreign";
            assert.equal((await o.service().handle(t, o.conn)).ok, false);
            assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 0);
        }));
    test(`${backend}: both signatures and active router/original keys are required`,
         () => fixture(backend, async o => {
             const c = o.call("write", {entry : {type : "Job", fields : {}}});
             const t = await o.signed(c);
             t.frame.delegation.signature = "bad";
             assert.equal((await o.service().handle(t, o.conn)).ok, false);
             assert.equal(
                 (await o.invoke(c, undefined, {routerLease : {...o.lease, signature : "bad"}})).ok,
                 false);
             o.records.get("router").state = "revoked";
             assert.equal((await o.invoke(c)).ok, false);
             o.records.get("router").state = "active";
             o.records.get("user").state = "revoked";
             await assert.rejects(o.signed(c));
             assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 0);
         }));
    test(`${backend}: a replicated Member answers ReplicaConfigPending until the router routes under its configuration`,
         () => fixture(backend, async o => {
             const before = o.call("write", {entry : {type : "Job", fields : {n : 1}}});
             assert.ok((await o.invoke(before)).ok, "non-replicated Spaces ignore the version");
             o.setReplica(3);
             const fresh = o.call("write", {entry : {type : "Job", fields : {n : 2}}});
             const pending = await o.invoke(fresh, undefined, {targetReplicaConfigVersion : 2});
             assert.equal(pending.ok, false);assert.match(JSON.stringify(pending), /not adopted by the router yet/);
             assert.equal((await o.invoke(o.call("write", {entry : {type : "Job", fields : {n : 3}}}))).ok, false, "a router without the version is pending too");
             // Follow-ups of an operation admitted before the change continue under its binding.
             const poll = await o.invoke({method : "pollOperation", space : o.info.spaceId, args : {targetRequest : before.request, waitMs : 0}}, o.target(before));
             assert.ok(poll.ok, JSON.stringify(poll));
             const adopted = await o.invoke(fresh, undefined, {targetReplicaConfigVersion : 3});
             assert.ok(adopted.ok, JSON.stringify(adopted));
             assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 2, "local work and adopted calls only");
             // After a promotion the journal epoch rises while the replicated Space document keeps its own: the
             // router's new target epoch is accepted, the old one is refused for new work.
             o.setReplica(4, 2);
             const promoted = async (epoch: number, n: number) => { const c = o.call("write", {entry : {type : "Job", fields : {n}}}), t = await o.signed(c, undefined, {targetPrimaryEpoch : epoch, targetReplicaConfigVersion : 4}); t.frame.primaryEpoch = epoch; return o.service().handle(t, o.conn); };
             const stale = await promoted(1, 5);assert.equal(stale.ok, false, JSON.stringify(stale));
             const fresh2 = await promoted(2, 6);assert.ok(fresh2.ok, JSON.stringify(fresh2));
         }));
    test(`${backend}: policy changes permit bound old resolution, not old new requests`,
         () => fixture(backend, async o => {
             const c = o.call("take", {template : {type : "Job"}, timeoutMs : FOREVER, waitMs : 0});
             assert.equal((await o.invoke(c)).result.state, "pending");
             const target = o.target(c);
             o.setPolicy(2);
             const oldNew =
                 await o.invoke(o.call("write", {entry : {type : "Job", fields : {n : 2}}}),
                                undefined, {policyVersion : 1});
             assert.equal(oldNew.ok, false);
             const p = await o.invoke({
                 method : "pollOperation",
                 space : o.info.spaceId,
                 args : {targetRequest : c.request, waitMs : 0}
             },
                                      target);
             assert.ok(p.ok, JSON.stringify(p));
             const wrong = await o.invoke({
                 method : "pollOperation",
                 space : o.info.spaceId,
                 args : {targetRequest : c.request, waitMs : 0}
             },
                                          {...target, argumentHash : "foreign"});
             assert.equal(wrong.ok, false);
             const cancelled =
                 await o.invoke(o.call("cancelOperation", {targetRequest : c.request}), target);
             assert.ok(cancelled.ok, JSON.stringify(cancelled));
             assert.equal(cancelled.result.state, "cancelled");
         }));
    test(`${backend}: higher epoch durably disables old pending effects and old router frames`,
         () => fixture(backend, async o => {
             const c = o.call("take", {template : {type : "Job"}, timeoutMs : FOREVER, waitMs : 0});
             assert.equal((await o.invoke(c)).result.state, "pending");
             const oldSigned =
                 await o.signed(o.call("write", {entry : {type : "Job", fields : {n : 3}}}));
             const newer = await o.leases.issue("router", o.routerKey.signer.keyId);
             await o.verifier.epochNotice(await o.leases.notice(1), o.info.spaceId);
             await o.reopenData();
             assert.equal((await o.service().handle(oldSigned, o.conn)).ok, false);
             await new PiSpaces(o.data, ctx, o.clock)
                 .write({type : "Job", fields : {n : 1}}, null, FOREVER);
             assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 1,
                          "old waiter must not take after epoch notice");
             o.setLease(newer);
             const p = await o.invoke({
                 method : "pollOperation",
                 space : o.info.spaceId,
                 args : {targetRequest : c.request, waitMs : 0}
             },
                                      o.target(c));
             assert.ok(p.ok, JSON.stringify(p));
             assert.equal(p.result.state, "done");
             assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 0);
         }));
    test(`${backend}: expired Root lease renews only with its signed retained token at the current epoch`,()=>fixture(backend,async o=>{
        const token=o.lease;o.setNow(token.lease.expiresAt+1000);
        await o.root.commit(async (tx:any)=>{const s=await spaceDoc(tx,o.controlId,o.now);core.settle(s,o.now);},ctx);
        await assert.rejects(o.leases.issue('router',o.routerKey.signer.keyId,{id:token.lease.id,routerEpoch:token.lease.routerEpoch}),DelegationDenied);
        await assert.rejects(o.leases.issue('router',o.routerKey.signer.keyId,{id:token.lease.id,routerEpoch:token.lease.routerEpoch,token:{...token,signature:'invalid'}}),DelegationDenied);
        const renewed=await o.leases.issue('router',o.routerKey.signer.keyId,{id:token.lease.id,routerEpoch:token.lease.routerEpoch,token});assert.equal(renewed.lease.id,token.lease.id);assert.equal(renewed.lease.routerEpoch,token.lease.routerEpoch);assert.ok(renewed.lease.expiresAt>o.now);
        await o.leases.issue('router',o.routerKey.signer.keyId);await assert.rejects(o.leases.issue('router',o.routerKey.signer.keyId,{id:token.lease.id,routerEpoch:token.lease.routerEpoch,token}),DelegationDenied);
    }));
    test(`${backend}: lease is not signed before durable commit and renewal preserves epoch`,
         () => fixture(backend, async o => {
             const old = o.lease;
             const renewed =
                 await o.leases.issue("router", o.routerKey.signer.keyId,
                                      {id : old.lease.id, routerEpoch : old.lease.routerEpoch});
             assert.equal(renewed.lease.routerEpoch, old.lease.routerEpoch);
             o.rootHome.faults.arm("failBeforeCommit");
             await assert.rejects(o.leases.issue("router", o.routerKey.signer.keyId),
                                  InjectedFault);
             await assert.rejects(o.leases.issue("user", "user-key"), DelegationDenied);
             assert.equal(renewed.lease.expiresAt - renewed.lease.issuedAt, 60000);
         }));
}
for (const backend of BACKENDS)
    test(`${backend}: new epoch arriving between authorization and commit fences the effect`,
         () => fixture(backend, async o => {
             const call = o.call("write", {entry : {type : "Job", fields : {n : 1}}});
             const signed = await o.signed(call);
             const auth = await o.verifier.check(
                 signed, {principal : {peerId : "router"}, roles : [ "router" ]}, o.conn);
             await o.leases.issue("router", o.routerKey.signer.keyId);
             await o.verifier.epochNotice(await o.leases.notice(1), o.info.spaceId);
             const client =
                 new PiSpaces(o.data, ctx, o.clock, undefined, "user", {authorization : auth});
             await assert.rejects(client.write({type : "Job", fields : {n : 1}}, null, FOREVER),
                                  DelegationDenied);
             assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 0);
         }));
for (const backend of BACKENDS)
    test(
        `${backend}: changed domain under same request fails, expired generation cannot create follow-up ID`,
        () => fixture(backend, async o => {
            const call =
                o.call("take", {template : {type : "Job"}, timeoutMs : FOREVER, waitMs : 0}, "old");
            const first = await o.invoke(call);
            assert.ok(first.ok);
            const changed = await o.invoke(
                {...call, args : {template : {type : "Other"}, timeoutMs : FOREVER, waitMs : 0}});
            assert.equal(changed.error.code, "RequestConflict");
            o.setNow(o.now + 8 * 24 * 3600 * 1000);
            o.setLease(await o.leases.issue("router", o.routerKey.signer.keyId));
            const target = o.target(call);
            const poll = await o.invoke({
                method : "pollOperation",
                space : o.info.spaceId,
                args : {targetRequest : call.request, waitMs : 0}
            },
                                        target);
            assert.ok(poll.ok, JSON.stringify(poll));
            assert.equal(poll.result.state, "pending");
            const cancel =
                await o.invoke(o.call("cancelOperation", {targetRequest : call.request}), target);
            assert.equal(cancel.error.code, "RequestExpired");
        }));

for (const backend of BACKENDS) {
    test(`${backend}: alias epoch notice fences the same stable Space ID`,
         () => fixture(backend, async o => {
             const c = o.call("write", {entry : {type : "Job", fields : {}}});
             const signed = await o.signed(c);
             await o.leases.issue("router", o.routerKey.signer.keyId);
             await o.verifier.epochNotice(await o.leases.notice(1), o.info.alias);
             assert.equal((await o.service().handle(signed, o.conn)).ok, false);
             assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 0);
         }));
    test(`${backend}: delegated events renew only the referenced waiter`,
         () => fixture(backend, async o => {
             const a = o.call("wait",
                              {template : {type : "Job"}, target : "mailbox", timeoutMs : FOREVER});
             const b = o.call("wait",
                              {template : {type : "Job"}, target : "mailbox", timeoutMs : FOREVER});
             const ar = await o.invoke(a), br = await o.invoke(b);
             assert.ok(ar.ok, JSON.stringify(ar));
             assert.ok(br.ok, JSON.stringify(br));
             const snap = async () => await o.data.commit(
                 async (tx: import("@earendil-works/pi-durable").Tx) =>
                     JSON.parse(JSON.stringify(await spaceDoc(tx, o.info.spaceId, o.now))),
                 ctx);
             const initial = await snap();
             const old = initial.waiters.map((w: any) => w.authorizedUntil);
             o.setNow(o.now + 10000);
             o.setLease(await o.leases.issue("router", o.routerKey.signer.keyId, o.lease.lease));
             const e = {method : "events", space : o.info.spaceId, args : {}} as Call;
             assert.ok((await o.invoke(e)).ok);
             assert.deepEqual((await snap()).waiters.map((w: any) => w.authorizedUntil), old);
             const r = await o.invoke(e, o.target(a));
             assert.ok(r.ok, JSON.stringify(r));
             const after = await snap();
             assert.ok(after.waiters[0].authorizedUntil > old[0]);
             assert.equal(after.waiters[1].authorizedUntil, old[1]);
         }));
}

for (const backend of BACKENDS)
    test(
        `${backend}: real TCP proof and FederationRpc preserve original principal and waiter winner`,
        () => fixture(backend, async o => {
            const server = await serveSpace(
                new ProvingService(o.service(),
                                   {keys : o.keys, gateHostId : "member", now : o.clock}),
                {
                    listen : {host : "127.0.0.1", port : 0},
                    connection : () => ({peerId : "router", credentials : {roles : [ "router" ]}})
                });
            const socket =
                socketTransport({host : "127.0.0.1", port : (server.address() as any).port});
            try {
                const binding = {
                    hostId : "member",
                    spaceId : o.info.spaceId,
                    authorityId : "authority",
                    dataIncarnation : o.info.incarnation,
                    primaryEpoch : 1
                };
                const state: any = {
                    policy : {
                        authorityId : "authority",
                        policyVersion : 1,
                        default : {mode : "local", member : "member"},
                        rules : [],
                        completionProfiles : []
                    },
                    members : {member : {id : "member", target : binding, state : "active"}}
                };
                const rpc = new FederationRpc({
                    state : async () => state,
                    transport : () => socket,
                    signer : o.routerKey.signer,
                    peerId : "router",
                    lease : async () => o.lease,
                    grant : o.grant,
                    now : o.clock
                });
                const router = new RouterController({
                    host : o.root,
                    ctx,
                    routerId : "tcp-router",
                    authorityId : "authority",
                    target : rpc,
                    assertAuthority : async () => {}
                });
                await router.recover();
                const f = new FederatedSpace({
                    host : o.root,
                    ctx,
                    id : "tcp-federation",
                    router,
                    state : async () => state,
                    io : rpc,
                    assertAuthority : async () => {},
                    now : o.clock
                });
                const principal = {peerId : "user"};
                await f.write({type : "Job", fields : {n : 1}}, {id : "tcp-write", principal});
                const taken: any = await f.take({type : "Job"}, {id : "tcp-take", principal});
                assert.equal(taken.fields.n, 1);
                assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 0);
                await assert.rejects(
                    f.takeWaiting({type : "Job"}, 10000, 5000, {id : "tcp-race", principal}),
                    FederationPending);
                await new PiSpaces(o.data, ctx, o.clock).write({type : "Job", fields : {n : 2}});
                const winner: any = await f.resume("tcp-race");
                assert.equal(winner.fields.n, 2);
                assert.equal(await new PiSpaces(o.data, ctx, o.clock).count(), 0);
                const claims = await o.data.commit(
                    async (tx: any) => JSON.parse(
                        JSON.stringify((await spaceDoc(tx, o.info.spaceId, o.now)).rpc!.claims)),
                    ctx);
                assert.ok(Object.values(claims).every((c: any) => c.principal.peerId === "user"));
            } finally {
                socket.close();
                await server.close();
            }
        }));

for (const backend of BACKENDS)
    test(
        `${backend}: composed Control Gate issues RouterLease and pinned policy only to proven router`,
        () => fixture(backend, async o => {
            const identity = {
                authenticate : () => ({principal : {peerId : 'router'}, roles : [ 'router' ]})
            };
            const authority = new GrantAuthority({
                authorityId : 'authority',
                hostId : 'control-host',
                signer : o.controlKey.signer,
                keys : o.keys,
                identity,
                refreshIdentity : async () => identity.authenticate(),
                now : o.clock
            });
            const verifier = new GrantVerifier({
                authorityId : 'authority',
                issuerHostId : 'control-host',
                algorithm : 'ed25519',
                publicKey : o.controlKey.publicKey,
                now : o.clock
            });
            const policy = new FederationPolicyAuthority({
                host : o.root,
                ctx,
                controlSpaceId : o.controlId,
                authorityId : 'authority',
                peerId : 'supervisor',
                signer : o.controlKey.signer,
                assertAuthority : async () => {}
            });
            await o.root.commit(async (tx: any) => {
                (await tx.doc(FederationRouting, o.controlId, null)).members.member = {
                    id : 'member',
                    state : 'active',
                    target : {
                        hostId : 'member',
                        spaceId : o.info.spaceId,
                        authorityId : 'authority',
                        dataIncarnation : o.info.incarnation,
                        primaryEpoch : 1
                    }
                };
            }, ctx);
            await policy.install({
                authorityId : 'authority',
                policyVersion : 1,
                rules : [],
                completionProfiles : [],
                default : {mode : 'local', member : 'member'}
            },
                                 0, async () => {});
            const runtime = await startFederationHost(o.root, ctx, {
                hostId : 'control-host',
                authorityId : 'authority',
                unsafeSkipBootGuardForTests : true,
                keys : o.keys,
                verifier,
                control : {host : o.root, authority, leases : o.leases, routing : policy},
                groupRoles : {'routers' : [ 'router' ]},
                directory : {
                    refresh : async () => {},
                    lookup : async ip => ip === '127.0.0.2' ? {
                        id : 'router',
                        name : 'router',
                        ip,
                        connected : true,
                        groups : [ 'routers' ]
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
                let remote: import('../src/remote.ts').RemoteSpace;
                remote = new (await import('../src/remote.ts')).RemoteSpace(socket, {
                    space : o.controlId,
                    signer : o.routerKey.signer,
                    expectedGateHostId : 'control-host',
                    ownPeerId : 'router',
                    grantProvider : () => remote.requestGrant(),
                    now : o.clock,
                    attempts : 1
                });
                await remote.authenticate();
                const lease = await remote.requestRouterLease();
                assert.equal(lease.lease.routerPeerId, 'router');
                assert.equal(lease.lease.routerEpoch, o.lease.lease.routerEpoch + 1);
                assert.equal((await remote.requestRoutingPolicy()).policy.policyVersion, 1);
                o.records.get('router').state = 'revoked';
                await assert.rejects(remote.requestRouterLease());
            } finally {
                socket.close();
                await runtime.close();
            }
        }));

for(const backend of BACKENDS)test(`${backend}: complete Root composition rejects a superseded owner lease`,()=>fixture(backend,async o=>{
 const {createFederationController}=await import('../src/federation-controller.ts');
 const server=await serveSpace(new ProvingService(o.service(),{keys:o.keys,gateHostId:'member',now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})});const socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});try{
 await o.root.commit(async(tx:any)=>{(await tx.doc(FederationRouting,o.controlId,null)).members.member={id:'member',state:'active',target:{hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1}};},ctx);
 let insideCommit=false,leaseRefreshes=0;
 const observedHost=new Proxy(o.root,{get(target,property){if(property==='commit')return(fn:any,c:any)=>target.commit(async(tx:any)=>{insideCommit=true;try{return await fn(tx);}finally{insideCommit=false;}},c);const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
 const controller=await createFederationController({host:observedHost,ctx,id:'complete-root',journalPartitions:8,controlSpaceId:o.controlId,authorityId:'authority',routerPeerId:'router',routerSigner:o.routerKey.signer,controlPeerId:'supervisor',controlSigner:o.controlKey.signer,controlPublicKey:o.controlKey.publicKey,transport:()=>socket,memberPin:async()=>({issuer:'member',algorithm:'ed25519',publicKey:o.controlKey.publicKey}),lease:async()=>{assert.equal(insideCommit,false,'lease renewal must never run inside the journal commit');leaseRefreshes++;await o.root.commit(()=>{},ctx);return o.lease;},grant:o.grant,assertAuthority:async()=>{},authorizeAdmin:async()=>{},now:o.clock});
 assert.equal(controller.partitionRouters.length,8);assert.ok(leaseRefreshes>0);
 await controller.policy.install({authorityId:'authority',policyVersion:1,rules:[],completionProfiles:[],default:{mode:'local',member:'member'}},0,async()=>{});await controller.space.write({type:'Job',fields:{n:1}},{id:'composition-write',principal:{peerId:'user'}});await o.leases.issue('router',o.routerKey.signer.keyId);await assert.rejects(controller.space.take({type:'Job'},{id:'old-owner-take',principal:{peerId:'user'}}),/superseded/);assert.equal(await new PiSpaces(o.data,ctx,o.clock).count(),1);
 }finally{socket.close();await server.close();}
}));

for(const backend of BACKENDS)test(`${backend}: typed wire resolution errors persist review and never resend effects`,()=>fixture(backend,async o=>{
 const server=await serveSpace(new ProvingService(o.service(),{keys:o.keys,gateHostId:'member',now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})});
 const socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});
 try {
  const target={hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1};
  const state:any={policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'member'},rules:[],completionProfiles:[]},members:{member:{id:'member',target,state:'active'}}};
  for(const code of ['PermissionDenied','RequestExpired','ResultExpired','IncarnationChanged','RequestConflict','TransactionError','CompletionViolation']) {
   let sends=0,polls=0;
   const transport={request:async(text:string)=>{const call=JSON.parse(text);if(call.method==='write'){sends++;throw new Error('failure before send');}if(call.method==='resolveOperation'){polls++;return JSON.stringify({ok:false,error:{code,message:'fixture resolution refusal'}});}return socket.request(text);}};
   const rpc=new FederationRpc({state:async()=>state,transport:()=>transport,signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock});
   const router=new RouterController({host:o.root,ctx,routerId:'review-'+code,authorityId:'authority',target:rpc,assertAuthority:async()=>{}});await router.recover();
   const spec=await rpc.step('member',{peerId:'user'},'write',{entry:{type:'Job',fields:{code}},txn:null,leaseMs:60000},1);
   await router.submit({id:'lost-'+code,area:'federation',steps:[spec]});
   assert.equal((await router.advance('lost-'+code)).steps[0]!.state,'unknown');
   assert.equal((await router.advance('lost-'+code)).state,'needsReview');
   await router.recover();assert.equal((await router.advance('lost-'+code)).state,'needsReview');
   assert.equal(sends,1);assert.equal(polls,1);assert.equal(await new PiSpaces(o.data,ctx,o.clock).count(),0);
  }
 }finally{socket.close();await server.close();}
}));

for(const backend of BACKENDS)test(`${backend}: signed current-epoch admission resolution retries one identity before send and after reply loss`,()=>fixture(backend,async o=>{
 const server=await serveSpace(new ProvingService(o.service(),{keys:o.keys,gateHostId:'member',now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})}),socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});
 try{
  const target={hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1},state:any={policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'member'},rules:[],completionProfiles:[]},members:{member:{id:'member',target,state:'active'}}};
  let sends=0,misses=0,receipts=0;const requests:string[]=[];
  const transport={request:async(text:string)=>{const call=JSON.parse(text);if(call.method==='write'){sends++;requests.push(JSON.stringify(call.request));if(sends===1)throw new Error('before send');const reply=await socket.request(text);if(sends===2)throw new Error('after durable reply');return reply;}const reply=await socket.request(text);if(call.method==='resolveOperation'){const v=JSON.parse(reply);if(v.ok&&v.result.state==='notAdmitted')misses++;if(v.ok&&v.result.state==='done')receipts++;}return reply;}};
  const rpc=new FederationRpc({state:async()=>state,transport:()=>transport,signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock}),router=new RouterController({host:o.root,ctx,routerId:'admission-root',authorityId:'authority',target:rpc,assertAuthority:async()=>{}});await router.recover();
  const spec=await rpc.step('member',{peerId:'user'},'write',{entry:{type:'Job',fields:{n:1}},txn:null,leaseMs:60000},1);await router.submit({id:'same-request',area:'federation',steps:[spec]});
  assert.equal((await router.advance('same-request')).steps[0]!.state,'unknown');
  assert.equal((await router.advance('same-request')).steps[0]!.state,'unknown');
  assert.equal((await router.advance('same-request')).state,'completed');
  await router.recover();assert.equal((await router.advance('same-request')).state,'completed');
  assert.equal(sends,2);assert.equal(misses,1);assert.equal(receipts,1);assert.equal(new Set(requests).size,1);assert.equal(await new PiSpaces(o.data,ctx,o.clock).count(),1);
  const oldMember=new FederationRpc({state:async()=>state,transport:()=>({request:async text=>JSON.parse(text).method==='resolveOperation'?JSON.stringify({ok:false,error:{code:'UnsupportedMethod',message:'old Member'}}):socket.request(text)}),signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock});
  assert.equal((await oldMember.resolve((await router.get('same-request'))!.steps[0]!)).outcome,'done');
  assert.equal(await new PiSpaces(o.data,ctx,o.clock).count(),1);
 }finally{socket.close();await server.close();}
}));

for(const backend of BACKENDS)test(`${backend}: definitive wire transaction errors stop Child dispatch instead of looping on missing admission`,()=>fixture(backend,async o=>{
 const server=await serveSpace(new ProvingService(o.service(),{keys:o.keys,gateHostId:'member',now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})}),socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});
 try{
  const target={hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1},state:any={policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'member'},rules:[],completionProfiles:[]},members:{member:{id:'member',target,state:'active'}}};
  for(const code of ['TransactionError','CompletionViolation']){
   let effects=0,polls=0;const transport={request:async(text:string)=>{const call=JSON.parse(text);if(call.method==='take'){effects++;return JSON.stringify({ok:false,error:{code,message:'expired transaction before claim admission'}});}if(call.method==='resolveOperation')polls++;return socket.request(text);}};
   const rpc=new FederationRpc({state:async()=>state,transport:()=>transport,signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock}),router=new RouterController({host:o.root,ctx,routerId:'definitive-'+code,authorityId:'authority',target:rpc,assertAuthority:async()=>{}});await router.recover();
   const spec=await rpc.step('member',{peerId:'user'},'take',{template:{type:'Job'},timeoutMs:0,txn:'expired'},1);await router.submit({id:'refused-'+code,area:'federation',steps:[spec]});
   assert.equal((await router.advance('refused-'+code)).state,'needsReview');await router.recover();const retained=await router.advance('refused-'+code);assert.equal(retained.state,'needsReview');assert.equal(retained.steps[0].evidence,code);assert.equal(effects,1);assert.equal(polls,0);assert.equal(await new PiSpaces(o.data,ctx,o.clock).count(),0);
  }
 }finally{socket.close();await server.close();}
}));

for(const backend of BACKENDS)test(`${backend}: inline replies still verify retained claims and every binding; legacy replies resolve separately`,()=>fixture(backend,async o=>{
 const server=await serveSpace(new ProvingService(o.service(),{keys:o.keys,gateHostId:'member',now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})}),socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});
 try{
  const target={hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1},state:any={policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'member'},rules:[],completionProfiles:[]},members:{member:{id:'member',target,state:'active'}}};
  let mode='valid',queries=0,effects=0;
  const transport={request:async(text:string)=>{
   const call=JSON.parse(text);if(call.method==='resolveOperation')queries++;
   const encoded=await socket.request(text);if(call.method!=='write')return encoded;effects++;
   const reply=JSON.parse(encoded);assert.ok(reply.ok);assert.ok(reply.claimReceipt,'Member must resolve the persisted original claim');
   if(mode==='legacy')delete reply.claimReceipt;
   else if(mode==='raw-result')reply.result={id:'wrong-unbound-result',expires:123};
   else if(mode==='missing-principal')delete reply.claimReceipt.binding.principal;
   else if(mode==='host')reply.claimReceipt.hostId='foreign-host';
   else if(mode==='principal')reply.claimReceipt.binding.principal={peerId:'foreign'};
   else if(mode==='request')reply.claimReceipt.binding.requestId='foreign-request';
   else if(mode==='hash')reply.claimReceipt.binding.argumentHash='0'.repeat(64);
   else if(mode==='incarnation')reply.claimReceipt.binding.dataIncarnation='foreign-incarnation';
   else if(mode==='epoch')reply.claimReceipt.binding.primaryEpoch=2;
   else if(mode==='restored')reply.claimReceipt.resolution.restoredHistory=true;
   else if(mode==='expired')reply.claimReceipt.resolution.resultExpired=true;
   else if(mode==='resolution-method')reply.claimReceipt.resolution.method='take';
   else if(mode==='missing-admission')reply.claimReceipt.resolution={state:'notAdmitted'};
   return JSON.stringify(reply);
  }};
  const rpc=new FederationRpc({state:async()=>state,transport:()=>transport,signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock}),router=new RouterController({host:o.root,ctx,routerId:'inline-witness',authorityId:'authority',target:rpc,assertAuthority:async()=>{}});await router.recover();
  const modes=['valid','raw-result','legacy','missing-principal','host','principal','request','hash','incarnation','epoch','restored','expired','resolution-method','missing-admission'];
  for(mode of modes){
   const id='witness-'+mode,spec=await rpc.step('member',{peerId:'user'},'write',{entry:{type:'Job',fields:{mode}},txn:null,leaseMs:60000},1);
   await router.submit({id,area:id,steps:[spec]});const before=queries,command=await router.advance(id);
   if(['valid','raw-result','legacy'].includes(mode)){assert.equal(command.state,'completed');assert.notEqual((command.steps[0]!.result as any).id,'wrong-unbound-result');assert.equal(queries-before,mode==='legacy'?1:0);}
   else {assert.equal(command.state,'needsReview');assert.equal(queries,before);const sent=effects;await router.recover();assert.equal((await router.advance(id)).state,'needsReview');assert.equal(effects,sent);}
  }
  assert.equal(await new PiSpaces(o.data,ctx,o.clock).count(),modes.length);assert.equal(effects,modes.length);
 }finally{socket.close();await server.close();}
}));

for(const backend of BACKENDS)test(`${backend}: transaction follow-ups reuse only a live bound admission namespace and still freshly authenticate`,()=>fixture(backend,async o=>{
 const server=await serveSpace(new ProvingService(o.service(),{keys:o.keys,gateHostId:'member',now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})}),socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});
 try{
  const target={hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1},state:any={policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'member'},rules:[],completionProfiles:[]},members:{member:{id:'member',target,state:'active'}}};
  let generations=0,proofs=0,effects=0;const transport={request:async(text:string)=>{const c=JSON.parse(text);if(c.method==='generation')generations++;if(c.method==='prove')proofs++;if(['take','write'].includes(c.method))effects++;return socket.request(text);}};
  const rpc=new FederationRpc({state:async()=>state,transport:()=>transport,signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock}),router=new RouterController({host:o.root,ctx,routerId:'generation-reuse',authorityId:'authority',target:rpc,assertAuthority:async()=>{}});await router.recover();
  await new PiSpaces(o.data,ctx,o.clock).write({type:'Job',fields:{n:1}});
  await router.submit({id:'begin',area:'begin',steps:[await rpc.step('member',{peerId:'user'},'txn',{action:'begin',leaseMs:60000},1)]});const begun=await router.advance('begin');assert.equal(begun.state,'completed');const origin=begun.steps[0]!,txn=(origin.result as any).id;assert.ok(origin.generationAdmitUntil!>o.now);const before=generations;
  await router.recover();const retained=(await router.get('begin'))!.steps[0]!;assert.equal(retained.generationAdmitUntil,origin.generationAdmitUntil);
  const take=await rpc.step('member',{peerId:'user'},'take',{template:{type:'Job'},timeoutMs:0,txn},1,retained);assert.equal(take.generation,origin.generation);assert.equal(generations,before);
  const priorProofs=proofs;await router.submit({id:'take',area:'take',steps:[take]});assert.equal((await router.advance('take')).state,'completed');assert.ok(proofs>priorProofs);assert.equal(effects,1);
  for(const bad of [{...origin,generationAdmitUntil:o.now},{...origin,generationAdmitUntil:undefined},{...origin,target:{...origin.target,dataIncarnation:'foreign'}},{...origin,principal:{peerId:'foreign'}}]){const n=generations;const spec=await rpc.step('member',{peerId:'user'},'write',{entry:{type:'Job',fields:{n:2}},txn},1,bad);assert.notEqual(spec.generation,origin.generation);assert.equal(generations,n+1);}
  const next=await rpc.step('member',{peerId:'user'},'write',{entry:{type:'Job',fields:{n:2}},txn},1,origin);await router.submit({id:'write',area:'write',steps:[next]});o.records.get('router').state='revoked';const prior=effects;const denied=await router.advance('write');assert.equal(denied.steps[0]!.state,'unknown');assert.equal(effects,prior);o.records.get('router').state='active';assert.equal((await router.advance('write')).state,'completed');assert.equal(effects,prior+1);
  await router.submit({id:'abort',area:'abort',steps:[await rpc.step('member',{peerId:'user'},'txn',{action:'abort',id:txn},1,origin)]});assert.equal((await router.advance('abort')).state,'completed');assert.equal(await new PiSpaces(o.data,ctx,o.clock).count(),1);
 }finally{socket.close();await server.close();}
}));

for(const backend of BACKENDS)test(`${backend}: a delegated resolution of an unknown request of an earlier epoch is NotCommitted only with promotion evidence`,()=>fixture(backend,async o=>{
 o.setReplica(1,1);
 const lost=o.call('write',{entry:{type:'Job',fields:{n:7}}});// never reached this Member
 o.setReplica(2,2);// promotion: epoch 2, configuration 2
 let proof:{hash:string}|null=null;const svc=()=>o.service({promotionProof:async()=>proof});
 const resolveCall={method:'resolveOperation' as const,space:o.info.spaceId,args:{targetRequest:lost.request as any,method:'write',argumentHash:o.target(lost).argumentHash,primaryEpoch:1}};
 const resolve=async()=>svc().handle(await o.signed(resolveCall as any,o.target(lost),{targetPrimaryEpoch:1,targetReplicaConfigVersion:2}),o.conn);
 const without=await resolve();assert.equal(without.ok,false);assert.equal((without as any).error.code,'IncarnationChanged','without evidence: review, not NotCommitted');
 proof={hash:'b'.repeat(64)};
 const decided=await resolve();assert.ok(decided.ok,JSON.stringify(decided));assert.equal((decided as any).result.error.code,'NotCommitted');
 assert.deepEqual(await resolve(),decided,'repeatable');
 // The late original call under the old epoch meets the negative claim.
 const late=await svc().handle(await o.signed(lost,undefined,{targetPrimaryEpoch:1,targetReplicaConfigVersion:2}),o.conn);
 assert.equal(late.ok,false);assert.equal((late as any).error.code,'NotCommitted',JSON.stringify(late));
 assert.equal(await new PiSpaces(o.data,ctx,o.clock).count({type:'Job',fields:{n:7}}),0);
 // The router turns it into a failed step without effect.
 const {FederationRpc}=await import('../src/federation-rpc.ts');
 const rpc=new FederationRpc({state:async()=>({policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'member'},rules:[],completionProfiles:[]},members:{}}) as any,transport:()=>({request:async()=>JSON.stringify(decided)}),signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock});
 const step:any={target:{hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1},principal:{peerId:'user'},generation:lost.request!.generation,requestId:lost.request!.requestId,method:'write',args:lost.args,policyVersion:1,state:'unknown'};
 const receipt=(rpc as any).checkedResolution(step,(decided as any).result);assert.equal(receipt.outcome,'failed');
}));

// v3 5.3.1 (decided 2026-10-18): after an adopted transition (degrade: same host, higher epoch; promotion: another
// host) the router resolves a step bound to the earlier target at the installed successor, with the bound epoch, and
// never sends its effect there.
for(const backend of BACKENDS)for(const promoted of [false,true])test(`${backend}: the router resolves a step of an earlier epoch at the installed successor${promoted?' on another host':''} and never resends its effect`,()=>fixture(backend,async o=>{
 o.setReplica(1,1);
 const lost=o.call('write',{entry:{type:'Job',fields:{n:7}}}),kept=o.call('write',{entry:{type:'Job',fields:{n:8}}});
 assert.ok((await o.invoke(kept,undefined,{targetReplicaConfigVersion:1})).ok,'confirmed before the transition');
 o.setReplica(2,2);// epoch 2, configuration 2 (degrade or promotion)
 const host=promoted?'member-b':'member',svc=o.service({hostId:host,promotionProof:async()=>({hash:'c'.repeat(64)})});
 const {FederationRpc}=await import('../src/federation-rpc.ts');
 const bound={hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1};
 const state={policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'m'},rules:[],completionProfiles:[]},
  members:{m:{id:'m',state:'active',target:{...bound,hostId:host,primaryEpoch:2},replication:{primaryReplica:host,replicaConfigVersion:2,durability:'single'}}}};
 let sent:string[]=[];
 const server=await serveSpace(new ProvingService(svc,{keys:o.keys,gateHostId:host,now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})}),socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});
 try{
 const rpc=new FederationRpc({state:async()=>state as any,transport:()=>({request:async(text:string)=>{sent.push(JSON.parse(text).method);return socket.request(text);}}) as any,signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock});
 const step=(c:any,state:string):any=>({target:bound,principal:{peerId:'user'},generation:c.request.generation,requestId:c.request.requestId,method:'write',args:c.args,policyVersion:1,state,resultBudgetBytes:4096,argHash:o.target(c).argumentHash});
 // The confirmed step keeps its result; the lost one is NotCommitted; neither sends an effect.
 const r1=await rpc.resolve(step(kept,'unknown'));assert.equal(r1.outcome,'done',JSON.stringify(r1));
 const r2=await rpc.resolve(step(lost,'unknown'));assert.deepEqual([r2.outcome,r2.evidence],['failed','NotCommitted'],JSON.stringify(r2));
 sent=[];const r3=await rpc.invoke(step(lost,'prepared'));assert.deepEqual([r3.outcome,r3.evidence],['failed','NotCommitted'],JSON.stringify(r3));
 assert.ok(!sent.includes('write'),'no effect sent to a successor under the old binding: '+sent.join(','));
 assert.deepEqual([r2.target,r3.target],[bound,bound],'receipts keep the bound target');
 assert.equal(await new PiSpaces(o.data,ctx,o.clock).count({type:'Job',fields:{n:7}}),0);
 // Another Space, incarnation or a lower installed epoch is no successor.
 for(const t of [{...bound,dataIncarnation:'other'},{...bound,spaceId:'sp-other'}])await assert.rejects(rpc.resolve({...step(lost,'unknown'),target:t}),/no longer installed/);
 state.members.m.target.primaryEpoch=1;state.members.m.target.hostId='member-c';await assert.rejects(rpc.resolve({...step(lost,'unknown'),target:{...bound,primaryEpoch:2}}),/no longer installed/);
 }finally{socket.close();await server.close();}
}));

// v3 5.3.1 step 5 (decided 2026-10-18): a routed write refused before admission while the router has not adopted the
// Member's replica configuration waits, then runs under the new binding once only notice adoptions changed the policy;
// any other policy change since keeps the refusal (review).
for(const backend of BACKENDS)test(`${backend}: a routed write in the ReplicaConfigPending window runs after the adoption; another policy change since makes it review`,()=>fixture(backend,async o=>{
 const server=await serveSpace(new ProvingService(o.service(),{keys:o.keys,gateHostId:'member',now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})}),socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});
 try{
  const target={hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1};
  const state:any={policy:{authorityId:'authority',policyVersion:1,default:{mode:'local',member:'m'},rules:[],completionProfiles:[]},noticePolicyVersions:[],
   members:{m:{id:'m',state:'active',target,replication:{primaryReplica:'member',replicaConfigVersion:1,durability:'sync',standbyReplica:'s'}}}};
  const rpc=new FederationRpc({state:async()=>state,transport:()=>socket,signer:o.routerKey.signer,peerId:'router',lease:async()=>o.lease,grant:o.grant,now:o.clock});
  const router=new RouterController({host:o.root,ctx,routerId:'pending-router',authorityId:'authority',target:rpc,assertAuthority:async()=>{}});await router.recover();
  const f=new FederatedSpace({host:o.root,ctx,id:'pending-federation',router,state:async()=>state,io:rpc,assertAuthority:async()=>{},now:o.clock}),principal={peerId:'user'};
  const count=(n:number)=>new PiSpaces(o.data,ctx,o.clock).count({type:'Job',fields:{n}});
  const adopt=(version:number,epoch=1)=>{state.policy.policyVersion++;state.noticePolicyVersions.push(state.policy.policyVersion);o.setPolicy(state.policy.policyVersion);state.members.m.replication.replicaConfigVersion=version;state.members.m.target={...state.members.m.target,primaryEpoch:epoch};};
  o.setReplica(1,1);await f.write({type:'Job',fields:{n:1}},{id:'w1',principal});
  // setStandby on the Member: configuration 2, the router has not adopted it yet.
  o.setReplica(2,1);
  await assert.rejects(f.write({type:'Job',fields:{n:2}},{id:'w2',principal}),FederationPending);
  await assert.rejects(f.write({type:'Job',fields:{n:2}},{id:'w2',principal}),FederationPending,'still waiting for the adoption');
  assert.equal(await count(2),0);
  adopt(2);
  await f.write({type:'Job',fields:{n:2}},{id:'w2',principal});assert.equal(await count(2),1,'runs once after the adoption');
  await f.write({type:'Job',fields:{n:2}},{id:'w2',principal});assert.equal(await count(2),1,'a retry returns the result');
  // A degrade (epoch 2) after the refusal: the step moves to the installed successor binding as well.
  o.setReplica(3,2);
  await assert.rejects(f.write({type:'Job',fields:{n:3}},{id:'w3',principal}),FederationPending);
  adopt(3,2);await f.write({type:'Job',fields:{n:3}},{id:'w3',principal});assert.equal(await count(3),1);
  // An ordinary policy change between refusal and adoption: the refusal stands.
  o.setReplica(4,2);
  await assert.rejects(f.write({type:'Job',fields:{n:4}},{id:'w4',principal}),FederationPending);
  state.policy.policyVersion++;o.setPolicy(state.policy.policyVersion);adopt(4,2);
  await assert.rejects(f.write({type:'Job',fields:{n:4}},{id:'w4',principal}),/review/);assert.equal(await count(4),0);
 }finally{socket.close();await server.close();}
}));
