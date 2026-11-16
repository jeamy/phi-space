#!/usr/bin/env node
// Fencing service on the register host: netcup SCP calls with the local token; only operator certificates.
import { NetcupScp, NetcupFencing, fileTokenProvider, fileFenceState, serveFencing } from '../dist/netcup-fencing.js';
import { privateFile } from '../dist/keys.js';
const config = JSON.parse(privateFile(process.argv[2]).toString('utf8'));
const scp = new NetcupScp({ accessToken: fileTokenProvider(config.tokenFile) });
const server = await serveFencing(new NetcupFencing(scp, config.pins, fileFenceState(config.stateFile)), config);
console.log('netcup fencing service ready'); let closing = false;
const close = async () => { if (closing) return; closing = true; await server.close(); };
process.once('SIGTERM', close); process.once('SIGINT', close);
