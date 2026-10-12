import assert from "node:assert/strict";
import test from "node:test";

import {generateKey, type KeyDirectory, type PeerKeyRec, ProvingService} from "./src/auth.ts";
import {argHash} from "./src/claims.ts";
import {PiSpaces} from "./src/client.ts";
import {FOREVER} from "./src/core.ts";
import {
    DelegationDenied,
    delegationForCall,
    DelegationVerifier,
    RouterLeaseAuthority,
    signDelegation,
    type TargetRequest
} from "./src/delegation.ts";
import {FederatedSpace, FederationPending} from "./src/federated-space.ts";
import {FederationPolicyAuthority, FederationRouting} from "./src/federation-policy.ts";
import {FederationRpc} from "./src/federation-rpc.ts";
import {GrantAuthority, GrantVerifier} from "./src/grants.ts";
import {RouterController} from "./src/router.ts";
import {rpcDomain} from "./src/rpc-domain.ts";
import {startFederationHost} from "./src/runtime.ts";
import {type Call, SpaceService, StaticIdentity} from "./src/service.ts";
import {serveSpace, socketTransport} from "./src/socket.ts";
import {createSpace, listSpaces, spaceDoc} from "./src/spaces.ts";
import {BACKENDS, ctx, InjectedFault, PersistentHome} from "./test/support/persistent.ts";

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
            now : clock
        });
        const conn = {peerId : "router", state : {proof : {keyId : routerKey.signer.keyId}}};
        const identity =
            new StaticIdentity({router : {principal : {peerId : "router"}, roles : [ "router" ]}});
        const service = () => new SpaceService({
            host : data,
            ctx,
            identity,
            hostId : "member",
            authorityId : "authority",
            primaryEpoch : 1,
            now : clock,
            maxPollMs : 1,
            authorize : (call, id, c) => verifier.check(call, id, c)
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
                    now : clock
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
                let remote: import('./src/remote.ts').RemoteSpace;
                remote = new (await import('./src/remote.ts')).RemoteSpace(socket, {
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
 const {createFederationController}=await import('./src/federation-controller.ts');
 const server=await serveSpace(new ProvingService(o.service(),{keys:o.keys,gateHostId:'member',now:o.clock}),{listen:{host:'127.0.0.1',port:0},connection:()=>({peerId:'router',credentials:{roles:['router']}})});const socket=socketTransport({host:'127.0.0.1',port:(server.address() as any).port});try{
 await o.root.commit(async(tx:any)=>{(await tx.doc(FederationRouting,o.controlId,null)).members.member={id:'member',state:'active',target:{hostId:'member',spaceId:o.info.spaceId,authorityId:'authority',dataIncarnation:o.info.incarnation,primaryEpoch:1}};},ctx);
 const controller=await createFederationController({host:o.root,ctx,id:'complete-root',journalPartitions:8,controlSpaceId:o.controlId,authorityId:'authority',routerPeerId:'router',routerSigner:o.routerKey.signer,controlPeerId:'supervisor',controlSigner:o.controlKey.signer,controlPublicKey:o.controlKey.publicKey,transport:()=>socket,memberPin:async()=>({issuer:'member',algorithm:'ed25519',publicKey:o.controlKey.publicKey}),lease:async()=>o.lease,grant:o.grant,assertAuthority:async()=>{},authorizeAdmin:async()=>{},now:o.clock});
 assert.equal(controller.partitionRouters.length,8);
 await controller.policy.install({authorityId:'authority',policyVersion:1,rules:[],completionProfiles:[],default:{mode:'local',member:'member'}},0,async()=>{});await controller.space.write({type:'Job',fields:{n:1}},{id:'composition-write',principal:{peerId:'user'}});await o.leases.issue('router',o.routerKey.signer.keyId);await assert.rejects(controller.space.take({type:'Job'},{id:'old-owner-take',principal:{peerId:'user'}}),/superseded/);assert.equal(await new PiSpaces(o.data,ctx,o.clock).count(),1);
 }finally{socket.close();await server.close();}
}));
