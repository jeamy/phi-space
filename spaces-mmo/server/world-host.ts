// The world worker (docs/architektur.md): loads the world definition into the space (engine/loader.ts), takes
// intents oldest first and runs each command in a transaction together with taking its intent, and removes the
// characters of lapsed guest accounts. It holds no state of its own: a world worker that dies loses at most the
// command it was running, whose intent comes back when the transaction lapses. Several may run; each intent is taken
// by exactly one (an intent another one holds is invisible, so each takes the next).
//
//   SPACES_MMO_SPACE              the world space (default unix:/tmp/spaces-mmo-world.sock)
//   SPACES_MMO_WORLD              which world to load (default leuchtfeuer)
//   SPACES_MMO_MSG_LEASE_MS       how long a message stays (default 10 min)
//   SPACES_MMO_CLEANUP_MS         how often lapsed guests are looked for (default 60 s)
//   SPACES_MMO_TXN_MS             lease of a command's transaction: how soon the work of a dead process returns (15 s)
//   SPACES_MMO_TIME_SCALE         factor on every game duration (burn time, fog steps, tide); tests run fast with 0.01
import "./env.ts";
import { pathToFileURL } from "node:url";
import { FOREVER, NO_WAIT } from "phi-spaces";
import { CommandError, execute } from "./engine/commands.ts";
import { msg } from "./engine/context.ts";
import { marketTick, ordersTick } from "./engine/commands/trade.ts";
import { fireTick, floodTick, fogTick, stormTick } from "./engine/fire.ts";
import { ensureTokens, loadIntoSpace } from "./engine/loader.ts";
import { runDue, type Job } from "./engine/ticker.ts";
import { gameMs } from "./engine/time.ts";
import { loadWorld, type WorldDef } from "./engine/world.ts";
import { actorToken, fieldsOf, type AccountFields, type CharacterFields, type IntentFields } from "./model.ts";
import { awaitWork, connectSpace, DEFAULT_SPACE, envMs, readExisting, StillHeld } from "./space.ts";

export async function startWorld(o: { space?: string; world?: WorldDef } = {}) {
	const w = o.world ?? (await loadWorld());
	const conn = connectSpace(o.space ?? (process.env.SPACES_MMO_SPACE || DEFAULT_SPACE));
	const space = conn.space;
	const msgLeaseMs = envMs("SPACES_MMO_MSG_LEASE_MS", 10 * 60_000);
	const TXN_MS = envMs("SPACES_MMO_TXN_MS", 15_000);
	const halt = new AbortController();

	// the world's recurring jobs (engine/ticker.ts): whichever worker takes a due ticker runs it, once
	const jobs: Job[] = [
		{ key: "fire", everyMs: gameMs(15_000, 100), run: () => fireTick(space, w, msgLeaseMs) },
		{ key: "fog", everyMs: gameMs(w.fog.stepMs), run: () => fogTick(space, w, msgLeaseMs) },
		{ key: "flood", everyMs: gameMs(w.flood.everyMs), run: () => floodTick(space, w, msgLeaseMs) },
		{ key: "orders", everyMs: gameMs(w.orders.everyMs), run: () => ordersTick(space, w) },
		{ key: "market", everyMs: gameMs(60_000, 100), run: () => marketTick(space) },
		...(w.storm ? [{ key: "storm", everyMs: gameMs(w.storm.everyMs), run: async () => { await stormTick(space, w, msgLeaseMs); } }] : []),
	];
	const loaded = await loadIntoSpace(space, w, { tickers: jobs }).catch((e) => { conn.close(); throw e; });
	if (loaded.loaded) console.log(`[world] loaded ${w.id} version ${w.version}${loaded.spawned.length ? `, placed ${loaded.spawned.join(", ")}` : ""}`);
	const tokens = await ensureTokens(space);
	if (tokens) console.log(`[world] wrote ${tokens} missing tokens`);

	/** In `txn`: the character's token and its oldest intent, or null (another worker has the token, or no intent is
	 *  left). Only the token's holder takes a character's intents, so all of them are visible here. */
	const claim = async (txn: string, charId: string): Promise<IntentFields | null> => {
		if (!(await space.takeIfExists(actorToken(charId), NO_WAIT, { txn }))) return null;
		const [oldest] = await space.readAll({ type: "Intent", fields: { charId } }, { limit: 1 });
		const e = oldest && (await space.takeIfExists({ type: "Intent", id: oldest.id }, NO_WAIT, { txn }));
		return e ? fieldsOf<IntentFields>(e) : null;
	};

	/** A refusal: in a transaction of its own (again holding the token), the intent is consumed and the actor told. */
	const refuse = async (actor: CharacterFields, text: string) => {
		const txn = (await space.createTransaction(TXN_MS)).id;
		try {
			if (!(await claim(txn, actor.charId))) { await space.abort(txn); return; }
			await msg({ space, txn, actor, msgLeaseMs }, actor.charId, "error", text);
			await space.write(actorToken(actor.charId), txn, FOREVER);
			await space.commit(txn);
		} catch { await space.abort(txn).catch(() => {}); }
	};

	/** Runs the oldest intent of a character whose token is free. "none": no intent at all; "busy": every character
	 *  with intents is being served by another worker right now. */
	const step = async (): Promise<"ran" | "busy" | "none"> => {
		const pending = await space.readAll({ type: "Intent" }, { limit: 50 });
		if (!pending.length) return "none";
		const tried = new Set<string>();
		for (const p of pending) {
			const charId = String(p.fields.charId);
			if (tried.has(charId)) continue;
			tried.add(charId);
			const txn = (await space.createTransaction(TXN_MS)).id;
			let actor: CharacterFields | null = null;
			try {
				const intent = await claim(txn, charId);
				// another worker serves this character right now (tokens are written with every character, and for older
				// ones when a worker starts)
				if (!intent) { await space.abort(txn); continue; }
				const a = await space.readIfExists({ type: "Character", fields: { charId } }, 5_000);
				if (a) {
					actor = fieldsOf<CharacterFields>(a);
					const acc = await space.readIfExists({ type: "Account", fields: { accountId: actor.accountId } }, 2_000);
					await execute({ space, txn, world: w, actor, account: acc ? fieldsOf<AccountFields>(acc) : null, msgLeaseMs, cache: {}, ...(intent.asked ? { asked: intent.asked } : {}) }, intent.line);
				}
				await space.write(actorToken(charId), txn, FOREVER);
				await space.commit(txn);
				return "ran";
			} catch (e) {
				await space.abort(txn).catch(() => {});
				// a refusal is told and its intent consumed (it would only fail again); anything else (the space busy, a
				// conflict) leaves the intent for another try a moment later, and one that keeps failing lapses with its lease
				if (e instanceof CommandError) { if (actor) await refuse(actor, e.message); return "ran"; }
				console.error("[world] command failed:", (e as Error).message);
				await new Promise((r) => setTimeout(r, 500));
				return "ran";
			}
		}
		return "busy";
	};

	const loop = (async () => {
		while (!halt.signal.aborted) {
			try {
				const r = await step();
				if (r === "none") await awaitWork(space, { type: "Intent" }, halt.signal);
				else if (r === "busy") await new Promise((res) => setTimeout(res, 20));
			} catch (e) {
				if (halt.signal.aborted) break;
				console.error("[world] intent loop:", (e as Error).message);
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	})();

	const ticking = (async () => {
		while (!halt.signal.aborted) {
			let wait = 1000;
			try { wait = await runDue(space, jobs, { txnMs: TXN_MS, maxWaitMs: 1000 }); }
			catch (e) { if (!halt.signal.aborted) console.error("[world] tickers:", (e as Error).message); }
			await new Promise<void>((r) => { const t = setTimeout(r, wait); halt.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
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
			await space.takeIfExists(actorToken(ch.charId), NO_WAIT);
		}
	};
	const sweep = setInterval(() => void cleanup().catch((e) => console.error("[world] cleanup:", (e as Error).message)), envMs("SPACES_MMO_CLEANUP_MS", 60_000));
	sweep.unref?.();

	return {
		space,
		cleanup,
		async close() { halt.abort(); clearInterval(sweep); await loop; await ticking; conn.close(); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	// started together with the space (the dev runner restarts both on a change): wait until its socket is there
	let world: Awaited<ReturnType<typeof startWorld>> | undefined;
	for (let tries = 0; !world; tries++) {
		try { world = await startWorld(); }
		catch (e) {
			if (tries >= 30 || !/ENOENT|ECONNREFUSED/.test((e as Error).message)) throw e;
			if (!tries) console.log("[world] waiting for the space …");
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	// the starter and the tests wait for this line
	console.log(`[world] ready (${process.env.SPACES_MMO_WORLD || "leuchtfeuer"})`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 3000).unref(); await world.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
