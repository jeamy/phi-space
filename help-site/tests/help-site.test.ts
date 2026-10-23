// Comprehensive test suite for PHI-SPACES / HELP, the 6 Multiplayer Space-Chat stages (v1..v6),
// the RFC-6455 WebSocket gateway, and the login-protected AdminSpaces portal.
import "./test-env.ts";

import test from "node:test";
import assert from "node:assert/strict";
import { buildHelpSite } from "../scripts/build-web.ts";
import { renderMarkdownToHtml } from "../client/lib/markdown.ts";
import { searchAreas, searchArticles } from "../client/lib/search.ts";
import { runStageV1 } from "../examples/v1-local-memory/run.ts";
import { runStageV2 } from "../examples/v2-local-durable/run.ts";
import { runStageV3 } from "../examples/v3-remote-socket/run.ts";
import { runStageV4 } from "../examples/v4-gated-auth/run.ts";
import { runStageV5 } from "../examples/v5-federated-cluster/run.ts";
import { runStageV6 } from "../examples/v6-mobile-control/run.ts";
import { startHelpServer } from "../server/index.ts";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { Meter, startService, SpaceService, StaticIdentity, serveSpace, RemoteSpace, socketTransport, openOwnMemoryHost } from "../../src/index.ts";
import { SocialSwarmHub, SWARM_ALIAS } from "../server/social/swarm.ts";
import { ALL_ARTICLES } from "../scripts/corpus.ts";

test("1. Help Corpus, Markdown {#anchor} rendering & token-aware search", async () => {
	await buildHelpSite();
	const { readFile } = await import("node:fs/promises");
	const standalone = await readFile(new URL("../dist/public/assets/app.js", import.meta.url), "utf8");
	assert.match(standalone, /createRoot/);
	assert.match(standalone, /getElementById\("app"\)/, "standalone bundle must actually mount the Help app");
	const html = renderMarkdownToHtml("## Überblick {#overview}\n\nEin Absatz mit `code`.");
	assert.ok(html.includes('<h2 id="overview">Überblick</h2>'), "explicit {#anchor} becomes DOM id and is stripped from visible text");
	assert.ok(!html.includes("{#overview}"), "raw {#anchor} marker is never visible");

	const srv = await startHelpServer({ port: 0 });
	try {
		const res = await fetch(`${srv.url}/help/index.json`);
		assert.equal(res.status, 200);
		const index = await res.json();
		assert.equal(index.schema, "phi-spaces-help-site-index-v1");
		assert.equal(index.areas.length, 9);
		assert.equal(index.stats.uniqueArticles, ALL_ARTICLES.length);
		assert.equal(index.stats.localizedRecords, ALL_ARTICLES.length * 2);

		const deArticles = index.articles.filter((a: any) => a.locale === "de");
		const gidHits = searchArticles(deArticles, "gid");
		assert.ok(gidHits.length >= 1, "short token search 'gid' finds matching articles");
		const hrwHits = searchAreas(index.areas, "hrw", "de");
		assert.equal(hrwHits.length, 1);
		assert.equal(hrwHits[0].id, "federation_router_membership");
	} finally {
		await srv.close();
	}
});

test("2. Evolutionary Stages v1 through v6 execute and verify all phi-spaces invariants", async () => {
	const v1 = await runStageV1();
	assert.equal(v1.idempotentThreadMatch, true);
	assert.equal(v1.aliceLeaseRenewed, true);
	assert.equal(v1.snapshot.threads.length, 2);
	assert.equal(v1.physicalMsgCount, 4, "O(1) pointer fork writes zero physical Msg copies into the Space");
	assert.equal(v1.snapshot.messages.length, 6, "inspectSnapshot dynamically resolves the 2 inherited + 4 own messages");

	const v2 = await runStageV2();
	assert.deepEqual(v2.triggeredJobs, ["alarm-backup-check"]);
	assert.ok(v2.alarmReplyText?.includes("Geplanter Space-Alarm ausgelöst"));
	assert.equal(v2.subagentRuns.length, 1);
	assert.ok(v2.subagentRuns[0]!.answer?.includes("PostgreSQL"), "search_history subagent found PostgreSQL from thread-1");
	assert.deepEqual(v2.subagentRuns[0]!.citedThreadIds, ["thread-1"]);

	const v3 = await runStageV3();
	assert.ok(v3.mailboxEventsReceived >= 1);
	assert.equal(v3.ackedUpTo, 1);
	assert.ok(v3.subagentRun?.answer?.includes("PostgreSQL"));

	const v4 = await runStageV4();
	assert.equal(v4.oldKeyState, "revoked");
	assert.equal(v4.newKeyState, "active");
	assert.equal(v4.snapshot.messages.length, 4);

	const v5 = await runStageV5();
	assert.equal(v5.totalClusterMessages, 4);
	assert.equal(v5.completeClusterRead, true);
	assert.equal(v5.replicatedPresenceCount, 1);
	assert.equal(v5.snapshot.threads.length, 4);

	const v6 = await runStageV6();
	assert.ok(v6.mobileQrPayload.includes('"v":1'));
	assert.equal(v6.archivedState, "archived");
	assert.equal(v6.reactivatedState, "active");
	assert.deepEqual(v6.runStates, { started: "running", paused: "paused", resumed: "running" });
	assert.equal(v6.chatSnapshot.messages.length, 2);
});

test("3. HTTP Server, Live Multiplayer Space-Chat API & Login-Protected AdminSpaces Portal", async () => {
	const srv = await startHelpServer({ port: 0, adminPassword: "test-secret-password" });
	try {
		// Static UI & Assets
		const homeRes = await fetch(`${srv.url}/`);
		assert.equal(homeRes.status, 200);
		const homeHtml = await homeRes.text();
		assert.ok(homeHtml.includes("PHI-SPACES / HELP"));

		const jsRes = await fetch(`${srv.url}/assets/app.js`);
		assert.equal(jsRes.status, 200);

		// Public Multiplayer Space-Chat REST API
		const chatRes = await fetch(`${srv.url}/api/chat/sessions/demo-room/action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "message.submit",
				threadId: "thread-ops",
				author: "bob",
				text: "Was haben wir bezüglich des Event-Stores entschieden?",
				requestId: "test-subagent-q1",
			}),
		});
		assert.equal(chatRes.status, 200);
		const chatData = await chatRes.json();
		assert.equal(chatData.ok, true);
		assert.equal(chatData.snapshot.subagentRuns.length, 1);
		assert.ok(chatData.snapshot.subagentRuns[0].answer.includes("PostgreSQL"));

		// Running a stage demo mirrors the real stage entries into `chat-session-stage-<stage>`
		const stageRunRes = await fetch(`${srv.url}/api/chat/stages/v5/run`, { method: "POST" });
		assert.equal(stageRunRes.status, 200);
		const stageSnapRes = await fetch(`${srv.url}/api/chat/sessions/stage-v5`);
		assert.equal(stageSnapRes.status, 200);
		const stageSnapData = await stageSnapRes.json();
		assert.equal(stageSnapData.snapshot.threads.length, 4, "stage-v5 mirror contains the 4 real HRW threads");

		// Unauthenticated AdminSpaces access is rejected with 401
		const unauthRes = await fetch(`${srv.url}/api/admin/overview`);
		assert.equal(unauthRes.status, 401);
		assert.equal((await fetch(`${srv.url}/api/llm/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: true }) })).status, 401);
		assert.equal((await fetch(`${srv.url}/api/chat/sessions/demo-room/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "unknown" }) })).status, 400);

		// Login to AdminSpaces
		const loginRes = await fetch(`${srv.url}/api/admin/login`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				username: "admin@spaces.eibrain.org",
				password: "test-secret-password",
			}),
		});
		assert.equal(loginRes.status, 200);
		const setCookie = loginRes.headers.get("set-cookie") ?? "";
		const cookiePair = setCookie.split(";")[0]!;
		const loginData = await loginRes.json();
		const csrfToken = loginData.session.csrfToken as string;
		assert.ok(cookiePair.startsWith("phi_spaces_admin_sid="));
		assert.ok(csrfToken.length >= 16);
		assert.equal((await fetch(`${srv.url}/api/llm/model`, { method: "POST", headers: { "content-type": "application/json", cookie: cookiePair }, body: JSON.stringify({ on: true }) })).status, 403);

		// Missing CSRF token on POST is rejected with 403
		const noCsrfRes = await fetch(`${srv.url}/api/admin/command`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: cookiePair,
			},
			body: JSON.stringify({ kind: "listAlerts", args: {} }),
		});
		assert.equal(noCsrfRes.status, 403);

		// Authenticated AdminSpaces commands with idempotent commandId
		const cmdId = "w-createSpace-test-room-99";
		const createRes1 = await fetch(`${srv.url}/api/admin/command`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: cookiePair,
				"x-csrf-token": csrfToken,
			},
			body: JSON.stringify({
				commandId: cmdId,
				kind: "createSpace",
				args: { alias: "admin-created-space" },
			}),
		});
		assert.equal(createRes1.status, 200);
		const c1 = await createRes1.json();
		assert.equal(c1.operation.state, "completed");

		// Retrying with the exact same commandId returns the stored result idempotently
		const createRes2 = await fetch(`${srv.url}/api/admin/command`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: cookiePair,
				"x-csrf-token": csrfToken,
			},
			body: JSON.stringify({
				commandId: cmdId,
				kind: "createSpace",
				args: { alias: "admin-created-space" },
			}),
		});
		assert.equal(createRes2.status, 200);
		const c2 = await createRes2.json();
		assert.equal(c2.result.spaceId, c1.result.spaceId);

		// Generate Mobile Enrollment QR via AdminSpaces
		const enrollRes = await fetch(`${srv.url}/api/admin/command`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: cookiePair,
				"x-csrf-token": csrfToken,
			},
			body: JSON.stringify({
				kind: "createEnroll",
				args: { peerId: "phone-test", endpoint: "tcp://100.64.0.10:9440" },
			}),
		});
		assert.equal(enrollRes.status, 200);
		const enrollData = await enrollRes.json();
		assert.ok(enrollData.result.qrPayload.includes('"v":1'));
		assert.equal((await fetch(`${srv.url}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enrollToken: enrollData.result.token }) })).status, 401);

		// Declarative Bootstrap / Deployment Config (planDeployment, applyDeployment, startWorkers, exportDeployment)
		const depConfig = {
			schemaVersion: 1,
			deployment: "chat-cluster-demo",
			configRevision: 1,
			coordinator: "host-a",
			hosts: [{ alias: "host-a", role: "coordinator" }],
			spaces: [
				{ alias: "control", host: "host-a", purpose: "control" },
				{ alias: "chat-prod-room", host: "host-a", purpose: "data", maxSpaceBytes: 67108864 },
			],
			workers: [
				{
					alias: "chat-worker-main",
					host: "host-a",
					kind: "chat-worker",
					targetSpace: "chat-prod-room",
					count: 1,
				},
			],
		};
		const planRes = await fetch(`${srv.url}/api/admin/command`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: cookiePair, "x-csrf-token": csrfToken },
			body: JSON.stringify({ kind: "planDeployment", args: { config: depConfig } }),
		});
		assert.equal(planRes.status, 200);
		const planData = await planRes.json();
		assert.equal(planData.result.ready, true);

		const applyRes = await fetch(`${srv.url}/api/admin/command`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: cookiePair, "x-csrf-token": csrfToken },
			body: JSON.stringify({ kind: "applyDeployment", args: { config: depConfig } }),
		});
		assert.equal(applyRes.status, 200);
		const applyData = await applyRes.json();
		assert.equal(applyData.result.state, "completed");

		const exportRes = await fetch(`${srv.url}/api/admin/command`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: cookiePair, "x-csrf-token": csrfToken },
			body: JSON.stringify({ kind: "exportDeployment", args: { deployment: "chat-cluster-demo" } }),
		});
		assert.equal(exportRes.status, 200);
	} finally {
		await srv.close();
	}
});

test("4. Next.js 16 Production Server (useNext: true) serves SSR App Router & Help Corpus", { skip: process.env.PHI_SPACES_TEST_NEXT !== "1" }, async () => {
	const srv = await startHelpServer({ port: 0, useNext: true, dev: false });
	try {
		const res = await fetch(`${srv.url}/`);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.ok(html.includes("PHI-SPACES"), "Next.js 16 SSR HTML contains PHI-SPACES");
		assert.ok(html.includes("_next/static"), "Next.js 16 SSR HTML references _next/static chunks");

		const indexRes = await fetch(`${srv.url}/help/index.json`);
		assert.equal(indexRes.status, 200);
	} finally {
		await srv.close();
	}
});

test("5. Multi-Shard Social Swarm distribution (big + nano): attachRemoteShard, delta merge, thread routing & fault tolerance", async () => {
	// 1. Shard B (nano): own host in memory, running headless SocialSwarmHub with shardTag "b-"
	const harnessB = openOwnMemoryHost();
	const stopServiceB = await startService(harnessB, ctx, { watchDebounceMs: 20 });
	const meterB = new Meter();
	const hubB = new SocialSwarmHub(harnessB, ctx, meterB, {
		shardTag: "b-",
		produce: false,
		pulses: false,
		seedContent: false,
	});
	await hubB.init();

	// Expose Shard B over TCP on ephemeral port
	const identity = new StaticIdentity({
		"peer-hub": { principal: { peerId: "peer-hub" }, roles: ["member"] },
	});
	const serverB = await serveSpace(new SpaceService({ host: harnessB, ctx, identity }), {
		listen: { host: "127.0.0.1", port: 0 },
		connection: () => ({ peerId: "peer-hub" }),
	});
	const addrB = serverB.address() as AddressInfo;
	const transportB = socketTransport({ host: "127.0.0.1", port: addrB.port });
	const remoteSpace = new RemoteSpace(transportB, { space: SWARM_ALIAS });

	// 2. Hub A (big): own host in memory, attach remote shard B
	const harnessA = openOwnMemoryHost();
	const stopServiceA = await startService(harnessA, ctx, { watchDebounceMs: 20 });
	const meterA = new Meter();
	const hubA = new SocialSwarmHub(harnessA, ctx, meterA, {
		shardTag: "",
		produce: false,
		pulses: false,
		seedContent: false,
	});
	hubA.attachRemoteShard(remoteSpace, "b-");
	await hubA.init();

	try {
		// a. Verify initial 2-shard discovery
		const initialStats = await hubA.stats();
		assert.equal(initialStats.shards, 2, "hub detects 2 configured shards");
		assert.equal(initialStats.shardsUp, 2, "both shards are healthy and reachable");

		// Register a fake WebSocket connection to Hub A so the live broadcast loop is active
		const received: any[] = [];
		let clientHandler!: (data: string) => void | Promise<void>;
		const fakeWs = {
			id: "ws-test-1",
			send: (payload: unknown) => {
				const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
				received.push(parsed);
			},
			onMessage: (fn: (data: string) => void | Promise<void>) => {
				clientHandler = fn;
			},
			onClose: (_fn: () => void) => {},
			close: () => {},
		};
		await hubA.attachWebSocket(fakeWs as any);
		assert.ok(typeof clientHandler === "function", "client registered message handler");

		// b. Create a task directly on Shard B
		const taskIdB = "task-b-1";
		await remoteSpace.write(
			{ type: "SwarmTask", fields: { taskId: taskIdB, kind: "post", agentId: "agent-test-b", channel: "random", createdAt: Date.now() } },
			null,
			60_000,
		);

		// Wait for Shard B's worker to process the task and write the post
		let postB: any = null;
		for (let i = 0; i < 50; i++) {
			const posts = await remoteSpace.readAll({ type: "Post" });
			if (posts.length > 0) {
				postB = posts[0]!.fields;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(postB, "Shard B worker processed task and produced post");
		assert.ok(String(postB.postId).startsWith("b-post-"), `Post ID carries Shard B tag 'b-': ${postB.postId}`);

		// c. Test delta sync to Hub A: wait for delta loop to merge Shard B post into Hub A snapshot
		for (let i = 0; i < 50; i++) {
			const snap = hubA.snapshot();
			if (snap.posts.some((p) => p.postId === postB.postId)) {
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		const snapA = hubA.snapshot();
		assert.ok(snapA.posts.some((p) => p.postId === postB.postId), "Hub A merged remote Shard B post into its feed");

		// d. Test Thread Co-locality / Reply routing
		// Submit a reply to postB (which lives on Shard B)
		await clientHandler(JSON.stringify({
			type: "post.submit",
			author: "alice",
			text: "replying to shard b post!",
			replyTo: postB.postId,
			channel: "random",
		}));

		// The reply should be routed to Shard B and committed with prefix "b-"
		let replyPost: any = null;
		for (let i = 0; i < 50; i++) {
			const posts = await remoteSpace.readAll({ type: "Post", fields: { replyTo: postB.postId } });
			if (posts.length > 0) {
				replyPost = posts[0]!.fields;
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(replyPost, "Reply task was routed to Shard B and produced child post");
		assert.ok(String(replyPost.postId).startsWith("b-post-"), `Reply post ID also lives on Shard B: ${replyPost.postId}`);
		assert.equal(replyPost.replyTo, postB.postId);

		// Fetch thread for postB
		await clientHandler(JSON.stringify({
			type: "thread.fetch",
			postId: postB.postId,
		}));
		const threadMsg = received.find((m) => m.type === "thread" && m.postId === postB.postId);
		assert.ok(threadMsg, "thread.fetch returned thread from Shard B");
		assert.equal(threadMsg.posts.length, 2, "thread contains root post and reply");

		// e. Test Fault Tolerance: shut down Shard B server
		await serverB.close();

		// Hub stats should degrade cleanly
		const degradedStats = await hubA.stats();
		assert.equal(degradedStats.shards, 2);
		assert.equal(degradedStats.shardsUp, 1, "hub detects Shard B is down, reports shardsUp: 1");

		// New post submit while Shard B is down falls back to Shard A cleanly
		await clientHandler(JSON.stringify({
			type: "post.submit",
			author: "alice",
			text: "new post during shard b outage",
			channel: "random",
		}));

		// The task should have committed to local space (Shard A)
		const localTasks = await hubA.space.readAll({ type: "SwarmTask" });
		assert.ok(localTasks.length >= 1, "post was successfully queued on local Shard A during remote outage");
	} finally {
		await hubA.close();
		transportB.close();
		await hubB.close();
		await serverB.close().catch(() => {});
		await stopServiceA().catch(() => {});
		await stopServiceB().catch(() => {});
		await harnessA.close(ctx);
		await harnessB.close(ctx);
	}
});

