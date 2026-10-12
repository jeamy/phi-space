import {CapabilityDirectory} from "../../src/capability-directory.ts";
// Through two composed gates and independent persistent harnesses: no copied control keys/state in the data member.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFederationHost, GrantAuthority, GrantVerifier, GateIdentity, SpaceKeyDirectory, bootstrapEnroll, newEnrollToken, hashToken, generateKey, RemoteSpace, socketTransport, PiSpaces, FOREVER, CONTROL_SPACE, createSpace, rotationBytes, OutcomeUnknown, core, type Signer, type Grant, SqliteRecoveryRegister, listSpaces, spaceDoc } from "../../src/index.ts";
import { forEachBackend, PersistentHome, ctx } from "./persistent.ts";

const until = async (f: () => Promise<boolean>) => { const end = Date.now() + 5000; while (!(await f())) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 10)); } };
export async function exerciseFederationRuntime() {
	await forEachBackend(async home => {
		const other = new PersistentHome(home.backend); let h = await home.open(), data = await other.open();
		const registerDir = mkdtempSync(join(tmpdir(), "pi-spaces-runtime-register-")), external = new SqliteRecoveryRegister(join(registerDir, "external.sqlite")), installed = new SqliteRecoveryRegister(join(registerDir, "installed.sqlite"));
		const provisionBoot = async (host: typeof h, hostId: string) => { await host.commit(tx => spaceDoc(tx, undefined, now), ctx); const spaces: Record<string, any> = {}; for (const info of await listSpaces(host, ctx)) { const permit = { state: "active", authorityId: "authority", dataIncarnation: info.incarnation, role: "local", transitionId: "fixture-bootstrap" }; spaces[info.spaceId] = permit; await installed.compareAndSet(`installed:${hostId}:${info.spaceId}`, null, permit); } await external.compareAndSet(`boot:${hostId}`, null, { hostId, state: "active", spaces }); return { external, installed }; };
		let now = 1_800_000_000_000; const clock = () => now;
		const peers = new Map([ ["127.0.0.3", { id: "admin", name: "admin", ip: "127.0.0.3", connected: true, groups: ["space-enroll"] }], ["127.0.0.4", { id: "worker", name: "worker", ip: "127.0.0.4", connected: true, groups: ["space-enroll"] }], ["127.0.0.2", { id: "data-host", name: "data-host", ip: "127.0.0.2", connected: true, groups: ["space-enroll"] }] ]);
		let offline = false;
		const directory = { refresh: async () => { if (offline) throw new Error("management down"); }, lookup: async (ip: string) => { if (offline) throw new Error("management down"); return peers.get(ip) ?? null; } };
		const rootKey = generateKey("ed25519", "control-signer"), identity = new GateIdentity();
		let keys = new SpaceKeyDirectory(h, ctx, clock);
		const verifier = () => new GrantVerifier({ authorityId: "authority", issuerHostId: "control-host", publicKey: rootKey.publicKey, algorithm: "ed25519", now: clock });
		let root: Awaited<ReturnType<typeof startFederationHost>> | undefined, member: Awaited<ReturnType<typeof startFederationHost>> | undefined;
		const sockets: Array<ReturnType<typeof socketTransport>> = [];
		const groupRoles = { "space-admin": ["admin"], "space-members": ["member"], "space-hosts": ["member", "host"], "space-enroll": ["unpaired"] };
		const authority = () => new GrantAuthority({ authorityId: "authority", hostId: "control-host", signer: rootKey.signer, keys, identity, now: clock, refreshIdentity: async conn => { await directory.refresh(); const p = await directory.lookup(conn.overlayIp!); return p ? identity.authenticate({ ...conn, credentials: { roles: p.groups.flatMap(g => groupRoles[g as keyof typeof groupRoles] ?? []) } }) : null; } });
		try {
			const adminKey = generateKey("ed25519", "first"), token = newEnrollToken(); await bootstrapEnroll(h, ctx, { tokenHash: hashToken(token), allowedPeerId: "admin", now: clock });
			root = await startFederationHost(h, ctx, { hostId: "control-host", authorityId: "authority", keys, verifier: verifier(), boot: await provisionBoot(h, "control-host"), control: { host: h, authority: authority(), directory:new CapabilityDirectory({host:h,ctx,spaceId:(await listSpaces(h,ctx)).find(i=>i.alias===CONTROL_SPACE)!.spaceId,assertAuthority:async()=>{},now:clock}) }, directory, groupRoles, listen: { host: "127.0.0.1", port: 0 }, revalidateMs: 0, now: clock });
			const make = (port: number, ip: string, peerId: string, hostId: string, signer: Signer, grantProvider?: any) => { const socket = socketTransport({ host: "127.0.0.1", port }, { localAddress: ip }); sockets.push(socket); return new RemoteSpace(socket, { space: CONTROL_SPACE, signer, expectedGateHostId: hostId, ownPeerId: peerId, now: clock, attempts: 3, backoffMs: 1, callTimeoutMs: 3000, grantProvider }); };
			let admin: RemoteSpace; admin = make((root.address() as any).port, "127.0.0.3", "admin", "control-host", adminKey.signer, () => admin.requestGrant());
			const paired = await admin.enroll(token); peers.get("127.0.0.3")!.groups = ["space-admin"]; await root.revalidate();
			const adminSigner = { ...adminKey.signer, keyId: paired.keyId }; admin = make((root.address() as any).port, "127.0.0.3", "admin", "control-host", adminSigner, () => admin.requestGrant());
			const hostKey = generateKey("ecdsa-p256", "host"), hostToken = newEnrollToken();
			await admin.write({ type: "Command", fields: { commandId: "pair-host", kind: "createEnroll", args: { tokenHash: hashToken(hostToken), role: "host", allowedPeerId: "data-host", scope: ["*"] } } }, null, FOREVER);
			await until(async () => (await admin.readAll({ type: "Result", fields: { commandId: "pair-host" } })).length === 1);
			let hostControl: RemoteSpace; hostControl = make((root.address() as any).port, "127.0.0.2", "data-host", "control-host", hostKey.signer, () => hostControl.requestGrant());
			const hostPaired = await hostControl.enroll(hostToken); peers.get("127.0.0.2")!.groups = ["space-hosts"]; await root.revalidate();
			hostControl = make((root.address() as any).port, "127.0.0.2", "data-host", "control-host", { ...hostKey.signer, keyId: hostPaired.keyId }, () => hostControl.requestGrant()); await hostControl.authenticate();
            await hostControl.publishCapability({hostId:"data-host",resources:{cpus:2},tools:["sieve"],models:[],metrics:{freeMemoryBytes:1000}});
            assert.equal((await hostControl.readAll({type:"Capability"})).length,1);
            await assert.rejects(hostControl.publishCapability({hostId:"other-host",resources:{},tools:[],models:[],metrics:{}}),/associated/);
            await assert.rejects(admin.write({type:"Capability",fields:{hostId:"forged"}},null,FOREVER),/Command/);

			const networkKeys = { find: (peerId: string, keyId: string) => hostControl.lookupPeerKey(peerId, keyId) };
			await data.commit(tx => createSpace(tx, "jobs", now), ctx);
			member = await startFederationHost(data, ctx, { hostId: "data-host", authorityId: "authority", keys: networkKeys, verifier: verifier(), boot: await provisionBoot(data, "data-host"), directory, groupRoles, listen: { host: "127.0.0.1", port: 0 }, revalidateMs: 0, now: clock });
			let purpose: Grant["purpose"] = "effect";
			const socket = socketTransport({ host: "127.0.0.1", port: (member.address() as any).port }, { localAddress: "127.0.0.3" }); sockets.push(socket);
			const remote = new RemoteSpace(socket, { space: "jobs", signer: adminSigner, expectedGateHostId: "data-host", ownPeerId: "admin", now: clock, grantProvider: () => admin.requestGrant(purpose), maxClientWaitMs: 1000, attempts: 2, backoffMs: 1, callTimeoutMs: 3000 });
			await remote.write({ type: "Job", fields: { n: 1 } }, null, FOREVER); assert.equal((await remote.take({ type: "Job" }, 0))?.fields.n, 1); assert.equal((await remote.info()).primaryEpoch, 1, "initial single epoch agrees with recovery boot defaults");
			let pending: any; try { await remote.take({ type: "Later" }, FOREVER); } catch (e) { assert.ok(e instanceof OutcomeUnknown); pending = e.request; }
			assert.ok(pending); now += 61000;
			const local = new PiSpaces(data, ctx, clock, undefined, undefined, { space: "jobs" }); await local.write({ type: "Later", fields: { safe: true } }, null, FOREVER);
			assert.equal(await local.count({ type: "Later" }), 1, "expired grant cannot complete the old remote take");
			purpose = "resolution"; assert.equal((await remote.pollOperation(pending, 0)).state, "pending"); assert.equal(await local.count({ type: "Later" }), 1);
			await assert.rejects(remote.write({ type: "Forbidden", fields: {} }), /resolution/);
			purpose = "effect"; assert.equal((await remote.pollOperation(pending, 0)).state, "done"); assert.equal(await local.count({ type: "Later" }), 0);

			const workerKey = generateKey("ecdsa-p256", "worker"), workerToken = newEnrollToken();
			await admin.write({ type: "Command", fields: { commandId: "pair-worker", kind: "createEnroll", args: { tokenHash: hashToken(workerToken), role: "member", allowedPeerId: "worker", scope: ["jobs"] } } }, null, FOREVER);
			await until(async () => (await admin.readAll({ type: "Result", fields: { commandId: "pair-worker" } })).length === 1);
			let worker: RemoteSpace; worker = make((root.address() as any).port, "127.0.0.4", "worker", "control-host", workerKey.signer, () => worker.requestGrant());
			let workerEnrollment: { generation: string; requestId: string } | undefined;
			const workerPaired = await worker.enroll(workerToken, { beforeSend: async request => { workerEnrollment = request; } }); peers.get("127.0.0.4")!.groups = ["space-members"]; await root.revalidate();
			worker = make((root.address() as any).port, "127.0.0.4", "worker", "control-host", { ...workerKey.signer, keyId: workerPaired.keyId }, () => worker.requestGrant()); await worker.authenticate();
			assert.equal((await worker.enrollStatus(workerEnrollment)).state, "done", "own enrollment remains resolvable after layer-A promotion with data-only scope");
			assert.equal((await worker.enroll(workerToken, { request: workerEnrollment })).keyId, workerPaired.keyId, "persisted identity resolves the consumed token after reconnect");
			await assert.rejects(worker.readAll({ type: "PeerKey" }), /scope/);
			const workerReplacement = generateKey("ecdsa-p256", "worker-replacement"), workerChallenge = await worker.rotationChallenge(workerReplacement.signer.algorithm, workerReplacement.publicKey);
			const workerRotation = await worker.rotateKey(workerChallenge, workerReplacement.signer);
			await until(async () => (await new PiSpaces(h, ctx, clock, undefined, undefined, { space: CONTROL_SPACE }).readAll({ type: "Result", fields: { commandId: workerRotation.commandId } })).length === 1);
			assert.equal((await keys.find("worker", workerPaired.keyId))?.state, "revoked"); assert.deepEqual((await keys.find("worker", workerChallenge.newKeyId))?.scope, ["jobs"]);

			offline = true; await assert.rejects(admin.requestGrant(), /management down/); offline = false;
			const replacement = generateKey("ecdsa-p256", "replacement"), ch = await admin.rotationChallenge(replacement.signer.algorithm, replacement.publicKey);
			const accepted = await admin.rotateKey(ch, replacement.signer);
			await until(async () => (await new PiSpaces(h, ctx, clock, undefined, undefined, { space: CONTROL_SPACE }).readAll({ type: "Result", fields: { commandId: accepted.commandId } })).length === 1);
			assert.equal((await keys.find("admin", paired.keyId))?.state, "revoked"); assert.equal((await keys.find("admin", ch.newKeyId))?.state, "active");
			await root.revalidate(); await member.revalidate();
			await member.close(); member = undefined; await root.close(); root = undefined;
			home.crash(h); other.crash(data); h = await home.open(); data = await other.open(); keys = new SpaceKeyDirectory(h, ctx, clock);
			assert.equal((await keys.find("admin", ch.newKeyId))?.state, "active"); assert.equal((await keys.find("admin", paired.keyId))?.state, "revoked");
			assert.equal(await new PiSpaces(data, ctx, clock, undefined, undefined, { space: "jobs" }).count({ type: "Later" }), 0);
		} finally { sockets.forEach(s => s.close()); await member?.close(); await root?.close(); await other.dispose(); external.close(); installed.close(); rmSync(registerDir, { recursive: true, force: true }); }
	});
}
