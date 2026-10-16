// Complete StorageWrite batches, sealed durably before transport. Administrative storage substrate.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,lstatSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Context} from '@earendil-works/chord';
import type {Storage,StorageWrite,DocumentId,DocumentRecord,Seq} from '@earendil-works/pi-durable';
import {canonicalJson} from './canonical.ts';
import type {Json} from './core.ts';
export type PrimarySyncConfig={spaceId:string;authorityId:string;primaryEpoch:number;replicaConfigVersion:number;primaryReplica:string;standbyReplica:string};
export type PrimaryCommitIntent={version:1;config:PrimarySyncConfig;revision:number;previousHash:string;batchHash:string;deltas:StorageWrite[];validatedAt:number;hash:string};
export type PrimarySyncAck={revision:number;hash:string;configHash:string};
export interface PrimarySyncPeer{accept(intent:PrimaryCommitIntent):Promise<PrimarySyncAck>}
export class PrimarySyncBlocked extends Error{}
export class CommitSealed extends Error{
 readonly revision:number;readonly hash:string;
 constructor(intent:PrimaryCommitIntent,cause?:unknown){super('commit is durably sealed; resolve this candidate before admitting new work',{cause});this.revision=intent.revision;this.hash=intent.hash;}
}
const canonical=(v:unknown)=>canonicalJson(v as Json);
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const copy=<T>(v:T):T=>JSON.parse(canonical(v));
const zero='0'.repeat(64),kind='pi-spaces.primary-sync-storage-marker';
const exact=(v:object,keys:string[])=>Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const name=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
function configOf(input:PrimarySyncConfig){
 const c=copy(input);if(!c||!exact(c,['spaceId','authorityId','primaryEpoch','replicaConfigVersion','primaryReplica','standbyReplica'])||![c.spaceId,c.authorityId,c.primaryReplica,c.standbyReplica].every(name)||c.primaryReplica===c.standbyReplica||!integer(c.primaryEpoch)||c.primaryEpoch<1||!integer(c.replicaConfigVersion)||c.replicaConfigVersion<1)throw new PrimarySyncBlocked('invalid fixed primary/standby configuration');return c;
}
type Marker={configHash:string;revision:number;batchHash:string;previousHash:string};
const address=(spaceId:string)=>({kind,key:spaceId,scope:{kind:'session' as const}});
async function marker(storage:Storage,c:PrimarySyncConfig,ctx:Context):Promise<{record:DocumentRecord;value:Marker}|null>{
 const record=await storage.findDocument(address(c.spaceId),'current',ctx);if(!record)return null;const doc=await storage.document(record.id,'current',ctx);
 if(!doc||doc.version!==1)throw new PrimarySyncBlocked('storage replication marker missing or invalid');return {record,value:doc.value as Marker};
}
/** Dedicated local journal, not the independent recovery register. Open before the Harness. */
export class PrimarySyncJournal implements PrimarySyncPeer{
 private c:PrimarySyncConfig;get config(){return copy(this.c);}readonly configHash:string;readonly maxIntentBytes:number;private db:DatabaseSync;private maxHistoryBytes:number;
 constructor(path:string,config:PrimarySyncConfig,o:{maxIntentBytes?:number;maxHistoryBytes?:number}={}){
  this.c=configOf(config);this.configHash=hash(this.c);this.maxIntentBytes=o.maxIntentBytes??256*1024;this.maxHistoryBytes=o.maxHistoryBytes??64*1024*1024;
  if(!integer(this.maxIntentBytes)||this.maxIntentBytes<32768||this.maxIntentBytes>1024*1024||!integer(this.maxHistoryBytes)||this.maxHistoryBytes<this.maxIntentBytes||this.maxHistoryBytes>1024*1024*1024)throw new PrimarySyncBlocked('invalid journal bounds');
  mkdirSync(dirname(path),{recursive:true,mode:0o700});try{if(lstatSync(path).isSymbolicLink())throw new PrimarySyncBlocked('journal must not be a symlink');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  this.db=new DatabaseSync(path);chmodSync(path,0o600);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sync_intents (revision INTEGER PRIMARY KEY, hash TEXT NOT NULL, intent TEXT NOT NULL)');
  try{
   this.transaction(()=>{const prior=this.meta('config');if(prior&&prior!==canonical(this.config))throw new PrimarySyncBlocked('stored replica configuration changed');if(!prior)this.setMeta('config',canonical(this.config));});
   let previous=zero,revision=0;for(const row of this.db.prepare('SELECT revision,hash,intent FROM sync_intents ORDER BY revision').all()){const i=JSON.parse(row.intent as string) as PrimaryCommitIntent;this.validate(i);if(row.revision!==i.revision||row.hash!==i.hash)throw new PrimarySyncBlocked('journal index disagrees with immutable intent');if(i.revision!==++revision||i.previousHash!==previous)throw new PrimarySyncBlocked('journal history is not a complete prefix');previous=i.hash;}
   if(!integer(this.appliedRevision)||this.appliedRevision>revision)throw new PrimarySyncBlocked('journal applied position exceeds history');
  }catch(e){this.db.close();throw e;}
 }
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private meta(key:string):string|undefined{return(this.db.prepare('SELECT value FROM sync_meta WHERE key=?').get(key) as {value:string}|undefined)?.value;}
 private setMeta(key:string,value:string){this.db.prepare('INSERT INTO sync_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
 get appliedRevision(){return Number(this.meta('applied')??0);}
 head():PrimarySyncAck{const row=this.db.prepare('SELECT revision,hash FROM sync_intents ORDER BY revision DESC LIMIT 1').get() as {revision:number;hash:string}|undefined;return {...(row??{revision:0,hash:zero}),configHash:this.configHash};}
 intent(revision:number):PrimaryCommitIntent|null{if(!integer(revision)||revision<1)throw new PrimarySyncBlocked('invalid commit revision');const row=this.db.prepare('SELECT intent FROM sync_intents WHERE revision=?').get(revision) as {intent:string}|undefined;return row?JSON.parse(row.intent):null;}
 private validate(i:PrimaryCommitIntent){
  if(!i||!exact(i,['version','config','revision','previousHash','batchHash','deltas','validatedAt','hash'])||i.version!==1||canonical(i.config)!==canonical(this.config)||!integer(i.revision)||i.revision<1||!integer(i.validatedAt)||!Array.isArray(i.deltas)||i.deltas.length<2||Buffer.byteLength(canonical(i))>this.maxIntentBytes)throw new PrimarySyncBlocked('invalid or oversized commit intent');
  const {hash:signature,...body}=i;if(signature!==hash(body)||i.batchHash!==hash(i.deltas.slice(0,-1)))throw new PrimarySyncBlocked('commit intent hash changed');
  const mark=i.deltas.at(-1)!;
  if(mark.type!=='document.create'&&mark.type!=='document.change'||mark.content.kind!=='base'||mark.content.version!==1||canonical(mark.content.value)!==canonical({configHash:this.configHash,revision:i.revision,batchHash:i.batchHash,previousHash:i.previousHash}))throw new PrimarySyncBlocked('commit marker does not bind the batch');
  if(mark.type==='document.create'&&canonical({kind:mark.record.kind,key:mark.record.key,scope:mark.record.scope})!==canonical(address(this.config.spaceId)))throw new PrimarySyncBlocked('commit marker address changed');
  for(const write of i.deltas.slice(0,-1))if(write.type==='document.create'&&write.record.kind===kind||write.type==='document.change'&&write.id===(mark.type==='document.create'?mark.record.id:mark.id)||write.type==='document.retire'&&write.id===(mark.type==='document.create'?mark.record.id:mark.id))throw new PrimarySyncBlocked('business batch touches replication marker');
 }
 private insert(i:PrimaryCommitIntent){
  const old=this.intent(i.revision);if(old){if(canonical(old)!==canonical(i))throw new PrimarySyncBlocked('immutable commit revision changed');return;}
  const head=this.head();if(i.revision!==head.revision+1||i.previousHash!==head.hash)throw new PrimarySyncBlocked('commit history gap or fork');
  const encoded=canonical(i),used=(this.db.prepare('SELECT COALESCE(SUM(length(CAST(intent AS BLOB))),0) AS n FROM sync_intents').get() as {n:number}).n;
  if(used+Buffer.byteLength(encoded)>this.maxHistoryBytes)throw new PrimarySyncBlocked('sync history is full; no committed result was discarded');
  this.db.prepare('INSERT INTO sync_intents(revision,hash,intent) VALUES(?,?,?)').run(i.revision,i.hash,encoded);
 }
 seal(deltas:StorageWrite[],validatedAt:number):PrimaryCommitIntent{
  return this.transaction(()=>{const head=this.head();if(head.revision!==this.appliedRevision)throw new PrimarySyncBlocked('a sealed candidate is already unresolved');
   const body={version:1 as const,config:copy(this.config),revision:head.revision+1,previousHash:head.hash,batchHash:hash(deltas.slice(0,-1)),deltas:copy(deltas),validatedAt},intent={...body,hash:hash(body)};this.validate(intent);this.insert(intent);return copy(intent);
  });
 }
 async accept(input:PrimaryCommitIntent):Promise<PrimarySyncAck>{const i=copy(input);this.validate(i);this.transaction(()=>this.insert(i));return {revision:i.revision,hash:i.hash,configHash:this.configHash};}
 markApplied(i:PrimaryCommitIntent){this.transaction(()=>{const stored=this.intent(i.revision);if(!stored||stored.hash!==i.hash)throw new PrimarySyncBlocked('cannot apply an unknown intent');if(this.appliedRevision===i.revision)return;if(this.appliedRevision!==i.revision-1)throw new PrimarySyncBlocked('applied history gap');this.setMeta('applied',String(i.revision));});}
 close(){this.db.close();}
}
async function apply(storage:Storage,journal:PrimarySyncJournal,intent:PrimaryCommitIntent,ctx:Context):Promise<Seq|null>{
 const m=await marker(storage,journal.config,ctx),expected={configHash:journal.configHash,revision:intent.revision,batchHash:intent.batchHash,previousHash:intent.previousHash};
 if(m&&canonical(m.value)===canonical(expected)){journal.markApplied(intent);return null;}
 const previous=intent.revision>1?journal.intent(intent.revision-1):null;
 if(intent.revision===1?m!==null:!m||m.value.configHash!==journal.configHash||m.value.revision!==intent.revision-1||m.value.batchHash!==previous?.batchHash||m.value.previousHash!==previous?.previousHash)throw new PrimarySyncBlocked('data marker disagrees with the complete journal prefix');
 const seq=await storage.commit(copy(intent.deltas),ctx);journal.markApplied(intent);return seq;
}
async function verifyDataPrefix(storage:Storage,journal:PrimarySyncJournal,ctx:Context){
 const m=await marker(storage,journal.config,ctx),applied=journal.appliedRevision;
 if(applied===0){
  if(m)throw new PrimarySyncBlocked('untracked replicated data marker');
  const docs=await storage.scanDocuments({scope:{kind:'session'},at:'current'},1,undefined,ctx),conversations=await storage.scanConversations({},1,undefined,ctx),tasks=await storage.scanTasks({},1,undefined,ctx),submissions=await storage.scanSubmissions({},1,undefined,ctx);
  if(docs.items.length||conversations.items.length||tasks.items.length||submissions.items.length)throw new PrimarySyncBlocked('bootstrap requires an empty dedicated storage domain');
 }else{
  const i=journal.intent(applied)!;
  if(!m||canonical(m.value)!==canonical({configHash:journal.configHash,revision:applied,batchHash:i.batchHash,previousHash:i.previousHash}))throw new PrimarySyncBlocked('materialized data does not match applied journal prefix');
 }
}
/** Materialize all accepted decisions on a stopped standby before opening its Harness. No promotion permission is implied. */
export async function materializeSyncHistory(storage:Storage,journal:PrimarySyncJournal,ctx:Context):Promise<void>{
 // A durable data commit can precede the local journal receipt after an interrupted apply.
 const next=journal.appliedRevision<journal.head().revision?journal.intent(journal.appliedRevision+1):null;
 const current=await marker(storage,journal.config,ctx);
 if(!(next&&current?.value.revision===next.revision&&current.value.batchHash===next.batchHash))await verifyDataPrefix(storage,journal,ctx);
 for(let r=journal.appliedRevision+1;r<=journal.head().revision;r++){const i=journal.intent(r);if(!i)throw new PrimarySyncBlocked('missing accepted prefix');await apply(storage,journal,i,ctx);}
}
/** Resolve the single sealed primary candidate before opening the Harness. Does not reauthorize its business decision. */
export async function recoverPrimarySync(storage:Storage,journal:PrimarySyncJournal,peer:PrimarySyncPeer,ctx:Context,assertPrimary:()=>Promise<void>):Promise<void>{
 if(journal.head().revision-journal.appliedRevision>1)throw new PrimarySyncBlocked('primary has more than one unresolved candidate');
 if(journal.head().revision===journal.appliedRevision){await verifyDataPrefix(storage,journal,ctx);return;}
 const i=journal.intent(journal.head().revision)!,m=await marker(storage,journal.config,ctx);
 if(!m||canonical(m.value)!==canonical({configHash:journal.configHash,revision:i.revision,batchHash:i.batchHash,previousHash:i.previousHash}))await verifyDataPrefix(storage,journal,ctx);
 await assertPrimary();const ack=await peer.accept(copy(i));
 if(canonical(ack)!==canonical({revision:i.revision,hash:i.hash,configHash:journal.configHash}))throw new PrimarySyncBlocked('standby ACK does not match sealed intent');await assertPrimary();await apply(storage,journal,i,ctx);
}
/** Captures every document, claim, task, mailbox and root table write in the supplied storage domain. */
export function primarySyncStorage(storage:Storage,journal:PrimarySyncJournal,peer:PrimarySyncPeer,o:{assertPrimary:()=>Promise<void>;now?:()=>number}):Storage{
 let poisoned=false,busy=false;
 return new Proxy(storage,{get(target,property,receiver){
  if(property!=='commit'){const v=Reflect.get(target,property,receiver);return typeof v==='function'?v.bind(target):v;}
  return async(writes:readonly StorageWrite[],ctx:Context):Promise<Seq>=>{
   if(poisoned||busy||journal.head().revision!==journal.appliedRevision)throw new PrimarySyncBlocked('restart and resolve sealed history before more work');busy=true;let sealed:PrimaryCommitIntent|undefined;
   try{
    await o.assertPrimary();await verifyDataPrefix(storage,journal,ctx);const head=journal.head(),m=await marker(storage,journal.config,ctx);
    if(head.revision===0&&m||head.revision>0&&(!m||m.value.revision!==head.revision||m.value.configHash!==journal.configHash||m.value.batchHash!==journal.intent(head.revision)?.batchHash))throw new PrimarySyncBlocked('replication data marker differs from local history');
    if(!writes.length)throw new PrimarySyncBlocked('empty storage batches are not sync decisions');
    const value={configHash:journal.configHash,revision:head.revision+1,batchHash:hash(writes),previousHash:head.hash};
    const mark:StorageWrite=m?{type:'document.change',id:m.record.id,content:{version:1,kind:'base',value}}:{type:'document.create',record:{...address(journal.config.spaceId),id:await storage.mintId<DocumentId>()},content:{version:1,kind:'base',value}};
    const now=(o.now??Date.now)();if(!integer(now))throw new PrimarySyncBlocked('invalid validation timestamp');
    await o.assertPrimary();sealed=journal.seal([...copy(writes),mark],now);
    const ack=await peer.accept(copy(sealed));if(canonical(ack)!==canonical({revision:sealed.revision,hash:sealed.hash,configHash:journal.configHash}))throw new PrimarySyncBlocked('standby ACK does not match sealed intent');
    await o.assertPrimary();const seq=await apply(storage,journal,sealed,ctx);if(seq===null)throw new PrimarySyncBlocked('unexpected already-applied candidate');return seq;
   }catch(e){if(sealed){poisoned=true;throw new CommitSealed(sealed,e);}throw e;}finally{busy=false;}
  };
 }});
}
