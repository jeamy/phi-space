// The control side of workers, Space commands and deployment (src/workers.ts, src/space-lifecycle.ts, src/deployment.ts) over one
// memory host, for rust/phi-host/tests/deployment.rs: the admin command adapters with scripted ports (host status, the Member's
// answer to a lifecycle instruction) and the real worker directory; each reply carries the instructions sent and both journals.
//
//   node --experimental-strip-types --no-warnings test/support/deployment-driver.ts
import { createInterface } from "node:readline";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { createSpace, snapshotSpace, spaceDoc } from "../../src/spaces.ts";
import { WorkerAssignments, WorkerJournal, appliedWorkers, workerCommands } from "../../src/workers.ts";
import { signLifecycle, spaceCommands } from "../../src/space-lifecycle.ts";
import { DeploymentController, DeploymentState, capabilityHostStatus, deploymentCommands } from "../../src/deployment.ts";
import * as core from "../../src/core.ts";

type Line = Record<string, any>;
const SPACE = "sp-00000000-0000-4000-8000-000000000001";
const signerOf = (fill: number, keyId: string) => {
	const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, fill)]), format: "der", type: "pkcs8" });
	const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
	return { keyId, algorithm: "ed25519" as const, publicKey, sign: async (b: Uint8Array) => sign(null, b, key) };
};
const control = signerOf(5, "control"), memberKey = signerOf(6, "member"), otherKey = signerOf(7, "other");
let host = openOwnMemoryHost();
let now = 1_000_000, incarnation: string | null = null, plan: any[] = [], status: Record<string, string> = {}, sent: unknown[] = [];
const send = async (hostId: string, t: any): Promise<any> => {
	sent.push([hostId, t]);
	const q = t.value, next = plan.shift() ?? {};
	if (next === "throw") throw new Error("the line broke");
	if (typeof next.refuse === "string") throw new Error(next.refuse);
	const r: Record<string, unknown> = { commandId: next.wrongId ? "other" : q.commandId, action: next.wrongAction ? "archive" : q.action };
	if (!next.noSpaceId) r.spaceId = next.spaceId ?? (q.action === "create" ? `sp-${hostId}-${q.alias}` : q.spaceId);
	r.alias = q.alias ?? `al-${q.spaceId}`;
	r.state = q.action === "archive" ? "archived" : q.action === "delete" ? "deleted" : "active";
	if (next.existed) r.existed = true;
	return signLifecycle("result", r, next.issuer ?? "member-peer", (next.badKey ? otherKey : memberKey) as never);
};
const hostPin = async () => ({ issuer: "member-peer", algorithm: memberKey.algorithm, publicKey: memberKey.publicKey });
const build = () => {
	const workers = new WorkerAssignments({ host, ctx, authorityId: "a", peerId: "control-peer", signer: control as never, identity: async () => ({ incarnation }), now: () => now });
	const spaces = spaceCommands({ authorityId: "a", peerId: "control-peer", signer: control as never, hostPin, send });
	const capability = capabilityHostStatus(host, ctx, SPACE, () => now);
	const hostStatus = async (hostId: string) => {
		const s = status[hostId];
		if (s === "throw") throw new Error("status unavailable");
		if (s === "fresh" || s === "stale") return { fresh: s === "fresh", at: now - 5 };
		return capability(hostId);
	};
	const deployment = new DeploymentController({ host, ctx, ports: { hostStatus, createSpace: spaces.createSpace, workers, controlSpaceId: SPACE }, now: () => now });
	const bare = new DeploymentController({ host, ctx, ports: { hostStatus, createSpace: spaces.createSpace, controlSpaceId: SPACE }, now: () => now });
	const applied = async () => appliedWorkers((await snapshotSpace(host, SPACE, ctx))!, now);
	return { workers, capability, bare: deploymentCommands(bare) as Record<string, (id: string, a: Record<string, core.Json>) => Promise<core.Json>>, commands: { ...workerCommands(workers, applied), ...spaces, ...deploymentCommands(deployment) } as Record<string, (id: string, a: Record<string, core.Json>) => Promise<core.Json>> };
};
const open = async () => { host = openOwnMemoryHost(); await host.commit((tx) => createSpace(tx, "control", 1000, { spaceId: SPACE, incarnation: "0a0b0c0d" }), ctx); return build(); };
let w = await open();
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Line;
	if (l.reset) { w = await open(); console.log("{}"); continue; }
	now = l.now ?? now; incarnation = l.incarnation ?? null; plan = l.plan ?? []; status = l.status ?? {}; sent = [];
	if (l.write?.length) await host.commit(async (tx) => { const s = await spaceDoc(tx, SPACE, now); for (const [type, fields, lease] of l.write) core.write(s, now, { type, fields }, null, lease); }, ctx);
	let out: Record<string, unknown>;
	try {
		const a = l.args ?? {};
		const result = l.op === "forHost" ? await w.workers.forHost(String(a.hostId ?? "")) : l.op === "hostStatus" ? await w.capability(String(a.hostId ?? "")) : await (l.noWorkers ? w.bare : w.commands)[l.op]!(l.id, a);
		out = { ok: true, result };
	} catch (e) { out = { ok: false, error: (e as Error).constructor.name, message: (e as Error).message }; }
	console.log(JSON.stringify({ ...out, sent, docs: { workers: (await host.snapshot(WorkerJournal, ctx)) ?? null, deployment: (await host.snapshot(DeploymentState, ctx)) ?? null } }));
}
