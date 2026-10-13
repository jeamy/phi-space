#!/usr/bin/env python3
# Local operator driver: temporary signed-wire fixtures on the existing NetBird test peers.
import subprocess,json,uuid,pathlib,shlex,time,sys,argparse,re
parser=argparse.ArgumentParser(description='Run isolated pi-spaces signed-wire acceptance over the existing NetBird peers')
parser.add_argument('--rpc-faults',action='store_true',help='Inject before-send failures and discard successful replies for each effect kind on each Member (not process crashes)')
parser.add_argument('--rpc-fault-boundary',choices=['beforeSend','afterReply','both'],default='afterReply',help='Inject only before send, only after successful reply, or both; missing outcomes require a current-epoch admission proof')
parser.add_argument('--process-crashes',action='store_true',help='SIGKILL and restart only the owned Root fixture; retain lease epoch and request journals')
parser.add_argument('--process-crash-effect',choices=['SieveTask','SieveResult','take','txn-begin','txn-commit','all'],default='txn-commit')
parser.add_argument('--process-crash-boundary',choices=['beforeSend','afterReply','both'],default='both')
parser.add_argument('--process-crash-members',nargs='+',choices=['a','b','c'],default=['a','b','c'])
parser.add_argument('--ack-crashes',action='store_true',help='Six real Root SIGKILLs before/after mailbox ACKs, with waiting-take races concurrent with the job Workers')
parser.add_argument('--entries',type=int,default=10000,help='Initial total inventory; non-job entries are seeded locally in bounded Member commits')
parser.add_argument('--jobs',type=int,default=1000)
parser.add_argument('--run-id',default=str(int(time.time())))
parser.add_argument('--artifacts',type=pathlib.Path,required=True)
parser.add_argument('--output',type=pathlib.Path,default=pathlib.Path('/tmp/pi-spaces-netbird-phase2'))
args=parser.parse_args();jobs=args.jobs;tag=args.run_id
if args.ack_crashes and (args.process_crashes or args.rpc_faults):parser.error('run ACK crashes separately from other faults')
if args.process_crashes and args.rpc_faults:parser.error('run process crashes and transport exceptions separately')
if len(set(args.process_crash_members))!=len(args.process_crash_members):parser.error('process-crash-members must be unique')
if not jobs<=args.entries<=10000:parser.error('entries must be jobs..10000')
if not 6<=jobs<=1000 or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,47}',tag):parser.error('jobs must be 6..1000 and run-id a short lowercase identifier')
args.artifacts=args.artifacts.resolve();args.output.mkdir(parents=True,exist_ok=True)
for name in ['pi-spaces.mjs','scenarios/phase2-netbird.mjs']:
 if not (args.artifacts/name).is_file():parser.error('missing built artifact: '+name)
base='/home/mux/.local/share/pi-spaces-operations/ap2-netbird-'+tag
names=['pi-spaces-ap2-netbird-'+tag+'-'+x for x in ['root','a','b','c']]
owned={};created=[];root_launched=False;status=args.output/(tag+'-progress.json')
def ssh(cmd,input=None):return subprocess.check_output(['ssh','-oBatchMode=yes','big',cmd],input=input,text=True,stderr=subprocess.PIPE)
def remote(code):return json.loads(ssh('python3 -',code))
def progress(stage):status.write_text(json.dumps({'stage':stage,'jobs':jobs,'date':time.time()}));print(stage,flush=True)
api='''import json,pathlib,urllib.request
p=pathlib.Path('/media/docker/pi-spaces/netbird/secrets.env');e=dict(l.strip().split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#'));token=e['NB_PAT'].strip().strip(chr(34)).strip(chr(39))
def call(method,path,data=None):
 req=urllib.request.Request('https://spacebird.eibrain.org/api'+path,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Token '+token,'Content-Type':'application/json'},method=method)
 with urllib.request.urlopen(req,timeout=10) as r:return json.load(r) if r.status!=204 else None
'''
try:
 progress('build-ready')
 ssh('test ! -e '+shlex.quote(base))
 ssh('mkdir -p '+shlex.quote(base)+'/scenarios '+shlex.quote(base)+'/shared '+shlex.quote(base)+'/secrets '+' '.join(shlex.quote(base+'/'+x) for x in ['root','a','b','c']))
 for local,dest in [(str(args.artifacts/'pi-spaces.mjs'),'pi-spaces.mjs'),(str(args.artifacts/'scenarios/phase2-netbird.mjs'),'scenarios/phase2-netbird.mjs')]:subprocess.run(['scp',local,'big:'+base+'/'+dest],check=True,stdout=subprocess.DEVNULL)
 result=remote(api+'''
peers={p['name']:p for p in call('GET','/peers') if p.get('name') in ['host-a','host-b','member-1','member-2']}
assert len(peers)==4 and all(p['connected'] for p in peers.values())
assert not any(g['name']=='space-ap2-test' for g in call('GET','/groups'))
g=call('POST','/groups',{'name':'space-ap2-test','peers':[p['id'] for p in peers.values()]})
print(json.dumps({'groupId':g['id'],'peers':{n:{k:p[k] for k in ['id','ip']} for n,p in peers.items()}}))
''');owned['groupId']=result['groupId'];peers=result['peers']
 pol=remote(api+"\np=call('POST','/policies',"+repr({'name':'pi-spaces-ap2-isolated','description':'temporary signed wire fixture on tcp7423','enabled':True,'rules':[{'name':'ap2-wire','enabled':True,'action':'accept','bidirectional':False,'protocol':'tcp','ports':['7423'],'sources':[owned['groupId']],'destinations':[owned['groupId']]}]})+");print(json.dumps({'policyId':p['id']}))\n");owned.update(pol)
 config={'authorityId':'ap2-wire-'+str(uuid.uuid4()),'root':{'peerId':peers['host-a']['id'],'ip':peers['host-a']['ip']},'managementUrl':'https://spacebird.eibrain.org','jobs':jobs,'entries':args.entries,'ackCrashes':args.ack_crashes,'processCrashes':args.process_crashes,'processCrashEffects':['SieveTask','SieveResult','take','txn-begin','txn-commit'] if args.process_crash_effect=='all' else [args.process_crash_effect],'processCrashEffect':args.process_crash_effect,'processCrashBoundary':args.process_crash_boundary,'processCrashMembers':args.process_crash_members,'rpcFaults':args.rpc_faults,'rpcFaultBoundary':args.rpc_fault_boundary,'members':[{'id':key,'hostId':'ap2-wire-'+key,'peerId':peers[name]['id'],'ip':peers[name]['ip'],'namespace':'pi-spaces-test-nb-'+name+'-1'} for key,name in [('a','host-b'),('b','member-1'),('c','member-2')]]}
 remote('import pathlib,json\nb=pathlib.Path('+repr(base)+")\n(b/'shared/config.json').write_text("+repr(json.dumps(config))+''');(b/'shared/config.json').chmod(0o600)
e=dict(l.strip().split('=',1) for l in pathlib.Path('/media/docker/pi-spaces/netbird/gate.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
p=b/'secrets/management-token';p.write_text(e['NB_GATE_TOKEN'].strip().strip(chr(34)).strip(chr(39)));p.chmod(0o600)
print('{}')
''')
 def cmd(name,namespace,data,mode,detach=False):
  args=['docker','run','--rm','--user','0:0','--name',name,'--network','container:'+namespace,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','1g','--tmpfs','/tmp:rw,nosuid,nodev,size=64m']
  if mode=='run' and (config['processCrashes'] or config['ackCrashes']):args+=['--init']
  if detach:args.remove('--rm');args+=['--detach']
  if mode=='run':args+=['--cidfile',base+'/root/run.cid']
  for src,target in [('pi-spaces.mjs','/opt/app/pi-spaces.mjs:ro'),('scenarios','/opt/app/scenarios:ro'),('shared','/shared:rw'),('secrets','/secrets:ro'),(data,'/data:rw')]:args+=['-v',base+'/'+src+':'+target]
  args+=['pi-spaces-test-node:local','node','/opt/app/scenarios/phase2-netbird.mjs',mode,'/shared/config.json']
  if mode=='member':args+=[data]
  return shlex.join(args)
 progress('provisioning')
 ssh(cmd(names[0],'pi-spaces-test-nb-host-a-1','root','prepare'))
 for i,m in enumerate(config['members']):
  cid=ssh(cmd(names[i+1],m['namespace'],m['id'],'member',True)).strip();assert re.fullmatch('[a-f0-9]{64}',cid);created.append(cid)
 for _ in range(120):
  found=remote('import pathlib,json\nb=pathlib.Path('+repr(base)+"+'/shared');print(json.dumps({'ready':all((b/(x+'.json')).exists() for x in ['a','b','c'])}))")
  if found['ready']:break
  states=ssh(shlex.join(['docker','inspect','--format','{{.State.Status}}']+created)).splitlines()
  if any(state!='running' for state in states):raise RuntimeError('Member exited during fixture startup; see captured Member logs')
  time.sleep(1)
 else:
  raise RuntimeError('Member startup timed out')
 progress('running');root_launched=True
 if args.process_crashes or args.ack_crashes:
  cid=ssh(cmd(names[0],'pi-spaces-test-nb-host-a-1','root','run',True)).strip();assert re.fullmatch('[a-f0-9]{64}',cid);created.append(cid)
  expected=6 if args.ack_crashes else len(config['processCrashEffects'])*len(args.process_crash_members)*(2 if args.process_crash_boundary=='both' else 1);restarts=[];deadline=time.monotonic()+1800
  while True:
   result=subprocess.run(['ssh','-oBatchMode=yes','big','docker wait '+shlex.quote(cid)],capture_output=True,text=True,timeout=max(1,deadline-time.monotonic()))
   if result.returncode:raise RuntimeError('Cannot observe owned Root container exit')
   state=json.loads(ssh('docker inspect --format '+shlex.quote('{{json .State}}')+' '+shlex.quote(cid)))
   code=int(result.stdout.strip());assert code==state['ExitCode'];assert not state['OOMKilled'],'OOM is not a selected crash'
   (args.output/(tag+'.log')).write_text(ssh('docker logs '+shlex.quote(cid)+' 2>&1'))
   if code==0:break
   if code!=137 or len(restarts)>=expected:raise RuntimeError('Unexpected Root exit; see '+str(args.output/(tag+'.log')))
   saved=remote('import pathlib,json\np=pathlib.Path('+repr(base+"/root/run-progress.json")+");s=json.loads(p.read_text());print(json.dumps({'crashes':s['crashes'],'done':len(s['done'])}))")
   assert len(saved['crashes'])==len(restarts)+1,'SIGKILL must match exactly one newly persisted boundary'
   restarts.append({'number':len(restarts)+1,'exitCode':code,'oomKilled':False,'completedJobs':saved['done'],'crash':saved['crashes'][-1],'finishedAt':state['FinishedAt']})
   (args.output/(tag+'-restarts.json')).write_text(json.dumps(restarts,indent=2)+'\n');progress('restarting-root-'+str(len(restarts)))
   ssh('docker start '+shlex.quote(cid))
  assert len(restarts)==expected,'all configured real process crashes must be observed'
 else:
  with (args.output/(tag+'.log')).open('w') as log:
   proc=subprocess.run(['ssh','-oBatchMode=yes','big',cmd(names[0],'pi-spaces-test-nb-host-a-1','root','run')],stdout=log,stderr=subprocess.STDOUT,timeout=1800)
  if proc.returncode:raise RuntimeError('Wire run failed; see '+str(args.output/(tag+'.log')))
 subprocess.run(['scp','big:'+base+'/shared/netbird-sieve.json',str(args.output/(tag+'.json'))],check=True,stdout=subprocess.DEVNULL)
 progress('passed')
finally:
 cleanup_failed=[]
 if root_launched:
  try:
   cid=ssh('cat '+shlex.quote(base+'/root/run.cid')).strip()
   if re.fullmatch('[a-f0-9]{64}',cid) and cid not in created:created.append(cid)
  except Exception:pass
 for cid in created:
  try:
   try:(args.output/(tag+'-'+cid[:12]+'.log')).write_text(ssh('docker logs '+shlex.quote(cid)+' 2>&1'))
   except Exception:pass
   ssh('docker stop --time 5 '+shlex.quote(cid))
   ssh('docker rm '+shlex.quote(cid))
  except Exception:
   try:ssh('docker inspect '+shlex.quote(cid));cleanup_failed.append('container '+cid)
   except Exception:pass
 for kind,key in [('policies','policyId'),('groups','groupId')]:
  if key in owned:
   try:remote(api+"\ncall('DELETE','/"+kind+'/'+owned[key]+"');print('{}')")
   except Exception as ex:cleanup_failed.append(kind);print('Cleanup needs review: '+kind,flush=True)
 progress('cleanup-needs-review' if cleanup_failed else 'cleanup-finished')
 if cleanup_failed:raise RuntimeError('temporary NetBird objects remain: '+', '.join(cleanup_failed))
