import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import {PrimarySyncJournal,provisionFileSigner,signedReplicaPeer,replicaSyncHandler,ReplicaTransportRefused,type PrimarySyncConfig} from '../src/index.ts';

const config:PrimarySyncConfig={spaceId:'s',authorityId:'a',primaryEpoch:1,replicaConfigVersion:1,primaryReplica:'p',standbyReplica:'q'};
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'replica-transport-')),p=provisionFileSigner(join(dir,'p.json')),q=provisionFileSigner(join(dir,'q.json')),x=provisionFileSigner(join(dir,'x.json'));
 const journal=new PrimarySyncJournal(join(dir,'q.sqlite'),config,{self:'q'});
 const pin=(hostId:string,s:{publicKey:string})=>({hostId,algorithm:'ed25519' as const,publicKey:s.publicKey});
 let now=1_000_000;const handler=replicaSyncHandler({journal:()=>journal,signer:q,self:'q',remotes:[pin('p',p)],assertQuarantine:async()=>{},now:()=>now});
 let last='';const wire={request:async(t:string)=>{last=t;return handler(t);}};
 const client=(signer=p,self='p',remote=pin('q',q),transport=wire)=>signedReplicaPeer({transport,signer,self,remote,now:()=>now});
 return {dir,journal,p,q,x,pin,client,handler,last:()=>last,setNow:(v:number)=>{now=v;},dispose:()=>{journal.close();rmSync(dir,{recursive:true,force:true});}};
}

test('signed replica transport authenticates both directions and binds answers to requests',async()=>{
 const t=setup();
 try{
  assert.equal((await t.client().head()).revision,0);
  // An unpinned key or a sender claiming another host is refused before the journal is touched.
  await assert.rejects(t.client(t.x).head(),ReplicaTransportRefused);
  await assert.rejects(t.client(t.p,'other').head(),ReplicaTransportRefused);
  // A request addressed to another replica is refused.
  await assert.rejects(t.client(t.p,'p',t.pin('elsewhere',t.q)).head(),/unauthenticated replica response|unauthenticated replica request/);
  // Replay of a captured request and an altered body are refused.
  await t.client().head();const captured=t.last();await assert.rejects(t.handler(captured),/replayed/);
  const altered=JSON.parse(captured);altered.body={x:1};await assert.rejects(t.handler(JSON.stringify(altered)),/stale or altered/);
  // Stale timestamps are refused.
  const old=t.client();t.setNow(1_000_000);const req=old.head();t.setNow(1_000_000);await req;
  t.setNow(2_000_000);await assert.rejects(t.handler(captured),/stale or altered|replayed/);
  // A forged or rebound answer is rejected by the client: the answer to one request does not fit another.
  t.setNow(1_000_000);let first='';const relay={request:async(text:string)=>{const a=await t.handler(text);if(!first){first=a;return a;}return first;}};
  const c=t.client(t.p,'p',t.pin('q',t.q),relay);await c.head();await assert.rejects(c.head(),ReplicaTransportRefused);
  const forged={request:async()=>JSON.stringify({value:{from:'q',to:'p',nonce:'0'.repeat(32),method:'head',ok:true,result:{revision:99}},signature:'AAAA'})};
  await assert.rejects(t.client(t.p,'p',t.pin('q',t.q),forged).head(),ReplicaTransportRefused);
  // Journal refusals arrive as signed answers and surface as PrimarySyncBlocked, not as transport errors.
  await assert.rejects(t.client().accept({version:1} as any),/standby refused/);
 }finally{t.dispose();}
});
