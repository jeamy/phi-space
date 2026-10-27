// The world worker (docs/architektur.md): loads the world definition into the space (engine/loader.ts), takes
// intents oldest first and runs each command in a transaction together with taking its intent, and removes the
// characters of lapsed guest accounts. It holds no state of its own: a world worker that dies loses at most the
// command it was running, whose intent comes back when the transaction lapses. Several may run; each intent is taken
// by exactly one (an intent another one holds is invisible, so each takes the next).
//
//   SPACES_MMO_SPACE              the world space (default unix:/tmp/spaces-mmo-world.sock)
//   SPACES_MMO_WORLD              which world to load (default leuchtfeuer)
//   SPACES_MMO_MSG_LEASE_MS       how long a message stays (default 2 min: every message is an entry, and every call
//                                 costs the space time in proportion to its entries; pages get messages at once)
//   SPACES_MMO_CLEANUP_MS         how often lapsed guests are looked for (default 60 s)
//   SPACES_MMO_TXN_MS             lease of a command's transaction: how soon the work of a dead process returns (15 s)
//   SPACES_MMO_WORLD_LANES        how many characters this worker serves at once (default 16; each one's commands in order)
//   SPACES_MMO_WORLD_INTENTS=0    this worker runs no commands, only the world's dates and the sweeps: a command makes about
//                                 a dozen calls to the space one after another, so it belongs next to the space (nano)
//   SPACES_MMO_SLOW_MS            log commands answered later than this after they were typed (default off)
//   SPACES_MMO_TIME_SCALE         the starting rate of a new world's clock (docs/weltzeit.md); an existing clock keeps its rate
import "./env.ts";
import { pathToFileURL } from "node:url";
import { FOREVER, NO_WAIT } from "phi-spaces";
import { CommandError, execute } from "./engine/commands.ts";
import { msg } from "./engine/context.ts";
import { marketTick, ordersTick } from "./engine/commands/trade.ts";
import { fireTick, floodTick, fogTick, stormTick } from "./engine/fire.ts";
import { sweepTick } from "./engine/sweep.ts";
import { ensureTokens, loadIntoSpace } from "./engine/loader.ts";
import { ClockGuard, runSchedules } from "./engine/schedule.ts";
import { sweepSpots } from "./engine/occupancy.ts";
import { SCHEDULE_HANDLERS, tickHandler } from "./engine/worldevents.ts";
import { loadWorld, type WorldDef } from "./engine/world.ts";
import { actorToken, fieldsOf, type AccountFields, type CharacterFields, type IntentFields } from "./model.ts";
import { awaitWork, connectSpace, DEFAULT_SPACE, envMs, readExisting, StillHeld } from "./space.ts";

export async function startWorld(o: { space?: string; world?: WorldDef } = {}) {
	const w = o.world ?? (await loadWorld());
	const conn = connectSpace(o.space ?? (process.env.SPACES_MMO_SPACE || DEFAULT_SPACE));
	const space = conn.space;
	const msgLeaseMs = envMs("SPACES_MMO_MSG_LEASE_MS", 2 * 60_000);
	const TXN_MS = envMs("SPACES_MMO_TXN_MS", 15_000);
	const halt = new AbortController();
	const SLOW_MS = Number(process.env.SPACES_MMO_SLOW_MS ?? 0);

	// the world's recurring jobs run as dates in world time (engine/schedule.ts, worldevents.ts tickJobs): whichever worker
	// takes a due date runs the job, once
	const runs: Record<string, () => Promise<void>> = {
		fire: () => fireTick(space, w, msgLeaseMs),
		fog: () => fogTick(space, w, msgLeaseMs),
		flood: () => floodTick(space, w, msgLeaseMs),
		sweep: () => sweepTick(space),
		orders: () => ordersTick(space, w),
		market: () => marketTick(space),
		storm: async () => { await stormTick(space, w, msgLeaseMs); },
	};
	const handlers = { ...SCHEDULE_HANDLERS, tick: tickHandler(runs) };
	const loaded = await loadIntoSpace(space, w).catch((e) => { conn.close(); throw e; });
	if (loaded.loaded) console.log(`[world] loaded ${w.id} version ${w.version}${loaded.spawned.length ? `, placed ${loaded.spawned.join(", ")}` : ""}`);
	const tokens = await ensureTokens(space);
	if (tokens) console.log(`[world] wrote ${tokens} missing tokens`);

	/** In `txn`: the character's token and its oldest intent, or null (another worker has the token, or no intent is
	 *  left). Only the token's holder takes a character's intents, so all of them are visible here; a take finds the
	 *  oldest match first. */
	const claim = async (txn: string, charId: string): Promise<IntentFields | null> => {
		if (!(await space.takeIfExists(actorToken(charId), NO_WAIT, { txn }))) return null;
		const e = await space.takeIfExists({ type: "Intent", fields: { charId } }, NO_WAIT, { txn });
		return e ? fieldsOf<IntentFields>(e) : null;
	};

	/** One entry by template from the snapshot (no commit); only when none is visible, a read that waits while another
	 *  transaction holds it (a character being moved by a give, an account in the middle of its registration). */
	const one = async (tmpl: { type: string; fields: Record<string, unknown> }, waitMs: number) =>
		(await space.readAll(tmpl as never, { limit: 1 }))[0] ?? (await space.readIfExists(tmpl as never, waitMs));

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

	/** Runs the oldest intent of one character. "ran"; "held": another worker serves this character right now. */
	const serve = async (charId: string): Promise<"ran" | "held"> => {
		const t0 = Date.now(), txn = (await space.createTransaction(TXN_MS)).id;
		let actor: CharacterFields | null = null;
		try {
			const intent = await claim(txn, charId);
			// another worker serves this character right now (tokens are written with every character, and for older
			// ones when a worker starts)
			if (!intent) { await space.abort(txn); return "held"; }
			const a = await one({ type: "Character", fields: { charId } }, 5_000);
			if (a) {
				actor = fieldsOf<CharacterFields>(a);
				// a step reads the account only if a lock asks (no command sets, no lock of its own): one read less on the
				// path players use most
				const accountId = actor.accountId;
				const loadAccount = async () => { const e = await one({ type: "Account", fields: { accountId } }, 2_000); return e ? fieldsOf<AccountFields>(e) : null; };
				const account = /^step\s/.test(intent.line) ? null : await loadAccount();
				await execute({ space, txn, world: w, actor, account, ...(account ? {} : { loadAccount }), msgLeaseMs, cache: {}, ...(intent.asked ? { asked: intent.asked } : {}), ...(intent.step ? { step: intent.step } : {}) }, intent.line);
			}
			await space.write(actorToken(charId), txn, FOREVER);
			await space.commit(txn);
			if (SLOW_MS && Date.now() - intent.at > SLOW_MS) console.error(`[world] slow: ${charId} "${intent.line.slice(0, 40)}" ${Date.now() - intent.at} ms after it was typed, ${Date.now() - t0} ms to run`);
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
	};

	// Lanes: up to LANES characters are served at once (each character's commands one after another, in order). Every
	// character with waiting intents gets a lane in turn, the one waiting longest first, so a character that types a
	// lot holds one lane and no one waits behind its queue.
	const LANES = Math.max(1, Math.floor(envMs("SPACES_MMO_WORLD_LANES", 16)));
	const busy = new Set<string>(); // characters a lane of this worker serves now
	const heldElsewhere = new Map<string, number>(); // character -> until when another worker is assumed to serve it
	let laneDone: () => void = () => {};
	const takesIntents = process.env.SPACES_MMO_WORLD_INTENTS !== "0";
	const loop = (async () => {
		while (takesIntents && !halt.signal.aborted) {
			try {
				const free = LANES - busy.size;
				const settled = new Promise<void>((r) => (laneDone = r));
				if (free > 0) {
					// the oldest intents, a few per free lane (the gateway caps what an account sends, so a window this small
					// reaches every character that waits; a larger one would make each look cost the space more when it is busiest)
					const pending = await space.readAll({ type: "Intent" }, { limit: Math.max(8, free * 4) });
					if (!pending.length && !busy.size) { await awaitWork(space, { type: "Intent" }, halt.signal); continue; }
					const now = Date.now(), chars: string[] = [];
					for (const p of pending) {
						const charId = String(p.fields.charId);
						if (busy.has(charId) || chars.includes(charId) || (heldElsewhere.get(charId) ?? 0) > now) continue;
						chars.push(charId);
						if (chars.length >= free) break;
					}
					for (const charId of chars) {
						busy.add(charId);
						void serve(charId).then((r) => { if (r === "held") heldElsewhere.set(charId, Date.now() + 20); else heldElsewhere.delete(charId); }, () => {})
							.finally(() => { busy.delete(charId); laneDone(); });
					}
					if (chars.length) continue; // look for more work while these run
					// every waiting character is served (here or by another worker): wait for a lane or a moment
					await Promise.race([settled, new Promise((r) => setTimeout(r, busy.size ? 50 : 20))]);
					continue;
				}
				await settled;
			} catch (e) {
				if (halt.signal.aborted) break;
				console.error("[world] intent loop:", (e as Error).message);
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
		while (busy.size) await new Promise<void>((r) => { laneDone = r; setTimeout(r, 100); });
	})();

	// the world's dates (engine/schedule.ts): whichever worker takes a due one serves it, once
	const guard = new ClockGuard({ toleranceMs: envMs("SPACES_MMO_CLOCK_TOLERANCE_MS", 5 * 60_000) });
	const scheduling = (async () => {
		while (!halt.signal.aborted) {
			let wait = 1000;
			try { wait = await runSchedules(space, handlers, { txnMs: TXN_MS, maxWaitMs: 1000, guard }); }
			catch (e) { if (!halt.signal.aborted) console.error("[world] schedules:", (e as Error).message); }
			await new Promise<void>((r) => { const t = setTimeout(r, wait); halt.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });
		}
	})();

	/** Characters of guest accounts that lapsed are removed, with what they carried, their cell and what they gave to
	 *  the fires (else every guest that ever played would stay in the space, and every read of a type would read them).
	 *  An account held by a transaction (a registration in progress) is skipped this round. */
	const cleanup = async () => {
		for (const c of await space.readAll({ type: "Character", fields: { guest: true } })) {
			const ch = fieldsOf<CharacterFields>(c);
			try {
				if (await readExisting(space, { type: "Account", fields: { accountId: ch.accountId } })) continue;
			} catch (e) { if (e instanceof StillHeld) continue; throw e; }
			await space.takeIfExists({ type: "Character", id: c.id }, NO_WAIT);
			await space.takeIfExists(actorToken(ch.charId), NO_WAIT);
			for (const type of ["Item", "Spot", "Contribution"]) {
				const key: Record<string, string> = type === "Item" ? { location: ch.charId } : { charId: ch.charId };
				for (const e of await space.readAll({ type, fields: key })) await space.takeIfExists({ type, id: e.id }, NO_WAIT);
			}
		}
	};
	const sweep = setInterval(() => void cleanup().catch((e) => console.error("[world] cleanup:", (e as Error).message)), envMs("SPACES_MMO_CLEANUP_MS", 60_000));
	sweep.unref?.();
	// the cells of characters that went offline (engine/occupancy.ts): they block nobody, but every read of a room's cells reads them
	const spots = setInterval(() => void sweepSpots(space).catch((e) => console.error("[world] spots:", (e as Error).message)), envMs("SPACES_MMO_SPOT_SWEEP_MS", 30_000));
	spots.unref?.();

	return {
		space,
		cleanup,
		async close() { halt.abort(); clearInterval(sweep); clearInterval(spots); await loop; await scheduling; conn.close(); },
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
