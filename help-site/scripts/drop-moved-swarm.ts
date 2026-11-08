// After split-swarm.ts: removes the old copy of the swarm Space from the help store (spaces-eibrain.sqlite), which
// nothing serves anymore. Run it while the hub is stopped; ADDRESS is the swarm's space process that holds the moved
// Space (on big tcp:127.0.0.1:3610). It refuses unless that process answers with a ready history head there.
//
//   node --experimental-strip-types help-site/scripts/drop-moved-swarm.ts FROM.sqlite ADDRESS
//
// The Space is deleted as SpaceLifecycle deletes one (its alias freed, its id kept reserved with deletedAt), and its
// document with all its rows is retired. VACUUM then gives the space back to the file system.
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { connectSpace, listSpaces, NamedSpace, openSqliteHost, Registry } from "phi-spaces";
import { SWARM_ALIAS } from "../server/social/space-side.ts";

const [from, address] = process.argv.slice(2);
if (!from || !address) {
	console.error("usage: drop-moved-swarm.ts FROM.sqlite ADDRESS");
	process.exit(2);
}

const moved = connectSpace(address, { space: SWARM_ALIAS, callTimeoutMs: 10_000 });
try {
	const head = await moved.space.read({ type: "PostHistoryHead" }, 0);
	const n = (await moved.space.stats()).entries;
	if (!head || head.fields.ready !== true || n === 0) {
		console.error(`${address}: ${SWARM_ALIAS} has no ready history head (${n} entries); nothing is dropped`);
		process.exit(1);
	}
	console.log(`${address}: ${SWARM_ALIAS} holds ${n} entries, history head ready`);
} finally { moved.close(); }

const before = statSync(from).size;
const host = await openSqliteHost(from);
try {
	const info = (await listSpaces(host, ctx)).find((s) => s.alias === SWARM_ALIAS);
	if (!info) {
		console.log(`${from}: no ${SWARM_ALIAS} Space (already dropped)`);
	} else {
		const old = await host.snapshot(NamedSpace, info.spaceId, ctx);
		await host.commit(async (tx) => {
			const r = await tx.doc(Registry);
			delete r.aliases[info.alias];
			r.spaces[info.spaceId] = { ...r.spaces[info.spaceId]!, deletedAt: Date.now() };
			await tx.retireDoc(NamedSpace, info.spaceId);
		}, ctx);
		console.log(`${from}: dropped ${SWARM_ALIAS} (${info.spaceId}, ${old?.entries.length ?? 0} entries)`);
	}
} finally { await host.close(ctx); }

const db = new DatabaseSync(from);
try { db.exec("VACUUM"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
console.log(`${from}: ${(before / 1e6).toFixed(1)} MB -> ${(statSync(from).size / 1e6).toFixed(1)} MB`);
