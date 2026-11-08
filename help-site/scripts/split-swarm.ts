// One-time move of the swarm Space out of the help store (spaces-eibrain.sqlite, which also holds the chat stages, the
// control space and the admin state) into a store of its own (swarm.sqlite). That store is served by the swarm's space
// process (server/space-host.ts or `phi-space-server --profile help`). Run it while the hub is stopped.
//
//   node --experimental-strip-types help-site/scripts/split-swarm.ts FROM.sqlite TO.sqlite
//
// The entries keep their ids, so the history chain (each node names the next by id) stays as it is. Whatever open
// transactions held is handled as their abort would: taken entries become free again, and entries written under one
// are dropped. Request claims, change stream and mailboxes start empty in the new store. The limits and the completion
// profile are set again by the space process on its start. The old store keeps its copy of the Space, which nothing
// serves anymore (drop-moved-swarm.ts removes it); TO must not exist yet.
import { access } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { core, createSpace, listSpaces, NamedSpace, openSqliteHost, spaceDoc } from "phi-spaces";
import { SWARM_ALIAS } from "../server/social/space-side.ts";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
	console.error("usage: split-swarm.ts FROM.sqlite TO.sqlite");
	process.exit(2);
}
if (await access(to).then(() => true, () => false)) {
	console.error(`${to} exists: the move goes into a new store only`);
	process.exit(2);
}

const source = await openSqliteHost(from);
const info = (await listSpaces(source, ctx)).find((s) => s.alias === SWARM_ALIAS);
const old = info ? await source.snapshot(NamedSpace, info.spaceId, ctx) : null;
await source.close(ctx);
if (!info || !old) {
	console.error(`${from}: no ${SWARM_ALIAS} Space`);
	process.exit(1);
}
const now = Date.now();
const entries = old.entries
	.filter((e) => e.writtenUnder === null && (e.expires === core.FOREVER || e.expires > now))
	.map((e) => ({ ...e, takenBy: null, readBy: [] }));

const target = await openSqliteHost(to);
try {
	const made = await target.commit((tx) => createSpace(tx, SWARM_ALIAS, Date.now()), ctx);
	await target.commit(async (tx) => {
		const s = await spaceDoc(tx, made.spaceId, Date.now());
		s.entries = entries;
		s.nextId = Math.max(s.nextId, old.nextId);
		core.touch(s, Date.now());
	}, ctx);
	const byType: Record<string, number> = {};
	for (const e of entries) byType[e.type] = (byType[e.type] ?? 0) + 1;
	console.log(`moved ${entries.length} of ${old.entries.length} entries of ${SWARM_ALIAS} (${info.spaceId}) to ${to} (${made.spaceId}): ${JSON.stringify(byType)}`);
} finally {
	await target.close(ctx);
}
