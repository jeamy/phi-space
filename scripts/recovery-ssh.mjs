#!/usr/bin/env node
// authorized_keys forced command: pinned local socket, no shell, no argv from SSH_ORIGINAL_COMMAND.
import { RegisterConflict } from '../dist/recovery-register.js';
import { SocketRecoveryRegister } from '../dist/register-service.js';
import { socketTransport } from '../dist/socket.js';
const [mode, socket] = process.argv.slice(2), expected = mode === 'read' ? 'pi-spaces-register-read' : mode === 'operator' ? 'pi-spaces-register-operator' : 'pi-spaces-recovery';
if (!['read', 'operator', 'recovery'].includes(mode) || !socket || process.env.SSH_ORIGINAL_COMMAND !== expected) throw new Error('SSH command refused');
let bytes = 0, input = '';
for await (const part of process.stdin) { bytes += part.length; if (bytes > 256 * 1024) throw new Error('request exceeds budget'); input += part.toString('utf8'); }
if (mode === 'read' || mode === 'operator') {
  const call = JSON.parse(input); if (!['get', ...(mode === 'operator' ? ['compareAndSet'] : [])].includes(call.method) || typeof call.key !== 'string' || !call.key || call.key.length > 512) throw new Error('read command refused');
  const client = new SocketRecoveryRegister(socket, { writable: mode === 'operator' }); try { process.stdout.write(JSON.stringify({ ok: true, result: call.method === 'get' ? await client.get(call.key) : await client.compareAndSet(call.key, call.expectedVersion, call.value) })); } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: { code: e instanceof RegisterConflict ? "RequestConflict" : "PermissionDenied", message: e instanceof Error ? e.message : String(e) } })); } finally { client.close(); }
} else {
  // The private service, not this bridge, verifies the pinned signature, role and target identity.
  JSON.parse(input); const client = socketTransport({ path: socket }); const timer = setTimeout(() => { client.close(); process.exitCode = 1; }, 10000);
  try { process.stdout.write(await client.request(input)); } finally { clearTimeout(timer); client.close(); }
}
