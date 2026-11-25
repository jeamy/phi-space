// The agent adapter (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 5, phase 4): one socket per host peer
// and tenant, the frame rule of the agent-host contract, an actor per agent with its own private home, sessions kept
// and renewed by the adapter, the relative-path tools, and a retried mutation answered from its receipt.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketTransport } from "phi-spaces";
import { FilesAgentClient, FilesError, filesTools } from "../client/agent-client.ts";
import { serveAgentSocket } from "../server/agent-socket.ts";
import { FilesService } from "../server/service.ts";

const ADM = { actorKind: "user" as const, actorId: "adm" };
const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-agent-"));
	const clock = { t: Date.now() };
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, now: () => clock.t });
	for (const t of ["acme", "globex"]) await svc.createTenant(t, { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
	for (const [agent, home] of [["conversation-a", "conv-a"], ["conversation-b", "conv-b"]])
		await svc.provisionActor("acme", ADM, "agent", agent, home, { enrolledHostPeerId: "host-1", agentId: agent });
	await svc.provisionActor("acme", ADM, "agent", "other-host", "other-host", { enrolledHostPeerId: "host-2", agentId: "other-host" });
	await svc.provisionActor("globex", ADM, "agent", "conversation-g", "conv-g", { enrolledHostPeerId: "host-1", agentId: "conversation-g" });
	const path = join(dir, "acme.sock");
	const server = await serveAgentSocket(svc, { path, hostPeerId: "host-1", tenantId: "acme" });
	const clients: FilesAgentClient[] = [];
	const client = (agent: string) => { const c = new FilesAgentClient({ path, agent, retries: 0 }); clients.push(c); return c; };
	const done = async () => { for (const c of clients) c.close(); await server.close(); await svc.close(); rmSync(dir, { recursive: true, force: true }); };
	return { svc, dir, path, clock, client, done };
}

test("two conversations of one host: two actors, two private homes, each invisible to the other", async () => {
	const { client, done } = await setup();
	try {
		const a = client("conversation-a"), b = client("conversation-b");
		assert.deepEqual(await a.workspaces(), ["conv-a"]);
		assert.deepEqual(await b.workspaces(), ["conv-b"]);
		assert.deepEqual(await a.write("conv-a", "notes.md", Buffer.from("mine"), 0), { version: 1 });
		await assert.rejects(b.read("conv-a", "notes.md"), code("notFound"));
		await assert.rejects(b.list("conv-a", "."), code("notFound"));
		await assert.rejects(b.write("conv-a", "x.md", Buffer.from("x"), 0), code("notFound"));
		assert.equal((await a.read("conv-a", "notes.md")).bytes.toString(), "mine");
	} finally { await done(); }
});

test("the frame rule: no agent acts for nobody, a malformed one is refused, the socket fixes host peer and tenant", async () => {
	const { path, client, done } = await setup();
	const raw = socketTransport({ path });
	try {
		const send = async (msg: unknown) => JSON.parse(await raw.request(typeof msg === "string" ? msg : JSON.stringify(msg)));
		assert.equal((await send({ op: "workspaces" })).error.code, "unauthenticated", "the host peer is no actor");
		assert.equal((await send({ op: "workspaces", frame: {} })).error.code, "unauthenticated");
		for (const agent of ["", "a b", "x".repeat(129), 7, "ä"]) assert.equal((await send({ op: "workspaces", frame: { agent } })).error.code, "invalidInput", String(agent));
		assert.equal((await send("not json")).error.code, "invalidInput");
		assert.equal((await send([1])).error.code, "invalidInput");
		assert.equal((await send({ op: "nope", frame: { agent: "conversation-a" } })).error.code, "invalidInput");
		assert.equal((await send({ op: "createWorkspace", frame: { agent: "conversation-a" } })).error.code, "invalidInput", "no admin operations on the agent socket");
		assert.equal((await send({ op: "list", args: [1], frame: { agent: "conversation-a" } })).error.code, "invalidInput");
		await assert.rejects(client("unknown-agent").workspaces(), code("unauthenticated"));
		await assert.rejects(client("other-host").workspaces(), code("unauthenticated"), "an agent of another host peer");
		await assert.rejects(client("conversation-g").workspaces(), code("unauthenticated"), "an agent of another tenant");
	} finally { raw.close(); await done(); }
});

test("the tools: relative paths, a version conflict with the current version, binary files, refusals as results", async () => {
	const { client, done } = await setup();
	try {
		const a = client("conversation-a");
		const tools = Object.fromEntries(filesTools(a).map((t) => [t.name, t]));
		assert.deepEqual(await tools.fs_workspaces.execute({}), { workspaces: ["conv-a"] });
		assert.deepEqual(await tools.fs_mkdir.execute({ workspace: "conv-a", path: "drafts" }), { status: "created" });
		assert.deepEqual(await tools.fs_write.execute({ workspace: "conv-a", path: "drafts/brief.md", text: "eins", expectedVersion: 0 }), { version: 1 });
		assert.deepEqual(await tools.fs_write.execute({ workspace: "conv-a", path: "drafts/brief.md", text: "zwei", expectedVersion: 1 }), { version: 2 });
		const stale = await tools.fs_write.execute({ workspace: "conv-a", path: "drafts/brief.md", text: "drei", expectedVersion: 1 }) as Record<string, unknown>;
		assert.equal(stale.error, "versionConflict");
		assert.equal(stale.currentVersion, 2);
		assert.deepEqual(await tools.fs_read.execute({ workspace: "conv-a", path: "drafts/brief.md" }), { text: "zwei", version: 2 });
		assert.deepEqual(await tools.fs_list.execute({ workspace: "conv-a", path: "." }), { entries: [{ name: "drafts", kind: "dir" }] });
		await a.write("conv-a", "blob.bin", Buffer.from([0xff, 0xfe, 0x00]), 0);
		assert.deepEqual(await tools.fs_read.execute({ workspace: "conv-a", path: "blob.bin" }), { binary: true, size: 3, version: 1 });
		assert.equal((await tools.fs_read.execute({ workspace: "conv-a", path: "/etc/passwd" }) as { error: string }).error, "invalidInput");
		assert.equal((await tools.fs_read.execute({ workspace: "conv-b", path: "x" }) as { error: string }).error, "notFound");
	} finally { await done(); }
});

test("a mutation sent twice with its operation ID applies once; contents must be canonical base64", async () => {
	const { path, client, done } = await setup();
	const raw = socketTransport({ path });
	try {
		const a = client("conversation-a");
		const id = await a.operationId();
		assert.deepEqual(await a.write("conv-a", "f.txt", Buffer.from("x"), 0, id), { version: 1 });
		assert.deepEqual(await a.write("conv-a", "f.txt", Buffer.from("x"), 0, id), { version: 1 }, "answered from the receipt");
		await assert.rejects(a.write("conv-a", "f.txt", Buffer.from("y"), 0, id), code("requestMismatch"));
		const send = async (contents: string) => JSON.parse(await raw.request(JSON.stringify({ op: "write", frame: { agent: "conversation-a" }, args: { workspace: "conv-a", path: "g.txt", contents, expectedVersion: 0, operationId: await a.operationId() } })));
		for (const bad of ["eA", "eA= =", "e A==", "-_8=", 5 as unknown as string]) assert.equal((await send(bad)).error.code, "invalidInput", String(bad));
		assert.deepEqual((await send("eA==")).value, { version: 1 });
	} finally { raw.close(); await done(); }
});

test("sessions: renewed after expiry, but a disabled agent fails closed", async () => {
	const { svc, clock, client, done } = await setup();
	try {
		const a = client("conversation-a");
		await a.workspaces();
		clock.t += 13 * 3600_000; // past the absolute session expiry
		assert.deepEqual(await a.workspaces(), ["conv-a"], "the adapter logged in again");
		const adm = (await svc.login("acme", "user", { issuer: "i", subject: "adm" })).handle;
		await svc.disableActor(adm, { kind: "agent", id: "conversation-a" }, [{ workspace: "conv-a", owner: { kind: "user", id: "adm" } }], (await svc.issueOperationIds(adm, 1))[0]);
		await assert.rejects(a.workspaces(), (e: unknown) => e instanceof FilesError && e.code === "unauthenticated");
	} finally { await done(); }
});

test("a socket directory others can reach is refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-agent-"));
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	try {
		chmodSync(dir, 0o755);
		await assert.rejects(serveAgentSocket(svc, { path: join(dir, "s.sock"), hostPeerId: "h", tenantId: "acme" }), /reachable by others/);
		chmodSync(dir, 0o750);
		const s = await serveAgentSocket(svc, { path: join(dir, "s.sock"), hostPeerId: "h", tenantId: "acme" });
		await s.close();
	} finally { await svc.close(); rmSync(dir, { recursive: true, force: true }); }
});
