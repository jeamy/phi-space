import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash,X509Certificate} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import {NetcupScp,NetcupFencing,NetcupError,fileTokenProvider,fileFenceState,serveFencing,TlsFencing,SimulatorFencing,type FenceProof} from './src/index.ts';

const NANO={serverId:964249,mac:'2a:38:5f:38:de:22'};
/** Fake SCP following the spec shapes: GET server/interfaces, one-attribute PATCH with 202 tasks, task polling. */
function fakeScp(o:{failTask?:boolean;maintenance?:boolean;ignorePowerOff?:boolean}={}){
 const servers:Record<number,{state:string;autostart:boolean;macs:string[]}>={964249:{state:'RUNNING',autostart:true,macs:[NANO.mac]},730972:{state:'RUNNING',autostart:true,macs:['aa:bb:cc:dd:ee:ff']}};
 const calls:string[]=[],tasks=new Map<string,()=>void>();let n=0;
 const json=(status:number,body:unknown)=>new Response(body===undefined?'':JSON.stringify(body),{status});
 const f=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input)),path=url.pathname.replace('/scp-core/api/v1',''),method=init?.method??'GET';
  assert.equal((init?.headers as any).Authorization,'Bearer access-1');calls.push(`${method} ${path}${url.search}`);
  if(o.maintenance&&method==='PATCH')return json(503,{code:'maintenance',message:'Node is in maintenance mode.'});
  let m=path.match(/^\/servers\/(\d+)$/);const s=m?servers[+m[1]]:undefined;
  if(m&&method==='GET')return s?json(200,{id:+m[1],serverLiveInfo:{state:s.state,autostart:s.autostart}}):json(404,{message:'not found'});
  if(m&&method==='PATCH'){
   assert.equal((init?.headers as any)['Content-Type'],'application/merge-patch+json');const body=JSON.parse(String(init?.body));assert.equal(Object.keys(body).length,1,'one attribute per call');
   const apply=()=>{if('autostart' in body)s!.autostart=body.autostart;if(body.state==='OFF'&&!o.ignorePowerOff)s!.state='SHUTOFF';if(body.state==='ON')s!.state='RUNNING';};
   const uuid='task-'+(++n);tasks.set(uuid,apply);return json(202,{uuid,state:'PENDING'});
  }
  m=path.match(/^\/servers\/(\d+)\/interfaces$/);if(m)return json(200,servers[+m[1]].macs.map(mac=>({mac})));
  m=path.match(/^\/tasks\/(.+)$/);if(m){const run=tasks.get(m[1])!;if(o.failTask)return json(200,{uuid:m[1],state:'ERROR'});run();return json(200,{uuid:m[1],state:'FINISHED'});}
  return json(404,{message:'unknown'});
 }) as typeof fetch;
 return {servers,calls,scp:new NetcupScp({fetch:f,accessToken:async()=>'access-1',pollMs:1,taskTimeoutMs:1000})};
}

test('netcup fencing pins identity, disables autostart before a hard power-off and proves SHUTOFF; release restores and boots',async()=>{
 const t=fakeScp(),dir=mkdtempSync(join(tmpdir(),'netcup-')),a=new NetcupFencing(t.scp,{'nano-test':NANO},fileFenceState(join(dir,'state.json')));
 try{
  const proof=await a.fence('nano-test','primary lost');
  assert.deepEqual(t.calls.filter(c=>!c.startsWith('GET /tasks')),['GET /servers/964249/interfaces','GET /servers/964249','PATCH /servers/964249','PATCH /servers/964249?stateOption=POWEROFF','GET /servers/964249']);
  assert.deepEqual({k:proof.kind,l:proof.restartLocked,e:proof.evidence},{k:'cloud',l:true,e:{provider:'netcup',serverId:964249,state:'SHUTOFF',autostart:false,reason:'primary lost'}});
  assert.equal(await a.verify(proof),true);
  // Already locked: a repeated fence does not patch again.
  t.calls.length=0;await a.fence('nano-test','again');assert.equal(t.calls.filter(c=>c.startsWith('PATCH')).length,0);
  // verify re-queries live state and never trusts the proof's server ID.
  t.servers[730972].state='SHUTOFF';t.servers[730972].autostart=false;t.servers[964249].state='RUNNING';
  assert.equal(await a.verify({...proof,evidence:{...(proof.evidence as any),serverId:730972}}),false);
  t.servers[964249].state='SHUTOFF';t.servers[964249].autostart=true;assert.equal(await a.verify(proof),false,'autostart on is no restart lock');
  t.servers[964249].autostart=false;assert.equal(await a.verify({...proof,kind:'simulator'}),false);
  assert.equal(await a.verify({...proof,hostId:'big'}),false);
  await a.release('nano-test','quarantine');assert.deepEqual(t.servers[964249],{state:'RUNNING',autostart:true,macs:[NANO.mac]});
  assert.deepEqual(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')),{});
  // big (730972) is not pinned: never touched.
  await assert.rejects(a.fence('big','x'),/not a netcup fencing target/);
  assert.equal(t.calls.some(c=>c.includes('730972')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('netcup fencing refuses changed identity, failed tasks, maintenance and a server that stays running',async()=>{
 let t=fakeScp();t.servers[964249].macs=['de:ad:be:ef:00:01'];
 await assert.rejects(new NetcupFencing(t.scp,{'nano-test':NANO}).fence('nano-test','x'),/no longer carries the pinned interface/);assert.equal(t.calls.some(c=>c.startsWith('PATCH')),false);
 t=fakeScp({failTask:true});await assert.rejects(new NetcupFencing(t.scp,{'nano-test':NANO}).fence('nano-test','x'),/task ERROR/);
 t=fakeScp({maintenance:true});await assert.rejects(new NetcupFencing(t.scp,{'nano-test':NANO}).fence('nano-test','x'),/maintenance/);
 t=fakeScp({ignorePowerOff:true});await assert.rejects(new NetcupFencing(t.scp,{'nano-test':NANO}).fence('nano-test','x'),/RUNNING .*not fenced/);
 assert.throws(()=>new NetcupFencing(t.scp,{'nano-test':{serverId:1,mac:'XX'}}),/invalid netcup pin/);
 await assert.rejects(new NetcupFencing(t.scp,{'nano-test':NANO}).release('nano-test','other' as 'quarantine'),/only leads into quarantine/);
});

test('token provider refreshes under a lock file, stores a rotated refresh token atomically and caches the access token',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'netcup-token-')),path=join(dir,'netcup.json');writeFileSync(path,JSON.stringify({refreshToken:'r1',servers:{}}),{mode:0o600});
 let calls=0;const f=(async(_u:string,init?:RequestInit)=>{calls++;const p=new URLSearchParams(String(init?.body));assert.equal(p.get('grant_type'),'refresh_token');assert.equal(p.get('client_id'),'scp');
  return new Response(JSON.stringify(p.get('refresh_token')==='r1'?{access_token:'a1',refresh_token:'r2',expires_in:300}:{error:'invalid_grant'}),{status:p.get('refresh_token')==='r1'?200:400});}) as typeof fetch;
 try{
  const token=fileTokenProvider(path,{fetch:f});assert.equal(await token(),'a1');assert.equal(await token(),'a1');assert.equal(calls,1);
  const stored=JSON.parse(readFileSync(path,'utf8'));assert.equal(stored.refreshToken,'r2');assert.ok(stored.rotatedAt);assert.equal(existsSync(path+'.lock'),false);
  await assert.rejects(fileTokenProvider(path,{fetch:f})(),/refresh failed: invalid_grant/);assert.equal(existsSync(path+'.lock'),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

function certificates(dir:string){
 const openssl=(args:string[])=>execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
 openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','2','-subj','/CN=Test Fencing CA']);
 for(const name of ['server','operator','reader']){
  openssl(['req','-newkey','rsa:2048','-nodes','-keyout',`${name}.key`,'-out',`${name}.csr`,'-subj',`/CN=${name}`]);
  writeFileSync(join(dir,`${name}.ext`),name==='server'?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n':'extendedKeyUsage=clientAuth\n',{mode:0o600});
  openssl(['x509','-req','-in',`${name}.csr`,'-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',`${name}.crt`,'-days','2','-extfile',`${name}.ext`]);
  chmodSync(join(dir,`${name}.key`),0o600);chmodSync(join(dir,`${name}.crt`),0o600);
 }
 chmodSync(join(dir,'ca.crt'),0o600);
 return {identity:(n:string)=>({caFile:join(dir,'ca.crt'),certFile:join(dir,`${n}.crt`),keyFile:join(dir,`${n}.key`)}),fingerprint:(n:string)=>createHash('sha256').update(new X509Certificate(readFileSync(join(dir,`${n}.crt`))).raw).digest('hex')};
}

test('fencing service over mutual TLS serves only operator certificates; the client proof passes promote kind checks',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fencing-tls-')),c=certificates(dir),t=fakeScp(),adapter=new NetcupFencing(t.scp,{'nano-test':NANO});
 const server=await serveFencing(adapter,{...c.identity('server'),host:'127.0.0.1',port:0,peers:{[c.fingerprint('operator')]:{operator:true},[c.fingerprint('reader')]:{}}});
 const port=(server.address() as {port:number}).port,client=(n:string)=>new TlsFencing({...c.identity(n),host:'127.0.0.1',port,serverName:'127.0.0.1',timeoutMs:5000});
 try{
  await assert.rejects(client('reader').fence('nano-test','x'));assert.equal(t.calls.length,0,'a reader certificate cannot fence');
  const op=client('operator'),proof=await op.fence('nano-test','primary lost');assert.equal(proof.kind,'cloud');assert.equal(await op.verify(proof),true);
  await assert.rejects(op.fence('big','x'),(e:Error)=>e instanceof NetcupError&&/not a netcup fencing target/.test(e.message));
  await assert.rejects(op.fence('../x','x'),/invalid host ID/);
  // A remote cloud proof is not accepted by a simulator adapter.
  const sim=new SimulatorFencing();assert.equal(await sim.verify(proof as FenceProof),false);
  await op.release('nano-test');assert.equal(t.servers[964249].state,'RUNNING');
 }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
});
