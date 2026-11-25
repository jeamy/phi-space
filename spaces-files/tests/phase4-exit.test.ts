// Phase 4 exit evidence (docs/zanzibar-agent-filesystem-plan.en.md, section 7): the opening user journey of section 1
// through both adapters, with two browser clients (Lea and the tenant administrator) and a scripted agent on its
// host's socket. Automatic private homes, the stale save, the revoked group membership, the workspace leaving the list,
// `notFound` inside it, the editor's draft kept, and two conversations of one host as two isolated actors. The reads
// and saves around the revocation run once before it and once after its acknowledgement (the concurrency gate).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesAgentClient, filesTools } from "../client/agent-client.ts";
import { afterSave, edit, openDraft } from "../client/draft.ts";
import { serveAgentSocket } from "../server/agent-socket.ts";
import { FilesService } from "../server/service.ts";
import { webStack } from "./support/browser.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const text = (v: { contents: string }) => Buffer.from(v.contents, "base64").toString("utf8");

test("the opening journey through the browser and the agent socket", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-exit4-"));
	const svc = await FilesService.open({ dataDir: join(dir, "data"), stateDir: join(dir, "state"), blobDir: join(dir, "blobs") });
	const web = await webStack(svc);
	const sock = join(dir, "host-1.sock");
	const agents = await serveAgentSocket(svc, { path: sock, hostPeerId: "host-1", tenantId: "acme" });
	const planner = new FilesAgentClient({ path: sock, agent: "planner-17" });
	const convA = new FilesAgentClient({ path: sock, agent: "conversation-a" });
	const convB = new FilesAgentClient({ path: sock, agent: "conversation-b" });
	try {
		await svc.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: web.idp.issuer, subject: "adm" });
		const adm = web.browser(), lea = web.browser();
		await adm.signIn(web.idp, "adm");
		const reg = async (args: Record<string, unknown>) => adm.must("registerActor", { ...args, operationId: await adm.opId() });
		await reg({ kind: "user", actorId: "lea", homeName: "lea", identity: { issuer: web.idp.issuer, subject: "lea" } });
		for (const a of ["planner-17", "conversation-a", "conversation-b"])
			await reg({ kind: "agent", actorId: a, homeName: a, identity: { enrolledHostPeerId: "host-1", agentId: a } });
		await adm.must("createWorkspace", { name: "dispatch", owner: { kind: "user", id: "adm" }, operationId: await adm.opId() });
		await adm.must("grant", { workspace: "dispatch", path: ".", relation: "editor", subject: { kind: "group", id: "north", relation: "member" }, operationId: await adm.opId() });
		for (const who of [{ kind: "user", id: "lea" }, { kind: "agent", id: "planner-17" }])
			await adm.must("addMember", { group: "north", subject: who, operationId: await adm.opId() });

		// automatic private homes, and the shared workspace through North
		await lea.signIn(web.idp, "lea");
		assert.deepEqual(await lea.must("workspaces"), ["dispatch", "lea"]);
		assert.deepEqual(await planner.workspaces(), ["dispatch", "planner-17"]);

		// the agent writes brief.md up to version 3; both read version 3
		const tools = Object.fromEntries(filesTools(planner).map((t) => [t.name, t]));
		let v = 0;
		for (const t of ["draft 1", "draft 2", "draft 3"]) v = ((await tools.fs_write.execute({ workspace: "dispatch", path: "brief.md", text: t, expectedVersion: v })) as { version: number }).version;
		assert.equal(v, 3);
		const agentRead = await tools.fs_read.execute({ workspace: "dispatch", path: "brief.md" }) as { text: string; version: number };
		const leaRead = await lea.must("read", { workspace: "dispatch", path: "brief.md" });
		assert.deepEqual([agentRead.version, leaRead.version], [3, 3]);

		// Lea saves version 4; the agent's save over version 3 is a conflict that names version 4
		const leaEdit = "draft 3, with Lea's changes";
		assert.deepEqual(await lea.must("write", { workspace: "dispatch", path: "brief.md", contents: b64(leaEdit), expectedVersion: 3, operationId: await lea.opId() }), { version: 4 });
		const stale = await tools.fs_write.execute({ workspace: "dispatch", path: "brief.md", text: "the agent's edit", expectedVersion: 3 }) as Record<string, unknown>;
		assert.deepEqual([stale.error, stale.currentVersion], ["versionConflict", 4]);
		assert.deepEqual(await tools.fs_read.execute({ workspace: "dispatch", path: "brief.md" }), { text: leaEdit, version: 4 }, "the agent reads Lea's changes before it edits");

		// Lea's editor stays open on version 4 with a new draft; before the revocation her reads and lists work
		let draft = edit(openDraft("dispatch", "brief.md", leaEdit, 4), "Lea's second edit");
		assert.equal((await lea.must("read", { workspace: "dispatch", path: "brief.md" })).version, 4);
		assert.deepEqual(await lea.must("list", { workspace: "dispatch", path: "." }), [{ name: "brief.md", kind: "file" }]);

		// the administrator removes Lea from North, her only access to dispatch; the acknowledgement comes back
		assert.deepEqual(await adm.must("removeMember", { group: "north", subject: { kind: "user", id: "lea" }, operationId: await adm.opId() }), { status: "removed" });

		// after it: dispatch has left her list, everything inside answers like an absent path, her save fails, her draft stays
		assert.deepEqual(await lea.must("workspaces"), ["lea"]);
		const absent = (await lea.call("list", { workspace: "no-such-workspace", path: "." })).json!.error;
		for (const [op, args] of [["list", { path: "." }], ["read", { path: "brief.md" }], ["read", { path: "missing.md" }], ["listGrants", { path: "." }]] as const) {
			const r = (await lea.call(op, { workspace: "dispatch", ...args })).json!.error;
			assert.deepEqual(r, absent, `${op} ${args.path}`);
		}
		const save = await lea.call("write", { workspace: "dispatch", path: "brief.md", contents: b64(draft.text), expectedVersion: 4, operationId: await lea.opId() });
		assert.equal(save.json!.error!.code, "notFound");
		assert.equal(save.json!.error!.currentVersion, undefined, "nothing about the file is disclosed");
		draft = afterSave(draft, { error: save.json!.error!.code });
		assert.equal(draft.text, "Lea's second edit", "the draft is kept");
		const now = await planner.read("dispatch", "brief.md");
		assert.deepEqual([now.version, now.bytes.toString()], [4, leaEdit], "the file stays at version 4");
		assert.equal(text(await adm.must("read", { workspace: "dispatch", path: "brief.md" })), leaEdit);
		assert.deepEqual(await lea.must("list", { workspace: "lea", path: "." }), [], "her home is untouched");

		// two conversations of one host: two actors, two private homes, each invisible to the other
		assert.deepEqual(await convA.workspaces(), ["conversation-a"]);
		assert.deepEqual(await convB.workspaces(), ["conversation-b"]);
		await convA.write("conversation-a", "mine.md", Buffer.from("a"), 0);
		await assert.rejects(convB.read("conversation-a", "mine.md"), (e: Error & { code?: string }) => e.code === "notFound");
		await assert.rejects(convA.read("dispatch", "brief.md"), (e: Error & { code?: string }) => e.code === "notFound");
	} finally {
		for (const c of [planner, convA, convB]) c.close();
		await agents.close();
		await web.close();
		await svc.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
