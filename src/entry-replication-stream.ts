// Durable per-source receive positions and an explicitly started, cancellable pull worker.
import { defineDocFamily } from '@earendil-works/pi-durable';
import { canonicalJson } from './canonical.ts';
import type { Json } from './core.ts';
import type { EntryReplicationController, ReplicatedEntryChange } from './entry-replication.ts';
export type EntryStreamIdentity = { version: 1; spaceId: string; authorityId: string; configHash: string; replicaId: string; incarnation: string; streamId: string };
export type EntryStreamDescription = { source: EntryStreamIdentity; revision: number };
/** `positions`: the stream positions of `events`, present only when they are not after+1, after+2, ... (compaction). */
export type EntryStreamPage = { source: EntryStreamIdentity; after: number; next: number; headRevision: number; more: boolean; events: ReplicatedEntryChange[]; positions?: number[]; sha256: string };
export type EntryStreamResult = { added: number; revision: number; cursor: number };
export type EntryStreamCheckpoint = { source: EntryStreamIdentity; cursor: number; seedSnapshotId?: string; last: null | { after: number; next: number; sha256: string; result: EntryStreamResult } };
export const EntryStreamCheckpoints = defineDocFamily<{ links: Record<string, EntryStreamCheckpoint> }, null>({ kind: 'pi-spaces.entry-stream-checkpoints', version: 1, scope: 'session', family: true, initial: () => ({ links: {} }) });
export class EntryStreamCursorConflict extends Error {
 readonly cursor: number;
 constructor(cursor: number) { super('source cursor changed; reload the durable checkpoint'); this.cursor=cursor; }
}
/** Source adapters explicitly classify temporary read/network failures; authorization/storage failures are not retried. */
export class EntryReplicationUnavailable extends Error {}
export interface EntryReplicationSource {
 describe(signal?: AbortSignal): Promise<EntryStreamDescription>;
 changes(after: number, maxBytes: number, signal?: AbortSignal): Promise<EntryStreamPage>;
}
export type EntryReplicationStep = { added:number; revision:number|null; cursor:number; status: 'applied' | 'idle' | 'raced'; more: boolean };
export type EntryReplicationPumpOptions = {
 target: EntryReplicationController; source: EntryReplicationSource; identity: EntryStreamIdentity;
 snapshotId?: string; pageBytes?: number; pollMs?: number; retryMs?: number; maxRetryMs?: number; callTimeoutMs?: number;
 onProgress?: (step: EntryReplicationStep) => void;
};
const canonical=(v:unknown)=>canonicalJson(v as Json);
export class EntryReplicationPump {
 private o: EntryReplicationPumpOptions; private running=false;
 private pageBytes:number; private pollMs:number; private retryMs:number; private maxRetryMs:number; private callTimeoutMs:number;
 constructor(o:EntryReplicationPumpOptions){
  this.o={...o,identity:structuredClone(o.identity)};this.pageBytes=o.pageBytes??Math.floor((o.target.maxBatchBytes-16384)/2);this.pollMs=o.pollMs??1000;this.retryMs=o.retryMs??100;this.maxRetryMs=o.maxRetryMs??5000;this.callTimeoutMs=o.callTimeoutMs??5000;
  if(!Number.isSafeInteger(this.pageBytes)||this.pageBytes<1024||2*this.pageBytes+16384>o.target.maxBatchBytes||[this.pollMs,this.retryMs,this.maxRetryMs,this.callTimeoutMs].some(n=>!Number.isSafeInteger(n)||n<10||n>60000)||this.maxRetryMs<this.retryMs)throw new Error('invalid replication pump bounds');
 }
 private async call<T>(fn:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(signal?.aborted)throw new DOMException('replication stopped','AbortError');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,stop:()=>void=()=>{};
  try{return await Promise.race([Promise.resolve().then(()=>fn(controller.signal)),new Promise<never>((_,reject)=>{
   stop=()=>{reject(new DOMException('replication stopped','AbortError'));controller.abort();};signal?.addEventListener('abort',stop,{once:true});
   timer=setTimeout(()=>{reject(new EntryReplicationUnavailable('source read timed out'));controller.abort();},this.callTimeoutMs);
   if(signal?.aborted)stop();
  })]);}finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();}
 }
 async step(signal?:AbortSignal):Promise<EntryReplicationStep>{
  const description=await this.call(s=>this.o.source.describe(s),signal);
  if(!description||canonical(description.source)!==canonical(this.o.identity)||!Number.isSafeInteger(description.revision)||description.revision<0)throw new Error('replication source identity changed');
  const checkpoint=await this.o.target.startStreamImport(this.o.identity,this.o.snapshotId);
  const page=await this.call(s=>this.o.source.changes(checkpoint.cursor,this.pageBytes,s),signal);
  if(signal?.aborted)throw new DOMException('replication stopped','AbortError');
  if(!page||page.after!==checkpoint.cursor||canonical(page.source)!==canonical(this.o.identity))throw new Error('replication page does not match requested source or cursor');
  try{
   const result=await this.o.target.importStreamPage(page);
   return {...result,status:page.events.length?'applied':'idle',more:page.more};
  }catch(error){
   if(!(error instanceof EntryStreamCursorConflict))throw error;
   const current=await this.o.target.streamImportStatus(this.o.identity);if(!current)throw error;
   return {added:0,revision:null,cursor:current.cursor,status:'raced',more:true};
  }
 }
 private async wait(ms:number,signal:AbortSignal){
  if(signal.aborted)return;await new Promise<void>(resolve=>{let timer:ReturnType<typeof setTimeout>;const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
 }
 /** Only explicitly temporary source failures retry. A target/storage/authorization failure stops the worker. */
 async run(signal:AbortSignal):Promise<void>{
  if(this.running)throw new Error('replication pump is already running');this.running=true;let retry=this.retryMs;
  try{while(!signal.aborted){
   try{const result=await this.step(signal);retry=this.retryMs;this.o.onProgress?.(result);if(!signal.aborted&&(result.status!=='applied'||!result.more))await this.wait(result.status==='raced'?this.retryMs:this.pollMs,signal);}
   catch(error){if(signal.aborted)break;if(!(error instanceof EntryReplicationUnavailable))throw error;await this.wait(retry,signal);retry=Math.min(this.maxRetryMs,retry*2);}
  }}finally{this.running=false;}
 }
}
