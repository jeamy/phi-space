#!/usr/bin/env python3
"""Owned two-host NetBird component run for the existing big installation.

Only compiled artifacts are shipped. The driver creates and removes its own
exact peer/port firewall rules and NetBird policy/group. It never stops a VPN.
"""
import argparse,signal
import subprocess,json,os,selectors,time,pathlib,secrets,shlex,tempfile,shutil,hashlib,datetime
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--artifacts',required=True)
parser.add_argument('--output',required=True)
parser.add_argument('--local-ip',default='100.89.218.189')
parser.add_argument('--remote-ip',default='100.89.53.156')
args=parser.parse_args()
A=pathlib.Path(args.artifacts).resolve();O=pathlib.Path(args.output).resolve()
if O.exists():raise RuntimeError('refuse an existing output directory; use a fresh run')
if not all((A/s).is_file() for s in ['pi-spaces.mjs','scenarios/phase3-overlay-node.mjs','MANIFEST.json']):raise RuntimeError('compiled artifacts and manifest required')
O.mkdir(mode=0o700,parents=True)
signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(KeyboardInterrupt()))
T='ap3-overlay-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d')+'-'+secrets.token_hex(4);B='/home/mux/.local/share/pi-spaces-operations/'+T;token=secrets.token_hex(32)
procs=[];localhome=tempfile.mkdtemp(prefix='pi-overlay-local-');bigip=args.remote_ip;localip=args.local_ip;started=time.monotonic();before=None;owned={}

def ssh(args):
 p=subprocess.run(['ssh','-oControlMaster=auto','-oControlPath=/tmp/pi-overlay-ssh-%r@%h-%p','-oControlPersist=120','-oBatchMode=yes','-oConnectTimeout=10','big',shlex.join(args)],capture_output=True,text=True,timeout=45)
 if p.returncode:raise RuntimeError(p.stderr[-500:])
 return p.stdout

def rootssh(args):
 p=subprocess.run(['ssh','-oControlMaster=auto','-oControlPath=/tmp/pi-overlay-root-%r@%h-%p','-oControlPersist=120','-oBatchMode=yes','-oConnectTimeout=10','bigi',shlex.join(args)],capture_output=True,text=True,timeout=45)
 if p.returncode:raise RuntimeError('owned firewall rule operation failed: '+p.stderr[-300:])
 return p.stdout

def api(method,path,data=None):
 code="""import pathlib,json,urllib.request
p=pathlib.Path('/media/docker/pi-spaces/netbird/secrets.env');e=dict(l.strip().split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#'));token=e['NB_PAT'].strip().strip(chr(34)).strip(chr(39))
"""+'method='+repr(method)+';path='+repr(path)+';data='+repr(data)+"\nreq=urllib.request.Request('https://spacebird.eibrain.org/api'+path,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Token '+token,'Content-Type':'application/json'},method=method)\nwith urllib.request.urlopen(req,timeout=20) as r:\n raw=r.read().decode();print(raw if raw else '{}')\n"
 result=subprocess.run(['ssh','-oControlMaster=auto','-oControlPath=/tmp/pi-overlay-ssh-%r@%h-%p','-oControlPersist=120','-oBatchMode=yes','big','python3','-'],input=code,text=True,capture_output=True,timeout=40)
 if result.returncode:raise RuntimeError('temporary NetBird fixture API failed: '+result.stderr[-350:])
 return json.loads(result.stdout)

def inventory():
 ids=ssh(['docker','ps','-aq']).split()
 if not ids:return []
 return sorted([{'id':x['Id'],'status':x['State']['Status'],'started':x['State']['StartedAt'],'restarts':x['RestartCount']} for x in json.loads(ssh(['docker','inspect',*ids]))],key=lambda x:x['id'])

def receive(p,timeout=25):
 s=selectors.DefaultSelector();s.register(p.stdout,selectors.EVENT_READ)
 try:
  if not s.select(timeout):raise RuntimeError('fixture response timeout')
  line=p.stdout.readline()
  if not line:raise RuntimeError('fixture exited '+str(p.poll()))
  return json.loads(line)
 finally:s.close()
seq=0

def call(p,op,allow=False,**kw):
 global seq
 seq+=1;p.stdin.write(json.dumps({'id':seq,'op':op,**kw})+'\n');p.stdin.flush();v=receive(p,60)
 if v.get('id')!=seq:raise RuntimeError('fixture correlation mismatch')
 if not v.get('ok') and not allow:raise RuntimeError(v.get('error'))
 return v.get('result') if v.get('ok') else v

def mutate(p,rid,kind='put',key='shared',n=0,expires=None):
 m={'kind':kind,'type':'State','fields':{'key':key,'n':n},'owner':{'peerId':'isolated-subject'}}
 if kind=='put':m['expiresAt']=expires
 return call(p,'mutate',requestId=rid,mutation=m)
try:
 before=inventory()
 local_rule=['ts-input','-i','wt0','-s',bigip,'-d',localip,'-p','tcp','--sport','17431','-m','conntrack','--ctstate','ESTABLISHED','-m','comment','--comment',T,'-j','RETURN']
 subprocess.run(['sudo','-n','iptables','-I',local_rule[0],'1',*local_rule[1:]],check=True,capture_output=True);owned['localFirewallRule']=True
 rootssh(['iptables','-I','ts-input','1','-i','wt0','-s',localip,'-d',bigip,'-p','tcp','--dport','17431','-m','comment','--comment',T,'-j','RETURN']);owned['firewallRule']=True;(O/'owned.json').write_text(json.dumps({'tag':T,'base':B,'owned':owned}))
 peers=api('GET','/peers');selected=[p['id'] for p in peers if p.get('ip') in [bigip,localip]];assert len(selected)==2,'two provisioned peers required'
 group=api('POST','/groups',{'name':T,'peers':selected});owned['groupId']=group['id'];(O/'owned.json').write_text(json.dumps({'tag':T,'base':B,'owned':owned}))
 policy=api('POST','/policies',{'name':T,'description':'owned two-host AP3 fixture only; removed after test','enabled':True,'rules':[{'name':T,'enabled':True,'action':'accept','bidirectional':True,'protocol':'tcp','ports':['17431'],'sources':[group['id']],'destinations':[group['id']]}]});owned['policyId']=policy['id'];(O/'owned.json').write_text(json.dumps({'tag':T,'base':B,'owned':owned}))
 time.sleep(3)
 ssh(['test','!','-e',B]);ssh(['mkdir','-m','700',B]);ssh(['mkdir',B+'/artifacts',B+'/store'])
 for source,dest in [('pi-spaces.mjs','pi-spaces.mjs'),('scenarios/phase3-overlay-node.mjs','phase3-overlay-node.mjs')]:subprocess.run(['scp','-oControlMaster=auto','-oControlPath=/tmp/pi-overlay-ssh-%r@%h-%p','-oControlPersist=120','-q',str(A/source),'big:'+B+'/artifacts/'+dest],check=True)
 modulelink=A/'node_modules'
 if not modulelink.exists():modulelink.symlink_to('/media/data/programming/pi-spaces/node_modules',target_is_directory=True)
 localerr=open(O/'local.stderr','w');remoteerr=open(O/'remote.stderr','w')
 local=subprocess.Popen(['node',str(A/'scenarios/phase3-overlay-node.mjs'),localhome,'a',localip,bigip,token],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=localerr,text=True,bufsize=1);procs.append(local)
 args=['docker','run','--rm','-i','--name',T,'--label','pi-spaces.owned-phase3='+T,'--network','host','--user','0','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','1g','--pids-limit','128','--tmpfs','/tmp:rw,size=64m','-e','NODE_ENV=production','-v',B+'/artifacts/pi-spaces.mjs:/opt/app/pi-spaces.mjs:ro','-v',B+'/artifacts/phase3-overlay-node.mjs:/opt/app/scenarios/phase3-overlay-node.mjs:ro','-v',B+'/store:/data','sha256:95cb86e8e1be12e8daece82ac83c038bad97117802f45210b797747c6ba7c413','node','/opt/app/scenarios/phase3-overlay-node.mjs','/data','b',bigip,localip,token]
 remote=subprocess.Popen(['ssh','-oControlMaster=auto','-oControlPath=/tmp/pi-overlay-ssh-%r@%h-%p','-oControlPersist=120','-oBatchMode=yes','big',shlex.join(args)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=remoteerr,text=True,bufsize=1);procs.append(remote)
 assert receive(local)['ready'] and receive(remote,45)['ready']
 for p in procs:call(p,'listen')
 mutate(local,'before-state',key='deleted',n=1);mutate(remote,'before-other',key='stable',n=2)
 # Establish both directions over actual WireGuard/NetBird addresses before timing a partition.
 call(local,'bootstrap',host=bigip);call(local,'exchange',host=bigip)
 print(json.dumps({'stage':'overlay-connected','tag':T,'transport':'NetBird TCP 17431','independentHosts':['local','big']}),flush=True)
 for p in procs:call(p,'partition')
 partition_start=time.monotonic();start_wall=datetime.datetime.now(datetime.timezone.utc).isoformat();samples=[]
 # Offline writes/deletes/renewal versions on both physical hosts for at least ten real minutes.
 for n in range(21):
  for i,p in enumerate(procs):
   mutate(p,f'concurrent-{n}',n=n*2+i)
   mutate(p,f'renew-{n}',key='renewed',n=n*2+i,expires=int(time.time()*1000)+120000)
  if n==0:mutate(local,'delete-during-partition',kind='delete',key='deleted');mutate(remote,'expired-winner',key='expires',n=99,expires=int(time.time()*1000)+1000)
  if n==1:mutate(local,'old-permanent',key='expires',n=0) # A later winner is explicitly expired below.
  if n==2:mutate(remote,'new-expired-winner',key='expires',n=100,expires=int(time.time()*1000)+1000)
  samples.append({'sample':n,'elapsedSeconds':time.monotonic()-partition_start,'localRevision':call(local,'describe')['revision'],'bigRevision':call(remote,'describe')['revision']})
  if n in [0,10,20]:print(json.dumps({'stage':'partition','sample':n,'elapsedSeconds':samples[-1]['elapsedSeconds']}),flush=True)
  if n<20:
   end=partition_start+(n+1)*30
   while time.monotonic()<end:time.sleep(min(1,end-time.monotonic()))
 duration=time.monotonic()-partition_start;assert duration>=600
 # Restart both Harnesses, retaining the private independent SQLite stores and import checkpoints.
 for p in procs:call(p,'reopen');call(p,'listen')
 for _ in range(3):call(local,'exchange',host=bigip)
 a=call(local,'status');b=call(remote,'status');order=lambda x:json.dumps(x,sort_keys=True)
 assert sorted(a['entries'],key=order)==sorted(b['entries'],key=order),'views did not converge'
 assert not any(e['fields']['key'] in ['deleted','expires'] for e in a['entries']),'deleted/expired winner revived'
 ar=a['stream']['revision'];br=b['stream']['revision']
 for p in procs:call(p,'maintain',requestId='after-partition')
 for _ in range(2):call(local,'exchange',host=bigip)
 assert call(local,'describe')['revision']==ar and call(remote,'describe')['revision']==br,'forwarding grew an echo'
 report={'passed':True,'date':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'real-two-host-entry-overlay-component','transport':'TCP bound to existing NetBird IPv4 on port 17431','partitionMechanism':'both owned replication listeners stopped; existing VPN and other traffic unchanged','partitionStarted':start_wall,'partitionSeconds':duration,'samples':samples,'after':{'localRevision':ar,'bigRevision':br,'visibleEntries':len(a['entries']),'localReceivedExports':a['received'],'bigReceivedExports':b['received']},'snapshotUnderLoad':False,'realNetbirdReplication':True,'fullPhase3Accepted':False,'productionServiceActivated':False,'authentication':'fixture peer-IP pin and private token; not production layer-B/grants','artifactHashes':{s:hashlib.sha256((A/s).read_bytes()).hexdigest() for s in ['pi-spaces.mjs','scenarios/phase3-overlay-node.mjs']}}
 shutil.copyfile(A/'MANIFEST.json',O/'build.json');(O/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'stage':'passed','partitionSeconds':duration}),flush=True)
finally:
 errors=[]
 for p in procs:
  try:call(p,'stop');p.wait(timeout=10)
  except Exception:
   p.terminate()
   try:p.wait(timeout=10)
   except Exception:p.kill()
 try:
  listed=ssh(['docker','ps','-aq','--filter','name=^/'+T+'$']).split()
  for cid in listed:
   # --rm may remove the container between inventory and inspect.
   try:v=json.loads(ssh(['docker','inspect',cid]))[0]
   except Exception:
    if not ssh(['docker','ps','-aq','--filter','name=^/'+T+'$']).strip():continue
    raise
   assert v['Name']=='/'+T and v['Config']['Labels'].get('pi-spaces.owned-phase3')==T;ssh(['docker','rm','-f',cid])
 except Exception as e:errors.append(str(e))
 try:
  if owned.get('firewallRule'):
   rootssh(['iptables','-D','ts-input','-i','wt0','-s',localip,'-d',bigip,'-p','tcp','--dport','17431','-m','comment','--comment',T,'-j','RETURN']);assert T not in rootssh(['iptables','-S','ts-input'])
 except Exception as e:errors.append(str(e))
 try:
  if owned.get('localFirewallRule'):subprocess.run(['sudo','-n','iptables','-D',*local_rule],check=True,capture_output=True)
 except Exception as e:errors.append(str(e))
 for kind,key in [('policies','policyId'),('groups','groupId')]:
  try:
   if key in owned:api('DELETE','/'+kind+'/'+owned[key])
  except Exception as e:errors.append(str(e))
 after=inventory();unchanged=before==after if before is not None else None
 (O/'cleanup.json').write_text(json.dumps({'ownContainerRemoved':not errors,'ownNetbirdPolicyRemoved':not errors,'ownNetbirdGroupRemoved':not errors,'ownFirewallRuleRemoved':not errors,'ownLocalFirewallRuleRemoved':not errors,'protectedInventoryUnchanged':unchanged,'localStoreRemoved':True,'remoteStoreRetainedPrivately':True,'errors':errors},indent=2)+'\n');shutil.rmtree(localhome)
 assert unchanged is not False,'protected inventories changed'
 assert not errors,errors
 print(json.dumps({'stage':'cleaned','protectedInventoryUnchanged':True}),flush=True)
