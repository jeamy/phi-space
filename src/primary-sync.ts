// Complete StorageWrite batches, sealed durably before transport. Administrative storage substrate.
// Replica configuration changes (promotion, degradeToSingle, setStandby; docs/federation-plan-v3.md 5.3, 5.3.1) are
// entries of the same hash chain: a version-2 intent whose only write is the replication marker, carrying the new
// configuration. The current configuration is derived from the chain, so markers, replay and catch-up stay exact.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Context} from '@earendil-works/chord';
import type {Storage,StorageWrite,DocumentId,DocumentRecord,Seq} from '@earendil-works/pi-durable';
import {canonicalJson} from './canonical.ts';
import type {Json} from './core.ts';

/** `durability` absent means sync (older configurations keep their hash). Single has no standby. */
export type PrimarySyncConfig={spaceId:string;authorityId:string;primaryEpoch:number;replicaConfigVersion:number;primaryReplica:string;standbyReplica:string|null;durability?:'sync'|'single'};
export type PrimaryCommitIntent={version:1;config:PrimarySyncConfig;revision:number;previousHash:string;batchHash:string;deltas:StorageWrite[];validatedAt:number;hash:string};
/** A configuration change in the chain; `config` is the configuration from this revision on. */
export type PrimaryConfigIntent={version:2;config:PrimarySyncConfig;previousConfigHash:string;reason:string;revision:number;previousHash:string;batchHash:string;deltas:StorageWrite[];validatedAt:number;hash:string};
export type PrimaryIntent=PrimaryCommitIntent|PrimaryConfigIntent;
export type PrimarySyncAck={revision:number;hash:string;configHash:string};
export interface PrimarySyncPeer{accept(intent:PrimaryIntent):Promise<PrimarySyncAck>}
export class PrimarySyncBlocked extends Error{}
export class CommitSealed extends Error{
 readonly revision:number;readonly hash:string;
 constructor(intent:PrimaryIntent,cause?:unknown){super('commit is durably sealed; resolve this candidate before admitting new work',{cause});this.revision=intent.revision;this.hash=intent.hash;}
}
const canonical=(v:unknown)=>canonicalJson(v as Json);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const copy=<T>(v:T):T=>JSON.parse(canonical(v));
const zero='0'.repeat(64),kind='pi-spaces.primary-sync-storage-marker';
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
 private assertStandby?:(config:PrimarySyncConfig,version:1|2)=>Promise<void>;private self?:string;
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
 constructor(path:string,config:PrimarySyncConfig,o:{maxIntentBytes?:number;maxHistoryBytes?:number;self?:string;assertStandby?:(config:PrimarySyncConfig,version:1|2)=>Promise<void>}={}){
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
  const keys1=['version','config','revision','previousHash','batchHash','deltas','validatedAt','hash'],keys2=[...keys1,'previousConfigHash','reason'];
  if(!i||!(i.version===1&&exact(i,keys1)||i.version===2&&exact(i,keys2))||!integer(i.revision)||i.revision<1||!integer(i.validatedAt)||!Array.isArray(i.deltas)||Buffer.byteLength(canonical(i))>this.maxIntentBytes)throw new PrimarySyncBlocked('invalid or oversized commit intent');
  if(i.version===1){if(canonical(i.config)!==canonical(current)||i.deltas.length<2)throw new PrimarySyncBlocked('invalid or oversized commit intent');}
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
  const encoded=canonical(i),used=(this.db.prepare('SELECT COALESCE(SUM(length(CAST(intent AS BLOB))),0) AS n FROM sync_intents').get() as {n:number}).n;
  if(used+Buffer.byteLength(encoded)>this.maxHistoryBytes)throw new PrimarySyncBlocked('sync history is full; no committed result was discarded');
  this.db.prepare('INSERT INTO sync_intents(revision,hash,intent) VALUES(?,?,?)').run(i.revision,i.hash,encoded);this.configs.push(copy(i.config));
 }
 private sealEntry(build:(head:PrimarySyncAck)=>Omit<PrimaryIntent,'hash'>):PrimaryIntent{
  return this.transaction(()=>{const head=this.head();if(head.revision!==this.appliedRevision)throw new PrimarySyncBlocked('a sealed candidate is already unresolved');
   const body=build(head),intent={...body,hash:hash(body)} as PrimaryIntent;this.insert(intent);return copy(intent);
  });
 }
 seal(deltas:StorageWrite[],validatedAt:number):PrimaryCommitIntent{
  return this.sealEntry(head=>({version:1 as const,config:this.config,revision:head.revision+1,previousHash:head.hash,batchHash:hash(deltas.slice(0,-1)),deltas:copy(deltas),validatedAt})) as PrimaryCommitIntent;
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
 transition<T extends Json>(id:string):T|null{const v=this.meta('transition:'+id);return v?JSON.parse(v):null;}
 saveTransition(id:string,value:Json){if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id))throw new PrimarySyncBlocked('invalid transition ID');this.transaction(()=>this.setMeta('transition:'+id,canonical(value)));}
 markApplied(i:PrimaryIntent,recovered=false){this.transaction(()=>{const stored=this.intent(i.revision);if(!stored||stored.hash!==i.hash)throw new PrimarySyncBlocked('cannot apply an unknown intent');if(this.appliedRevision===i.revision)return;if(this.appliedRevision!==i.revision-1)throw new PrimarySyncBlocked('applied history gap');this.setMeta('applied',String(i.revision));if(recovered)this.setMeta('recoveredCommitted',canonical([...this.recoveredCommitted,i.revision]));});}
 close(){this.db.close();}
}
async function apply(storage:Storage,journal:PrimarySyncJournal,intent:PrimaryIntent,ctx:Context,recovered=false):Promise<Seq|null>{
 const m=await marker(storage,journal.configAt(intent.revision),ctx),expected=markerOf(intent);
 if(m&&canonical(m.value)===canonical(expected)){journal.markApplied(intent,recovered);return null;}
 const previous=intent.revision>1?journal.intent(intent.revision-1):null;
 if(intent.revision===1?m!==null:!m||m.value.configHash!==journal.configHashAt(intent.revision-1)||m.value.revision!==intent.revision-1||m.value.batchHash!==previous?.batchHash||m.value.previousHash!==previous?.previousHash)throw new PrimarySyncBlocked('data marker disagrees with the complete journal prefix');
 const seq=await storage.commit(copy(intent.deltas),ctx);journal.markApplied(intent,recovered);return seq;
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
export function primarySyncStorage(storage:Storage,journal:PrimarySyncJournal,peer:PrimarySyncPeer|null,o:{assertPrimary:()=>Promise<void>;now?:()=>number}):Storage{
 let poisoned=false,busy=false;
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
   }catch(e){if(sealed){poisoned=true;throw new CommitSealed(sealed,e);}throw e;}finally{busy=false;}
  };
 }});
}
