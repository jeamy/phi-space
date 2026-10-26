// What people ask Ines in plain words, without a model (server/npc/requests.ts): the sentence is understood, she fetches
// wood and feeds the fire, and says what she did; a sentence she cannot do gets an answer that says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestOf } from "../server/npc/requests.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer, startStack } from "./stack.ts";
import type { SpaceLike } from "phi-spaces";

test("requests are understood by name, in the ways people say them", () => {
	assert.deepEqual(requestOf("hi ines, geh holz sammeln", "Ines"), { kind: "gather", count: 2 });
	assert.deepEqual(requestOf("bitte an ines, holz zu sammeln.", "Ines"), { kind: "gather", count: 2 });
	assert.deepEqual(requestOf("Ines, sammle bitte drei Scheit Treibholz", "Ines"), { kind: "gather", count: 3 });
	assert.deepEqual(requestOf("ines hol 9 holz", "Ines"), { kind: "gather", count: 4 }, "at most four at a time");
	assert.deepEqual(requestOf("Ines, leg bitte holz ins feuer", "Ines"), { kind: "feed" });
	assert.deepEqual(requestOf("hallo ines", "Ines"), { kind: "greet" });
	assert.deepEqual(requestOf("moin Ines!", "Ines"), { kind: "greet" });
	assert.deepEqual(requestOf("ines, wie spät ist es", "Ines"), { kind: "unclear" });
	assert.equal(requestOf("geh holz sammeln", "Ines"), null, "not meant for her: her name is not in it");
	assert.equal(requestOf("hallo bo", "Ines"), null);
});

const lit = (s: SpaceLike, ms: number) => lightFire(s, ms);
const heard = (p: Player, starts: string, ms = 20_000, from = 0) => p.until((f: ServerFrame) => f.t === "msg" && f.m.text.startsWith(starts), ms, from);

test("asked to fetch wood, Ines fetches it, feeds the fire and says so; a sentence she cannot do gets an answer", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.02" } });
	const srv = await startServer({ stack });
	try {
		await lit(stack.space, 120_000);
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Bittender", password: "geheim-123" })).status, 200);
		await p.play();
		await stack.npcProcess();
		await eventually(async () => (await stack.space.count({ type: "NpcOwner" })) >= 1, 10_000, "the keeper plays");
		p.send("hi ines, geh holz sammeln");
		await heard(p, "Ines: Mach ich, Bittender");
		await heard(p, "Ines legt Treibholz ins Leuchtfeuer", 30_000);
		await heard(p, "Ines: Fertig, Bittender", 30_000);
		const from = p.frames.length;
		p.send("ines, wie spät ist es");
		await heard(p, "Ines: Das habe ich nicht verstanden, Bittender", 15_000, from);
		await p.leave();
	} finally { await srv.close(); await stack.close(); }
});
