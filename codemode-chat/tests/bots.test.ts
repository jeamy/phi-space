// Bot tasks (server/bottask.ts, docs/codemode-anwendungen.en.md B): the judge opens a world in the arena, the bot plays
// it through look/act/wait, the arena says whether the goal was reached. Here the arena is tests/fake-arena.ts (the
// same JSON lines; spaces-mmo/tests/arena.test.ts holds the real one). Only judges with an arena take bot candidates.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./stack.ts";
import { startFakeArena } from "./fake-arena.ts";
import { episodeEntries, judge, loadCodemode, memoryEntries, verdictFields } from "../server/judge.ts";
import { covers, JUMP_CELLS, recall, type MemoryPath } from "../server/memory.ts";
import { teamPrompt } from "../server/llm.ts";
import { laneOf } from "../server/room.ts";
import { offeredTasks, taskById, TASKS } from "../server/tasks.ts";
import { ISLAND_ROOMS } from "../server/island.ts";
import { ArenaDown, MAX_BOT_CALLS } from "../server/bottask.ts";
import { execute } from "../server/runner.ts";

const cm = await loadCodemode();
const t = cm ? test : test.skip;
const task = taskById("beacon-bucht")!;
const [direct, looksAlways, noWood, farAway] = task.variants;

/** CODEMODE_ARENA for the length of `fn` (this process: the judge function and the catalog read it). */
async function withArena<T>(address: string, fn: () => Promise<T>): Promise<T> {
	const was = process.env.CODEMODE_ARENA;
	process.env.CODEMODE_ARENA = address;
	try { return await fn(); } finally { process.env.CODEMODE_ARENA = was ?? ""; }
}

t("the bot variants in a world each: the direct bot is cheapest, the wrong ones miss the goal", async () => {
	const arena = await startFakeArena();
	try {
		const [a, b, c, d] = await withArena(arena.address, () => Promise.all([direct, looksAlways, noWood, farAway].map((v) => judge(cm!, task, v!))));
		for (const v of [a!, b!]) { assert.equal(v.ok, true, v.error ?? ""); assert.equal(v.passed, 1); assert.equal(v.score, 1); }
		assert.deepEqual([a!.cost, a!.calls], [5, { look: 1, act: 4 }]);
		assert.deepEqual([b!.cost, b!.calls], [9, { look: 5, act: 4 }]);
		for (const v of [c!, d!]) { assert.equal(v.ok, false); assert.match(v.error!, /goal not reached: feuer-bucht is out/); }
		assert.equal(arena.opened(), 4, "a world per contribution");
		assert.equal(arena.open(), 0, "every world closed again");
	} finally { await arena.close(); }
});

t("a bot that throws, one beyond the call cap, and a judge without an arena", async () => {
	const arena = await startFakeArena();
	try {
		const [boom, storm] = await withArena(arena.address, () => Promise.all([
			judge(cm!, task, `async function bot(){await tools.look();throw new Error("lost my way")}`),
			judge(cm!, task, `async function bot(){for(;;)await tools.look()}`),
		]));
		assert.equal(boom!.ok, false); assert.match(boom!.error!, /lost my way \(calls: look 1 = 1 points\)/);
		assert.equal(storm!.ok, false); assert.match(storm!.error!, new RegExp(`more than ${MAX_BOT_CALLS} tool calls`));
		assert.equal(arena.open(), 0);
		const none = await withArena("", () => judge(cm!, task, direct!));
		assert.equal(none.ok, false); assert.match(none.error!, /no arena/);
	} finally { await arena.close(); }
});

t("▶ does not run a bot: it needs a world of its own", async () => {
	await assert.rejects(execute(cm! as never, task, direct!, "", () => {}, new AbortController().signal), /runs only when it is judged/);
});

t("the arena's own trouble is no verdict: unreachable, or gone in the middle, the judge gives the candidate back", async () => {
	await withArena("unix:/nowhere/arena.sock", () => assert.rejects(judge(cm!, task, direct!), ArenaDown));
	const arena = await startFakeArena({ dropOnAct: true });
	try { await withArena(arena.address, () => assert.rejects(judge(cm!, task, direct!), ArenaDown)); } finally { await arena.close(); }
});

test("bot tasks: their own lane, offered only with an arena, the prompt names the tools and the rule", () => {
	assert.equal(laneOf("beacon-bucht"), "bot");
	assert.equal(laneOf("frustration"), "code");
	assert.equal(laneOf("custom"), "code");
	process.env.CODEMODE_ARENA = "";
	assert.equal(offeredTasks().some((x) => x.kind === "bot"), false, "no arena: no bot task in the catalog");
	process.env.CODEMODE_ARENA = "unix:/nowhere";
	try { assert.equal(offeredTasks().some((x) => x.id === "beacon-bucht"), true); } finally { process.env.CODEMODE_ARENA = ""; }
	const p = teamPrompt({ task, lang: "en", agent: 0, gen: 1 }).user;
	assert.match(p, /tools\.act\(args\)/);
	assert.match(p, /fewest points/);
});

t("only a judge with an arena takes bot candidates; a run ends with the cheapest bot as best", async () => {
	const arena = await startFakeArena();
	process.env.CODEMODE_ARENA = arena.address; // the web process (in this test process) offers the bot task
	// two judges without an arena come first: neither may take a bot candidate
	const srv = await startServer({ port: 0, bind: "127.0.0.1", judges: [{ host: "plain-1" }, { host: "plain-2" }, { host: "arena", arena: arena.address, workers: 1 }] });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/bots1/task", { taskId: "beacon-bucht" })).status, 200);
		for (const [author, source] of [["direkt", direct], ["vorsichtig", looksAlways], ["ohneholz", noWood]] as const) assert.equal((await post("/api/sessions/bots1/code", { author, source })).status, 200);
		let snap: any;
		for (const end = Date.now() + 60_000; ;) {
			const s = await (await fetch(srv.url + "/api/sessions/bots1")).json() as any;
			snap = { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) };
			if (snap.contributions?.length === 3 && snap.contributions.every((c: any) => c.ok !== null) && snap.best) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(snap.contributions)}`);
			await new Promise((r) => setTimeout(r, 100));
		}
		const by = Object.fromEntries(snap.contributions.map((c: any) => [c.author, c]));
		assert.deepEqual([by.direkt.ok, by.vorsichtig.ok, by.ohneholz.ok], [true, true, false]);
		assert.ok(snap.contributions.every((c: any) => c.host === "arena"), JSON.stringify(snap.contributions.map((c: any) => c.host)));
		assert.equal(snap.best.candidateId, by.direkt.candidateId);
	} finally { await srv.close(); await arena.close(); process.env.CODEMODE_ARENA = ""; }
});

t("a scripted run on the bot task ends with the cheapest bot as best, its summary in tool points", async () => {
	const arena = await startFakeArena();
	process.env.CODEMODE_ARENA = arena.address;
	const srv = await startServer({ port: 0, bind: "127.0.0.1", judges: [{ host: "arena", arena: arena.address }] });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/botrun/task", { taskId: "beacon-bucht" })).status, 200);
		assert.equal((await post("/api/sessions/botrun/run", { agents: 3, gens: 2, perAgent: 1, contenders: ["scripted"] })).status, 200);
		let snap: any;
		for (const end = Date.now() + 90_000; ;) {
			const s = await (await fetch(srv.url + "/api/sessions/botrun")).json() as any;
			snap = { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) };
			if (snap.run && !snap.run.active && snap.contributions?.length >= 3 && snap.contributions.every((c: any) => c.ok !== null) && snap.best && snap.messages.some((m: any) => /^Run /.test(m.text))) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify([snap.run, snap.contributions?.map((c: any) => [c.author, c.ok, c.cost, c.error]), (await srv.stack.space.readAll({ type: "CodeCandidate" })).map((e: any) => [e.fields.author, e.fields.lane]), (await srv.stack.space.readAll({ type: "CodeJudging" })).map((e: any) => e.fields.author)])}`);
			await new Promise((r) => setTimeout(r, 100));
		}
		const correct = snap.contributions.filter((c: any) => c.ok);
		assert.ok(correct.length > 0);
		assert.equal(snap.contributions.find((c: any) => c.candidateId === snap.best.candidateId).cost, Math.min(...correct.map((c: any) => c.cost)));
		assert.ok(snap.messages.some((m: any) => /tool points/.test(m.text)), JSON.stringify(snap.messages.map((m: any) => m.text)));
	} finally { await srv.close(); await arena.close(); process.env.CODEMODE_ARENA = ""; }
});

// ---- a planning task (docs/codemode-planung.en.md, step 1): episodes, the hidden ones after the shown ones, a goal that holds
const island = taskById("beacon-insel")!;
const [explorer, careful, memorizer, startRoom, noWoodAtAll] = island.variants;

t("a planning task plays every episode in a world of its own: the explorer reaches all, the memorizer only the shown ones", async () => {
	const arena = await startFakeArena();
	try {
		const [a, b, m, s] = await withArena(arena.address, async () => { const out = []; for (const v of [explorer, careful, memorizer, startRoom]) out.push(await judge(cm!, island, v!)); return out; });
		for (const v of [a!, b!]) { assert.equal(v.ok, true, v.error ?? ""); assert.deepEqual([v.passed, v.total, v.score], [9, 9, 1]); }
		assert.ok(a!.cost! < b!.cost!, "looking after every step costs points");
		assert.equal(m!.ok, false);
		assert.deepEqual([m!.passed, m!.score], [3, 0], "the three shown episodes, none of the hidden");
		assert.match(m!.error!, /6 of 6 hidden episodes not reached/);
		assert.deepEqual([s!.passed, s!.score], [7, 0.667]);
		assert.deepEqual(s!.episodes!.filter((e) => !e.reached[0]).map((e) => e.id), ["H3", "H6"], "the driftwood lay in another room");
		// one world per episode (no wait, one seed), every one closed; the last one opened with its episode's start and setup
		assert.equal(arena.opened(), 4 * 9);
		assert.equal(arena.open(), 0);
		assert.deepEqual(arena.lastOpen()!.start, { room: "graue-bucht", x: 14, y: 9 });
		assert.equal(arena.lastOpen()!.seed, undefined, "no seed without wait");
		// a hidden episode says reached or not, nothing else; a shown one keeps the arena's detail
		const hidden = m!.episodes!.filter((e) => e.kind === "holdout");
		assert.ok(hidden.every((e) => e.detail === undefined && e.reached.length === 1));
		assert.ok(m!.cases.filter((c) => c.call.startsWith("hidden")).every((c) => c.error === "not reached" || c.got === "reached"));
		assert.ok(m!.episodes!.filter((e) => e.kind === "sample").every((e) => typeof e.detail === "string"));
	} finally { await arena.close(); }
});

t("the hidden episodes do not run when no shown one was reached; the prompt shows the shown ones only, and no wait", async () => {
	const arena = await startFakeArena();
	try {
		const v = await withArena(arena.address, () => judge(cm!, island, noWoodAtAll!));
		assert.equal(v.ok, false);
		assert.equal(arena.opened(), 3, "only the three shown episodes");
		assert.deepEqual(v.episodes!.filter((e) => e.skipped).map((e) => e.id), ["H1", "H2", "H3", "H4", "H5", "H6"]);
		assert.match(v.error!, /^S1: goal not reached/);
		// a bot that calls wait has no such tool here
		const w = await withArena(arena.address, () => judge(cm!, island, `async function bot(){await tools.wait({minutes:5})}`));
		assert.equal(w.ok, false);
		assert.doesNotMatch(island.prompt.en, /tools\.wait\(args\)/);
		for (const e of island.bot!.episodes!) assert.equal(island.prompt.en.includes(e.text.en), e.kind === "sample", e.id);
	} finally { await arena.close(); }
});

t("a fire fed and then left burns out: the goal must still hold after the judge's 5 world minutes", async () => {
	const arena = await startFakeArena();
	try {
		// feeds the fire, then waits it out (beacon-bucht has wait): with hold 5 the episode would not count
		const v = await withArena(arena.address, () => judge(cm!, { ...island, bot: { ...island.bot!, noWait: undefined, episodes: island.bot!.episodes!.slice(0, 1) } }, `async function bot(){const s=await tools.look();const w=s.things[0];await tools.act({line:"move "+w.x+" "+w.y});await tools.act({line:"nimm treibholz"});await tools.act({line:"move 9 9"});await tools.act({line:"lege holz ins feuer"});await tools.wait({minutes:8})}`));
		assert.equal(v.ok, false);
		assert.match(v.error!, /not held 5 world minutes/);
		assert.equal(v.episodes![0]!.reached.length, 3, "a task with wait runs three seeds");
		assert.deepEqual(arena.lastOpen()!.seed, 1002);
	} finally { await arena.close(); }
});

// ---- step 2: the paths of the shown episodes, the rooms they cross, the room map's data
t("a shown episode keeps its way, a hidden one none; the verdict entry carries no path, BotEpisode does", async () => {
	const arena = await startFakeArena();
	try {
		const v = await withArena(arena.address, () => judge(cm!, island, explorer!));
		assert.equal(v.ok, true, v.error ?? "");
		assert.equal(arena.paths(), 3, "the arena is asked for the way of the three shown episodes only");
		const shown = v.episodes!.filter((e) => e.kind === "sample"), hidden = v.episodes!.filter((e) => e.kind === "holdout");
		assert.ok(hidden.every((e) => e.path === undefined));
		const s3 = shown.find((e) => e.id === "S3")!;
		assert.deepEqual(s3.path![0], ["klippenpfad", 2, 8], "from the episode's start");
		assert.ok(s3.path!.some((p) => p[0] === "graue-bucht"));
		assert.deepEqual(s3.path!.at(-1), ["graue-bucht", 9, 9], "to the fire");
		// the rooms the paths cross, from the arena's map
		assert.deepEqual(v.rooms!.map((r) => r.room), ["fischerdorf", "graue-bucht", "klippenpfad"]);
		assert.deepEqual(v.rooms!.find((r) => r.room === "graue-bucht")!.fires, [{ beaconId: "feuer-bucht", x: 9, y: 10 }]);
		// the CodeScore entry stays small: no path, no rooms; the BotEpisode entries have them
		const f = verdictFields(v) as Record<string, any>;
		assert.equal(f.rooms, undefined);
		assert.ok(f.episodes.every((e: any) => e.path === undefined));
		assert.deepEqual(episodeEntries(v).map((e) => e.episode), ["S1", "S2", "S3"]);
		// a second verdict asks the arena for no room again (the judge remembers them)
		const maps = arena.maps();
		await withArena(arena.address, () => judge(cm!, island, careful!));
		assert.equal(arena.maps(), maps);
	} finally { await arena.close(); }
});

t("no hidden episode lies on a shown one's way: its driftwood is in a room no shown episode passes, for every planning task", () => {
	const near = (a: { room: string; x: number; y: number }, b: { room: string; x: number; y: number }) => a.room === b.room && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= 3;
	const planning = TASKS.filter((x) => x.bot?.episodes?.length);
	assert.ok(planning.length > 0);
	for (const task of planning) {
		const eps = task.bot!.episodes!, shown = eps.filter((e) => e.kind === "sample"), hidden = eps.filter((e) => e.kind === "holdout");
		const cells = (e: typeof eps[number]) => [...(e.start ? [e.start] : []), ...(e.setup?.items ?? [])];
		for (const h of hidden) for (const c of h.setup?.items ?? []) for (const s of shown) for (const d of cells(s)) assert.ok(!near(c, d), `${task.id} ${h.id}: ${c.room} ${c.x},${c.y} is near ${s.id}`);
	}
	// the island: the shortest way of every shown episode (start, driftwood, fire) enters no room a hidden piece lies in
	const route = (a: string, b: string): string[] => {
		const prev = new Map<string, string | null>([[a, null]]), q = [a];
		while (q.length) { const r = q.shift()!; if (r === b) break; for (const d of Object.values(ISLAND_ROOMS[r]!.exits)) if (!prev.has(d)) { prev.set(d, r); q.push(d); } }
		const out: string[] = []; for (let r: string | null = b; r; r = prev.get(r) ?? null) out.unshift(r); return out;
	};
	const eps = island.bot!.episodes!, hiddenRooms = new Set(eps.filter((e) => e.kind === "holdout").flatMap((e) => (e.setup?.items ?? []).map((i) => i.room)));
	for (const s of eps.filter((e) => e.kind === "sample")) {
		const wood = s.setup!.items![0]!.room, way = [...route(s.start!.room, wood), ...route(wood, "graue-bucht")];
		assert.ok(way.every((r) => !hiddenRooms.has(r)), `${s.id}: ${way.join(" → ")}`);
	}
});

t("the panel of a planning contribution gets its paths and the rooms' geometry; deleting the block takes the paths along", async () => {
	const arena = await startFakeArena();
	process.env.CODEMODE_ARENA = arena.address;
	const srv = await startServer({ port: 0, bind: "127.0.0.1", judges: [{ host: "arena", arena: arena.address, workers: 1 }] });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/paths1/task", { taskId: "beacon-insel" })).status, 200);
		assert.equal((await post("/api/sessions/paths1/code", { author: "erkunder", source: explorer })).status, 200);
		let snap: any;
		for (const end = Date.now() + 60_000; ;) {
			const s = await (await fetch(srv.url + "/api/sessions/paths1")).json() as any;
			snap = { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) };
			if (snap.contributions?.length === 1 && snap.contributions[0].ok !== null) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(snap.contributions)}`);
			await new Promise((r) => setTimeout(r, 100));
		}
		const c = snap.contributions[0];
		assert.equal(c.ok, true, c.error);
		// the snapshot's task names the shown episodes' cells (for the marks on the map), the hidden ones' not
		const shown = snap.task.episodes.filter((e: any) => e.kind === "sample");
		assert.deepEqual(shown[0].start, { room: "graue-bucht", x: 10, y: 8 });
		assert.deepEqual(shown[0].items, [{ proto: "treibholz", room: "graue-bucht", x: 5, y: 7 }]);
		assert.ok(snap.task.episodes.filter((e: any) => e.kind === "holdout").every((e: any) => e.start === undefined && e.items === undefined));
		const d = await (await fetch(`${srv.url}/api/sessions/paths1/source/${c.candidateId}`)).json() as any;
		assert.deepEqual(d.paths.map((p: any) => p.episode), ["S1", "S2", "S3"]);
		assert.deepEqual(d.paths[2].path[0], ["klippenpfad", 2, 8]);
		assert.deepEqual(d.rooms.map((r: any) => r.room).sort(), ["fischerdorf", "graue-bucht", "klippenpfad"]);
		assert.equal(d.rooms[0].ground.length, 16);
		assert.equal(await srv.stack.space.count({ type: "BotEpisode" }), 3);
		// deleting the block takes the paths with it; the rooms stay for the next block
		assert.equal((await post("/api/sessions/paths1/delete", { blockId: snap.current })).status, 200);
		assert.equal(await srv.stack.space.count({ type: "BotEpisode" }), 0);
		assert.equal(await srv.stack.space.count({ type: "BotRoom" }), 3);
	} finally { await srv.close(); await arena.close(); process.env.CODEMODE_ARENA = ""; }
});

// ---- step 3: the memory, recall from a freeze, coverage
const memTask = taskById("beacon-insel-memory")!;
const [mExplorer, mRecaller, mReplayer, mNoWood] = memTask.variants;
const asMemory = (v: Awaited<ReturnType<typeof judge>>, gen = 1): MemoryPath[] => memoryEntries(v, memTask.bot!.goal).map((m) => ({ ...m, gen, author: "a" }));

test("recall: the nearest remembered cell, along a path to its end, a jump to another path costs 10 cells", () => {
	const goal = "beacon:x";
	const a: MemoryPath = { memoryId: "a", gen: 1, author: "a", episode: "S1", goal, path: [["r", 0, 0], ["r", 5, 0], ["s", 1, 1]] };
	const b: MemoryPath = { memoryId: "b", gen: 1, author: "b", episode: "S2", goal, path: [["q", 0, 0], ["q", 9, 9], ["r", 6, 1]] };
	const one = recall([a], goal, { room: "r", x: 1, y: 0 });
	assert.ok(one.found);
	assert.deepEqual([one.from, one.distance, one.jumps, one.steps], [["r", 0, 0], 1, 0, [["r", 0, 0], ["r", 5, 0], ["s", 1, 1]]]);
	// from q: b leads into r, where it ends; a jump onto a would go further: b's own end is cheaper
	const two = recall([a, b], goal, { room: "q", x: 0, y: 0 });
	assert.ok(two.found && two.jumps === 0 && two.steps.at(-1)![0] === "r");
	// a path whose own end lies far: the way jumps over to a (2 cells apart) and on to a's end, 10 cells for the jump
	const d: MemoryPath = { memoryId: "d", gen: 2, author: "d", episode: "S3", goal, path: [["q", 0, 0], ["r", 6, 1], ["r", 22, 1]] };
	const three = recall([a, d], goal, { room: "q", x: 0, y: 0 });
	assert.ok(three.found);
	assert.deepEqual([three.jumps, three.cost, three.links, three.steps.at(-1)], [1, 1 + JUMP_CELLS + 2 + 1, [[["r", 6, 1], ["r", 5, 0]]], ["s", 1, 1]]);
	assert.equal(recall([a], goal, { room: "elsewhere", x: 0, y: 0 }).found, false);
	assert.equal(recall([a], "beacon:y", { room: "r", x: 0, y: 0 }).found, false, "only paths of that goal");
	assert.equal(covers([a], goal, { room: "r", x: 3, y: 0 }), true);
	assert.equal(covers([a], goal, { room: "r", x: 2, y: 9 }), false, "more than 3 cells from every remembered cell");
});

t("with memory: a correct contribution's shown paths are remembered, recall answers from them, coverage counts the hidden starts they reach", async () => {
	const arena = await startFakeArena();
	try {
		// an empty memory: the explorer is correct, covers nothing, and its three shown paths would be remembered
		const first = await withArena(arena.address, () => judge(cm!, memTask, mExplorer!, { memory: [] }));
		assert.equal(first.ok, true, first.error ?? "");
		assert.equal(first.coverage, 0);
		const memory = asMemory(first);
		assert.deepEqual(memory.map((m) => m.episode), ["S1", "S2", "S3"]);
		// the replayer has nothing to replay without a memory
		const empty = await withArena(arena.address, () => judge(cm!, memTask, mReplayer!, { memory: [] }));
		assert.deepEqual([empty.passed, empty.score], [0, 0]);
		// with it: the recaller is still correct and recalls once per episode; the memory covers H6 (it starts 3 cells from
		// where S3's driftwood lay in the Graue Bucht), no other hidden start
		const rec = await withArena(arena.address, () => judge(cm!, memTask, mRecaller!, { memory }));
		assert.equal(rec.ok, true, rec.error ?? "");
		assert.equal(rec.calls!.recall, 9);
		assert.equal(rec.coverage, 0.167);
		// the replayer reaches the shown episodes whose remembered way passes their driftwood, none of the hidden
		const rep = await withArena(arena.address, () => judge(cm!, memTask, mReplayer!, { memory }));
		assert.equal(rep.ok, false);
		assert.equal(rep.score, 0);
		assert.ok(rep.passed >= 2 && rep.passed <= 3, String(rep.passed));
		assert.ok(rep.episodes!.filter((e) => e.kind === "holdout").every((e) => !e.reached[0]));
		// nothing of a hidden episode goes into the memory; a contribution that is not correct adds its reached ones only
		assert.ok(memoryEntries(rep, memTask.bot!.goal).every((m) => m.episode.startsWith("S")));
		// the same contribution with the same memory: the same verdict, as on another judge
		const again = await withArena(arena.address, () => judge(cm!, memTask, mRecaller!, { memory }));
		const same = (v: typeof rec) => JSON.stringify([v.ok, v.passed, v.score, v.cost, v.calls, v.coverage, v.episodes!.map((e) => [e.id, e.reached, e.cost, e.path])]);
		assert.equal(same(again), same(rec));
		// the task without memory has no recall tool and no coverage
		const plain = await withArena(arena.address, () => judge(cm!, island, mExplorer!, { memory }));
		assert.equal(plain.coverage, undefined);
		assert.doesNotMatch(island.prompt.en, /tools\.recall/);
		assert.match(memTask.prompt.en, /tools\.recall/);
		void mNoWood;
	} finally { await arena.close(); }
});

t("a run with memory: each generation recalls what the ones before it reached, frozen when it began; the block's memory goes with it", async () => {
	const arena = await startFakeArena();
	process.env.CODEMODE_ARENA = arena.address;
	const srv = await startServer({ port: 0, bind: "127.0.0.1", judges: [{ host: "arena", arena: arena.address, workers: 2 }] });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/mem1/task", { taskId: "beacon-insel-memory" })).status, 200);
		assert.equal((await post("/api/sessions/mem1/run", { agents: 3, gens: 3, perAgent: 1, polish: 1, contenders: ["scripted"] })).status, 200);
		let snap: any;
		for (const end = Date.now() + 240_000; ;) {
			const s = await (await fetch(srv.url + "/api/sessions/mem1")).json() as any;
			snap = { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) };
			if (snap.run && !snap.run.active && snap.contributions?.length >= 6 && snap.contributions.every((c: any) => c.ok !== null)) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify([snap.run, snap.contributions?.map((c: any) => [c.author, c.gen, c.ok])])}`);
			await new Promise((r) => setTimeout(r, 200));
		}
		assert.equal(snap.task.memory, true);
		const space = srv.stack.space;
		const freezes = (await space.readAll({ type: "MemoryFreeze", fields: { session: "mem1" } })).map((e: any) => e.fields).sort((a: any, b: any) => a.freezeId.localeCompare(b.freezeId));
		assert.ok(freezes.length >= 2, JSON.stringify(freezes.map((f: any) => f.freezeId)));
		assert.deepEqual(freezes[0].memoryIds, [], "the first generation recalls nothing");
		assert.ok(freezes[1].memoryIds.length > 0, "the second recalls what the first reached");
		// every candidate carries its generation's freeze; the first generation's verdicts cover nothing (its own paths
		// came in while it was judged), the second's cover H6
		const scores = (await space.readAll({ type: "CodeScore", fields: { session: "mem1" } })).map((e: any) => e.fields);
		const byGen = (g: number) => snap.contributions.filter((c: any) => c.gen === g);
		assert.ok(byGen(1).length && byGen(1).every((c: any) => c.coverage === 0), JSON.stringify(byGen(1).map((c: any) => c.coverage)));
		assert.ok(byGen(2).length && byGen(2).every((c: any) => c.coverage > 0), JSON.stringify(byGen(2).map((c: any) => c.coverage)));
		assert.ok(scores.length >= 6);
		const memories = await space.readAll({ type: "PlanMemory", fields: { session: "mem1" } });
		assert.ok(memories.length >= 3 && memories.every((e: any) => /^S\d$/.test(e.fields.episode)), "only shown episodes, each path once");
		// the memory view
		const view = await (await fetch(`${srv.url}/api/sessions/mem1/memory/${snap.current}`)).json() as any;
		assert.equal(view.memories.length, memories.length);
		assert.ok(view.rooms.length >= 3);
		// a contribution by hand gets a freeze of its own, of the memory as it stands
		const own = await (await post("/api/sessions/mem1/code", { author: "hand", source: mRecaller })).json() as any;
		const cand = (await space.readAll({ type: "CodeCandidate", fields: { session: "mem1", candidateId: own.candidateId } }))[0]
			?? (await space.readAll({ type: "CodeJudging", fields: { session: "mem1", candidateId: own.candidateId } }))[0]
			?? (await space.readAll({ type: "CodeScore", fields: { session: "mem1", candidateId: own.candidateId } }))[0];
		void cand;
		const mine = (await space.readAll({ type: "MemoryFreeze", fields: { session: "mem1", freezeId: `c-${own.candidateId}` } }))[0] as any;
		assert.ok(mine && mine.fields.memoryIds.length === memories.length);
		// deleting the block takes memory and freezes along
		for (const end = Date.now() + 60_000; ;) {
			const s = await (await fetch(srv.url + "/api/sessions/mem1")).json() as any;
			const b = s.blocks.find((x: any) => x.blockId === s.current);
			if (b.contributions.every((c: any) => c.ok !== null)) break;
			if (Date.now() > end) throw new Error("the hand contribution was not judged");
			await new Promise((r) => setTimeout(r, 200));
		}
		assert.equal((await post("/api/sessions/mem1/delete", { blockId: snap.current })).status, 200);
		assert.equal(await space.count({ type: "PlanMemory" }), 0);
		assert.equal(await space.count({ type: "MemoryFreeze" }), 0);
	} finally { await srv.close(); await arena.close(); process.env.CODEMODE_ARENA = ""; }
});
