// Gate 4: measure default resource boundaries, without repeating the accepted job workload.
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { core, claims, PhiSpaces, createSpace, spaceDoc, snapshotSpace, serveSpace, socketTransport, startGate, type PeerDirectory } from '../../../src/index.ts';
import { PersistentHome, ctx } from '../../support/persistent.ts';

const output = process.argv[2];
if (!output) throw new Error('usage: phase2-gate4.mjs <report-directory>');
mkdirSync(output, { recursive: true });
const limits = core.DEFAULT_LIMITS;
const started = performance.now();
const report: Record<string, unknown> = { date: new Date().toISOString(), scope: 'bounded-default-resource-acceptance', node: process.version, limits, independentNetbirdLoad: false, fullPhase2Accepted: false };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2000) {
 const end = performance.now() + ms;
 while (!check()) { if (performance.now() >= end) throw new Error('condition timed out'); await sleep(5); }
}
async function bounded<T>(p: Promise<T>, ms = 10000): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('request timed out')), ms); })]); }
 finally { clearTimeout(timer); }
}
const home = new PersistentHome();
try {
 const host = await home.open();
 const id = (await host.commit(tx => createSpace(tx, 'gate4', Date.now()), ctx)).spaceId;
 // Inventory quota matches the accepted load fixture. All other limits stay at their defaults.
 await host.commit(async tx => core.setLimits(await spaceDoc(tx, id, Date.now()), { maxEntriesPerOwner: 10000 }), ctx);
 const seedStart = performance.now();
 for (let i = 0; i < 10000; i += 20) {
  await host.commit(async tx => {
   const state = await spaceDoc(tx, id, Date.now());
   for (let n = i; n < i + 20; n++) core.write(state, Date.now(), { type: 'Inventory', fields: { n, pad: 'x'.repeat(1024) } }, null, core.FOREVER, 'gate4-owner');
  }, ctx);
 }
 let clock = Date.now();
 const client = new PhiSpaces(host, ctx, () => clock, undefined, undefined, { space: id });
 const seen = new Set<string>(), snapshotStart = performance.now();
 let page = await client.readPage({ type: 'Inventory' }, { maxBytes: limits.maxFrameBytes - 1024 });
 const firstMs = performance.now() - snapshotStart, firstToken = page.token;
 let pages = 0, maxPageBytes = 0;
 for (;;) {
  pages++; maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page)));
  for (const item of page.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
  if (!page.next) break;
  if (pages === 1) await client.write({ type: 'Concurrent', fields: { late: true } }, null, core.FOREVER);
  page = await client.readPage({ type: 'Inventory' }, { after: page.next, maxBytes: limits.maxFrameBytes - 1024 });
 }
 const traversalMs = performance.now() - snapshotStart;
 assert.equal(seen.size, 10000); assert.ok(traversalMs < limits.snapshotTtlMs);
 assert.ok(maxPageBytes + 1024 <= limits.maxFrameBytes);
 const state = (await snapshotSpace(host, id, ctx))!;
 const inventoryBytes = Buffer.byteLength(JSON.stringify(core.list(state, clock, { type: 'Inventory' })));
 // Retain identical large snapshots until the aggregate byte cap evicts the first token.
 const evictionStart = performance.now(); let created = 1;
 for (; created <= limits.maxSnapshots; created++) {
  await client.readPage({ type: 'Inventory' });
  try { await client.readPage({ type: 'Inventory' }, { token: firstToken }); }
  catch (e) { assert.ok(e instanceof core.SnapshotExpired); break; }
 }
 assert.ok(created < limits.maxSnapshots);
 const small = (await client.readPage({ type: 'Concurrent' })).token;
 for (let n = 0; n < limits.maxSnapshots; n++) await client.readPage({ type: 'Concurrent' });
 await assert.rejects(client.readPage({ type: 'Concurrent' }, { token: small }), core.SnapshotExpired);
 const liveToken = (await client.readPage({ type: 'Inventory' })).token;
 clock += limits.snapshotTtlMs;
 await assert.rejects(client.readPage({ type: 'Inventory' }, { token: liveToken }), core.SnapshotExpired);
 report.snapshot = { entries: seen.size, inventoryBytes, pages, maxPageBytes, firstPageMs: firstMs, traversalMs, ttlMs: limits.snapshotTtlMs, createdBeforeFirstEviction: created + 1, aggregateByteCapExercised: true, countCapExercised: true, evictionProbeMs: performance.now() - evictionStart, concurrentWriteExcluded: true, expiredAtTtl: true, seedMs: snapshotStart - seedStart };
 // Default-sized transactional completion: admission refuses the next entry, existing work still commits.
 const txid = (await client.createTransaction(60000)).id;
 let admitted = 0;
 for (; admitted < 10; admitted++) {
  try { await client.write({ type: 'Boundary', fields: { pad: 'z'.repeat(60000) } }, txid, core.FOREVER); }
  catch (e) { assert.ok(e instanceof core.ResourceExhausted); break; }
 }
 assert.ok(admitted > 0 && admitted < 10);
 const reservedBytes = (await snapshotSpace(host, id, ctx))!.txns[txid]!.reserved!;
 await client.commit(txid);
 const after = (await snapshotSpace(host, id, ctx))!;
 const batch = after.stream!.log.at(-1)!;
 const publishedBatchBytes = Buffer.byteLength(JSON.stringify(batch));
 assert.equal(batch.ops.length, admitted); assert.ok(publishedBatchBytes <= limits.maxCommitBytes);
 assert.equal(await client.count({ type: 'Boundary' }), admitted);
 report.commit = { admittedEntries: admitted, nextAdmissionRefused: true, reservedCompletionBytes: reservedBytes, publishedBatchBytes, completionSucceeded: true, physicalStorageDeltaBytesMeasured: false };
 // Use the real one-hour/24-hour defaults with an injected clock, not a shortened configuration.
 const s = core.initialState(), principal = { peerId: 'generation-probe' };
 const g = claims.issueGeneration(s, 1000, principal), req = { principal, generation: g.generation, requestId: 'known' };
 const a = claims.admit(s, 1001, req, 'read', {}, Infinity);
 assert.equal(a.kind, 'fresh');
 const atExpiry = claims.admit(s, g.admitUntil + 1, req, 'read', {}, Infinity);
 assert.equal(atExpiry.kind, 'pending');
 assert.throws(() => claims.admit(s, g.admitUntil + 1, { ...req, requestId: 'new' }, 'read', {}, Infinity), claims.RequestExpired);
 claims.decide(s, g.admitUntil + 2, a.key, { state: 'done', result: { n: 1 } });
 assert.equal(claims.admit(s, g.admitUntil + 3, req, 'read', {}, Infinity).kind, 'done');
 assert.throws(() => claims.admit(s, g.admitUntil + 2 + limits.claimResultMs, req, 'read', {}, Infinity), claims.RequestExpired);
 report.generation = { admitMs: g.admitUntil - 1000, resultRetentionMs: limits.claimResultMs, pendingSurvivesAdmissionEnd: true, newIdRejected: true, decidedReplayWorks: true, expiredClaimNeverReadmitted: true, clock: 'injected; no one-hour wall-clock wait' };
} finally { await home.dispose(); }
console.log(JSON.stringify({ stage: 'snapshot-commit-generation-passed' }));

// Actual TCP framing and default global connection count; echo isolates framing from RPC authorization.
const echo = await serveSpace({ handleText: async text => text }, { listen: { host: '127.0.0.1', port: 0 } });
const target = { host: '127.0.0.1', port: (echo.address() as net.AddressInfo).port };
const transport = socketTransport(target), sockets: net.Socket[] = [];
try {
 const exact = 'x'.repeat(limits.maxFrameBytes - 8);
 assert.equal(await bounded(transport.request(exact)), exact);
 await assert.rejects(transport.request(exact + 'x'), /exceeds maxFrameBytes/);
 transport.close(); await until(() => echo.connections() === 0);
 const oversized = net.createConnection(target); sockets.push(oversized); oversized.on('error', () => {});
 await bounded(new Promise<void>(r => oversized.once('connect', r)));
 const closed = new Promise<void>(r => oversized.once('close', r));
 const header = Buffer.alloc(8); header.writeUInt32BE(limits.maxFrameBytes - 7); oversized.write(header);
 await bounded(closed); await until(() => echo.connections() === 0);
 for (let n = 0; n < 64; n++) {
  const socket = net.createConnection(target); sockets.push(socket);
  socket.on('error', () => {}); await bounded(new Promise<void>(r => socket.once('connect', r)));
 }
 await until(() => echo.connections() === 64);
 const rejected = net.createConnection(target); sockets.push(rejected); rejected.on('error', () => {});
 await bounded(new Promise<void>(r => rejected.once('close', r)));
 assert.equal(echo.connections(), 64);
 report.socket = { frameBytes: limits.maxFrameBytes, headerBytes: 8, exactFrameRoundTrip: true, oversizedClientFrameRefused: true, oversizedServerFrameRefused: true, globalConnections: 64, sixtyFifthRefused: true };
} finally { transport.close(); for (const s of sockets) s.destroy(); await echo.close(); }

const directory: PeerDirectory = { async refresh() {}, async lookup(ip) { return { id: 'peer', name: 'peer', ip, groups: ['space-hosts'], connected: true }; } };
const events: Array<{ event: string; reason?: string }> = [];
const gate = await startGate({ handleText: async () => '{}' }, { listen: { host: '127.0.0.1', port: 0 }, directory, revalidateMs: 0, onEvent: e => events.push(e) });
const clients: ReturnType<typeof socketTransport>[] = [];
try {
 const address = { host: '127.0.0.1', port: (gate.address() as net.AddressInfo).port };
 for (let n = 0; n < 32; n++) {
  const t = socketTransport(address); clients.push(t); assert.equal(await bounded(t.request('{}')), '{}'); await sleep(35);
 }
 assert.equal(gate.peers().length, 32);
 const extra = socketTransport(address); clients.push(extra);
 await assert.rejects(bounded(extra.request('{}')));
 assert.ok(events.some(e => e.reason?.includes('already 32 connections')));
 report.peerConnections = { maxConnectionsPerPeer: 32, thirtyThirdRefusedByPeerCap: true, defaultsUnchanged: true };
} finally { for (const t of clients) t.close(); await gate.close(); }
const slow = await startGate({ handleText: async () => '{}' }, { listen: { host: '127.0.0.1', port: 0 }, directory: { async refresh() {}, lookup: () => new Promise(() => {}) }, revalidateMs: 0 });
const slowClient = socketTransport({ host: '127.0.0.1', port: (slow.address() as net.AddressInfo).port });
try {
 const t = performance.now(); await assert.rejects(bounded(slowClient.request('{}'), 8000));
 const elapsedMs = performance.now() - t;
 assert.ok(elapsedMs >= 4900 && elapsedMs < 7500);
 report.handshake = { configuredMs: 5000, measuredRefusalMs: elapsedMs, hungDirectoryFailsClosed: true, scope: 'peer identification after first frame; not total key-proof time' };
} finally { slowClient.close(); await slow.close(); }
report.passed = true; report.elapsedMs = performance.now() - started; report.peakRssBytes = process.resourceUsage().maxRSS * 1024;
writeFileSync(join(output, 'gate4.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ stage: 'gate4-passed', elapsedMs: report.elapsedMs, peakRssBytes: report.peakRssBytes }));
