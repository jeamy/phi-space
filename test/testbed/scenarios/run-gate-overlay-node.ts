// Case 3 of docs/betrieb-und-mobile-steuerung.md §7.4 over the real NetBird overlay (§8 B4). Operator-driven fixture,
// one JSON command per stdin line. `member` runs on big behind the composed Gate (layer B key proof, signed run gate
// instructions) on its NetBird address; `controller` runs on the operator host with a second, local Member.
// Layer A uses a fixture peer-IP pin, not the NetBird Management API.
import { createInterface } from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { GrantVerifier, RemoteSpace, RunController, RunGateService, core, createSpace, listSpaces, loadFileSigner, localRunMember, provisionFileSigner, remoteRunMember, signRun, snapshotSpace, socketTransport, spaceDoc, startFederationHost, type RunGateInstruction, type RunMember, type RunSpec } from "../../../src/index.ts";

const PORT = 17432;
const [home, role, bindIp, peerIp] = process.argv.slice(2);
if (!home || !["member", "controller"].includes(role!) || !/^(100|127)\.[0-9.]+$/.test(bindIp!) || !/^(100|127)\.[0-9.]+$/.test(peerIp!)) throw Error("usage: run-gate-overlay-node <home> member|controller <bindIp> <peerIp>");
mkdirSync(home, { recursive: true, mode: 0o700 });
const JOB_PROFILE: core.CompletionProfile = { taskType: "Job", resultTypes: ["Done"], equalFields: ["runId", "n"], maxResultCount: 1, maxLeaseMs: 60_000, gateField: "runId" };
const keyFile = join(home, `${role}.key`);
const signer = existsSync(keyFile) ? loadFileSigner(keyFile) : provisionFileSigner(keyFile);
const open = async () => Harness.open(await openNodeSqliteStorage(join(home, `${role}.sqlite`)), { models: createModels(), registry: createRegistry() }, ctx);
let host = await open();
async function jobsSpace(alias: string): Promise<string> {
	const known = (await listSpaces(host, ctx)).find(i => i.alias === alias);
	if (known) return known.spaceId;
	const sid = (await host.commit(tx => createSpace(tx, alias, Date.now()), ctx)).spaceId;
	await host.commit(async tx => core.setCompletionProfiles(await spaceDoc(tx, sid, Date.now()), [JOB_PROFILE]), ctx);
	return sid;
}
/** Registered preparer: two Jobs per Member, idempotent. */
const prepareJobs = async (run: RunSpec, space: string) => {
	await host.commit(async tx => {
		const s = await spaceDoc(tx, space, Date.now());
		for (const n of [1, 2]) if (!core.count(s, Date.now(), { type: "Job", fields: { runId: run.runId, n } })) core.write(s, Date.now(), { type: "Job", fields: { runId: run.runId, n } }, null, core.FOREVER);
	}, ctx);
};
const gateOf = async (sid: string, runId: string) => core.runGateView((await snapshotSpace(host, sid, ctx))!, runId);
const spaceId = await jobsSpace(role === "member" ? "jobs-big" : "jobs-local");
console.log(JSON.stringify({ ready: true, role, ip: bindIp, spaceId, publicKey: signer.publicKey, keyId: signer.keyId }));

let runtime: Awaited<ReturnType<typeof startFederationHost>> | undefined;
let remote: { spaceId: string; publicKey: string; keyId: string } | undefined;
const send = async (t: Parameters<RunGateService["apply"]>[0]) => {
	// A fresh connection and key proof per instruction: a restarted Member has no session to resume.
	const transport = socketTransport({ host: peerIp!, port: PORT }, { localAddress: bindIp, connectTimeoutMs: 3000 });
	try {
		const space = new RemoteSpace(transport, { space: remote!.spaceId, signer, ownPeerId: "control", expectedGateHostId: "member", attempts: 1, callTimeoutMs: 8000 });
		await space.authenticate();
		return await space.requestRunGate(t);
	} finally { transport.close(); }
};
const member = (sid: string): RunMember => sid === spaceId
	? localRunMember(host, ctx, sid, prepareJobs)
	: remoteRunMember({ spaceId: sid, authorityId: "authority", peerId: "control", signer, memberPin: { issuer: "member", algorithm: "ed25519", publicKey: remote!.publicKey }, send });
let controller = () => new RunController({ host, ctx, member, identity: async () => ({ authorityId: "authority", incarnation: "overlay-control-1" }) });

const commands = createInterface({ input: process.stdin });
try {
	for await (const line of commands) {
		let q: any;
		try {
			q = JSON.parse(line);
			let result: unknown;
			if (role === "member" && q.op === "serve") {
				const controlKey = { publicKey: String(q.controllerPublicKey), keyId: String(q.controllerKeyId) };
				runtime = await startFederationHost(host, ctx, {
					hostId: "member", authorityId: "authority", unsafeSkipBootGuardForTests: true, groupRoles: { "space-hosts": ["host"] },
					runGates: new RunGateService({ host, ctx, authorityId: "authority", peerId: "member", signer, controllerPin: { issuer: "control", algorithm: "ed25519", publicKey: controlKey.publicKey }, preparers: { jobs: prepareJobs }, assertAuthority: async () => {} }),
					keys: { find: async (peer, k) => peer === "control" && k === controlKey.keyId ? { peerId: "control", principal: "control", keyId: k, algorithm: "ed25519", publicKey: controlKey.publicKey, state: "active", roles: ["host"], scope: ["*"] } : null },
					verifier: new GrantVerifier({ authorityId: "authority", issuerHostId: "control", algorithm: "ed25519", publicKey: controlKey.publicKey }),
					directory: { refresh: async () => {}, lookup: async ip => ip === peerIp ? { id: "control", name: "control", ip, connected: true, groups: ["space-hosts"] } : null },
					listen: { host: bindIp!, port: PORT }, revalidateMs: 0,
				});
				result = { listening: `${bindIp}:${PORT}` };
			} else if (q.op === "gate") result = { [spaceId]: await gateOf(spaceId, q.runId) };
			else if (role === "controller" && q.op === "connect") { remote = { spaceId: q.spaceId, publicKey: q.publicKey, keyId: q.keyId }; result = { members: [remote.spaceId, spaceId] }; }
			else if (role === "controller" && q.op === "start") result = await controller().start(q.commandId, { runId: q.runId, kind: "jobs", config: null, members: [remote!.spaceId, spaceId] });
			else if (role === "controller" && ["pause", "resume", "stop"].includes(q.op)) result = await (controller() as any)[q.op](q.commandId, q.runId);
			else if (role === "controller" && q.op === "advance") result = await controller().advance(q.runId);
			else if (role === "controller" && q.op === "status") result = await controller().status(q.runId);
			else if (role === "controller" && q.op === "crash") { host = await open(); result = { reopened: true }; } // the old handle is abandoned, as by a killed process
			else if (role === "controller" && q.op === "replay") {
				const instruction = { runId: q.runId, commandId: q.commandId, kind: q.kind, revision: q.revision, authorityId: "authority", spaceId: remote!.spaceId } as RunGateInstruction;
				try { result = { accepted: true, ack: (await send(await signRun("instruction", instruction, "control", signer))).value }; }
				catch (e) { result = { accepted: false, error: e instanceof Error ? e.message : String(e) }; }
			} else if (q.op === "stop-node") { console.log(JSON.stringify({ id: q.id, ok: true, result: { stopped: true } })); break; }
			else throw Error(`unknown command ${q.op} for ${role}`);
			console.log(JSON.stringify({ id: q.id, ok: true, result }));
		} catch (e) { console.log(JSON.stringify({ id: q?.id, ok: false, error: e instanceof Error ? e.message : String(e) })); }
	}
} finally { await runtime?.close(); await host.close(ctx).catch(() => {}); }
