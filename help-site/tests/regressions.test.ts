import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { core, FOREVER, Meter, PiSpaces, RemoteSpace, SpaceService, StaticIdentity, inProcessTransport, spaceDoc, spaces } from "../../src/index.ts";
import { SpaceChatEngine } from "../examples/shared/chat-core.ts";
import { renderMarkdownToHtml } from "../client/lib/markdown.ts";
import { WebAdminController, WebAdminState } from "../server/admin/admin-controller.ts";
import { SpaceChatHub } from "../server/space-chat/stage-runner.ts";
import { dispatchChatCommand } from "../server/space-chat/commands.ts";
import { upgradeWebSocket } from "../server/ws.ts";
import { appendHistory, initializeHistory, mergedHistory } from "../server/social/history.ts";
import type { SwarmPost } from "../server/social/swarm.ts";
import { SocialSwarmHub } from "../server/social/swarm.ts";
import { startArticleLoad } from "../client/lib/article-load.ts";
import { startChatConnection, type ChatSocket } from "../client/lib/chat-connection.ts";
import { UploadStore } from "../server/uploads.ts";
import { SIEVE_EXPORTER, collectSieveResults } from "../../examples/sieve.ts";

async function memory() {
	const registry = createRegistry(); registry.install(spaces);
	return Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
}
async function until(check: () => Promise<boolean>, ms = 5_000) {
	const deadline = Date.now() + ms;
	while (!await check()) { if (Date.now() > deadline) throw new Error("Condition timed out"); await new Promise(r => setTimeout(r, 25)); }
}

test("F02: markdown consumes unknown block lines, H4-H6 and EOF", () => {
	for (const input of ["#### Heading", "| orphan", "#invalid", "   ## indented", "###### Six", "text\n| orphan"]) {
		assert.ok(renderMarkdownToHtml(input).length > 0);
	}
	assert.equal(renderMarkdownToHtml("#### Heading"), "<h4>Heading</h4>");
	assert.equal(renderMarkdownToHtml("#invalid"), "<p>#invalid</p>");
});

test("cold expiry watermark scans persisted entries after reopen", () => {
	const state = core.initialState(); core.write(state, 1_000, { type: "Timer", fields: {} }, null, 10);
	const reopened = JSON.parse(JSON.stringify(state)); core.settle(reopened, 1_020);
	assert.equal(reopened.entries.length, 0);
});

test("F01/F21: concurrent engines coordinate sequences, repeats and unique threads", async () => {
	const h = await memory();
	try {
		const s = new PiSpaces(h, ctx), a = new SpaceChatEngine(s), b = new SpaceChatEngine(new PiSpaces(h, ctx));
		await a.installProfilesIfSupported();
		const input = { threadId: "t", title: "Thread", createdBy: "a", requestId: "create" };
		await Promise.all([a.createThread(input), b.createThread(input)]);
		assert.equal(await s.count({ type: "Thread" }), 1);
		const write = s.write.bind(s);
		s.write = async (entry, ...args) => { if (entry.type === "Msg") throw new Error("injected message failure"); return write(entry, ...args); };
		await assert.rejects(a.submitMessage({ threadId: "t", author: "a", text: "abort", requestId: "abort" }), /injected/);
		s.write = write;
		await assert.rejects(b.createThread({ ...input, requestId: "other" }), /already exists/);
		const messages = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).submitMessage({ threadId: "t", author: "a", text: "message " + i, requestId: "m" + i })));
		assert.equal(new Set(messages.map(m => m.seq)).size, 8);
		assert.deepEqual(messages.map(m => m.seq).sort((a, b) => a - b), [1,2,3,4,5,6,7,8]);
		await Promise.all([a.processNextChatTask(), b.processNextChatTask()]);
		const snapshot = await a.inspectSnapshot();
		assert.equal(snapshot.messages.length, 10);
		assert.equal(new Set(snapshot.messages.map(m => m.seq)).size, 10);
		const replay = { threadId: "t", author: "a", text: "same", requestId: "repeat" };
		const repeats = await Promise.all([a.submitMessage(replay), b.submitMessage(replay)]);
		assert.deepEqual(repeats[0], repeats[1]);
		await assert.rejects(a.submitMessage({ ...replay, text: "different" }), /different arguments/);
		for (const fork of [{ parentThreadId: "missing", forkUpToSeq: 0 }, { parentThreadId: "t", forkUpToSeq: -1 }, { parentThreadId: "t", forkUpToSeq: 0.5 }, { parentThreadId: "t", forkUpToSeq: 999 }]) {
			await assert.rejects(a.forkThread({ newThreadId: "bad", title: "Bad", createdBy: "a", requestId: "fork", ...fork }));
		}
		await a.forkThread({ newThreadId: "child", parentThreadId: "t", forkUpToSeq: 2, title: "Child", createdBy: "a", requestId: "fork-ok" });
		const own = await b.submitMessage({ threadId: "child", author: "b", text: "child", requestId: "own" });
		assert.equal(own.seq, 3);
		assert.ok((await a.inspectSnapshot()).messages.some(m => m.projectionOf));
	} finally { await h.close(ctx); }
});

test("F01: legacy colliding sequences remain visible with distinct identities", () => {
	const base = { threadId: "t", seq: 1, author: "a", role: "user" as const, text: "x", taskId: "x", subagentSearchId: "none", createdAt: 1 };
	const result = SpaceChatEngine.resolveMessagesForThread("t", new Map(), new Map([["t", [{ ...base, msgId: "one" }, { ...base, msgId: "two" }]]]));
	assert.deepEqual(result.map(m => m.msgId), ["one", "two"]);
});

test("atomic unique write works locally, through RPC, and during a reservation", async () => {
	const h = await memory();
	try {
		const local = new PiSpaces(h, ctx);
		const service = new SpaceService({ host: h, ctx, identity: new StaticIdentity({ peer: { principal: { peerId: "peer" }, roles: ["member"] } }) });
		const remote = new RemoteSpace(inProcessTransport(service, { peerId: "peer" }));
		const outcomes = await Promise.allSettled([local.write({ type: "Mutex", fields: { key: "k" } }, null, FOREVER, { unique: ["key"] }), remote.write({ type: "Mutex", fields: { key: "k" } }, null, FOREVER, { unique: ["key"] })]);
		assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
		const txn = await local.createTransaction(5_000);
		await local.take({ type: "Mutex" }, 0, { txn: txn.id });
		await assert.rejects(remote.write({ type: "Mutex", fields: { key: "k" } }, null, FOREVER, { unique: ["key"] }), /unique/);
		await local.abort(txn.id);
		assert.equal(await local.count({ type: "Mutex" }), 1);
	} finally { await h.close(ctx); }
});

test("F08/F10: presence replay across engines and completed search provenance", async () => {
	const h = await memory();
	try {
		const s = new PiSpaces(h, ctx), a = new SpaceChatEngine(s), b = new SpaceChatEngine(new PiSpaces(h, ctx));
		const input = { participantId: "p", username: "P", activeThreadId: "t", requestId: "join" };
		const [x, y] = await Promise.all([a.joinOrRefreshPresence(input), b.joinOrRefreshPresence(input)]);
		assert.equal(x.leaseId, y.leaseId);
		assert.equal(await s.count({ type: "Presence" }), 1);
		await assert.rejects(a.joinOrRefreshPresence({ ...input, username: "Other" }), /different/);
		assert.equal(await s.count({ type: "Presence" }), 1);
		await a.createThread({ threadId: "t", title: "Search", createdBy: "p", requestId: "create" });
		await a.submitMessage({ threadId: "t", author: "p", text: "suche: space", requestId: "search" });
		await a.processNextChatTask();
		const search = (await new SpaceChatEngine(s).inspectSnapshot()).subagentRuns[0]!;
		assert.equal(search.parentThreadId, "t");
		assert.equal(search.question, "[p]: suche: space");
	} finally { await h.close(ctx); }
});

test("F03/F06/F07: durable admin replay, parallel requests, enrollment separation and stable identity on SQLite reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "help-admin-regression-"));
	const open = async () => { const registry = createRegistry(); registry.install(spaces); return Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), { models: createModels(), registry }, ctx); };
	let h = await open();
	let admin = new WebAdminController({ host: h, ctx, meter: new Meter(), adminPassword: "test" });
	try {
		await admin.initialize();
		const identity = admin.login({ password: "test" });
		assert.throws(() => admin.login({ password: "admin-spaces-2026" }));
		const command = { commandId: "create", kind: "createSpace", args: { alias: "replay-test" }, requestedBy: "tester" };
		const staleController = new WebAdminController({ host: h, ctx, meter: new Meter(), adminPassword: "test" }); await staleController.initialize();
		const [first, parallel] = await Promise.all([admin.executeCommand(command), admin.executeCommand(command)]);
		assert.deepEqual(first.result, parallel.result);
		try { assert.deepEqual((await staleController.executeCommand(command)).result, first.result); } finally { await staleController.close(); }
		await assert.rejects(admin.executeCommand({ ...command, args: { alias: "wrong" } }), /different/);
		const enroll = await admin.executeCommand({ commandId: "enroll", kind: "createEnroll", args: { role: "member", peerId: "phone" }, requestedBy: "tester" });
		assert.throws(() => admin.login({ enrollToken: (enroll.result as any).token }));
		await admin.close(); await h.close(ctx);
		h = await open(); admin = new WebAdminController({ host: h, ctx, meter: new Meter(), adminPassword: "test" });
		await admin.initialize();
		assert.deepEqual((await admin.executeCommand(command)).result, first.result);
		assert.equal(admin.login({ password: "test" }).publicKey, identity.publicKey);
		const s = new PiSpaces(h, ctx, Date.now, undefined, undefined, { space: admin.controlSpaceId });
		assert.equal((await s.readAll({ type: "PeerKey", fields: { peerId: "web-admin-eibrain", state: "active" } })).length, 1);
		const rotation = { commandId: "rotate", kind: "rotateKey", requestedBy: "tester" };
		await Promise.all([admin.executeCommand(rotation), admin.executeCommand(rotation)]);
		assert.equal((await s.readAll({ type: "PeerKey", fields: { peerId: "web-admin-eibrain", state: "active" } })).length, 1);
	} finally { await admin.close(); await h.close(ctx); await rm(dir, { recursive: true, force: true }); }
});

test("F04/F05: overdue schedules advance and persisted workers restart without a command", async () => {
	const h = await memory();
	let admin = new WebAdminController({ host: h, ctx, meter: new Meter(), adminPassword: "test" });
	try {
		await admin.initialize();
		await admin.executeCommand({ commandId: "start", kind: "startRun", args: { runId: "scheduled", start: 1, end: 10 }, requestedBy: "test" });
		await admin.executeCommand({ commandId: "schedule", kind: "scheduleRun", args: { runId: "scheduled", delayMs: -1 }, requestedBy: "test" });
		await until(async () => (await admin.runController.list()).some(r => r.runId === "scheduled" && r.state === "paused"));
		await admin.executeCommand({ commandId: "workers", kind: "setWorkers", args: { assignmentId: "test-workers", targetSpace: admin.defaultSieveSpaceId, kind: "chat-worker", count: 1 }, requestedBy: "test" });
		await admin.close();
		admin = new WebAdminController({ host: h, ctx, meter: new Meter(), adminPassword: "test" }); await admin.initialize();
		assert.equal(admin.workerSupervisor.summary().assignments["test-workers"]?.active, 1);
		await admin.executeCommand({ commandId: "resume-schedule", kind: "scheduleRun", args: { runId: "scheduled", scheduleKind: "resume", delayMs: 30 }, requestedBy: "test" });
		await admin.close(); admin = new WebAdminController({ host: h, ctx, meter: new Meter(), adminPassword: "test" }); await admin.initialize();
		await until(async () => (await admin.runController.list()).some(r => r.runId === "scheduled" && r.state === "running"));
	} finally { await admin.close(); await h.close(ctx); }
});

test("F11/F12/F13/F23: shared initialization, queue retry, immutable report and common dispatcher", async () => {
	const h = await memory();
	let hub = new SpaceChatHub(h, ctx, new Meter());
	try {
		const [a, b] = await Promise.all([hub.ensureSession("room", { seed: false }), hub.ensureSession("room", { seed: false })]);
		assert.strictEqual(a, b);
		await a.engine.createThread({ threadId: "t", title: "T", createdBy: "a", requestId: "t" });
		await a.engine.submitMessage({ threadId: "t", author: "a", text: "queued before shutdown", requestId: "pending" });
		await hub.close(); hub = new SpaceChatHub(h, ctx, new Meter()); await hub.initialize();
		const session = await hub.ensureSession("room", { seed: false });
		const realCommit = session.engine.space.commit.bind(session.engine.space);
		let once = true;
		session.engine.space.commit = async (...args) => { if (once) { once = false; throw new Error("injected commit failure"); } return realCommit(...args); };
		await until(async () => (await session.engine.inspectSnapshot()).messages.some(m => m.role === "assistant"));
		assert.equal((await session.engine.inspectSnapshot()).pendingTasks.length, 0);
		await assert.rejects(dispatchChatCommand(session.engine, { kind: "unknown" }), /Unknown/);
		const report = await hub.runStageDemo("v1") as any;
		assert.equal(report.mirrorMode, "immutable-report");
		assert.equal(report.snapshot.messages.length, 6);
		await assert.rejects(hub.executeAction("stage-v1", { kind: "message.submit" }), /immutable/);
		await hub.runStageDemo("v1");
		assert.equal((await hub.broadcastSnapshot("stage-v1")).messages.length, 6);
		const before = await hub.broadcastSnapshot("stage-v1"), commit = h.commit.bind(h);
		h.commit = ((fn: any, context: any) => commit(async tx => { await fn(tx); throw new Error("report import interrupted"); }, context)) as typeof h.commit;
		try { await assert.rejects(hub.runStageDemo("v1"), /import interrupted/); } finally { h.commit = commit; }
		assert.deepEqual((await hub.broadcastSnapshot("stage-v1")).messages, before.messages);
	} finally { await hub.close(); await h.close(ctx); }
});

class Socket extends Duplex {
	written: Buffer[] = [];
	_read() {}
	_write(chunk: Buffer, _encoding: string, done: () => void) { this.written.push(Buffer.from(chunk)); done(); }
}
function clientFrame(opcode: number, payload: Buffer, fin = true, masked = true) {
	assert.ok(payload.length < 126);
	const mask = Buffer.from([1, 2, 3, 4]);
	return Buffer.concat([Buffer.from([(fin ? 128 : 0) | opcode, (masked ? 128 : 0) | payload.length]), ...(masked ? [mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))] : [payload])]);
}
function upgrade(socket: Socket, head = Buffer.alloc(0)) {
	return upgradeWebSocket({ method: "GET", headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } } as IncomingMessage, socket, head)!;
}
test("F17: real masked frames queue early input and enforce protocol and fragmentation limits", async () => {
	const socket = new Socket(); const ws = upgrade(socket, clientFrame(1, Buffer.from("early")));
	await new Promise(r => setImmediate(r));
	const messages: string[] = []; ws.onMessage(text => { messages.push(text); });
	await new Promise(r => setImmediate(r)); assert.deepEqual(messages, ["early"]);
	socket.push(clientFrame(1, Buffer.from("hel"), false)); socket.push(clientFrame(0, Buffer.from("lo")));
	await new Promise(r => setImmediate(r)); assert.deepEqual(messages, ["early", "hello"]); ws.close();
	for (const frames of [clientFrame(1, Buffer.from("x"), true, false), clientFrame(0, Buffer.alloc(0)), clientFrame(9, Buffer.alloc(0), false), clientFrame(1, Buffer.from([0xff])), Buffer.concat([clientFrame(1, Buffer.alloc(0), false), ...Array.from({ length: 1025 }, () => clientFrame(0, Buffer.alloc(0), false))])]) {
		const bad = new Socket(); const conn = upgrade(bad); let closed = false; conn.onClose(() => { closed = true; }); bad.push(frames);
		await new Promise(r => setImmediate(r)); assert.equal(closed, true); bad.destroy();
	}
});

function post(n: number): SwarmPost { return { postId: "p" + n, seq: n, taskId: "t" + n, author: "a", handle: "a", name: "A", hue: 1, channel: "test", text: "post " + n, replyTo: null, replyToHandle: null, at: n, likes: 0, replies: 0, imageSeed: null, imageAlt: null, imageUrl: null }; }
test("F14/F15: indexed pages merge shards without omissions; shard failure preserves retry", async () => {
	const h = await memory(), other = await memory();
	try {
		const sources = [new PiSpaces(h, ctx), new PiSpaces(other, ctx)];
		for (const s of sources) await initializeHistory(s);
		for (let n = 1; n <= 30; n++) {
			const s = sources[n % 2]!; const t = await s.createTransaction(30_000); const p = post(n);
			await appendHistory(s, p, t.id); await s.write({ type: "Post", fields: { ...p } }, t.id, FOREVER); await s.commit(t.id);
		}
		let cursors: string[] | undefined; const ids: string[] = [];
		for (let i = 0; i < 10; i++) { const page = await mergedHistory(sources, { cursors, beforeAt: Infinity, beforeId: "", limit: 7 }); ids.push(...page.posts.map(p => p.postId)); cursors = page.cursors; if (page.exhausted) break; }
		assert.equal(ids.length, 30); assert.equal(new Set(ids).size, 30); assert.equal(ids[0], "p30");
		const read = sources[1]!.read.bind(sources[1]); sources[1]!.read = async () => { throw new Error("shard unavailable"); };
		await assert.rejects(mergedHistory(sources, { beforeAt: Infinity, beforeId: "", limit: 7 }), /unavailable/);
		sources[1]!.read = read;
		assert.equal((await mergedHistory(sources, { beforeAt: Infinity, beforeId: "", limit: 7 })).posts[0]!.postId, "p30");
	} finally { await h.close(ctx); await other.close(ctx); }
});

test("F19: concurrent upload quota is enforced and retention reclaims generated files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "help-upload-regression-"));
	try {
		const store = new UploadStore(dir, 10, 1, 1000);
		const outcomes = await Promise.allSettled([store.put(Buffer.from("one"), ".png"), store.put(Buffer.from("two"), ".png")]);
		assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
		const name = (outcomes.find(x => x.status === "fulfilled") as PromiseFulfilledResult<string>).value;
		await utimes(join(dir, name), new Date(0), new Date(0));
		assert.equal(await store.existsFresh(name), false);
		assert.ok(await store.put(Buffer.from("new"), ".png"));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("F20: exporter and collector reject invalid ranges, duplicate and conflicting results", async () => {
	const h = await memory(), other = await memory();
	try {
		const s = new PiSpaces(h, ctx), config = { runId: "r", start: 1, end: 10, blockSize: 9 };
		const run = { runId: "r", config, members: ["a"] } as any;
		const valid = { runId: "r", taskId: "r:0", rangeStart: 1, rangeEnd: 10, primes: [2, 3, 5, 7] };
		await s.write({ type: "SieveResult", fields: { ...valid, rangeStart: 2 } }, null, FOREVER);
		await assert.rejects(SIEVE_EXPORTER(run, () => s), /mismatch/);
		await assert.rejects(collectSieveResults(s, config), /mismatch/);
		await s.take({ type: "SieveResult" }, 0); await s.write({ type: "SieveResult", fields: valid }, null, FOREVER);
		assert.equal((await SIEVE_EXPORTER({ ...run, members: ["a", "b"] }, () => s)).complete, true);
		const second = new PiSpaces(other, ctx);
		await second.write({ type: "SieveResult", fields: { ...valid, primes: [2, 3] } }, null, FOREVER);
		await assert.rejects(SIEVE_EXPORTER({ ...run, members: ["a", "b"] }, id => id === "a" ? s : second), /Conflicting/);
		await s.write({ type: "SieveResult", fields: valid }, null, FOREVER);
		await assert.rejects(SIEVE_EXPORTER(run, () => s), /Duplicate/);
	} finally { await h.close(ctx); await other.close(ctx); }
});

test("F03: recovery has no 10000-command cutoff and refuses interrupted effects", async () => {
	const h = await memory();
	const admin = new WebAdminController({ host: h, ctx, meter: new Meter(), adminPassword: "test" });
	try {
		await h.commit(async tx => {
			const d = await tx.doc(WebAdminState);
			for (let i = 0; i <= 10_000; i++) d.operations["cmd" + i] = JSON.stringify({ commandId: "cmd" + i, kind: "listRuns", args: {}, requestedBy: "test", at: i, state: "completed", result: { index: i } });
			d.operations.interrupted = JSON.stringify({ commandId: "interrupted", kind: "createEnroll", args: {}, requestedBy: "test", at: 1, state: "sending" });
		}, ctx);
		await admin.initialize();
		assert.deepEqual((await admin.executeCommand({ commandId: "cmd10000", kind: "listRuns", requestedBy: "test" })).result, { index: 10_000 });
		await assert.rejects(admin.executeCommand({ commandId: "interrupted", kind: "createEnroll", requestedBy: "test" }), /requires review/);
		const s = new PiSpaces(h, ctx, Date.now, undefined, undefined, { space: admin.controlSpaceId });
		assert.equal(await s.count({ type: "Enroll" }), 0);
	} finally { await admin.close(); await h.close(ctx); }
});

test("F09: client presence outlives its lease, reconnects, updates metadata and stops polling while connected", t => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const sent: any[] = [], sockets: ChatSocket[] = []; let polls = 0;
	const connect = (): ChatSocket => { const socket: ChatSocket = { readyState: 1, onopen: null, onclose: null, onmessage: null, onerror: null, send: raw => sent.push(JSON.parse(raw)), close() { this.readyState = 3; this.onclose?.(); } }; sockets.push(socket); return socket; };
	const options = { participant: "alice", threadId: "first", connect, snapshot: () => {}, poll: async () => { polls++; }, presenceFallback: async () => {} };
	const stop = startChatConnection(options); sockets[0]!.onopen?.();
	t.mock.timers.tick(31_000);
	assert.ok(sent.length >= 4); assert.equal(polls, 1);
	sockets[0]!.close(); t.mock.timers.tick(1500); assert.equal(sockets.length, 2);
	stop();
	const stopUpdated = startChatConnection({ ...options, participant: "bob", threadId: "second" }); sockets.at(-1)!.onopen?.();
	assert.equal(sent.at(-1).participantId, "bob"); assert.equal(sent.at(-1).activeThreadId, "second");
	stopUpdated(); const count = sent.length; t.mock.timers.tick(60_000); assert.equal(sent.length, count);
});

test("F18: article loader ignores stale completions and reports 404/network errors", async () => {
	const pending = new Map<string, (r: Response) => void>();
	const fetcher = ((url: string) => new Promise<Response>(resolve => pending.set(url, resolve))) as typeof fetch;
	const contents: string[] = [], errors: unknown[] = [];
	const callbacks = { content: (text: string) => { contents.push(text); }, error: (e: unknown) => { errors.push(e); }, done: () => {} };
	const cancel = startArticleLoad("A", callbacks, fetcher); cancel();
	startArticleLoad("B", callbacks, fetcher); pending.get("B")!(new Response("B"));
	await new Promise(r => setImmediate(r)); pending.get("A")!(new Response("A")); await new Promise(r => setImmediate(r));
	assert.deepEqual(contents, ["B"]);
	startArticleLoad("404", callbacks, async () => new Response("missing", { status: 404 }));
	startArticleLoad("network", callbacks, async () => { throw new Error("network down"); });
	await new Promise(r => setImmediate(r)); assert.equal(errors.length, 2);
});

test("F11: slow reply generation is aborted and the task completes with bounded fallback", async () => {
	const h = await memory();
	try {
		const s = new PiSpaces(h, ctx), engine = new SpaceChatEngine(s); let aborted = false;
		await engine.installProfilesIfSupported(); await engine.createThread({ threadId: "t", title: "T", createdBy: "a", requestId: "t" });
		engine.setReplyGenerator(({ signal }) => new Promise((_, reject) => { signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); }));
		await engine.submitMessage({ threadId: "t", author: "a", text: "slow reply", requestId: "slow" });
		assert.ok(await engine.processNextChatTask({ replyTimeoutMs: 20 })); assert.equal(aborted, true); assert.equal(await s.count({ type: "ChatTask" }), 0);
	} finally { await h.close(ctx); }
});

test("F16: failed post batches release reservations; failed follow-up intents retry atomically", async () => {
	const h = await memory(), hub = new SocialSwarmHub(h, ctx, new Meter(), { produce: false, pulses: false, seedContent: false });
	try {
		await hub.init();
		const s = hub.space, commit = h.commit.bind(h);
		let failPost = true, failEffect = true;
		h.commit = (fn, context) => commit(async tx => {
			const result = await fn(tx);
			const state = await spaceDoc(tx, hub.spaceId, Date.now());
			if (state.entries.some(e => e.type === "Post" && e.fields.taskId === "question")) {
				if (failPost) { failPost = false; assert.equal(hub.snapshot().posts.length, 0); throw new Error("injected Post failure"); }
				if (failEffect && state.entries.some(e => e.type === "SwarmTask" && String(e.fields.taskId).startsWith("answer-"))) { failEffect = false; throw new Error("injected follow-up failure"); }
			}
			return result;
		}, context);
		await s.write({ type: "SwarmTask", fields: { taskId: "question", kind: "post", agentId: "agent-you", channel: "pi-spaces", replyTo: null, userText: "How does this work?", createdAt: Date.now() } }, null, FOREVER);
		await until(async () => {
			const question = await s.read({ type: "Post", fields: { taskId: "question" } }, 0);
			return !failEffect && !!question && await s.count({ type: "Post", fields: { replyTo: question.fields.postId } }) > 0 && await s.count({ type: "PostEffect" }) === 0;
		}, 10_000);
		assert.equal(failPost, false);
		assert.equal(await s.count({ type: "Post", fields: { taskId: "question" } }), 1);
		assert.equal(await s.count({ type: "PostEffect" }), 0);
		assert.equal(await s.count({ type: "PostHistoryNode" }), await s.count({ type: "Post" }));
	} finally { await hub.close(); await h.close(ctx); }
});

test("F15: interrupted history migration resumes across bounded commits without duplicated nodes", async () => {
	const h = await memory();
	try {
		const s = new PiSpaces(h, ctx);
		for (let n = 1; n <= 40; n++) await s.write({ type: "Post", fields: { ...post(n), text: "x".repeat(5_000) } }, null, FOREVER);
		const commit = s.commit.bind(s); let count = 0;
		s.commit = async (...args) => {
			if (++count === 2) {
				await assert.rejects(mergedHistory([s], { beforeAt: Infinity, beforeId: "", limit: 10 }), /incomplete/);
				throw new Error("migration interrupted");
			}
			return commit(...args);
		};
		// The current migration retries transient commit contention internally.
		await initializeHistory(s);
		assert.ok(count > 2);
		s.commit = commit;
		await initializeHistory(s);
		assert.equal(await s.count({ type: "PostHistoryNode" }), 40);
		const page = await mergedHistory([s], { beforeAt: Infinity, beforeId: "", limit: 40 });
		assert.equal(page.posts[0]!.postId, "p40"); assert.equal(page.exhausted, true);
	} finally { await h.close(ctx); }
});

test("F17: outgoing backpressure and malformed handshakes are bounded", async () => {
	const socket = new Socket(); const ws = upgrade(socket);
	Object.defineProperty(socket, "writableLength", { get: () => 2_097_152 });
	ws.send("slow client"); assert.equal(socket.destroyed, true);
	const invalid = new Socket();
	assert.equal(upgradeWebSocket({ method: "GET", headers: { "sec-websocket-version": "12" } } as IncomingMessage, invalid, Buffer.alloc(0)), null);
	assert.equal(invalid.destroyed, true);
});

test("F19: session creation quota is enforced before allocating another space", async () => {
	const h = await memory(), hub = new SpaceChatHub(h, ctx, new Meter());
	try {
		await Promise.all(Array.from({ length: 64 }, (_, n) => hub.ensureSession("quota-" + n, { seed: false })));
		await assert.rejects(hub.ensureSession("excess", { seed: false }), /quota/);
		assert.equal((await hub.ensureSession("quota-0")).sessionId, "quota-0");
	} finally { await hub.close(); await h.close(ctx); }
});
