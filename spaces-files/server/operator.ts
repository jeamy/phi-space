// The host operator's local interface (docs/zanzibar-agent-filesystem-plan.en.md, section 5, *Host operator
// operations*): a unix socket inside the deployment-state directory, which only the service account can reach (mode
// 700, checked on open), so the OS account is the separate authentication. Its operations are serialized and offer no
// file access: create or resume a tenant with its first administrator and home, list tenants, switch the admission
// mode. Backup, restore and key rotation join it in phase 5.
//
//   node --experimental-strip-types server/operator.ts create-tenant <tenant> <adminId> <homeName> <issuer> <subject>
//   node --experimental-strip-types server/operator.ts tenants | mode normal|maintenance
//   (root: npm --prefix spaces-files run operator -- …; FILES_STATE_DIR names the state directory)
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serveSpace, socketTransport, type SpaceServer } from "phi-spaces";
import type { FilesService } from "./service.ts";
import { checkSocketPath } from "./agent-socket.ts";
import { isObj, wireError } from "./wire.ts";

export const OPERATOR_SOCKET = "operator.sock";

export async function serveOperator(svc: FilesService, stateDir: string): Promise<SpaceServer> {
	checkSocketPath(join(stateDir, OPERATOR_SOCKET));
	let chain: Promise<unknown> = Promise.resolve();
	const run = async (msg: unknown) => {
		if (!isObj(msg) || typeof msg.op !== "string") throw Object.assign(new Error("a call is {op, args}"), { code: "invalidInput" });
		const a = isObj(msg.args) ? msg.args : {};
		switch (msg.op) {
			case "createTenant": return svc.createTenant(String(a.tenantId), { actorId: String(a.actorId), homeName: String(a.homeName), issuer: String(a.issuer), subject: String(a.subject) });
			case "tenants": return Promise.all((await svc.tenants()).map(async (t) => ({ tenantId: t, state: await svc.tenantState(t) })));
			case "setMode": await svc.setMode(a.mode === "maintenance" ? "maintenance" : a.mode === "normal" ? "normal" : (() => { throw Object.assign(new Error("mode is normal or maintenance"), { code: "invalidInput" }); })()); return { mode: svc.state.mode() };
			default: throw Object.assign(new Error("unknown operation"), { code: "invalidInput" });
		}
	};
	return serveSpace({
		handleText: (text) => {
			// one operation at a time, in arrival order
			const p = chain.then(async () => {
				try { return JSON.stringify({ ok: true, value: await run(JSON.parse(text)) ?? null }); }
				catch (e) { return JSON.stringify({ ok: false, error: wireError(e) }); }
			});
			chain = p;
			return p;
		},
	}, { listen: { path: join(stateDir, OPERATOR_SOCKET) }, maxConnections: 4 });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { ROOT, loadDotEnv } = await import("./env.ts");
	loadDotEnv();
	const stateDir = process.env.FILES_STATE_DIR || join(ROOT, ".local", "state");
	const [cmd, ...rest] = process.argv.slice(2);
	const call = cmd === "create-tenant" && rest.length === 5 ? { op: "createTenant", args: { tenantId: rest[0], actorId: rest[1], homeName: rest[2], issuer: rest[3], subject: rest[4] } }
		: cmd === "tenants" ? { op: "tenants" }
		: cmd === "mode" && rest.length === 1 ? { op: "setMode", args: { mode: rest[0] } }
		: null;
	if (!call) {
		console.error("usage: operator.ts create-tenant <tenant> <adminId> <homeName> <issuer> <subject> | tenants | mode normal|maintenance");
		process.exit(2);
	}
	const t = socketTransport({ path: join(stateDir, OPERATOR_SOCKET) });
	try {
		const r = JSON.parse(await t.request(JSON.stringify(call)));
		console.log(JSON.stringify(r.ok ? r.value : r.error, null, 2));
		process.exitCode = r.ok ? 0 : 1;
	} catch (e) {
		console.error(`[operator] the service does not answer at ${join(stateDir, OPERATOR_SOCKET)}: ${(e as Error).message}`);
		process.exitCode = 1;
	} finally { t.close(); }
}
