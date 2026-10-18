import test from "node:test";
import assert from "node:assert/strict";
import {RouterController, RouterBlocked, RouterConflict, RouterBudgetExceeded, RouterJournal, type RouterOptions, type RouterTarget, type RouterStep, type RouterReceipt} from "../src/router.ts";
import {FederationSimulator, FederationReferenceModel, VirtualClock} from "./support/federation-simulator.ts";
import {BACKENDS, PersistentHome, ctx, InjectedFault} from "./support/persistent.ts";
import {PhiSpaces} from "../src/client.ts";
import {Space} from "../src/doc.ts";
import {FOREVER} from "../src/core.ts";

async function fixture(
    backend: typeof BACKENDS[number],
    f: (s: FederationSimulator, home: PersistentHome, o: RouterOptions) => Promise<void>) {
    const s = new FederationSimulator(backend, 71), home = new PersistentHome(backend);
    try {
        await s.add("a");
        await s.add("b");
        await s.add("c");
        const o: RouterOptions = {
            host: await home.open(),
            ctx,
            routerId: "router-1",
            authorityId: "authority-1",
            target: s,
            assertAuthority: async () => {},
            now: () => s.clock.now("router")
        };
        await f(s, home, o);
    } finally {
        await home.dispose();
        await s.dispose();
    }
}
for (const backend of BACKENDS) {
    test(
        `${backend}: lost take reply + duplicate + both restarts resolve one winner`,
        () => fixture(backend, async (s, home, o) => {
            await s.seed("a", {n: 1});
            await s.seed("a", {n: 2});
            let r = new RouterController(o);
            await r.recover();
            const step =
                await s.step("a", "take", {template: {type: "Job"}, timeoutMs: 0, waitMs: 0});
            await r.submit({id: "take", area: "jobs", steps: [step]});
            s.fault("a", {duplicate: true, dropReply: true, latencyMs: 10});
            assert.equal((await r.advance("take")).state, "applying");
            const prior = (await r.get("take"))!;
            home.crash(o.host as any);
            o.host = await home.open();
            await s.crash("a");
            await s.reopen("a");
            r = new RouterController(o);
            await assert.rejects(
                r.submit({id: "early", area: "jobs", steps: [step]}), RouterBlocked);
            await r.recover();
            const done = (await r.get("take"))!;
            assert.equal(done.state, "completed");
            assert.equal(done.steps[0]!.requestId, prior.steps[0]!.requestId);
            assert.equal((done.steps[0]!.result as any).fields.n, 1);
            assert.equal(
                await new PhiSpaces(s.nodes.get("a")!.host, ctx, () => s.clock.now("a")).count({
                    type: "Job"
                }),
                1);
            await s.assertInventory();
        }));
    for (const checkpoint of ["beforeSend", "afterReply"] as const)
        test(
            `${backend}: crash ${checkpoint} retains target and subrequest`,
            () => fixture(backend, async (s, home, o) => {
                await s.seed("a", {n: 1});
                let armed = true;
                o.checkpoint = async p => {
                    if (p === checkpoint && armed) {
                        armed = false;
                        throw new InjectedFault("router killed");
                    }
                };
                let r = new RouterController(o);
                await r.recover();
                const spec = {
                    id: "crash",
                    area: "jobs",
                    steps: [await s.step(
                        "a", "take", {template: {type: "Job"}, timeoutMs: 0, waitMs: 0})]
                };
                await r.submit(spec);
                await assert.rejects(r.advance(spec.id), InjectedFault);
                const id = (await r.get(spec.id))!.steps[0]!.requestId;
                home.crash(o.host as any);
                o.host = await home.open();
                r = new RouterController(o);
                await r.recover();
                const result = await r.advance(spec.id);
                assert.equal(result.state, "completed");
                assert.equal(result.steps[0]!.requestId, id);
                assert.equal(
                    await new PhiSpaces(s.nodes.get("a")!.host, ctx, () => s.clock.now("a")).count(),
                    0);
                await s.assertInventory();
            }));
    test(
        `${backend}: FOREVER waiter reconstructs without blocking an independent write`,
        () => fixture(backend, async (s, home, o) => {
            let r = new RouterController(o);
            await r.recover();
            const step =
                await s.step("a", "take", {template: {type: "Job"}, timeoutMs: FOREVER, waitMs: 0});
            await r.submit({id: "wait", area: "jobs", steps: [step]});
            assert.equal((await r.advance("wait")).steps[0]!.state, "pending");
            home.crash(o.host as any);
            o.host = await home.open();
            r = new RouterController(o);
            await r.recover();
            await r.submit({
                id: "write",
                area: "jobs",
                steps: [await s.step(
                    "a", "write", {entry: {type: "Job", fields: {n: 7}}, leaseMs: FOREVER})]
            });
            assert.equal((await r.advance("write")).state, "completed");
            assert.equal((await r.advance("wait")).state, "completed");
            await s.assertInventory();
        }));
    test(
        `${backend}: partition blocks dependent policy area, unrelated member remains usable`,
        () => fixture(backend, async (s, home, o) => {
            const r = new RouterController(o);
            await r.recover();
            await s.seed("a", {n: 1});
            await r.submit({
                id: "policy",
                area: "a-policy",
                blocksArea: true,
                steps: [await s.step("a", "take", {template: {type: "Job"}, waitMs: 0})]
            });
            s.partition("a");
            assert.equal((await r.advance("policy")).state, "applying");
            await r.recover();
            await assert.rejects(
                r.submit({
                    id: "dependent",
                    area: "a-policy",
                    steps: [await s.step("a", "write", {entry: {type: "Job", fields: {n: 2}}})]
                }),
                RouterBlocked);
            await r.recover();
            await r.submit({
                id: "unrelated",
                area: "b-policy",
                steps: [await s.step("b", "write", {entry: {type: "Job", fields: {n: 3}}})]
            });
            assert.equal((await r.advance("unrelated")).state, "completed");
            s.partition("a", false);
            assert.equal((await r.advance("policy")).state, "completed");
            await s.assertInventory();
        }));
    for (const cause of ["expiry", "incarnation", "missingHistory"] as const)
        test(
            `${backend}: ${cause} becomes needsReview without replacement or second winner`,
            () => fixture(backend, async (s, home, o) => {
                const r = new RouterController(o);
                await r.recover();
                await s.seed("a", {n: 1});
                await s.seed("a", {n: 2});
                await r.submit({
                    id: "review",
                    area: "jobs",
                    blocksArea: true,
                    steps: [await s.step("a", "take", {template: {type: "Job"}, waitMs: 0})]
                });
                s.fault("a", {dropReply: true});
                await r.advance("review");
                const old = (await r.get("review"))!.steps[0]!.requestId;
                if (cause === "expiry")
                    await s.clock.advance(8 * 24 * 60 * 60 * 1000);
                else if (cause === "incarnation")
                    await s.changeIncarnation("a");
                else
                    await s.nodes.get("a")!.host.commit(async tx => {
                        const d = await tx.doc(Space);
                        d.rpc!.claims = {};
                        d.rpc!.generations = {};
                        d.rpc!.bytes = 0;
                    }, ctx);
                const reviewed = await r.advance("review");
                assert.equal(reviewed.state, "needsReview");
                assert.equal(reviewed.steps[0]!.requestId, old);
                assert.equal(
                    await new PhiSpaces(s.nodes.get("a")!.host, ctx, () => s.clock.now("a")).count(),
                    1);
                assert.equal((await r.advance("review")).state, "needsReview");
                await r.review(
                    "review", "admin", "manual reconciliation preserves historical uncertainty",
                    true, async a => assert.equal(a, "admin"));
                assert.equal((await r.get("review"))!.state, "needsReview");
                await r.submit({
                    id: "independent",
                    area: "jobs",
                    steps: [await s.step("b", "write", {entry: {type: "Job", fields: {n: 3}}})]
                });
            }));
    test(
        `${backend}: changed command, result overflow and forged binding cannot cause retry`,
        () => fixture(backend, async (s, home, o) => {
            const r = new RouterController(o);
            await r.recover();
            await s.seed("a", {long: "x".repeat(200)});
            const step = await s.step("a", "take", {template: {type: "Job"}, waitMs: 0});
            step.resultBudgetBytes = 64;
            const spec = {id: "small", area: "jobs", steps: [step]};
            await r.submit(spec);
            await assert.rejects(
                r.submit(
                    {...spec, steps: [{...step, args: {template: {type: "Other"}, waitMs: 0}}]}),
                RouterConflict);
            await r.recover();
            assert.equal((await r.advance("small")).state, "needsReview");
            assert.equal(
                await new PhiSpaces(s.nodes.get("a")!.host, ctx, () => s.clock.now("a")).count(), 0);
            const forged: RouterTarget = {
                protocol: "phi-spaces-rpc-v1",
                resolve: s.resolve.bind(s),
                invoke: async st => ({...await s.invoke(st), requestId: "forged"})
            };
            const other = new RouterController({...o, routerId: "other", target: forged});
            await other.recover();
            await other.submit({
                id: "forged",
                area: "jobs",
                steps: [await s.step("b", "write", {entry: {type: "Job", fields: {n: 1}}})]
            });
            assert.equal((await other.advance("forged")).state, "needsReview");
            await s.assertInventory();
        }));
    test(
        `${backend}: budgets refuse before send, IDs retained, ack follows durable ingest`,
        () => fixture(backend, async (s, home, o) => {
            const r = new RouterController({...o, limits: {maxCommands: 1}});
            await r.recover();
            const step = await s.step("a", "write", {entry: {type: "Job", fields: {n: 1}}});
            let ack = 0;
            home.faults.arm("failBeforeCommit");
            await assert.rejects(r.ingest({id: "one", area: "jobs", steps: [step]}, async () => {
                ack++;
            }), InjectedFault);
            assert.equal(ack, 0);
            home.crash(o.host as any);
            o.host = await home.open();
            const reopened = new RouterController({...o, limits: {maxCommands: 1}});
            await reopened.recover();
            await reopened.ingest({id: "one", area: "jobs", steps: [step]}, async () => {
                assert.ok(await reopened.get("one"));
                ack++;
            });
            assert.equal(ack, 1);
            await reopened.advance("one");
            await assert.rejects(
                reopened.submit({id: "two", area: "jobs", steps: [step]}), RouterBudgetExceeded);
            assert.equal(
                await new PhiSpaces(s.nodes.get("a")!.host, ctx, () => s.clock.now("a")).count(), 1);
            assert.equal(s.trace.filter((e: any) => e.event === "invoke").length, 1);
        }));
    test(
        `${backend}: storage answer lost after command acceptance reconstructs exact reservation`,
        () => fixture(backend, async (s, home, o) => {
            let r = new RouterController(o);
            await r.recover();
            const step = await s.step("a", "write", {entry: {type: "Job", fields: {n: 1}}});
            home.faults.arm("loseAnswer");
            await assert.rejects(
                r.submit({id: "persisted", area: "jobs", steps: [step]}), InjectedFault);
            home.crash(o.host as any);
            o.host = await home.open();
            r = new RouterController(o);
            await r.recover();
            const c = await r.submit({id: "persisted", area: "jobs", steps: [step]});
            const i = await o.host.snapshot(RouterJournal, o.routerId, ctx);
            assert.equal(i!.reservedBytes, c.reservedBytes);
            assert.equal(Object.keys(i!.refs).length, 1);
            await r.advance("persisted");
            await s.assertInventory();
        }));
    test(
        `${backend}: sequential multi-target effects remain partial and resume bound step`,
        () => fixture(backend, async (s, home, o) => {
            let r = new RouterController(o);
            await r.recover();
            const steps = await Promise.all(["a", "b", "c"].map(
                id => s.step(
                    id, "write", {entry: {type: "Job", fields: {node: id}}, leaseMs: FOREVER})));
            await r.submit({id: "multi", area: "jobs", steps});
            s.partition("b");
            const partial = await r.advance("multi");
            assert.equal(partial.steps[0]!.state, "done");
            assert.equal(partial.steps[1]!.state, "unknown");
            assert.equal(partial.steps[2]!.state, "prepared");
            home.crash(o.host as any);
            o.host = await home.open();
            r = new RouterController(o);
            await r.recover();
            s.partition("b", false);
            assert.equal((await r.advance("multi")).state, "completed");
            await s.assertInventory();
            assert.equal(
                await new PhiSpaces(s.nodes.get("a")!.host, ctx, () => s.clock.now("a")).count(), 1);
        }));
}
test(
    "seeded multi-harness simulation reproduces sanitized trace and ordered clock events",
    async () => {
        const traces: any[] = [];
        for (let n = 0; n < 2; n++)
            await fixture("jsonl", async (s, home, o) => {
                const r = new RouterController(o);
                await r.recover();
                s.clock.jump("a", -5000);
                await r.submit({
                    id: "same",
                    area: "jobs",
                    steps: [await s.step("a", "write", {entry: {type: "Job", fields: {n: 1}}})]
                });
                s.fault("a", {dropBefore: true});
                await r.advance("same");
                await r.advance("same");
                traces.push(structuredClone(s.trace));
            });
        assert.deepEqual(traces[0], traces[1]);
        const clock = new VirtualClock(), order: number[] = [];
        clock.schedule(10, async () => {
            order.push(1);
        });
        clock.schedule(10, async () => {
            order.push(2);
        });
        clock.jump("node", -10000);
        await clock.advance(10);
        assert.deepEqual(order, [1, 2]);
        assert.equal(clock.tick, 10);
        assert.equal(clock.now("node"), 90010);
    });
test("independent reference model detects conflicting reservations and request winners", () => {
    const m = new FederationReferenceModel();
    m.inventory.set("gid", {node: "a", type: "Job", fields: {}});
    m.reserve("gid", "tx1");
    assert.throws(() => m.reserve("gid", "tx2"), /two reservation owners/);
    assert.throws(() => m.take("gid", "request"), /reservation/);
    m.finish("tx1", false);
    m.take("gid", "r1");
    assert.throws(() => m.take("gid", "r2"), /second take winner/);
    m.record("r1", "hash", "done", {gid: "gid"});
    assert.throws(() => m.record("r1", "changed", "done", {gid: "gid"}), /binding/);
    assert.throws(() => m.record("r1", "hash", "done", {gid: "other"}), /outcome/);
});
test("non-idempotent adapters and invalid budgets are rejected", () => {
    const target = {protocol: "http-post"} as unknown as RouterTarget;
    assert.throws(
        () => new RouterController({
            host: {} as any,
            ctx,
            routerId: "r",
            authorityId: "a",
            target,
            assertAuthority: async () => {}
        }),
        /idempotent/);
    assert.throws(
        () => new RouterController({
            host: {} as any,
            ctx,
            routerId: "r",
            authorityId: "a",
            target: {...target, protocol: "phi-spaces-rpc-v1"},
            assertAuthority: async () => {},
            limits: {maxCommands: 0}
        }),
        /budget/);
});
for (const backend of BACKENDS)
    test(
        `${backend}: actual transaction reservations survive duplicate replies and target restart`,
        () => fixture(backend, async (s, home, o) => {
            const r = new RouterController(o);
            await r.recover();
            const entry = await s.seed("a", {n: 1});
            await r.submit({
                id: "begin",
                area: "jobs",
                steps: [await s.step("a", "txn", {action: "begin", leaseMs: FOREVER})]
            });
            const tx = (await r.advance("begin")).steps[0]!.result as any;
            await r.submit({
                id: "reserved",
                area: "jobs",
                steps: [await s.step("a", "take", {template: {type: "Job"}, txn: tx.id, waitMs: 0})]
            });
            s.fault("a", {duplicate: true, dropReply: true});
            await r.advance("reserved");
            assert.equal(s.model.reservations.get(entry.gid!), tx.id);
            await s.crash("a");
            await s.reopen("a");
            await r.recover();
            assert.equal((await r.get("reserved"))!.state, "completed");
            await s.assertInventory();
            await r.submit({
                id: "competitor",
                area: "jobs",
                steps:
                    [await s.step("a", "take", {template: {type: "Job"}, timeoutMs: 0, waitMs: 0})]
            });
            assert.equal((await r.advance("competitor")).steps[0]!.result, null);
            await r.submit({
                id: "abort",
                area: "jobs",
                steps: [await s.step("a", "txn", {action: "abort", id: tx.id})]
            });
            s.fault("a", {duplicate: true});
            assert.equal((await r.advance("abort")).state, "completed");
            assert.equal(s.model.reservations.size, 0);
            await s.assertInventory();
            await r.submit({
                id: "winner",
                area: "jobs",
                steps: [await s.step("a", "take", {template: {type: "Job"}, waitMs: 0})]
            });
            assert.equal((await r.advance("winner")).state, "completed");
            await s.assertInventory();
        }));
for (const backend of BACKENDS)
    test(
        `${backend}: definitive failure differs from lost transport and prevents later steps`,
        () => fixture(backend, async (s, home, o) => {
            let sends = 0;
            const adapter: RouterTarget = {
                protocol: "phi-spaces-rpc-v1",
                invoke: async st => {
                    sends++;
                    return {
                        target: st.target,
                        principal: st.principal,
                        method: st.method,
                        generation: st.generation,
                        requestId: st.requestId,
                        argHash: st.argHash,
                        outcome: "failed",
                        evidence: "fixture: persisted final cancellation"
                    };
                },
                resolve: async () => {
                    throw new Error("should not resolve terminal failure");
                }
            };
            const r = new RouterController({...o, target: adapter});
            await r.recover();
            await r.submit({
                id: "fail",
                area: "jobs",
                steps: await Promise.all(["a", "b"].map(
                    id => s.step(id, "write", {entry: {type: "Job", fields: {n: 1}}})))
            });
            assert.equal((await r.advance("fail")).state, "failed");
            assert.equal((await r.advance("fail")).state, "failed");
            assert.equal(sends, 1);
            assert.equal(
                await new PhiSpaces(s.nodes.get("b")!.host, ctx, () => s.clock.now("b")).count(), 0);
        }));
for (const backend of BACKENDS)
    test(
        `${backend}: guard fences effects and journal reservation corruption fails closed`,
        () => fixture(backend, async (s, home, o) => {
            let allowed = true;
            const r = new RouterController({
                ...o,
                assertAuthority: async () => {
                    if (!allowed) throw new RouterBlocked("lease lost");
                }
            });
            await r.recover();
            const step = await s.step("a", "write", {entry: {type: "Job", fields: {n: 1}}});
            await r.submit({id: "fenced", area: "jobs", steps: [step]});
            allowed = false;
            await assert.rejects(r.advance("fenced"), RouterBlocked);
            assert.equal(s.trace.length, 0);
            allowed = true;
            await o.host.commit(async tx => {
                const index = await tx.doc(RouterJournal, o.routerId, null);
                index.reservedBytes++;
            }, ctx);
            await assert.rejects(r.recover(), /reservation reconstruction/);
            await assert.rejects(
                r.submit({id: "blocked", area: "jobs", steps: [step]}), RouterBlocked);
        }));
for (const backend of BACKENDS)
    test(
        `${backend}: restore barrier persists for prepared and decided subrequests without rewriting results`,
        () => fixture(backend, async (s, home, o) => {
            let r = new RouterController(o);
            await r.recover();
            await s.seed("a", {n: 1});
            const step = await s.step("a", "take", {template: {type: "Job"}, waitMs: 0});
            await r.submit({id: "decided", area: "jobs", blocksArea: true, steps: [step]});
            const done = await r.advance("decided");
            await r.submit({
                id: "unsent",
                area: "other",
                steps: [await s.step("a", "write", {entry: {type: "Job", fields: {n: 2}}})]
            });
            const count = s.trace.length;
            assert.deepEqual(
                (await r.reconcileDataRestore({
                    hostId: "a",
                    spaceId: step.target.spaceId,
                    oldIncarnation: step.target.dataIncarnation,
                    recoveryId: "restore-1"
                })).sort(),
                ["decided", "unsent"]);
            assert.deepEqual((await r.get("decided"))!.steps[0]!.result, done.steps[0]!.result);
            home.crash(o.host as any);
            o.host = await home.open();
            r = new RouterController(o);
            await r.recover();
            assert.equal((await r.advance("unsent")).state, "needsReview");
            assert.equal(s.trace.length, count, "restore must not dispatch old prepared requests");
            await assert.rejects(
                r.submit({id: "dependent-after-restore", area: "jobs", steps: [step]}),
                RouterBlocked);
        }));
for (const backend of BACKENDS)
    test(`${backend}: seeded faults across three members match independent inventory`, async () => {
        for (const seed of [3, 11, 29, 47, 83]) {
            await fixture(backend, async (s, home, o) => {
                const {SeededRandom} = await import("./support/federation-simulator.ts");
                const random = new SeededRandom(seed);
                let router = new RouterController(o);
                await router.recover();
                for (const id of ["a", "b", "c"])
                    for (let n = 0; n < 4; n++) await s.seed(id, {n});
                for (let n = 0; n < 12; n++) {
                    const target = ["a", "b", "c"][n % 3]!;
                    const step = await s.step(target, "take", {template: {type: "Job"}, waitMs: 0});
                    const id = `take-${n}`;
                    await router.submit({id, area: "jobs", steps: [step]});
                    s.fault(target, {
                        latencyMs: random.integer(40),
                        duplicate: random.next() < .5,
                        dropBefore: random.next() < .25,
                        dropReply: random.next() < .5
                    });
                    await router.advance(id);
                    if (random.next() < .4) {
                        await s.crash(target);
                        await s.reopen(target);
                    }
                    if (random.next() < .4) {
                        home.crash(o.host as any);
                        o.host = await home.open();
                        router = new RouterController(o);
                        await router.recover();
                    }
                    assert.equal((await router.advance(id)).state, "completed");
                    await s.assertInventory();
                }
                assert.equal(s.model.inventory.size, 0);
            });
        }
    });
for (const backend of BACKENDS)
    for (const fault of ["failBeforeCommit", "loseAnswer"] as const)
        test(
            `${backend}: ${fault} on result journal commit resolves target effect once`,
            () => fixture(backend, async (s, home, o) => {
                await s.seed("a", {n: 1});
                o.checkpoint = async point => {
                    if (point === "afterReply") home.faults.arm(fault);
                };
                let r = new RouterController(o);
                await r.recover();
                await r.submit({
                    id: "result-commit",
                    area: "jobs",
                    steps: [await s.step("a", "take", {template: {type: "Job"}, waitMs: 0})]
                });
                await assert.rejects(r.advance("result-commit"), InjectedFault);
                home.crash(o.host as any);
                o.host = await home.open();
                o.checkpoint = undefined;
                r = new RouterController(o);
                await r.recover();
                assert.equal((await r.advance("result-commit")).state, "completed");
                assert.equal(s.trace.filter((e: any) => e.event === "invoke").length, 1);
                await s.assertInventory();
            }));
for (const backend of BACKENDS)
    test(
        `${backend}: forward and backward host-clock jumps preserve fixed request decisions`,
        () => fixture(backend, async (s, home, o) => {
            const r = new RouterController(o);
            await r.recover();
            await r.submit({
                id: "finite",
                area: "jobs",
                steps: [await s.step(
                    "a", "take", {template: {type: "Job"}, timeoutMs: 1000, waitMs: 0})]
            });
            const pending = await r.advance("finite");
            assert.equal(pending.steps[0]!.state, "pending");
            const id = pending.steps[0]!.requestId;
            s.clock.jump("a", 2000);
            assert.equal((await r.advance("finite")).steps[0]!.result, null);
            s.clock.jump("a", -4000);
            await s.seed("a", {n: 1});
            assert.equal((await r.advance("finite")).steps[0]!.requestId, id);
            assert.equal(
                await new PhiSpaces(s.nodes.get("a")!.host, ctx, () => s.clock.now("a")).count(), 1);
            await s.assertInventory();
        }));
for (const backend of BACKENDS)
    test(
        `${backend}: transaction writes and lease expiry agree with independent model`,
        () => fixture(backend, async (s, home, o) => {
            const r = new RouterController(o);
            await r.recover();
            await r.submit({
                id: "begin-write",
                area: "jobs",
                steps: [await s.step("a", "txn", {action: "begin", leaseMs: "forever"})]
            });
            const tx = (await r.advance("begin-write")).steps[0]!.result as any;
            await r.submit({
                id: "uncommitted",
                area: "jobs",
                steps: [await s.step(
                    "a", "write",
                    {entry: {type: "Job", fields: {n: 1}}, txn: tx.id, leaseMs: "forever"})]
            });
            assert.equal((await r.advance("uncommitted")).state, "completed");
            await s.assertInventory();
            await r.submit({
                id: "commit-write",
                area: "jobs",
                steps: [await s.step("a", "txn", {action: "commit", id: tx.id})]
            });
            s.fault("a", {duplicate: true, dropReply: true});
            await r.advance("commit-write");
            assert.equal((await r.advance("commit-write")).state, "completed");
            await s.assertInventory();
            await r.submit({
                id: "expiring",
                area: "jobs",
                steps: [await s.step(
                    "b", "write", {entry: {type: "Job", fields: {n: 2}}, leaseMs: 1000})]
            });
            assert.equal((await r.advance("expiring")).state, "completed");
            s.clock.jump("b", 2000);
            await s.assertInventory();
            await r.submit({
                id: "after-expiry",
                area: "jobs",
                steps: [await s.step("b", "read", {template: {type: "Job"}, waitMs: 0})]
            });
            assert.equal((await r.advance("after-expiry")).steps[0]!.result, null);
            s.clock.jump("b", -4000);
            await s.assertInventory();
        }));
