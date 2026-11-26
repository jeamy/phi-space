// The Space process of spaces-files (docs/zanzibar-agent-filesystem-plan.en.md, section 8, separate Space process):
// it owns the store with the tenant Spaces and serves it on a private unix socket to the filesystem service, its only
// client. It holds no logic of the filesystem: phi-spaces' Space service, plus two calls only the service makes, the
// creation of a tenant's Space and the compaction of the store. The tenant Spaces are never exposed beyond the socket,
// which lies in the data directory (mode 700).
//
//   node server/space-host.ts --store FILE|memory --listen unix:/path.sock [--exit-with-parent]
//
// `--exit-with-parent`: the process ends when its stdin closes, so a killed service leaves no Space process behind.
// A Space binary in another language takes the same arguments and prints the same ready line (server/store.ts).
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { parseTarget, serveSpace, SpaceService, StaticIdentity, type SpaceServer } from "phi-spaces";
import { inProcessStore, SPACE_PEER } from "./store.ts";

/** A tenant's Space alias (server/service.ts, `tenantAlias`): the only Spaces the service may create. */
const TENANT_ALIAS = /^t-[a-z0-9][a-z0-9_-]{0,61}$/;

export async function startSpaceHost(o: { file: string | null; listen: string }): Promise<{ close(): Promise<void> }> {
	const store = await inProcessStore(o.file);
	let server: SpaceServer;
	try {
		const inner = new SpaceService({
			host: store.host, ctx,
			identity: new StaticIdentity({ [SPACE_PEER]: { principal: { peerId: SPACE_PEER }, roles: ["member"] } }),
			// one client makes every call of every tenant: the per-peer bounds are the service's own admission
			maxCallsPerWindow: 1_000_000, maxPendingPerPrincipal: 4096, maxPendingPerPeer: 4096,
		});
		const service = {
			async handleText(text: string, conn: never, maxFrameBytes?: number): Promise<string> {
				let msg: { method?: unknown; args?: { alias?: unknown } } | null = null;
				try { msg = JSON.parse(text); } catch { /* the Space service answers it */ }
				if (msg?.method === "filesCreateSpace") {
					const alias = msg.args?.alias;
					if (typeof alias !== "string" || !TENANT_ALIAS.test(alias)) return JSON.stringify({ ok: false, error: { code: "BadRequest", message: "a tenant Space alias is t-<tenant>" } });
					return JSON.stringify({ ok: true, result: await store.createSpace(alias) });
				}
				if (msg?.method === "filesCompact") return JSON.stringify({ ok: true, result: await store.compact() });
				return inner.handleText(text, conn, maxFrameBytes);
			},
		};
		server = await serveSpace(service, { listen: parseTarget(o.listen), connection: () => ({ peerId: SPACE_PEER }) });
	} catch (e) { await store.close(); throw e; }
	return { async close() { await server.close(); await store.close(); } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
	const storeArg = arg("--store"), listen = arg("--listen");
	if (!storeArg || !listen?.startsWith("unix:")) {
		console.error("usage: space-host.ts --store FILE|memory --listen unix:/path.sock [--exit-with-parent]");
		process.exit(2);
	}
	let host: { close(): Promise<void> } | undefined;
	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		setTimeout(() => process.exit(0), 3000).unref();
		await host?.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	if (process.argv.includes("--exit-with-parent")) { process.stdin.on("end", () => void shutdown()); process.stdin.on("close", () => void shutdown()); process.stdin.resume(); }
	try { host = await startSpaceHost({ file: storeArg === "memory" ? null : storeArg, listen }); }
	catch (e) { console.error(`[files-space] cannot start: ${(e as Error).message}`); process.exit(1); }
	if (stopping) { await host.close(); process.exit(0); }
	// the service waits for this line; it comes after the handlers, since the service may signal at once
	console.log(`[files-space] ready on ${listen} (store ${storeArg})`);
}
