import {rpcDomain} from "../../src/rpc-domain.ts";
// AP 2.8: real persistent harnesses + RPC claims; simulated transport, independent safety model.
import assert from "node:assert/strict";
import {PhiSpaces} from "../../src/client.ts";
import {SpaceService, StaticIdentity} from "../../src/service.ts";
import {Registry, spaceDoc} from "../../src/spaces.ts";
import {Space} from "../../src/doc.ts";
import {argHash, admit, keyOf, RequestExpired} from "../../src/claims.ts";
import {canonicalJson} from "../../src/canonical.ts";
import {FOREVER, type Json, type SpaceState} from "../../src/core.ts";
import type {RouterTarget, RouterStep, RouterReceipt, RouterStepSpec, TargetBinding} from "../../src/router.ts";
import {PersistentHome, ctx, type Backend} from "./persistent.ts";
import {plainDoc} from "./host.ts";
import type {Harness} from "@earendil-works/pi-durable";

export class VirtualClock {
    tick = 0;
    private sequence = 0;
    private queue: {at: number; seq: number; run: () => Promise<void>}[] = [];
    private offsets = new Map<string, number>();
    now(node: string): number {
        return 100000 + this.tick + (this.offsets.get(node) ?? 0);
    }
    jump(node: string, delta: number) {
        if (!Number.isSafeInteger(delta)) throw new TypeError("invalid clock jump");
        this.offsets.set(node, (this.offsets.get(node) ?? 0) + delta);
    }
    schedule(delay: number, run: () => Promise<void>) {
        if (!Number.isSafeInteger(delay) || delay < 0) throw new TypeError("invalid delay");
        this.queue.push({at: this.tick + delay, seq: this.sequence++, run});
    }
    async advance(delay: number) {
        if (!Number.isSafeInteger(delay) || delay < 0) throw new TypeError("invalid time advance");
        const end = this.tick + delay;
        for (;;) {
            this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
            const e = this.queue[0];
            if (!e || e.at > end) break;
            this.queue.shift();
            this.tick = e.at;
            await e.run();
        }
        this.tick = Math.max(this.tick, end);
    }
}
export class SeededRandom {
    private state: number;
    constructor(seed: number) {
        this.state = seed >>> 0 || 1;
    }
    next(): number {
        let x = this.state;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.state = x >>> 0;
        return this.state / 4294967296;
    }
    integer(max: number) {
        return Math.floor(this.next() * max);
    }
}
/** Separate model: requests never change outcome; reservations prevent a second winner. */
export class FederationReferenceModel {
    readonly requests = new Map < string, {
        hash: string;
        state: "pending"|"done"|"cancelled";
        result?: string
    }
    >();
    readonly inventory = new Map < string, {
        node: string;
        type: string;
        fields: Json;
        expires?: number;
        writtenUnder?: string
    }
    >();
    readonly reservations = new Map<string, string>();
    readonly transactions = new Map < string, {
        node: string;
        expires: number
    }
    >();
    private consumed = new Map<string, string>();
    record(request: string, hash: string, state: "pending"|"done"|"cancelled", result?: Json) {
        const old = this.requests.get(request),
              encoded = result === undefined ? undefined : canonicalJson(result);
        if (old) {
            assert.equal(hash, old.hash, "request argument binding changed");
            if (old.state !== "pending") {
                assert.equal(state, old.state, "decided request state changed");
                assert.equal(encoded, old.result, "decided request outcome changed");
                return false;
            }
        }
        this.requests.set(
            request, {hash, state, ...(encoded === undefined ? {} : {result: encoded})});
        return true;
    }
    reserve(gid: string, txn: string) {
        assert.ok(this.inventory.has(gid), "reservation of absent entry");
        const old = this.reservations.get(gid);
        assert.ok(!old || old === txn, "two reservation owners");
        this.reservations.set(gid, txn);
    }
    take(gid: string, request: string) {
        const old = this.consumed.get(gid);
        if (old) {
            assert.equal(old, request, "second take winner");
            return;
        }
        assert.ok(this.inventory.has(gid), "take of absent entry");
        assert.ok(!this.reservations.has(gid), "take crosses reservation");
        this.inventory.delete(gid);
        this.consumed.set(gid, request);
    }
    finish(txn: string, commit: boolean) {
        this.transactions.delete(txn);
        for (const [gid, entry] of this.inventory)
            if (entry.writtenUnder === txn) {
                if (commit)
                    delete entry.writtenUnder;
                else
                    this.inventory.delete(gid);
            }
        for (const [gid, owner] of this.reservations)
            if (owner === txn) {
                this.reservations.delete(gid);
                if (commit) this.take(gid, "txn:" + txn);
            }
    }
    settle(node: string, now: number) {
        for (const [txn, t] of this.transactions)
            if (t.node === node && t.expires <= now) this.finish(txn, false);
        for (const [gid, e] of this.inventory)
            if (e.node === node && (e.expires ?? FOREVER) <= now) {
                this.inventory.delete(gid);
                this.reservations.delete(gid);
            }
    }
}
export type NetworkFault = {
    latencyMs?: number;
    duplicate?: boolean;
    dropBefore?: boolean;
    dropReply?: boolean
};
type Node = {
    home: PersistentHome; host: Harness; service: SpaceService; alive: boolean;
    binding: TargetBinding
};
const principal = {
    peerId: "router-fixture"
};
export class FederationSimulator implements RouterTarget {
    readonly protocol = "phi-spaces-rpc-v1" as const;
    readonly clock = new VirtualClock();
    readonly model = new FederationReferenceModel();
    readonly trace: Json[] = [];
    readonly nodes = new Map<string, Node>();
    readonly random: SeededRandom;
    private partitions = new Set<string>();
    private faults = new Map<string, NetworkFault[]>();
    private generations = new Map<string, string>();
    readonly backend: Backend;
    constructor(backend: Backend, seed = 1) {
        this.backend = backend;
        this.random = new SeededRandom(seed);
    }
    private makeService(n: Node) {
        return new SpaceService({
            host: n.host,
            ctx,
            identity: new StaticIdentity({[principal.peerId]: {principal, roles: ["admin"]}}),
            hostId: n.binding.hostId,
            authorityId: n.binding.authorityId,
            primaryEpoch: n.binding.primaryEpoch,
            now: () => this.clock.now(n.binding.hostId),
            maxPollMs: 1,
            authorize:async(call)=>({validUntil:FOREVER,roles:["admin"],canExecutePending:()=>true,check:()=>{},allowClosedWaiter:call.method==="lease"&&call.args?.action==="cancel"&&!!call.frame?.delegation})
        });
    }
    async add(id: string) {
        if (this.nodes.has(id)) throw new Error("duplicate simulated host");
        const home = new PersistentHome(this.backend), host = await home.open(),
              binding: TargetBinding = {
                  hostId: id,
                  spaceId: "space-" + id,
                  authorityId: "authority-1",
                  dataIncarnation: "inc-" + id,
                  primaryEpoch: 1
              };
        await host.commit(async tx => {
            const s = await spaceDoc(tx, undefined, this.clock.now(id)), r = await tx.doc(Registry);
            r.hostId = id;
            r.hostKey = "fixture-key-" + id;
            r.defaultSpaceId = binding.spaceId;
            r.aliases = {default: binding.spaceId};
            r.spaces = {
                [binding.spaceId]: {
                    spaceId: binding.spaceId,
                    alias: "default",
                    incarnation: binding.dataIncarnation,
                    createdAt: 100000
                }
            };
            s.spaceId = binding.spaceId;
            s.incarnation = binding.dataIncarnation;
            s.primaryEpoch = 1;
        }, ctx);
        const n = {home, host, binding, alive: true, service: null as unknown as SpaceService};
        n.service = this.makeService(n);
        this.nodes.set(id, n);
        return n;
    }
    private node(id: string) {
        const n = this.nodes.get(id);
        if (!n) throw new Error("unknown simulated host");
        return n;
    }
    async step(id: string, method: RouterStepSpec["method"], args: Json): Promise<RouterStepSpec> {
        const n = this.node(id),
              g = await new PhiSpaces(n.host, ctx, () => this.clock.now(id), undefined, undefined, {
                      authorityId: n.binding.authorityId
                  }).issueGeneration(principal);
        this.generations.set(g.generation, "generation-" + (this.generations.size + 1));
        return {
            target: structuredClone(n.binding),
            principal,
            generation: g.generation,
            method,
            args
        };
    }
    partition(id: string, blocked = true) {
        if (blocked)
            this.partitions.add(id);
        else
            this.partitions.delete(id);
        this.trace.push({event: "partition", node: id, blocked, tick: this.clock.tick});
    }
    fault(id: string, f: NetworkFault) {
        const q = this.faults.get(id) ?? [];
        q.push(f);
        this.faults.set(id, q);
    }
    async crash(id: string) {
        const n = this.node(id);
        if (!n.alive) throw new Error("already crashed");
        n.home.crash(n.host);
        n.alive = false;
        this.trace.push({event: "crash", node: id, tick: this.clock.tick});
    }
    async reopen(id: string) {
        const n = this.node(id);
        if (n.alive) throw new Error("must crash before reopen");
        n.host = await n.home.open();
        n.service = this.makeService(n);
        n.alive = true;
        this.trace.push({event: "reopen", node: id, tick: this.clock.tick});
    }
    async changeIncarnation(id: string) {
        const n = this.node(id);
        n.binding = {...n.binding, dataIncarnation: n.binding.dataIncarnation + "-restored"};
        await n.host.commit(async tx => {
            const s = await tx.doc(Space), r = await tx.doc(Registry);
            s.incarnation = n.binding.dataIncarnation;
            r.spaces[n.binding.spaceId]!.incarnation = s.incarnation;
        }, ctx);
        this.trace.push({event: "restore", node: id, tick: this.clock.tick});
    }
    private receipt(
        s: Readonly<RouterStep>, outcome: RouterReceipt["outcome"], result?: Json,
        evidence?: string): RouterReceipt {
        return {
            target: structuredClone(s.target),
            principal: structuredClone(s.principal),
            method: s.method,
            generation: s.generation,
            requestId: s.requestId,
            argHash: s.argHash,
            outcome,
            ...(result === undefined ? {} : {result}),
            ...(evidence ? {evidence} : {})
        };
    }
    private binding(s: Readonly<RouterStep>, n: Node) {
        return canonicalJson(s.target as unknown as Json) ===
            canonicalJson(n.binding as unknown as Json);
    }
    private domain(s: Readonly<RouterStep>): {method: string; args: Json} {
        return rpcDomain({method:s.method,args:s.args as any},s.principal);
    }
    private async observe(n: Node, s: Readonly<RouterStep>, view: any) {
        const identity = canonicalJson(
            [s.principal, n.binding.spaceId, s.generation, s.requestId] as unknown as Json);
        const fresh = this.model.record(
            identity, s.argHash, view.state,
            view.state === "pending" ? undefined : view.result ?? null);
        if (!fresh || view.state !== "done" || view.error) return;
        const a = s.args as any;
        if (s.method === "take" && view.result) {
            const gid = view.result.gid;
            assert.equal(view.result.type, a.template?.type ?? view.result.type);
            for (const [k, v] of Object.entries(a.template?.fields ?? {}))
                assert.deepEqual(
                    view.result.fields[k], v, "target returned entry outside template");
            if (a.txn)
                this.model.reserve(gid, a.txn);
            else
                this.model.take(gid, identity);
        } else if (s.method === "txn" && a.action === "begin") {
            this.model.transactions.set(
                view.result.id, {node: n.binding.hostId, expires: view.result.expires});
        } else if (s.method === "txn" && a.action !== "begin") {
            this.model.finish(a.id, a.action === "commit");
        } else if (s.method === "write") {
            const lease = view.result;
            const gid = n.binding.spaceId + "/" + lease.id;
            this.model.inventory.set(gid, {
                node: n.binding.hostId,
                type: a.entry.type,
                fields: structuredClone(a.entry.fields ?? {}),
                expires: lease.expires,
                ...(a.txn ? {writtenUnder: a.txn} : {})
            });
        }
    }
    private async poll(n: Node, s: Readonly<RouterStep>): Promise<RouterReceipt> {
        const request = {principal: s.principal, generation: s.generation, requestId: s.requestId};
        try {
            const view = await new PhiSpaces(
                             n.host, ctx, () => this.clock.now(n.binding.hostId), undefined,
                             undefined, {authorityId: n.binding.authorityId})
                             .pollOperation(request);
            if (view.resultExpired || view.restoredHistory || view.unknownOutcome)
                return this.receipt(
                    s, "needsReview", undefined, "result expired or restored history");
            const snapshot = (await n.host.snapshot(Space, ctx))!,
                  claim = snapshot.rpc?.claims[keyOf(snapshot, request)], domain = this.domain(s);
            if (!claim || claim.argHash !== argHash(domain.method, domain.args))
                return this.receipt(s, "needsReview", undefined, "claim argument binding differs");
            await this.observe(n, s, view);
            return this.receipt(
                s,
                view.error                     ? "failed" :
                    view.state === "done"      ? "done" :
                    view.state === "cancelled" ? "cancelled" :
                                                 "pending",
                view.result, view.error?.code);
        } catch (e) {
            if (!(e instanceof RequestExpired)) throw e;
            // a plain copy; claims the own store keeps on the disk are read whole for it
            const snapshot = plainDoc(await n.host.snapshot(Space, ctx)) as SpaceState;
            try {
                const domain = this.domain(s);
                const proof = admit(
                    snapshot, this.clock.now(n.binding.hostId), request, domain.method, domain.args,
                    FOREVER);
                if (proof.kind === "fresh")
                    return this.receipt(
                        s, "notAdmitted", undefined, "valid generation and no admitted claim");
            } catch {
            }
            return this.receipt(s, "needsReview", undefined, "missing or expired request history");
        }
    }
    private async network(
        s: Readonly<RouterStep>, kind: "invoke"|"resolve",
        run: (n: Node) => Promise<RouterReceipt>) {
        const f = this.faults.get(s.target.hostId)?.shift() ?? {},
              delay = f.latencyMs ?? this.random.integer(20);
        await this.clock.advance(delay);
        this.trace.push({
            event: kind,
            node: s.target.hostId,
            requestId: s.requestId,
            generation: this.generations.get(s.generation) ?? "unknown-generation",
            tick: this.clock.tick,
            fault: f as unknown as Json
        });
        const n = this.node(s.target.hostId);
        if (!n.alive || this.partitions.has(s.target.hostId) || f.dropBefore)
            throw new Error("simulated transport unavailable");
        this.model.settle(n.binding.hostId, this.clock.now(n.binding.hostId));
        if (!this.binding(s, n))
            return this.receipt(
                s, "needsReview", undefined, "target incarnation/authority changed");
        const r = await run(n);
        if (f.duplicate) {
            const duplicate = await run(n);
            assert.deepEqual(duplicate, r, "same request produced divergent duplicate reply");
            this.trace.push({
                event: "duplicate",
                node: s.target.hostId,
                requestId: s.requestId,
                tick: this.clock.tick
            });
        }
        if (f.dropReply) throw new Error("reply lost after durable target commit");
        return r;
    }
    async invoke(s: Readonly<RouterStep>): Promise<RouterReceipt> {
        return this.network(s, "invoke", async n => {
            const reply = await n.service.handle(
                {
                    method: s.method,
                    space: s.target.spaceId,
                    request: {generation: s.generation, requestId: s.requestId},
                    frame: {authorityId: s.target.authorityId, primaryEpoch: s.target.primaryEpoch,...(s.targetRequest?{delegation:{} as Json}:{})},
                    args: s.args
                },
                {peerId: s.principal.peerId});
            if (!reply.ok) {
                if ([
                        "IncarnationChanged", "ResultExpired", "RequestExpired", "RequestConflict"
                    ].includes(reply.error.code))
                    return this.receipt(s, "needsReview", undefined, reply.error.code);
                throw new Error("target RPC " + reply.error.code);
            }
            return this.poll(n, s);
        });
    }
    async resolve(s: Readonly<RouterStep>): Promise<RouterReceipt> {
        return this.network(s, "resolve", n => this.poll(n, s));
    }
    async seed(id: string, fields: Record<string, Json>, type = "Job") {
        const n = this.node(id), p = new PhiSpaces(n.host, ctx, () => this.clock.now(id));
        await p.write({type, fields}, null, FOREVER);
        const entry = (await p.readAll({type})).at(-1)!;
        this.model.inventory.set(entry.gid!, {node: id, type, fields: structuredClone(fields)});
        return entry;
    }
    async assertInventory() {
        for (const [id, n] of this.nodes) {
            if (!n.alive) continue;
            const actual = await new PhiSpaces(n.host, ctx, () => this.clock.now(id)).readAll();
            const expected = [...this.model.inventory].filter(
                ([gid, e]) => e.node === id && !e.writtenUnder &&
                    (e.expires ?? FOREVER) > this.clock.now(id) &&
                    !this.model.reservations.has(gid));
            assert.deepEqual(
                actual.map(e => e.gid).sort(), expected.map(([gid]) => gid).sort(),
                "target inventory differs from independent model");
        }
    }
    async dispose() {
        for (const n of this.nodes.values()) await n.home.dispose();
    }
}
