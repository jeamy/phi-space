// The Space process of spaces-files (docs/zanzibar-agent-filesystem-plan.en.md, section 8, separate Space process):
// it owns the store with the tenant Spaces and serves it on a private unix socket to the filesystem service, its only
// client. It holds no logic of the filesystem: phi-spaces' Space service, and on the store's own side the two requests
// only the service makes, the creation of a tenant's Space and the compaction of the store (server/store.ts,
// `FilesHostRequest`). The tenant Spaces are never exposed beyond the socket, which lies in the data directory (mode 700).
//
//   node server/space-host.ts --store FILE|memory --listen unix:/path.sock [--exit-with-parent]
//
// `--exit-with-parent`: the process ends when its stdin closes, so a killed service leaves no Space process behind.
// The Rust `files-space` (spaces-files/rust) takes the same arguments, answers the same requests and prints the same
// ready line.
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { PhiSpaces, parseTarget, serveSpace, SpaceService, StaticIdentity, type SpaceServer } from "phi-spaces";
import { HOST_REPLY, HOST_REQUEST, inProcessStore, REPLY_LEASE_MS, SPACE_PEER } from "./store.ts";

/** A tenant's Space alias (server/service.ts, `tenantAlias`): the only Spaces the service may create. */
const TENANT_ALIAS = /^t-[a-z0-9][a-z0-9_-]{0,61}$/;

export async function startSpaceHost(o: { file: string | null; listen: string }): Promise<{ close(): Promise<void> }> {
	const store = await inProcessStore(o.file);
	let server: SpaceServer;
	let stopping = false;
	let requests: Promise<void> = Promise.resolve();
	try {
		const service = new SpaceService({
			host: store.host, ctx,
			identity: new StaticIdentity({ [SPACE_PEER]: { principal: { peerId: SPACE_PEER }, roles: ["member"] } }),
			// one client makes every call of every tenant: the per-peer bounds are the service's own admission
			maxCallsPerWindow: 1_000_000, maxPendingPerPrincipal: 4096, maxPendingPerPeer: 4096,
		});
		server = await serveSpace(service, { listen: parseTarget(o.listen), connection: () => ({ peerId: SPACE_PEER }) });
		// the requests, one at a time, as the store's owner (no principal of the socket)
		const local = new PhiSpaces(store.host, ctx);
		const answer = async (f: Record<string, unknown>): Promise<Record<string, unknown>> => {
			try {
				if (f.op === "createSpace") {
					if (typeof f.alias !== "string" || !TENANT_ALIAS.test(f.alias)) return { ok: false, error: "a tenant Space alias is t-<tenant>" };
					return { ok: true, result: await store.createSpace(f.alias) };
				}
				if (f.op === "compact") return { ok: true, result: await store.compact() };
				return { ok: false, error: `unknown request ${String(f.op)}` };
			} catch (e) { return { ok: false, error: (e as Error).message }; }
		};
		requests = (async () => {
			while (!stopping) {
				const r = await local.take({ type: HOST_REQUEST }, 500).catch(() => null);
				if (r === null) continue;
				const a = await answer(r.fields);
				await local.write({ type: HOST_REPLY, fields: { id: r.fields.id, ...a } as never }, null, REPLY_LEASE_MS).catch((e) => console.error(`[files-space] reply lost: ${(e as Error).message}`));
			}
		})();
	} catch (e) { await store.close(); throw e; }
	return { async close() { stopping = true; await requests; await server.close(); await store.close(); } };
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
