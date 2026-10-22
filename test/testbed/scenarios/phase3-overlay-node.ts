// Isolated operator-controlled fixture. Peer-IP and private-token scoped exchange; no normal service data.
import {createInterface} from 'node:readline';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as ctx} from '../../../src/context.ts';
import {EntryReplicationController,EntryReplicationPump,EntryReplicationUnavailable,serveSpace,socketTransport,type EntryMutation,type EntryStreamIdentity} from '../../../src/index.ts';
const [home,replicaId,bindIp,allowedIp,token]=process.argv.slice(2);
if(!home||!['a','b'].includes(replicaId!)||!/^100\.[0-9.]+$/.test(bindIp!)||!/^100\.[0-9.]+$/.test(allowedIp!)||!/^\w{48,128}$/.test(token!))throw Error('private fixture arguments required');
mkdirSync(home,{recursive:true,mode:0o700});let host=await Harness.open(await openNodeSqliteStorage(join(home,'entries.sqlite')),{models:createModels(),registry:createRegistry()},ctx);
const controller=()=>new EntryReplicationController({host,ctx,config:{spaceId:'isolated-overlay-phase3',authorityId:'isolated-overlay-authority',replicaId:replicaId!,incarnation:'v1',members:['a','b'].map(replicaId=>({replicaId,incarnation:'v1'})),rules:[{type:'State',variant:'lww',keyFields:['key']},{type:'Fact',variant:'set'}]},authorize:async()=>{},assertActive:async()=>{},clockUncertaintyMs:()=>0});
let server:Awaited<ReturnType<typeof serveSpace>>|undefined;let received=0;const commands=createInterface({input:process.stdin});
const listen=async()=>{if(server)return;server=await serveSpace({handleText:async(text)=>{
 const c=JSON.parse(text);if(c.token!==token)throw Error('fixture authorization failed');let result:unknown;
 if(c.method==='describe')result=await controller().describeStream();else if(c.method==='changes')result=await controller().streamChanges(c.after,c.maxBytes);else if(c.method==='snapshot')result=await controller().startSnapshot(c.maxBytes);else if(c.method==='snapshotPage')result=await controller().snapshotPage(c.snapshotId,c.index);else if(c.method==='startImport')result=await controller().startStreamImport(c.source);else if(c.method==='importPage')result=await controller().importStreamPage(c.page);else throw Error('fixture exchange method denied');received++;return JSON.stringify({ok:true,result});
}},{listen:{host:bindIp!,port:17431},connection:socket=>socket.remoteAddress?.replace(/^::ffff:/,'')===allowedIp?{}:null,maxConnections:4});};
const stop=async()=>{await server?.close();server=undefined;};
console.log(JSON.stringify({ready:true,replicaId,ip:bindIp,revision:(await controller().describeStream()).revision}));
try{for await(const line of commands){let q:any;try{q=JSON.parse(line);let result:unknown;
 if(q.op==='listen'){await listen();result={listening:true};}
 else if(q.op==='partition'){await stop();result={listening:false,at:Date.now()};}
 else if(q.op==='mutate')result=await controller().mutate(q.requestId,q.mutation as EntryMutation);
 else if(q.op==='describe')result=await controller().describeStream();
 else if(q.op==='status')result={entries:await controller().read(),stream:await controller().describeStream(),received,at:Date.now()};
 else if(q.op==='maintain'){let j=await controller().startSnapshotMaintenance(q.requestId,8192);while(j.phase!=='completed')j=await controller().advanceSnapshotMaintenance(q.requestId);result={phase:j.phase};}
 else if(q.op==='reopen'){await host.close(ctx);host=await Harness.open(await openNodeSqliteStorage(join(home,'entries.sqlite')),{models:createModels(),registry:createRegistry()},ctx);result={reopened:true};}
 else if(q.op==='pull'||q.op==='bootstrap'||q.op==='exchange'){
  if(q.host!==allowedIp)throw Error('unprovisioned source endpoint');const transport=socketTransport({host:q.host,port:17431},{localAddress:bindIp,connectTimeoutMs:3000});
  const read=async(method:string,args:Record<string,unknown>={})=>{try{const response=await transport.request(JSON.stringify({method,token,...args}));const reply=JSON.parse(response);if(!reply.ok)throw Error('export rejected');return reply.result;}catch(e){throw new EntryReplicationUnavailable('overlay exchange failed: '+(e instanceof Error?e.message:'unknown'));}};
  try{const source=await read('describe');let snapshotId:string|undefined;
   if(q.op==='bootstrap'){const m=await read('snapshot',{maxBytes:8192});await controller().beginSnapshotImport(m);for(let n=0;n<m.pageCount;n++)await controller().importSnapshotPage(m.id,await read('snapshotPage',{snapshotId:m.id,index:n}));await controller().finishSnapshotImport(m.id);snapshotId=m.id;}
   const pump=new EntryReplicationPump({target:controller(),source:{describe:()=>read('describe'),changes:(after,maxBytes)=>read('changes',{after,maxBytes})},identity:source.source as EntryStreamIdentity,snapshotId,pageBytes:8192});let step;let pages=0;
   do{step=await pump.step();if(++pages>1024)throw Error('fixture pull exceeds bound');}while(step.more);let sent=0;
   if(q.op==='exchange'){const own=await controller().describeStream(),checkpoint=await read('startImport',{source:own.source});let cursor=checkpoint.cursor;while(cursor<own.revision){const page=await controller().streamChanges(cursor,8192);const applied=await read('importPage',{page});cursor=applied.cursor;if(++sent>1024)throw Error('fixture exchange exceeds bound');}}
   result={...step,pages,sent};
  }finally{transport.close();}
 }
 else if(q.op==='stop'){console.log(JSON.stringify({id:q.id,ok:true,result:{stopped:true}}));break;}
 else throw Error('unknown fixture command');console.log(JSON.stringify({id:q.id,ok:true,result}));
 }catch(e){console.log(JSON.stringify({id:q?.id,ok:false,error:e instanceof Error?e.message:String(e)}));}}
}finally{await stop();await host.close(ctx);}
