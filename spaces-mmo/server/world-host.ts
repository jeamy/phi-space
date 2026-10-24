// The world process (docs/architektur.md): loads the world's rooms into the space, takes intents oldest first and runs
// each command in a transaction together with taking its intent, and removes the characters of lapsed guest accounts.
// It holds no state of its own: a world process that dies loses at most the command it was running, whose intent
// comes back when the transaction lapses. Several may run; each intent is taken by exactly one.
//
//   SPACES_MMO_SPACE              the world space (default unix:/tmp/spaces-mmo-world.sock)
//   SPACES_MMO_WORLD              which world to load (default leuchtfeuer)
//   SPACES_MMO_MSG_LEASE_MS       how long a message stays (default 10 min)
//   SPACES_MMO_CLEANUP_MS         how often lapsed guests are looked for (default 60 s)
import "./env.ts";
import { pathToFileURL } from "node:url";
import { FOREVER, NO_WAIT } from "phi-spaces";
import { CommandError, execute, msg } from "./engine/commands.ts";
import { loadWorld, type WorldDef } from "./engine/world.ts";
import { asFields, fieldsOf, type CharacterFields, type IntentFields, type RoomFields } from "./model.ts";
import { awaitWork, connectSpace, DEFAULT_SPACE, envMs, readExisting, StillHeld } from "./space.ts";

const TXN_MS = 15_000;

export async function startWorld(o: { space?: string; world?: WorldDef } = {}) {
	const w = o.world ?? (await loadWorld());
	const conn = connectSpace(o.space ?? (process.env.SPACES_MMO_SPACE || DEFAULT_SPACE));
	const space = conn.space;
	const msgLeaseMs = envMs("SPACES_MMO_MSG_LEASE_MS", 10 * 60_000);
	const halt = new AbortController();

	// the rooms of the world (written once; a later world:load in Phase 1 replaces them)
	for (const r of w.rooms) {
		if (await space.readIfExists({ type: "Room", fields: { roomId: r.roomId } }, NO_WAIT)) continue;
		await space.write({ type: "Room", fields: asFields<RoomFields>({ roomId: r.roomId, name: r.name, desc: r.desc, ground: r.ground }) }, null, FOREVER);
	}

	/** Takes the oldest intent and runs it; false when there was none. */
	const step = async (): Promise<boolean> => {
		const [oldest] = await space.readAll({ type: "Intent" }, { limit: 1 });
		if (!oldest) return false;
		const txn = (await space.createTransaction(TXN_MS)).id;
		let actor: CharacterFields | null = null;
		try {
			const e = await space.takeIfExists({ type: "Intent", id: oldest.id }, NO_WAIT, { txn });
			if (!e) { await space.abort(txn); return true; } // another world process was faster
			const intent = fieldsOf<IntentFields>(e);
			const a = await space.readIfExists({ type: "Character", fields: { charId: intent.charId } }, 5_000);
			if (a) {
				actor = fieldsOf<CharacterFields>(a);
				await execute({ space, txn, world: w, actor, msgLeaseMs }, intent.line);
			}
			await space.commit(txn);
		} catch (e) {
			await space.abort(txn).catch(() => {});
			if (e instanceof CommandError) {
				// a refusal goes to the actor, and the intent is consumed (it would only fail again)
				await space.takeIfExists({ type: "Intent", id: oldest.id }, NO_WAIT).catch(() => {});
				if (actor) await msg({ space, txn: null, actor, msgLeaseMs }, actor.charId, "error", e.message).catch(() => {});
			} else {
				// anything else (the space busy, a conflict) leaves the intent for another try, a moment later; an intent
				// that keeps failing lapses with its lease
				console.error("[world] command failed:", (e as Error).message);
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		return true;
	};

	const loop = (async () => {
		while (!halt.signal.aborted) {
			try {
				if (!(await step())) await awaitWork(space, { type: "Intent" }, halt.signal);
			} catch (e) {
				if (halt.signal.aborted) break;
				console.error("[world] intent loop:", (e as Error).message);
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	})();

	/** Characters of guest accounts that lapsed are removed. An account held by a transaction (a registration in
	 *  progress) is skipped this round. */
	const cleanup = async () => {
		for (const c of await space.readAll({ type: "Character", fields: { guest: true } })) {
			const ch = fieldsOf<CharacterFields>(c);
			try {
				if (await readExisting(space, { type: "Account", fields: { accountId: ch.accountId } })) continue;
			} catch (e) { if (e instanceof StillHeld) continue; throw e; }
			await space.takeIfExists({ type: "Character", id: c.id }, NO_WAIT);
		}
	};
	const sweep = setInterval(() => void cleanup().catch((e) => console.error("[world] cleanup:", (e as Error).message)), envMs("SPACES_MMO_CLEANUP_MS", 60_000));
	sweep.unref?.();

	return {
		space,
		cleanup,
		async close() { halt.abort(); clearInterval(sweep); await loop; conn.close(); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const world = await startWorld();
	// the starter and the tests wait for this line
	console.log(`[world] ready (${process.env.SPACES_MMO_WORLD || "leuchtfeuer"})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await world.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
