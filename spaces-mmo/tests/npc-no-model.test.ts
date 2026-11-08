// Model calls only in the model process (docs/rust-portierung.en.md, R8.0 item 2): the npc process asks for what an awake
// model NPC says through a Think entry (server/npc/minds.ts) and the model process answers (server/model-npc.ts). So
// nothing the npc process loads reaches the model calls (server/llm.ts), the durable dialogues (server/npc/durable.ts),
// the agent package or pi-ai and pi-durable: the Rust npc process (R8.4) needs none of them either.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PhiSpaces, openOwnMemoryHost } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { think } from "../server/npc/minds.ts";
import { serveThinks } from "../server/model-npc.ts";
import { closeDurableNpcs } from "../server/npc/durable.ts";
import { saveSettings } from "../server/settings.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every file `entry` loads, following relative imports (static, `export … from`, `import("…")`), and the bare modules. */
function reach(entry: string): { files: string[]; bare: string[] } {
	const seen = new Set<string>(), bare = new Set<string>(), todo = [resolve(ROOT, entry)];
	while (todo.length) {
		const f = todo.pop()!;
		if (seen.has(f)) continue;
		seen.add(f);
		const text = readFileSync(f, "utf8");
		const specs = [
			...[...text.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+"([^"]+)"/gm)].map((m) => m[1]!),
			...[...text.matchAll(/^\s*import\s+"([^"]+)"/gm)].map((m) => m[1]!),
			...[...text.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]!),
		];
		for (const s of specs) {
			if (!s.startsWith(".")) { bare.add(s); continue; }
			const p = resolve(dirname(f), s);
			if (existsSync(p)) todo.push(p);
		}
	}
	return { files: [...seen].map((f) => relative(ROOT, f)).sort(), bare: [...bare].sort() };
}

test("the npc process loads nothing of the model calls: no llm.ts, no durable dialogue, no agent package, no pi-ai", () => {
	const { files, bare } = reach("server/npc-host.ts");
	assert.ok(files.includes("server/npc/minds.ts"), "the walk follows the imports");
	assert.deepEqual(files.filter((f) => /^server\/(llm|model-npc|model-host)\.ts$|^server\/npc\/durable\.ts$|^\.\.\/agent\//.test(f)), []);
	assert.deepEqual(bare.filter((b) => /pi-ai|pi-durable|@earendil-works|chord/.test(b)), []);
});

test("an awake NPC's answer comes from the model process: a Think, answered as a Thought; without one it dozes", { timeout: 20_000 }, async () => {
	process.env.SPACES_MMO_LLM = "1";
	process.env.SPACES_MMO_LLM_MODULE = "tests/fake-llm.ts";
	process.env.SPACES_MMO_THINK_WAIT_MS = "1500";
	const host = openOwnMemoryHost(), space = new PhiSpaces(host, ctx);
	const npc = { npcId: "ines", name: "Ines", persona: "Keep the beacon.", budgetDay: 20, worldId: "leuchtfeuer" };
	const s = { room: "Hafen", people: ["Anna"], event: "talk", heard: ["Anna: Hallo Ines"] };
	try {
		await saveSettings(space, { "npc.budgetDay": 20, "llm.perDay": 500, "llm.perMin": 20 });
		// nobody answers: the request is taken back, the NPC dozes as when its budget is used up
		assert.equal(await think(space, npc, s), "budget");
		assert.equal(await space.count({ type: "Think" }), 0, "an unanswered request does not stay");
		const halt = new AbortController(), serving = serveThinks(space, halt.signal);
		try {
			const r = await think(space, npc, s);
			assert.equal(typeof r, "object", String(r));
			assert.ok(typeof r === "object" && r.lines.length > 0, JSON.stringify(r));
			assert.equal(await space.count({ type: "Thought" }), 0, "the answer is taken by the one who asked");
			const counts = await space.readAll({ type: "LlmCount" });
			assert.ok(counts.some((e) => String(e.fields.key).startsWith("npc:ines:")), "the NPC's day is counted in the model process");
		} finally { halt.abort(); await serving; await closeDurableNpcs(); } // test:durable: the dialogue's agent process
	} finally {
		delete process.env.SPACES_MMO_THINK_WAIT_MS;
		process.env.SPACES_MMO_LLM = ""; process.env.SPACES_MMO_LLM_MODULE = "";
		await host.close(ctx);
	}
});
