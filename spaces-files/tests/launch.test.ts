// The whole service as it is launched (server/launch.ts): store, state and blob directories, the operator socket, an
// agent socket and the browser adapter against an identity provider of its own process; the operator creates the
// tenant through its CLI, the administrator signs in through the browser and registers an agent, and the agent saves
// through its socket.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FilesAgentClient } from "../client/agent-client.ts";
import { startDevIdp } from "../server/dev-idp.ts";
import { Browser, freePort, testCert } from "./support/browser.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const node = (file: string) => [process.execPath, "--no-warnings", "--experimental-strip-types", join(ROOT, "server", file)] as const;

test("launched: operator, browser sign-in, admin registration and an agent's save", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-launch-"));
	const port = await freePort();
	const origin = `https://localhost:${port}`;
	const idp = await startDevIdp({ clients: [{ clientId: "files-launch", redirectUris: [`${origin}/auth/callback`] }] });
	const tls = testCert();
	writeFileSync(join(dir, "cert.pem"), tls.cert);
	writeFileSync(join(dir, "key.pem"), tls.key, { mode: 0o600 });
	mkdirSync(join(dir, "agents"), { mode: 0o750 });
	const sock = join(dir, "agents", "host-1.sock");
	const env = {
		...process.env, NODE_TEST_CONTEXT: "", FILES_MEM: "",
		FILES_DATA_DIR: join(dir, "data"), FILES_STATE_DIR: join(dir, "state"), FILES_BLOB_DIR: join(dir, "blobs"),
		FILES_PUBLIC_ORIGIN: origin, FILES_TLS_CERT: join(dir, "cert.pem"), FILES_TLS_KEY: join(dir, "key.pem"),
		FILES_OIDC_ISSUER: idp.issuer, FILES_OIDC_CLIENT_ID: "files-launch", FILES_AGENT_SOCKETS: `host-1@acme=${sock}`,
	};
	const [cmd, ...args] = node("launch.ts");
	const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout!.on("data", (c) => { out += c; if (out.includes("[files] ready")) resolve(); });
			child.stderr!.on("data", (c) => { out += c; });
			child.once("exit", (code) => reject(new Error(`exited ${code}: ${out}`)));
		});
		assert.match(out, /browser https:\/\/localhost/);
		assert.match(out, /agents of host-1 in acme/);
		const [ocmd, ...oargs] = node("operator.ts");
		const op = (...a: string[]) => promisify(execFile)(ocmd, [...oargs, ...a], { env });
		await op("create-tenant", "acme", "adm", "adm", idp.issuer, "adm");
		assert.match((await op("tenants")).stdout, /"state": "ready"/);
		assert.match((await op("create-tenant", "acme", "adm", "adm", idp.issuer, "adm")).stdout, /"status": "alreadyExists"/);

		const adm = new Browser(origin);
		await adm.signIn(idp, "adm");
		await adm.must("registerActor", { kind: "agent", actorId: "planner-17", homeName: "planner-17", identity: { enrolledHostPeerId: "host-1", agentId: "planner-17" }, operationId: await adm.opId() });
		const agent = new FilesAgentClient({ path: sock, agent: "planner-17" });
		try {
			assert.deepEqual(await agent.write("planner-17", "plan.md", Buffer.from("step one"), 0), { version: 1 });
			assert.deepEqual(await agent.workspaces(), ["planner-17"]);
		} finally { agent.close(); }
		assert.deepEqual((await adm.must<Array<{ id: string }>>("listActors")).map((a) => a.id), ["planner-17", "adm"]);
	} finally {
		child.kill("SIGTERM");
		await new Promise((r) => child.once("exit", r));
		await idp.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
