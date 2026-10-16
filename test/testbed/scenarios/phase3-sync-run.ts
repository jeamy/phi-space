// Driver for the phase 3 primary/sync acceptance (plan 3.4/3.5): nanoi primary, standby-100 sync standby, a sealed
// candidate without ACK, netcup fencing of the primary, promotion and degradeToSingle on the standby, release of the
// old primary into quarantine, an empty setStandby back to it and a comparison of both materialized states.
// `--local DIR` runs the same steps on loopback with a local register and the simulator adapter; the remote run is
// started only with `--remote CONFIG` (see docs/ap3-replica-control.md) and changes real hosts.
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalJson,SqliteRecoveryRegister,TlsRecoveryRegister,TlsFencing,releaseHostToQuarantine,provisionFileSigner,type RecoveryRegister,type FencingAdapter,type PrimarySyncConfig} from '../../../src/index.ts';

const AUTH='a-c22244a8-b5d3-43f8-84e6-0a7a92004f54',SPACE='phase3-sync',P='nano-test',S='standby-100';
const genesis:PrimarySyncConfig={spaceId:SPACE,authorityId:AUTH,primaryEpoch:1,replicaConfigVersion:1,primaryReplica:P,standbyReplica:S,durability:'sync'};
const canonical=(v:unknown)=>canonicalJson(v as any);
const permit=(role:'primary'|'standby',inc:string)=>({state:'active',authorityId:AUTH,dataIncarnation:inc,role,primaryEpoch:1,replicaConfigVersion:1,durability:'sync',transitionId:'phase3-sync-setup'});

class Node{
 private child:ChildProcessWithoutNullStreams;private waiting=new Map<number,(v:any)=>void>();private next=1;ready:Promise<any>;exited=false;readonly name:string;
 constructor(name:string,cmd:string,args:string[],log:(s:string)=>void){
  this.name=name;
  this.child=spawn(cmd,args,{stdio:['pipe','pipe','pipe']});let first:(v:any)=>void;this.ready=new Promise(r=>first=r);
  createInterface({input:this.child.stdout}).on('line',l=>{if(process.env.SYNC_DEBUG)log(`${name} raw ${l.slice(0,160)}`);let m:any;try{m=JSON.parse(l);}catch{log(`${name} | ${l}`);return;}if(m.ready){first(m);return;}const w=this.waiting.get(m.id);if(w){this.waiting.delete(m.id);w(m);}});
  createInterface({input:this.child.stderr}).on('line',l=>{if(!/ExperimentalWarning|trace-warnings/.test(l))log(`${name} ! ${l}`);});
  this.child.on('exit',()=>{this.exited=true;for(const w of this.waiting.values())w({ok:false,error:'node exited'});this.waiting.clear();});
 }
 async call(op:string,args:Record<string,unknown>={}):Promise<any>{const id=this.next++;const p=new Promise<any>(r=>this.waiting.set(id,r));this.child.stdin.write(JSON.stringify({id,op,...args})+'\n');const m=await p;if(!m.ok)throw Error(`${this.name}.${op}: ${m.error}`);return m.result;}
 async stop(){if(this.exited)return;this.child.stdin.end();await new Promise(r=>{this.child.once('exit',r);setTimeout(r,15000);});}
 kill(){this.child.kill('SIGKILL');}
}

type Env={register:RecoveryRegister;operatorFencing:FencingAdapter|null;startPrimary:()=>Node;startStandby:()=>Node;fencePrimaryProcess:(n:Node)=>Promise<void>;afterRelease:()=>Promise<void>;out:string};
async function scenario(env:Env){
 const log:any[]=[],step=(name:string,data:unknown=null)=>{const e={at:new Date().toISOString(),name,data};log.push(e);console.log(e.at,name,JSON.stringify(data)?.slice(0,400));};
 const check=(cond:boolean,what:string)=>{if(!cond)throw Error('check failed: '+what);step('check',what);};
 const report=(passed:boolean,error?:string)=>writeFileSync(join(env.out,'report.json'),JSON.stringify({passed,error:error??null,log},null,1));
 let p:Node|undefined,s:Node|undefined;
 try{
  p=env.startPrimary();s=env.startStandby();step('primary ready',await p.ready);step('standby ready',await s.ready);
  await s.call('listen');const opened=await p.call('open-primary');step('primary opened',opened.config);
  const before=await p.call('write',{count:5,label:'before'});check(before.writes.every((w:any)=>w.ok),'five sync writes confirmed by the standby');
  check((await s.call('status')).head.hash===before.head.hash,'standby journal head equals primary head');
  await s.call('unlisten');const fork=await p.call('write',{count:1,label:'fork'});const sealed=fork.writes[0].sealed;
  check(!fork.writes[0].ok&&!!sealed,'write without standby ACK is sealed, not committed');step('fork candidate',sealed);
  await p.call('close');await env.fencePrimaryProcess(p);
  const proof=await s.call('fence',{target:P,reason:'phase3 sync acceptance: primary lost'});step('fence proof',{kind:proof.kind,restartLocked:proof.restartLocked,evidence:proof.evidence});
  check(await s.call('verify')===true,'fencing proof verifies');
  const promoted=await s.call('promote',{tid:'phase3-promote-1',epoch:1,version:1});step('promoted',promoted.config);
  check(promoted.config.primaryReplica===S&&promoted.config.standbyReplica===P&&promoted.config.primaryEpoch===2,'standby is primary with epoch 2, old primary named as standby');
  const atFork=await s.call('intent',{revision:sealed.revision});check(!atFork||atFork.hash!==sealed.hash,'the unacknowledged fork is not part of the promoted history');step('promoted entry at fork revision',atFork);
  await s.call('open-primary');const blocked=await s.call('write',{count:1,label:'sealed-on-new-primary'});const pending=blocked.writes[0].sealed;
  check(!blocked.writes[0].ok&&!!pending,'without a live standby a write stays sealed and unconfirmed');step('sealed on the promoted primary',pending);await s.call('close');
  const degraded=await s.call('degrade',{tid:'phase3-degrade-1',epoch:2,version:2});step('degraded',degraded.config);
  check(degraded.config.durability==='single'&&degraded.config.primaryEpoch===3,'single durability with epoch 3');
  check(canonical(degraded.recoveredCommitted)===canonical([pending.revision]),'degradeToSingle completed exactly the sealed candidate after the fencing proof');
  await s.call('open-primary');const single=await s.call('write',{count:3,label:'single'});check(single.writes.every((w:any)=>w.ok),'single writes on the promoted primary');await s.call('close');
  await releaseHostToQuarantine(env.register,P,'phase3-release-1',env.operatorFencing??undefined);step('old primary released into quarantine',(await env.register.get<any>('boot:'+P))?.value.state);
  await env.afterRelease();p=env.startPrimary();step('old primary restarted',(await p.ready).head);
  const wiped=await p.call('wipe');step('old sync history moved aside',{aside:wiped.aside,head:wiped.head});await p.call('listen');
  const set=await s.call('set-standby',{tid:'phase3-standby-1',target:P,targetIncarnation:'sync-nano-2'});step('setStandby',set.config);
  check(set.config.standbyReplica===P&&set.config.durability==='sync','old primary is the new sync standby');
  check((await env.register.get<any>('boot:'+P))?.value.state==='active','old primary left quarantine');
  await s.call('open-primary');const after=await s.call('write',{count:3,label:'after-setstandby'});check(after.writes.every((w:any)=>w.ok),'sync writes in the new direction');
  const ss=await s.call('state');await p.call('unlisten');const ps=await p.call('state');step('final states',{standby100:{entries:ss.entries,snapshot:ss.snapshot,head:ss.head},nano:{entries:ps.entries,snapshot:ps.snapshot,head:ps.head}});
  check(ss.entries===12&&ps.entries===12,'twelve probes: five before, one recovered candidate, three single, three after; no fork');
  check(ss.snapshot===ps.snapshot&&ss.head.hash===ps.head.hash,'both materialized states and journal heads are identical');
  report(true);step('PASSED');
 }catch(e){step('FAILED',(e as Error).message);report(false,(e as Error).message);process.exitCode=1;}
 finally{await p?.stop();await s?.stop();}
}

const here=fileURLToPath(new URL('.',import.meta.url)),args=process.argv.slice(2);
if(args[0]==='--local'){
 const dir=resolve(args[1]??'phase3-sync-local');mkdirSync(dir,{recursive:true,mode:0o700});
 const register=new SqliteRecoveryRegister(join(dir,'register.sqlite'));
 const keys:Record<string,ReturnType<typeof provisionFileSigner>>={[P]:provisionFileSigner(join(dir,'keys',P+'.json')),[S]:provisionFileSigner(join(dir,'keys',S+'.json'))};
 await register.compareAndSet('boot:'+P,null,{hostId:P,state:'active',spaces:{[SPACE]:permit('primary','sync-nano-1')}});
 await register.compareAndSet('boot:'+S,null,{hostId:S,state:'active',spaces:{[SPACE]:permit('standby','sync-100-1')}});
 const pin=(h:string,port:number)=>({hostId:h,algorithm:'ed25519',publicKey:keys[h]!.publicKey,ip:'127.0.0.1',port});
 const conf=(self:string,other:string,inc:string,port:number,fencing:unknown)=>{const f=join(dir,self+'.json');writeFileSync(f,JSON.stringify({self,bindIp:'127.0.0.'+(self===P?'1':'2'),port,signerFile:join(dir,'keys',self+'.json'),remotes:[{...pin(other,port),ip:'127.0.0.'+(other===P?'1':'2')}],genesis,dataIncarnation:inc,register:{sqlite:join(dir,'register.sqlite')},fencing}));return f;};
 const node=(self:string,f:string)=>new Node(self,process.execPath,[...(process.env.SYNC_REPORT_DIR?['--report-on-signal','--report-directory='+process.env.SYNC_REPORT_DIR]:[]),'--experimental-strip-types',join(here,'phase3-sync-node.ts'),join(dir,self),f],l=>console.log(l));
 const pf=conf(P,S,'sync-nano-1',17432,null),sf=conf(S,P,'sync-100-1',17432,{simulator:true});
 await scenario({register,operatorFencing:null,startPrimary:()=>node(P,pf),startStandby:()=>node(S,sf),fencePrimaryProcess:async n=>{n.kill();},afterRelease:async()=>{},out:dir});
 register.close();
}else if(args[0]==='--remote'){
 const rc=JSON.parse(readFileSync(args[1]!,'utf8'));const register=new TlsRecoveryRegister(rc.operatorRegister),fencing=new TlsFencing(rc.operatorFencing);
 // primary/standby: {ssh: string[] (e.g. ["big","ssh","nanoi"]), command: string}; nothing is shipped from here.
 const ssh=(name:string,c:{ssh:string[];command:string})=>new Node(name,'ssh',['-o','ServerAliveInterval=15',...c.ssh,c.command],l=>console.log(l));
 const {execFileSync}=await import('node:child_process');
 const waitUp=async()=>{for(let i=0;i<90;i++){try{execFileSync('ssh',['-o','ConnectTimeout=5',...rc.primary.ssh,'docker inspect -f {{.State.Running}} '+rc.primary.container],{stdio:'ignore'});return;}catch{await new Promise(r=>setTimeout(r,5000));}}throw Error('old primary did not come back');};
 mkdirSync(rc.out,{recursive:true,mode:0o700});
 await scenario({register,operatorFencing:fencing,startPrimary:()=>ssh(P,rc.primary),startStandby:()=>ssh(S,rc.standby),fencePrimaryProcess:async n=>{await n.stop();},afterRelease:waitUp,out:rc.out});
}else throw Error('use --local DIR or --remote CONFIG');
