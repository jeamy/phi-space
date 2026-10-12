#!/usr/bin/env node
import { SqliteRecoveryRegister } from '../dist/recovery-register.js';
import { serveTlsRegister } from '../dist/tls-register.js';
import { privateFile } from '../dist/keys.js';
const config = JSON.parse(privateFile(process.argv[2]).toString('utf8')), register = new SqliteRecoveryRegister(config.database);
const server = await serveTlsRegister(register, config);
console.log('Independent mutual-TLS register ready'); let closing = false;
const close = async () => { if (closing) return; closing = true; try { await server.close(); } finally { register.close(); } };
process.once('SIGTERM', close); process.once('SIGINT', close);
