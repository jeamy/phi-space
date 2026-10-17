// Alerts, audit and run previews (docs/betrieb-und-mobile-steuerung.md §7.5, §8 B10).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as c from "../src/core.ts";
import { generateKey } from "../src/auth.ts";
import { auditLog, collectAlerts, startAlertMonitor, webhookPublisher, type Alert } from "../src/alerts.ts";
import { GrantVerifier } from "../src/grants.ts";
import { CONTROL_SPACE } from "../src/index.ts";
import { principalId } from "../src/mailbox.ts";
import { RunController, localRunMember, runCommands, type RunMember } from "../src/run-controller.ts";
import { startFederationHost } from "../src/runtime.ts";
import { createSpace, snapshotSpace, spaceDoc } from "../src/spaces.ts";
import { RunJournal } from "../src/run-controller.ts";
import { WorkerAssignments } from "../src/workers.ts";
import { BACKENDS, ctx, PersistentHome } from "./support/persistent.ts";

const PROFILE: c.CompletionProfile = { taskType: "Job", resultTypes: ["Done"], equalFields: ["runId", "n"], maxResultCount: 1, maxLeaseMs: 60_000, gateField: "runId" };
type Host = Awaited<ReturnType<PersistentHome["open"]>>;
async function setup(h: Host) {
	const ids: string[] = [];
	for (const alias of ["a", "b"]) { const id = (await h.commit(tx => createSpace(tx, alias, Date.now()), ctx)).spaceId; await h.commit(async tx => c.setCompletionProfiles(await spaceDoc(tx, id, Date.now()), [PROFILE]), ctx); ids.push(id); }
	const controlSpaceId = (await h.commit(tx => createSpace(tx, CONTROL_SPACE, Date.now()), ctx)).spaceId;
	let down = false;
	const member = (id: string): RunMember => { const m = localRunMember(h, ctx, id, async () => {}); return id === ids[1] ? { ...m, gate: x => down ? Promise.reject(new Error("unreachable")) : m.gate(x) } : m; };
	const runs = new RunController({ host: h, ctx, member });
	const workers = new WorkerAssignments({ host: h, ctx, authorityId: "a", peerId: "control", signer: generateKey("ed25519", "c").signer });
	const capability = (hostId: string, at: number, workersSummary: unknown) => h.commit(async tx => c.write(await spaceDoc(tx, controlSpaceId, Date.now()), Date.now(), { type: "Capability", fields: { hostId, at, resources: {}, tools: [], models: [], metrics: { workers: workersSummary as any } } }, null, c.FOREVER), ctx);
	return { ids, controlSpaceId, runs, workers, capability, setDown: (v: boolean) => { down = v; } };
}

for (const backend of BACKENDS) test(`${backend}: alerts name incomplete pauses, reviews, stale or lagging hosts and rejected workers`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), o = await setup(h), now = Date.now();
		await o.runs.start("s1", { runId: "r1", kind: "jobs", config: null, members: o.ids });
		o.setDown(true); await o.runs.pause("p1", "r1"); o.setDown(false);
		await o.runs.start("s2", { runId: "r2", kind: "jobs", config: null, members: [o.ids[0]!] });
		await o.workers.set("w1", { assignmentId: "silent", hostId: "host-x", kind: "sieve", targetSpace: o.ids[0]!, count: 1 });
		await o.workers.set("w2", { assignmentId: "bad", hostId: "host-y", kind: "shell", targetSpace: o.ids[0]!, count: 1 });
		await o.workers.set("w3", { assignmentId: "late", hostId: "host-z", kind: "sieve", targetSpace: o.ids[0]!, count: 1 });
		await o.capability("host-y", now, { generation: 2, assignments: { bad: { rejected: "no registered worker kind shell" } } });
		await o.capability("host-z", now, { generation: 1, assignments: {}, fetchError: "control unreachable" });
		await o.capability("host-old", now - 10 * 60_000, { generation: 0, assignments: {} });
		const alerts = await collectAlerts({ runs: o.runs, workers: o.workers, host: h, ctx, controlSpaceId: o.controlSpaceId });
		const keys = alerts.map(a => a.key);
		for (const k of ["run:r1:pauseIncomplete", "worker:silent:stale", "worker:bad:rejected", "worker:late:pending:3", "host:host-z:fetch", "host:host-old:stale"]) assert.ok(keys.includes(k), `${k} in ${keys.join(", ")}`);
		assert.equal(alerts[0]!.severity, "critical", "critical first");
		assert.ok(!keys.some(k => k.startsWith("run:r2")), "a healthy run raises nothing");
		await o.runs.reconcile("rec", "r2", "rec-2");
		assert.ok((await collectAlerts({ runs: o.runs, host: h, ctx, controlSpaceId: o.controlSpaceId })).some(a => a.key === "run:r2:needsReview"));
	} finally { await home.dispose(); }
});

test("the alert monitor publishes only changes and retries a failed delivery", async () => {
	let current: Alert[] = [{ key: "a", severity: "warning", source: "host", subject: "h", message: "m" }];
	const published: Array<{ raised: string[]; resolved: string[] }> = []; let fail = true;
	const m = startAlertMonitor({ collect: async () => current, intervalMs: 60_000, publish: async ch => { if (fail) { fail = false; throw new Error("network"); } published.push({ raised: ch.raised.map(a => a.key), resolved: ch.resolved.map(a => a.key) }); } });
	try {
		await new Promise(r => setTimeout(r, 20));
		assert.deepEqual(published, [], "the first delivery failed");
		await m.pass(); assert.deepEqual(published, [{ raised: ["a"], resolved: [] }], "the same alert is delivered again");
		await m.pass(); assert.equal(published.length, 1, "no change, no message");
		current = [{ key: "b", severity: "critical", source: "run", subject: "r", message: "x" }];
		await m.pass(); assert.deepEqual(published[1], { raised: ["b"], resolved: ["a"] });
	} finally { await m.stop(); }
});

test("the webhook publisher posts plain text with priority and refuses URLs with credentials", async (tc) => {
	const got: Array<{ body: string; priority: string | undefined; title: string | undefined }> = [];
	const server = http.createServer(async (req, res) => { let body = ""; for await (const ch of req) body += ch; got.push({ body, priority: req.headers.priority as string, title: req.headers.title as string }); res.end("ok"); });
	await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); tc.after(() => server.close());
	const publish = webhookPublisher(`http://127.0.0.1:${(server.address() as AddressInfo).port}/pi-spaces`, { title: "prime-demo" });
	await publish({ raised: [{ key: "k", severity: "critical", source: "run", subject: "r1", message: "Pause unvollständig" }], resolved: [{ key: "j", severity: "warning", source: "host", subject: "h", message: "alt" }] });
	assert.deepEqual(got[0], { body: "!! r1: Pause unvollständig\nok h: alt", priority: "high", title: "prime-demo" });
	assert.throws(() => webhookPublisher("https://user:pw@ntfy.example/t"), c.IllegalArgumentError);
});

for (const backend of BACKENDS) test(`${backend}: previews journal nothing; the audit lists results without payloads`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), o = await setup(h), cmds = runCommands(o.runs);
		assert.deepEqual(await cmds.startRun!("x", { runId: "r9", kind: "jobs", config: null, members: [o.ids[0]!], dryRun: true }), { dryRun: true, allowed: true, revision: 1 });
		assert.equal(await o.runs.status("r9"), null, "a preview starts nothing");
		await o.runs.start("s", { runId: "r9", kind: "jobs", config: null, members: [o.ids[0]!] });
		assert.deepEqual(await cmds.resumeRun!("y", { runId: "r9", dryRun: true }), { dryRun: true, allowed: false, reason: "cannot resume while running", state: "running" });
		assert.deepEqual(await cmds.pauseRun!("z", { runId: "r9", dryRun: true }), { dryRun: true, allowed: true, revision: 3, state: "running" });
		assert.equal((await o.runs.status("r9"))!.revision, 2);
		assert.equal(Object.keys((await h.snapshot(RunJournal, ctx))!.runs.r9!.commands).length, 1, "previews leave no command");
		await h.commit(async tx => { const s = await spaceDoc(tx, o.controlSpaceId, Date.now()); for (const [id, at, state, extra] of [["c1", 10, "completed", { result: { secret: "payload" } }], ["c2", 20, "failed", { error: "denied" }]] as const) c.write(s, Date.now(), { type: "Result", fields: { commandId: id, kind: "pauseRun", state, requestedBy: "p-admin", at, ...extra } as any }, null, c.FOREVER); }, ctx);
		const log = await auditLog(h, ctx, o.controlSpaceId);
		assert.deepEqual(log, [{ commandId: "c2", kind: "pauseRun", state: "failed", requestedBy: "p-admin", at: 20, error: "denied" }, { commandId: "c1", kind: "pauseRun", state: "completed", requestedBy: "p-admin", at: 10 }]);
		assert.ok(!JSON.stringify(log).includes("payload"));
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: listAlerts and auditLog are admin commands of the composed control runtime`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), o = await setup(h), key = generateKey("ed25519", "ctl");
		const runtime = await startFederationHost(h, ctx, { hostId: "ctl", authorityId: "a", unsafeSkipBootGuardForTests: true, keys: { find: async () => null },
			verifier: new GrantVerifier({ authorityId: "a", issuerHostId: "ctl", algorithm: "ed25519", publicKey: key.publicKey }), directory: { refresh: async () => {}, lookup: async () => null },
			listen: { host: "127.0.0.1", port: 0 }, revalidateMs: 0, control: { host: h, authority: {} as any, runs: o.runs, workers: o.workers } });
		try {
			await o.workers.set("w", { assignmentId: "silent", hostId: "host-x", kind: "sieve", targetSpace: o.ids[0]!, count: 1 });
			await h.commit(async tx => c.write(await spaceDoc(tx, o.controlSpaceId, Date.now()), Date.now(), { type: "PeerKey", fields: { peerId: "p-admin", state: "active", roles: ["admin"] } }, null, c.FOREVER), ctx);
			for (const [id, kind] of [["al", "listAlerts"], ["au", "auditLog"]]) await h.commit(async tx => c.write(await spaceDoc(tx, o.controlSpaceId, Date.now()), Date.now(), { type: "Command", fields: { commandId: id, kind, args: {} } }, null, 3_600_000, principalId({ peerId: "p-admin" })), ctx);
			const result = async (id: string) => { for (let i = 0; i < 200; i++) { const r = c.list((await snapshotSpace(h, o.controlSpaceId, ctx))!, Date.now(), { type: "Result", fields: { commandId: id } })[0]?.fields as any; if (r) return r; await new Promise(x => setTimeout(x, 25)); } throw new Error("no result " + id); };
			assert.deepEqual((await result("al")).result.map((a: Alert) => a.key), ["worker:silent:stale"]);
			assert.equal((await result("au")).state, "completed");
		} finally { await runtime.close(); }
	} finally { await home.dispose(); }
});
