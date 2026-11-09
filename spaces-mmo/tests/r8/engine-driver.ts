// The frozen TypeScript engine as a process (docs/rust-portierung.en.md, R8.2): one JSON line in, one JSON line out, so the
// Rust engine (rust/mmo-engine, tests/engine_walk.rs) can be held against it step by step on a space of its own.
//
//   node --experimental-strip-types --no-warnings tests/r8/engine-driver.ts <oracle root> <space address> <seed> <clock ms>
//
// The engine is imported from the oracle (the frozen commit, unpacked by rust/mmo-engine/tests/common); the clock and chance are a seeded source
// (server/engine/source.ts) whose clock is the driver's, moved by the steps. The environment (SPACES_MMO_*) is the
// caller's: rust/mmo-engine/tests/common sets it for both engines.
// In:  {"op": "clock", "at": ms} | {"op": "load", "world": "leuchtfeuer", "replace"?: bool} | {"op": "dump"}
//      | {"op": "tick", "world": "leuchtfeuer", "job": "fire" | "fog" | "flood" | "orders" | "market"}: a recurring job as the world worker runs
//      it (server/world-host.ts `runs`: in stableTerrain, on spatialWorld), its messages kept MSG_LEASE_MS (10 min)
//      | {"op": "player", "account": {...}, "char": {...}, "session"?: id}: an account, its character and its token as the
//      accounts write them (server/accounts.ts; given whole, so neither side draws from the source), a Session when online
//      | {"op": "write", "entry": {...}, "lease"?: ms}: an entry written as it is (the state a walk needs: a Spot, an Offer)
//      | {"op": "take", "template": {...}}: one entry taken away (true when there was one)
//      | {"op": "cmd", "charId", "intentId", "line", "step"?, "asked"?, "lang"?}: an Intent as the gateway (or the model
//      process, with `asked`) writes it, then the character's
//      oldest intent served as the world worker does (server/world-host.ts `serve`, copied below): "ran", "held",
//      "refused: <text>" or "failed: <text>". R8_SERVE=plain|batch|mirror (default mirror, as in production) picks its path.
// Out: {"ok": true, "result"?: ...} or {"ok": false, "error": "<message>"}; "dump": every entry as the JSON text of
//      [type, types, fields] with the keys sorted, in the order the space lists them.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [root, address, seedText, clockText] = process.argv.slice(2);
if (!root || !address || !seedText || !clockText) throw new Error("usage: engine-driver.ts <oracle root> <space address> <seed> <clock ms>");
const from = (p: string) => import(pathToFileURL(join(root, "spaces-mmo", p)).href);

const source = await from("server/engine/source.ts");
const { loadWorld } = await from("server/engine/world.ts");
const { loadIntoSpace } = await from("server/engine/loader.ts");
const { WORLD_LOCK } = await from("server/model.ts");
const { connectSpace } = await from("server/space.ts");
const { stableTerrain, spatialWorld } = await from("server/engine/room-growth.ts");
const { fireTick, chainTick, fogTick, floodTick } = await from("server/engine/fire.ts");
const { ordersTick, marketTick } = await from("server/engine/commands/trade.ts");
const { byPeoplesPace } = await from("server/engine/clock.ts");
const { execute, CommandError } = await from("server/engine/commands.ts");
const { msg } = await from("server/engine/context.ts");
const { pinTerrain } = await from("server/engine/room-growth.ts");
const { actorToken, fieldsOf } = await from("server/model.ts");
const { batching, bufferedTxn, Mirror } = await from("server/space.ts");
const { FOREVER, NO_WAIT } = await import("phi-spaces");

let clock = Number(clockText);
const MSG_LEASE_MS = 600_000;
const space = connectSpace(address).space;

const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)])) : v);
const SERVE = process.env.R8_SERVE ?? "mirror";
const TXN_MS = 15_000;

// server/world-host.ts at the frozen commit: begin, finishing, one, refuse and serve, as they are there (`refused` and
// `failed` returned instead of logged)
const batch = SERVE === "plain" ? null : await batching(space);
const mirror = batch && SERVE === "mirror" ? new Mirror(space) : null;
const claim = async (txn: string, charId: string) => {
	if (!(await space.takeIfExists(actorToken(charId), NO_WAIT, { txn }))) return null;
	const e = await space.takeIfExists({ type: "Intent", fields: { charId } }, NO_WAIT, { txn });
	return e ? fieldsOf(e) : null;
};
const begin = async (charId: string) => {
	if (!batch) {
		const txn = (await space.createTransaction(TXN_MS)).id;
		try { await pinTerrain(space, txn); return { txn, intent: await claim(txn, charId) }; }
		catch (e) { await space.abort(txn).catch(() => {}); throw e; }
	}
	const [t, terrain, token] = await batch.batch([{ op: "begin", lease: TXN_MS }, { op: "read", template: WORLD_LOCK, txn: "$" }, { op: "take", template: actorToken(charId), txn: "$" }]);
	if (!terrain.entry || !token.entry) return { txn: t.id, intent: null };
	const intent = await space.takeIfExists({ type: "Intent", fields: { charId } }, NO_WAIT, { txn: t.id });
	return { txn: t.id, intent: intent ? fieldsOf(intent) : null };
};
const finishing = (txn: string, charId: string) => {
	if (!batch) return { space, async commit() { await space.write(actorToken(charId), txn, FOREVER); await space.commit(txn); } };
	const b = bufferedTxn(batch, txn, mirror);
	return { space: b.space, commit: () => b.commit([{ op: "write", entry: actorToken(charId), txn, lease: FOREVER }]) };
};
const one = async (tmpl: { type: string; fields: Record<string, unknown> }, waitMs: number) =>
	(mirror ? mirror.readAll(tmpl, 1) : await space.readAll(tmpl, { limit: 1 }))[0] ?? (await space.readIfExists(tmpl, waitMs));
const refuse = async (actor: Record<string, unknown>, text: string) => {
	let txn: string | null = null;
	try {
		const b = await begin(String(actor.charId));
		txn = b.txn;
		if (!b.intent) { await space.abort(txn); return; }
		const end = finishing(txn!, String(actor.charId));
		await msg({ space: end.space, txn, actor, msgLeaseMs: MSG_LEASE_MS }, actor.charId, "error", text);
		await end.commit();
	} catch { if (txn) await space.abort(txn).catch(() => {}); }
};
const serve = async (w: unknown, charId: string): Promise<string> => {
	const { txn, intent } = await begin(charId);
	let actor: Record<string, unknown> | null = null;
	try {
		if (!intent) { await space.abort(txn); return "held"; }
		await mirror?.fresh();
		const a = await one({ type: "Character", fields: { charId } }, 5_000);
		const end = finishing(txn, charId);
		if (a) {
			actor = fieldsOf(a);
			const accountId = actor!.accountId;
			const loadAccount = async () => { const e = await one({ type: "Account", fields: { accountId } }, 2_000); return e ? fieldsOf(e) : null; };
			const account = /^step\s/.test(intent.line) ? null : await loadAccount();
			await execute({ space: end.space, txn, world: await spatialWorld(end.space, w), actor, account, ...(account ? {} : { loadAccount }), msgLeaseMs: MSG_LEASE_MS, cache: {}, ...(intent.asked ? { asked: intent.asked } : {}), ...(intent.lang ? { lang: intent.lang } : {}), ...(intent.step ? { step: intent.step } : {}) }, intent.line);
		}
		await end.commit();
		return "ran";
	} catch (e) {
		await space.abort(txn).catch(() => {});
		if (e instanceof CommandError) { const m = (e as Error).message; if (actor) await refuse(actor, m); return `refused: ${m}`; }
		return `failed: ${(e as Error).message}`;
	}
};

const worlds = new Map<string, unknown>();
const world = async (id: string) => { if (!worlds.has(id)) worlds.set(id, await loadWorld(id)); return worlds.get(id); };

async function step(line: Record<string, unknown>): Promise<unknown> {
	switch (line.op) {
		case "clock": clock = Number(line.at); return null;
		case "load": {
			const w = await world(String(line.world));
			if (!(await space.readIfExists(WORLD_LOCK, 0))) await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER); // the space process writes it
			return await loadIntoSpace(space, w, { replace: !!line.replace });
		}
		case "tick": {
			const w = await world(String(line.world)), msgLeaseMs = MSG_LEASE_MS;
			const job = (fn: (live: unknown) => Promise<void>) => () => stableTerrain(space, async () => fn(await spatialWorld(space, w)));
			// server/world-host.ts at the frozen commit, the jobs ported so far
			const runs: Record<string, () => Promise<void>> = {
				fire: job(async (live) => { await fireTick(space, live, msgLeaseMs); await chainTick(space, live, msgLeaseMs); }),
				fog: job((live) => fogTick(space, live, msgLeaseMs)),
				flood: job(async (live) => { if (await byPeoplesPace(space)) await floodTick(space, live, msgLeaseMs); }),
				orders: job((live) => ordersTick(space, live)),
				market: job((live) => marketTick(space, live)),
			};
			const run = runs[String(line.job)];
			if (!run) throw new Error(`unknown job ${String(line.job)}`);
			await run();
			return null;
		}
		case "player": {
			const txn = (await space.createTransaction(10_000)).id;
			try {
				await pinTerrain(space, txn);
				await space.write({ type: "Account", fields: line.account }, txn, FOREVER);
				await space.write({ type: "Character", fields: line.char }, txn, FOREVER);
				await space.write(actorToken((line.char as { charId: string }).charId), txn, FOREVER);
				await space.commit(txn);
			} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
			if (line.session) await space.write({ type: "Session", fields: { sessionId: line.session, charId: (line.char as { charId: string }).charId, accountId: (line.account as { accountId: string }).accountId } }, null, FOREVER);
			return null;
		}
		case "cmd": {
			const w = await world(String(line.world ?? "leuchtfeuer"));
			await space.write({ type: "Intent", fields: { intentId: line.intentId, charId: line.charId, line: line.line, at: clock, ...(line.step ? { step: line.step } : {}), ...(line.asked ? { asked: line.asked } : {}), ...(line.lang ? { lang: line.lang } : {}) } }, null, 30_000);
			return await serve(w, String(line.charId));
		}
		case "write": await space.write(line.entry, null, line.lease ?? FOREVER); return null;
		case "take": return !!(await space.takeIfExists(line.template, NO_WAIT));
		case "dump": return (await space.readAll({})).map((e: { type: string; types: string[]; fields: unknown }) => JSON.stringify([e.type, e.types, canon(e.fields)]));
		default: throw new Error(`unknown op ${String(line.op)}`);
	}
}

await source.withSource(source.seeded(Number(seedText), () => clock), async () => {
	for await (const text of createInterface({ input: process.stdin })) {
		if (!text.trim()) continue;
		let out: unknown;
		try { out = { ok: true, result: await step(JSON.parse(text)) }; }
		catch (e) { out = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
		process.stdout.write(JSON.stringify(out) + "\n");
	}
});
process.exit(0);
