#!/usr/bin/env node
// Run on the independently managed operator host. Never deploy its database with a space snapshot.
import { SqliteRecoveryRegister } from '../dist/recovery-register.js';
import { serveRegister, SocketRecoveryRegister } from '../dist/register-service.js';
import { privateFile } from '../dist/keys.js';
const [method, file, ...args] = process.argv.slice(2);
if (method === 'serve' && args.length === 2) {
  const register = new SqliteRecoveryRegister(file), servers = [];
  try { servers.push(await serveRegister(register, args[0])); servers.push(await serveRegister(register, args[1], { writable: true })); }
  catch (e) { for (const s of servers) await s.close(); register.close(); throw e; }
  console.log('Recovery register ready (private reader and operator sockets)');
  let closing = false;
  const close = async () => { if (closing) return; closing = true; for (const server of servers) await server.close(); register.close(); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
} else if (method === 'get' && args.length === 1 || method === 'cas' && args.length === 3) {
  const client = new SocketRecoveryRegister(file, { writable: method === 'cas' });
  try { console.log(JSON.stringify(method === 'get' ? await client.get(args[0]) : await client.compareAndSet(args[0], args[1] === 'null' ? null : Number(args[1]), JSON.parse(privateFile(args[2]).toString('utf8'))))); }
  finally { client.close(); }
} else throw new Error('Usage: recovery-register.mjs serve DB READ_SOCKET OPERATOR_SOCKET | get SOCKET KEY | cas SOCKET KEY EXPECTED_VERSION PRIVATE_JSON_FILE');
