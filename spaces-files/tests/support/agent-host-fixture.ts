// A spaces-files service in memory with one agent socket, for a project that is an agent host of it and tests against
// a real one without importing it (codemode-forum/tests/files.test.ts starts this file as a process). The tenant
// `acme` has the administrator `adm` and the person `lea`; `lea` owns the workspace `astro`. The socket stands for the
// host peer `forum-host` in `acme`.
//
//   node --experimental-strip-types tests/support/agent-host-fixture.ts <socket path>
//
// It prints `{"ready":true}` once the socket listens, then answers one JSON line on stdin with one JSON line on
// stdout (`{ok, value}` or `{ok:false, code, message}`):
//   {op:"agent", id, home?}                     register an agent of forum-host (its home: `home`, default the id)
//   {op:"workspace", name, owner?}              a workspace owned by `owner` (an agent's id, else lea)
//   {op:"write", ws, path, text?|base64?}       lea writes a file, making its directories
//   {op:"grant"|"revoke", ws, path, relation, agent?, user?}   lea (the owner) grants or revokes
//   {op:"remove", ws, path}                     lea removes a file
//   {op:"restrict"|"unrestrict", ws, path}      lea restricts a folder (a viewer grant needs a workspace root or one)
//   {op:"list", ws, path}                       what lea sees in a folder: [{name, kind, version?}]
//   {op:"read", ws, path}                       a file as lea reads it: {base64, version}
import { createInterface } from "node:readline";
import { FilesService } from "../../server/service.ts";
import { serveAgentSocket } from "../../server/agent-socket.ts";

const path = process.argv[2];
if (!path) { console.error("usage: agent-host-fixture.ts <socket path>"); process.exit(2); }
const HOST = "forum-host", TENANT = "acme", ADM = { actorKind: "user" as const, actorId: "adm" };

const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
await svc.createTenant(TENANT, { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
await svc.provisionActor(TENANT, ADM, "user", "lea", "lea", { issuer: "i", subject: "lea" });
const adm = (await svc.login(TENANT, "user", { issuer: "i", subject: "adm" })).handle;
const lea = (await svc.login(TENANT, "user", { issuer: "i", subject: "lea" })).handle;
const id = async (h: string) => (await svc.issueOperationIds(h, 1))[0];
await svc.createWorkspace(adm, "astro", { kind: "user", id: "lea" }, await id(adm));
const server = await serveAgentSocket(svc, { path, hostPeerId: HOST, tenantId: TENANT });

type Cmd = { op: string; id?: string; home?: string; name?: string; owner?: string; ws?: string; path?: string; text?: string; base64?: string; relation?: string; agent?: string; user?: string };
async function run(c: Cmd): Promise<unknown> {
	switch (c.op) {
		case "agent": return svc.provisionActor(TENANT, ADM, "agent", c.id!, c.home ?? c.id!, { enrolledHostPeerId: HOST, agentId: c.id! });
		case "workspace": return svc.createWorkspace(adm, c.name!, c.owner ? { kind: "agent", id: c.owner } : { kind: "user", id: "lea" }, await id(adm));
		case "write": {
			const segs = c.path!.split("/");
			for (let i = 1; i < segs.length; i++) {
				try { await svc.mkdir(lea, c.ws!, segs.slice(0, i).join("/"), await id(lea)); }
				catch (e) { if ((e as { code?: string }).code !== "alreadyExists") throw e; }
			}
			const bytes = c.base64 !== undefined ? Buffer.from(c.base64, "base64") : Buffer.from(c.text ?? "", "utf8");
			let version = 0;
			try { version = (await svc.read(lea, c.ws!, c.path!)).version; } catch {}
			return svc.write(lea, c.ws!, c.path!, bytes, version, await id(lea));
		}
		case "grant": case "revoke": {
			const subject = c.agent ? { kind: "agent", id: c.agent } : { kind: "user", id: c.user! };
			return (svc as any)[c.op](lea, c.ws!, c.path!, c.relation!, subject, await id(lea));
		}
		case "remove": return svc.remove(lea, c.ws!, c.path!, null, await id(lea));
		case "restrict": case "unrestrict": return svc[c.op](lea, c.ws!, c.path!, await id(lea));
		case "list": return (await svc.list(lea, c.ws!, c.path!)).map((e: { name: string; kind: string }) => ({ name: e.name, kind: e.kind }));
		case "read": { const r = await svc.read(lea, c.ws!, c.path!); return { base64: Buffer.from(r.bytes).toString("base64"), version: r.version }; }
		default: throw new Error(`no such command: ${c.op}`);
	}
}

console.log(JSON.stringify({ ready: true }));
const lines = createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on("line", (line) => {
	chain = chain.then(async () => {
		try { console.log(JSON.stringify({ ok: true, value: (await run(JSON.parse(line))) ?? null })); }
		catch (e) { console.log(JSON.stringify({ ok: false, code: (e as { code?: string }).code ?? "error", message: (e as Error).message })); }
	});
});
lines.on("close", () => { void chain.then(async () => { await server.close(); await svc.close(); process.exit(0); }); });
