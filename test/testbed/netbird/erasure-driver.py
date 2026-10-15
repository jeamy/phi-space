#!/usr/bin/env python3
"""Exclusive maintenance transport for the owned multi-host AP2 fixture.

The TypeScript coordinator owns independent floors and progress. This driver
only controls exact processes, private homes and artifacts from its manifest.
Input/output is one bounded JSON request/reply; no keys or tokens are returned.
"""
import argparse, hashlib, json, os, pathlib, shlex, signal, stat, subprocess, sys, time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    opts = parser.parse_args()
    state_path = pathlib.Path(opts.state)
    state = json.loads(state_path.read_text())
    tag, base = state['tag'], state['base']
    if not tag.startswith('ap2-remaining-') or base != '/home/mux/.local/share/pi-spaces-operations/' + tag:
        raise RuntimeError('not an owned remaining-block fixture')
    request = json.loads(sys.stdin.read(262145))
    members = ['root', *state['members']]
    # The local d Member is explicit; every other runtime is an owned big container.
    local = pathlib.Path(state['localHome']) if state.get('localHome') else None
    if local and local != pathlib.Path.home() / '.local/share/pi-spaces-ops' / tag / 'd':
        raise RuntimeError('local home disagrees with owned scope')

    def save():
        temp = state_path.with_suffix('.erasure-tmp')
        with open(temp, 'w') as file:
            os.chmod(temp, 0o600)
            file.write(json.dumps(state, indent=2) + '\n')
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, state_path)

    def ssh(args, data=None):
        reply = subprocess.run(['ssh', '-oBatchMode=yes', '-oConnectTimeout=10', 'big', shlex.join(args)], input=data, text=True, capture_output=True, timeout=240)
        if reply.returncode:
            raise RuntimeError('owned maintenance SSH failed: ' + reply.stderr[-1200:])
        return reply.stdout

    def home(member):
        if member not in members:
            raise RuntimeError('unknown owned participant')
        return str(local) if member == 'd' else base + '/' + member

    def python(member, code):
        if member == 'd':
            result = subprocess.run(['python3', '-'], input=code, text=True, capture_output=True, timeout=120)
            if result.returncode:
                raise RuntimeError('owned local maintenance failed: ' + result.stderr[-1200:])
            return json.loads(result.stdout)
        return json.loads(ssh(['python3', '-'], code))

    def node(member, tool, args, data=None):
        if member == 'd':
            reply = subprocess.run(['node', str(local / 'artifacts/tools' / tool), *args], input=data, text=True, capture_output=True, timeout=240, cwd=local)
            if reply.returncode:
                raise RuntimeError('owned local operator failed: ' + reply.stderr[-1200:])
            return json.loads(reply.stdout)
        tunnel = json.loads(pathlib.Path(state['sharedTunnelState']).read_text())['tunnel']['socketDir']
        command = ['docker', 'run', '--rm', '--interactive', '--user', '0:0', '--network', 'container:' + state['namespaces'][member], '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '-v', base + '/artifacts/pi-spaces.mjs:/opt/app/pi-spaces.mjs:ro', '-v', base + '/artifacts/tools:/opt/app/tools:ro', '-v', home(member) + ':/data:rw', '-v', tunnel + ':/register-tunnel:ro', 'pi-spaces-test-node:local', 'node', '/opt/app/tools/' + tool, *args]
        return json.loads(ssh(command, data))

    def stopped():
        containers = {**state.get('stoppedContainers', {}), **state.get('running', {})}
        expected = {cid: {'home': home(member), 'name': '/' + tag + '-' + member} for member, cid in containers.items()}
        remote_homes = [home(member) for member in members if member != 'd']
        # One current remote inventory, with every exact CID, volume and owner lock checked.
        ssh(['python3', '-'], "import json,pathlib,subprocess\nexpected=" + repr(expected) + ";homes=" + repr(remote_homes) + "\nif expected:\n values=json.loads(subprocess.check_output(['docker','inspect',*expected],text=True));assert len(values)==len(expected)\n for value in values:\n  own=expected[value['Id']];assert value['Name']==own['name'] and not value['State']['Running'] and any(m['Source']==own['home'] and m['Destination']=='/data' for m in value['Mounts'])\nfor home in homes:\n p=pathlib.Path(home);assert (p/'restart.lock').is_file() and not (p/'restart.lock').is_symlink() and not (p/'owner.lock').exists()\nprint('{}')")
        if local:
            if state.get('localProcess'):
                pid = state['localProcess']['pid']
                proc = pathlib.Path('/proc/' + str(pid) + '/cmdline')
                if proc.exists() and proc.read_bytes().rstrip(b'\0'):
                    raise RuntimeError('local Member is still running; refuse maintenance')
            if not (local / 'restart.lock').is_file() or (local / 'restart.lock').is_symlink() or (local / 'owner.lock').exists():
                raise RuntimeError('local Member lacks exclusive restart lock')

    action = request['action']
    if action == 'stop':
        for member in members:
            python(member, 'import pathlib,json,os\np=pathlib.Path(' + repr(home(member)) + ')/"restart.lock"\nif not p.exists():\n f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(f,b"exclusive principal erasure\\n");os.fsync(f);os.close(f)\nprint("{}")')
        for member, cid in list({**state.get('stoppedContainers', {}), **state.get('running', {})}.items()):
            result = json.loads(ssh(['docker', 'inspect', cid]))[0]
            if not any(m['Source'] == home(member) and m['Destination'] == '/data' for m in result['Mounts']):
                raise RuntimeError('container ownership changed')
            if result['State']['Running']:
                ssh(['docker', 'stop', '--time', '120', cid])
            result = json.loads(ssh(['docker', 'inspect', cid]))[0]
            if result['State']['Running']:
                raise RuntimeError('owned writer did not stop')
            state.setdefault('stoppedContainers', {})[member] = cid
            state['running'].pop(member, None)
            save()
            python(member, 'import pathlib,json\np=pathlib.Path(' + repr(home(member)) + ')/"owner.lock"\nif p.exists():\n o=json.loads(p.read_text());assert o["mode"]=="run";p.unlink()\nprint("{}")')
        if local and state.get('localProcess'):
            pid = state['localProcess']['pid']
            cmd = pathlib.Path('/proc/' + str(pid) + '/cmdline')
            if cmd.exists() and cmd.read_bytes().rstrip(b'\0'):
                if cmd.read_bytes().split(b'\0')[:4] != [s.encode() for s in state['localProcess']['args']]:
                    raise RuntimeError('local process ownership changed')
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 120
                while cmd.exists() and cmd.read_bytes().rstrip(b'\0'):
                    if time.monotonic() > deadline:
                        raise RuntimeError('local owned writer did not stop')
                    time.sleep(.1)
            state['localProcess']['stopped'] = True
            save()
            python('d', 'import pathlib,json\np=pathlib.Path(' + repr(str(local)) + ')/"owner.lock"\nif p.exists():\n o=json.loads(p.read_text());assert o["mode"]=="run";p.unlink()\nprint("{}")')
        stopped()
        result = {'stopped': True}
    elif action == 'assertStopped':
        stopped()
        result = {'stopped': True}
    elif action in ['offline', 'compact', 'audit']:
        member = request['member']
        stopped()
        data = request.get('data', {})
        if action == 'offline':
            if request['mode'] not in ['erase-evidence', 'erase-local', 'erase-root', 'erase-stamp']:
                raise RuntimeError('unknown exclusive erase mode')
            result = node(member, 'federation-host.mjs', [request['mode'], home(member) if member == 'd' else '/data'], json.dumps(data))
        else:
            tool = 'erase-compact.mjs' if action == 'compact' else 'audit-maintenance.mjs'
            path = home(member) if action == 'compact' else home(member) + '/harness.sqlite'
            if member != 'd':
                path = '/data' if action == 'compact' else '/data/harness.sqlite'
            result = node(member, tool, [path])
    elif action in ['backup', 'destroy', 'verifyBytes']:
        stopped()
        member = request['member']
        identifier = request['id']
        if not identifier.startswith('erase-') or len(identifier) > 63 or not all(c.isalnum() or c in '-_' for c in identifier):
            raise RuntimeError('invalid owned erasure artifact identity')
        result = python(member, '''import hashlib,pathlib,json,os,sqlite3
home=pathlib.Path(''' + repr(home(member)) + ''');folder=home/'erasure-backups';folder.mkdir(mode=0o700,exist_ok=True);artifact=folder/''' + repr(identifier + '-' + member + '.sqlite') + '''
action=''' + repr(action) + '''
if action=='backup':
 if not artifact.exists():
  temporary=artifact.with_suffix('.part')
  if temporary.exists():
   assert temporary.is_file() and not temporary.is_symlink();temporary.unlink()
  fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
  source=sqlite3.connect('file:'+str(home/'harness.sqlite')+'?mode=ro',uri=True);target=sqlite3.connect(temporary)
  try:source.backup(target);assert target.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
  finally:target.close();source.close()
  with open(temporary,'rb') as f:os.fsync(f.fileno())
  os.replace(temporary,artifact)
  fd=os.open(folder,os.O_RDONLY);os.fsync(fd);os.close(fd)
 assert artifact.is_file() and not artifact.is_symlink()
 digest=hashlib.sha256(artifact.read_bytes()).hexdigest();print(json.dumps({'id':''' + repr(identifier + '-' + member) + ''','sha256':digest,'kind':'backup'}))
elif action=='destroy':
 if artifact.exists():
  assert artifact.is_file() and not artifact.is_symlink();assert hashlib.sha256(artifact.read_bytes()).hexdigest()==''' + repr(request.get('sha256')) + ''';artifact.unlink()
 fd=os.open(folder,os.O_RDONLY);os.fsync(fd);os.close(fd);print('{}')
else:
 assert not list(folder.iterdir()),'old owned backup remains'
 for suffix in ['', '-wal', '-shm', '-journal']:
  p=home/('harness.sqlite'+suffix)
  if p.exists():assert b'privacy-probe-payload' not in p.read_bytes() and b'erase-subject' not in p.read_bytes(),'erased payload remains in active backend history'
 print(json.dumps({'backendAndArchivesClean':True,'filesChecked':[('harness.sqlite'+suffix) for suffix in ['', '-wal', '-shm', '-journal'] if (home/('harness.sqlite'+suffix)).exists()],'archiveFilesRemaining':len(list(folder.iterdir()))}))
''')
        if action == 'verifyBytes':
            receipt = {'commandId': identifier, 'member': member, **result}
            receipt_path = local.parent / (identifier + '-file-verification.jsonl')
            fd = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                    raise RuntimeError('private verification receipt is not owned')
                os.write(fd, (json.dumps(receipt) + '\n').encode())
                os.fsync(fd)
            finally:
                os.close(fd)
    else:
        raise RuntimeError('unsupported exclusive erasure action')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
