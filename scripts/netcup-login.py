#!/usr/bin/env python3
"""netcup SCP device-flow login for the pi-spaces fencing adapter (runs on vpsc as the register user).

login   : request a device code, print ONLY the approval URL/code, poll, store the offline refresh token (0600).
inspect : refresh the access token (storing a rotated refresh token), save the per-user OpenAPI spec and list
          servers (id, name, hostname). Never prints tokens.
"""
import json, os, sys, time, urllib.parse, urllib.request, urllib.error, pathlib

BASE = 'https://www.servercontrolpanel.de'
OIDC = BASE + '/realms/scp/protocol/openid-connect'
API = BASE + '/scp-core/api/v1'
DIR = pathlib.Path.home() / '.config' / 'pi-spaces-fencing'
FILE = DIR / 'netcup.json'

def post_form(url, data):
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), method='POST',
                                 headers={'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try: return e.code, json.loads(body)
        except ValueError: return e.code, {'error': 'http_%d' % e.code}

def load():
    return json.loads(FILE.read_text()) if FILE.exists() else {}

def store(state):
    DIR.mkdir(mode=0o700, parents=True, exist_ok=True); os.chmod(DIR, 0o700)
    tmp = DIR / '.netcup.json.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(state, f, indent=1); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, FILE)

def login():
    code, dev = post_form(OIDC + '/auth/device', {'client_id': 'scp', 'scope': 'openid offline_access'})
    if code != 200 or 'device_code' not in dev: sys.exit('device request failed: %s %s' % (code, dev.get('error')))
    print('OPEN:', dev.get('verification_uri_complete') or dev.get('verification_uri'))
    print('CODE:', dev.get('user_code'), '| expires in', dev.get('expires_in'), 's', flush=True)
    interval, deadline = int(dev.get('interval', 5)), time.time() + int(dev.get('expires_in', 600))
    while time.time() < deadline:
        time.sleep(interval)
        code, tok = post_form(OIDC + '/token', {'client_id': 'scp', 'grant_type': 'urn:ietf:params:oauth:grant-type:device_code', 'device_code': dev['device_code']})
        if code == 200 and tok.get('refresh_token'):
            def save():
                state = load(); state.update({'refreshToken': tok['refresh_token'], 'obtainedAt': int(time.time()), 'scope': tok.get('scope')}); state.setdefault('servers', {}); store(state)
            with_lock(save)
            print('STORED: offline refresh token in', FILE, '(not printed)', flush=True); return
        err = tok.get('error')
        if err == 'slow_down': interval += 5
        elif err != 'authorization_pending': sys.exit('token request failed: %s' % err)
    sys.exit('device code expired without approval')

LOCK = DIR / 'netcup.json.lock'
def with_lock(fn):
    # Same exclusive lock-file protocol as the fencing service (src/netcup-fencing.ts): rotated refresh tokens.
    for _ in range(300):
        try: os.close(os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)); break
        except FileExistsError:
            try:
                if time.time() - LOCK.stat().st_mtime > 60: LOCK.unlink()
            except FileNotFoundError: pass
            time.sleep(0.1)
    else: sys.exit('netcup token lock busy')
    try: return fn()
    finally:
        try: LOCK.unlink()
        except FileNotFoundError: pass

def access_token(): return with_lock(_access_token)
def _access_token():
    state = load()
    if not state.get('refreshToken'): sys.exit('no refresh token stored; run login first')
    code, tok = post_form(OIDC + '/token', {'client_id': 'scp', 'grant_type': 'refresh_token', 'refresh_token': state['refreshToken']})
    if code != 200: sys.exit('refresh failed: %s' % tok.get('error'))
    if tok.get('refresh_token') and tok['refresh_token'] != state['refreshToken']:
        state['refreshToken'] = tok['refresh_token']; state['rotatedAt'] = int(time.time()); store(state)
    return tok['access_token']

def get(path, token):
    req = urllib.request.Request(API + path, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read().decode())

def inspect():
    token = access_token()
    spec = get('/openapi', token); (DIR / 'scp-openapi.json').write_text(json.dumps(spec, indent=1)); os.chmod(DIR / 'scp-openapi.json', 0o600)
    print('SPEC: version', spec.get('info', {}).get('version'), '|', len(spec.get('paths', {})), 'paths ->', DIR / 'scp-openapi.json')
    servers = get('/servers', token)
    for s in servers if isinstance(servers, list) else servers.get('content', servers.get('servers', [])):
        print('SERVER:', s.get('id'), s.get('name'), s.get('hostname') or s.get('nickname'))

{'login': login, 'inspect': inspect}[sys.argv[1] if len(sys.argv) > 1 else 'login']()
