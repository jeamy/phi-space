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
import { EntrySnapshotChunks, EntrySnapshotTransfers, type EntrySnapshotManifest, type EntrySnapshotPage, type EntrySnapshotSegment, type EntrySnapshotImport } from './entry-replication-transfer.ts';
export type { EntrySnapshotManifest, EntrySnapshotPage, EntrySnapshotImport } from './entry-replication-transfer.ts';
export type EntryReplicationRule = { type: string; variant: 'lww'; keyFields: string[] } | { type: string; variant: 'set' };
export type EntryReplicationConfig = {
 spaceId: string; authorityId: string; replicaId: string; incarnation: string;
 members: Array<{ replicaId: string; incarnation: string }>; rules: EntryReplicationRule[];
};
export type EntryMutation =
 | { kind: 'put' | 'add'; type: string; fields: Fields; owner: Principal; expiresAt: number | null }
 | { kind: 'delete'; type: string; fields: Fields; owner: Principal }
 | { kind: 'remove'; type: string; tags: string[]; owner: Principal };
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
 private validateMutation(m: EntryMutation) {
  if(!m || !id(m.type) || !m.owner || !exact(m.owner,m.owner.agentId===undefined?['peerId']:['peerId','agentId']) || !id(m.owner.peerId) || m.owner.agentId!==undefined&&!id(m.owner.agentId))throw new ReplicationConflict('invalid mutation identity');
  const r=this.config.rules.find(r=>r.type===m.type);if(!r)throw new ReplicationConflict('type has no replication rule');
  if(m.kind==='remove') {
   if(r.variant!=='set'||!exact(m,['kind','type','tags','owner'])||!Array.isArray(m.tags)||m.tags.length>256||new Set(m.tags).size!==m.tags.length)throw new ReplicationConflict('invalid observed remove');
   for(const tag of m.tags){let v:unknown;try{v=JSON.parse(tag);}catch{throw new ReplicationConflict('invalid observed tag');}if(!Array.isArray(v)||v.length!==3||!number(v[2])||v[2]<1||!this.config.members.some(p=>p.replicaId===v[0]&&p.incarnation===v[1])||canonical(v)!==tag)throw new ReplicationConflict('unknown tag origin');}
  } else {
   const hasLease=m.kind==='put'||m.kind==='add';
   if(!exact(m,hasLease?['kind','type','fields','owner','expiresAt']:['kind','type','fields','owner']) || (r.variant==='lww' ? !['put','delete'].includes(m.kind) : m.kind!=='add') || !m.fields || typeof m.fields!=='object'||Array.isArray(m.fields) || hasLease&&m.expiresAt!==null&&!number(m.expiresAt))throw new ReplicationConflict('invalid replicated mutation');
   if(bytes(m.fields)>64*1024)throw new ResourceExhausted('entry fields exceed 64 KiB');if(r.variant==='lww')key(r,m.fields);
  }
 }
 private validateEvent(e: ReplicatedEntryChange, now: number) {
  if(!e || !exact(e,['originReplicaId','incarnation','seq','clock','requestId','argumentHash','mutation']) || !this.config.members.some(m=>m.replicaId===e.originReplicaId&&m.incarnation===e.incarnation)||!number(e.seq)||e.seq<1||!id(e.requestId)||typeof e.argumentHash!=='string'||!/^[a-f0-9]{64}$/.test(e.argumentHash))throw new ReplicationConflict('invalid change identity or retired origin');
  validateHybridClock(e.clock);if(e.clock.physical-now>60000)throw new ReplicationClockError('remote clock exceeds future bound');this.validateMutation(e.mutation);
  if(e.argumentHash!==hash(e.mutation))throw new ReplicationConflict('changed mutation argument hash');
 }
 private budget(events: ReplicatedEntryChange[]) { if(2*bytes(events)+16384>this.maxBatchBytes)throw new ResourceExhausted('replication batch exceeds atomic import budget'); }
 private append(s: EntryReplicationState, incoming: ReplicatedEntryChange[], now: number) {
  const known=new Map(s.events.map(e=>[entryChangeId(e),e])),requests=new Set(s.events.map(e=>canonical([e.originReplicaId,e.incarnation,e.requestId]))),accepted:ReplicatedEntryChange[]=[];
  for(const event of incoming){
   this.validateEvent(event,now);const k=entryChangeId(event),old=known.get(k);
   if(old){if(canonical(old)!==canonical(event))throw new ReplicationConflict('immutable change ID reused');continue;}
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
   const observed=known.get(tag);if(observed&&(observed.mutation.kind!=='add'||observed.mutation.type!==event.mutation.type))throw new ReplicationConflict('remove references another type or a non-add');
  }
  for(const event of accepted){s.events.push(copy(event));s.clock=advanceHybridClock(s.clock,now,event.clock);if(event.originReplicaId===this.config.replicaId&&event.incarnation===this.config.incarnation)s.seq=Math.max(s.seq,event.seq);}
  if(accepted.length){s.lastWallTime=Math.max(s.lastWallTime,now);if(bytes(s)>this.maxHistoryBytes)throw new ResourceExhausted('replica history is full; no tombstone or dedup record was discarded');}
  return accepted.length;
 }

 async mutate(requestId: string, mutation: EntryMutation): Promise<ReplicatedEntryChange> {
  const m=copy(mutation);if(!id(requestId))throw new ReplicationConflict('invalid request ID');this.validateMutation(m);const argumentHash=hash(m);
  await this.check('local');return this.o.host.commit(async tx=>{
   await this.check('local');const s=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(s);
   const logical=await this.materializeIn(tx,s),previous=logical.events.length;
   const old=logical.events.find(e=>e.originReplicaId===this.config.replicaId&&e.incarnation===this.config.incarnation&&e.requestId===requestId);
   if(old){if(old.argumentHash!==argumentHash)throw new RequestConflict('replication request changed arguments');await this.check('local');return copy(old);}
   const now=this.now();this.clockSafe(s,now);
   if(m.kind==='remove')for(const tag of m.tags){const e=logical.events.find(e=>entryChangeId(e)===tag);if(!e||e.mutation.kind!=='add'||e.mutation.type!==m.type)throw new ReplicationConflict('local remove can only remove observed adds of its type');}
   if(!Number.isSafeInteger(s.seq+1))throw new ReplicationConflict('origin sequence exhausted');
   const event:ReplicatedEntryChange={originReplicaId:this.config.replicaId,incarnation:this.config.incarnation,seq:s.seq+1,clock:advanceHybridClock(s.clock,now),requestId,argumentHash,mutation:m};
   this.budget([event]);s.config??=copy(this.config);s.configHash=this.configHash;logical.config=copy(this.config);logical.configHash=this.configHash;this.append(logical,[event],now);this.persistOverlay(s,logical,previous);
   await this.check('local');return copy(event);
  },this.o.ctx);
 }
 async importChanges(input: ReplicatedEntryChange[]): Promise<{ added: number; revision: number }> {
  const events=copy(input);if(!Array.isArray(events)||events.length>1024)throw new ResourceExhausted('bounded event array required');this.budget(events);
  await this.check('import');return this.o.host.commit(async tx=>{
   await this.check('import');const s=await tx.doc(EntryReplicas,this.documentKey,null);this.bind(s);const now=this.now();
   s.config??=copy(this.config);s.configHash=this.configHash;const logical=await this.materializeIn(tx,s),previous=logical.events.length;const added=this.append(logical,events,now);this.persistOverlay(s,logical,previous);await this.check('import');return {added,revision:logical.events.length};
  },this.o.ctx);
 }
 private async materialize(base: Readonly<EntryReplicationState>, load: (key: string) => Promise<Readonly<{page: EntrySnapshotPage|null}>|undefined>): Promise<EntryReplicationState> {
  const result:EntryReplicationState=copy(base),events:ReplicatedEntryChange[]=[],seen=new Map<string,string>();let through=0;
  const add=(items:ReadonlyArray<ReplicatedEntryChange>)=>{for(const e of items){const k=entryChangeId(e),h=hash(e),old=seen.get(k);if(old&&old!==h)throw new ReplicationConflict('stored change ID conflict');if(!old){events.push(copy(e));seen.set(k,h);}}};
  for(const segment of base.segments??[]){
   if(segment.overlayThrough<through||segment.overlayThrough>base.events.length)throw new ReplicationConflict('invalid stored overlay boundary');
   add(base.events.slice(through,segment.overlayThrough));through=segment.overlayThrough;
   const pages=await this.stagedEvents(segment.manifest,load);add(pages);
  }
  add(base.events.slice(through));result.events=events;return result;
 }
 private materializeIn(tx: Tx, base: Readonly<EntryReplicationState>) { return this.materialize(base,key=>tx.doc(EntrySnapshotChunks,key,null)); }
 private persistOverlay(base: EntryReplicationState, logical: EntryReplicationState, previous: number) {
  base.events.push(...copy(logical.events.slice(previous)));base.clock=copy(logical.clock);base.seq=logical.seq;base.lastWallTime=logical.lastWallTime;
 }
 private async state(action: 'read'|'export') {
  await this.check(action);const base=await this.o.host.snapshot(EntryReplicas,this.documentKey,this.o.ctx);if(base)this.bind(base);
  const state=base?await this.materialize(base,key=>this.o.host.snapshot(EntrySnapshotChunks,key,this.o.ctx)):undefined;
  await this.check(action);return state;
 }
 async read(): Promise<ReplicatedEntryView[]> {
  const s=await this.state('read'),now=this.now();this.clockSafe(s??{lastWallTime:0},now);if(!s)return [];
  const winners=new Map<string,ReplicatedEntryChange>(),removed=new Set<string>();
  for(const e of s.events){const r=this.config.rules.find(r=>r.type===e.mutation.type)!;
   if(r.variant==='lww'&&e.mutation.kind!=='remove'){
    const k=key(r,e.mutation.fields),old=winners.get(k),cmp=old?compareHybridClock(e.clock,old.clock):1;
    if(!old||cmp>0||cmp===0&&e.originReplicaId>old.originReplicaId)winners.set(k,e);
   } else if(e.mutation.kind==='remove')for(const tag of e.mutation.tags)removed.add(tag);
  }
  const visible=[...winners.values()].filter(e=>e.mutation.kind==='put');
  visible.push(...s.events.filter(e=>e.mutation.kind==='add'&&!removed.has(entryChangeId(e))));
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
 async startSnapshot(pageBytes=Math.floor((this.maxBatchBytes-16384)/2)):Promise<EntrySnapshotManifest> {
  if(!number(pageBytes)||pageBytes<1024||2*pageBytes+16384>this.maxBatchBytes)throw new ReplicationConflict('invalid snapshot page budget');
  const state=await this.state('export'),events=copy(state?.events??[]),now=this.now(),cache=this.cache();
  for(const [key,v] of cache)if(v.manifest.expiresAt<=now)cache.delete(key);
  const manifest:EntrySnapshotManifest={version:1,id:'ss'+randomBytes(16).toString('hex'),spaceId:this.config.spaceId,authorityId:this.config.authorityId,configHash:this.configHash,sourceReplicaId:this.config.replicaId,sourceIncarnation:this.config.incarnation,revision:events.length,eventCount:events.length,bytes:bytes(events),pageBytes,pageCount:0,expiresAt:now+60000,seedHash:'',rootHash:''};
  if(!Number.isSafeInteger(manifest.expiresAt)||manifest.bytes>64*1024*1024)throw new ResourceExhausted('snapshot cache byte bound exceeded');
  const pages:EntrySnapshotPage[]=[];let offset=0;
  do {
   const page:EntrySnapshotPage={snapshotId:manifest.id,index:pages.length,offset,next:pages.length+1,events:[],previousHash:'0'.repeat(64),sha256:'0'.repeat(64)};
   while(offset<events.length&&page.events.length<1024){const e=events[offset]!;page.events.push(e);if(bytes(page)>pageBytes){page.events.pop();if(!page.events.length)throw new ResourceExhausted('one change does not fit snapshot page');break;}offset++;}
   pages.push(page);if(pages.length>2048)throw new ResourceExhausted('snapshot exceeds 2048 pages');
  }while(offset<events.length);
  manifest.pageCount=pages.length;manifest.seedHash=manifestSeed(manifest);let chain=manifest.seedHash;
  for(const page of pages){page.previousHash=chain;page.sha256=pageHash(page);chain=page.sha256;}manifest.rootHash=chain;
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
   await this.check('import');const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),t=ledger.transfers[snapshotId];if(!t)throw new ReplicationConflict('unknown snapshot import');this.bindManifest(t.manifest);if(t.phase==='completed'){await this.check('import');return copy(t.result!);}
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
   await this.check('import');const ledger=await tx.doc(EntrySnapshotTransfers,this.documentKey,null),t=ledger.transfers[snapshotId];if(!t)throw new ReplicationConflict('unknown snapshot import');this.bindManifest(t.manifest);if(t.phase==='completed')throw new ReplicationConflict('published generation cannot be aborted');if(t.phase==='aborted'){await this.check('import');return copy(t);}
   t.phase='aborting';if(t.cleanupCursor<t.nextPage){const chunk=await tx.doc(EntrySnapshotChunks,chunkKey(this.documentKey,snapshotId,t.cleanupCursor),null);chunk.page=null;t.cleanupCursor++;}
   if(t.cleanupCursor===t.nextPage){t.phase='aborted';ledger.retainedBytes-=t.reservedBytes;}
   await this.check('import');return copy(t);
  },this.o.ctx);
 }
}
