// Agent hosts on other machines (docs/zanzibar-agent-filesystem-plan.en.md, section 8, network agent hosts): a TLS
// listener where a host enrolls its key with the operator's one-time token, proves it on every connection, and acts
// for its agents only in the tenants its key names; a revocation refuses the next call, a restore revokes every host
// key, and two hosts with equal agent IDs are two actors.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashToken, newEnrollToken } from "phi-spaces";
import { FilesAgentClient } from "../client/agent-client.ts";
import { agentNetTransport, enrollHost, hostKey, type AgentNetTarget } from "../client/agent-net-client.ts";
import { newBackupKey, readBackupKey } from "../server/archive.ts";
import { backupData, restoreData } from "../server/backup.ts";
import { serveAgentNet, parseListen, type AgentNetServer } from "../server/agent-net.ts";
import { FilesService, type FilesServiceOptions } from "../server/service.ts";
import { testCert } from "./support/browser.ts";

const ADM = { actorKind: "user" as const, actorId: "adm" };
const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const refused = (e: Error) => { assert.match(e.message, /PermissionDenied|Unauthenticated/); return true; };

async function setup(o: Partial<FilesServiceOptions> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-net-"));
	const clock = { t: Date.now() };
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, now: () => clock.t, ...o });
	for (const t of ["acme", "globex"]) await svc.createTenant(t, { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
	const tls = testCert();
	let server: AgentNetServer = await serveAgentNet(svc, { host: "127.0.0.1", port: 0, ...tls });
	const closers: Array<() => void> = [];
	const target = (peerId: string, extra: Partial<AgentNetTarget> = {}): AgentNetTarget =>
		({ host: "127.0.0.1", port: server.address().port, ca: tls.cert, servername: "localhost", peerId, ...extra });
	/** The operator's side: a token bound to the peer, only its hash goes to the service. */
	const invite = async (peerId: string, tenants: string[]) => { const token = newEnrollToken(); await svc.createHostEnroll(peerId, tenants, hashToken(token)); return token; };
	/** A host: its key file, enrolled with a fresh token, and a client per agent over one transport. */
	const host = async (peerId: string, tenants: string[]) => {
		const keyFile = join(dir, `${peerId}.key`);
		const { keyId } = await enrollHost(target(peerId), await invite(peerId, tenants), hostKey(keyFile));
		clock.t += 61_000;                                            // one enrollment attempt per peer and minute
		const transport = agentNetTransport(target(peerId), hostKey(keyFile, keyId));
		closers.push(() => transport.close());
		return { keyId, keyFile, client: (agent: string, tenant: string) => new FilesAgentClient({ agent, tenant, transport, retries: 0 }) };
	};
	const done = async () => { for (const c of closers) c(); await server.close(); await svc.close(); rmSync(dir, { recursive: true, force: true }); };
	return { svc, dir, clock, target, invite, host, done, reserve: async () => { await server.close(); server = await serveAgentNet(svc, { host: "127.0.0.1", port: 0, ...tls }); } };
}

test("a host enrolls with the operator's token, proves its key, and acts for its agents", async () => {
	const d = await setup();
	try {
		await d.svc.provisionActor("acme", ADM, "agent", "conv-a", "conv-a", { enrolledHostPeerId: "host-1", agentId: "conv-a" });
		const h = await d.host("host-1", ["acme"]);
		assert.deepEqual(await d.svc.listHosts(), [{ peerId: "host-1", keyId: h.keyId, tenants: ["acme"], state: "active" }]);
		const a = h.client("conv-a", "acme");
		assert.deepEqual(await a.workspaces(), ["conv-a"]);
		assert.deepEqual(await a.write("conv-a", "notes.md", Buffer.from("over tls"), 0), { version: 1 });
		assert.equal((await a.read("conv-a", "notes.md")).bytes.toString(), "over tls");
		// an agent the tenant does not know is no actor
		await assert.rejects(h.client("stranger", "acme").workspaces(), code("unauthenticated"));
		// a frame without a tenant, or one the key does not name, is refused
		await assert.rejects(new FilesAgentClient({ agent: "conv-a", transport: agentNetTransport(d.target("host-1"), hostKey(h.keyFile, h.keyId)), retries: 0 }).workspaces(), code("unauthenticated"));
		await assert.rejects(h.client("conv-a", "globex").workspaces(), code("unauthenticated"));
	} finally { await d.done(); }
});

test("enrollment: the token is bound to its peer, used once, and a challenge for another service is not signed", async () => {
	const d = await setup();
	try {
		const token = await d.invite("host-1", ["acme"]);
		// another peer with host-1's token: refused, and the token stays for host-1
		await assert.rejects(enrollHost(d.target("host-2"), token, hostKey(join(d.dir, "h2.key"))), refused);
		await assert.rejects(enrollHost(d.target("host-1"), "not-the-token", hostKey(join(d.dir, "h1.key"))), refused);
		d.clock.t += 61_000;
		const { keyId } = await enrollHost(d.target("host-1"), token, hostKey(join(d.dir, "h1.key")));
		assert.ok(keyId);
		d.clock.t += 61_000;
		await assert.rejects(enrollHost(d.target("host-1"), token, hostKey(join(d.dir, "h1b.key"))), refused, "a token is spent");
		// the host checks the service's ID before it signs
		await assert.rejects(enrollHost(d.target("host-1", { gateHostId: "elsewhere" }), token, hostKey(join(d.dir, "h1.key"))), /names service spaces-files/);
		// without the service's CA the TLS connection does not even open
		await assert.rejects(enrollHost(d.target("host-1", { ca: undefined }), token, hostKey(join(d.dir, "h1.key"))));
		// a proof with a key of another peer, or no key, admits nothing
		const t = agentNetTransport(d.target("host-2"), hostKey(join(d.dir, "h1.key"), keyId));
		await assert.rejects(new FilesAgentClient({ agent: "x", tenant: "acme", transport: t, retries: 0 }).workspaces(), refused);
		t.close();
		// the operator names a valid peer and existing tenants
		await assert.rejects(d.svc.createHostEnroll("bad peer", ["acme"], hashToken(newEnrollToken())), code("invalidInput"));
		await assert.rejects(d.svc.createHostEnroll("host-3", ["nope"], hashToken(newEnrollToken())), code("invalidInput"));
		assert.deepEqual(parseListen("0.0.0.0:4202"), { host: "0.0.0.0", port: 4202 });
		assert.deepEqual(parseListen("[::1]:4202"), { host: "::1", port: 4202 });
		assert.throws(() => parseListen("4202"));
	} finally { await d.done(); }
});

test("two hosts with equal agent IDs act as two actors; revoking one host refuses its next call", async () => {
	const d = await setup();
	try {
		await d.svc.provisionActor("acme", ADM, "agent", "h1-conv", "h1-conv", { enrolledHostPeerId: "host-1", agentId: "conv" });
		await d.svc.provisionActor("acme", ADM, "agent", "h2-conv", "h2-conv", { enrolledHostPeerId: "host-2", agentId: "conv" });
		const h1 = await d.host("host-1", ["acme"]), h2 = await d.host("host-2", ["acme", "globex"]);
		const a = h1.client("conv", "acme"), b = h2.client("conv", "acme");
		assert.deepEqual(await a.workspaces(), ["h1-conv"]);
		assert.deepEqual(await b.workspaces(), ["h2-conv"]);
		await a.write("h1-conv", "mine.md", Buffer.from("1"), 0);
		await assert.rejects(b.read("h1-conv", "mine.md"), code("notFound"));
		assert.equal(await d.svc.revokeHosts("host-1"), 1);
		await assert.rejects(a.workspaces(), code("unauthenticated"), "the open connection is refused at its next call");
		assert.deepEqual(await b.workspaces(), ["h2-conv"], "the other host goes on");
		// a new connection cannot prove the revoked key either
		const t = agentNetTransport(d.target("host-1"), hostKey(h1.keyFile, h1.keyId));
		await assert.rejects(new FilesAgentClient({ agent: "conv", tenant: "acme", transport: t, retries: 0 }).workspaces(), refused);
		t.close();
		assert.deepEqual((await d.svc.listHosts()).map((k) => [k.peerId, k.state]), [["host-1", "revoked"], ["host-2", "active"]]);
	} finally { await d.done(); }
});

test("a restore revokes every host key: each host enrolls again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-net-rs-"));
	const o = { dataDir: join(dir, "data"), stateDir: join(dir, "state"), blobDir: join(dir, "blobs") };
	newBackupKey(join(dir, "data.key"));
	const key = readBackupKey(join(dir, "data.key"));
	const d = await setup(o);
	try {
		await d.svc.provisionActor("acme", ADM, "agent", "conv", "conv", { enrolledHostPeerId: "host-1", agentId: "conv" });
		const h = await d.host("host-1", ["acme"]);
		assert.deepEqual(await h.client("conv", "acme").workspaces(), ["conv"]);
		await backupData(d.svc, join(dir, "data.bk"), key);
		await d.done().catch(() => {});
		await restoreData(join(dir, "data.bk"), key, o);
		const svc = await FilesService.open(o);
		try { assert.deepEqual((await svc.listHosts()).map((k) => k.state), ["revoked"]); }
		finally { await svc.close(); }
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
