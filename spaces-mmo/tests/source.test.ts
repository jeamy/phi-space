// The engine's clock and chance (server/engine/source.ts; docs/rust-portierung.en.md, R8.0 item 5): the seeded generator
// as specified (vectors another implementation must reproduce), no command or tick that reads the clock or the operating
// system's randomness past it, and the TypeScript half of R8.2's comparison: the same commands and ticks with the same
// seed and clock give the same entries in two fresh spaces, and another seed gives others.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PhiSpaces, openOwnMemoryHost, FOREVER, type SpaceLike } from "phi-spaces";
import { BACKGROUND_CONTEXT } from "phi-spaces/context";
import { mulberry32, seeded, withSource, SYSTEM, randomInt, timeNow } from "../server/engine/source.ts";
import { loadWorld } from "../server/engine/world.ts";
import { loadIntoSpace } from "../server/engine/loader.ts";
import { CommandError, execute } from "../server/engine/commands.ts";
import { spatialWorld } from "../server/engine/room-growth.ts";
import { fireTick, fogTick, floodTick, stormTick } from "../server/engine/fire.ts";
import { wildTick } from "../server/engine/commands/wild.ts";
import { windTick } from "../server/engine/commands/wind.ts";
import { gardenTick } from "../server/engine/commands/garden.ts";
import { ordersTick } from "../server/engine/commands/trade.ts";
import { WORLD_LOCK, type AccountFields, type CharacterFields } from "../server/model.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// every message an entry, so the comparison sees what each command said
process.env.SPACES_MMO_MSG_TRANSIENT = "0";

test("mulberry32 and what is drawn from it: the vectors of the specification in source.ts", () => {
	const take = (seed: number, n: number) => { const next = mulberry32(seed); return Array.from({ length: n }, () => next()); };
	assert.deepEqual(take(0, 4), [1144304738, 1416247, 958946056, 627933444]);
	assert.deepEqual(take(1, 4), [2693262067, 11749833, 2265367787, 4213581821]);
	assert.deepEqual(take(0xdeadbeef, 4), [4043151706, 1147597007, 3315858022, 1538288752]);
	const s = seeded(1);
	assert.equal(s.float(), 2693262067 / 2 ** 32);
	assert.equal(s.int(0, 10), 11749833 % 10);
	assert.equal(s.int(5, 6), 5, "a range of one still draws");
	assert.equal(seeded(1).bytes(6).toString("hex"), "f3ea87a0" + "c949");
	// rejection: with n = 3·2^30 the limit is 2^32 - 2^30 = 3·2^30; seed 0xdeadbeef's first output (4043151706) is above
	// it and drawn again, the second (1147597007) is taken
	assert.equal(seeded(0xdeadbeef).int(0, 3 * 2 ** 30), 1147597007);
	assert.throws(() => seeded(0).int(3, 3), RangeError);
	assert.equal(seeded(9, 1234).now(), 1234);
});

test("the source belongs to the call: withSource reaches what it awaits and starts, the rest keeps the real one", async () => {
	const a = seeded(1, 100), b = seeded(1, 200);
	const [x, y] = await Promise.all([
		withSource(a, async () => { await new Promise((r) => setTimeout(r, 5)); return [timeNow(), randomInt(1000)]; }),
		withSource(b, async () => { await new Promise((r) => setImmediate(r)); return [timeNow(), randomInt(1000)]; }),
	]);
	assert.deepEqual(x, [100, 2693262067 % 1000]);
	assert.deepEqual(y, [200, 2693262067 % 1000]);
	assert.ok(Math.abs(timeNow() - Date.now()) < 1000, "outside, the real clock");
	assert.equal(SYSTEM.int(0, 1), 0);
});

test("no command or tick reads the clock or the operating system's randomness past source.ts", () => {
	const dir = join(ROOT, "server/engine");
	const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".ts")).map((e) => relative(ROOT, join(e.parentPath, e.name)));
	// how long a scheduled job took is told in the log, it decides nothing
	const allowed = new Set(["server/engine/worldevents.ts:\t\tconst job = String(schedule.payload.job), t0 = Date.now();", "server/engine/worldevents.ts:\t\tif (Date.now() - t0 > SLOW_JOB_MS) console.warn(`[world] job ${job} took ${Math.round((Date.now() - t0) / 1000)} s`);"]);
	const bad = files.filter((f) => f !== "server/engine/source.ts").flatMap((f) => readFileSync(join(ROOT, f), "utf8").split("\n").map((l) => `${f}:${l}`))
		.filter((l) => /Date\.now\(|Math\.random|node:crypto|randomUUID|getRandomValues|new Date\(\)|performance\.now/.test(l) && !/^\S+:\s*(\/\/|\/\*\*|\*)/.test(l) && !allowed.has(l));
	assert.deepEqual(bad, []);
});

/** A world, two players and a list of their commands, then a round of ticks; every entry as type and fields, sorted. */
async function play(seed: number): Promise<string[]> {
	const host = openOwnMemoryHost(), space: SpaceLike = new PhiSpaces(host, BACKGROUND_CONTEXT);
	let clock = Date.UTC(2026, 10, 8, 12);
	return withSource(seeded(seed, () => clock), async () => {
		const w = await loadWorld("leuchtfeuer");
		await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER); // the space process writes it
		await loadIntoSpace(space, w);
		const start = w.rooms.find((r) => r.roomId === w.start)!;
		const people = ["anna", "bo"].map((name, i) => {
			const account: AccountFields = { accountId: `a-${name}`, name, guest: false, admin: false, createdAt: clock, touchedAt: clock };
			const actor: CharacterFields = { charId: `c-${name}`, accountId: account.accountId, name, room: start.roomId, x: start.spawn.x + i, y: start.spawn.y, skin: i, guest: false };
			return { account, actor };
		});
		for (const p of people) {
			await space.write({ type: "Account", fields: p.account as never }, null, FOREVER);
			await space.write({ type: "Character", fields: p.actor as never }, null, FOREVER);
		}
		const lines = ["schau", "inventar", "sag Hallo zusammen", "step 1 0", "step 1 0", "step 0 1", "nimm treibholz", "sammle", "wer", "zeit", "ruf", "step -1 0", "step 0 -1", "umgraben", "beet", "aussehen", "schau", "offer treibholz an bo", "lege treibholz", "nimm treibholz"];
		for (const line of lines) for (const p of people) {
			clock += 1_000;
			const txn = (await space.createTransaction(30_000)).id;
			const actor = (await space.readAll({ type: "Character", fields: { charId: p.actor.charId } }))[0]!.fields as unknown as CharacterFields;
			try {
				await execute({ space, txn, world: await spatialWorld(space, w), actor, account: p.account, msgLeaseMs: 600_000, cache: {} }, line);
				await space.commit(txn);
			} catch (e) {
				await space.abort(txn);
				if (!(e instanceof CommandError)) throw e;
			}
		}
		for (let round = 0; round < 3; round++) {
			clock += 3_600_000;
			await fireTick(space, w, 600_000); await fogTick(space, w, 600_000); await floodTick(space, w, 600_000); await stormTick(space, w, 600_000);
			await wildTick(space, w, 600_000); await windTick(space, w, 600_000); await gardenTick(space, w); await ordersTick(space, w);
		}
		const all = await space.readAll({});
		return all.map((e) => JSON.stringify([e.type, canon(e.fields)])).sort();
	});
}
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)])) : v);

test("the same seed and clock give the same world twice; another seed another one", { timeout: 120_000 }, async () => {
	const a = await play(7), b = await play(7), c = await play(8);
	assert.ok(a.length > 1000, `a world was written (${a.length} entries)`);
	const diff = (x: string[], y: string[]) => { const ys = new Set(y); return x.filter((e) => !ys.has(e)); };
	assert.deepEqual(diff(a, b).slice(0, 5), [], "only in the first run");
	assert.deepEqual(diff(b, a).slice(0, 5), [], "only in the second run");
	assert.notDeepEqual(a, c, "the seed decides what chance gives");
});
