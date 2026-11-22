// The plan document in the space: versions share the sections that did not change, a second writer of a section is
// refused, writers of different sections follow each other, and the sizes hold at their limits.
import test from "node:test";
import assert from "node:assert/strict";
import { OUTLINE, parseOutline, parseSection } from "../server/calls.ts";
import { DOC_LIMITS, DocRefused, fullDoc, headOf, renderMarkdown, StaleSection, versionsOf, writeVersion, type Revision, type Writer } from "../server/plandoc.ts";
import { planTask } from "../server/plantask.ts";
import { renderSection, safeLinks } from "../client/lib/safe-markdown.ts";
import { startStack, type Stack } from "./stack.ts";

const TTL = 600_000;
let seq = 0;
const doc = () => ({ session: "doc-test", blockId: `b${process.pid}x${seq++}`, table: "A" });
const ANN: Writer = { author: "agent-0", model: "fake/alpha" }, BOB: Writer = { author: "agent-1", model: "fake/beta" };
const THREE: Revision = { changes: [{ title: "Goal", text: "one" }, { title: "Steps", text: "two" }, { title: "Risks", text: "three" }] };

/** One version, written and committed in a transaction of its own. */
async function commit(stack: Stack, d: ReturnType<typeof doc>, who: Writer, r: Revision) {
	const t = await stack.space.createTransaction(30_000);
	try { const v = await writeVersion(stack.space, t.id, TTL, d, who, r); await stack.space.commit(t.id); return v; }
	catch (e) { await stack.space.abort(t.id).catch(() => {}); throw e; }
}

test("the plan document", async (t) => {
	const stack = await startStack({ agents: false, model: false });
	t.after(() => stack.close());
	const { space } = stack;

	await t.test("a new version writes only the sections that changed", async () => {
		const d = doc();
		const v1 = await commit(stack, d, ANN, THREE);
		assert.deepEqual([v1.version, v1.sections.map((s) => [s.sectionId, s.rev, s.title]), v1.changed], [1, [["s1", 1, "Goal"], ["s2", 1, "Steps"], ["s3", 1, "Risks"]], ["s1", "s2", "s3"]]);
		const v2 = await commit(stack, d, BOB, { changes: [{ sectionId: "s2", base: 1, text: "two, revised" }] });
		assert.deepEqual([v2.version, v2.changed, v2.sections.map((s) => s.rev)], [2, ["s2"], [1, 2, 1]]);
		// three sections, four section entries: the unchanged ones are the same entries in both versions
		assert.equal(await space.count({ type: "PlanSection", fields: d }), 4);
		assert.deepEqual(v2.sections.filter((s) => s.sectionId !== "s2"), v1.sections.filter((s) => s.sectionId !== "s2"));
		assert.deepEqual(v2.sections[1]!.model, "fake/beta");
		// the old version is still what it was
		assert.deepEqual((await fullDoc(space, (await headOf(space, d, 1))!)).sections.map((s) => s.text), ["one", "two", "three"]);
		assert.deepEqual((await fullDoc(space, (await headOf(space, d))!)).sections.map((s) => s.text), ["one", "two, revised", "three"]);
		assert.deepEqual((await versionsOf(space, d)).map((v) => [v.version, v.model]), [[1, "fake/alpha"], [2, "fake/beta"]]);
		assert.equal(renderMarkdown(await fullDoc(space, v2), "A plan"), "# A plan\n\n## Goal\n\none\n\n## Steps\n\ntwo, revised\n\n## Risks\n\nthree\n");
		// the same text again is no new revision, and a version that changes nothing is refused
		await assert.rejects(commit(stack, d, ANN, { changes: [{ sectionId: "s1", base: 1, text: "one" }] }), /nothing changed/);
	});

	await t.test("a second writer of a section is refused and told the newer text", async () => {
		const d = doc();
		await commit(stack, d, ANN, THREE);
		await commit(stack, d, ANN, { changes: [{ sectionId: "s1", base: 1, text: "Ann's goal" }] });
		// Bob wrote against revision 1 as well
		const stale = await commit(stack, d, BOB, { changes: [{ sectionId: "s1", base: 1, text: "Bob's goal" }] }).catch((e) => e);
		assert.ok(stale instanceof StaleSection);
		assert.deepEqual([stale.current.rev, stale.current.text, stale.current.model], [2, "Ann's goal", "fake/alpha"]);
		assert.equal((await headOf(space, d))!.version, 2);
		assert.equal(await space.count({ type: "PlanSection", fields: { ...d, sectionId: "s1" } }), 2);
		// with the newer revision as his base he gets in
		const v3 = await commit(stack, d, BOB, { changes: [{ sectionId: "s1", base: 2, text: "Bob's goal, after Ann's" }] });
		assert.deepEqual([v3.version, v3.sections[0]!.rev], [3, 3]);
	});

	await t.test("writers at the same time: of one section the first gets in, of different sections both", async () => {
		const d = doc();
		await commit(stack, d, ANN, THREE);
		// Ann's transaction stays open while Bob writes
		const ta = await space.createTransaction(30_000);
		await writeVersion(space, ta.id, TTL, d, ANN, { changes: [{ sectionId: "s1", base: 1, text: "Ann's goal" }] });
		const same = commit(stack, d, BOB, { changes: [{ sectionId: "s1", base: 1, text: "Bob's goal" }] }).catch((e) => e);
		const other = commit(stack, d, BOB, { changes: [{ sectionId: "s3", base: 1, text: "Bob's risks" }] });
		await new Promise((r) => setTimeout(r, 400));
		assert.equal((await headOf(space, d))!.version, 1); // nothing of either is there before Ann commits
		await space.commit(ta.id);
		assert.ok((await same) instanceof StaleSection);
		const v3 = await other;
		assert.deepEqual([v3.version, v3.sections.map((s) => s.rev), v3.changed], [3, [2, 1, 2], ["s3"]]);
		assert.deepEqual((await fullDoc(space, v3)).sections.map((s) => s.text), ["Ann's goal", "two", "Bob's risks"]);
	});

	await t.test("sections are added, dropped and put in order", async () => {
		const d = doc();
		await commit(stack, d, ANN, THREE);
		const v2 = await commit(stack, d, ANN, { changes: [{ title: "Costs", text: "four", after: "s1" }, { title: "Summary", text: "zero", after: "" }, { title: "Open questions", text: "five" }], remove: ["s3"] });
		assert.deepEqual(v2.sections.map((s) => s.title), ["Summary", "Goal", "Costs", "Steps", "Open questions"]);
		const ids = v2.sections.map((s) => s.sectionId);
		const v3 = await commit(stack, d, ANN, { changes: [], order: [...ids].reverse() });
		assert.deepEqual(v3.sections.map((s) => s.title), ["Open questions", "Steps", "Costs", "Goal", "Summary"]);
		assert.deepEqual(v3.changed, []);
		await assert.rejects(commit(stack, d, ANN, { changes: [], order: ids.slice(1) }), /name every section once/);
		await assert.rejects(commit(stack, d, ANN, { changes: [], remove: ["s3"] }), /unknown section s3/);
		await assert.rejects(commit(stack, d, ANN, { changes: [{ sectionId: "s9", text: "x" }] }), /unknown section s9/);
		await assert.rejects(commit(stack, d, ANN, { changes: [{ title: "goal", text: "again" }] }), /same title/);
	});

	await t.test("the sizes hold at their limits", async () => {
		const d = doc(), full = "ä".repeat(DOC_LIMITS.sectionBytes / 2); // two bytes a letter: exactly the limit
		const v1 = await commit(stack, d, ANN, { changes: [{ title: "Goal", text: full }] });
		assert.equal(v1.sections[0]!.bytes, DOC_LIMITS.sectionBytes);
		const over = await commit(stack, d, ANN, { changes: [{ sectionId: "s1", base: 1, text: full + "a" }] }).catch((e) => e);
		assert.ok(over instanceof DocRefused);
		assert.match(over.message, /has 24001 bytes; a section holds at most 24000/);
		// four full sections fit into a document, the fifth does not
		await commit(stack, d, ANN, { changes: ["B", "C", "D"].map((title) => ({ title, text: full.slice(0, 11_990) })) });
		await assert.rejects(commit(stack, d, ANN, { changes: [{ title: "E", text: full.slice(0, 11_990) }] }), /it holds at most 96000/);
		assert.equal((await headOf(space, d))!.version, 2);
		const many = doc();
		await commit(stack, many, ANN, { changes: Array.from({ length: DOC_LIMITS.sections }, (_, i) => ({ title: `Section ${i}`, text: "x" })) });
		await assert.rejects(commit(stack, many, ANN, { changes: [{ title: "One more", text: "x" }] }), /at most 40 sections/);
		await assert.rejects(commit(stack, doc(), ANN, { changes: [{ title: "t".repeat(DOC_LIMITS.title + 1), text: "x" }] }), /title has at most 120/);
		await assert.rejects(commit(stack, doc(), ANN, { changes: [] }), /nothing changed/);
	});
});

test("an outline is read from a model's answer", () => {
	assert.deepEqual(parseOutline("Here is my outline:\n\n## 1. Goal\nWhat we want.\nAnd why.\n\n## Steps\n\n### 3) Risks\nWhat can go wrong."), [
		{ title: "Goal", intent: "What we want. And why." }, { title: "Steps", intent: "(nothing said yet)" }, { title: "Risks", intent: "What can go wrong." }]);
	assert.throws(() => parseOutline("## Goal\nx\n## Steps\ny"), /has 2 sections; it needs at least 3/);
	assert.throws(() => parseOutline("I would start with the goal."), /has 0 sections/);
	assert.throws(() => parseOutline("## Goal\nx\n## goal\ny\n## Steps\nz"), /names a heading twice/);
	assert.equal(parseOutline(Array.from({ length: 30 }, (_, i) => `## S${i}\nx`).join("\n")).length, OUTLINE.max);
	// headings the person fixed stay, in their order, whatever the model wrote
	assert.deepEqual(parseOutline("## Weg\nWie es geht.\n## Anderes\nx", ["Ziel", "Weg"]), [{ title: "Ziel", intent: "(nothing said yet)" }, { title: "Weg", intent: "Wie es geht." }]);
});

test("a section is read from a model's answer", () => {
	assert.equal(parseSection("## Goal\n\nThe goal.\n\n### Detail\nMore.  \n", "goal"), "The goal.\n\n### Detail\nMore.");
	assert.equal(parseSection("## Another heading\nText.", "Goal"), "## Another heading\nText.");
	assert.throws(() => parseSection("## Goal\n\n", "Goal"), /section is empty/);
	const long = parseSection(Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: ${"x".repeat(90)}`).join("\n\n"), "Goal");
	assert.ok(Buffer.byteLength(long) <= DOC_LIMITS.sectionBytes && Buffer.byteLength(long) > DOC_LIMITS.sectionBytes - 200);
	assert.match(long, /x{90}$/); // cut at a paragraph
});

test("a plan task is checked when it is created", () => {
	const brief = "Plan how the 3D world gets four times the resolution.";
	assert.deepEqual(planTask({ brief: `  ${brief}\r\n`, outline: "1. Goal\n- Steps\n\n## Risks", criteria: ["Names the files it changes"] }), { brief, lang: "en", outline: ["Goal", "Steps", "Risks"], criteria: ["Names the files it changes"] });
	assert.equal(planTask({ brief, lang: "de" }).lang, "de");
	assert.throws(() => planTask({ brief: "too short" }), /at least 20 characters/);
	assert.throws(() => planTask({ brief: "x".repeat(8001) }), /at most 8000 characters/);
	assert.throws(() => planTask({ brief, outline: ["Goal", "goal"] }), /names a heading twice/);
	assert.throws(() => planTask({ brief, outline: Array.from({ length: 21 }, (_, i) => `H${i}`) }), /at most 20 headings/);
	assert.throws(() => planTask({ brief, criteria: Array.from({ length: 13 }, (_, i) => `C${i}`) }), /At most 12 criteria/);
});

test("a section's links keep only plain web addresses, and its HTML is escaped", () => {
	assert.equal(safeLinks("See [the docs](https://example.org/a?b=1), [mail](mailto:a@example.org), [this](javascript:void), [that](data:text/html,x) and [here](#top)."), "See [the docs](https://example.org/a?b=1), [mail](mailto:a@example.org), this, that and here.");
	const html = renderSection('A [link](https://example.org) and <img src=x onerror=alert(1)> and [bad](javascript:void).');
	assert.match(html, /<a href="https:\/\/example\.org"/);
	assert.doesNotMatch(html, /<img|javascript:/);
});
