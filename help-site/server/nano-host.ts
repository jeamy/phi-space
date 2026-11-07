// Headless swarm shard ("nano"): the shard engine runs the worker side locally. Task processing, post commits and the
// doc scans of this shard happen on THIS machine, not on the hub host. Its Space is either a separate space process
// (`SWARM_SPACE`, TypeScript server/space-host.ts or `phi-space-server --profile help`, which also serves the hub), or
// this process holds the store itself and serves it on `SWARM_LISTEN`.
//
//   SWARM_SPACE=tcp:127.0.0.1:3600        the shard's space process; unset = the store lives in this process:
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
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { connectSpace, Meter, SpaceService, StaticIdentity, serveSpace, parseTarget } from "phi-spaces";
import { openSwarmSide } from "./social/space-side.ts";
import { retentionConfig } from "./social/retention.ts";
import { SocialSwarmHub, SWARM_ALIAS } from "./social/swarm.ts";
import { swarmPostGenerator, swarmReplyGenerator } from "./llm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const listen = parseTarget(process.env.SWARM_LISTEN ?? "unix:/tmp/swarm-b.sock");
const dbPath = process.env.SWARM_DB ?? join(ROOT, ".local", "swarm-b.phi.sqlite");
const shardTag = process.env.SWARM_TAG ?? "b-";
const produce = process.env.SWARM_PRODUCE === "1";

const meter = new Meter();
const spaceAt = process.env.SWARM_SPACE || null;

const side = spaceAt ? null : await openSwarmSide(ctx, { file: process.env.SWARM_MEM === "1" ? null : dbPath, retention: retentionConfig(), meter });
const client = spaceAt ? connectSpace(spaceAt, { space: SWARM_ALIAS, callTimeoutMs: 30_000 }) : null;

const hub = new SocialSwarmHub(client?.space ?? side!.space, meter, {
	shardTag,
	produce,
	pulses: false,
	seedContent: false,
});
const llmReply = await swarmReplyGenerator();
const llmPost = await swarmPostGenerator();
if (llmReply) hub.setReplyGenerator(llmReply);
if (llmPost) hub.setPostGenerator(llmPost);

const server = side ? await serveSpace(new SpaceService({
	host: side.host, ctx,
	identity: new StaticIdentity({ "peer-hub": { principal: { peerId: "peer-hub" }, roles: ["member"] } }),
}), { listen, connection: () => ({ peerId: "peer-hub" }) }) : null;

const where = spaceAt ? `space ${spaceAt}` : `live on ${JSON.stringify(listen)} (space ${side!.spaceId}, db ${process.env.SWARM_MEM === "1" ? "memory" : dbPath})`;
void hub.init()
	.then(() => console.log(`[nano] shard ${JSON.stringify(shardTag)} ${where}`))
	// A failed engine init must not kill the host: serving the space is the critical role.
	.catch((e) => console.error("[nano] swarm engine init failed – space stays served", e));

const shutdown = async () => {
	await hub.close();
	await server?.close();
	client?.close();
	await side?.close();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
