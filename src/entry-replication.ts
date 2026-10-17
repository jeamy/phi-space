// Trusted entry-replication substrate. Not the full-state primary/sync commit protocol.
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from '@earendil-works/chord';
import { defineDocFamily, type Tx } from '@earendil-works/pi-durable';
import { canonicalJson } from './canonical.ts';
import type { SpaceHost } from './client.ts';
import type { Principal } from './claims.ts';
import { RequestConflict } from './claims.ts';
import { SnapshotExpired, ResourceExhausted, type Json, type Fields } from './core.ts';
import { advanceHybridClock, compareHybridClock, ReplicationClockError, validateHybridClock, type HybridClock } from './replication-clock.ts';
import { EntrySnapshotChunks, EntrySnapshotTransfers, EntrySnapshotMaintenance, type EntrySnapshotMaintenanceJob, type EntrySnapshotManifest, type EntrySnapshotPage, type EntrySnapshotSegment, type EntrySnapshotImport } from './entry-replication-transfer.ts';
import { EntryStreamCheckpoints, EntryStreamCursorConflict, type EntryStreamIdentity, type EntryStreamDescription, type EntryStreamPage, type EntryStreamCheckpoint, type EntryStreamResult } from './entry-replication-stream.ts';
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
 /** Erases every earlier change owned by `principal` (docs/ap3-replikation.md, step 3); `owner` is the issuing admin. */
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
export type EntryReplicationState = { config: EntryReplicationConfig | null; configHash: string; clock: HybridClock; lastWallTime: number; seq: number; events: ReplicatedEntryChange[]; segments?: EntrySnapshotSegment[] };
export type EntryReplicationSnapshot = { version: 1; spaceId: string; authorityId: string; configHash: string; events: ReplicatedEntryChange[]; sha256: string };
export type ReplicatedEntryView = { id: string; type: string; fields: Fields; owner: Principal; expiresAt: number | null; clock: HybridClock; originReplicaId: string };
export class ReplicationConflict extends Error {}
export const EntryReplicas = defineDocFamily<EntryReplicationState, null>({ kind: 'pi-spaces.entry-replica', version: 2, scope: 'session', family: true,
 initial: () => ({ config: null, configHash: '', clock: { physical: 0, logical: 0 }, lastWallTime: 0, seq: 0, events: [], segments: [] }), migrate: v => ({ ...v, segments: v.segments ?? [] }) as EntryReplicationState });
function assertJson(v: unknown, depth=0, parents=new Set<object>()): void {
 if(depth>64)throw new ReplicationConflict('JSON nesting exceeds 64 levels');
 if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
 if(typeof v!=='object'||parents.has(v)||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null||Object.getOwnPropertySymbols(v).length)throw new ReplicationConflict('plain finite JSON required');
 parents.add(v);if(Array.isArray(v)){for(let n=0;n<v.length;n++)assertJson(v[n],depth+1,parents);}else for(const k of Object.keys(v))assertJson((v as Record<string,unknown>)[k],depth+1,parents);parents.delete(v);
}
const copy = <T>(v: T): T => { assertJson(v); return JSON.parse(JSON.stringify(v)); };
const canonical = (v: unknown) => canonicalJson(v as Json);
const bytes = (v: unknown) => Buffer.byteLength(canonical(v));
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
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
};
type ExportedSnapshot = { manifest: EntrySnapshotManifest; pages: EntrySnapshotPage[] };
const snapshotCaches = new WeakMap<object, Map<string, Map<string, ExportedSnapshot>>>();
const sha = (v: unknown): v is string => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const chunkKey = (documentKey: string, snapshotId: string, index: number) => hash([documentKey,snapshotId,index]);
const pageHash = (page: EntrySnapshotPage) => { const {sha256,...body}=page;return hash(body); };
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
  for(let i=0;i<events.length;i++){
   const e=events[i]!,m=e.mutation;if(m.kind==='erase'||m.kind==='remove')continue;
   const owner=canonical(m.owner);let best:string|undefined;
   for(const x of erases){const xm=x.mutation as Extract<EntryMutation,{kind:'erase'}>;if(canonical(xm.principal)!==owner||compareHybridClock(e.clock,x.clock)>=0)continue;const xid=entryChangeId(x);if(best===undefined||xid<best)best=xid;}
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
 private async importIn(tx:Tx,events:ReplicatedEntryChange[]):Promise<{added:number;revision:number}>{
  const s=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(s);const now=this.now();
  s.config??=copy(this.config);s.configHash=this.configHash;const logical=await this.materializeIn(tx,s),previous=logical.events.length;
  const added=this.append(logical,events,now);this.persistOverlay(s,logical,previous);return {added,revision:logical.events.length};
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
  const add=(items:ReadonlyArray<ReplicatedEntryChange>)=>{for(const e of items){const k=entryChangeId(e),h=hash(e),old=seen.get(k);
   if(old&&old!==h){const i=at.get(k)!,verdict=this.equivalent(events[i]!,e);if(verdict==='conflict')throw new ReplicationConflict('stored change ID conflict');if(verdict==='replace'){events[i]=copy(e);seen.set(k,h);}continue;}
   if(!old){at.set(k,events.length);events.push(copy(e));seen.set(k,h);}}};
  for(const segment of base.segments??[]){
   if(segment.overlayThrough<through||segment.overlayThrough>base.events.length)throw new ReplicationConflict('invalid stored overlay boundary');
   add(base.events.slice(through,segment.overlayThrough));through=segment.overlayThrough;
   const pages=await this.stagedEvents(segment.manifest,load);add(pages);
  }
  add(base.events.slice(through));if(!raw)this.applyErasures(events);result.events=events;return result;
 }
 private materializeIn(tx: Tx, base: Readonly<EntryReplicationState>) { return this.materialize(base,key=>tx.doc(EntrySnapshotChunks,key,null)); }
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
 async changes(afterRevision=0,maxBytes=256*1024): Promise<{events:ReplicatedEntryChange[];next:number;more:boolean}> {
  const s=await this.state('export'),all=s?.events??[];
  if(!number(afterRevision)||afterRevision>all.length||!Number.isSafeInteger(maxBytes)||maxBytes<256||maxBytes>256*1024)throw new ReplicationConflict('invalid revision or page budget');
  const page={events:[] as ReplicatedEntryChange[],next:afterRevision,more:afterRevision<all.length};
  for(let n=afterRevision;n<all.length;n++){const candidate={events:[...page.events,copy(all[n]!)],next:n+1,more:n+1<all.length};if(bytes(candidate)>maxBytes){if(!page.events.length)throw new ResourceExhausted('next change does not fit page');break;}Object.assign(page,candidate);}
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
  if(!m||!exact(m,['version','id','spaceId','authorityId','configHash','sourceReplicaId','sourceIncarnation','revision','eventCount','bytes','pageBytes','pageCount','expiresAt','seedHash','rootHash'])||m.version!==1||!/^ss[0-9a-f]{32}$/.test(m.id)||m.spaceId!==this.config.spaceId||m.authorityId!==this.config.authorityId||m.configHash!==this.configHash||!this.config.members.some(p=>p.replicaId===m.sourceReplicaId&&p.incarnation===m.sourceIncarnation)||!number(m.revision)||m.revision!==m.eventCount||!number(m.eventCount)||!number(m.bytes)||m.bytes<2||m.bytes>this.maxHistoryBytes||!number(m.pageBytes)||m.pageBytes<1024||2*m.pageBytes+16384>this.maxBatchBytes||!number(m.pageCount)||m.pageCount<1||m.pageCount>2048||!number(m.expiresAt)||!sha(m.seedHash)||!sha(m.rootHash)||manifestSeed(m)!==m.seedHash)throw new ReplicationConflict('invalid snapshot manifest or binding');
 }
 private validatePage(m:EntrySnapshotManifest,p:EntrySnapshotPage,index:number,offset:number,previousHash:string) {
  if(!p||!exact(p,['snapshotId','index','offset','next','events','previousHash','sha256'])||p.snapshotId!==m.id||p.index!==index||p.offset!==offset||p.next!==index+1||p.previousHash!==previousHash||!Array.isArray(p.events)||p.events.length>1024||(!p.events.length&&m.eventCount!==0)||!sha(p.sha256)||pageHash(p)!==p.sha256||bytes(p)>m.pageBytes||offset+p.events.length>m.eventCount)throw new ReplicationConflict('snapshot page changed, is out of order or exceeds budget');
 }
 private async stagedEvents(m:EntrySnapshotManifest,load:(key:string)=>Promise<Readonly<{page:EntrySnapshotPage|null}>|undefined>,count=m.pageCount):Promise<ReplicatedEntryChange[]> {
  const events:ReplicatedEntryChange[]=[];let chain=m.seedHash;
  for(let n=0;n<count;n++){const chunk=await load(chunkKey(this.documentKey,m.id,n));if(!chunk?.page)throw new ReplicationConflict('snapshot page is missing');this.validatePage(m,chunk.page,n,events.length,chain);events.push(...copy(chunk.page.events));chain=chunk.page.sha256;}
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
  const template:EntrySnapshotManifest={version:1,id:'ss'+randomBytes(16).toString('hex'),spaceId:this.config.spaceId,authorityId:this.config.authorityId,configHash:this.configHash,sourceReplicaId:this.config.replicaId,sourceIncarnation:this.config.incarnation,revision:events.length,eventCount:events.length,bytes:bytes(events),pageBytes,pageCount:0,expiresAt:now+60000,seedHash:'',rootHash:''};
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
   const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);const logical=await this.materializeIn(tx,base),staged=await this.stagedEvents(t.manifest,key=>tx.doc(EntrySnapshotChunks,key,null),t.nextPage);
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
   t.phase='completed';t.result={added,revision:logical.events.length,sourceRevision:t.manifest.revision};await this.check('import');return copy(t.result);
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


 /** Step 3 (docs/ap3-replikation.md): erases every earlier change of `principal` on all replicas, as a change of its own. */
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
 async startSnapshotMaintenance(requestId:string,pageBytes=Math.floor((this.maxBatchBytes-16384)/2)):Promise<EntrySnapshotMaintenanceJob>{
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
   const template:EntrySnapshotManifest={version:1,id:'ss'+randomBytes(16).toString('hex'),spaceId:this.config.spaceId,authorityId:this.config.authorityId,configHash:this.configHash,sourceReplicaId:this.config.replicaId,sourceIncarnation:this.config.incarnation,revision:logical.events.length,eventCount:logical.events.length,bytes:bytes(logical.events),pageBytes,pageCount:0,expiresAt:now+60000,seedHash:'',rootHash:''};
   if(!Number.isSafeInteger(template.expiresAt))throw new ReplicationConflict('maintenance deadline overflow');
   const {manifest}=this.packSnapshot(logical.events,template),reservedBytes=manifest.bytes+manifest.pageCount*1024;
   if(ledger.retainedBytes+reservedBytes>3*this.maxHistoryBytes+2048*1024)throw new ResourceExhausted('maintenance retained byte bound exceeded');
   ledger.transfers[manifest.id]={maintenanceRequestId:requestId,manifest,phase:'consolidating',nextPage:0,nextOffset:0,chainHash:manifest.seedHash,receivedBytes:2,reservedBytes,cleanupCursor:0};ledger.retainedBytes+=reservedBytes;
   maintenance.job={requestId,phase:'copying',manifest,nextPage:0,overlayCount:base.events.length,previous:(base.segments??[]).map(s=>({snapshotId:s.manifest.id,pageCount:s.manifest.pageCount,nextPage:0}))};
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
   const base=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(base);this.bindManifest(job.manifest);
   const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),replacement=ledger.transfers[job.manifest.id];
   if(!replacement)throw new ReplicationConflict('maintenance receipt missing');
   if(job.phase==='copying'){
    if((base.segments??[]).map(s=>s.manifest.id).join(',')!==job.previous.map(s=>s.snapshotId).join(',')||base.events.length<job.overlayCount)throw new ReplicationConflict('maintenance source references changed');
    const logical=await this.materializeIn(tx,base),prefix=logical.events.slice(0,job.manifest.revision),packed=this.packSnapshot(prefix,job.manifest);
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

 private streamIdentity():EntryStreamIdentity {
  const body={version:1 as const,spaceId:this.config.spaceId,authorityId:this.config.authorityId,configHash:this.configHash,replicaId:this.config.replicaId,incarnation:this.config.incarnation};return {...body,streamId:hash(body)};
 }
 private validateStream(source:EntryStreamIdentity){
  if(!source||!exact(source,['version','spaceId','authorityId','configHash','replicaId','incarnation','streamId'])||source.version!==1||source.spaceId!==this.config.spaceId||source.authorityId!==this.config.authorityId||source.configHash!==this.configHash||!this.config.members.some(m=>m.replicaId===source.replicaId&&m.incarnation===source.incarnation)||!sha(source.streamId))throw new ReplicationConflict('stream identity or binding changed');
  const {streamId,...body}=source;if(streamId!==hash(body))throw new ReplicationConflict('stream identity hash changed');
 }
 private streamPageHash(page:EntryStreamPage){return hash({source:page.source,after:page.after,next:page.next,events:page.events});}
 async describeStream():Promise<EntryStreamDescription>{const state=await this.state('export');return {source:this.streamIdentity(),revision:state?.events.length??0};}
 async streamChanges(after:number,maxBytes=Math.floor((this.maxBatchBytes-16384)/2)):Promise<EntryStreamPage>{
  const state=await this.state('export'),events=state?.events??[];
  if(!number(after)||after>events.length||!number(maxBytes)||maxBytes<1024||maxBytes>256*1024)throw new ReplicationConflict('invalid stream cursor or page budget');
  const page:EntryStreamPage={source:this.streamIdentity(),after,next:after,headRevision:events.length,more:after<events.length,events:[],sha256:'0'.repeat(64)};
  for(let n=after;n<events.length&&page.events.length<1024;n++){
   const candidate={...page,events:[...page.events,copy(events[n]!)],next:n+1,more:n+1<events.length};
   if(bytes(candidate)>maxBytes){if(!page.events.length)throw new ResourceExhausted('next change does not fit stream page');break;}Object.assign(page,candidate);
  }
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
  const page=copy(input);if(!page||!exact(page,['source','after','next','headRevision','more','events','sha256']))throw new ReplicationConflict('invalid stream page');this.validateStream(page.source);
  if(!number(page.after)||!number(page.next)||!number(page.headRevision)||page.after>page.next||page.next>page.headRevision||typeof page.more!=='boolean'||page.more!==(page.next<page.headRevision)||!Array.isArray(page.events)||page.events.length>1024||page.next-page.after!==page.events.length||(!page.events.length&&page.more)||!sha(page.sha256)||this.streamPageHash(page)!==page.sha256||bytes(page)>256*1024)throw new ReplicationConflict('stream page range or hash changed');this.budget(page.events);
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
   if(page.events.length){checkpoint.cursor=page.next;checkpoint.last={after:page.after,next:page.next,sha256:page.sha256,result:copy(result)};}
   await this.check('import');return result;
  },this.o.ctx);
 }
}
