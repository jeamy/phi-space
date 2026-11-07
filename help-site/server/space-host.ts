// The swarm Space's process: holds the store of one swarm shard and serves it over the phi-spaces socket transport. The
// swarm engines (the hub on big, the shard engine on nano) are its clients. The Rust `phi-space-server --profile help`
// reads the same environment and prints the same ready line (rust/phi-space-server/src/profiles.rs).
//
//   SWARM_LISTEN=tcp:0.0.0.0:3600        (default unix:/tmp/swarm-space.sock)
//   SWARM_DB=/data/swarm.sqlite          (default help-site/.local/swarm.sqlite); SWARM_MEM=1 keeps it in memory
//   SWARM_MAX_ENTRIES=20000              entry cap; the oldest posts are purged above it (0 = off)
//   SWARM_HOST_NAME=nano                 name in the HostInfo entry (default: hostname)

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { serveSpace, SpaceService, StaticIdentity, parseTarget } from "phi-spaces";
import { openSwarmSide } from "./social/space-side.ts";
import { retentionConfig } from "./social/retention.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const listenSpec = process.env.SWARM_LISTEN ?? "unix:/tmp/swarm-space.sock";
const mem = process.env.SWARM_MEM === "1";
const file = mem ? null : process.env.SWARM_DB ?? join(ROOT, ".local", "swarm.sqlite");

const side = await openSwarmSide(ctx, { file, retention: retentionConfig() });
// Every client is a process of the swarm (the hub, a shard engine): one peer, as in the other projects' space processes.
const server = await serveSpace(new SpaceService({
	host: side.host, ctx,
	identity: new StaticIdentity({ "peer-swarm": { principal: { peerId: "peer-swarm" }, roles: ["member"] } }),
}), { listen: parseTarget(listenSpec), connection: () => ({ peerId: "peer-swarm" }) });
console.log(`[space] ready on ${listenSpec} (db ${file ?? "memory"})`);

let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	await server.close();
	await side.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
