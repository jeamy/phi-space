// AP 2.1: durable command orchestration. Boot/RouterLease/delegation wiring is AP 2.2.
import {defineDocFamily, type Session} from "@earendil-works/pi-durable";
import type {Context} from "@earendil-works/chord";
import {canonicalJson,digestJson} from "./canonical.ts";
import {argHash, ResultExpired, type Principal} from "./claims.ts";
import type {Json} from "./core.ts";
import { jsonCopy, jsonBytes } from "./json.ts";

export type TargetBinding = {
    hostId: string; spaceId: string; authorityId: string; dataIncarnation: string;
    primaryEpoch: number
};
export type RouterOperation = "write"|"read"|"take"|"txn"|"lease"|"wait"|"notify"|"cancelOperation";
export type RouterStepSpec = {
    target: TargetBinding; principal: Principal; generation: string; method: RouterOperation;
    args: Json; policyVersion?: number; targetRequest?: import("./delegation.ts").TargetRequest;
    resultBudgetBytes?: number; generationAdmitUntil?: number
};
export type RouterCommandSpec = {
    id: string; area: string;
    blocksArea?: boolean; steps: RouterStepSpec[]
};
export type CommandState = "accepted"|"applying"|"completed"|"failed"|"needsReview";
export type RouterStep = RouterStepSpec&{
    requestId: string;
    argHash: string;
    state: "prepared"|"inflight"|"pending"|"unknown"|"done"|"failed"|"needsReview";
    result?: Json;
    evidence?: string
};
export type RouterCommand = {
    id: string; area: string; blocksArea: boolean; hash: string; state: CommandState;
    steps: RouterStep[];
    reservedBytes: number;
    erased?:{commandId:string;originalHash:string;subjectHash:string};
    reviews: {at: number; admin: string; note: string; releaseArea: boolean}[]
};
export type RouterReceipt = {
    target: TargetBinding; principal: Principal; method: RouterOperation; generation: string;
    requestId: string;
    argHash: string;
    outcome: "done" | "pending" | "failed" | "cancelled" | "notAdmitted" | "needsReview";
    result?: Json;
    evidence?: string
};
/** An adapter must return bound durable claim evidence; transport errors NEVER prove failure. */
export interface RouterTarget {
    readonly protocol: "phi-spaces-rpc-v1";
    invoke(step: Readonly<RouterStep>): Promise<RouterReceipt>;
    resolve(step: Readonly<RouterStep>): Promise<RouterReceipt>;
    /** A step refused before admission: its new binding, 'wait' (retry later) or 'refuse' (the refusal stands). */
    reprepare?(step: Readonly<RouterStep>): Promise<RouterStepSpec | 'wait' | 'refuse'>
}
export type RouterLimits = {
    maxCommands: number; maxSteps: number; maxCommandBytes: number; maxIndexBytes: number;
    maxCommitBytes: number;
    maxJournalBytes: number;
    defaultResultBytes: number
};
export const DEFAULT_ROUTER_LIMITS: Readonly<RouterLimits> = Object.freeze({
    maxCommands: 128,
    maxSteps: 16,
    maxCommandBytes: 128 * 1024,
    maxIndexBytes: 32 * 1024,
    maxCommitBytes: 192 * 1024,
    maxJournalBytes: 4 * 1024 * 1024,
    defaultResultBytes: 16 * 1024
});
type Ref = {
    hash: string; state: CommandState; area: string; blocksArea: boolean; released: boolean;
    reservedBytes: number
};
type Index = {
    authorityId: string|null; mode: "recovering" | "ready"; limits: RouterLimits | null;
    refs: Record<string, Ref>;
    future?: Record<string, {slots: number; bytesPerSlot: number}>;
    reservedBytes: number
};
export const RouterJournal = defineDocFamily<Index, null>({
    kind: "phi-spaces.router-journal",
    version: 1,
    scope: "session",
    family: true,
    initial: () =>
        ({authorityId: null, mode: "recovering", limits: null, refs: {}, reservedBytes: 0})
});
export const RouterCommands = defineDocFamily<{command: RouterCommand | null}, null>({
    kind: "phi-spaces.router-command",
    version: 1,
    scope: "session",
    family: true,
    initial: () => ({command: null})
});
export class RouterBlocked extends Error {}
export class RouterConflict extends Error {}
export class RouterBudgetExceeded extends Error {}
const copy = jsonCopy;
const bytes = jsonBytes;
const hash = digestJson;
const ident = (id: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ||
        ["constructor", "prototype", "__proto__"].includes(id))
        throw new TypeError("invalid router identifier");
};
const boundedEvidence = (text: string): string => {
    let result = "";
    for (const char of text) { if (Buffer.byteLength(result + char) > 512) break; result += char; }
    return result;
};
const terminal = (s: CommandState) => ["completed", "failed", "needsReview"].includes(s);
const commandKey = (router: string, id: string) => hash([router, id]);
const specOf = (c: RouterCommand) => ({
    id: c.id,
    area: c.area,
    blocksArea: c.blocksArea,
    steps: c.steps.map(
        ({target, principal, generation, method, args, resultBudgetBytes,policyVersion,targetRequest,generationAdmitUntil}) =>
            ({target, principal, generation, method, args, resultBudgetBytes,policyVersion,targetRequest,generationAdmitUntil}))
});
export type RouterCommitHook=(command:Readonly<RouterCommand>,tx:import('@earendil-works/pi-durable').Tx,context:{roomBytes:number;releaseFuture:(id:string)=>void})=>Promise<void>;
export type RouterOptions = {
    host: Pick<Session, "commit"|"snapshot">; ctx: Context; routerId: string; authorityId: string;
    target: RouterTarget;
    assertAuthority: () => Promise<void>;
    now?: () => number;
    limits?: Partial<RouterLimits>;
    checkpoint?: (point: "beforeSend"|"afterReply", command: Readonly<RouterCommand>) =>
                  Promise<void>
};
/** One instance owns a journal. The supplied authority guard must fence competing owners. */
export class RouterController {
    private o: RouterOptions;
    private limits: RouterLimits;
    private ready = false;
    private tail: Promise < unknown >= Promise.resolve();
    constructor(o: RouterOptions) {
        ident(o.routerId);
        ident(o.authorityId);
        if (o.target.protocol !== "phi-spaces-rpc-v1" || typeof o.assertAuthority !== "function")
            throw new TypeError("idempotent target and authority guard required");
        this.o = o;
        this.limits = {...DEFAULT_ROUTER_LIMITS, ...o.limits};
        for (const v of Object.values(this.limits))
            if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError("invalid router budget");
    }
    get journalId(): string { return this.o.routerId; }
    private serial<T>(f: () => Promise<T>): Promise<T> {
        const p = this.tail.then(f);
        this.tail = p.catch(() => {});
        return p;
    }
    private async change<T>(
        f: (index: Index,
            tx: Parameters<Parameters<RouterOptions["host"]["commit"]>[0]>[0]) => Promise<T>):
        Promise<T> {
        await this.o.assertAuthority();
        try {
            return await this.o.host.commit(async tx => {
                const i = await tx.doc(RouterJournal, this.o.routerId, null);
                if (i.authorityId !== null && i.authorityId !== this.o.authorityId)
                    throw new RouterBlocked(
                        "journal authority changed; explicit restore reconciliation required");
                i.authorityId = this.o.authorityId;
                if (i.limits && hash(i.limits) !== hash(this.limits))
                    throw new RouterBlocked("persisted budget configuration differs");
                i.limits = this.limits;
                const r = await f(i, tx);
                if (bytes(i) > this.limits.maxIndexBytes)
                    throw new RouterBudgetExceeded("router index exceeds budget");
                await this.o.assertAuthority();
                return r;
            }, this.o.ctx);
        } catch (e) {
            if (!(e instanceof RouterConflict) && !(e instanceof RouterBudgetExceeded))
                this.ready = false;
            throw e;
        }
    }
    async get(id: string): Promise<RouterCommand|undefined> {
        ident(id);
        await this.o.assertAuthority();
        const d =
            await this.o.host.snapshot(RouterCommands, commandKey(this.o.routerId, id), this.o.ctx);
        return d?.command ? copy(d.command) : undefined;
    }
    private normalize(s: RouterCommandSpec): RouterCommand {
        ident(s.id);
        ident(s.area);
        if (!Array.isArray(s.steps) || s.steps.length < 1 || s.steps.length > this.limits.maxSteps)
            throw new TypeError("invalid command steps");
        const steps = s.steps.map((x, n) => {
            for (const k
                     of [x.target.hostId, x.target.spaceId, x.target.authorityId,
                         x.target.dataIncarnation, x.principal.peerId, x.generation])
                if (typeof k !== "string" || !k || k.length > 256)
                    throw new TypeError("incomplete target/request binding");
            if (x.principal.agentId !== undefined &&
                (!x.principal.agentId || x.principal.agentId.length > 128))
                throw new TypeError("invalid agent binding");
            if (!Number.isSafeInteger(x.target.primaryEpoch) || x.target.primaryEpoch < 1 ||
                x.target.authorityId !== this.o.authorityId)
                throw new RouterBlocked("target authority/epoch mismatch");
            if (!["write", "read", "take", "txn", "lease", "wait", "notify", "cancelOperation"]
                     .includes(x.method))
                throw new TypeError("non-idempotent command operation");
            if(x.generationAdmitUntil!==undefined&&(!Number.isSafeInteger(x.generationAdmitUntil)||x.generationAdmitUntil<0))throw new TypeError("invalid generation admission deadline");
            canonicalJson(x.args);
            const resultBudgetBytes = x.resultBudgetBytes ?? this.limits.defaultResultBytes;
            if (!Number.isSafeInteger(resultBudgetBytes) || resultBudgetBytes < 64)
                throw new TypeError("invalid result reservation");
            return {
                ...copy(x),
                resultBudgetBytes,
                requestId: "router-" + hash([this.o.routerId, s.id, n]),
                argHash: argHash(x.method, x.args),
                state: "prepared" as const
            };
        });
        const c: RouterCommand = {
            id: s.id,
            area: s.area,
            blocksArea: !!s.blocksArea,
            hash: "",
            state: "accepted",
            steps,
            reservedBytes: 0,
            reviews: []
        };
        c.hash = hash(specOf(c));
        c.reservedBytes =
            bytes(c) + steps.reduce((n, x) => n + x.resultBudgetBytes! + 512, 0) + 8192;
        if (c.reservedBytes > this.limits.maxCommandBytes ||
            c.reservedBytes + this.limits.maxIndexBytes + 4096 > this.limits.maxCommitBytes)
            throw new RouterBudgetExceeded(
                "command cannot reserve bounded results and commit overhead");
        return c;
    }
    private hookContext(i:Index,c:RouterCommand){return{roomBytes:this.limits.maxCommitBytes-bytes(i)-bytes(c)-8192,releaseFuture:(id:string)=>{ident(id);const r=i.future?.[id];if(r){i.reservedBytes-=r.slots*r.bytesPerSlot;delete i.future![id];}}};}
    private reserveFutureValue(i:Index,id:string,slots:number,bytesPerSlot:number){
        ident(id);if(!Number.isSafeInteger(slots)||slots<1||!Number.isSafeInteger(bytesPerSlot)||bytesPerSlot<1024||bytesPerSlot>this.limits.maxCommandBytes)throw new RouterBudgetExceeded('invalid future reservation');
        i.future??={};if(i.future[id])return;const count=Object.values(i.future).reduce((n,r)=>n+r.slots,0);
        if(Object.keys(i.refs).length+count+slots>this.limits.maxCommands||i.reservedBytes+slots*bytesPerSlot+this.limits.maxIndexBytes>this.limits.maxJournalBytes)throw new RouterBudgetExceeded('future child budget unavailable');
        i.future[id]={slots,bytesPerSlot};i.reservedBytes+=slots*bytesPerSlot;
        if(bytes(i)>this.limits.maxIndexBytes)throw new RouterBudgetExceeded('router index exceeds budget');
    }
    /** Only inside a caller-owned transaction with fresh authority guards before/after commit. */
    async reserveFutureIn(tx:import('@earendil-works/pi-durable').Tx,id:string,slots:number,bytesPerSlot=this.limits.maxCommandBytes){
        if(!this.ready)throw new RouterBlocked('router is recovering');const i=await tx.doc(RouterJournal,this.o.routerId,null);
        if(i.mode!=='ready'||i.authorityId!==this.o.authorityId||hash(i.limits)!==hash(this.limits))throw new RouterBlocked('reservation owner or budget changed');
        this.reserveFutureValue(i,id,slots,bytesPerSlot);
    }
    /** Reserve future child effects before admitting a composite operation. IDs are never recycled. */
    async reserveFuture(id:string,slots:number,bytesPerSlot=this.limits.maxCommandBytes):Promise<void>{
        await this.serial(async()=>{if(!this.ready)throw new RouterBlocked('router is recovering');await this.change(async i=>this.reserveFutureValue(i,id,slots,bytesPerSlot));});
    }
    async releaseFuture(id: string): Promise<void> {
        await this.serial(async()=>{ident(id);await this.o.assertAuthority();const current=await this.o.host.snapshot(RouterJournal,this.o.routerId,this.o.ctx);if(current?.authorityId!==this.o.authorityId)throw new RouterBlocked('reservation owner changed');if(!current.future?.[id])return;await this.change(async i=>{const r=i.future?.[id];if(r){i.reservedBytes-=r.slots*r.bytesPerSlot;delete i.future![id];}});});
    }
    async submit(spec: RouterCommandSpec, futureId?: string, admitted?:RouterCommitHook): Promise<RouterCommand> {
        const c = this.normalize(spec);
        return this.serial(async () => {
            if (!this.ready) throw new RouterBlocked("router is recovering");
            return this.change(async (i, tx) => {
                const d = await tx.doc(RouterCommands, commandKey(this.o.routerId, c.id), null);
                if (d.command) {
                    if (d.command.hash !== c.hash)
                        throw new RouterConflict("command ID already binds different arguments");
                    if(d.command.erased)throw new ResultExpired("Child command content was erased");
                    return copy(d.command);
                }
                if (Object.values(i.refs).some(
                        r => r.area === c.area && r.blocksArea && !r.released &&
                            r.state !== "completed" && r.state !== "failed"))
                    throw new RouterBlocked("routing area has unresolved policy/membership work");
                const reservation = futureId ? i.future?.[futureId] : undefined;
                if (futureId && (!reservation || reservation.slots < 1 || c.reservedBytes > reservation.bytesPerSlot)) throw new RouterBudgetExceeded("missing or insufficient child reservation");
                if (reservation) {reservation.slots--; i.reservedBytes -= reservation.bytesPerSlot;}
                const futureCount = Object.values(i.future ?? {}).reduce((n,r)=>n+r.slots,0);
                if (Object.keys(i.refs).length + futureCount >= this.limits.maxCommands ||
                    i.reservedBytes + c.reservedBytes + this.limits.maxIndexBytes > this.limits.maxJournalBytes)
                    throw new RouterBudgetExceeded(
                        "journal full; historical IDs must not be evicted for reuse");
                d.command = c;
                i.refs[c.id] = {
                    hash: c.hash,
                    state: c.state,
                    area: c.area,
                    blocksArea: c.blocksArea,
                    released: false,
                    reservedBytes: c.reservedBytes
                };
                i.reservedBytes += c.reservedBytes;
                await admitted?.(copy(c),tx,this.hookContext(i,c));
                return copy(c);
            });
        });
    }
    /** Ack only AFTER the mailbox command has been durably deduplicated into the journal. */
    async ingest(spec: RouterCommandSpec, ack: () => Promise<void>): Promise<RouterCommand> {
        const c = await this.submit(spec);
        await ack();
        return c;
    }
    private async update(id: string, f: (c: RouterCommand,tx:import("@earendil-works/pi-durable").Tx,i:Index) => void|Promise<void>): Promise<RouterCommand> {
        return this.change(async (i, tx) => {
            const d = await tx.doc(RouterCommands, commandKey(this.o.routerId, id), null);
            if (!d.command || !i.refs[id]) throw new RouterBlocked("missing command history");
            await f(d.command,tx,i);
            if (bytes(d.command) > d.command.reservedBytes)
                throw new RouterBudgetExceeded("reserved command bytes exceeded");
            i.refs[id]!.state = d.command.state;
            return copy(d.command);
        });
    }
    private verify(c: RouterCommand) {
        if(c.erased){if(c.hash!==c.erased.originalHash||c.state!=="completed"||c.steps.length||c.reviews.length)throw new RouterBlocked("invalid erased Child tombstone");return;}
        if (c.hash !== hash(specOf(c))) throw new RouterBlocked("command binding hash corrupted");
        for (const [n, s] of c.steps.entries())
            if (s.argHash !== argHash(s.method, s.args) ||
                s.requestId !== "router-" + hash([this.o.routerId, c.id, n]))
                throw new RouterBlocked("subrequest binding corrupted");
    }
    private async applyReceipt(id: string, n: number, r: RouterReceipt, completed?:RouterCommitHook): Promise<RouterCommand> {
        return this.update(id, async (c,tx,i) => {
            const s = c.steps[n]!;
            if (hash(r.target) !== hash(s.target) || hash(r.principal) !== hash(s.principal) ||
                r.method !== s.method || r.generation !== s.generation ||
                r.requestId !== s.requestId || r.argHash !== s.argHash) {
                s.state = "needsReview";
                s.evidence = "receipt binding mismatch";
                c.state = "needsReview";
                return;
            }
            if (!["done", "pending", "failed", "cancelled", "notAdmitted", "needsReview"].includes(
                    r.outcome)) {
                s.state = "needsReview";
                s.evidence = "invalid claim outcome";
                c.state = "needsReview";
                return;
            }
            if (bytes(r.result ?? null) > s.resultBudgetBytes!) {
                s.state = "needsReview";
                s.evidence = "result exceeds reservation; receipt hash " + hash(r);
                c.state = "needsReview";
                return;
            }
            s.evidence = boundedEvidence(r.evidence ?? r.outcome);
            if (r.outcome === "done") {
                s.state = "done";
                s.result = r.result ?? null;
            } else if (r.outcome === "failed" || r.outcome === "cancelled") {
                s.state = "failed";
                c.state = "failed";
            } else if (r.outcome === "needsReview") {
                s.state = "needsReview";
                c.state = "needsReview";
            } else
                s.state = r.outcome === "notAdmitted" ? "prepared" : "pending";
            if (c.steps.every(x => x.state === "done")) c.state = "completed";
            if(c.state==="completed")await completed?.(copy(c),tx,this.hookContext(i,c));
        });
    }
    private async resolve(c: RouterCommand, n: number,completed?:RouterCommitHook): Promise<RouterCommand> {
        let receipt: RouterReceipt;
        await this.o.assertAuthority();
        try {
            receipt = await this.o.target.resolve(copy(c.steps[n]!));
        } catch {
            return this.update(c.id, d => {
                d.steps[n]!.state = "unknown";
                d.steps[n]!.evidence = "resolution transport unavailable";
            });
        }
        return this.applyReceipt(c.id, n, receipt,completed);
    }
    /** Cold-start only: initialize empty journals in bounded, fenced commits; recover retained work normally. */
    static async recoverMany(controllers:readonly RouterController[]):Promise<void>{
        const all=[...new Set(controllers)];if(!all.length)return;
        const first=all[0]!,o=first.o;
        if(all.some(r=>r.ready||r.o.host!==o.host||r.o.ctx!==o.ctx||r.o.authorityId!==o.authorityId||r.o.assertAuthority!==o.assertAuthority))throw new RouterBlocked('batched recovery requires one inactive, fenced owner');
        const retained:RouterController[]=[];
        for(let n=0;n<all.length;n+=16){
            const batch=all.slice(n,n+16),empty:RouterController[]=[];await o.assertAuthority();
            await o.host.commit(async tx=>{
                await o.assertAuthority();
                for(const r of batch){const i=await tx.doc(RouterJournal,r.o.routerId,null);
                    if(i.authorityId!==null&&i.authorityId!==o.authorityId||i.limits&&hash(i.limits)!==hash(r.limits))throw new RouterBlocked('journal authority or budget changed');
                    if(Object.keys(i.refs).length||Object.keys(i.future??{}).length){retained.push(r);continue;}
                    if(i.reservedBytes!==0)throw new RouterBlocked('empty journal reservation mismatch');
                    i.authorityId=o.authorityId;i.limits=r.limits;i.mode='ready';
                    if(bytes(i)>r.limits.maxIndexBytes)throw new RouterBudgetExceeded('router index exceeds budget');empty.push(r);
                }
                await o.assertAuthority();
            },o.ctx);
            for(const r of empty)r.ready=true;
        }
        for(const r of retained)await r.recover();
    }
    async recover(): Promise<void> {
        return this.serial(async () => {
            this.ready = false;
            const refs = await this.change(async i => {
                i.mode = "recovering";
                return copy(i.refs);
            });
            let sum = 0;
            for (const [id, r] of Object.entries(refs)) {
                const c = await this.get(id);
                if (!c || c.hash !== r.hash || c.reservedBytes !== r.reservedBytes ||
                    c.area !== r.area || c.blocksArea !== r.blocksArea || c.state !== r.state)
                    throw new RouterBlocked("incomplete journal reconstruction");
                this.verify(c);
                sum += c.reservedBytes;
                if (!terminal(c.state)) {
                    const n = c.steps.findIndex(s => s.state !== "done");
                    if (n >= 0 && c.steps[n]!.state !== "prepared") await this.resolve(c, n);
                }
            }
            await this.change(async i => {
                const future = Object.values(i.future ?? {}).reduce((n,r)=>{if(!Number.isSafeInteger(r.slots)||r.slots<0||!Number.isSafeInteger(r.bytesPerSlot)||r.bytesPerSlot<1024||r.bytesPerSlot>this.limits.maxCommandBytes)throw new RouterBlocked("corrupt future reservation");return n+r.slots*r.bytesPerSlot;},0);
                if (sum + future !== i.reservedBytes || sum + future + this.limits.maxIndexBytes > this.limits.maxJournalBytes)
                    throw new RouterBlocked("reservation reconstruction mismatch");
                i.mode = "ready";
            });
            this.ready = true;
        });
    }
    async advance(id: string,completed?:RouterCommitHook): Promise<RouterCommand> {
        ident(id);
        return this.serial(async () => {
            if (!this.ready) throw new RouterBlocked("router is recovering");
            let c = await this.get(id);
            if (!c) throw new RouterBlocked("unknown command");
            this.verify(c);if(c.erased)throw new ResultExpired("Child command content was erased");
            const reprepared = new Set<number>();
            while (!terminal(c.state)) {
                const n = c.steps.findIndex(s => s.state !== "done");
                if (n < 0) throw new RouterBlocked("inconsistent command state");
                if (c.steps[n]!.state !== "prepared") {
                    c = await this.resolve(c, n,completed);
                    if (terminal(c.state)) break;
                    if ((c.steps[n] as RouterStep).state !== "prepared") return c;
                }
                // Refused before admission: prepare again under the current binding where that is allowed (v3 5.3.1).
                const s0 = c.steps[n]!;
                if (s0.evidence === "ReplicaConfigPending" || s0.evidence === "StalePolicyVersion") {
                    let next: RouterStepSpec | "wait" | "refuse" = "refuse";
                    try { next = this.o.target.reprepare ? await this.o.target.reprepare(copy(s0)) : "refuse"; } catch { return c; }
                    if (next === "wait") return c;
                    if (next === "refuse") return this.update(id, d => { d.steps[n]!.state = "needsReview"; d.state = "needsReview"; });
                    const spec = next;
                    c = await this.update(id, (d, _tx, i) => {
                        const s = d.steps[n]!;
                        s.target = copy(spec.target); s.generation = spec.generation; s.policyVersion = spec.policyVersion;
                        if (spec.generationAdmitUntil === undefined) delete s.generationAdmitUntil; else s.generationAdmitUntil = spec.generationAdmitUntil;
                        s.evidence = "prepared again under policy " + spec.policyVersion;
                        d.hash = hash(specOf(d)); i.refs[id]!.hash = d.hash;
                    });
                }
                c = await this.update(id, d => {
                    d.state = "applying";
                    d.steps[n]!.state = "inflight";
                });
                try {
                    await this.o.checkpoint?.("beforeSend", copy(c));
                } catch (e) {
                    this.ready = false;
                    throw e;
                }
                await this.o.assertAuthority();
                let receipt: RouterReceipt;
                try {
                    receipt = await this.o.target.invoke(copy(c.steps[n]!));
                } catch {
                    return this.update(id, d => {
                        d.steps[n]!.state = "unknown";
                        d.steps[n]!.evidence = "effect outcome unknown; resolve same request";
                    });
                }
                try {
                    await this.o.checkpoint?.("afterReply", copy(c));
                } catch (e) {
                    this.ready = false;
                    throw e;
                }
                c = await this.applyReceipt(id, n, receipt,completed);
                // Refused before admission: prepare it again at once (once per call), see above.
                const after = c.steps[n] as RouterStep;
                if (after.state === "prepared" && (after.evidence === "ReplicaConfigPending" || after.evidence === "StalePolicyVersion") && !reprepared.has(n)) { reprepared.add(n); continue; }
                if (after.state !== "done") return c;
            }
            return c;
        });
    }
    /** Data-restore step 5: persist review barriers without replay or changing retained results. */
    async reconcileDataRestore(o: {
        hostId: string; spaceId: string; oldIncarnation: string; recoveryId: string
    }): Promise<string[]> {
        ident(o.recoveryId);
        return this.serial(async () => {
            if (!this.ready) throw new RouterBlocked("router is recovering");
            const i = await this.o.host.snapshot(RouterJournal, this.o.routerId, this.o.ctx);
            const affected: string[] = [];
            for (const id of Object.keys(i?.refs ?? {})) {
                const c = await this.get(id);
                if (!c) throw new RouterBlocked("missing restore journal history");
                const matches = c.steps.some(
                    s => s.target.hostId === o.hostId && s.target.spaceId === o.spaceId &&
                        s.target.dataIncarnation === o.oldIncarnation);
                if (!matches) continue;
                await this.update(id, d => {
                    for (const s of d.steps)
                        if (s.target.hostId === o.hostId && s.target.spaceId === o.spaceId &&
                            s.target.dataIncarnation === o.oldIncarnation) {
                            s.state = "needsReview";
                            s.evidence = "data restore " + o.recoveryId +
                                ": historical outcome retained; recovery views require review";
                        }
                    d.state = "needsReview";
                });
                affected.push(id);
            }
            return affected;
        });
    }
    async review(
        id: string, admin: string, note: string, releaseArea: boolean,
        authorize: (admin: string) => Promise<void>): Promise<RouterCommand> {
        ident(id);
        ident(admin);
        if (!note || Buffer.byteLength(note) > 1024)
            throw new TypeError("bounded review note required");
        return this.serial(async () => {
            if (!this.ready) throw new RouterBlocked("router is recovering");
            await authorize(admin);
            return this.change(async (i, tx) => {
                const d = await tx.doc(RouterCommands, commandKey(this.o.routerId, id), null);
                if (d.command?.state !== "needsReview" || !i.refs[id] ||
                    d.command.reviews.length >= 4)
                    throw new RouterBlocked("review requires retained needsReview history");
                d.command.reviews.push({at: (this.o.now ?? Date.now)(), admin, note, releaseArea});
                if (bytes(d.command) > d.command.reservedBytes)
                    throw new RouterBudgetExceeded("review exceeds reservation");
                if (releaseArea) i.refs[id]!.released = true;
                await authorize(admin);
                return copy(d.command);
            });
        });
    }
}
