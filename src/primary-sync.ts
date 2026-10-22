// Complete StorageWrite batches, sealed durably before transport. Administrative storage substrate.
// Replica configuration changes (promotion, degradeToSingle, setStandby; docs/federation-plan-v3.md 5.3, 5.3.1) are
// entries of the same hash chain: a version-2 intent whose only write is the replication marker, carrying the new
// configuration. The current configuration is derived from the chain, so markers, replay and catch-up stay exact.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Context} from './context.ts';
import type {Storage,StorageWrite,DocumentId,DocumentRecord,Seq} from '@earendil-works/pi-durable';
import {canonicalJson,digestJson} from './canonical.ts';
import {CommitSealed,SyncBudgetExceeded} from './commit-sealed.ts';
import {limitCheckpointBytes} from './doc.ts';
import type {Json} from './core.ts';
import { canonicalCopy } from './json.ts';

/** `durability` absent means sync (older configurations keep their hash). Single has no standby. */
export type PrimarySyncConfig={spaceId:string;authorityId:string;primaryEpoch:number;replicaConfigVersion:number;primaryReplica:string;standbyReplica:string|null;durability?:'sync'|'single'};
export type PrimaryCommitIntent={version:1;config:PrimarySyncConfig;revision:number;previousHash:string;batchHash:string;deltas:StorageWrite[];validatedAt:number;hash:string};
/** A configuration change in the chain; `config` is the configuration from this revision on. */
export type PrimaryConfigIntent={version:2;config:PrimarySyncConfig;previousConfigHash:string;reason:string;revision:number;previousHash:string;batchHash:string;deltas:StorageWrite[];validatedAt:number;hash:string};
/**
 * Bootstrap of an existing store (plan 3.2, "Bootstrap bestehender Stores"): the complete live content as creates,
 * split into chunks at the start of the chain (revisions 1..total). Each chunk carries the data marker like a
 * commit; `storeHash` is the digest of the complete captured store, checked by the primary before its marker and by
 * every replica after applying the last chunk.
 */
export type PrimaryBootstrapIntent={version:3;config:PrimarySyncConfig;bootstrap:{index:number;total:number;storeHash:string};revision:number;previousHash:string;batchHash:string;deltas:StorageWrite[];validatedAt:number;hash:string};
export type PrimaryIntent=PrimaryCommitIntent|PrimaryConfigIntent|PrimaryBootstrapIntent;
export type PrimarySyncAck={revision:number;hash:string;configHash:string};
export interface PrimarySyncPeer{accept(intent:PrimaryIntent):Promise<PrimarySyncAck>}
export class PrimarySyncBlocked extends Error{}
/** The journal's per-commit or history budget is used up; nothing was sealed. */
export class SyncJournalFull extends PrimarySyncBlocked{}
export {CommitSealed};
const canonical=(v:unknown)=>canonicalJson(v as Json);
const hash=(v:unknown)=>digestJson(v);
const copy=canonicalCopy;
const zero='0'.repeat(64),kind='phi-spaces.primary-sync-storage-marker';
const exact=(v:object,keys:string[])=>Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const name=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
export const durabilityOf=(c:PrimarySyncConfig)=>c.durability??'sync';
function configOf(input:PrimarySyncConfig){
 const c=copy(input),base=['spaceId','authorityId','primaryEpoch','replicaConfigVersion','primaryReplica','standbyReplica'];
 if(!c||!(exact(c,base)||exact(c,[...base,'durability']))||![c.spaceId,c.authorityId,c.primaryReplica].every(name)||!integer(c.primaryEpoch)||c.primaryEpoch<1||!integer(c.replicaConfigVersion)||c.replicaConfigVersion<1)throw new PrimarySyncBlocked('invalid fixed primary/standby configuration');
 if(c.durability!==undefined&&!['sync','single'].includes(c.durability))throw new PrimarySyncBlocked('invalid fixed primary/standby configuration');
 if(durabilityOf(c)==='sync'?(!name(c.standbyReplica)||c.primaryReplica===c.standbyReplica):c.standbyReplica!==null)throw new PrimarySyncBlocked('invalid fixed primary/standby configuration');
 return c;
}
/** Allowed configuration steps: same Space and authority, version +1, epoch unchanged or +1, a new primary only with a new epoch. */
export function validateConfigTransition(previous:PrimarySyncConfig,next:PrimarySyncConfig){
 const p=configOf(previous),n=configOf(next);
 if(n.spaceId!==p.spaceId||n.authorityId!==p.authorityId)throw new PrimarySyncBlocked('a replica transition keeps Space and authority');
 if(n.replicaConfigVersion!==p.replicaConfigVersion+1)throw new PrimarySyncBlocked('a replica transition raises replicaConfigVersion by exactly one');
 if(n.primaryEpoch!==p.primaryEpoch&&n.primaryEpoch!==p.primaryEpoch+1)throw new PrimarySyncBlocked('a replica transition keeps or raises primaryEpoch by one');
 if(n.primaryReplica!==p.primaryReplica&&n.primaryEpoch!==p.primaryEpoch+1)throw new PrimarySyncBlocked('a new primary requires a new primaryEpoch');
 return n;
}
type Marker={configHash:string;revision:number;batchHash:string;previousHash:string};
const address=(spaceId:string)=>({kind,key:spaceId,scope:{kind:'session' as const}});
async function marker(storage:Storage,c:PrimarySyncConfig,ctx:Context):Promise<{record:DocumentRecord;value:Marker}|null>{
 const record=await storage.findDocument(address(c.spaceId),'current',ctx);if(!record)return null;const doc=await storage.document(record.id,'current',ctx);
 if(!doc||doc.version!==1)throw new PrimarySyncBlocked('storage replication marker missing or invalid');return {record,value:doc.value as Marker};
}
const markerOf=(i:PrimaryIntent)=>({configHash:hash(i.config),revision:i.revision,batchHash:i.batchHash,previousHash:i.previousHash});
/** Dedicated local journal, not the independent recovery register. Open before the Harness. */
export class PrimarySyncJournal implements PrimarySyncPeer{
 private genesis:PrimarySyncConfig;private configs:PrimarySyncConfig[];readonly maxIntentBytes:number;private db:DatabaseSync;private maxHistoryBytes:number;
 private assertStandby?:(config:PrimarySyncConfig,version:1|2|3)=>Promise<void>;private self?:string;
 /** Configuration after the newest entry, including an unresolved candidate. */
 get config(){return copy(this.configs.at(-1)!);}
 get configHash(){return hash(this.configs.at(-1));}
 /** Configuration in force after `revision` (0: the genesis configuration). */
 configAt(revision:number){const c=this.configs[revision];if(!c)throw new PrimarySyncBlocked('unknown journal revision');return copy(c);}
 configHashAt(revision:number){return hash(this.configAt(revision));}
 /**
  * `config` is the genesis configuration, fixed for the journal's lifetime. `self` and `assertStandby` bind
  * acceptance: an entry is accepted only if this replica is the standby of the configuration it leads to and the
  * callback (external boot permit, host state) agrees.
  */
 constructor(path:string,config:PrimarySyncConfig,o:{maxIntentBytes?:number;maxHistoryBytes?:number;self?:string;assertStandby?:(config:PrimarySyncConfig,version:1|2|3)=>Promise<void>}={}){
  this.genesis=configOf(config);this.configs=[this.genesis];this.self=o.self;this.assertStandby=o.assertStandby;this.maxIntentBytes=o.maxIntentBytes??256*1024;this.maxHistoryBytes=o.maxHistoryBytes??64*1024*1024;
  if(!integer(this.maxIntentBytes)||this.maxIntentBytes<32768||this.maxIntentBytes>1024*1024||!integer(this.maxHistoryBytes)||this.maxHistoryBytes<this.maxIntentBytes||this.maxHistoryBytes>1024*1024*1024)throw new PrimarySyncBlocked('invalid journal bounds');
  mkdirSync(dirname(path),{recursive:true,mode:0o700});try{if(lstatSync(path).isSymbolicLink())throw new PrimarySyncBlocked('journal must not be a symlink');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  this.db=new DatabaseSync(path);chmodSync(path,0o600);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sync_intents (revision INTEGER PRIMARY KEY, hash TEXT NOT NULL, intent TEXT NOT NULL)');
  try{
   this.transaction(()=>{const prior=this.meta('config');if(prior&&prior!==canonical(this.genesis))throw new PrimarySyncBlocked('stored replica configuration changed');if(!prior)this.setMeta('config',canonical(this.genesis));});
   let previous=zero,revision=0;for(const row of this.db.prepare('SELECT revision,hash,intent FROM sync_intents ORDER BY revision').all()){const i=JSON.parse(row.intent as string) as PrimaryIntent;this.validate(i,this.configs.at(-1)!);if(row.revision!==i.revision||row.hash!==i.hash)throw new PrimarySyncBlocked('journal index disagrees with immutable intent');if(i.revision!==++revision||i.previousHash!==previous)throw new PrimarySyncBlocked('journal history is not a complete prefix');previous=i.hash;this.configs.push(copy(i.config));}
   if(!integer(this.appliedRevision)||this.appliedRevision>revision)throw new PrimarySyncBlocked('journal applied position exceeds history');
  }catch(e){this.db.close();throw e;}
 }
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private meta(key:string):string|undefined{return(this.db.prepare('SELECT value FROM sync_meta WHERE key=?').get(key) as {value:string}|undefined)?.value;}
 private setMeta(key:string,value:string){this.db.prepare('INSERT INTO sync_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
 get appliedRevision(){return Number(this.meta('applied')??0);}
 /** Revisions completed locally without a standby ACK under a verified fencing proof (5.3.1 step 3). */
 get recoveredCommitted():number[]{return JSON.parse(this.meta('recoveredCommitted')??'[]');}
 head():PrimarySyncAck{const row=this.db.prepare('SELECT revision,hash FROM sync_intents ORDER BY revision DESC LIMIT 1').get() as {revision:number;hash:string}|undefined;return {...(row??{revision:0,hash:zero}),configHash:this.configHash};}
 intent(revision:number):PrimaryIntent|null{if(!integer(revision)||revision<1)throw new PrimarySyncBlocked('invalid commit revision');const row=this.db.prepare('SELECT intent FROM sync_intents WHERE revision=?').get(revision) as {intent:string}|undefined;return row?JSON.parse(row.intent):null;}
 /** Validates an entry against the configuration in force before it. */
 private validate(i:PrimaryIntent,current:PrimarySyncConfig){
  const keys1=['version','config','revision','previousHash','batchHash','deltas','validatedAt','hash'],keys2=[...keys1,'previousConfigHash','reason'],keys3=[...keys1,'bootstrap'];
  if(!i||!(i.version===1&&exact(i,keys1)||i.version===2&&exact(i,keys2)||i.version===3&&exact(i,keys3))||!integer(i.revision)||i.revision<1||!integer(i.validatedAt)||!Array.isArray(i.deltas))throw new PrimarySyncBlocked('invalid or oversized commit intent');
  if(Buffer.byteLength(canonical(i))>this.maxIntentBytes)throw new SyncJournalFull(`oversized commit intent (at most ${this.maxIntentBytes} bytes)`);
  if(i.version===1){if(canonical(i.config)!==canonical(current)||i.deltas.length<2)throw new PrimarySyncBlocked('invalid or oversized commit intent');}
  else if(i.version===3){
   const b=i.bootstrap;
   if(canonical(i.config)!==canonical(current)||!b||!exact(b,['index','total','storeHash'])||!integer(b.index)||!integer(b.total)||b.total<1||b.index>=b.total||i.revision!==b.index+1||!/^[0-9a-f]{64}$/.test(String(b.storeHash))||i.deltas.length<1)throw new PrimarySyncBlocked('invalid bootstrap chunk');
   for(const w of i.deltas.slice(0,-1))if(!['conversation','entry','task','submission','document.create'].includes(w.type))throw new PrimarySyncBlocked('a bootstrap chunk only creates records');
  }
  else{
   if(i.previousConfigHash!==hash(current)||typeof i.reason!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(i.reason)||i.deltas.length!==1)throw new PrimarySyncBlocked('invalid replica configuration entry');
   validateConfigTransition(current,i.config);
  }
  const {hash:signature,...body}=i;if(signature!==hash(body)||i.batchHash!==hash(i.deltas.slice(0,-1)))throw new PrimarySyncBlocked('commit intent hash changed');
  const mark=i.deltas.at(-1)!;
  if(mark.type!=='document.create'&&mark.type!=='document.change'||mark.content.kind!=='base'||mark.content.version!==1||canonical(mark.content.value)!==canonical(markerOf(i)))throw new PrimarySyncBlocked('commit marker does not bind the batch');
  if(mark.type==='document.create'&&canonical({kind:mark.record.kind,key:mark.record.key,scope:mark.record.scope})!==canonical(address(current.spaceId)))throw new PrimarySyncBlocked('commit marker address changed');
  for(const write of i.deltas.slice(0,-1))if(write.type==='document.create'&&write.record.kind===kind||write.type==='document.change'&&write.id===(mark.type==='document.create'?mark.record.id:mark.id)||write.type==='document.retire'&&write.id===(mark.type==='document.create'?mark.record.id:mark.id))throw new PrimarySyncBlocked('business batch touches replication marker');
 }
 private insert(i:PrimaryIntent){
  const head=this.head();
  // Shape, size and configuration first, against the configuration before this revision (or the current one for a gap).
  this.validate(i,integer(i?.revision)&&i.revision>=1&&i.revision-1<=head.revision?this.configs[i.revision-1]!:this.configs.at(-1)!);
  const old=this.intent(i.revision);if(old){if(canonical(old)!==canonical(i))throw new PrimarySyncBlocked('immutable commit revision changed');return;}
  if(i.revision!==head.revision+1||i.previousHash!==head.hash)throw new PrimarySyncBlocked('commit history gap or fork');
  // Bootstrap chunks form an unbroken prefix of the chain; nothing else may precede or interrupt them.
  const before=i.revision>1?this.intent(i.revision-1):null;
  if(i.version===3&&before&&(before.version!==3||before.bootstrap.total!==i.bootstrap.total||before.bootstrap.storeHash!==i.bootstrap.storeHash))throw new PrimarySyncBlocked('bootstrap chunks must start the chain without gaps');
  if(i.version!==3&&before?.version===3&&before.bootstrap.index!==before.bootstrap.total-1)throw new PrimarySyncBlocked('the bootstrap is not complete');
  const encoded=canonical(i),used=(this.db.prepare('SELECT COALESCE(SUM(length(CAST(intent AS BLOB))),0) AS n FROM sync_intents').get() as {n:number}).n;
  if(used+Buffer.byteLength(encoded)>this.maxHistoryBytes)throw new SyncJournalFull('sync history is full; no committed result was discarded');
  this.db.prepare('INSERT INTO sync_intents(revision,hash,intent) VALUES(?,?,?)').run(i.revision,i.hash,encoded);this.configs.push(copy(i.config));
 }
 private sealEntry(build:(head:PrimarySyncAck)=>Omit<PrimaryIntent,'hash'>):PrimaryIntent{
  return this.transaction(()=>{const head=this.head();if(head.revision!==this.appliedRevision)throw new PrimarySyncBlocked('a sealed candidate is already unresolved');
   const body=build(head),intent={...body,hash:hash(body)} as PrimaryIntent;this.insert(intent);return copy(intent);
  });
 }
 seal(deltas:StorageWrite[],validatedAt:number):PrimaryCommitIntent{
  // Business decisions wait while a replica transition is open; checked in the sealing transaction itself, so no
  // write can slip in between a transition's begin and its configuration entry. Version-2 entries stay allowed.
  return this.sealEntry(head=>{const open=this.openTransitionIds();const last=head.revision?this.intent(head.revision):null;if(last?.version===3&&last.bootstrap.index!==last.bootstrap.total-1)throw new PrimarySyncBlocked('the store bootstrap is not complete; finish it before new work');if(open.length)throw new PrimarySyncBlocked(`replica transition ${open[0]} in progress; writes are paused`);return {version:1 as const,config:this.config,revision:head.revision+1,previousHash:head.hash,batchHash:hash(deltas.slice(0,-1)),deltas:copy(deltas),validatedAt};}) as PrimaryCommitIntent;
 }
 /** Seals all bootstrap chunks in one transaction; each chunk gets its marker write (create first, then change). */
 sealBootstrap(chunks:StorageWrite[][],storeHash:string,markerId:DocumentId,validatedAt:number):PrimaryBootstrapIntent[]{
  return this.transaction(()=>{
   if(this.head().revision!==0)throw new PrimarySyncBlocked('a bootstrap starts an empty journal');
   const out:PrimaryBootstrapIntent[]=[];
   chunks.forEach((writes,index)=>{const head=this.head(),body:Omit<PrimaryBootstrapIntent,'hash'|'deltas'>={version:3,config:this.config,bootstrap:{index,total:chunks.length,storeHash},revision:head.revision+1,previousHash:head.hash,batchHash:hash(writes),validatedAt};
    const value=markerOf({...body,deltas:[],hash:''} as PrimaryIntent),mark:StorageWrite=index===0?{type:'document.create',record:{...address(this.config.spaceId),id:markerId},content:{version:1,kind:'base',value}}:{type:'document.change',id:markerId,content:{version:1,kind:'base',value}};
    const full={...body,deltas:[...copy(writes),mark]},intent={...full,hash:hash(full)} as PrimaryBootstrapIntent;this.insert(intent);out.push(copy(intent));});
   return out;
  });
 }
 /** Seals a configuration change; `mark` is the marker write for the new configuration hash. */
 sealTransition(next:PrimarySyncConfig,reason:string,mark:StorageWrite,validatedAt:number):PrimaryConfigIntent{
  return this.sealEntry(head=>({version:2 as const,config:configOf(next),previousConfigHash:this.configHash,reason,revision:head.revision+1,previousHash:head.hash,batchHash:hash([]),deltas:[copy(mark)],validatedAt})) as PrimaryConfigIntent;
 }
 async accept(input:PrimaryIntent):Promise<PrimarySyncAck>{
  const i=copy(input);
  if(this.self!==undefined&&i.config.standbyReplica!==this.self)throw new PrimarySyncBlocked('this replica is not the standby of the entry');
  await this.assertStandby?.(copy(i.config),i.version);
  this.transaction(()=>this.insert(i));return {revision:i.revision,hash:i.hash,configHash:hash(i.config)};
 }
 /**
  * Catch-up of a quarantined replica before setStandby: accepts the existing history in order although earlier
  * entries name other standbys. Only while `assertQuarantine` confirms the quarantine state; no other effect.
  */
 async catchUp(input:PrimaryIntent,assertQuarantine:()=>Promise<void>):Promise<PrimarySyncAck>{
  const i=copy(input);await assertQuarantine();this.transaction(()=>this.insert(i));return {revision:i.revision,hash:i.hash,configHash:hash(i.config)};
 }
 /** Durable record of a replica transition (promotion, degradeToSingle, setStandby) for idempotent continuation. */
 /** IDs of transitions in phase started or locallyCommitted; while any exists, business writes are paused. */
 openTransitionIds():string[]{
  return (this.db.prepare("SELECT key,value FROM sync_meta WHERE key LIKE 'transition:%'").all() as {key:string;value:string}[])
   .filter(r=>['started','locallyCommitted'].includes(JSON.parse(r.value)?.phase)).map(r=>r.key.slice('transition:'.length));
 }
 /** Starts or resumes a transition atomically: at most one open transition per journal; returns the stored record. */
 beginTransition<T extends Json>(id:string,record:T):T{
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id))throw new PrimarySyncBlocked('invalid transition ID');
  return this.transaction(()=>{const old=this.meta('transition:'+id);if(old)return JSON.parse(old);const open=this.openTransitionIds();
   if(open.length)throw new PrimarySyncBlocked(`replica transition ${open[0]} is still open; resume or abandon it first`);
   this.setMeta('transition:'+id,canonical(record));return record;});
 }
 /** Ends a started transition that sealed nothing (refused proof, wrong versions, failed catch-up). */
 abandonTransition(id:string){
  this.transaction(()=>{const v=this.meta('transition:'+id),rec=v?JSON.parse(v):null;
   if(!rec||rec.phase!=='started')throw new PrimarySyncBlocked('only a started transition can be abandoned');
   const head=this.head().revision;for(let r=1;r<=head;r++){const i=this.intent(r)!;if(i.version===2&&i.reason===id)throw new PrimarySyncBlocked('the transition already sealed a configuration entry; resume it');}
   this.setMeta('transition:'+id,canonical({...rec,phase:'abandoned'}));});
 }
 transition<T extends Json>(id:string):T|null{const v=this.meta('transition:'+id);return v?JSON.parse(v):null;}
 saveTransition(id:string,value:Json){if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id))throw new PrimarySyncBlocked('invalid transition ID');this.transaction(()=>this.setMeta('transition:'+id,canonical(value)));}
 markApplied(i:PrimaryIntent,recovered=false){this.transaction(()=>{const stored=this.intent(i.revision);if(!stored||stored.hash!==i.hash)throw new PrimarySyncBlocked('cannot apply an unknown intent');if(this.appliedRevision===i.revision)return;if(this.appliedRevision!==i.revision-1)throw new PrimarySyncBlocked('applied history gap');this.setMeta('applied',String(i.revision));if(recovered)this.setMeta('recoveredCommitted',canonical([...this.recoveredCommitted,i.revision]));});}
 close(){this.db.close();}
}
type Captured={writes:StorageWrite[];digest:string};
async function scanAll<T>(scan:(cursor:any)=>Promise<{items:readonly T[];next?:any}>):Promise<T[]>{const out:T[]=[];let cursor:any;do{const page=await scan(cursor);out.push(...page.items);cursor=page.next;}while(cursor!==undefined);return out;}
/**
 * The complete live content of a store as creates in dependency order (conversations, entries, tasks, submissions,
 * then documents of the session, conversation and task scopes), and its digest. The replication marker is excluded.
 * Only current document state is captured: as-of history of rewindable documents does not replicate.
 */
/**
 * Evidence for NotCommitted (v3 6.2): this host is the primary of the current configuration with no unresolved
 * candidate, and its continuous chain covers `requestEpoch` and every configuration change since. A primary change is
 * only ever a promotion with a verified fencing proof, so no earlier replica can still write. Null when the chain does
 * not reach back to that epoch (then the outcome stays unknown).
 */
export type PromotionEvidence={spaceId:string;authorityId:string;requestEpoch:number;primaryEpoch:number;primaryReplica:string;transitions:Array<{revision:number;hash:string;reason:string;config:PrimarySyncConfig}>;hash:string};
export function promotionEvidence(journal:PrimarySyncJournal,requestEpoch:number,self:string):PromotionEvidence|null{
 const c=journal.config,head=journal.head();
 if(!integer(requestEpoch)||c.primaryReplica!==self||requestEpoch>=c.primaryEpoch||head.revision!==journal.appliedRevision)return null;
 let covered=journal.configAt(0).primaryEpoch===requestEpoch;const transitions:PromotionEvidence['transitions']=[];
 for(let r=1;r<=head.revision;r++){
  const i=journal.intent(r);if(!i)return null;if(i.version!==2)continue;
  if(i.config.primaryEpoch===requestEpoch)covered=true;
  if(i.config.primaryEpoch>requestEpoch)transitions.push({revision:i.revision,hash:i.hash,reason:i.reason,config:copy(i.config)});
 }
 if(!covered||!transitions.length)return null;
 const body={spaceId:c.spaceId,authorityId:c.authorityId,requestEpoch,primaryEpoch:c.primaryEpoch,primaryReplica:self,transitions};
 return {...body,hash:hash(body)};
}
/** The last configuration transition of the chain (its reason is the transition ID) with the configuration before it. */
export function lastConfigTransition(journal:PrimarySyncJournal):{transitionId:string;config:PrimarySyncConfig;previous:PrimarySyncConfig}|null{
 for(let r=journal.head().revision;r>=1;r--){const i=journal.intent(r);if(i?.version===2)return{transitionId:i.reason,config:copy(i.config),previous:journal.configAt(r-1)};}
 return null;
}
export async function captureStore(storage:Storage,ctx:Context):Promise<Captured>{
 // Storage IDs are minted numbers: ascending numeric order is creation order (parents before children).
 const order=(a:unknown,b:unknown)=>typeof a==='number'&&typeof b==='number'?a-b:String(a)<String(b)?-1:String(a)>String(b)?1:0;
 const byId=<T extends {id:unknown}>(xs:T[])=>[...new Map(xs.map(x=>[String(x.id),x])).values()].sort((a,b)=>order(a.id,b.id));
 const conversations=byId(await scanAll(c=>storage.scanConversations({},256,c,ctx)));
 const entries=byId((await Promise.all(conversations.map(c=>scanAll(cur=>storage.scanEntries({conversationId:c.id},256,cur,ctx))))).flat());
 const tasks=byId(await scanAll(c=>storage.scanTasks({},256,c,ctx))),submissions=byId(await scanAll(c=>storage.scanSubmissions({},256,c,ctx)));
 const scopes=[{kind:'session' as const},...conversations.map(c=>({kind:'conversation' as const,conversationId:c.id})),...tasks.map(t=>({kind:'task' as const,taskId:t.id}))];
 const docs:StorageWrite[]=[];
 for(const scope of scopes)for(const r of byId(await scanAll(c=>storage.scanDocuments({scope:scope as any,at:'current'},256,c,ctx)))){
  if(r.kind===kind)continue;const d=await storage.document(r.id,'current',ctx);if(!d)throw new PrimarySyncBlocked('document vanished during capture');
  const {createdAt:_c,retiredAt:_r,...record}=r as DocumentRecord & {retiredAt?:Seq};docs.push({type:'document.create',record:record as any,content:{version:d.version,kind:'base',value:d.value}});
 }
 const writes:StorageWrite[]=[...conversations.map(value=>({type:'conversation' as const,value})),...entries.map(value=>({type:'entry' as const,value})),...tasks.map(value=>({type:'task' as const,value})),...submissions.map(value=>({type:'submission' as const,value})),...docs];
 return {writes:copy(writes),digest:hash(writes)};
}
/**
 * Brings an existing, exclusively opened store (daemon stopped, no Harness) under primary/sync. The journal must be
 * empty with a single-durability genesis: the standby joins afterwards with setStandby. Resumable: after a crash
 * between sealing and the markers the same call verifies the store again and finishes.
 */
export async function bootstrapPrimarySync(storage:Storage,journal:PrimarySyncJournal,ctx:Context,o:{now?:()=>number;chunkBytes?:number}={}):Promise<{revisions:number;storeHash:string;writes:number}>{
 const head=journal.head().revision,first=head?journal.intent(1):null;
 if(head===0){
  if(durabilityOf(journal.config)!=='single')throw new PrimarySyncBlocked('a bootstrap starts single; add the standby afterwards with setStandby');
  if(await marker(storage,journal.config,ctx))throw new PrimarySyncBlocked('the store already carries a replication marker');
  const {writes,digest}=await captureStore(storage,ctx),limit=Math.min(o.chunkBytes??journal.maxIntentBytes-16384,journal.maxIntentBytes-16384),chunks:StorageWrite[][]=[[]];let size=0;
  for(const w of writes){const n=Buffer.byteLength(canonical(w));if(n>limit)throw new PrimarySyncBlocked(`a single record of ${n} bytes exceeds the bootstrap chunk budget`);if(size+n>limit&&chunks.at(-1)!.length){chunks.push([]);size=0;}chunks.at(-1)!.push(w);size+=n;}
  const now=(o.now??Date.now)();if(!integer(now))throw new PrimarySyncBlocked('invalid validation timestamp');
  journal.sealBootstrap(chunks,digest,await storage.mintId<DocumentId>(),now);
 }else if(first?.version!==3)throw new PrimarySyncBlocked('this journal did not start with a bootstrap');
 const b=(journal.intent(1) as PrimaryBootstrapIntent).bootstrap;
 if(journal.appliedRevision<b.total){
  // The store is unchanged since sealing (exclusive): verify before writing the markers that make it tracked.
  if((await captureStore(storage,ctx)).digest!==b.storeHash)throw new PrimarySyncBlocked('the store changed since the bootstrap was sealed');
  for(let r=journal.appliedRevision+1;r<=b.total;r++){const i=journal.intent(r)!,m=await marker(storage,i.config,ctx);
   if(m&&canonical(m.value)===canonical(markerOf(i))){journal.markApplied(i);continue;}
   await storage.commit([copy(i.deltas.at(-1)!)],ctx);journal.markApplied(i);}
 }
 return {revisions:b.total,storeHash:b.storeHash,writes:(await captureStore(storage,ctx)).writes.length};
}
async function apply(storage:Storage,journal:PrimarySyncJournal,intent:PrimaryIntent,ctx:Context,recovered=false):Promise<Seq|null>{
 const m=await marker(storage,journal.configAt(intent.revision),ctx),expected=markerOf(intent);
 if(m&&canonical(m.value)===canonical(expected)){journal.markApplied(intent,recovered);return null;}
 const previous=intent.revision>1?journal.intent(intent.revision-1):null;
 if(intent.revision===1?m!==null:!m||m.value.configHash!==journal.configHashAt(intent.revision-1)||m.value.revision!==intent.revision-1||m.value.batchHash!==previous?.batchHash||m.value.previousHash!==previous?.previousHash)throw new PrimarySyncBlocked('data marker disagrees with the complete journal prefix');
 const seq=await storage.commit(copy(intent.deltas),ctx);
 // A replica that applied the last bootstrap chunk must hold exactly the captured store before it counts as applied.
 if(intent.version===3&&intent.bootstrap.index===intent.bootstrap.total-1&&(await captureStore(storage,ctx)).digest!==intent.bootstrap.storeHash)throw new PrimarySyncBlocked('the bootstrapped replica differs from the captured store');
 journal.markApplied(intent,recovered);return seq;
}
async function verifyDataPrefix(storage:Storage,journal:PrimarySyncJournal,ctx:Context){
 const applied=journal.appliedRevision,m=await marker(storage,journal.configAt(applied),ctx);
 if(applied===0){
  if(m)throw new PrimarySyncBlocked('untracked replicated data marker');
  const docs=await storage.scanDocuments({scope:{kind:'session'},at:'current'},1,undefined,ctx),conversations=await storage.scanConversations({},1,undefined,ctx),tasks=await storage.scanTasks({},1,undefined,ctx),submissions=await storage.scanSubmissions({},1,undefined,ctx);
  if(docs.items.length||conversations.items.length||tasks.items.length||submissions.items.length)throw new PrimarySyncBlocked('bootstrap requires an empty dedicated storage domain');
 }else{
  const i=journal.intent(applied)!;
  if(!m||canonical(m.value)!==canonical(markerOf(i)))throw new PrimarySyncBlocked('materialized data does not match applied journal prefix');
 }
}
/** Materialize all accepted decisions on a stopped standby before opening its Harness. No promotion permission is implied. */
export async function materializeSyncHistory(storage:Storage,journal:PrimarySyncJournal,ctx:Context,assertReplica?:()=>Promise<void>):Promise<void>{
 await assertReplica?.();
 // A durable data commit can precede the local journal receipt after an interrupted apply.
 const next=journal.appliedRevision<journal.head().revision?journal.intent(journal.appliedRevision+1):null;
 const current=await marker(storage,journal.configAt(journal.appliedRevision),ctx);
 if(!(next&&current?.value.revision===next.revision&&current.value.batchHash===next.batchHash))await verifyDataPrefix(storage,journal,ctx);
 for(let r=journal.appliedRevision+1;r<=journal.head().revision;r++){const i=journal.intent(r);if(!i)throw new PrimarySyncBlocked('missing accepted prefix');await apply(storage,journal,i,ctx);}
}
/** Resolve the single sealed primary candidate before opening the Harness. Does not reauthorize its business decision. */
export async function recoverPrimarySync(storage:Storage,journal:PrimarySyncJournal,peer:PrimarySyncPeer|null,ctx:Context,assertPrimary:()=>Promise<void>):Promise<void>{
 if(journal.head().revision-journal.appliedRevision>1)throw new PrimarySyncBlocked('primary has more than one unresolved candidate');
 if(journal.head().revision===journal.appliedRevision){await verifyDataPrefix(storage,journal,ctx);return;}
 const i=journal.intent(journal.head().revision)!,m=await marker(storage,journal.configAt(i.revision),ctx);
 if(!m||canonical(m.value)!==canonical(markerOf(i)))await verifyDataPrefix(storage,journal,ctx);
 await assertPrimary();
 // A candidate sealed under single durability needs no ACK; under sync only the standby decides it.
 if(durabilityOf(journal.configAt(i.revision-1))==='sync'){
  if(!peer)throw new PrimarySyncBlocked('a sync candidate needs its standby or a fenced degradeToSingle');
  const ack=await peer.accept(copy(i));if(canonical(ack)!==canonical({revision:i.revision,hash:i.hash,configHash:hash(i.config)}))throw new PrimarySyncBlocked('standby ACK does not match sealed intent');
 }
 await assertPrimary();await apply(storage,journal,i,ctx);
}
/**
 * 5.3.1 step 3: completes the at most one sealed candidate locally, exactly once, without a standby ACK. Only after
 * `assertFenced` confirmed a verified fencing proof of the counter-replica. The candidate keeps its stored deltas.
 */
export async function recoverSealedWithoutStandby(storage:Storage,journal:PrimarySyncJournal,ctx:Context,assertFenced:()=>Promise<void>):Promise<number|null>{
 if(journal.head().revision-journal.appliedRevision>1)throw new PrimarySyncBlocked('primary has more than one unresolved candidate');
 if(journal.head().revision===journal.appliedRevision){await verifyDataPrefix(storage,journal,ctx);return null;}
 const i=journal.intent(journal.head().revision)!,m=await marker(storage,journal.configAt(i.revision),ctx);
 if(!m||canonical(m.value)!==canonical(markerOf(i)))await verifyDataPrefix(storage,journal,ctx);
 await assertFenced();await apply(storage,journal,i,ctx,true);return i.revision;
}
/**
 * Seals and applies one configuration change. `peer` must confirm it when the new configuration has a standby that
 * takes part (setStandby target, unchanged standby); a promotion or degradeToSingle is a local, fenced commit.
 */
export async function applyConfigTransition(storage:Storage,journal:PrimarySyncJournal,next:PrimarySyncConfig,o:{reason:string;peer?:PrimarySyncPeer|null;ctx:Context;assert:()=>Promise<void>;now?:()=>number}):Promise<PrimaryConfigIntent>{
 if(journal.head().revision!==journal.appliedRevision)throw new PrimarySyncBlocked('resolve the sealed candidate before a replica transition');
 await verifyDataPrefix(storage,journal,o.ctx);validateConfigTransition(journal.config,next);
 const head=journal.head(),m=await marker(storage,journal.config,o.ctx),value={configHash:hash(configOf(next)),revision:head.revision+1,batchHash:hash([]),previousHash:head.hash};
 const mark:StorageWrite=m?{type:'document.change',id:m.record.id,content:{version:1,kind:'base',value}}:{type:'document.create',record:{...address(next.spaceId),id:await storage.mintId<DocumentId>()},content:{version:1,kind:'base',value}};
 const now=(o.now??Date.now)();if(!integer(now))throw new PrimarySyncBlocked('invalid validation timestamp');
 await o.assert();const sealed=journal.sealTransition(next,o.reason,mark,now);
 try{
  if(o.peer){const ack=await o.peer.accept(copy(sealed));if(canonical(ack)!==canonical({revision:sealed.revision,hash:sealed.hash,configHash:hash(sealed.config)}))throw new PrimarySyncBlocked('standby ACK does not match the replica transition');}
  await o.assert();await apply(storage,journal,sealed,o.ctx);return sealed;
 }catch(e){throw new CommitSealed(sealed,e);}
}
/** Captures every document, claim, task, mailbox and root table write in the supplied storage domain. */
/** `onPoisoned`: a sealed candidate was not confirmed; this storage refuses all work until it is reopened and resolved. */
export function primarySyncStorage(storage:Storage,journal:PrimarySyncJournal,peer:PrimarySyncPeer|null,o:{assertPrimary:()=>Promise<void>;now?:()=>number;onPoisoned?:(sealed:{revision:number;hash:string})=>void}):Storage{
 let poisoned=false,busy=false;
 // A Space base must fit one sealed commit together with the other writes of that commit.
 limitCheckpointBytes(journal.maxIntentBytes-64*1024);
 return new Proxy(storage,{get(target,property,receiver){
  if(property!=='commit'){const v=Reflect.get(target,property,receiver);return typeof v==='function'?v.bind(target):v;}
  return async(writes:readonly StorageWrite[],ctx:Context):Promise<Seq>=>{
   if(poisoned||busy||journal.head().revision!==journal.appliedRevision)throw new PrimarySyncBlocked('restart and resolve sealed history before more work');busy=true;let sealed:PrimaryIntent|undefined;
   try{
    await o.assertPrimary();await verifyDataPrefix(storage,journal,ctx);const head=journal.head(),m=await marker(storage,journal.config,ctx);
    if(head.revision===0&&m||head.revision>0&&(!m||m.value.revision!==head.revision||m.value.configHash!==journal.configHash||m.value.batchHash!==journal.intent(head.revision)?.batchHash))throw new PrimarySyncBlocked('replication data marker differs from local history');
    if(!writes.length)throw new PrimarySyncBlocked('empty storage batches are not sync decisions');
    const sync=durabilityOf(journal.config)==='sync';if(sync&&!peer)throw new PrimarySyncBlocked('sync writes need a confirming standby');
    const value={configHash:journal.configHash,revision:head.revision+1,batchHash:hash(writes),previousHash:head.hash};
    const mark:StorageWrite=m?{type:'document.change',id:m.record.id,content:{version:1,kind:'base',value}}:{type:'document.create',record:{...address(journal.config.spaceId),id:await storage.mintId<DocumentId>()},content:{version:1,kind:'base',value}};
    const now=(o.now??Date.now)();if(!integer(now))throw new PrimarySyncBlocked('invalid validation timestamp');
    await o.assertPrimary();sealed=journal.seal([...copy(writes),mark],now);
    if(sync){const ack=await peer!.accept(copy(sealed));if(canonical(ack)!==canonical({revision:sealed.revision,hash:sealed.hash,configHash:journal.configHash}))throw new PrimarySyncBlocked('standby ACK does not match sealed intent');}
    await o.assertPrimary();const seq=await apply(storage,journal,sealed,ctx);if(seq===null)throw new PrimarySyncBlocked('unexpected already-applied candidate');return seq;
   }catch(e){if(sealed){poisoned=true;try{o.onPoisoned?.({revision:sealed.revision,hash:sealed.hash});}catch{}throw new CommitSealed(sealed,e);}
    // Refused before sealing for lack of journal budget: no storage effect, so the session stays usable.
    if(e instanceof SyncJournalFull)throw new SyncBudgetExceeded(e.message,{cause:e});throw e;}finally{busy=false;}
  };
 }});
}
