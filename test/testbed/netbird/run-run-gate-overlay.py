#!/usr/bin/env python3
"""Case 3 of docs/betrieb-und-mobile-steuerung.md §7.4 over the real NetBird overlay.

A run controller on the operator host and a second local Member pause a run while the Member on big is offline
(its container is killed). The pause stays `pauseIncomplete`, survives a controller crash, and completes with the
same command once the Member's container is started again on the same store. A late pause after a newer resume
changes nothing. Only compiled artifacts are shipped. The driver creates and removes its own firewall rules,
NetBird group/policy and container; it never stops a VPN or any other container.

--local-smoke runs the same sequence with both nodes on loopback, without ssh, firewall or NetBird.
"""
import argparse, datetime, hashlib, json, pathlib, secrets, selectors, shlex, shutil, signal, subprocess, tempfile, time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--artifacts', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--local-ip', default='100.89.218.189')
parser.add_argument('--remote-ip', default='100.89.53.156')
parser.add_argument('--image', default='sha256:95cb86e8e1be12e8daece82ac83c038bad97117802f45210b797747c6ba7c413')
parser.add_argument('--local-smoke', action='store_true')
args = parser.parse_args()
A = pathlib.Path(args.artifacts).resolve(); O = pathlib.Path(args.output).resolve()
SCENARIO = 'scenarios/run-gate-overlay-node.mjs'; PORT = '17432'
if O.exists(): raise RuntimeError('refuse an existing output directory; use a fresh run')
if not all((A / s).is_file() for s in ['pi-spaces.mjs', SCENARIO, 'MANIFEST.json']): raise RuntimeError('compiled artifacts and manifest required')
O.mkdir(mode=0o700, parents=True)
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
SMOKE = args.local_smoke
T = 'rungate-overlay-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d') + '-' + secrets.token_hex(4)
B = '/home/mux/.local/share/phi-spaces-operations/' + T
localip, bigip = ('127.0.0.2', '127.0.0.3') if SMOKE else (args.local_ip, args.remote_ip)
localhome = tempfile.mkdtemp(prefix='pi-rungate-local-'); memberhome = tempfile.mkdtemp(prefix='pi-rungate-member-') if SMOKE else None
procs = {}; owned = {}; before = None; containers = []; steps = []; seq = 0
SSH = ['ssh', '-oControlMaster=auto', '-oControlPath=/tmp/pi-rungate-ssh-%r@%h-%p', '-oControlPersist=120', '-oBatchMode=yes', '-oConnectTimeout=10']

def ssh(argv, host='big'):
    p = subprocess.run([*SSH, host, shlex.join(argv)], capture_output=True, text=True, timeout=45)
    if p.returncode: raise RuntimeError(p.stderr[-500:])
    return p.stdout

def api(method, path, data=None):
    code = """import pathlib,json,urllib.request
p=pathlib.Path('/media/docker/phi-spaces/netbird/secrets.env');e=dict(l.strip().split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#'));token=e['NB_PAT'].strip().strip(chr(34)).strip(chr(39))
""" + 'method=' + repr(method) + ';path=' + repr(path) + ';data=' + repr(data) + "\nreq=urllib.request.Request('https://spacebird.eibrain.org/api'+path,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Token '+token,'Content-Type':'application/json'},method=method)\nwith urllib.request.urlopen(req,timeout=20) as r:\n raw=r.read().decode();print(raw if raw else '{}')\n"
    r = subprocess.run([*SSH, 'big', 'python3', '-'], input=code, text=True, capture_output=True, timeout=40)
    if r.returncode: raise RuntimeError('temporary NetBird fixture API failed: ' + r.stderr[-350:])
    return json.loads(r.stdout)

def inventory():
    ids = ssh(['docker', 'ps', '-aq']).split()
    if not ids: return []
    return sorted([{'id': x['Id'], 'status': x['State']['Status'], 'started': x['State']['StartedAt'], 'restarts': x['RestartCount']} for x in json.loads(ssh(['docker', 'inspect', *ids])) if not x['Name'].startswith('/' + T)], key=lambda x: x['id'])

def receive(p, timeout=30):
    s = selectors.DefaultSelector(); s.register(p.stdout, selectors.EVENT_READ)
    try:
        if not s.select(timeout): raise RuntimeError('fixture response timeout')
        line = p.stdout.readline()
        if not line: raise RuntimeError('fixture exited ' + str(p.poll()))
        return json.loads(line)
    finally: s.close()

def call(name, op, allow=False, **kw):
    global seq
    seq += 1; p = procs[name]; p.stdin.write(json.dumps({'id': seq, 'op': op, **kw}) + '\n'); p.stdin.flush(); v = receive(p, 90)
    if v.get('id') != seq: raise RuntimeError('fixture correlation mismatch')
    if not v.get('ok') and not allow: raise RuntimeError(f'{name} {op}: {v.get("error")}')
    return v.get('result') if v.get('ok') else v

def step(name, value):
    steps.append({'step': name, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'value': value})
    print(json.dumps({'stage': name}), flush=True)

def start_member(n):
    err = open(O / f'member-{n}.stderr', 'w')
    if SMOKE:
        argv = ['node', str(A / SCENARIO), memberhome, 'member', bigip, localip]
    else:
        name = f'{T}-{n}'; containers.append(name)
        docker = ['docker', 'run', '--rm', '-i', '--name', name, '--label', 'pi-spaces.owned-rungate=' + T, '--network', 'host', '--user', '0', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '1', '--memory', '512m', '--pids-limit', '128', '--tmpfs', '/tmp:rw,size=64m', '-e', 'NODE_ENV=production', '-v', B + '/artifacts/pi-spaces.mjs:/opt/app/pi-spaces.mjs:ro', '-v', B + '/artifacts/run-gate-overlay-node.mjs:/opt/app/scenarios/run-gate-overlay-node.mjs:ro', '-v', B + '/store:/data', args.image, 'node', '/opt/app/scenarios/run-gate-overlay-node.mjs', '/data', 'member', bigip, localip]
        argv = [*SSH, 'big', shlex.join(docker)]
    procs['member'] = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True, bufsize=1)
    ready = receive(procs['member'], 60); assert ready['ready'] and ready['role'] == 'member'
    return ready

def kill_member():
    if SMOKE: procs['member'].kill()
    else: ssh(['docker', 'kill', containers[-1]])
    procs['member'].wait(timeout=30); del procs['member']

try:
    if not SMOKE:
        before = inventory()
        local_rule = ['ts-input', '-i', 'wt0', '-s', bigip, '-d', localip, '-p', 'tcp', '--sport', PORT, '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-m', 'comment', '--comment', T, '-j', 'RETURN']
        subprocess.run(['sudo', '-n', 'iptables', '-I', local_rule[0], '1', *local_rule[1:]], check=True, capture_output=True); owned['localFirewallRule'] = True
        ssh(['iptables', '-I', 'ts-input', '1', '-i', 'wt0', '-s', localip, '-d', bigip, '-p', 'tcp', '--dport', PORT, '-m', 'comment', '--comment', T, '-j', 'RETURN'], 'bigi'); owned['firewallRule'] = True
        (O / 'owned.json').write_text(json.dumps({'tag': T, 'base': B, 'owned': owned}))
        peers = api('GET', '/peers'); selected = [p['id'] for p in peers if p.get('ip') in [bigip, localip]]; assert len(selected) == 2, 'two provisioned peers required'
        group = api('POST', '/groups', {'name': T, 'peers': selected}); owned['groupId'] = group['id']; (O / 'owned.json').write_text(json.dumps({'tag': T, 'base': B, 'owned': owned}))
        policy = api('POST', '/policies', {'name': T, 'description': 'owned run gate case-3 fixture only; removed after test', 'enabled': True, 'rules': [{'name': T, 'enabled': True, 'action': 'accept', 'bidirectional': True, 'protocol': 'tcp', 'ports': [PORT], 'sources': [group['id']], 'destinations': [group['id']]}]}); owned['policyId'] = policy['id']; (O / 'owned.json').write_text(json.dumps({'tag': T, 'base': B, 'owned': owned}))
        time.sleep(3)
        ssh(['test', '!', '-e', B]); ssh(['mkdir', '-m', '700', B]); ssh(['mkdir', B + '/artifacts', B + '/store']); owned['remoteBase'] = True
        for source, dest in [('pi-spaces.mjs', 'pi-spaces.mjs'), (SCENARIO, 'run-gate-overlay-node.mjs')]:
            subprocess.run(['scp', *SSH[1:5], '-q', str(A / source), 'big:' + B + '/artifacts/' + dest], check=True)
    modulelink = A / 'node_modules'
    if not modulelink.exists(): modulelink.symlink_to('/media/data/programming/phi-spaces/node_modules', target_is_directory=True)
    procs['controller'] = subprocess.Popen(['node', str(A / SCENARIO), localhome, 'controller', localip, bigip], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(O / 'controller.stderr', 'w'), text=True, bufsize=1)
    control = receive(procs['controller']); assert control['ready']
    m = start_member(1)
    call('member', 'serve', controllerPublicKey=control['publicKey'], controllerKeyId=control['keyId'])
    call('controller', 'connect', spaceId=m['spaceId'], publicKey=m['publicKey'], keyId=m['keyId'])
    run = 'case3-' + secrets.token_hex(3)
    started = call('controller', 'start', commandId='start-1', runId=run); assert started['state'] == 'running', started; step('started', started)

    kill_member(); step('member-killed', {'container': None if SMOKE else containers[-1]})
    t0 = time.monotonic(); incomplete = call('controller', 'pause', commandId='pause-3', runId=run); pause_ms = int((time.monotonic() - t0) * 1000)
    assert incomplete['state'] == 'pauseIncomplete', incomplete
    assert incomplete['pending']['applied'] == [control['spaceId']] and incomplete['pending']['missing'] == [m['spaceId']], incomplete
    step('pause-incomplete', {**incomplete, 'pauseCallMs': pause_ms})
    assert call('controller', 'gate', runId=run)[control['spaceId']]['state'] == 'paused'

    call('controller', 'crash'); after_crash = call('controller', 'status', runId=run)
    assert after_crash['state'] == 'pauseIncomplete' and after_crash['pending']['revision'] == 3, after_crash
    busy = call('controller', 'resume', allow=True, commandId='resume-early', runId=run); assert not busy.get('ok', True) and 'still applying pause' in busy['error'], busy
    step('controller-crash-kept-pause', {'status': after_crash, 'earlyResume': busy['error']})

    m2 = start_member(2); assert m2['spaceId'] == m['spaceId'] and m2['publicKey'] == m['publicKey'], 'same store and key after restart'
    call('member', 'serve', controllerPublicKey=control['publicKey'], controllerKeyId=control['keyId'])
    paused = call('controller', 'advance', runId=run); assert paused['state'] == 'paused' and paused['revision'] == 3, paused
    gate = call('member', 'gate', runId=run)[m['spaceId']]; assert gate['state'] == 'paused' and gate['revision'] == 3 and gate['commandId'] == 'pause-3', gate
    step('same-pause-completed', {'status': paused, 'memberGate': gate})

    resumed = call('controller', 'resume', commandId='resume-4', runId=run); assert resumed['state'] == 'running' and resumed['revision'] == 4, resumed
    late = call('controller', 'replay', runId=run, commandId='pause-3', kind='pause', revision=3)
    gate = call('member', 'gate', runId=run)[m['spaceId']]; assert gate['state'] == 'running' and gate['revision'] == 4, ('late pause changed the gate', gate)
    other = call('controller', 'replay', runId=run, commandId='pause-x', kind='pause', revision=3); assert not other['accepted'] and 'belongs to another command' in other['error'], other
    stale = call('controller', 'replay', runId=run, commandId='pause-y', kind='pause', revision=4); assert not stale['accepted'], stale
    step('late-pause-without-effect', {'replaySameCommand': late, 'otherCommand': other['error'], 'staleRevision': stale['error'], 'memberGate': gate})

    stopped = call('controller', 'stop', commandId='stop-5', runId=run); assert stopped['state'] == 'stopped' and stopped['revision'] == 5, stopped
    step('stopped', stopped)
    report = {'passed': True, 'date': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scope': 'local-loopback-smoke' if SMOKE else 'real-netbird-two-host-run-gate', 'case': '7.4 case 3', 'run': run,
              'transport': 'loopback TCP' if SMOKE else f'TCP {PORT} bound to the existing NetBird IPv4 addresses', 'offlineMechanism': 'member process killed' if SMOKE else 'member container killed (docker kill), restarted on the same store',
              'authentication': 'layer B key proof and signed run gate instructions/ACKs; layer A fixture peer-IP pin, not the Management API', 'members': {'big': m['spaceId'], 'local': control['spaceId']},
              'steps': steps, 'productionServiceActivated': False, 'artifactHashes': {s: hashlib.sha256((A / s).read_bytes()).hexdigest() for s in ['pi-spaces.mjs', SCENARIO]}}
    shutil.copyfile(A / 'MANIFEST.json', O / 'build.json'); (O / 'report.json').write_text(json.dumps(report, indent=2) + '\n'); print(json.dumps({'stage': 'passed'}), flush=True)
finally:
    errors = []
    for name, p in list(procs.items()):
        try: call(name, 'stop-node'); p.wait(timeout=15)
        except Exception:
            p.terminate()
            try: p.wait(timeout=10)
            except Exception: p.kill()
    if not SMOKE:
        try:
            for name in containers:
                for cid in ssh(['docker', 'ps', '-aq', '--filter', 'name=^/' + name + '$']).split():
                    try: v = json.loads(ssh(['docker', 'inspect', cid]))[0]
                    except Exception: continue  # --rm removed it meanwhile
                    assert v['Name'] == '/' + name and v['Config']['Labels'].get('pi-spaces.owned-rungate') == T; ssh(['docker', 'rm', '-f', cid])
        except Exception as e: errors.append(str(e))
        try:
            if owned.get('firewallRule'):
                ssh(['iptables', '-D', 'ts-input', '-i', 'wt0', '-s', localip, '-d', bigip, '-p', 'tcp', '--dport', PORT, '-m', 'comment', '--comment', T, '-j', 'RETURN'], 'bigi'); assert T not in ssh(['iptables', '-S', 'ts-input'], 'bigi')
        except Exception as e: errors.append(str(e))
        try:
            if owned.get('localFirewallRule'): subprocess.run(['sudo', '-n', 'iptables', '-D', *local_rule], check=True, capture_output=True)
        except Exception as e: errors.append(str(e))
        for kind, key in [('policies', 'policyId'), ('groups', 'groupId')]:
            try:
                if key in owned: api('DELETE', '/' + kind + '/' + owned[key])
            except Exception as e: errors.append(str(e))
        after = inventory() if before is not None else None
        unchanged = before == after if before is not None else None
        (O / 'cleanup.json').write_text(json.dumps({'ownContainersRemoved': not errors, 'ownNetbirdPolicyAndGroupRemoved': not errors, 'ownFirewallRulesRemoved': not errors, 'protectedInventoryUnchanged': unchanged, 'remoteStoreRetainedPrivately': owned.get('remoteBase', False), 'remoteBase': B if owned.get('remoteBase') else None, 'errors': errors}, indent=2) + '\n')
        assert unchanged is not False, 'protected inventories changed'
    shutil.rmtree(localhome, ignore_errors=True)
    if memberhome: shutil.rmtree(memberhome, ignore_errors=True)
    assert not errors, errors
    print(json.dumps({'stage': 'cleaned'}), flush=True)
