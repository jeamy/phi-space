import subprocess,json,urllib.request
try:
 req=urllib.request.Request('http://127.0.0.1:19991/fault',data=b'{"blocked":[]}',headers={'Content-Type':'application/json'},method='POST');urllib.request.urlopen(req,timeout=4).close()
except Exception:pass
rule=['-t','nat','-p','tcp','-d','152.53.239.133/32','--dport','443','-m','comment','--comment','phi-spaces-component-fault-proxy','-j','DNAT','--to-destination','152.53.239.133:14443']
failed=False
for container in ['phi-spaces-test-nb-host-b-1','phi-spaces-test-nb-member-2-1']:
 check=['docker','exec',container,'iptables',*rule[:2],'-C','OUTPUT',*rule[2:]]
 if subprocess.run(check,capture_output=True).returncode==0:
  subprocess.run(['docker','exec',container,'iptables',*rule[:2],'-D','OUTPUT',*rule[2:]],check=True)
 subprocess.run(['docker','exec',container,'netbird','down'],capture_output=True,timeout=20)
 r=subprocess.run(['docker','exec',container,'netbird','up'],capture_output=True,timeout=70)
 print(json.dumps({'container':container,'redirectRemoved':True,'reconnected':r.returncode==0}))

 if r.returncode:failed=True
if failed:raise SystemExit(1)
