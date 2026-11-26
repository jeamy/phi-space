// Starts the filesystem service (docs/zanzibar-agent-filesystem-plan.en.md): the store with its owner lock, the
// reaper, admission, the deployment state, and the adapters: the browser and admin adapter over HTTPS, one agent
// socket per configured host peer and tenant, and the host operator's local socket.
//
//   FILES_DATA_DIR=…/data   (default: spaces-files/.local/data; created with mode 700, refused if others can reach it)
//   FILES_STATE_DIR=…/state (default: spaces-files/.local/state; the deployment state, never inside the data directory)
//   FILES_BLOB_DIR=…/blobs  (default: spaces-files/.local/blobs; the sealed file contents, apart from both)
//   FILES_MEM=1             in memory, throwaway (no operator socket)
//   FILES_LIMITS=…/limits.json  overrides of the filesystem limits (server/limits.ts), checked on start
//   FILES_UPKEEP_MS         how often each tenant's upkeep runs (default 600000; 0 turns it off)
//   FILES_MOUNTS=…/mounts.json  read-only directory mounts, each the workspace @<name> (server/mounts.ts)
//
//   FILES_PUBLIC_ORIGIN     the browser's origin (default https://localhost:4200); FILES_HTTP_HOST (default 127.0.0.1)
//                           and FILES_HTTP_PORT (default: the origin's port) where it listens
//   FILES_TLS_CERT / _KEY   PEM files (default .local/tls/cert.pem and key.pem, `npm run dev-cert`); without them the
//                           browser adapter stays off
//   FILES_OIDC_ISSUER, FILES_OIDC_CLIENT_ID, FILES_OIDC_CLIENT_SECRET, FILES_OIDC_CA (a PEM file)
//                           the identity provider; default the development IdP (`npm run dev-idp`, http://127.0.0.1:4201)
//   FILES_AGENT_SOCKETS     `hostPeer@tenant=/path/to.sock;…`, one socket per enrolled agent host and tenant
//   FILES_AGENT_NET         `host:port`: agent hosts on other machines over TLS (server/agent-net.ts), with the
//                           certificate of FILES_TLS_CERT / _KEY; FILES_AGENT_NET_ID the service ID in each challenge
//                           (default "spaces-files"); hosts enroll with `operator enroll-host <peer> <tenant,…>`
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpaceServer } from "phi-spaces";
import { parseAgentSockets, serveAgentSocket } from "./agent-socket.ts";
import { ROOT, loadDotEnv } from "./env.ts";
import { serveHttp, type HttpServer } from "./http.ts";
import { parseListen, serveAgentNet, type AgentNetServer } from "./agent-net.ts";
import { OidcClient } from "./oidc.ts";
import { serveOperator } from "./operator.ts";
import { parseMounts } from "./mounts.ts";
import { parseLimits } from "./limits.ts";
import { FilesService } from "./service.ts";

loadDotEnv();
const env = process.env;
const mem = env.FILES_MEM === "1";
const dataDir = mem ? null : env.FILES_DATA_DIR || join(ROOT, ".local", "data");
const stateDir = mem ? null : env.FILES_STATE_DIR || join(ROOT, ".local", "state");
const blobDir = mem ? null : env.FILES_BLOB_DIR || join(ROOT, ".local", "blobs");

// The handlers come first: whoever reads the ready line may signal at once, before another statement of this file runs.
let service: FilesService | undefined;
const servers: Array<SpaceServer | HttpServer | AgentNetServer> = [];
let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	setTimeout(() => process.exit(0), 3000).unref();
	for (const s of servers) await s.close().catch(() => {});
	await service?.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const notes: string[] = [];
try {
	const limits = env.FILES_LIMITS ? parseLimits(readFileSync(env.FILES_LIMITS, "utf8"), env.FILES_LIMITS) : undefined;
	const mounts = env.FILES_MOUNTS ? parseMounts(readFileSync(env.FILES_MOUNTS, "utf8"), env.FILES_MOUNTS) : undefined;
	service = await FilesService.open({ dataDir, stateDir, blobDir, limits, mounts });
	for (const name of mounts?.keys() ?? []) notes.push(`mount @${name}`);
	if (stateDir) { servers.push(await serveOperator(service, stateDir)); notes.push(`operator ${join(stateDir, "operator.sock")}`); }
	for (const a of parseAgentSockets(env.FILES_AGENT_SOCKETS ?? "")) { servers.push(await serveAgentSocket(service, a)); notes.push(`agents of ${a.hostPeerId} in ${a.tenantId} at ${a.path}`); }
	const origin = env.FILES_PUBLIC_ORIGIN || "https://localhost:4200";
	const cert = env.FILES_TLS_CERT || join(ROOT, ".local", "tls", "cert.pem");
	const key = env.FILES_TLS_KEY || join(ROOT, ".local", "tls", "key.pem");
	if (existsSync(cert) && existsSync(key)) {
		const oidc = new OidcClient({
			issuer: env.FILES_OIDC_ISSUER || "http://127.0.0.1:4201",
			clientId: env.FILES_OIDC_CLIENT_ID || "spaces-files-dev",
			clientSecret: env.FILES_OIDC_CLIENT_SECRET || undefined,
			redirectUri: `${new URL(origin).origin}/auth/callback`,
			ca: env.FILES_OIDC_CA ? readFileSync(env.FILES_OIDC_CA, "utf8") : undefined,
		});
		const port = Number(env.FILES_HTTP_PORT || new URL(origin).port || 443);
		servers.push(await serveHttp(service, { listen: { host: env.FILES_HTTP_HOST || "127.0.0.1", port }, tls: { cert: readFileSync(cert), key: readFileSync(key) }, origin, oidc }));
		notes.push(`browser ${origin} (identity provider ${oidc.issuer})`);
	} else notes.push(`browser off: no TLS certificate at ${cert} (npm run dev-cert)`);
} catch (e) {
	console.error(`[files] cannot start: ${(e as Error).message}`);
	for (const s of servers) await s.close().catch(() => {});
	await service?.close().catch(() => {});
	process.exit(1);
}
if (stopping) { await service.close(); process.exit(0); }
// keep the process (and the owner lock) alive until a signal, also when nothing listens
setInterval(() => {}, 1 << 30);
// upkeep (plan section 6.2): expired receipts, audit rows past their age and orphaned blobs, in bounded batches inside
// each tenant's queue; a busy or closed tenant is simply tried again next time
const upkeepMs = Number(env.FILES_UPKEEP_MS || 600_000);
if (upkeepMs > 0) setInterval(() => {
	void (async () => { for (const t of await service!.tenants()) await service!.maintainTenant(t).catch(() => {}); })().catch(() => {});
}, upkeepMs).unref();
for (const n of notes) console.log(`[files] ${n}`);
// the tests wait for this line
console.log(`[files] ready (store ${service.storePath ?? "memory"})`);
