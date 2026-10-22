// Trusted entry-replication substrate. Not the full-state primary/sync commit protocol.
import { randomBytes } from 'node:crypto';
import type { Context } from './context.ts';
import type { StoreTx } from './store/types.ts';
import { defineDocFamily } from './store/documents.ts';
import { canonicalJson, digestJson } from './canonical.ts';
import type { SpaceHost } from './client.ts';
import type { Principal } from './claims.ts';
import { RequestConflict } from './claims.ts';
import { SnapshotExpired, ResourceExhausted, type Json, type Fields } from './core.ts';
import { advanceHybridClock, compareHybridClock, ReplicationClockError, validateHybridClock, type HybridClock } from './replication-clock.ts';
import { EntrySnapshotChunks, EntrySnapshotTransfers, EntrySnapshotMaintenance, type EntrySnapshotMaintenanceJob, type EntrySnapshotManifest, type EntrySnapshotPage, type EntrySnapshotSegment, type EntrySnapshotImport } from './entry-replication-transfer.ts';
import { EntryStreamCheckpoints, EntryStreamCursorConflict, type EntryStreamIdentity, type EntryStreamDescription, type EntryStreamPage, type EntryStreamCheckpoint, type EntryStreamResult } from './entry-replication-stream.ts';
import { strictJsonCopy } from './json.ts';
export type { EntrySnapshotManifest, EntrySnapshotPage, EntrySnapshotImport, EntrySnapshotMaintenanceJob } from './entry-replication-transfer.ts';
export type EntryReplicationRule = { type: string; variant: 'lww'; keyFields: string[] } | { type: string; variant: 'set' };
export type EntryReplicationConfig = {
 spaceId: string; authorityId: string; replicaId: string; incarnation: string;
 members: Array<{ replicaId: string; incarnation: string }>; rules: EntryReplicationRule[];
};
export type EntryMutation =
 | { kind: 'put' | 'add'; type: string; fields: Fields; owner: Principal; expiresAt: number | null }
 | { kind: 'delete'; type: string; fields: Fields; owner: Principal }
 | { kind: 'remove'; type: string; tags: string[]; owner: Principal }
 | { kind: 'renew'; type: string; tag: string; fields: Fields; owner: Principal; expiresAt: number | null }
 /** Erases every earlier change owned by `principal` (docs/abnahme/ap3-replikation.md, step 3); `owner` is the issuing admin. */
 | { kind: 'erase'; principal: Principal; owner: Principal }
 | RedactedMutation;
/**
 * An erased change: id, clock, type and owner stay, the content goes. `argumentHash` of its event stays the original's;
 * an lww change keeps only a hash of its canonical key, a renewal its tag.
 */
export type RedactedMutation = { kind: 'redacted'; type: string; owner: Principal; was: 'put' | 'add' | 'delete' | 'renew'; erase: string; keyHash?: string; tag?: string };
type ContentMutation = Extract<EntryMutation, { kind: 'put' | 'add' | 'delete' | 'renew' }>;
export type ReplicatedEntryChange = {
 originReplicaId: string; incarnation: string; seq: number; clock: HybridClock;
 requestId: string; argumentHash: string; mutation: EntryMutation;
};
/**
 * `dropped`: runs [first, last] of stream positions whose events compaction removed. Positions are assigned in logical
 * order and never reused; without runs, position = index + 1 (docs/abnahme/ap3-replikation.md, step 4).
 */
export type EntryReplicationState = { config: EntryReplicationConfig | null; configHash: string; clock: HybridClock; lastWallTime: number; seq: number; events: ReplicatedEntryChange[]; segments?: EntrySnapshotSegment[]; dropped?: Array<[number, number]>;
 /** Per origin: every change up to this sequence was held here and by every member; an unknown one is a removed one. */
 floor?: Record<string, number> };
/** Contiguous received sequence per origin (`canonical([replicaId, incarnation])`), advertised by `describeStream`. */
export type EntryVersionVector = Record<string, number>;
/** The last vector each peer advertised, as recorded here; `regressed` blocks compaction until the peer gets a new incarnation. */
export type EntryPeerVectors = { peers: Record<string, { incarnation: string; vector: EntryVersionVector; recordedAt: number; regressed?: true }> };
export const EntryReplicaPeers = defineDocFamily<EntryPeerVectors, null>({ kind: 'phi-spaces.entry-replica-peers', version: 1, scope: 'session', family: true, initial: () => ({ peers: {} }) });
/** Why nothing can be compacted, or what would be removed (docs/abnahme/ap3-replikation.md, step 4). */
export type EntryCompactionStatus = { blocked: string | null; events: number; droppable: number; floor: EntryVersionVector };
/** Expiry is judged this long after the deadline: the bound on remote clock skew. */
export const ENTRY_EXPIRY_GRACE_MS = 60_000;
export type EntryReplicationSnapshot = { version: 1; spaceId: string; authorityId: string; configHash: string; events: ReplicatedEntryChange[]; sha256: string };
export type ReplicatedEntryView = { id: string; type: string; fields: Fields; owner: Principal; expiresAt: number | null; clock: HybridClock; originReplicaId: string };
export class ReplicationConflict extends Error {}
export const EntryReplicas = defineDocFamily<EntryReplicationState, null>({ kind: 'phi-spaces.entry-replica', version: 2, scope: 'session', family: true,
 initial: () => ({ config: null, configHash: '', clock: { physical: 0, logical: 0 }, lastWallTime: 0, seq: 0, events: [], segments: [] }), migrate: v => ({ ...v, segments: v.segments ?? [] }) as EntryReplicationState });
const copy = <T>(v: T): T => strictJsonCopy(v, m => new ReplicationConflict(m));
const canonical = (v: unknown) => canonicalJson(v as Json);
const bytes = (v: unknown) => Buffer.byteLength(canonical(v));
const hash = digestJson;
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const number = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const exact = (v: object, keys: string[]) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export const entryChangeId = (e: Pick<ReplicatedEntryChange, 'originReplicaId' | 'incarnation' | 'seq'>) => canonical([e.originReplicaId, e.incarnation, e.seq]);
const origin = (e: { originReplicaId: string; incarnation: string }) => canonical([e.originReplicaId, e.incarnation]);
const contractHash = (c: EntryReplicationConfig) => hash({ spaceId: c.spaceId, authorityId: c.authorityId, members: c.members, rules: c.rules });
const key = (rule: Extract<EntryReplicationRule, { variant: 'lww' }>, fields: Fields) => canonical([rule.type, rule.keyFields.map(k => {
 if (!Object.hasOwn(fields, k)) throw new ReplicationConflict('missing lww key field'); return fields[k];
})]);
function configOf(input: EntryReplicationConfig): EntryReplicationConfig {
 const c = copy(input);
 if (!c || !exact(c, ['spaceId','authorityId','replicaId','incarnation','members','rules']) || ![c.spaceId,c.authorityId,c.replicaId,c.incarnation].every(id) || !Array.isArray(c.members) || !c.members.length || c.members.length > 32 || !Array.isArray(c.rules) || !c.rules.length || c.rules.length > 64) throw new ReplicationConflict('invalid replication configuration');
 if (c.members.some(m => !m || !exact(m,['replicaId','incarnation']) || !id(m.replicaId) || !id(m.incarnation)) || new Set(c.members.map(m=>m.replicaId)).size !== c.members.length || !c.members.some(m=>m.replicaId===c.replicaId && m.incarnation===c.incarnation)) throw new ReplicationConflict('invalid or missing replica membership');
 if (new Set(c.rules.map(r=>r.type)).size!==c.rules.length || c.rules.some(r=>!r || !id(r.type) || !['lww','set'].includes(r.variant) || (r.variant==='lww' ? !exact(r,['type','variant','keyFields']) || !Array.isArray(r.keyFields) || !r.keyFields.length || r.keyFields.length>16 || new Set(r.keyFields).size!==r.keyFields.length || r.keyFields.some(k=>!id(k)) : !exact(r,['type','variant'])))) throw new ReplicationConflict('invalid replication rules');
 c.members.sort((a,b)=>a.replicaId<b.replicaId?-1:1); c.rules.sort((a,b)=>a.type<b.type?-1:1);
 if (bytes(c)>8192) throw new ResourceExhausted('replica configuration exceeds 8 KiB'); return c;
}
export type EntryReplicationOptions = {
 host: SpaceHost; ctx: Context; config: EntryReplicationConfig;
 /** Fresh scoped authorization; the caller supplies the trusted transport/identity boundary. */
 authorize: (action: 'local' | 'import' | 'read' | 'export') => Promise<void>;
 /** Fresh boot/authority/deletion checks. Must reject frozen or obsolete replicas. */
 assertActive: () => Promise<void>;
 now?: () => number; clockUncertaintyMs: () => number;
 maxHistoryBytes?: number; maxBatchBytes?: number;
 /** Own changes stay at least this long, so a retried request finds its change (default 24 h, the claim retention). */
 requestRetentionMs?: number;
};
type ExportedSnapshot = { manifest: EntrySnapshotManifest; pages: EntrySnapshotPage[] };
const snapshotCaches = new WeakMap<object, Map<string, Map<string, ExportedSnapshot>>>();
const sha = (v: unknown): v is string => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const chunkKey = (documentKey: string, snapshotId: string, index: number) => hash([documentKey,snapshotId,index]);
const pageHash = (page: EntrySnapshotPage) => { const {sha256,...body}=page;return hash(body); };
const droppedCount = (runs: ReadonlyArray<[number, number]> = []) => runs.reduce((n,[a,b])=>n+b-a+1,0);
/** The stream position of each retained event, in logical order. */
export function positionsOf(count: number, runs: ReadonlyArray<[number, number]> = []): number[] {
 const out:number[]=[];let p=0,r=0;
 while(out.length<count){p++;while(r<runs.length&&runs[r]![1]<p)r++;if(r<runs.length&&runs[r]![0]<=p)continue;out.push(p);}
 return out;
}
const headOf = (s: Pick<EntryReplicationState, 'events' | 'dropped'>) => s.events.length + droppedCount(s.dropped);
const contiguous = (after: number, positions: number[]) => positions.every((p,n)=>p===after+n+1);
/** Sorted, merged union of position runs. */
function mergeRuns(...lists: ReadonlyArray<ReadonlyArray<[number, number]>>): Array<[number, number]> {
 const all=lists.flat().map(([a,b])=>[a,b] as [number,number]).sort((x,y)=>x[0]-y[0]),out:Array<[number,number]>=[];
 for(const r of all){const last=out.at(-1);if(last&&r[0]<=last[1]+1)last[1]=Math.max(last[1],r[1]);else out.push(r);}return out;
}
function runsOf(positions: number[]): Array<[number, number]> { return mergeRuns(positions.map(p=>[p,p] as [number,number])); }
const inRuns = (p: number, runs: ReadonlyArray<[number, number]>) => runs.some(([a,b])=>a<=p&&p<=b);
const memberKey = (m: { replicaId: string; incarnation: string }) => canonical([m.replicaId, m.incarnation]);
const manifestSeed = (manifest: EntrySnapshotManifest) => { const {seedHash,rootHash,...body}=manifest;return hash(body); };
export class EntryReplicationController {
 private o: EntryReplicationOptions; private config: EntryReplicationConfig; private configHash: string;
 readonly documentKey: string; readonly maxHistoryBytes: number; readonly maxBatchBytes: number;
 constructor(o: EntryReplicationOptions) {
  this.o = o; this.config = configOf(o.config); this.configHash = contractHash(this.config);
  this.documentKey = canonical([this.config.spaceId,this.config.replicaId,this.config.incarnation]);
  this.maxHistoryBytes = o.maxHistoryBytes ?? 16*1024*1024; this.maxBatchBytes = o.maxBatchBytes ?? 192*1024;
  if (!Number.isSafeInteger(this.maxHistoryBytes) || this.maxHistoryBytes<16384 || this.maxHistoryBytes>64*1024*1024 || !Number.isSafeInteger(this.maxBatchBytes) || this.maxBatchBytes<32768 || this.maxBatchBytes>192*1024) throw new ReplicationConflict('invalid replication byte limits');
 }
 private now() { const n=(this.o.now??Date.now)(); if(!number(n))throw new ReplicationClockError('invalid wall clock');return n; }
 private clockSafe(s: Pick<Readonly<EntryReplicationState>, 'lastWallTime'>, now: number) { const u=this.o.clockUncertaintyMs();if(!Number.isFinite(u)||u<0||u>=5000||s.lastWallTime-now>5000)throw new ReplicationClockError('clock uncertainty or backward jump blocks timed operations'); }
 private async check(action: Parameters<EntryReplicationOptions['authorize']>[0]) { await this.o.authorize(action);await this.o.assertActive(); }
 private bind(s: Readonly<EntryReplicationState>) { if(s.config && (s.configHash!==this.configHash || canonical(s.config)!==canonical(this.config)))throw new ReplicationConflict('stored replica configuration changed; explicit rebuild required'); }
 private tagOk(tag: unknown) { let v:unknown;try{v=JSON.parse(String(tag));}catch{return false;}return typeof tag==='string'&&Array.isArray(v)&&v.length===3&&number(v[2])&&v[2]>=1&&this.config.members.some(p=>p.replicaId===v[0]&&p.incarnation===v[1])&&canonical(v)===tag; }
 private validateMutation(m: EntryMutation) {
  const principalOk=(p:Principal|undefined)=>!!p&&typeof p==='object'&&exact(p,p.agentId===undefined?['peerId']:['peerId','agentId'])&&id(p.peerId)&&(p.agentId===undefined||id(p.agentId));
  if(m?.kind==='erase'){if(!exact(m,['kind','principal','owner'])||!principalOk(m.principal)||!principalOk(m.owner))throw new ReplicationConflict('invalid erase');return;}
  if(!m || !id(m.type) || !m.owner || !principalOk(m.owner))throw new ReplicationConflict('invalid mutation identity');
  const r=this.config.rules.find(r=>r.type===m.type);if(!r)throw new ReplicationConflict('type has no replication rule');
  if(m.kind==='redacted'){
   const keyed=r.variant==='lww',keys=['kind','type','owner','was','erase',...(keyed?['keyHash']:[]),...(m.was==='renew'?['tag']:[])];
   if(!exact(m,keys)||(keyed?!['put','delete'].includes(m.was):!['add','renew'].includes(m.was))||!this.tagOk(m.erase)||keyed&&!sha(m.keyHash)||m.was==='renew'&&!this.tagOk(m.tag))throw new ReplicationConflict('invalid redacted change');
   return;
  }
  if(m.kind==='remove') {
   if(r.variant!=='set'||!exact(m,['kind','type','tags','owner'])||!Array.isArray(m.tags)||m.tags.length>256||new Set(m.tags).size!==m.tags.length)throw new ReplicationConflict('invalid observed remove');
   for(const tag of m.tags){let v:unknown;try{v=JSON.parse(tag);}catch{throw new ReplicationConflict('invalid observed tag');}if(!Array.isArray(v)||v.length!==3||!number(v[2])||v[2]<1||!this.config.members.some(p=>p.replicaId===v[0]&&p.incarnation===v[1])||canonical(v)!==tag)throw new ReplicationConflict('unknown tag origin');}
  } else {
   const hasLease=m.kind==='put'||m.kind==='add'||m.kind==='renew';
   if(!exact(m,m.kind==='renew'?['kind','type','tag','fields','owner','expiresAt']:hasLease?['kind','type','fields','owner','expiresAt']:['kind','type','fields','owner']) || (r.variant==='lww' ? !['put','delete'].includes(m.kind) : !['add','renew'].includes(m.kind)) || !m.fields || typeof m.fields!=='object'||Array.isArray(m.fields) || hasLease&&m.expiresAt!==null&&!number(m.expiresAt))throw new ReplicationConflict('invalid replicated mutation');
   if(m.kind==='renew'){let tag:unknown;try{tag=JSON.parse(m.tag);}catch{throw new ReplicationConflict('invalid renewal tag');}if(!Array.isArray(tag)||tag.length!==3||!number(tag[2])||tag[2]<1||!this.config.members.some(p=>p.replicaId===tag[0]&&p.incarnation===tag[1])||canonical(tag)!==m.tag)throw new ReplicationConflict('unknown renewal tag');}
   if(bytes(m.fields)>64*1024)throw new ResourceExhausted('entry fields exceed 64 KiB');if(r.variant==='lww')key(r,m.fields);
  }
 }
 private validateEvent(e: ReplicatedEntryChange, now: number) {
  if(!e || !exact(e,['originReplicaId','incarnation','seq','clock','requestId','argumentHash','mutation']) || !this.config.members.some(m=>m.replicaId===e.originReplicaId&&m.incarnation===e.incarnation)||!number(e.seq)||e.seq<1||!id(e.requestId)||typeof e.argumentHash!=='string'||!/^[a-f0-9]{64}$/.test(e.argumentHash))throw new ReplicationConflict('invalid change identity or retired origin');
  validateHybridClock(e.clock);if(e.clock.physical-now>60000)throw new ReplicationClockError('remote clock exceeds future bound');this.validateMutation(e.mutation);
  // A redacted change keeps the original's argument hash (that is how a later original is recognised and dropped).
  if(e.mutation.kind!=='redacted'&&e.argumentHash!==hash(e.mutation))throw new ReplicationConflict('changed mutation argument hash');
 }
 /**
  * The same change in original and redacted form: an original arriving after its redaction is dropped, a redaction
  * replaces a local original; of two redactions the one by the smaller erase ID wins.
  */
 private equivalent(local: ReplicatedEntryChange, incoming: ReplicatedEntryChange): 'same' | 'replace' | 'conflict' {
  if(canonical(local)===canonical(incoming))return 'same';
  const {mutation:a,...ia}=local,{mutation:b,...ib}=incoming;
  if(canonical(ia)!==canonical(ib)||a.kind!=='redacted'&&b.kind!=='redacted')return 'conflict';
  const typeOwner=(m:EntryMutation)=>m.kind==='erase'?'':canonical([m.type,m.owner]);if(typeOwner(a)!==typeOwner(b))return 'conflict';
  if(a.kind==='redacted'&&b.kind==='redacted')return b.erase<a.erase?'replace':'same';
  if(a.kind==='redacted')return hash(b)===local.argumentHash?'same':'conflict';
  return hash(a)===incoming.argumentHash?'replace':'conflict';
 }
 private redact(e: ReplicatedEntryChange, erase: string): ReplicatedEntryChange {
  const m=e.mutation as ContentMutation,r=this.config.rules.find(r=>r.type===m.type)!;
  const red:RedactedMutation={kind:'redacted',type:m.type,owner:copy(m.owner),was:m.kind,erase,...(r.variant==='lww'?{keyHash:hash(key(r,m.fields))}:{}),...(m.kind==='renew'?{tag:m.tag}:{})};
  return {...copy(e),mutation:red};
 }
 /** Redacts, in place, every change owned by an erased principal with a clock before the erase (smallest erase ID wins). */
 private applyErasures(events: ReplicatedEntryChange[]): number {
  const erases=events.filter(e=>e.mutation.kind==='erase');if(!erases.length)return 0;let n=0;
  // Each erase's principal and change ID once, not again for every event compared against it.
  const keyed=erases.map(x=>({x,principal:canonical((x.mutation as Extract<EntryMutation,{kind:'erase'}>).principal),id:entryChangeId(x)}));
  for(let i=0;i<events.length;i++){
   const e=events[i]!,m=e.mutation;if(m.kind==='erase'||m.kind==='remove')continue;
   const owner=canonical(m.owner);let best:string|undefined;
   for(const {x,principal,id:xid} of keyed){if(principal!==owner||compareHybridClock(e.clock,x.clock)>=0)continue;if(best===undefined||xid<best)best=xid;}
   if(best===undefined)continue;
   if(m.kind==='redacted'){if(m.erase<=best)continue;events[i]={...e,mutation:{...m,erase:best}};n++;continue;}
   events[i]=this.redact(e,best);n++;
  }
  // A renewal copies its tag's fields: whatever its clock, it is redacted with an erased tag (chains to a fixpoint).
  for(let changed=true;changed;){changed=false;const at=new Map(events.map((e,i)=>[entryChangeId(e),i]));
   for(let i=0;i<events.length;i++){const e=events[i]!,m=e.mutation;if(m.kind!=='renew')continue;const t=events[at.get(m.tag)??-1]?.mutation;
    if(t?.kind==='redacted'){events[i]=this.redact(e,t.erase);n++;changed=true;}}}
  return n;
 }
 private budget(events: ReplicatedEntryChange[]) { if(2*bytes(events)+16384>this.maxBatchBytes)throw new ResourceExhausted('replication batch exceeds atomic import budget'); }
 private append(s: EntryReplicationState, incoming: ReplicatedEntryChange[], now: number) {
  const known=new Map(s.events.map(e=>[entryChangeId(e),e])),requests=new Set(s.events.map(e=>canonical([e.originReplicaId,e.incarnation,e.requestId]))),accepted:ReplicatedEntryChange[]=[];let replaced=0;
  for(const event of incoming){
   this.validateEvent(event,now);const k=entryChangeId(event),old=known.get(k);
   if(old){const verdict=this.equivalent(old,event);if(verdict==='conflict')throw new ReplicationConflict('immutable change ID reused');if(verdict==='replace'){known.set(k,copy(event));replaced++;}continue;}
   // Below the floor every change was held here: an unknown one was compacted away and must not come back.
   if(event.seq<=(s.floor?.[origin(event)]??0))continue;
   const request=canonical([event.originReplicaId,event.incarnation,event.requestId]);if(requests.has(request))throw new ReplicationConflict('origin request ID reused');
   known.set(k,event);requests.add(request);accepted.push(event);
  }
  // Sort once per origin rather than rescanning the entire history for every imported event.
  const origins=new Map<string,ReplicatedEntryChange[]>();
  for(const event of known.values()){const k=origin(event),items=origins.get(k)??[];items.push(event);origins.set(k,items);}
  for(const items of origins.values()){
   items.sort((a,b)=>a.seq-b.seq);for(let n=1;n<items.length;n++)if(compareHybridClock(items[n-1]!.clock,items[n]!.clock)>=0)throw new ReplicationConflict('origin clock is not strictly monotonic');
  }
  for(const event of known.values())if(event.mutation.kind==='remove')for(const tag of event.mutation.tags){
   const observed=known.get(tag),om=observed?.mutation as ContentMutation|RedactedMutation|undefined,kind=om?.kind==='redacted'?om.was:om?.kind;
   if(observed&&(!['add','renew'].includes(kind!)||om!.type!==event.mutation.type))throw new ReplicationConflict('remove references another type or a non-add');
  }
  for(const event of known.values())if(event.mutation.kind==='renew'){
   const m=event.mutation,observed=known.get(m.tag);
   if(entryChangeId(event)===m.tag)throw new ReplicationConflict('renewal cannot reference itself');
   // A renewal of an erased tag stays and is invisible (read); it is not compared with erased content.
   if(observed&&observed.mutation.kind!=='redacted'){const old=observed.mutation as ContentMutation;if(!['add','renew'].includes(old.kind)||old.type!==m.type||canonical(old.owner)!==canonical(m.owner)||!('fields'in old)||canonical(old.fields)!==canonical(m.fields)||compareHybridClock(observed.clock,event.clock)>=0)throw new ReplicationConflict('renewal must preserve an earlier tag fields and owner');}
  }
  if(replaced)s.events=s.events.map(e=>known.get(entryChangeId(e))!);
  for(const event of accepted){s.events.push(copy(event));s.clock=advanceHybridClock(s.clock,now,event.clock);if(event.originReplicaId===this.config.replicaId&&event.incarnation===this.config.incarnation)s.seq=Math.max(s.seq,event.seq);}
  this.applyErasures(s.events);
  if(accepted.length){s.lastWallTime=Math.max(s.lastWallTime,now);if(bytes(s)>this.maxHistoryBytes)throw new ResourceExhausted('replica history is full; no tombstone or dedup record was discarded');}
  return accepted.length;
 }

 async mutate(requestId: string, mutation: EntryMutation): Promise<ReplicatedEntryChange> {
  const m=copy(mutation);if(!id(requestId))throw new ReplicationConflict('invalid request ID');if(m?.kind==='redacted')throw new ReplicationConflict('a redacted change only arrives by replication');this.validateMutation(m);const argumentHash=hash(m);
  await this.check('local');return this.o.host.commit(async tx=>{
   await this.check('local');const s=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(s);
   const logical=await this.materializeIn(tx,s),previous=logical.events.length;
   const old=logical.events.find(e=>e.originReplicaId===this.config.replicaId&&e.incarnation===this.config.incarnation&&e.requestId===requestId);
   if(old){if(old.argumentHash!==argumentHash)throw new RequestConflict('replication request changed arguments');await this.check('local');return copy(old);}
   const now=this.now();this.clockSafe(s,now);
   if(m.kind==='remove')for(const tag of m.tags){const e=logical.events.find(e=>entryChangeId(e)===tag);if(!e||!['add','renew'].includes(e.mutation.kind)||(e.mutation as ContentMutation).type!==m.type)throw new ReplicationConflict('local remove can only remove observed adds of its type');}
   if(m.kind==='renew'){
    const observed=logical.events.find(e=>entryChangeId(e)===m.tag),old=observed?.mutation as ContentMutation|undefined;
    const removed=logical.events.some(e=>e.mutation.kind==='remove'&&e.mutation.tags.includes(m.tag)||e.mutation.kind==='renew'&&e.mutation.tag===m.tag);
    if(!old||!['add','renew'].includes(old.kind)||old.type!==m.type||!('expiresAt'in old)||old.expiresAt!==null&&old.expiresAt<=now||removed||canonical(old.owner)!==canonical(m.owner)||!('fields'in old)||canonical(old.fields)!==canonical(m.fields)||m.expiresAt!==null&&m.expiresAt<=now)throw new ReplicationConflict('renewal requires a live observed tag with unchanged fields and owner');
   }
   if(!Number.isSafeInteger(s.seq+1))throw new ReplicationConflict('origin sequence exhausted');
   const event:ReplicatedEntryChange={originReplicaId:this.config.replicaId,incarnation:this.config.incarnation,seq:s.seq+1,clock:advanceHybridClock(s.clock,now),requestId,argumentHash,mutation:m};
   this.budget([event]);s.config??=copy(this.config);s.configHash=this.configHash;logical.config=copy(this.config);logical.configHash=this.configHash;this.append(logical,[event],now);this.persistOverlay(s,logical,previous);
   await this.check('local');return copy(event);
  },this.o.ctx);
 }
 private async importIn(tx:StoreTx,events:ReplicatedEntryChange[]):Promise<{added:number;revision:number}>{
  const s=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(s);const now=this.now();
  s.config??=copy(this.config);s.configHash=this.configHash;const logical=await this.materializeIn(tx,s),previous=logical.events.length;
  const added=this.append(logical,events,now);this.persistOverlay(s,logical,previous);return {added,revision:headOf(logical)};
 }
 async importChanges(input: ReplicatedEntryChange[]): Promise<{ added: number; revision: number }> {
  const events=copy(input);if(!Array.isArray(events)||events.length>1024)throw new ResourceExhausted('bounded event array required');this.budget(events);
  await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const result=await this.importIn(tx,events);await this.check('import');return result;
  },this.o.ctx);
 }

 /** The logical history; redacted unless `raw` (used only to check what storage still holds). */
 private async materialize(base: Readonly<EntryReplicationState>, load: (key: string) => Promise<Readonly<{page: EntrySnapshotPage|null}>|undefined>, raw=false): Promise<EntryReplicationState> {
  const result:EntryReplicationState=copy(base),events:ReplicatedEntryChange[]=[],seen=new Map<string,string>();let through=0;
  const at=new Map<string,number>();
  // After the first segment (the compacted generation) a change below the floor was removed; it stays removed.
  let floorActive=false;
  const add=(items:ReadonlyArray<ReplicatedEntryChange>)=>{for(const e of items){const k=entryChangeId(e),h=hash(e),old=seen.get(k);
   if(!old&&floorActive&&e.seq<=(base.floor?.[origin(e)]??0))continue;
   if(old&&old!==h){const i=at.get(k)!,verdict=this.equivalent(events[i]!,e);if(verdict==='conflict')throw new ReplicationConflict('stored change ID conflict');if(verdict==='replace'){events[i]=copy(e);seen.set(k,h);}continue;}
   if(!old){at.set(k,events.length);events.push(copy(e));seen.set(k,h);}}};
  for(const segment of base.segments??[]){
   if(segment.overlayThrough<through||segment.overlayThrough>base.events.length)throw new ReplicationConflict('invalid stored overlay boundary');
   add(base.events.slice(through,segment.overlayThrough));through=segment.overlayThrough;
   const pages=await this.stagedEvents(segment.manifest,load);add(pages);floorActive=true;
  }
  add(base.events.slice(through));if(!raw)this.applyErasures(events);result.events=events;return result;
 }
 private materializeIn(tx: StoreTx, base: Readonly<EntryReplicationState>) { return this.materialize(base,key=>tx.doc(EntrySnapshotChunks,key,null)); }
 private persistOverlay(base: EntryReplicationState, logical: EntryReplicationState, previous: number) {
  // The overlay holds its changes in their current (possibly redacted) form; nothing erased stays in it.
  const current=new Map(logical.events.map(e=>[entryChangeId(e),e]));
  for(let i=0;i<base.events.length;i++){const now=current.get(entryChangeId(base.events[i]!));if(now&&canonical(now)!==canonical(base.events[i]))base.events[i]=copy(now);}
  base.events.push(...copy(logical.events.slice(previous)));base.clock=copy(logical.clock);base.seq=logical.seq;base.lastWallTime=logical.lastWallTime;
 }
 private async state(action: 'read'|'export') {
  await this.check(action);const base=await this.o.host.snapshot(EntryReplicas,this.documentKey,this.o.ctx);if(base)this.bind(base);
  const state=base?await this.materialize(base,key=>this.o.host.snapshot(EntrySnapshotChunks,key,this.o.ctx)):undefined;
  await this.check(action);return state;
 }
 /** This replica's own change for a local request ID (kept for retries, at least requestRetentionMs), or null. */
 async changeForRequest(requestId: string): Promise<ReplicatedEntryChange | null> {
  const s=await this.state('read');const e=s?.events.find(e=>e.originReplicaId===this.config.replicaId&&e.incarnation===this.config.incarnation&&e.requestId===requestId);return e?copy(e):null;
 }
 async read(): Promise<ReplicatedEntryView[]> {
  const s=await this.state('read'),now=this.now();this.clockSafe(s??{lastWallTime:0},now);if(!s)return [];
  // lww: winners per key hash, so a redacted change (key hash only) keeps competing and hides the key when it wins.
  const winners=new Map<string,ReplicatedEntryChange>(),removed=new Set<string>(),redacted=new Set<string>();
  for(const e of s.events){const m=e.mutation;if(m.kind==='erase')continue;
   const r=this.config.rules.find(r=>r.type===m.type)!;if(m.kind==='redacted')redacted.add(entryChangeId(e));
   if(r.variant==='lww'&&m.kind!=='remove'){
    const k=m.kind==='redacted'?m.keyHash!:hash(key(r,(m as ContentMutation).fields)),old=winners.get(k),cmp=old?compareHybridClock(e.clock,old.clock):1;
    if(!old||cmp>0||cmp===0&&e.originReplicaId>old.originReplicaId)winners.set(k,e);
   } else if(m.kind==='remove')for(const tag of m.tags)removed.add(tag);else if(m.kind==='renew'||m.kind==='redacted'&&m.was==='renew')removed.add((m as {tag:string}).tag);
  }
  const visible=[...winners.values()].filter(e=>e.mutation.kind==='put');
  // set: a renewal of an erased tag stays invisible.
  visible.push(...s.events.filter(e=>['add','renew'].includes(e.mutation.kind)&&!removed.has(entryChangeId(e))&&!(e.mutation.kind==='renew'&&redacted.has(e.mutation.tag))));
  return visible.filter(e=>{const m=e.mutation as Extract<EntryMutation,{expiresAt:number|null}>;return m.expiresAt===null||m.expiresAt>now;}).map(e=>{
   const m=e.mutation as Extract<EntryMutation,{expiresAt:number|null}>;return {id:entryChangeId(e),type:m.type,fields:copy(m.fields),owner:copy(m.owner),expiresAt:m.expiresAt,clock:copy(e.clock),originReplicaId:e.originReplicaId};
  }).sort((a,b)=>a.id<b.id?-1:1);
 }
 /** Byte-bounded changes after stream position `afterRevision`; `positions` only when they are not contiguous. */
 async changes(afterRevision=0,maxBytes=256*1024): Promise<{events:ReplicatedEntryChange[];next:number;more:boolean;positions?:number[]}> {
  const s=await this.state('export');
  if(!number(afterRevision)||afterRevision>(s?headOf(s):0)||!Number.isSafeInteger(maxBytes)||maxBytes<256||maxBytes>256*1024)throw new ReplicationConflict('invalid revision or page budget');
  const frame=(events:ReplicatedEntryChange[],positions:number[],next:number,more:boolean)=>({events,next,more,...(contiguous(afterRevision,positions)?{}:{positions})});
  const {events,positions,next,more}=this.pageAfter(s,afterRevision,maxBytes,frame,'next change does not fit page');return frame(events,positions,next,more);
 }
 /** Retained events after position `after` that fit `maxBytes` as measured by `frame`; `next` is the head when nothing follows. */
 private pageAfter(s:EntryReplicationState|undefined,after:number,maxBytes:number,frame:(events:ReplicatedEntryChange[],positions:number[],next:number,more:boolean)=>unknown,tooLarge:string){
  const all=s?.events??[],at=positionsOf(all.length,s?.dropped),head=s?headOf(s):0;let n=0;while(n<at.length&&at[n]!<=after)n++;
  const page={events:[] as ReplicatedEntryChange[],positions:[] as number[],next:n<at.length?after:head,more:n<at.length};
  // `listed` bounds the frame from above (every event and position with its comma, the positions key present); the
  // frame itself is serialized only when that bound no longer fits, not once per event (quadratic per page).
  let listed=14;
  for(;n<all.length&&page.events.length<1024;n++){
   const event=copy(all[n]!),position=at[n]!,more=n+1<all.length,next=more?position:head,item=bytes(event)+1+String(position).length+1;
   page.events.push(event);page.positions.push(position);
   if(bytes(frame([],[],next,more))+listed+item>maxBytes&&bytes(frame(page.events,page.positions,next,more))>maxBytes){page.events.pop();page.positions.pop();if(!page.events.length)throw new ResourceExhausted(tooLarge);break;}
   listed+=item;page.next=next;page.more=more;
  }
  return page;
 }
 async snapshot(): Promise<EntryReplicationSnapshot> {
  const s=await this.state('export'),events=copy(s?.events??[]);this.budget(events);
  const body={version:1 as const,spaceId:this.config.spaceId,authorityId:this.config.authorityId,configHash:this.configHash,events};
  return {...body,sha256:hash(body)};
 }
 async installSnapshot(snapshot: EntryReplicationSnapshot) {
  const v=copy(snapshot);await this.check('import');
  if(!v||!exact(v,['version','spaceId','authorityId','configHash','events','sha256'])||v.version!==1||v.spaceId!==this.config.spaceId||v.authorityId!==this.config.authorityId||v.configHash!==this.configHash)throw new ReplicationConflict('snapshot binding changed');
  const {sha256,...body}=v;if(sha256!==hash(body))throw new ReplicationConflict('snapshot hash mismatch');
  // Merge, never replace: local changes accepted after snapshot creation survive installation.
  return this.importChanges(v.events);
 }

 private snapshotId(value:unknown):asserts value is string {if(typeof value!=='string'||!/^ss[0-9a-f]{32}$/.test(value))throw new ReplicationConflict('invalid snapshot ID');}
 private cache() {
  let byDocument=snapshotCaches.get(this.o.host);if(!byDocument){byDocument=new Map();snapshotCaches.set(this.o.host,byDocument);}
  let cache=byDocument.get(this.documentKey);if(!cache){cache=new Map();byDocument.set(this.documentKey,cache);}return cache;
 }
 private bindManifest(m:EntrySnapshotManifest) {if(m.spaceId!==this.config.spaceId||m.authorityId!==this.config.authorityId||m.configHash!==this.configHash||!this.config.members.some(p=>p.replicaId===m.sourceReplicaId&&p.incarnation===m.sourceIncarnation))throw new ReplicationConflict('snapshot binding changed');}
 private validateManifest(m: EntrySnapshotManifest) {
  if(!m||!exact(m,['version','id','spaceId','authorityId','configHash','sourceReplicaId','sourceIncarnation','revision','eventCount','bytes','pageBytes','pageCount','expiresAt','seedHash','rootHash'])||m.version!==1||!/^ss[0-9a-f]{32}$/.test(m.id)||m.spaceId!==this.config.spaceId||m.authorityId!==this.config.authorityId||m.configHash!==this.configHash||!this.config.members.some(p=>p.replicaId===m.sourceReplicaId&&p.incarnation===m.sourceIncarnation)||!number(m.revision)||!number(m.eventCount)||m.revision<m.eventCount||!number(m.bytes)||m.bytes<2||m.bytes>this.maxHistoryBytes||!number(m.pageBytes)||m.pageBytes<1024||2*m.pageBytes+16384>this.maxBatchBytes||!number(m.pageCount)||m.pageCount<1||m.pageCount>2048||!number(m.expiresAt)||!sha(m.seedHash)||!sha(m.rootHash)||manifestSeed(m)!==m.seedHash)throw new ReplicationConflict('invalid snapshot manifest or binding');
 }
 private validatePage(m:EntrySnapshotManifest,p:EntrySnapshotPage,index:number,offset:number,previousHash:string) {
  if(!p||!exact(p,['snapshotId','index','offset','next','events','previousHash','sha256'])||p.snapshotId!==m.id||p.index!==index||p.offset!==offset||p.next!==index+1||p.previousHash!==previousHash||!Array.isArray(p.events)||p.events.length>1024||(!p.events.length&&m.eventCount!==0)||!sha(p.sha256)||pageHash(p)!==p.sha256||bytes(p)>m.pageBytes||offset+p.events.length>m.eventCount)throw new ReplicationConflict('snapshot page changed, is out of order or exceeds budget');
 }
 /** `verified` (page admission): the chain up to `count` was checked when each page was staged, and the ledger's
  * `chainHash` binds it; only the linkage is rechecked, not every page's canonical hash (quadratic per import).
  * Finishing an import loads without it and checks the complete chain. */
 private async stagedEvents(m:EntrySnapshotManifest,load:(key:string)=>Promise<Readonly<{page:EntrySnapshotPage|null}>|undefined>,count=m.pageCount,verified?:{chainHash:string;nextOffset:number}):Promise<ReplicatedEntryChange[]> {
  const events:ReplicatedEntryChange[]=[];let chain=m.seedHash;
  for(let n=0;n<count;n++){const chunk=await load(chunkKey(this.documentKey,m.id,n));if(!chunk?.page)throw new ReplicationConflict('snapshot page is missing');
   if(verified){if(chunk.page.index!==n||chunk.page.offset!==events.length||chunk.page.previousHash!==chain)throw new ReplicationConflict('staged snapshot page changed');}else this.validatePage(m,chunk.page,n,events.length,chain);
   events.push(...copy(chunk.page.events));chain=chunk.page.sha256;}
  if(verified&&(chain!==verified.chainHash||events.length!==verified.nextOffset))throw new ReplicationConflict('staged snapshot pages disagree with the import ledger');
  if(count===m.pageCount&&(chain!==m.rootHash||events.length!==m.eventCount||bytes(events)!==m.bytes))throw new ReplicationConflict('snapshot is incomplete or its final hash changed');return events;
 }
 private packSnapshot(events:ReplicatedEntryChange[],template:EntrySnapshotManifest):ExportedSnapshot {
  const manifest=copy(template),pageBytes=manifest.pageBytes;
  const pages:EntrySnapshotPage[]=[];let offset=0;
  do {
   const page:EntrySnapshotPage={snapshotId:manifest.id,index:pages.length,offset,next:pages.length+1,events:[],previousHash:'0'.repeat(64),sha256:'0'.repeat(64)};
   while(offset<events.length&&page.events.length<1024){const e=events[offset]!;page.events.push(e);if(bytes(page)>pageBytes){page.events.pop();if(!page.events.length)throw new ResourceExhausted('one change does not fit snapshot page');break;}offset++;}
   pages.push(page);if(pages.length>2048)throw new ResourceExhausted('snapshot exceeds 2048 pages');
  }while(offset<events.length);
  manifest.pageCount=pages.length;manifest.seedHash=manifestSeed(manifest);let chain=manifest.seedHash;
  for(const page of pages){page.previousHash=chain;page.sha256=pageHash(page);chain=page.sha256;}manifest.rootHash=chain;
  return {manifest,pages};
 }
 async startSnapshot(pageBytes=Math.floor((this.maxBatchBytes-16384)/2)):Promise<EntrySnapshotManifest> {
  if(!number(pageBytes)||pageBytes<1024||2*pageBytes+16384>this.maxBatchBytes)throw new ReplicationConflict('invalid snapshot page budget');
  const state=await this.state('export'),events=copy(state?.events??[]),now=this.now(),cache=this.cache();
  for(const [key,v] of cache)if(v.manifest.expiresAt<=now)cache.delete(key);
  const template:EntrySnapshotManifest={version:1,id:'ss'+randomBytes(16).toString('hex'),spaceId:this.config.spaceId,authorityId:this.config.authorityId,configHash:this.configHash,sourceReplicaId:this.config.replicaId,sourceIncarnation:this.config.incarnation,revision:state?headOf(state):0,eventCount:events.length,bytes:bytes(events),pageBytes,pageCount:0,expiresAt:now+60000,seedHash:'',rootHash:''};
  if(!Number.isSafeInteger(template.expiresAt)||template.bytes>64*1024*1024)throw new ResourceExhausted('snapshot cache byte bound exceeded');
  const {manifest,pages}=this.packSnapshot(events,template);
  while(cache.size>=16||[...cache.values()].reduce((n,v)=>n+v.manifest.bytes,0)+manifest.bytes>64*1024*1024){const first=cache.keys().next().value;if(first===undefined)throw new ResourceExhausted('snapshot cache is full');cache.delete(first);}
  cache.set(manifest.id,{manifest,pages});return copy(manifest);
 }
 async snapshotPage(snapshotId:string,index:number):Promise<EntrySnapshotPage> {
  this.snapshotId(snapshotId);await this.check('export');const v=this.cache().get(snapshotId);if(!v||v.manifest.expiresAt<=this.now()){this.cache().delete(snapshotId);throw new SnapshotExpired('snapshot token expired; start a new snapshot');}
  this.bindManifest(v.manifest);if(!number(index)||index>=v.pages.length)throw new ReplicationConflict('invalid snapshot page index');await this.check('export');if(v.manifest.expiresAt<=this.now())throw new SnapshotExpired('snapshot token expired');return copy(v.pages[index]!);
 }
 async beginSnapshotImport(input:EntrySnapshotManifest):Promise<EntrySnapshotImport> {
  const manifest=copy(input);this.validateManifest(manifest);await this.check('import');
  return this.o.host.commit(async tx=>{
   await this.check('import');const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),old=ledger.transfers[manifest.id];
   if(old){if(canonical(old.manifest)!==canonical(manifest))throw new ReplicationConflict('snapshot ID changed manifest');await this.check('import');return copy(old);}
   if(this.now()>=manifest.expiresAt)throw new SnapshotExpired('snapshot expired before import');
   const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);
   const maintenance=await tx.doc(EntrySnapshotMaintenance,this.documentKey,null);if(maintenance.job&&maintenance.job.phase!=='completed')throw new ReplicationConflict('snapshot maintenance is active');
   const reservedBytes=manifest.bytes+manifest.pageCount*1024;
   if(Object.values(ledger.transfers).some(t=>t.phase==='receiving'||t.phase==='aborting')||Object.keys(ledger.transfers).length>=16||(base.segments?.length??0)>=16||ledger.retainedBytes+reservedBytes>2*this.maxHistoryBytes)throw new ResourceExhausted('snapshot transfer or retained staging capacity exhausted');
   const transfer:EntrySnapshotImport={manifest,phase:'receiving',nextPage:0,nextOffset:0,chainHash:manifest.seedHash,receivedBytes:2,reservedBytes,cleanupCursor:0};
   ledger.transfers[manifest.id]=copy(transfer);ledger.retainedBytes+=reservedBytes;await this.check('import');if(this.now()>=manifest.expiresAt)throw new SnapshotExpired('snapshot expired during import admission');return copy(transfer);
  },this.o.ctx);
 }
 async snapshotImportStatus(snapshotId:string):Promise<EntrySnapshotImport> {
  this.snapshotId(snapshotId);await this.check('import');const ledger=await this.o.host.snapshot(EntrySnapshotTransfers,this.documentKey,this.o.ctx),transfer=ledger?.transfers[snapshotId];if(!transfer)throw new ReplicationConflict('unknown snapshot import');this.bindManifest(transfer.manifest);await this.check('import');return copy(transfer);
 }
 async importSnapshotPage(snapshotId:string,input:EntrySnapshotPage):Promise<EntrySnapshotImport> {
  this.snapshotId(snapshotId);const page=copy(input);if(bytes(page)>Math.floor((this.maxBatchBytes-16384)/2))throw new ResourceExhausted('snapshot page exceeds atomic staging budget');await this.check('import');
  return this.o.host.commit(async tx=>{
   await this.check('import');const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),t=ledger.transfers[snapshotId];if(!t)throw new ReplicationConflict('unknown snapshot import');this.bindManifest(t.manifest);
   if(page.snapshotId!==snapshotId||!number(page.index)||page.index>=t.manifest.pageCount)throw new ReplicationConflict('page belongs to another import');
   if(page.index<t.nextPage){const prior=await tx.doc(EntrySnapshotChunks,chunkKey(this.documentKey,snapshotId,page.index),null);if((t.phase!=='receiving'&&t.phase!=='completed')||canonical(prior.page)!==canonical(page))throw new ReplicationConflict('duplicate page changed content');await this.check('import');return copy(t);}
   if(t.phase!=='receiving'||this.now()>=t.manifest.expiresAt)throw new SnapshotExpired('snapshot no longer accepts pages');
   this.validatePage(t.manifest,page,t.nextPage,t.nextOffset,t.chainHash);this.budget(page.events);
   const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);const logical=await this.materializeIn(tx,base),staged=await this.stagedEvents(t.manifest,key=>tx.doc(EntrySnapshotChunks,key,null),t.nextPage,{chainHash:t.chainHash,nextOffset:t.nextOffset});
   this.append(logical,[...staged,...page.events],this.now());
   // Receipt is causal even while payloads remain hidden: subsequent local writes must have a newer HLC.
   let observedClock=copy(base.clock);for(const event of page.events){observedClock=advanceHybridClock(observedClock,this.now(),event.clock);if(event.originReplicaId===this.config.replicaId&&event.incarnation===this.config.incarnation)base.seq=Math.max(base.seq,event.seq);}
   base.clock=observedClock;base.lastWallTime=Math.max(base.lastWallTime,this.now());
   const chunk=await tx.doc(EntrySnapshotChunks,chunkKey(this.documentKey,snapshotId,page.index),null);if(chunk.page!==null)throw new ReplicationConflict('staging page is already occupied');chunk.page=copy(page);
   t.receivedBytes+=bytes(page.events)-2+(t.nextOffset>0&&page.events.length>0?1:0);t.nextPage++;t.nextOffset+=page.events.length;t.chainHash=page.sha256;
   if(t.nextPage===t.manifest.pageCount&&(t.nextOffset!==t.manifest.eventCount||t.receivedBytes!==t.manifest.bytes||t.chainHash!==t.manifest.rootHash))throw new ReplicationConflict('final snapshot page does not match manifest');await this.check('import');if(this.now()>=t.manifest.expiresAt)throw new SnapshotExpired('snapshot expired during page admission');return copy(t);
  },this.o.ctx);
 }
 async finishSnapshotImport(snapshotId:string):Promise<{added:number;revision:number;sourceRevision:number}> {
  this.snapshotId(snapshotId);await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),t=ledger.transfers[snapshotId];if(!t)throw new ReplicationConflict('unknown snapshot import');this.bindManifest(t.manifest);if(['completed','retiring','retired'].includes(t.phase)){await this.check('import');return copy(t.result!);}
   if(t.phase!=='receiving'||t.nextPage!==t.manifest.pageCount)throw new ReplicationConflict('snapshot import is incomplete');
   const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);const logical=await this.materializeIn(tx,base),events=await this.stagedEvents(t.manifest,key=>tx.doc(EntrySnapshotChunks,key,null));
   const now=this.now();this.clockSafe(logical,now);const added=this.append(logical,events,now);
   const segments=[...(base.segments??[]),{manifest:copy(t.manifest),overlayThrough:base.events.length}];
   if(segments.length>16||bytes({...logical,segments,config:this.config,configHash:this.configHash})>this.maxHistoryBytes)throw new ResourceExhausted('published snapshot exceeds retained history budget');
   // Only this small head update makes the previously hidden immutable pages visible.
   base.config??=copy(this.config);base.configHash=this.configHash;base.segments=segments;base.clock=copy(logical.clock);base.seq=logical.seq;base.lastWallTime=logical.lastWallTime;
   t.phase='completed';t.result={added,revision:headOf(logical),sourceRevision:t.manifest.revision};await this.check('import');return copy(t.result);
  },this.o.ctx);
 }
 async abortSnapshotImport(snapshotId:string):Promise<EntrySnapshotImport> {
  this.snapshotId(snapshotId);await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),t=ledger.transfers[snapshotId];if(!t)throw new ReplicationConflict('unknown snapshot import');this.bindManifest(t.manifest);if(['completed','retiring','retired','consolidating'].includes(t.phase))throw new ReplicationConflict('published or maintenance generation cannot be aborted');if(t.phase==='aborted'){await this.check('import');return copy(t);}
   t.phase='aborting';if(t.cleanupCursor<t.nextPage){const chunk=await tx.doc(EntrySnapshotChunks,chunkKey(this.documentKey,snapshotId,t.cleanupCursor),null);chunk.page=null;t.cleanupCursor++;}
   if(t.cleanupCursor===t.nextPage){t.phase='aborted';ledger.retainedBytes-=t.reservedBytes;}
   await this.check('import');return copy(t);
  },this.o.ctx);
 }


 /** IDs of every change owned by `principal` (also redacted ones): evidence for erasing the Root's journals. */
 async changeIdsOwnedBy(principal: Principal): Promise<string[]> {
  const s=await this.state('export'),p=canonical(principal);
  return (s?.events??[]).filter(e=>e.mutation.kind!=='erase'&&canonical(e.mutation.owner)===p).map(e=>entryChangeId(e));
 }
 /** Step 3 (docs/abnahme/ap3-replikation.md): erases every earlier change of `principal` on all replicas, as a change of its own. */
 async erasePrincipal(requestId: string, principal: Principal, admin: Principal): Promise<ReplicatedEntryChange> {
  return this.mutate(requestId,{kind:'erase',principal:copy(principal),owner:copy(admin)});
 }
 /**
  * What this replica's storage still holds of erased principals. The overlay is rewritten with every commit; snapshot
  * segments need maintenance and incoming snapshot transfers an abort (completeErasure). The offline durable history
  * compaction then removes the superseded revisions.
  */
 async erasureStatus(): Promise<{ erases: number; overlayPending: number; segmentsPending: number; transfersPending: number; complete: boolean }> {
  await this.check('read');const base=await this.o.host.snapshot(EntryReplicas,this.documentKey,this.o.ctx);
  if(!base){await this.check('read');return {erases:0,overlayPending:0,segmentsPending:0,transfersPending:0,complete:true};}
  this.bind(base);const raw=await this.materialize(base,key=>this.o.host.snapshot(EntrySnapshotChunks,key,this.o.ctx),true),view=copy(raw.events);this.applyErasures(view);
  const target=new Map(view.map(e=>[entryChangeId(e),canonical(e)])),overlayIds=new Set(base.events.map(e=>entryChangeId(e)));
  const overlayPending=base.events.filter(e=>target.get(entryChangeId(e))!==canonical(e)).length;
  const segmentsPending=raw.events.filter(e=>!overlayIds.has(entryChangeId(e))&&target.get(entryChangeId(e))!==canonical(e)).length;
  const ledger=await this.o.host.snapshot(EntrySnapshotTransfers,this.documentKey,this.o.ctx),erases=view.filter(e=>e.mutation.kind==='erase').length;
  const transfersPending=erases?Object.values(ledger?.transfers??{}).filter(t=>t.phase==='receiving'||t.phase==='aborting').length:0;
  await this.check('read');return {erases,overlayPending,segmentsPending,transfersPending,complete:!overlayPending&&!segmentsPending&&!transfersPending};
 }
 /** Brings this replica's storage to the redacted form: overlay, export cache, incoming transfers, snapshot segments. */
 async completeErasure(requestId: string): Promise<Awaited<ReturnType<EntryReplicationController['erasureStatus']>>> {
  if(!id(requestId))throw new ReplicationConflict('invalid erasure request');
  snapshotCaches.get(this.o.host)?.delete(this.documentKey);
  await this.check('import');await this.o.host.commit(async tx=>{await this.check('import');const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);const logical=await this.materializeIn(tx,base);this.persistOverlay(base,logical,logical.events.length);},this.o.ctx);
  let status=await this.erasureStatus();
  if(status.transfersPending){const ledger=await this.o.host.snapshot(EntrySnapshotTransfers,this.documentKey,this.o.ctx);
   for(const [snapshotId,t] of Object.entries(ledger?.transfers??{}))if(t.phase==='receiving'||t.phase==='aborting')for(let n=0;n<100_000&&(await this.abortSnapshotImport(snapshotId)).phase!=='aborted';n++);}
  if(status.segmentsPending){const job=await this.startSnapshotMaintenance(requestId);let phase=job.phase;for(let n=0;n<100_000&&phase!=='completed';n++)phase=(await this.advanceSnapshotMaintenance(requestId)).phase;}
  status=await this.erasureStatus();return status;
 }

 /** Capture a stable logical prefix; replacement copies data, never discards causal/dedup history. */
 async startSnapshotMaintenance(requestId:string,pageBytes=Math.floor((this.maxBatchBytes-16384)/2)):Promise<EntrySnapshotMaintenanceJob>{return this.startMaintenance(requestId,pageBytes,false);}
 /** Step 4: a maintenance generation without the events `compactionStatus` counts as droppable; also installs the floor. */
 async startCompaction(requestId:string,pageBytes=Math.floor((this.maxBatchBytes-16384)/2)):Promise<EntrySnapshotMaintenanceJob>{return this.startMaintenance(requestId,pageBytes,true);}
 private async startMaintenance(requestId:string,pageBytes:number,compact:boolean):Promise<EntrySnapshotMaintenanceJob>{
  if(!id(requestId)||!number(pageBytes)||pageBytes<1024||2*pageBytes+16384>this.maxBatchBytes)throw new ReplicationConflict('invalid maintenance request or page budget');
  await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const maintenance=await tx.doc(EntrySnapshotMaintenance,this.documentKey,null);
   if(maintenance.job?.requestId===requestId){if(maintenance.job.manifest.pageBytes!==pageBytes)throw new ReplicationConflict('maintenance request changed page budget');await this.check('import');return copy(maintenance.job);}
   if(maintenance.job&&maintenance.job.phase!=='completed')throw new ReplicationConflict('another snapshot maintenance request is active');
   const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);
   const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null);
   if(Object.values(ledger.transfers).some(t=>t.maintenanceRequestId===requestId))throw new ReplicationConflict('older maintenance receipt cannot be restarted');
   if(Object.values(ledger.transfers).some(t=>!['completed','retired','aborted'].includes(t.phase)))throw new ReplicationConflict('finish or abort existing snapshot transfers first');
   if(Object.keys(ledger.transfers).length>=17)throw new ResourceExhausted('retire expired snapshot receipts before maintenance');
   const logical=await this.materializeIn(tx,base),now=this.now();this.clockSafe(logical,now);
   // The decision is fixed here: stability only grows, so it stays valid while imports continue.
   let events=logical.events,compaction:EntrySnapshotMaintenanceJob['compaction'];
   if(compact){
    const plan=this.plan(logical,await tx.doc(EntryReplicaPeers,this.documentKey,null),now);if(plan.blocked)throw new ReplicationConflict('compaction blocked: '+plan.blocked);
    const at=positionsOf(logical.events.length,logical.dropped),drop=new Set(plan.drop);events=logical.events.filter((_,i)=>!drop.has(i));compaction={dropped:runsOf(plan.drop.map(i=>at[i]!)),floor:plan.floor};
   }
   const template:EntrySnapshotManifest={version:1,id:'ss'+randomBytes(16).toString('hex'),spaceId:this.config.spaceId,authorityId:this.config.authorityId,configHash:this.configHash,sourceReplicaId:this.config.replicaId,sourceIncarnation:this.config.incarnation,revision:headOf(logical),eventCount:events.length,bytes:bytes(events),pageBytes,pageCount:0,expiresAt:now+60000,seedHash:'',rootHash:''};
   if(!Number.isSafeInteger(template.expiresAt))throw new ReplicationConflict('maintenance deadline overflow');
   const {manifest}=this.packSnapshot(events,template),reservedBytes=manifest.bytes+manifest.pageCount*1024;
   if(ledger.retainedBytes+reservedBytes>3*this.maxHistoryBytes+2048*1024)throw new ResourceExhausted('maintenance retained byte bound exceeded');
   ledger.transfers[manifest.id]={maintenanceRequestId:requestId,manifest,phase:'consolidating',nextPage:0,nextOffset:0,chainHash:manifest.seedHash,receivedBytes:2,reservedBytes,cleanupCursor:0};ledger.retainedBytes+=reservedBytes;
   maintenance.job={requestId,phase:'copying',manifest,nextPage:0,prefixCount:logical.events.length,...(compaction?{compaction}:{}),overlayCount:base.events.length,previous:(base.segments??[]).map(s=>({snapshotId:s.manifest.id,pageCount:s.manifest.pageCount,nextPage:0}))};
   await this.check('import');return copy(maintenance.job);
  },this.o.ctx);
 }
 async snapshotMaintenanceStatus():Promise<EntrySnapshotMaintenanceJob|null>{
  await this.check('import');const state=await this.o.host.snapshot(EntrySnapshotMaintenance,this.documentKey,this.o.ctx);await this.check('import');return state?.job?copy(state.job):null;
 }
 /** One page copy, atomic reference publication, or one obsolete-page retirement per invocation. */
 async advanceSnapshotMaintenance(requestId:string):Promise<EntrySnapshotMaintenanceJob>{
  if(!id(requestId))throw new ReplicationConflict('invalid maintenance request');await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const maintenance=await tx.doc(EntrySnapshotMaintenance,this.documentKey,null),job=maintenance.job;
   if(!job||job.requestId!==requestId)throw new ReplicationConflict('unknown maintenance request');
   if(job.phase==='aborting')throw new ReplicationConflict('maintenance generation is being aborted');
   const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);this.bindManifest(job.manifest);
   const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),replacement=ledger.transfers[job.manifest.id];
   if(!replacement)throw new ReplicationConflict('maintenance receipt missing');
   if(job.phase==='copying'){
    if((base.segments??[]).map(s=>s.manifest.id).join(',')!==job.previous.map(s=>s.snapshotId).join(',')||base.events.length<job.overlayCount)throw new ReplicationConflict('maintenance source references changed');
    const logical=await this.materializeIn(tx,base),at=positionsOf(logical.events.length,logical.dropped);
    const prefix=logical.events.slice(0,job.prefixCount??job.manifest.eventCount).filter((_,i)=>!job.compaction||!inRuns(at[i]!,job.compaction.dropped)),packed=this.packSnapshot(prefix,job.manifest);
    if(canonical(packed.manifest)!==canonical(job.manifest))throw new ReplicationConflict('maintenance source prefix changed');
    if(job.nextPage<job.manifest.pageCount){
     const page=packed.pages[job.nextPage]!,chunk=await tx.doc(EntrySnapshotChunks,chunkKey(this.documentKey,job.manifest.id,job.nextPage),null);
     if(chunk.page!==null)throw new ReplicationConflict('maintenance page already occupied');chunk.page=copy(page);job.nextPage++;
     replacement.nextPage=job.nextPage;replacement.nextOffset+=page.events.length;replacement.chainHash=page.sha256;replacement.receivedBytes+=bytes(page.events)-2+(page.offset>0&&page.events.length>0?1:0);
    }else{
     const staged=await this.stagedEvents(job.manifest,key=>tx.doc(EntrySnapshotChunks,key,null));
     if(canonical(staged)!==canonical(prefix))throw new ReplicationConflict('maintenance publication prefix changed');
     // Existing and concurrent overlay writes retain order; the full prefix is now immutable pages.
     base.events.splice(0,job.overlayCount);base.segments=[{manifest:copy(job.manifest),overlayThrough:0}];
     if(job.compaction){base.dropped=mergeRuns(base.dropped??[],job.compaction.dropped);const floor={...base.floor};for(const [k,v] of Object.entries(job.compaction.floor))floor[k]=Math.max(floor[k]??0,v);base.floor=floor;}
     for(const previous of job.previous){const t=ledger.transfers[previous.snapshotId];if(!t||t.phase!=='completed')throw new ReplicationConflict('maintenance generation receipt changed');t.phase='retiring';}
     replacement.phase='completed';replacement.result={added:0,revision:job.manifest.revision,sourceRevision:job.manifest.revision};job.phase='cleaning';
    }
   }else if(job.phase==='cleaning'){
    const previous=job.previous.find(p=>p.nextPage<p.pageCount);
    if(previous){
     await tx.retireDoc(EntrySnapshotChunks,chunkKey(this.documentKey,previous.snapshotId,previous.nextPage));previous.nextPage++;
     if(previous.nextPage===previous.pageCount){const t=ledger.transfers[previous.snapshotId];if(!t||t.phase!=='retiring')throw new ReplicationConflict('maintenance cleanup receipt changed');t.phase='retired';t.cleanupCursor=t.nextPage;ledger.retainedBytes-=t.reservedBytes;}
    }else job.phase='completed';
   }
   await this.check('import');return copy(job);
  },this.o.ctx);
 }
 /**
  * Aborts a generation that is still copying, e.g. because an erase changed its source prefix: one staged page per call,
  * then the receipt is aborted and the job cleared (null). A new generation needs a new request ID.
  */
 async abortSnapshotMaintenance(requestId:string):Promise<EntrySnapshotMaintenanceJob|null>{
  if(!id(requestId))throw new ReplicationConflict('invalid maintenance request');await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const maintenance=await tx.doc(EntrySnapshotMaintenance,this.documentKey,null),job=maintenance.job;
   if(!job||job.requestId!==requestId){await this.check('import');return null;}
   if(job.phase!=='copying'&&job.phase!=='aborting')throw new ReplicationConflict('a published maintenance generation cannot be aborted');
   const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),t=ledger.transfers[job.manifest.id];if(!t||t.maintenanceRequestId!==requestId)throw new ReplicationConflict('maintenance receipt missing');
   job.phase='aborting';
   if(job.nextPage>0){job.nextPage--;await tx.retireDoc(EntrySnapshotChunks,chunkKey(this.documentKey,job.manifest.id,job.nextPage));t.nextPage=job.nextPage;await this.check('import');return copy(job);}
   t.phase='aborted';ledger.retainedBytes-=t.reservedBytes;maintenance.job=null;await this.check('import');return null;
  },this.o.ctx);
 }
 /** Advances a maintenance generation to its end; one whose source changed under it is aborted (false). */
 private async finishMaintenance(requestId:string):Promise<boolean>{
  let job=await this.snapshotMaintenanceStatus();
  for(let n=0;n<100_000&&job&&job.requestId===requestId&&job.phase!=='completed';n++){
   if(job.phase==='aborting'){job=await this.abortSnapshotMaintenance(requestId);continue;}
   try{job=await this.advanceSnapshotMaintenance(requestId);}
   catch(e){if(!(e instanceof ReplicationConflict)||!/prefix changed/.test(e.message))throw e;job=await this.abortSnapshotMaintenance(requestId);}
  }
  return job?.requestId===requestId&&job.phase==='completed';
 }
 /** Drop one expired, unreachable transfer receipt. Never delete a live generation or its seed checkpoint. */
 async forgetSnapshotReceipt(snapshotId:string):Promise<boolean>{
  this.snapshotId(snapshotId);await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);const now=this.now();this.clockSafe(base,now);
   const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),t=ledger.transfers[snapshotId];if(!t){await this.check('import');return false;}this.bindManifest(t.manifest);
   const maintenance=await tx.doc(EntrySnapshotMaintenance,this.documentKey,null);
   if(!['retired','aborted'].includes(t.phase)||t.manifest.expiresAt>now||base.segments?.some(s=>s.manifest.id===snapshotId)||maintenance.job?.phase!=='completed'&&maintenance.job?.previous.some(p=>p.snapshotId===snapshotId))throw new ReplicationConflict('snapshot receipt is live or has not expired');
   delete ledger.transfers[snapshotId];await this.check('import');return true;
  },this.o.ctx);
 }

 /** Contiguous received sequence per configured origin: the floor, then every present sequence after it. */
 private vectorOf(s: Pick<EntryReplicationState,'events'|'floor'>|undefined): EntryVersionVector {
  const seqs=new Map<string,Set<number>>();for(const e of s?.events??[]){const k=origin(e);let set=seqs.get(k);if(!set){set=new Set();seqs.set(k,set);}set.add(e.seq);}
  const out:EntryVersionVector={};for(const m of this.config.members){const k=memberKey(m),set=seqs.get(k);let v=s?.floor?.[k]??0;while(set?.has(v+1))v++;out[k]=v;}return out;
 }
 /** Records the vector a peer advertised (the pump does this after each `describe`). A lower value marks the peer regressed. */
 async recordPeerVector(input: EntryStreamDescription): Promise<void> {
  const d=copy(input);this.validateStream(d?.source);const v=d.vector,keys=this.config.members.map(memberKey);
  if(d.source.replicaId===this.config.replicaId)throw new ReplicationConflict('the own stream is not a peer');
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||Object.values(v).some(n=>!number(n)))throw new ReplicationConflict('invalid peer vector');
  await this.check('import');const now=this.now(),fresh=(o:EntryPeerVectors['peers'][string]|undefined)=>!!o&&!o.regressed&&o.incarnation===d.source.incarnation&&canonical(o.vector)===canonical(v)&&now-o.recordedAt<10_000;
  // A fresh, unchanged vector needs no commit; recordedAt may lag by that much, which only delays compaction.
  if(fresh((await this.o.host.snapshot(EntryReplicaPeers,this.documentKey,this.o.ctx))?.peers[d.source.replicaId]))return;
  await this.o.host.commit(async tx=>{
   await this.check('import');const doc=await tx.doc(EntryReplicaPeers,this.documentKey,null),old=doc.peers[d.source.replicaId];if(fresh(old))return;
   const same=!!old&&old.incarnation===d.source.incarnation;
   doc.peers[d.source.replicaId]=same&&(old.regressed||keys.some(k=>(v[k]??0)<(old.vector[k]??0)))?{...old,regressed:true}:{incarnation:d.source.incarnation,vector:v,recordedAt:now};
   await this.check('import');
  },this.o.ctx);
 }
 /**
  * Which events can go (docs/abnahme/ap3-replikation.md, step 4). Stable: every member advertised a vector covering it, and this
  * replica holds each member's own changes up to its advertised vector. Candidates are stable, invisible for a stable
  * reason and never an erase; a candidate stays while it still suppresses or anchors a retained change (fixpoint).
  */
 private plan(s: EntryReplicationState, peers: Readonly<EntryPeerVectors>|undefined, now: number): { blocked: string|null; drop: number[]; floor: EntryVersionVector } {
  const own=this.vectorOf(s),floor={...own};let recorded=now;
  const blocked=(why:string)=>({blocked:why,drop:[],floor:{}});
  for(const m of this.config.members){if(m.replicaId===this.config.replicaId)continue;const p=peers?.peers[m.replicaId],k=memberKey(m);
   if(!p||p.incarnation!==m.incarnation)return blocked(`no vector recorded from member ${m.replicaId}`);
   if(p.regressed)return blocked(`member ${m.replicaId} advertised a lower vector; a restored replica needs a new incarnation`);
   if((own[k]??0)<(p.vector[k]??0))return blocked(`changes of member ${m.replicaId} are still missing here`);
   for(const o of Object.keys(floor))floor[o]=Math.min(floor[o]!,p.vector[o]??0);recorded=Math.min(recorded,p.recordedAt);
  }
  const events=s.events,index=new Map(events.map((e,i)=>[entryChangeId(e),i])),retainOwn=this.o.requestRetentionMs??86_400_000;
  const stable=(e:ReplicatedEntryChange)=>e.seq<=(floor[origin(e)]??0);
  // Own changes stay while a retry may still ask for them.
  const ok=(e:ReplicatedEntryChange)=>stable(e)&&!(e.originReplicaId===this.config.replicaId&&e.incarnation===this.config.incarnation&&e.clock.physical+retainOwn>now);
  const expired=(m:EntryMutation,at:number)=>'expiresAt'in m&&m.expiresAt!==null&&m.expiresAt+ENTRY_EXPIRY_GRACE_MS<=at;
  const rule=(type:string)=>this.config.rules.find(r=>r.type===type)!;
  const beats=(a:ReplicatedEntryChange,b:ReplicatedEntryChange)=>{const c=compareHybridClock(a.clock,b.clock);return c>0||c===0&&a.originReplicaId>b.originReplicaId;};
  const renewed=(m:EntryMutation)=>m.kind==='renew'||m.kind==='redacted'&&m.was==='renew'?(m as {tag:string}).tag:undefined;
  const groups=new Map<string,number[]>(),removedStably=new Set<string>(),renewsOf=new Map<string,number[]>(),candidates=new Set<number>();
  for(const [i,e] of events.entries()){const m=e.mutation;if(m.kind==='erase')continue;const r=rule(m.type);
   if(r.variant==='lww'){const k=m.kind==='redacted'?m.keyHash!:hash(key(r,(m as ContentMutation).fields)),g=groups.get(k);if(g)g.push(i);else groups.set(k,[i]);continue;}
   const tag=renewed(m);if(tag!==undefined){const list=renewsOf.get(tag);if(list)list.push(i);else renewsOf.set(tag,[i]);}
   if(stable(e)){if(m.kind==='remove')for(const t of m.tags)removedStably.add(t);if(tag!==undefined)removedStably.add(tag);}
  }
  // lww: superseded versions go; the winner (tombstone, redacted or expired) only together with every older version.
  for(const items of groups.values()){
   items.sort((x,y)=>beats(events[x]!,events[y]!)?-1:1);const [w,...rest]=items as [number,...number[]],wm=events[w]!.mutation,going=rest.filter(i=>ok(events[i]!));
   for(const i of going)candidates.add(i);
   if(going.length===rest.length&&ok(events[w]!)&&(wm.kind==='delete'||wm.kind==='redacted'||wm.kind==='put'&&expired(wm,now)))candidates.add(w);
  }
  // set: a tag removed by a stable remove or renew, erased by a stable erase, or expired before every member's vector was recorded.
  for(const [i,e] of events.entries()){const m=e.mutation;if(m.kind==='erase'||rule(m.type).variant!=='set'||!ok(e))continue;
   if(m.kind==='remove'){candidates.add(i);continue;}
   const erase=m.kind==='redacted'?events[index.get(m.erase)??-1]:undefined;
   if(removedStably.has(entryChangeId(e))||erase&&stable(erase)||m.kind!=='redacted'&&expired(m,Math.min(now,recorded)))candidates.add(i);
  }
  const drop=new Set(candidates);
  // Gone: removed now, or absent below the floor (held here once, so removed earlier).
  const gone=(tag:string)=>{const i=index.get(tag);if(i!==undefined)return drop.has(i);const [r,inc,seq]=JSON.parse(tag) as [string,string,number];return seq<=(floor[canonical([r,inc])]??0);};
  for(let changed=true;changed;){changed=false;
   for(const i of [...drop]){const m=events[i]!.mutation;if(m.kind==='erase'||rule(m.type).variant!=='set')continue;
    const tags=m.kind==='remove'?m.tags:renewed(m)!==undefined?[renewed(m)!]:[];
    // A removal stays while its tag does. A renewed tag stays while a renewal that is not yet stable names it: an erase
    // could still arrive and must reach the renewal through the tag. Every erase older than a stable renewal is here.
    if(tags.some(t=>!gone(t))||(renewsOf.get(entryChangeId(events[i]!))??[]).some(r=>!drop.has(r)&&!stable(events[r]!))){drop.delete(i);changed=true;}
   }
  }
  return {blocked:null,drop:[...drop].sort((a,b)=>a-b),floor};
 }
 async compactionStatus(): Promise<EntryCompactionStatus> {
  const s=await this.state('read'),peers=await this.o.host.snapshot(EntryReplicaPeers,this.documentKey,this.o.ctx);
  if(!s)return {blocked:null,events:0,droppable:0,floor:{}};
  const p=this.plan(s,peers,this.now());return {blocked:p.blocked,events:s.events.length,droppable:p.drop.length,floor:p.floor};
 }
 /** One compaction to completion; nothing happens while it is blocked or nothing can go. */
 async compact(requestId: string): Promise<{ dropped: number; status: EntryCompactionStatus }> {
  // Each generation leaves a receipt; retired and aborted ones go once expired, so periodic runs never run out.
  const ledger=await this.o.host.snapshot(EntrySnapshotTransfers,this.documentKey,this.o.ctx),now=this.now();
  for(const [snapshotId,t] of Object.entries(ledger?.transfers??{}))if(['retired','aborted'].includes(t.phase)&&t.manifest.expiresAt<=now)try{await this.forgetSnapshotReceipt(snapshotId);}catch(e){if(!(e instanceof ReplicationConflict))throw e;}
  // A generation left from before (a restart, or an erase changed its source) is finished or aborted first.
  const active=await this.snapshotMaintenanceStatus();if(active&&active.phase!=='completed'){await this.finishMaintenance(active.requestId);return {dropped:0,status:await this.compactionStatus()};}
  const before=await this.compactionStatus();if(before.blocked||!before.droppable)return {dropped:0,status:before};
  const job=await this.startCompaction(requestId),done=await this.finishMaintenance(requestId);
  return {dropped:done?droppedCount(job.compaction?.dropped):0,status:await this.compactionStatus()};
 }

 private streamIdentity():EntryStreamIdentity {
  const body={version:1 as const,spaceId:this.config.spaceId,authorityId:this.config.authorityId,configHash:this.configHash,replicaId:this.config.replicaId,incarnation:this.config.incarnation};return {...body,streamId:hash(body)};
 }
 private validateStream(source:EntryStreamIdentity){
  if(!source||!exact(source,['version','spaceId','authorityId','configHash','replicaId','incarnation','streamId'])||source.version!==1||source.spaceId!==this.config.spaceId||source.authorityId!==this.config.authorityId||source.configHash!==this.configHash||!this.config.members.some(m=>m.replicaId===source.replicaId&&m.incarnation===source.incarnation)||!sha(source.streamId))throw new ReplicationConflict('stream identity or binding changed');
  const {streamId,...body}=source;if(streamId!==hash(body))throw new ReplicationConflict('stream identity hash changed');
 }
 private streamPageHash(page:EntryStreamPage){return hash({source:page.source,after:page.after,next:page.next,events:page.events,...(page.positions?{positions:page.positions}:{})});}
 async describeStream():Promise<EntryStreamDescription>{const state=await this.state('export');return {source:this.streamIdentity(),revision:state?headOf(state):0,vector:this.vectorOf(state)};}
 async streamChanges(after:number,maxBytes=Math.floor((this.maxBatchBytes-16384)/2)):Promise<EntryStreamPage>{
  const state=await this.state('export'),head=state?headOf(state):0;
  if(!number(after)||after>head||!number(maxBytes)||maxBytes<1024||maxBytes>256*1024)throw new ReplicationConflict('invalid stream cursor or page budget');
  const source=this.streamIdentity(),frame=(events:ReplicatedEntryChange[],positions:number[],next:number,more:boolean):EntryStreamPage=>({source,after,next,headRevision:head,more,events,...(contiguous(after,positions)?{}:{positions}),sha256:'0'.repeat(64)});
  const {events,positions,next,more}=this.pageAfter(state,after,maxBytes,frame,'next change does not fit stream page'),page=frame(events,positions,next,more);
  page.sha256=this.streamPageHash(page);return page;
 }
 async startStreamImport(input:EntryStreamIdentity,snapshotId?:string):Promise<EntryStreamCheckpoint>{
  const source=copy(input);this.validateStream(source);if(snapshotId!==undefined)this.snapshotId(snapshotId);await this.check('import');
  return this.o.host.commit(async tx=>{
   await this.check('import');const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);
   const ledger=await tx.doc(EntryStreamCheckpoints,this.documentKey,null),old=ledger.links[source.streamId];
   if(old&&canonical(old.source)!==canonical(source))throw new ReplicationConflict('stored stream source changed');
   let seed=0;
   if(snapshotId!==undefined&&!(old&&old.seedSnapshotId===snapshotId)){
    const transfers=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),t=transfers.transfers[snapshotId];
    if(!t||!['completed','retiring','retired'].includes(t.phase)||!t.result||t.manifest.sourceReplicaId!==source.replicaId||t.manifest.sourceIncarnation!==source.incarnation)throw new ReplicationConflict('stream seed requires completed snapshot from this source');
    this.bindManifest(t.manifest);if(t.result.sourceRevision!==t.manifest.revision||!(t.phase==='retiring'||t.phase==='retired'||base.segments?.some(s=>s.manifest.id===snapshotId&&canonical(s.manifest)===canonical(t.manifest))))throw new ReplicationConflict('stream seed snapshot is not published');seed=t.result.sourceRevision;
   }
   if(!old){if(Object.keys(ledger.links).length>=32)throw new ResourceExhausted('stream checkpoint capacity exhausted');ledger.links[source.streamId]={source,cursor:seed,last:null,...(snapshotId?{seedSnapshotId:snapshotId}:{})};}
   else if(seed>old.cursor){old.cursor=seed;old.seedSnapshotId=snapshotId!;old.last=null;}
   await this.check('import');return copy(ledger.links[source.streamId]!);
  },this.o.ctx);
 }
 async streamImportStatus(input:EntryStreamIdentity):Promise<EntryStreamCheckpoint|null>{
  const source=copy(input);this.validateStream(source);await this.check('import');const ledger=await this.o.host.snapshot(EntryStreamCheckpoints,this.documentKey,this.o.ctx),checkpoint=ledger?.links[source.streamId];
  if(checkpoint&&canonical(checkpoint.source)!==canonical(source))throw new ReplicationConflict('stored stream source changed');await this.check('import');return checkpoint?copy(checkpoint):null;
 }
 async importStreamPage(input:EntryStreamPage):Promise<EntryStreamResult>{
  const page=copy(input);if(!page||!exact(page,['source','after','next','headRevision','more','events','sha256',...(page&&'positions'in page?['positions']:[])]))throw new ReplicationConflict('invalid stream page');this.validateStream(page.source);
  // Positions are absent while contiguous (after+1 ... next); a compacted source names them, strictly increasing.
  const positions=page.positions??(Array.isArray(page.events)?page.events.map((_,n)=>page.after+n+1):[]);
  if(!number(page.after)||!number(page.next)||!number(page.headRevision)||page.after>page.next||page.next>page.headRevision||typeof page.more!=='boolean'||page.more!==(page.next<page.headRevision)||!Array.isArray(page.events)||page.events.length>1024||!Array.isArray(positions)||positions.length!==page.events.length||positions.some((p,n)=>!number(p)||p<=(n?positions[n-1]!:page.after))||(positions.length?positions.at(-1)!>page.next||page.more&&positions.at(-1)!==page.next:page.more)||!sha(page.sha256)||this.streamPageHash(page)!==page.sha256||bytes(page)>256*1024)throw new ReplicationConflict('stream page range or hash changed');this.budget(page.events);
  await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);const ledger=await tx.doc(EntryStreamCheckpoints,this.documentKey,null),checkpoint=ledger.links[page.source.streamId];
   if(!checkpoint||canonical(checkpoint.source)!==canonical(page.source))throw new ReplicationConflict('stream is not initialized with this source');
   if(page.after!==checkpoint.cursor){
    if(checkpoint.last?.after===page.after&&checkpoint.last.next===page.next){
     if(checkpoint.last.sha256!==page.sha256)throw new ReplicationConflict('decided stream page changed content');await this.check('import');return copy(checkpoint.last.result);
    }
    throw new EntryStreamCursorConflict(checkpoint.cursor);
   }
   const applied=await this.importIn(tx,page.events),result={...applied,cursor:page.next};
   if(page.next>page.after){checkpoint.cursor=page.next;checkpoint.last={after:page.after,next:page.next,sha256:page.sha256,result:copy(result)};}
   await this.check('import');return result;
  },this.o.ctx);
 }
}
