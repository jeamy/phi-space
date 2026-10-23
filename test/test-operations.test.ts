import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionFileSigner, loadFileSigner, serveRegister, SocketRecoveryRegister, SqliteRecoveryRegister, RecoveryClient, serveRecovery, generateKey, RecoveryBlocked, RecoveryController, RegisterConflict, PhiSpaces, core, Space, startConfiguredFederation, bootstrapEnroll, newEnrollToken, hashToken, listSpaces, spaceDoc, Registry, beginRestore, restoreBatch, completeRestore, snapshotHash, dataRecoveryHandler, startMemberRecoveryOnly, signControlHostChange } from "../src/index.ts";
import { forEachBackend, ctx } from "./support/persistent.ts";
import { socketTransport } from "../src/socket.ts";
import { openTestHost } from "./support/host.ts";

test("provisioned keys survive reopen and fail closed on missing, public or symlinked files", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phi-spaces-keys-"));
	try {
		for (const algorithm of ["ed25519", "ecdsa-p256"] as const) {
			const path = join(dir, algorithm), key = provisionFileSigner(path, algorithm), reopened = loadFileSigner(path);
			assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(reopened.keyId, key.keyId); assert.equal(reopened.publicKey, key.publicKey);
			assert.throws(() => provisionFileSigner(path, algorithm), /EEXIST/);
			chmodSync(path, 0o644); assert.throws(() => loadFileSigner(path), /private file/); chmodSync(path, 0o600);
			symlinkSync(path, `${path}.link`); assert.throws(() => loadFileSigner(`${path}.link`));
		}
		assert.throws(() => loadFileSigner(join(dir, "absent")), /ENOENT/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("independent register sockets separate member reads from operator CAS and persist across reopen", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phi-spaces-register-rpc-")), db = new SqliteRecoveryRegister(join(dir, "register.sqlite"));
	const readServer = await serveRegister(db, join(dir, "read.sock")), adminServer = await serveRegister(db, join(dir, "admin.sock"), { writable: true });
	const reader = new SocketRecoveryRegister(join(dir, "read.sock")), forgedWriter = new SocketRecoveryRegister(join(dir, "read.sock"), { writable: true }), writer = new SocketRecoveryRegister(join(dir, "admin.sock"), { writable: true });
	try {
		await writer.compareAndSet("boot:host", null, { state: "active" });
		assert.equal((await reader.get<any>("boot:host"))?.value.state, "active");
		await assert.rejects(forgedWriter.compareAndSet("boot:host", 1, { state: "forged" }), /read-only/);
		await assert.rejects(writer.compareAndSet("boot:host", null, {}), RegisterConflict);
	} finally { reader.close(); forgedWriter.close(); writer.close(); await readServer.close(); await adminServer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("out-of-band recovery validates pinned signatures, target and supervisor method boundary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phi-spaces-recovery-rpc-")), operator = generateKey("ed25519", "operator"), supervisor = generateKey("ed25519", "supervisor"), attacker = generateKey("ed25519", "attacker");
	let effects = 0;
	const server = await serveRecovery({ path: join(dir, "recovery.sock"), hostId: "host", operator: { algorithm: "ed25519", publicKey: operator.publicKey }, supervisor: async () => ({ algorithm: "ed25519", publicKey: supervisor.publicKey }), handle: async (c, role) => { effects++; return { method: c.method, role }; } });
	const admin = new RecoveryClient(join(dir, "recovery.sock"), { hostId: "host", signer: operator.signer }), service = new RecoveryClient(join(dir, "recovery.sock"), { hostId: "host", signer: supervisor.signer }), foreign = new RecoveryClient(join(dir, "recovery.sock"), { hostId: "host", signer: attacker.signer }), wrongTarget = new RecoveryClient(join(dir, "recovery.sock"), { hostId: "other", signer: operator.signer });
	try {
		assert.deepEqual(await admin.call("installAuthority", {}), { method: "installAuthority", role: "operator" });
		assert.deepEqual(await service.call("restoreDataSpace", {}), { method: "restoreDataSpace", role: "supervisor" });
		await assert.rejects(service.call("installAuthority", {}), RecoveryBlocked);
		await assert.rejects(foreign.call("restoreDataSpace", {}), RecoveryBlocked);
		await assert.rejects(wrongTarget.call("restoreDataSpace", {}), RecoveryBlocked);
		assert.equal(effects, 2);
	} finally { [admin, service, foreign, wrongTarget].forEach(c => c.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("out-of-band recovery answers a replayed signed call from the first reply without running the handler again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phi-spaces-recovery-replay-")), operator = generateKey("ed25519", "operator");
	let effects = 0;
	const server = await serveRecovery({ path: join(dir, "recovery.sock"), hostId: "host", operator: { algorithm: "ed25519", publicKey: operator.publicKey }, handle: async c => ({ method: c.method, effect: ++effects }) });
	const wire = socketTransport({ path: join(dir, "recovery.sock") }), sent: string[] = [];
	const admin = new RecoveryClient({ request: text => { sent.push(text); return wire.request(text); } }, { hostId: "host", signer: operator.signer });
	try {
		assert.deepEqual(await admin.call("restoreStatus", {}, "same-id"), { method: "restoreStatus", effect: 1 });
		assert.deepEqual(JSON.parse(await wire.request(sent[0]!)), { ok: true, result: { method: "restoreStatus", effect: 1 } }); // the captured envelope again
		assert.equal(effects, 1);
		// A retry under the same request ID is a newly signed call and runs (handlers judge idempotency themselves).
		await new Promise(r => setTimeout(r, 2));
		assert.deepEqual(await admin.call("restoreStatus", {}, "same-id"), { method: "restoreStatus", effect: 2 });
	} finally { wire.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("durable restore controller resumes after crash, requires real control tuple and releases only scoped entries", async () => {
	await forEachBackend(async home => {
		let h = await home.open(), now = 1, fence = true, ack = false;
		const local = () => new PhiSpaces(h, ctx, () => now);
		for (let i = 0; i < 12; i++) await local().write({ type: "Task", fields: { n: i, pad: "x".repeat(600) } }, null, core.FOREVER);
		const source = core.plain((await h.snapshot(Space, ctx))!); await local().setLimits({ maxCommitBytes: 4000 });
		const dir = mkdtempSync(join(tmpdir(), "phi-spaces-controller-")), external = new SqliteRecoveryRegister(join(dir, "external.sqlite")), installed = new SqliteRecoveryRegister(join(dir, "installed.sqlite"));
		const permit = { state: "active", authorityId: "authority", dataIncarnation: source.incarnation!, role: "local", primaryEpoch: 1, transitionId: "initial" };
		await external.compareAndSet("boot:target", null, { hostId: "target", state: "active", spaces: { [source.spaceId!]: permit } });
		await external.compareAndSet(`placement:${source.spaceId}`, null, { authorityId: "authority", hostId: "lost-source", incarnation: source.incarnation!, primaryEpoch: 1 });
		await installed.compareAndSet(`installed:target:${source.spaceId}`, null, permit);
		const controller = () => new RecoveryController({ host: h, ctx, hostId: "target", authorityId: "authority", external, installed, now: () => now, loadSnapshot: async () => source, verifyFence: async hostId => ({ hostId, restartLocked: fence }), acknowledgeControl: async job => ({ recoveryId: job.request.recoveryId, space: job.request.space, incarnation: ack ? job.incarnation! : "wrong", primaryEpoch: job.primaryEpoch!, authorityId: "authority" }) });
		const request = { recoveryId: "restore-1", space: source.spaceId!, snapshotRef: "snapshot.json", targetHostId: "target", expectedDataIncarnation: source.incarnation!, expectedPrimaryEpoch: 1 };
		try {
			fence = false; await assert.rejects(controller().submit(request), RecoveryBlocked); fence = true;
			await controller().submit(request); await assert.rejects(controller().submit({ ...request, snapshotRef: "other.json" }), RegisterConflict);
			await controller().advance(request.recoveryId); home.crash(h); h = await home.open();
			for (let i = 0; i < 30 && (await controller().status(request.recoveryId)).state !== "waiting"; i++) await controller().advance(request.recoveryId);
			await assert.rejects(controller().advance(request.recoveryId), /control acknowledgement/);
			assert.equal((await external.get<any>("boot:target"))!.value.spaces[source.spaceId!].state, "revoked");
			ack = true; now = 62001; assert.equal((await controller().advance(request.recoveryId)).state, "completed");
			assert.equal((await controller().advance(request.recoveryId)).state, "completed");
			assert.equal(await local().take({ type: "Task" }, 0), null);
			const release = { commandId: "release-1", recoveryId: request.recoveryId, scope: { entryIds: [source.entries[0]!.id] } };
			const operator = generateKey("ed25519", "operator"), rpc = await serveRecovery({ path: join(dir, "restore.sock"), hostId: "target", operator: { algorithm: "ed25519", publicKey: operator.publicKey }, handle: dataRecoveryHandler(controller()) }), client = new RecoveryClient(join(dir, "restore.sock"), { hostId: "target", signer: operator.signer });
			try { assert.equal((await client.call("restoreStatus", { recoveryId: request.recoveryId }) as any).state, "completed"); const first = await client.call("releaseRestored", release, "release-rpc-1"); assert.deepEqual(await client.call("releaseRestored", release, "release-rpc-1"), first); await assert.rejects(client.call("arbitraryCommit", {}), /not supported/); } finally { client.close(); await rpc.close(); }
			const result = await controller().release(release); assert.deepEqual(result, { count: 1, completed: true }); assert.deepEqual(await controller().release(release), result);
			assert.equal((await local().take({ id: source.entries[0]!.id }, 0))?.fields.n, 0); assert.equal(await local().take({ type: "Task" }, 0), null);
			const activeBoot = (await external.get<any>("boot:target"))!; await external.compareAndSet("boot:target", activeBoot.version, { ...activeBoot.value, state: "fenced" });
			await assert.rejects(controller().release({ commandId: "release-after-fence", recoveryId: request.recoveryId, scope: { type: "Task" } }), /boot authorization/);
		} finally { external.close(); installed.close(); rmSync(dir, { recursive: true, force: true }); }
	});
});


test("configured runtime checks independent boot, provisioned overlay ownership and native trusted context", async () => {
 await forEachBackend(async home => {
  const h = await home.open(), dir = mkdtempSync(join(tmpdir(), "phi-spaces-configured-"));
  const external = new SqliteRecoveryRegister(join(dir, "external.sqlite")), installedFile = join(dir, "installed.sqlite"), installed = new SqliteRecoveryRegister(installedFile);
  let groups = ["space-hosts"], peerId = "configured-peer", runtime: Awaited<ReturnType<typeof startConfiguredFederation>> | undefined;
  const api = createServer((req, res) => { if (req.headers.authorization !== "Token fixture-token") { res.writeHead(401); res.end(); return; } res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify([{ id: peerId, ip: "127.0.0.1", connected: true, groups: groups.map(name => ({ name })) }])); });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const readSocket = join(dir, "read.sock"), readServer = await serveRegister(external, readSocket);
  try {
   await bootstrapEnroll(h, ctx, { tokenHash: hashToken(newEnrollToken()), allowedPeerId: "admin" }); await h.commit(tx => spaceDoc(tx, undefined, Date.now()), ctx);
   const keyFile = join(dir, "signer.json"), signer = provisionFileSigner(keyFile), tokenFile = join(dir, "management-token"), configFile = join(dir, "federation.json");
   writeFileSync(tokenFile, "fixture-token", { mode: 0o600 });
   const config = { hostId: "configured-host", peerId: "configured-peer", authorityId: "authority", controlHostId: "configured-host", controlSpaceId: (await h.snapshot(Registry, ctx))!.aliases.control, mode: "control", listen: { host: "127.0.0.1", port: 0 }, keyFile, registerReadSocket: readSocket, installedRegisterFile: installedFile, management: { url: `http://127.0.0.1:${(api.address() as any).port}`, tokenFile }, control: { address: { host: "127.0.0.1", port: 1 }, algorithm: signer.algorithm, publicKey: signer.publicKey } };
   writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
   await assert.rejects(startConfiguredFederation(h, ctx, configFile), /not authorized for normal boot/);
   const spaces: Record<string, any> = {};
   for (const info of await listSpaces(h, ctx)) { const permit = { state: "active", authorityId: "authority", dataIncarnation: info.incarnation, role: "local", transitionId: "initial" }; spaces[info.spaceId] = permit; await installed.compareAndSet(`installed:configured-host:${info.spaceId}`, null, permit); }
   await external.compareAndSet(`authority:${config.controlSpaceId}`, null, { authorityId: "authority", hostId: "configured-host", supervisorKey: signer.publicKey, state: "active", lineage: {} });
   await external.compareAndSet("boot:configured-host", null, { hostId: "configured-host", state: "active", spaces });
   peerId = "another-peer"; await assert.rejects(startConfiguredFederation(h, ctx, configFile), /does not belong/); peerId = "configured-peer";
   runtime = await startConfiguredFederation(h, ctx, configFile); assert.equal((await runtime.trustedConnection()).peerId, "configured-peer"); groups = ["space-observer"]; assert.deepEqual((await runtime.trustedConnection()).credentials.roles, ["observer"]);
   const nativeContext = { peerId: "forged", credentials: { roles: ["admin"] } }; const challenge = await runtime.service.handle({ method: "challenge", args: { protocol: 1 } }, nativeContext); assert.equal(challenge.ok && (challenge.result as any).observedPeerId, "configured-peer"); assert.deepEqual(nativeContext.credentials.roles, ["observer"]);
   // A running host follows a control promotion: the recorded, admin-signed change is installed and reported.
   await runtime.close(); groups = ["space-hosts"];
   const admin = provisionFileSigner(join(dir, "admin.json")), next = provisionFileSigner(join(dir, "next.json"));
   writeFileSync(configFile, JSON.stringify({ ...config, recoveryAdmin: { algorithm: admin.algorithm, publicKey: admin.publicKey } }), { mode: 0o600 });
   const unused = async () => { throw new Error("no sync Spaces"); };
   runtime = await startConfiguredFederation(h, ctx, configFile, { openSyncStorage: unused, openSyncHarness: unused, followIntervalMs: 50 });
   const signed = await signControlHostChange({ recoveryId: "promote-next", authorityId: "authority", controlSpaceId: config.controlSpaceId, fromHostId: "configured-host", targetHostId: "next-host", primaryEpoch: 2, supervisorKey: next.publicKey, algorithm: next.algorithm, address: { host: "127.0.0.9", port: 7421 } }, admin);
   const auth = (await external.get<any>(`authority:${config.controlSpaceId}`))!;
   await external.compareAndSet(`authority:${config.controlSpaceId}`, auth.version, { ...auth.value, hostId: "next-host", supervisorKey: next.publicKey, hostChange: "promote-next", hostChanges: { "promote-next": signed } });
   const changed = await Promise.race([runtime.controlChanged, new Promise<null>(r => setTimeout(() => r(null), 5000))]);
   assert.equal(changed?.targetHostId, "next-host", "the running host reports the change");
   assert.equal((await installed.get<any>(`installed-authority:${config.controlSpaceId}`))!.value.address.host, "127.0.0.9", "and installed the new endpoint");
   // lww/set: a provisioned entry replication must name a known Space of this host.
   await runtime.close(); runtime = undefined; await installed.compareAndSet(`installed-authority:${config.controlSpaceId}`, (await installed.get(`installed-authority:${config.controlSpaceId}`))!.version, { authorityId: "authority" });
   const auth2 = (await external.get<any>(`authority:${config.controlSpaceId}`))!; await external.compareAndSet(`authority:${config.controlSpaceId}`, auth2.version, { authorityId: "authority", hostId: "configured-host", supervisorKey: signer.publicKey, state: "active", lineage: {} });
   const er = { spaceId: "logical-sensors", replicaId: "r1", incarnation: "i1", members: [{ replicaId: "r1", incarnation: "i1" }], rules: [{ type: "Sensor", variant: "lww", keyFields: ["sensorId"] }] };
   writeFileSync(configFile, JSON.stringify({ ...config, entryReplication: { ...er, space: "nope" } }), { mode: 0o600 });
   await assert.rejects(startConfiguredFederation(h, ctx, configFile), /unknown Space nope/);
   writeFileSync(configFile, JSON.stringify({ ...config, entryReplication: { ...er, space: "default" } }), { mode: 0o600 });
   runtime = await startConfiguredFederation(h, ctx, configFile);
  } finally { await runtime?.close(); await readServer.close(); await new Promise<void>(resolve => api.close(() => resolve())); installed.close(); external.close(); rmSync(dir, { recursive: true, force: true }); }
 });
});


test("control snapshot cannot revive bootstrap, policy or peer rights and resets the primary epoch namespace", () => {
 const source = core.initialState(); source.spaceId = "control-id"; source.incarnation = "old-incarnation"; source.primaryEpoch = 17;
 for (const entry of [{ type: "Bootstrap", fields: { state: "open" } }, { type: "PeerKey", fields: { state: "active", peerId: "old-admin" } }, { type: "FederationPolicy", fields: { allow: true } }, { type: "Member", fields: { state: "active" } }, { type: "Command", fields: { kind: "rotateKey" } }] as core.EntryDraft[]) core.write(source, 1, entry, null, core.FOREVER);
 const target = core.plain(source); core.beginCommit(target);
 const restore = beginRestore(target, 1, { recoveryId: "control-restore", expectedDataIncarnation: "old-incarnation", expectedPrimaryEpoch: 17, snapshotHash: snapshotHash(source), kind: "control" });
 assert.equal(restore.primaryEpoch, 1);
 for (let i = 0; target.restore!.stage !== "waiting" && i < 10; i++) { core.beginCommit(target); restoreBatch(target, 1, source); }
 assert.equal(target.restore!.stage, "waiting"); completeRestore(target, 62001, "control-restore");
 assert.equal(core.list(target, 62001, { type: "Bootstrap" })[0]!.fields.state, "closed");
 assert.equal(core.list(target, 62001, { type: "PeerKey" })[0]!.fields.state, "revoked");
 assert.equal(core.list(target, 62001, { type: "Member" })[0]!.fields.state, "recoveryBlocked");
 assert.equal(core.list(target, 62001, { type: "FederationPolicy" }).length, 0); assert.equal(core.list(target, 62001, { type: "Command" }).length, 0);
});


test("member recovery starts with a public OP pin and never exposes control-authority methods", async () => {
 await forEachBackend(async home => {
  const h=await home.open(),dir=mkdtempSync(join(tmpdir(),"pi-member-only-")),operator=generateKey("ed25519","operator"),foreign=generateKey("ed25519","foreign"),config=join(dir,"member.json"),path=join(dir,"member.sock");
  writeFileSync(config,JSON.stringify({hostId:"member",path,installedRegisterFile:join(dir,"installed.sqlite"),operator:{algorithm:"ed25519",publicKey:operator.publicKey},registerTls:{host:"127.0.0.1",port:1,caFile:"unused",certFile:"unused",keyFile:"unused"}}),{mode:0o600});
  let stopped=false;const status=async()=>({hostId:"member",normalStopped:stopped,restartLocked:true});
  await assert.rejects(startMemberRecoveryOnly(h,ctx,config,status),/stopped and restart-locked/);stopped=true;
  const service=await startMemberRecoveryOnly(h,ctx,config,status),admin=new RecoveryClient(path,{hostId:"member",signer:operator.signer}),attacker=new RecoveryClient(path,{hostId:"member",signer:foreign.signer});
  try{
   await assert.rejects(admin.call("restoreControlSpace",{}),/only signed authority installation/);
   await assert.rejects(admin.call("arbitraryCommit",{}),/only signed authority installation/);
   await assert.rejects(attacker.call("installAuthority",{proof:null}),/signature or method/);
  }finally{admin.close();attacker.close();await service.close();rmSync(dir,{recursive:true,force:true});}
 });
});

test("two lww/set Members replicate their entry streams over proven, pinned host connections", async () => {
 const dir = mkdtempSync(join(tmpdir(), "phi-spaces-merge-")), external = new SqliteRecoveryRegister(join(dir, "external.sqlite"));
 const peers = [{ id: "peer-a", ip: "127.0.0.1" }, { id: "peer-b", ip: "127.0.0.2" }, { id: "peer-c", ip: "127.0.0.3" }];
 const api = createServer((req, res) => { if (req.headers.authorization !== "Token fixture-token") { res.writeHead(401); res.end(); return; } res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(peers.map(p => ({ ...p, connected: true, groups: [{ name: "space-hosts" }] })))); });
 await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
 const readSocket = join(dir, "read.sock"), readServer = await serveRegister(external, readSocket), tokenFile = join(dir, "management-token");writeFileSync(tokenFile, "fixture-token", { mode: 0o600 });
 const runtimes: Array<Awaited<ReturnType<typeof startConfiguredFederation>>> = [], hosts: any[] = [];
 try {
  const ports = [17651, 17652], names = ["a", "b"], signers = names.map(n => provisionFileSigner(join(dir, `signer-${n}.json`)));
  for (const [i, n] of names.entries()) {
   const h = await openTestHost(ctx);hosts.push(h);
   await bootstrapEnroll(h, ctx, { tokenHash: hashToken(newEnrollToken()), allowedPeerId: "admin" }); await h.commit(tx => spaceDoc(tx, undefined, Date.now()), ctx);
   const controlSpaceId = (await h.snapshot(Registry, ctx))!.aliases.control!, installedFile = join(dir, `installed-${n}.sqlite`), installed = new SqliteRecoveryRegister(installedFile), spaces: Record<string, any> = {};
   for (const info of await listSpaces(h, ctx)) { const permit = { state: "active", authorityId: "authority", dataIncarnation: info.incarnation, role: "local", transitionId: "initial" }; spaces[info.spaceId] = permit; await installed.compareAndSet(`installed:host-${n}:${info.spaceId}`, null, permit); }
   installed.close();
   await external.compareAndSet(`authority:${controlSpaceId}`, null, { authorityId: "authority", hostId: `host-${n}`, supervisorKey: signers[i]!.publicKey, state: "active", lineage: {} });
   await external.compareAndSet(`boot:host-${n}`, null, { hostId: `host-${n}`, state: "active", spaces });
   // The other Member's host key is known to this host's key directory (its own control Space in this fixture).
   const o = 1 - i, other = signers[o]!, outsider = i === 0 ? provisionFileSigner(join(dir, "signer-c.json")) : loadFileSigner(join(dir, "signer-c.json"));
   await new PhiSpaces(h, ctx, undefined, undefined, undefined, { space: "control" }).write({ type: "PeerKey", fields: { peerId: "peer-c", keyId: outsider.keyId, principal: "enrolled:peer-c", algorithm: outsider.algorithm, publicKey: outsider.publicKey, roles: ["host"], scope: ["*"], state: "active" } }, null, core.FOREVER);
   await new PhiSpaces(h, ctx, undefined, undefined, undefined, { space: "control" }).write({ type: "PeerKey", fields: { peerId: peers[o]!.id, keyId: other.keyId, principal: `enrolled:${peers[o]!.id}`, algorithm: other.algorithm, publicKey: other.publicKey, roles: ["host"], scope: ["*"], state: "active" } }, null, core.FOREVER);
   const configFile = join(dir, `federation-${n}.json`);
   writeFileSync(configFile, JSON.stringify({ hostId: `host-${n}`, peerId: peers[i]!.id, authorityId: "authority", controlHostId: `host-${n}`, controlSpaceId, mode: "control", listen: { host: peers[i]!.ip, port: ports[i] }, keyFile: join(dir, `signer-${n}.json`), registerReadSocket: readSocket, installedRegisterFile: installedFile, management: { url: `http://127.0.0.1:${(api.address() as any).port}`, tokenFile }, control: { address: { host: peers[i]!.ip, port: ports[i] }, algorithm: signers[i]!.algorithm, publicKey: signers[i]!.publicKey },
    entryReplication: { space: "default", spaceId: "logical-sensors", replicaId: `r-${n}`, incarnation: `i-${n}`, members: [{ replicaId: "r-a", incarnation: "i-a" }, { replicaId: "r-b", incarnation: "i-b" }], rules: [{ type: "Sensor", variant: "lww", keyFields: ["sensorId"] }], pollMs: 100, compactEveryMs: 1000,
     peers: [{ replicaId: `r-${names[o]}`, hostId: `host-${names[o]}`, peerId: peers[o]!.id, address: { host: peers[o]!.ip, port: ports[o] } }] } }), { mode: 0o600 });
   runtimes.push(await startConfiguredFederation(h, ctx, configFile));
  }
  const [a, b] = runtimes.map(r => r.entryReplication!);
  const until = async (f: () => Promise<boolean>) => { for (let n = 0; n < 150; n++) { if (await f()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
  const value = async (c: typeof a, id: string) => (await c!.read()).find(v => v.fields.sensorId === id)?.fields.v;
  await a!.mutate("put-a-1", { kind: "put", type: "Sensor", fields: { sensorId: "s1", v: 1 }, owner: { peerId: "peer-a" }, expiresAt: null });
  assert.ok(await until(async () => await value(b, "s1") === 1), "b pulled a's put");
  await b!.mutate("put-b-1", { kind: "put", type: "Sensor", fields: { sensorId: "s1", v: 2 }, owner: { peerId: "peer-b" }, expiresAt: null });
  assert.ok(await until(async () => await value(a, "s1") === 2), "a pulled b's newer put");
  assert.equal(await value(b, "s1"), 2, "both converge to the same winner");
  // Step 4: b's put and delete of s3 become stable on both and leave a's history; the head position stays.
  const head = (await a!.describeStream()).revision;
  await b!.mutate("put-b-3", { kind: "put", type: "Sensor", fields: { sensorId: "s3", v: 3 }, owner: { peerId: "peer-b" }, expiresAt: null });
  await b!.mutate("del-b-3", { kind: "delete", type: "Sensor", fields: { sensorId: "s3" }, owner: { peerId: "peer-b" } });
  const s3 = async () => (await a!.changes(0, 256 * 1024)).events.filter(e => e.mutation.kind !== "erase" && e.mutation.kind !== "remove" && e.mutation.kind !== "redacted" && (e.mutation as { fields: { sensorId?: string } }).fields.sensorId === "s3").length;
  assert.ok(await until(async () => (await a!.describeStream()).revision === head + 2 && await s3() === 0), "the periodic compaction on a removed b's put and tombstone");
  assert.equal(await value(a, "s1"), 2, "the live winner stays");
  // A proven host with a known key that is not pinned as a peer of this replication gets nothing.
  const { RemoteSpace, socketTransport } = await import("../src/index.ts"), t = socketTransport({ host: "127.0.0.1", port: 17651 }, { localAddress: "127.0.0.3" });
  try { const c = new RemoteSpace(t, { signer: loadFileSigner(join(dir, "signer-c.json")), ownPeerId: "peer-c", expectedGateHostId: "host-a", attempts: 1 }); await c.authenticate(); await assert.rejects(c.entryDescribe(), /not a replica of this entry replication/); } finally { t.close(); }
 } finally { for (const r of runtimes) await r.close(); for (const h of hosts) await h.close(ctx); await readServer.close(); await new Promise<void>(resolve => api.close(() => resolve())); external.close(); rmSync(dir, { recursive: true, force: true }); }
});
