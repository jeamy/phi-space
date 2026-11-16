#!/usr/bin/env node
// Pin HOST, systemd unit and normal runtime STATE_DIR in authorized_keys. Caller cannot choose them.
import { execFileSync } from 'node:child_process';
import { openSync, writeFileSync, fsyncSync, closeSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
const [hostId, unit, state] = process.argv.slice(2), command = process.env.SSH_ORIGINAL_COMMAND;
if (!hostId || !/^[A-Za-z0-9_.@-]+\.service$/.test(unit || '') || !state?.startsWith('/') || !['phi-spaces-fence', 'phi-spaces-fence-status'].includes(command)) throw new Error('fencing command refused');
const lock = join(state, 'restart.lock');
if (command === 'phi-spaces-fence') {
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ hostId, at: Date.now() }) + '\n'); fsyncSync(fd); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { if (fd !== undefined) closeSync(fd); }
  const dir = openSync(state, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  execFileSync('systemctl', ['--user', 'stop', unit], { timeout: 15000, stdio: ['ignore', 'ignore', 'ignore'] });
}
const info = execFileSync('systemctl', ['--user', 'show', unit, '--property=ActiveState,SubState,MainPID,ControlPID,KillMode'], { timeout: 5000, encoding: 'utf8' });
const properties = Object.fromEntries(info.trim().split('\n').map(line => line.split('=')));
let restartLocked = false; try { const s = lstatSync(lock); restartLocked = s.isFile() && !s.isSymbolicLink() && !(s.mode & 0o077); } catch {}
const stopped = ['inactive', 'failed'].includes(properties.ActiveState) && properties.MainPID === '0' && properties.ControlPID === '0' && properties.KillMode === 'control-group';
process.stdout.write(JSON.stringify({ hostId, restartLocked, stopped }));
