// Harness tasks (server/harnesstask.ts, docs/codemode-anwendungen.en.md C): the contribution is a judging script that
// rates implementations it cannot see, through `tools.run`. It counts only when every good implementation scores
// strictly higher than every bad one, the hidden ones included.
import test from "node:test";
import assert from "node:assert/strict";
import { CAPTURED, judge, loadCodemode } from "../server/judge.ts";
import { harnessTools } from "../server/harnesstask.ts";
import { newMeter } from "../server/tooltask.ts";
import { genIsland, tideCell, ToyIsland, toyCellError } from "../server/toyisland.ts";
import { teamPrompt } from "../server/llm.ts";
import { portableTask, restoreTask, taskById } from "../server/tasks.ts";
import { execute } from "../server/runner.ts";

const cm = await loadCodemode();
const t = cm ? test : test.skip;
const task = taskById("harness-sort")!;
const [cheap, careful, examplesOnly, noSpeed, same] = task.variants;

t("the harness variants: the cheap one wins, the ones that miss the hard-coded, the slow or everything fail", async () => {
	const [a, b, c, d, e] = await Promise.all([cheap, careful, examplesOnly, noSpeed, same].map((v) => judge(cm!, task, v!)));
	for (const v of [a!, b!]) { assert.equal(v.ok, true, v.error ?? ""); assert.equal(v.passed, 10); assert.equal(v.total, 10); }
	assert.ok(a!.cost! < b!.cost!, `${a!.cost} < ${b!.cost}`);
	assert.deepEqual(a!.calls, { run: 4 }, "points count the shown implementations only");
	assert.match(c!.error!, /knows the examples by heart|bubble sort|reference/);
	assert.ok(c!.cases.some((x) => /knows the examples by heart/.test(x.call) && !x.ok));
	assert.ok(d!.cases.some((x) => /bubble sort/.test(x.call) && !x.ok));
	assert.equal(e!.ok, false);
	// the hidden ones are rated only once the shown ones are ordered right
	for (const v of [c!, d!, e!]) assert.equal(v.cases.some((x) => /hidden/.test(x.call)), false);
	assert.ok(a!.cases.filter((x) => /hidden/.test(x.call)).length === 6);
});

t("the slow ones are told apart on every run: the verdict does not depend on the machine's mood", async () => {
	for (let round = 0; round < 4; round++) {
		const vs = await Promise.all([judge(cm!, task, cheap!), judge(cm!, task, cheap!)]);
		for (const v of vs) assert.equal(v.ok, true, `round ${round}: ${v.error}`);
	}
});

t("a hidden implementation's secrets stay in the judge: its errors, its code, the task as it leaves the judge", async () => {
	// right on the shown ones, then throws what a hidden one returned
	const leak = cheap!.replace("async function rate(){", `async function rate(){const p=await tools.run({args:[[2,1,1]]});if(p.value&&p.value.length===2)throw new Error("got "+JSON.stringify(p.value));`);
	const v = await judge(cm!, task, leak);
	assert.equal(v.ok, false);
	const hidden = v.cases.find((x) => x.call.includes("hidden bad 1"))!;
	assert.match(hidden.error!, /its message stays hidden/);
	assert.doesNotMatch(JSON.stringify(v), /got \[1,2\]/);
	// a hidden one's score never shows: a harness could hide what it saw in the number it returns
	const encode = cheap!.replace("return r.ms>3*base+5?0.5:1}", "return (r.ms>3*base+5?0.5:1)+r.value.length/1e7}");
	const e = await judge(cm!, task, encode);
	assert.equal(e.ok, true, e.error ?? "");
	for (const c of e.cases.filter((x) => /hidden/.test(x.call))) assert.equal(c.got, "ordered right");
	assert.doesNotMatch(JSON.stringify(e.cases.filter((x) => /hidden/.test(x.call))), /\d\.\d/);
	const prompt = JSON.stringify(teamPrompt({ task, lang: "en", agent: 0, gen: 1 }));
	for (const impl of [...task.harness!.hiddenGood, ...task.harness!.hiddenBad]) assert.equal(prompt.includes(impl.source), false);
	assert.match(prompt, /tools\.run\(args\)/);
	const out = portableTask(task);
	assert.equal(out.harness, undefined);
	assert.deepEqual(restoreTask(out).harness, task.harness);
	// a run that is not a number, and one beyond the cap
	const none = await judge(cm!, task, `async function rate(){return "good"}`);
	assert.match(none.error!, /returned no finite number/);
	const storm = await judge(cm!, task, `async function rate(){for(;;)await tools.run({args:[[1]]})}`);
	assert.match(storm.error!, /more than 40 runs/);
});

t("▶ runs a harness against the reference only", async () => {
	const lines: string[] = [];
	const end = await execute(cm! as never, task, `async function rate(){const r=await tools.run({args:[[3,1,2]]});console.log(JSON.stringify(r.value));return 1}`, "rate()", (e) => { if ("text" in e) lines.push(String(e.text)); }, new AbortController().signal);
	assert.equal(end.status, "ok");
	assert.ok(lines.includes("[1,2,3]"), JSON.stringify(lines));
	assert.ok(lines.some((l) => /runs of the reference \(built-in sort\): run 1 = 1 points/.test(l)), JSON.stringify(lines));
});

// ---- rate planners (docs/codemode-planung.en.md, step 5): island bots played on the toy island in the judge
const planners = taskById("harness-planners")!;
const spec = planners.harness!;
const [farAll, farCheap, shownOnly, oneSeed, noHold, nearOnly, graueOnly] = planners.variants;
/** One `run` of a planner harness against one bot, as rate() makes it. */
const play = async (source: string, a: Record<string, unknown>) => {
	const tools = harnessTools((o) => new cm!.CodemodeSandbox(o), CAPTURED, spec, { label: "x", source }, newMeter());
	return await tools[0]!.execute(a) as { reached?: boolean; points?: number; error?: string };
};

test("the toy island: the same episode and seed give the same world; the seed moves the tide, a fed fire burns 10 minutes", () => {
	const w = new ToyIsland({ room: "klippenpfad", x: 2, y: 8 }, [{ room: "graue-bucht", x: 17, y: 9 }]);
	assert.equal(w.act("west").at.room, "graue-bucht");
	assert.deepEqual(w.look().things, [{ name: "Treibholz", x: 17, y: 9 }]);
	w.act("move 17 9"); w.act("nimm treibholz"); w.act("move 9 9");
	assert.match(w.act("lege holz ins feuer").said[0]!, /Leuchtfeuer/);
	assert.equal(w.reached(5), true);
	assert.equal(w.reached(10), false, "one piece burns 10 world minutes");
	w.wait(6);
	assert.equal(w.reached(5), false);
	assert.deepEqual([tideCell(0).room, tideCell(1).room], ["graue-bucht", "graue-bucht"]);
	assert.notEqual(tideCell(2).room, "graue-bucht");
	const t = new ToyIsland({ room: "graue-bucht", x: 3, y: 3 }, [], 2);
	t.wait(60);
	assert.deepEqual(t.wood, [tideCell(2)]);
	assert.equal(toyCellError({ room: "graue-bucht", x: 9, y: 10 }, "wood"), "wood: the fire stands there");
	assert.match(toyCellError({ room: "nowhere", x: 1, y: 1 }, "start")!, /no room/);
	assert.match(toyCellError({ room: "duenen", x: 0, y: 1 }, "start")!, /x 1\.\.22/);
});

test("made islands: the same number gives the same island, every room reachable, exits both ways, the tide of seeds 0 and 1 beside the fire", () => {
	const rev: Record<string, string> = { nord: "süd", "süd": "nord", ost: "west", west: "ost" };
	const shapes = new Set<string>();
	for (let n = 0; n < 200; n++) {
		const w = genIsland(n), ids = Object.keys(w.rooms);
		assert.deepEqual(JSON.stringify(genIsland(n)), JSON.stringify(w));
		assert.ok(ids.length >= 5 && ids.length <= 8, `${n}: ${ids.length} rooms`);
		const seen = new Set([ids[0]!]), q = [ids[0]!];
		while (q.length) for (const t of Object.values(w.rooms[q.shift()!]!.exits)) if (!seen.has(t)) { seen.add(t); q.push(t); }
		assert.equal(seen.size, ids.length, `${n}: every room reachable`);
		for (const [id, r] of Object.entries(w.rooms)) for (const [d, t] of Object.entries(r.exits)) assert.equal(w.rooms[t]!.exits[rev[d]!], id, `${n}: ${id} ${d}`);
		assert.equal(toyCellError(w.episode.start, "start", w), null);
		assert.equal(toyCellError(w.episode.wood, "wood", w), null);
		assert.notEqual(w.episode.start.room, w.fire.room);
		assert.deepEqual([w.tide(0), w.tide(1)], [{ room: w.fire.room, x: w.fire.x - 1, y: w.fire.y }, { room: w.fire.room, x: w.fire.x + 1, y: w.fire.y }]);
		shapes.add(JSON.stringify(Object.values(w.rooms).map((r) => [r.at, Object.keys(r.exits)])));
	}
	assert.ok(shapes.size > 150, `${shapes.size} layouts of 200`);
	assert.match(toyCellError({ room: "graue-bucht", x: 5, y: 5 }, "start", genIsland(4))!, /no room/);
});

t("rate planners: every bad bot reaches the shown episodes with seed 0 and no hold; each fails where its lesson says", async () => {
	const shown = [{ start: { room: "graue-bucht", x: 10, y: 8 }, wood: { room: "graue-bucht", x: 5, y: 7 } }, { start: { room: "fischerdorf", x: 12, y: 8 }, wood: { room: "fischerdorf", x: 5, y: 5 } }, { start: { room: "klippenpfad", x: 2, y: 8 }, wood: { room: "graue-bucht", x: 17, y: 9 } }];
	for (const impl of [...spec.good, ...spec.bad, ...spec.hiddenGood, ...spec.hiddenBad]) for (const e of shown) assert.equal((await play(impl.source, e)).reached, true, `${impl.label} on ${e.start.room}`);
	const far = { start: { room: "klippenkopf", x: 12, y: 8 }, wood: { room: "torfmoor", x: 5, y: 5 } };
	const [byHeart, near, goesOut, tide, graue] = spec.bad;
	assert.equal((await play(byHeart!.source, far)).reached, false);
	assert.equal((await play(near!.source, far)).reached, false);
	assert.equal((await play(goesOut!.source, { ...shown[0], hold: 5 })).reached, false);
	assert.equal((await play(tide!.source, { ...shown[0], seed: 1 })).reached, false);
	// a made island: the reference finds its way, the bot with the Graue Insel's map does not
	assert.equal((await play(graue!.source, { island: 4 })).reached, false);
	assert.equal((await play(spec.good[0]!.source, { island: 4, seed: 2, hold: 5 })).reached, true);
	assert.match((await play(spec.good[0]!.source, { island: -1 })).error!, /island/);
	assert.match((await play(spec.good[0]!.source, { island: 4, start: { room: "fischerdorf", x: 12, y: 8 } })).error!, /no room fischerdorf/);
	const ref = await play(spec.good[0]!.source, { ...far, seed: 7, hold: 5 });
	assert.equal(ref.reached, true);
	assert.ok(ref.points! > 10, String(ref.points));
	// an episode the island does not have is no run of the bot
	assert.match((await play(spec.good[0]!.source, { start: { room: "graue-bucht", x: 9, y: 10 }, wood: shown[0]!.wood })).error!, /fire stands there/);
	assert.match((await play(spec.good[0]!.source, { ...far, hold: 61 })).error!, /hold/);
});

t("rate planners: the two correct harnesses rank every bot right, each blind one misranks the bot of its lesson, the verdict repeats", async () => {
	const [a, b, c, d, e, f, g] = await Promise.all([farAll, farCheap, shownOnly, oneSeed, noHold, nearOnly, graueOnly].map((v) => judge(cm!, planners, v!)));
	for (const v of [a!, b!]) { assert.equal(v.ok, true, v.error ?? ""); assert.deepEqual([v.passed, v.total], [12, 12]); }
	assert.ok(b!.cost! < a!.cost!, `${b!.cost} < ${a!.cost}`);
	const wrong = (v: typeof a) => v!.cases.filter((x) => !x.ok && !/reference/.test(x.call)).map((x) => x.call.replace("rate() on ", ""));
	assert.deepEqual(wrong(c), ["knows the shown episodes by heart", "looks only in its start room and the next ones", "knows only the map of the Graue Insel"]);
	assert.deepEqual(wrong(d), ["waits for the tide where it lands with seed 0"]);
	assert.deepEqual(wrong(e), ["lets the fire go out right after"]);
	assert.deepEqual(wrong(f), ["looks only in its start room and the next ones"]);
	assert.deepEqual(wrong(g), ["knows only the map of the Graue Insel"]);
	const again = await judge(cm!, planners, farCheap!);
	assert.deepEqual(again.cases, b!.cases, "the toy island gives every judge the same worlds");
	const constant = await judge(cm!, planners, `async function rate(){return 1}`);
	assert.equal(constant.ok, false);
	// the hidden bots never reach a prompt; the task leaves the judge without them and comes back by its id
	const prompt = JSON.stringify(teamPrompt({ task: planners, lang: "en", agent: 0, gen: 1 }));
	for (const impl of [...spec.good, ...spec.bad, ...spec.hiddenGood, ...spec.hiddenBad]) assert.equal(prompt.includes(impl.source), false, impl.label);
	assert.deepEqual(restoreTask(portableTask(planners)).harness, spec);
});

t("▶ plays a planner harness against the reference bot", async () => {
	const lines: string[] = [];
	const end = await execute(cm! as never, planners, `async function rate(){const r=await tools.run({start:{room:"duenen",x:12,y:8},wood:{room:"anleger",x:5,y:5},hold:5});console.log(JSON.stringify(r));return 1}`, "rate()", (e) => { if ("text" in e) lines.push(String(e.text)); }, new AbortController().signal);
	assert.equal(end.status, "ok");
	assert.ok(lines.some((l) => /"reached":true/.test(l)), JSON.stringify(lines));
});
