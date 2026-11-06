// Harness tasks (server/harnesstask.ts, docs/codemode-anwendungen.en.md C): the contribution is a judging script that
// rates implementations it cannot see, through `tools.run`. It counts only when every good implementation scores
// strictly higher than every bad one, the hidden ones included.
import test from "node:test";
import assert from "node:assert/strict";
import { judge, loadCodemode } from "../server/judge.ts";
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
