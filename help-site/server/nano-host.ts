// Headless swarm shard host ("nano"): owns its own SpaceHost + SQLite and serves the
// `social-swarm` space over the phi-spaces socket transport (unix path or TCP). A shard
// engine runs the worker side locally – task processing, post commits and the O(entries)
// doc scans for this shard happen on THIS machine, not on the hub host.
//
//   SWARM_LISTEN=unix:/tmp/swarm-b.sock   (default) or tcp:0.0.0.0:3600
//   SWARM_DB=/data/swarm-b.sqlite         (default: help-site/.local/swarm-b.phi.sqlite)
//   SWARM_TAG=b-                          post-id prefix of this shard
//   SWARM_PRODUCE=1                       also generate intents locally (default: 0)
//   SWARM_MAX_ENTRIES=20000               entry cap of this shard's database; the oldest posts are purged above it (0 = off)
//   SWARM_HOST_NAME=nano                  name shown in the hub's test-system bar (default: hostname)
//   PHI_SPACES_LLM=0                       disables the LLM generators (default anyway without creds)
//
// Hub side (big): SWARM_REMOTE=unix:/tmp/swarm-b.sock  or  SWARM_REMOTE=tcp:nano:3600

import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { Meter, startService, SpaceService, StaticIdentity, serveSpace, createSpace, parseTarget, openOwnMemoryHost, openSqliteHost } from "phi-spaces";
import { SocialSwarmHub, SWARM_ALIAS } from "./social/swarm.ts";
import { swarmPostGenerator, swarmReplyGenerator } from "./llm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const listen = parseTarget(process.env.SWARM_LISTEN ?? "unix:/tmp/swarm-b.sock");
const dbPath = process.env.SWARM_DB ?? join(ROOT, ".local", "swarm-b.phi.sqlite");
const shardTag = process.env.SWARM_TAG ?? "b-";
const produce = process.env.SWARM_PRODUCE === "1";

const meter = new Meter();

// The own store (a pi-durable file of an older version is refused, not taken over: phi-spaces decision D6).
const host = process.env.SWARM_MEM === "1"
	? openOwnMemoryHost()
	: await (async () => {
			await mkdir(dirname(dbPath), { recursive: true });
			return await openSqliteHost(dbPath);
		})();
await startService(host, ctx, { watchDebounceMs: 400 });

const hub = new SocialSwarmHub(host, ctx, meter, {
	shardTag,
	produce,
	pulses: false,
	seedContent: false,
});
const llmReply = await swarmReplyGenerator();
const llmPost = await swarmPostGenerator();
if (llmReply) hub.setReplyGenerator(llmReply);
if (llmPost) hub.setPostGenerator(llmPost);

// The space must exist before the service is queried by the hub.
const info = await host.commit((tx) => createSpace(tx, SWARM_ALIAS, Date.now()), ctx);

const identity = new StaticIdentity({
	"peer-hub": { principal: { peerId: "peer-hub" }, roles: ["member"] },
});
const server = await serveSpace(new SpaceService({ host: host, ctx, identity }), {
	listen,
	connection: () => ({ peerId: "peer-hub" }),
});

void hub.init()
	.then(() => console.log(`[nano] shard ${JSON.stringify(shardTag)} live on ${JSON.stringify(listen)} (space ${info.spaceId}, db ${process.env.SWARM_MEM === "1" ? "memory" : dbPath})`))
	// A failed engine init must not kill the host: serving the space is the critical role.
	.catch((e) => console.error("[nano] swarm engine init failed – space stays served", e));

const shutdown = async () => {
	await hub.close();
	await server.close();
	await host.close(ctx);
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
