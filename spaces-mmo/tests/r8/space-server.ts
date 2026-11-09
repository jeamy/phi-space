// The space the R8 walks serve both engines from (rust/mmo-engine/tests/common/walk.rs): one space in memory on a unix
// socket, with the service limits of the game's own space process (server/space-host.ts: every process of the game is one
// peer, so its calls per second and its waiting calls are sized for the whole game). The standalone service's defaults
// (1024 calls a second) are those of a single client: the Rust engine's load of the world goes past them.
//
//   node --experimental-strip-types --no-warnings tests/r8/space-server.ts unix:/path.sock
import { parseTarget, serveSpace, SpaceService, startService, StaticIdentity } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { openOwnMemoryHost } from "phi-spaces/store/host";

const listen = process.argv[2];
if (!listen) throw new Error("usage: space-server.ts unix:/path.sock");
const host = openOwnMemoryHost();
const stopService = await startService(host, ctx);
const peerId = "local";
const identity = new StaticIdentity({ [peerId]: { principal: { peerId }, roles: ["member"] } });
const server = await serveSpace(new SpaceService({ host, ctx, identity, maxCallsPerWindow: 50_000, maxPendingPerPrincipal: 4096, maxPendingPerPeer: 4096 }), { listen: parseTarget(listen), connection: () => ({ peerId }) });
const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await server.close(); await stopService(); await host.close(ctx); process.exit(0); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
