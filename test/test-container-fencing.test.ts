import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {ContainerFencing,ContainerFencingError,type CommandRunner} from '../src/index.ts';

/** Fake docker host: one container per name, a user unit that (unless its drop-in blocks it) starts the container. */
function fakeHost(dir:string,o:{stuck?:boolean}={}){
 const c:Record<string,{running:boolean;restart:string}>={'host-a':{running:true,restart:'unless-stopped'},'member-1':{running:true,restart:'unless-stopped'}};
 const units:Record<string,{container:string;active:boolean}>={'host-a.service':{container:'host-a',active:true}};const calls:string[]=[];
 const blocked=(u:string)=>existsSync(join(dir,u+'.d','zz-phi-spaces-fenced.conf'));
 const run:CommandRunner=async(cmd,args)=>{calls.push([cmd,...args].join(' '));const ok=(stdout='')=>({code:0,stdout,stderr:''});
  if(cmd==='docker'&&args[0]==='inspect'){const x=c[args.at(-1)!];return x?ok(`${x.running} "${x.restart}"`):{code:1,stdout:'',stderr:'no such container'};}
  if(cmd==='docker'&&args[0]==='update'){c[args.at(-1)!]!.restart=args[1]!.slice('--restart='.length);return ok();}
  if(cmd==='docker'&&args[0]==='stop'){if(!o.stuck)c[args.at(-1)!]!.running=false;return ok();}
  if(cmd==='systemctl'&&args[1]==='daemon-reload')return ok();
  if(cmd==='systemctl'&&args[1]==='is-active'){const u=units[args[2]!];return {code:u?.active?0:3,stdout:u?.active?'active\n':'inactive\n',stderr:''};}
  if(cmd==='systemctl'&&args[1]==='stop'){const u=units[args[2]!]!;u.active=false;return ok();}
  if(cmd==='systemctl'&&args[1]==='start'){const u=units[args[2]!]!;if(blocked(args[2]!))return ok();u.active=true;c[u.container]!.running=true;return ok();}
  return {code:1,stdout:'',stderr:'unexpected '+cmd};};
 return {c,units,calls,run};
}

test('container fencing release fails closed without the saved fence state',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'container-fencing-nostate-'));
 try{
  const h=fakeHost(dir),f=new ContainerFencing({pins:{'phase1b-host-a':{container:'host-a',unit:'host-a.service'}},unitDir:dir,stateFile:join(dir,'state.json'),run:h.run});
  await f.fence('phase1b-host-a','state test');rmSync(join(dir,'state.json'));
  await assert.rejects(f.release('phase1b-host-a','quarantine'),/no saved fence state/);
  assert.equal(h.c['host-a']!.running,false,'nothing was started');assert.ok(existsSync(join(dir,'host-a.service.d','zz-phi-spaces-fenced.conf')),'the lock stays');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('container fencing release refuses a unit that still carries another fencing drop-in',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'container-fencing-foreign-'));
 try{
  const h=fakeHost(dir),f=new ContainerFencing({pins:{'phase1b-host-a':{container:'host-a',unit:'host-a.service'}},unitDir:dir,stateFile:join(dir,'state.json'),run:h.run});
  await f.fence('phase1b-host-a','upgrade test');
  writeFileSync(join(dir,'host-a.service.d','zz-former-fenced.conf'),'[Unit]\nConditionPathExists=/nonexistent/former\n');
  await assert.rejects(f.release('phase1b-host-a','quarantine'),/another fencing drop-in \(zz-former-fenced\.conf\)/);
  assert.equal(h.c['host-a']!.running,false,'nothing was started');assert.ok(existsSync(join(dir,'host-a.service.d','zz-phi-spaces-fenced.conf')),'our lock stays');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('container fencing locks the pinned container three ways, verifies live state and releases into a started unit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'container-fencing-'));
 try{
  const h=fakeHost(dir),f=new ContainerFencing({pins:{'phase1b-host-a':{container:'host-a',unit:'host-a.service'}},unitDir:dir,stateFile:join(dir,'state.json'),run:h.run});
  await assert.rejects(f.fence('phase1b-member-1','x'),ContainerFencingError,'only pinned hosts');
  const proof=await f.fence('phase1b-host-a','promotion test');
  assert.deepEqual([proof.kind,proof.restartLocked,(proof.evidence as any).container],['container',true,'host-a']);
  assert.deepEqual(h.c['host-a'],{running:false,restart:'no'});assert.equal(h.units['host-a.service']!.active,false);
  assert.ok(existsSync(join(dir,'host-a.service.d','zz-phi-spaces-fenced.conf')));assert.deepEqual(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')),{'phase1b-host-a':{restartPolicy:'unless-stopped'}});
  assert.equal(h.c['member-1']!.running,true,'other containers untouched');
  // The unit lock holds against an operator start; verify re-reads the live state.
  await h.run('systemctl',['--user','start','host-a.service']);assert.equal(h.c['host-a']!.running,false);
  assert.equal(await f.verify(proof),true);
  assert.equal(await f.verify({...proof,hostId:'phase1b-member-1'}),false,'evidence never selects a container');
  h.c['host-a']!.running=true;assert.equal(await f.verify(proof),false,'a running container is not fenced');h.c['host-a']!.running=false;
  // Fencing again keeps the original restart policy for release.
  await f.fence('phase1b-host-a','again');assert.deepEqual(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')),{'phase1b-host-a':{restartPolicy:'unless-stopped'}});
  await f.release('phase1b-host-a','quarantine');
  assert.deepEqual(h.c['host-a'],{running:true,restart:'unless-stopped'});assert.equal(h.units['host-a.service']!.active,true);
  assert.equal(existsSync(join(dir,'host-a.service.d','zz-phi-spaces-fenced.conf')),false);assert.deepEqual(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')),{});
  // A container that does not stop is reported, never claimed as fenced.
  const s=fakeHost(dir,{stuck:true}),g=new ContainerFencing({pins:{'phase1b-host-a':{container:'host-a',unit:'host-a.service'}},unitDir:dir,stateFile:join(dir,'state2.json'),run:s.run});
  await assert.rejects(g.fence('phase1b-host-a','x'),/not fenced/);
  assert.throws(()=>new ContainerFencing({pins:{'x':{container:'a b',unit:'u.service'}},unitDir:dir,stateFile:join(dir,'s.json'),run:h.run}),ContainerFencingError);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
