// Space lifecycle (docs/betrieb-und-mobile-steuerung.md §5, §8 B7): idempotent creation with reuse, archiving,
// checked deletion with reserved ids, signed instructions, admin commands and the composed Gate over TCP.
import test from "node:test";
import assert from "node:assert/strict";
import * as c from "../src/core.ts";
import * as claims from "../src/claims.ts";
import { generateKey } from "../src/auth.ts";
import { PhiSpaces } from "../src/client.ts";
import { GrantVerifier } from "../src/grants.ts";
import { principalId } from "../src/mailbox.ts";
import { RemoteSpace } from "../src/remote.ts";
import { startFederationHost } from "../src/runtime.ts";
import { socketTransport } from "../src/socket.ts";
import { CONTROL_SPACE, Supervisor } from "../src/index.ts";
import { SpaceInUse, SpaceLifecycle, SpaceLifecycleService, signLifecycle, spaceCommands, type SpaceLifecycleInstruction } from "../src/space-lifecycle.ts";
import { createSpace, listSpaces, resolveSpaceId, snapshotSpace, spaceDoc } from "../src/spaces.ts";
import { BACKENDS, ctx, PersistentHome } from "./support/persistent.ts";

const controlKey = generateKey("ed25519", "control"), hostKey = generateKey("ed25519", "host-b");
const controlPin = { issuer: "control", algorithm: controlKey.signer.algorithm, publicKey: controlKey.publicKey };
const hostPin = { issuer: "host-b", algorithm: hostKey.signer.algorithm, publicKey: hostKey.publicKey };
const PROFILE: c.CompletionProfile = { taskType: "Job", resultTypes: ["Done"], equalFields: ["n"], maxResultCount: 1 };

for (const backend of BACKENDS) test(`${backend}: create reuses an alias unchanged, archive stops new work, delete needs an empty archived Space and keeps the id reserved`, async () => {
	const home = new PersistentHome(backend);
	try {
		let h = await home.open();
		const life = () => new SpaceLifecycle({ host: h, ctx });
		const made = await life().apply({ commandId: "c1", action: "create", alias: "jobs", limits: { maxEntries: 50 }, profiles: [PROFILE] });
		assert.equal(made.state, "active"); assert.equal(made.existed, undefined);
		assert.deepEqual(await life().apply({ commandId: "c1", action: "create", alias: "jobs", limits: { maxEntries: 50 }, profiles: [PROFILE] }), made, "same command, same result");
		const again = await life().apply({ commandId: "c2", action: "create", alias: "jobs" });
		assert.deepEqual([again.spaceId, again.existed], [made.spaceId, true], "a second create reuses the Space");
		await assert.rejects(life().apply({ commandId: "c3", action: "create", alias: "jobs", limits: { maxEntries: 60 } }), /reused only unchanged/);
		await assert.rejects(life().apply({ commandId: "c1", action: "create", alias: "other" }), c.IllegalArgumentError, "a command ID names one request");
		const s0 = (await snapshotSpace(h, made.spaceId, ctx))!;
		assert.equal(c.limitsOf(s0).maxEntries, 50); assert.deepEqual(s0.completionProfiles, [PROFILE]);

		const space = new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space: made.spaceId });
		await space.write({ type: "Note", fields: { n: 1 } }, null, c.FOREVER);
		await assert.rejects(life().apply({ commandId: "d0", action: "delete", spaceId: made.spaceId }), /archive the Space first/);
		assert.equal((await life().apply({ commandId: "a1", action: "archive", spaceId: made.spaceId })).state, "archived");
		await assert.rejects(space.write({ type: "Note", fields: { n: 2 } }, null, c.FOREVER), /archived/);
		await assert.rejects(space.createTransaction(1000), /archived/);
		await assert.rejects(space.take({ type: "Note" }, 0), /archived/);
		assert.equal(await space.count({ type: "Note" }), 1, "reads stay possible");
		await assert.rejects(life().apply({ commandId: "d1", action: "delete", spaceId: made.spaceId }), SpaceInUse);
		await life().apply({ commandId: "r1", action: "reactivate", spaceId: made.spaceId });
		assert.ok(await space.take({ type: "Note" }, 0));
		await h.commit(async tx => { const s = await spaceDoc(tx, made.spaceId, Date.now()); claims.admit(s, Date.now(), { principal: { peerId: "p" }, generation: claims.issueGeneration(s, Date.now(), { peerId: "p" }).generation, requestId: "r" }, "write", { x: 1 }, Date.now() + 60_000, 4096); }, ctx);
		await life().apply({ commandId: "a2", action: "archive", spaceId: made.spaceId });
		await assert.rejects(life().apply({ commandId: "d2", action: "delete", spaceId: made.spaceId }), /retains request claims/, "claims stay reachable until they expire");
		await h.commit(async tx => { const s = await spaceDoc(tx, made.spaceId, Date.now()); s.rpc = { generations: {}, claims: {}, bytes: 0, reservedBytes: 0 }; }, ctx); // the retention elapsed

		home.crash(h); h = await home.open();
		const deleted = await life().apply({ commandId: "d3", action: "delete", spaceId: made.spaceId });
		assert.equal(deleted.state, "deleted");
		assert.equal((await listSpaces(h, ctx)).some(i => i.spaceId === made.spaceId), false);
		assert.equal(await snapshotSpace(h, made.spaceId, ctx), undefined);
		await assert.rejects(h.commit(tx => resolveSpaceId(tx, made.spaceId, Date.now()), ctx), /unknown space/);
		const fresh = await life().apply({ commandId: "c4", action: "create", alias: "jobs" });
		assert.notEqual(fresh.spaceId, made.spaceId, "the alias is free again, the old id stays reserved");
		const member = await life().apply({ commandId: "m1", action: "create", alias: "member" });
		await h.commit(async tx => { (await spaceDoc(tx, member.spaceId, Date.now())).membership = { state: "active" } as any; }, ctx);
		await assert.rejects(life().apply({ commandId: "m2", action: "archive", spaceId: member.spaceId }), /federation Member \(active\); removeMember first/);
		const control = (await h.commit(tx => createSpace(tx, CONTROL_SPACE, Date.now()), ctx)).spaceId;
		await assert.rejects(life().apply({ commandId: "x", action: "archive", spaceId: control }), /no lifecycle/);
	} finally { await home.dispose(); }
});

test("archived Spaces refuse taking waits and registrations, reading waits stay possible", () => {
	const s = c.initialState(); s.archived = { at: 0, commandId: "a" };
	assert.throws(() => c.addWaiter(s, 0, { template: { type: "Job" }, take: true, target: "w", timeout: 1000 }), /archived/);
	assert.throws(() => c.notify(s, 0, { type: "Job" }, null, 1000, null, "w"), /archived/);
	c.addWaiter(s, 0, { template: { type: "Job" }, take: false, target: "w", timeout: 1000 });
});

for (const backend of BACKENDS) test(`${backend}: signed lifecycle instructions over admin commands; refusals become failed results`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open();
		const service = new SpaceLifecycleService({ lifecycle: new SpaceLifecycle({ host: h, ctx }), hostId: "host-b", authorityId: "authority", peerId: "host-b", signer: hostKey.signer, controlPin, assertAuthority: async () => {} });
		let down = false;
		const commands = spaceCommands({ authorityId: "authority", peerId: "control", signer: controlKey.signer, hostPin: async () => hostPin, send: async (hostId, t) => { if (down) throw new Error("connect ECONNREFUSED"); assert.equal(hostId, "host-b"); return service.apply(t); } });
		const made = await commands.createSpace("k1", { hostId: "host-b", alias: "sieve-b" }) as any;
		assert.equal(made.state, "active"); assert.ok(made.spaceId);
		const failed = await commands.deleteSpace("k2", { hostId: "host-b", spaceId: made.spaceId }) as any;
		assert.equal(failed.phase, "failed"); assert.match(failed.error, /archive the Space first/);
		down = true;
		await assert.rejects(commands.archiveSpace("k3", { hostId: "host-b", spaceId: made.spaceId }), /ECONNREFUSED/, "an unreachable host is retried, not failed");
		down = false;
		assert.equal((await commands.archiveSpace("k3", { hostId: "host-b", spaceId: made.spaceId }) as any).state, "archived");
		const q: SpaceLifecycleInstruction = { commandId: "k4", action: "reactivate", spaceId: made.spaceId, authorityId: "authority", hostId: "host-b" };
		await assert.rejects(service.apply(await signLifecycle("instruction", q, "control", generateKey("ed25519", "rogue").signer)), c.PermissionError);
		await assert.rejects(service.apply(await signLifecycle("instruction", { ...q, hostId: "host-c" }, "control", controlKey.signer)), /another authority or host/);

		const supervisor = new Supervisor(h, ctx, { asyncCommands: commands });
		const stop = await supervisor.start();
		try {
			const controlId = (await listSpaces(h, ctx)).find(i => i.alias === CONTROL_SPACE)!.spaceId;
			await h.commit(async tx => c.write(await spaceDoc(tx, controlId, Date.now()), Date.now(), { type: "PeerKey", fields: { peerId: "p-admin", state: "active", roles: ["admin"] } }, null, c.FOREVER), ctx);
			await h.commit(async tx => c.write(await spaceDoc(tx, controlId, Date.now()), Date.now(), { type: "Command", fields: { commandId: "adm-1", kind: "createSpace", args: { hostId: "host-b", alias: "via-admin" } } }, null, 3_600_000, principalId({ peerId: "p-admin" })), ctx);
			let result: any;
			for (let i = 0; i < 200 && !result; i++) { result = c.list((await snapshotSpace(h, controlId, ctx))!, Date.now(), { type: "Result", fields: { commandId: "adm-1" } })[0]?.fields; if (!result) await new Promise(r => setTimeout(r, 25)); }
			assert.equal(result.state, "completed"); assert.equal(result.result.alias, "via-admin");
		} finally { await stop(); }
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: the composed Gate applies a signed lifecycle instruction from a proven peer over TCP`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open();
		const runtime = await startFederationHost(h, ctx, {
			hostId: "host-b", authorityId: "authority", unsafeSkipBootGuardForTests: true, groupRoles: { "space-hosts": ["host"] },
			spaceLifecycle: new SpaceLifecycleService({ lifecycle: new SpaceLifecycle({ host: h, ctx }), hostId: "host-b", authorityId: "authority", peerId: "host-b", signer: hostKey.signer, controlPin, assertAuthority: async () => {} }),
			keys: { find: async (peer, k) => peer === "control" && k === controlKey.signer.keyId ? { peerId: "control", principal: "control", keyId: k, algorithm: "ed25519", publicKey: controlKey.publicKey, state: "active", roles: ["host"], scope: ["*"] } : null },
			verifier: new GrantVerifier({ authorityId: "authority", issuerHostId: "control", algorithm: "ed25519", publicKey: controlKey.publicKey }),
			directory: { refresh: async () => {}, lookup: async ip => ip === "127.0.0.2" ? { id: "control", name: "control", ip, connected: true, groups: ["space-hosts"] } : null },
			listen: { host: "127.0.0.1", port: 0 }, revalidateMs: 0,
		});
		const socket = socketTransport({ host: "127.0.0.1", port: (runtime.address() as any).port }, { localAddress: "127.0.0.2" });
		try {
			const remote = new RemoteSpace(socket, { signer: controlKey.signer, ownPeerId: "control", expectedGateHostId: "host-b", attempts: 1 });
			await remote.authenticate();
			const reply = await remote.requestSpaceLifecycle(await signLifecycle("instruction", { commandId: "tcp-1", action: "create", alias: "over-tcp", authorityId: "authority", hostId: "host-b" }, "control", controlKey.signer));
			assert.equal(reply.issuer, "host-b"); assert.equal(reply.value.alias, "over-tcp");
			assert.ok((await listSpaces(h, ctx)).some(i => i.alias === "over-tcp"));
		} finally { socket.close(); await runtime.close(); }
	} finally { await home.dispose(); }
});
