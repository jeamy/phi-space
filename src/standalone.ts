// A phi-space as a service of its own (docs/umstellung-ohne-pi-durable.md, U3): the own store (SQLite, or memory) served
// over a unix socket or TCP, with no pi-durable, no model and no agent. Every connection is one peer; whoever can reach
// the socket uses the space (keep it on a unix socket or an internal address, or put the overlay gate in front).
//
//   node --experimental-strip-types src/standalone.ts --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT [--peer ID]
//
// Prints "[phi-spaces] ready on <listen> (store <file|memory>)" once it serves; SIGINT/SIGTERM close it.
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "./context.ts";
import { serveSpace, type ListenTarget } from "./socket.ts";
import { parseTarget } from "./space-client.ts";
import { SpaceService, StaticIdentity } from "./service.ts";
import { startService } from "./index.ts";
import { openOwnMemoryHost } from "./store/host.ts";
import { openSqliteHost } from "./store/sqlite.ts";
import type { ClosableStoreHost } from "./store/types.ts";

export type StandaloneOptions = {
	/** The store file (the own SQLite store), or null for a space in memory. */
	store: string | null;
	listen: ListenTarget;
	/** The peer every connection is (default "local"), with the member role. */
	peerId?: string;
};

/** `unix:/path` or `tcp:host:port` (space-client.ts parseTarget). */
export const parseListen = parseTarget;

/** Opens the store and serves it; `close()` stops serving and closes the store (what was acknowledged is on the disk). */
export async function startStandalone(o: StandaloneOptions): Promise<{ address: string; host: ClosableStoreHost; close(): Promise<void> }> {
	const host: ClosableStoreHost = o.store ? await openSqliteHost(o.store) : openOwnMemoryHost();
	try {
		// background work of a space: expired leases and deadlines are settled when due, events delivered
		const stopService = await startService(host, ctx);
		const peerId = o.peerId ?? "local";
		const identity = new StaticIdentity({ [peerId]: { principal: { peerId }, roles: ["member"] } });
		const server = await serveSpace(new SpaceService({ host, ctx, identity }), { listen: o.listen, connection: () => ({ peerId }) });
		const a = server.address();
		const address = "path" in o.listen ? `unix:${o.listen.path}` : `tcp:${o.listen.host}:${typeof a === "object" && a ? a.port : o.listen.port}`;
		return { address, host, async close() { await server.close(); await stopService(); await host.close(ctx); } };
	} catch (e) { await host.close(ctx); throw e; }
}

// Started directly, as this file: inlined into a bundle (an example that imports parseListen), import.meta.url is the
// bundle's, and the bundle's own start must not run this one.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && /\/standalone\.(ts|m?js)$/.test(import.meta.url)) {
	const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
	const store = arg("--store"), listen = arg("--listen");
	if (!store || !listen) { console.error("usage: standalone.ts --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT [--peer ID]"); process.exit(2); }
	const s = await startStandalone({ store: store === "memory" ? null : store, listen: parseListen(listen), ...(arg("--peer") ? { peerId: arg("--peer")! } : {}) });
	console.log(`[phi-spaces] ready on ${s.address} (store ${store})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await s.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
