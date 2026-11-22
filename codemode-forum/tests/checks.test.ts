// The mechanical checks of a plan document: a plan that passes, and for each check a plan that fails exactly it; what
// counts as a path, a quote and a phase; and in a run: the check after the drafts, the writer mending what was found,
// and a writer that does not, which ends the run after its three checks with the failures named.
import test from "node:test";
import assert from "node:assert/strict";
import { anchorOf, checkDoc, pathsIn, phasesIn, quotesIn, type PlanCheck, type SourceFiles } from "../server/checks.ts";
import type { PlanView, Snapshot } from "../server/hub.ts";
import { DOC_LIMITS, type FullDoc } from "../server/plandoc.ts";
import { startServer } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
/** The files of the sources in these tests, and what one of them holds. */
const FILES: SourceFiles = new Map([["README.md", "repo"], ["src/world.ts", "repo"], ["src/deep/tiles.ts", "repo"], ["package.json", "repo"], ["requirements.md", "docs"]]);
const LINES: Record<string, string[]> = { "src/world.ts": ["export const RESOLUTION = 64;"], "requirements.md": ["The resolution must be 256."] };
const quoted = async (_source: string, path: string, line: string) => (LINES[path] ?? []).some((l) => l.toLowerCase().includes(line.toLowerCase()));

/** A document of sections by title and text; a section without text is not written yet (its first revision). */
function doc(sections: Record<string, string | null>): FullDoc {
	const list = Object.entries(sections).map(([title, text], i) => ({ sectionId: `s${i + 1}`, rev: text === null ? 1 : 2, title, hash: "", bytes: Buffer.byteLength(text ?? ""), author: "agent-0", model: "fake/alpha", text: text ?? "What it is to say." }));
	return { session: "s", blockId: "b", table: "A", version: 2, slot: "b:A:2", author: "agent-0", model: "fake/alpha", changed: [], sections: list, bytes: list.reduce((n, s) => n + s.bytes, 0), ts: 0 };
}
const GOOD = {
	Goal: "Raise `RESOLUTION` in `src/world.ts` from 64 to 256, as [the steps](#steps) say.\n\n> `src/world.ts`: export const RESOLUTION = 64;",
	Steps: "| Phase | What | Verified by |\n|---|---|---|\n| Phase 1 | change `src/world.ts` and `src/deep/` | the test in `src/world.test.ts` (new) fails before and passes after |\n| Phase 2 | update `README.md` | a check that the page shows 256 |",
	Risks: "Old saves. See `package.json`. Run `npm run test` and `node --test`.",
};
const check = (sections: Record<string, string | null>, o: { outline?: string[]; files?: SourceFiles | null } = {}) => checkDoc(doc(sections), { outline: o.outline ?? [] }, o.files === undefined ? FILES : o.files, quoted);
const failed = async (sections: Record<string, string | null>, o?: { outline?: string[]; files?: SourceFiles | null }) => (await check(sections, o)).failures.map((f) => [f.check, f.sectionId ?? null, f.text]);

test("a plan that follows the conventions passes", async () => {
	assert.deepEqual(await check(GOOD, { outline: ["goal", "Steps"] }), { ok: true, failures: [], counted: { paths: 6, quotes: 1, phases: 2, links: 1 } });
	// without sources there are no paths and quotes to check
	assert.deepEqual(await check({ ...GOOD, Goal: "Change `src/nowhere.ts`.\n\n> `nowhere.md`: not there" }, { files: null }), { ok: true, failures: [], counted: { paths: 0, quotes: 0, phases: 2, links: 0 } });
});

test("each check fails on a plan that breaks exactly its rule", async (t) => {
	await t.test("path: a file that is not in the sources and is not marked as new", async () => {
		assert.deepEqual(await failed({ ...GOOD, Risks: "It also touches `src/render.ts`, `src/camera.ts` (new) and `Makefile.toml`." }), [
			["path", "s3", "`src/render.ts` is not in the sources. Name it as it is there, or mark it as new: `src/render.ts` (new)."],
			["path", "s3", "`Makefile.toml` is not in the sources. Name it as it is there, or mark it as new: `Makefile.toml` (new)."]]);
		assert.deepEqual(await failed({ ...GOOD, Risks: "It adds `src/world.ts` (new)." }), [["path", "s3", "`src/world.ts` is marked as new, but it is in the sources already."]]);
	});
	await t.test("quote: a line that is not in the file, or a file that is not there", async () => {
		assert.deepEqual(await failed({ ...GOOD, Goal: "> `src/world.ts`: export const RESOLUTION = 128;" }), [["quote", "s1", '`src/world.ts` has no line "export const RESOLUTION = 128;". Quote it as it stands there, or do not quote.']]);
		assert.deepEqual((await failed({ ...GOOD, Goal: "> `src/gone.ts`: export const X = 1;" })).map((f) => f[0]), ["path", "quote"]);
		assert.deepEqual(await failed({ ...GOOD, Goal: "> `requirements.md`: the RESOLUTION must be 256." }), []); // any case, and a document counts
	});
	await t.test("section: one the person asked for is missing, or one is not written", async () => {
		assert.deepEqual(await failed(GOOD, { outline: ["Goal", "Costs"] }), [["section", null, 'The section "Costs" the person asked for is missing.']]);
		assert.deepEqual(await failed({ ...GOOD, Risks: null }), [["section", "s3", 'The section "Risks" is not written yet.']]);
	});
	await t.test("phase: none named, or one that does not say how it is verified", async () => {
		assert.deepEqual(await failed({ ...GOOD, Steps: "First change the constant, then update the page." }), [["phase", "s1", 'The plan names no phases. Number them ("Phase 1", "Phase 2", …) and say for each how it is verified.']]);
		assert.deepEqual(await failed({ ...GOOD, Steps: "### Phase 1\nChange the constant.\n\n### Phase 2\nUpdate the page. Verified by a test.\n\n- Schritt 3: aufräumen" }), [
			["phase", "s2", "Phase 1 does not say how it is verified: name a test or a check that can fail."], ["phase", "s2", "Phase 3 does not say how it is verified: name a test or a check that can fail."]]);
		// a phase may be named in several places; one of them says how it is verified
		assert.deepEqual(await failed({ ...GOOD, Risks: "Phase 1 is the risky one." }), []);
	});
	await t.test("link: one that leads to no section", async () => {
		assert.deepEqual(await failed({ ...GOOD, Risks: "See [the way](#the-way) and [the goal](#goal)." }), [["link", "s3", "The link #the-way leads to no section. The sections are: #goal, #steps, #risks."]]);
	});
	await t.test("size: a section or a document beyond its limit", async () => {
		const big = await check({ ...GOOD, Risks: "x".repeat(DOC_LIMITS.sectionBytes + 1) });
		assert.deepEqual(big.failures.map((f) => [f.check, f.sectionId]), [["size", "s3"]]);
		const d = doc(GOOD); d.bytes = DOC_LIMITS.docBytes + 1;
		assert.deepEqual((await checkDoc(d, { outline: [] }, FILES, quoted)).failures, [{ check: "size", text: "The document has 96001 bytes; it holds at most 96000." }]);
	});
});

test("what counts as a path, a quote, a phase and an anchor", () => {
	const tops = new Set(["src", "docs", "README.md"]);
	assert.deepEqual(pathsIn("`src/a.ts`, `./src/b/` and `src/c.ts:10-20`; `new.md` (new), `docs/x.md` (neu, Phase 2); `lib/new/thing.rs` (new); not paths: `npm run test`, `Math.max`, `a/b`, `--flag`, `1.5.2`, `foo()`, `<path>`, `RESOLUTION`, `client/server`.\n```\n`src/in-a-fence.ts`\n```", tops), [
		{ path: "src/a.ts", isNew: false }, { path: "src/b", isNew: false }, { path: "src/c.ts", isNew: false }, { path: "new.md", isNew: true }, { path: "docs/x.md", isNew: true }, { path: "lib/new/thing.rs", isNew: true }]);
	assert.deepEqual(quotesIn("> `src/a.ts`: const A = 1;\n>  `b.md:3` : `quoted in ticks`\n> an ordinary quote\n`c.md`: not a quote line"), [{ path: "src/a.ts", line: "const A = 1;" }, { path: "b.md", line: "quoted in ticks" }]);
	assert.deepEqual(phasesIn("Intro.\n## Phase 1: start\nDo it.\n| **Phase 2** | ship | test |\n- Schritt 3 aufräumen\nphase one is not numbered").map((p) => [p.n, p.text.split("\n").length]), [[1, 2], [2, 1], [3, 2]]);
	assert.deepEqual(["The Goal", "Risiken & Wege zurück", "3D: Auflösung ×4"].map(anchorOf), ["the-goal", "risiken-wege-zurück", "3d-auflösung-4"]);
});

const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
async function ended(url: string, id: string): Promise<Snapshot> {
	for (const end = Date.now() + 60_000; ; ) {
		const s = await snapshot(url, id);
		if (s.run && !s.run.active) return s;
		if (Date.now() > end) throw new Error("the run did not end");
		await new Promise((r) => setTimeout(r, 100));
	}
}
const DOCS = [{ name: "README.md", text: "# Demo\nThe resolution is 64." }];

test("the document is checked after the drafts, and the writer mends what the checker found", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	await srv.stack.sources();
	const id = `sloppy-c${process.pid}`;
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: "Plan how the world gets four times the resolution.", docs: DOCS })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 80_000 })).status, 200);
	const s = await ended(srv.url, id);
	// version 4 failed, the writer revised the one section, version 5 passes
	assert.deepEqual([s.run!.check, s.run!.doc, s.run!.phase], [{ version: 5, ok: true, failures: 0, round: 2 }, { table: "A", version: 5, sections: 3, written: 3 }, "done"]);
	const checks = (await srv.stack.space.readAll({ type: "PlanCheck", fields: { session: id } }, { limit: 10 })).map((e) => e.fields as unknown as PlanCheck).sort((a, b) => a.version - b.version);
	assert.deepEqual(checks.map((c) => [c.version, c.ok, c.failures.map((f) => [f.check, f.sectionId])]), [[4, false, [["path", "s2"], ["quote", "s2"], ["link", "s2"], ["phase", "s2"]]], [5, true, []]]);
	assert.deepEqual(checks[1]!.counted, { paths: 2, quotes: 1, phases: 1, links: 1 });
	// the writer was told what was found, as fact, with the section as it was
	const revise = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id, kind: "revise" } }, { limit: 5 })).map((e) => e.fields as unknown as { prompt: string });
	assert.equal(revise.length, 1);
	for (const f of checks[0]!.failures) assert.ok(revise[0]!.prompt.includes(`- ${f.text}`), f.text);
	assert.match(revise[0]!.prompt, /A program checked the document and found this, which must be mended\. It is not a matter of opinion:/);
	assert.ok(revise[0]!.prompt.includes('The section "Steps" as it is now:\n"""\nPhase 1: rewrite `missing.md`.'));
	assert.match(revise[0]!.prompt, /Name files and directories in backticks/);
	// the page gets the result with the version it belongs to
	const view = async (version?: number) => (await (await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}${version ? `?version=${version}` : ""}`)).json()) as PlanView;
	assert.deepEqual([(await view()).check, (await view(4)).check!.failures.length, (await view(3)).check, s.blocks[0]!.doc!.check], [{ ok: true, failures: [] }, 4, null, { ok: true, failures: [] }]);
	assert.match(s.lines.at(-1)!.text, /M1 wrote 3 of 3 sections of the first draft \(version 5, checks passed\)/);
	assert.equal(s.run!.usage.tokens, 300 + 450 + 400 + 3000 + 1000);
	for (const type of ["CheckRequest", "CheckResult", "SourceRequest", "SourceResult"]) assert.equal(await srv.stack.space.count({ type, fields: { session: id } }), 0, type);
});

test("a writer that mends nothing: after three checks the run ends and says what is left", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	await srv.stack.sources();
	const id = `stubborn-c${process.pid}`;
	await post(srv.url, `/api/rooms/${id}/task`, { brief: "Plan how the world gets four times the resolution.", docs: DOCS });
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 80_000 })).status, 200);
	const s = await ended(srv.url, id);
	assert.deepEqual([s.run!.check, s.run!.phase, s.run!.doc!.version], [{ version: 6, ok: false, failures: 4, round: 3 }, "done", 6]);
	assert.equal(await srv.stack.space.count({ type: "FakeCall", fields: { session: id, kind: "revise" } }), 2);
	assert.match(s.lines.at(-1)!.text, /of the first draft \(version 6, 4 check failures left\)/);
	assert.deepEqual(s.blocks[0]!.doc!.check!.failures.map((f) => f.check), ["path", "quote", "link", "phase"]);
});
