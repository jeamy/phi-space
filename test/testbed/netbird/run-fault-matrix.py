import subprocess,time,json,pathlib,urllib.request,sys
base=pathlib.Path('/home/mux/.local/share/pi-spaces-operations');report=base/'netbird-matrix-progress.json'
cases=[('management-5m',['management'],300)]
if '--all' in sys.argv:cases += [('management-1h',['management'],3600),('signal-10m',['signal'],600),('relay-30m',['relay'],1800),('management-relay-1h',['management','relay'],3600)]
state={'started':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'state':'starting','faultScope':'two-owned-test-peers-only','globalServerStopped':False,'runs':[]}
if '--resume' in sys.argv and report.exists():
 previous=json.loads(report.read_text());done=[r for r in previous['runs'] if r.get('finished')]
 state['started']=previous['started'];state['runs']=done;state['resumed']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
 state['abortedAttempts']=previous.get('abortedAttempts',[])+[r for r in previous['runs'] if not r.get('finished')]
 cases=[c for c in cases if c[0] not in {r['name'] for r in done}]
def save():
 p=report.with_suffix('.tmp');p.write_text(json.dumps(state,indent=2)+'\n');p.chmod(0o600);p.replace(report)
def docker(container,*args):
 try:return subprocess.run(['docker','exec',container,*args],capture_output=True,text=True,timeout=25)
 except subprocess.TimeoutExpired:return subprocess.CompletedProcess(['docker','exec',container,*args],124,'','CLI timeout')

def status(container):
 r=docker(container,'netbird','status','--json')
 if r.returncode or not r.stdout.strip():return {'management':None,'signal':None,'relayAvailable':None,'peers':[],'statusUnavailable':True,'reason':'CLI timeout or unavailable'}
 d=json.loads(r.stdout)
 relays=(d.get('relays') or {}).get('details') or [];peers=(d.get('peers') or {}).get('details') or []
 return {'management':bool((d.get('management') or {}).get('connected')),'signal':bool((d.get('signal') or {}).get('connected')),'relayAvailable':any(x.get('available') for x in relays if x.get('uri','').startswith('rels:')),'peers':[{'ip':p.get('netbirdIp'),'state':p.get('status'),'type':p.get('connectionType')} for p in peers]}

def objects():
 r=docker('pi-spaces-test-host-b-1','node','/data/phase1b-restore-source/netbird-probe.mjs')
 try:return json.loads(r.stdout)
 except:return {'passed':False,'error':'ProbeProcessFailed'}
def fault(blocked):
 req=urllib.request.Request('http://127.0.0.1:19991/fault',data=json.dumps({'blocked':blocked}).encode(),headers={'Content-Type':'application/json'},method='POST');return json.load(urllib.request.urlopen(req,timeout=5))
def tunnel():
 r=docker('pi-spaces-test-host-b-1','node','--input-type=module','-e',"import net from 'node:net';const s=net.connect(7421,'100.89.116.183');s.setTimeout(3000);s.on('connect',()=>{console.log('true');s.destroy();});s.on('timeout',()=>{console.log('false');s.destroy();});s.on('error',()=>console.log('false'));")
 return r.stdout.strip()=='true'
def sample(start):return {'seconds':round(time.monotonic()-start,1),'hostB':status('pi-spaces-test-nb-host-b-1'),'member2':status('pi-spaces-test-nb-member-2-1'),'objects':objects(),'directTcpConnect':tunnel()}
try:
 state['baselineObjects']=objects();assert state['baselineObjects']['passed'],'baseline objects failed'
 for name,blocked,duration in cases:
  fault([]);deadline=time.monotonic()+120
  while not objects()['passed']:
   if time.monotonic()>deadline:raise RuntimeError('healthy baseline not recovered')
   time.sleep(5)
  run={'name':name,'requestedSeconds':duration,'blocked':blocked,'samples':[]};state['runs'].append(run);state['state']='running';state['current']=name;save()
  fault(blocked);start=time.monotonic();restarted=False
  while True:
   if name=='signal-10m' and not restarted and time.monotonic()-start>=60:
    docker('pi-spaces-test-nb-host-b-1','netbird','down')
    subprocess.Popen(['docker','exec','pi-spaces-test-nb-host-b-1','netbird','up'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    restarted=True;run['hostBReconnectRequestedAtSeconds']=round(time.monotonic()-start,1)
   run['samples'].append(sample(start));run['elapsedSeconds']=round(time.monotonic()-start,1);save()
   if time.monotonic()-start>=duration:break
   time.sleep(min(15,duration-(time.monotonic()-start)))
  fault([]);recoveryStart=time.monotonic();deadline=recoveryStart+150;recoveryRestarted=False
  while not objects()['passed']:
   if not recoveryRestarted and time.monotonic()-recoveryStart>75:
    run['explicitAgentReconnectForRecovery']=True;recoveryRestarted=True
    for container in ['pi-spaces-test-nb-host-b-1','pi-spaces-test-nb-member-2-1']:subprocess.Popen(['docker','exec',container,'netbird','up'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   if time.monotonic()>deadline:raise RuntimeError('post-fault object access not recovered')
   time.sleep(5)
  run['recoveredObjects']=True;run['finished']=True;save()
 state['state']='finished';state['finished']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());save()
except Exception as e:state['state']='failed';state['error']=str(e);save();raise
finally:
 try:fault([])
 except Exception:pass
 # Restore only the redirection installed for these two test peers.
 r=subprocess.run(['/usr/bin/python3',str(base/'fault-cleanup.py')],capture_output=True,text=True,timeout=200);state['cleanupSuccess']=r.returncode==0;save()
