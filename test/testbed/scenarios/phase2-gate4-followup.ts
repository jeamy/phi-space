// Focused follow-up for silent connections and actual serialized storage writes.
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { StorageWrite } from '@earendil-works/pi-durable';
import { PiSpaces, core, startGate } from '../../../src/index.ts';
import { PersistentHome, ctx } from '../../support/persistent.ts';
const output=process.argv[2];if(!output)throw new Error('report directory required');mkdirSync(output,{recursive:true});
const writes: Array<{backend:string;serializedStorageWritesBytes:number;admittedEntries:number}> = [];
for(const backend of ['jsonl','sqlite'] as const){
 const home=new PersistentHome(backend),original=home.storage.bind(home);let measured=0;
 home.storage=async()=>{const storage=await original();return new Proxy(storage,{get(target,key,receiver){const v=Reflect.get(target,key,receiver);if(key==='commit')return async(w:readonly StorageWrite[],c:typeof ctx)=>{measured=Buffer.byteLength(JSON.stringify(w));return target.commit(w,c);};return typeof v==='function'?v.bind(target):v;}});};
 try{const host=await home.open(),client=new PiSpaces(host,ctx);const txn=(await client.createTransaction(60000)).id;let admitted=0;
  for(;admitted<10;admitted++){try{await client.write({type:'Boundary',fields:{pad:'z'.repeat(60000)}},txn,core.FOREVER);}catch(e){assert.ok(e instanceof core.ResourceExhausted);break;}}
  assert.ok(admitted>0&&admitted<10);await client.commit(txn);assert.ok(measured<=core.DEFAULT_LIMITS.maxCommitBytes,`actual ${backend} commit ${measured} exceeds ${core.DEFAULT_LIMITS.maxCommitBytes}`);
  writes.push({backend,serializedStorageWritesBytes:measured,admittedEntries:admitted});
 }finally{await home.dispose();}
}
const gate=await startGate({handleText:async()=> '{}'}, {listen:{host:'127.0.0.1',port:0},revalidateMs:0,directory:{async refresh(){},lookup:()=>new Promise(()=>{})}});
const socket=net.createConnection({host:'127.0.0.1',port:(gate.address() as net.AddressInfo).port});socket.on('error',()=>{});
let elapsedMs=0;
try{const start=performance.now();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('silent connection survived 5 s handshake')),8000);socket.once('close',()=>{clearTimeout(timer);resolve();});});elapsedMs=performance.now()-start;assert.ok(elapsedMs>=4900&&elapsedMs<7500);}finally{socket.destroy();await gate.close();}
writeFileSync(join(output,'followup.json'),JSON.stringify({passed:true,date:new Date().toISOString(),node:process.version,storage:writes,silentHandshake:{configuredMs:5000,measuredRefusalMs:elapsedMs,noFrameSent:true},scope:'targeted-boundary-followup'},null,2)+'\n');
console.log(JSON.stringify({stage:'gate4-followup-passed'}));
