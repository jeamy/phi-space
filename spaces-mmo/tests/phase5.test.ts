// Acceptance of Phase 5 (docs/modell-npcs.md): model NPCs with a scripted model (tests/fake-llm.ts; never a real one in
// the tests). Game time runs fast (SPACES_MMO_TIME_SCALE), so five minutes awake last 0.6 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpaceLike } from "phi-spaces";
import { sleep as putToSleep, tryWake } from "../server/npc/minds.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, lightFire, Player, startServer, startStack } from "./stack.ts";

const MODEL = { SPACES_MMO_LLM: "1", SPACES_MMO_LLM_MODULE: "tests/fake-llm.ts", SPACES_MMO_TIME_SCALE: "0.002" };
const fire = (s: SpaceLike, ms: number) => lightFire(s, ms);
const noFire = async (s: SpaceLike) => { while (await s.takeIfExists({ type: "Flame", fields: { beaconId: "feuer-bucht" } }, 1_000)); };
async function player(url: string, name: string) {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
const heard = (p: Player, text: string, ms = 15_000, from = 0) => p.until((f) => f.t === "msg" && f.m.text === text, ms, from) as Promise<Extract<ServerFrame, { t: "msg" }>>;

test("without model calls every role dozes as a script NPC: no model call, nobody awake", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_TIME_SCALE: "0.002" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		await fire(s, 120_000);
		const a = await player(srv.url, "Ohne");
		await stack.npcProcess();
		a.p.send("say hallo Ines");
		await heard(a.p, "Ines: Willkommen am Feuer, Ohne!");
		assert.equal(await s.count({ type: "LlmCount" }), 0, "no model call");
		assert.equal(await s.count({ type: "NpcAwake" }), 0, "nobody awake");
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("spoken to, Ines wakes, answers with the model and remembers; without more talk she dozes off again", async () => {
	// 0.02: five minutes awake last six seconds, long enough to look
	const stack = await startStack({ worldEnv: { ...MODEL, SPACES_MMO_TIME_SCALE: "0.02" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		await fire(s, 120_000);
		const a = await player(srv.url, "Gast");
		await stack.npcProcess();
		await eventually(async () => (await s.count({ type: "NpcOwner" })) === 3, 10_000, "all roles played");
		a.p.send("say Hallo Ines, habt ihr öl?");
		await heard(a.p, "Ines: Hallo! Öl haben wir keins, aber Treibholz brennt.");
		assert.ok(await s.readIfExists({ type: "NpcAwake", fields: { npcId: "ines" } }, 1_000), "awake");
		// she notes it after her words are said
		await eventually(async () => /über das Feuer gesprochen/.test(String((await s.readIfExists({ type: "NpcMemory", fields: { npcId: "ines" } }, 2_000))?.fields.text)), 10_000, "remembered");
		assert.equal((await s.readAll({ type: "LlmCount" })).some((e) => String(e.fields.key).startsWith("npc:ines:")), true, "counted against her day");
		await eventually(async () => !(await s.readIfExists({ type: "NpcAwake", fields: { npcId: "ines" } }, 0)), 20_000, "asleep again");
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("Ines may do what a player may: asked in plain words she says why not, takes wood offered in trade and feeds the fire", async () => {
	const stack = await startStack({ worldEnv: { ...MODEL, SPACES_MMO_TIME_SCALE: "0.02" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space, w = await loadWorld();
		await fire(s, 120_000);
		const a = await player(srv.url, "Bittende");
		await stack.npcProcess();
		await eventually(async () => (await s.count({ type: "NpcOwner" })) === 3, 10_000, "all roles played");
		a.p.send("hallo ines, leg holz ins feuer");
		await heard(a.p, "Ines: Ich habe kein Holz bei mir."); // nothing carried: she says why
		await spawn(s, null, w, (await eventually(() => resolvePrototype(s, "treibholz"), 10_000, "treibholz"))!, { location: a.me, x: -1, y: -1 });
		a.p.send("offer treibholz an Ines");
		await a.p.until((f) => f.t === "msg" && f.m.text.startsWith("Ines nimmt dein Angebot an: Treibholz"));
		await heard(a.p, "Ines: Danke, Bittende!");
		assert.equal(await s.count({ type: "Item", fields: { location: "npc-ines" } }), 1, "she carries the wood");
		const from = a.p.frames.length;
		a.p.send("Ines, leg bitte holz ins feuer");
		await heard(a.p, "Ines: Gern, ich lege nach.", 15_000, from);
		await a.p.until((f) => f.t === "msg" && f.m.text.startsWith("Ines legt Treibholz ins Leuchtfeuer"), 15_000, from);
		assert.equal(await s.count({ type: "Item", fields: { location: "npc-ines" } }), 0, "the wood is burnt");
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("NPCs talking next to Ines cost no model call: only people wake her and keep her talking", async () => {
	const stack = await startStack({ worldEnv: { ...MODEL, SPACES_MMO_TIME_SCALE: "0.02", SPACES_MMO_NPCS: "ines,kalle" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space, w = await loadWorld();
		await fire(s, 120_000);
		const a = await player(srv.url, "Schweigsam");
		// with wood in the pack the trader speaks to her (and Ines hears him)
		await spawn(s, null, w, (await eventually(() => resolvePrototype(s, "treibholz"), 10_000, "treibholz"))!, { location: a.me, x: -1, y: -1 });
		await stack.npcProcess();
		await a.p.until((f) => f.t === "msg" && f.m.text.startsWith("Kalle: Schweigsam, für dein Treibholz"), 20_000);
		await new Promise((r) => setTimeout(r, 3_000));
		const calls = async () => (await s.readAll({ type: "LlmCount" })).filter((e) => String(e.fields.key).startsWith("npc:ines:")).reduce((n, e) => n + Number(e.fields.used), 0);
		assert.ok((await calls()) <= 1, `at most the one call for the person who came (${await calls()})`);
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("a weak fire wakes Ines and she asks for wood", async () => {
	const stack = await startStack({ worldEnv: MODEL });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		await fire(s, 120_000);
		const a = await player(srv.url, "Zeugin");
		await stack.npcProcess();
		await new Promise((r) => setTimeout(r, 1_500)); // Ines has seen the fire burn
		await noFire(s);
		await fire(s, 1_000); // less than one and a half logs: weak
		await heard(a.p, "Ines: Das Feuer braucht Holz!");
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("SPACES_MMO_NPC_MAX: no more than that many are awake, even when woken at once; a sleeper frees the place", async () => {
	const stack = await startStack({ worlds: 0 });
	try {
		const s = stack.space;
		const woke = await Promise.all(["a", "b", "c", "d", "e"].map((id) => tryWake(s, `t-${id}`, 2, 60_000)));
		assert.equal(woke.filter(Boolean).length, 2, "two of five");
		assert.equal(await s.count({ type: "NpcAwake" }), 2);
		const awake = ["a", "b", "c", "d", "e"].filter((_, i) => woke[i]);
		const waiting = ["a", "b", "c", "d", "e"].find((_, i) => !woke[i])!;
		assert.equal(await tryWake(s, `t-${waiting}`, 2, 60_000), false, "still full");
		await putToSleep(s, `t-${awake[0]}`);
		assert.equal(await tryWake(s, `t-${waiting}`, 2, 60_000), true, "its turn now");
		assert.equal(await tryWake(s, `t-${awake[1]}`, 2, 60_000), true, "one already awake stays awake");
	} finally { await stack.close(); }
});

test("an empty day budget: no model call, a script line instead of an answer", async () => {
	const stack = await startStack({ worldEnv: { ...MODEL, SPACES_MMO_NPC_BUDGET_DAY: "0" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		await fire(s, 120_000);
		const a = await player(srv.url, "Sparsam");
		await stack.npcProcess();
		a.p.send("say Ines, bist du da?");
		await heard(a.p, "Ines flickt ein Netz.");
		assert.equal((await s.readAll({ type: "LlmCount" })).some((e) => String(e.fields.key).startsWith("npc:ines:")), false, "not one call counted");
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("the stranger appears only through dense fog, speaks to who is there, leaves unanswered and keeps his cooldown", async () => {
	// 0.01: fog steps of 1.2 s, he stays 6 s unanswered, his cooldown is 18 s
	const stack = await startStack({ worldEnv: { ...MODEL, SPACES_MMO_TIME_SCALE: "0.01" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		await fire(s, 120_000);
		await eventually(async () => Number((await s.readIfExists({ type: "Fog", fields: { room: "klippenpfad" } }, 2_000))?.fields.level) === 0, 15_000, "fog cleared");
		const a = await player(srv.url, "Wanderin");
		await stack.npcProcess();
		const n = a.p.frames.length;
		a.p.send("go ost");
		await a.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, n);
		const online = async () => (await s.readAll({ type: "Session" })).some((e) => e.fields.charId === "npc-fremder");
		await new Promise((r) => setTimeout(r, 1_000));
		assert.equal(await online(), false, "no fog, no stranger");
		await noFire(s); // the fog climbs to 3 and stays
		await heard(a.p, "Fremder: Wo geht es hier aus dem Nebel?", 20_000);
		assert.equal(await online(), true);
		await heard(a.p, "Fremder verschwindet im Nebel.", 20_000); // nobody answered him
		await eventually(async () => !(await online()), 5_000, "gone");
		assert.ok(await s.readIfExists({ type: "NpcVisit", fields: { npcId: "fremder" } }, 0), "his cooldown runs");
		await new Promise((r) => setTimeout(r, 3_000));
		assert.equal(await online(), false, "not back within the cooldown although the fog stays");
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});

test("two npc processes share the roles and never play one twice; when one dies the other takes over, memory stays", async () => {
	const stack = await startStack({ worldEnv: { ...MODEL, SPACES_MMO_NPC_ROLE_LEASE_MS: "1500" } });
	const srv = await startServer({ stack });
	try {
		const s = stack.space;
		await fire(s, 120_000);
		const a = await player(srv.url, "Beobachter");
		const first = await stack.npcProcess(), second = await stack.npcProcess();
		await eventually(async () => (await s.count({ type: "NpcOwner" })) === 3, 10_000, "three roles played");
		const from = a.p.frames.length;
		a.p.send("say Hallo Ines!");
		await heard(a.p, "Ines: Hallo! Bringt Treibholz, dann bleibt das Licht.", 15_000, from);
		await new Promise((r) => setTimeout(r, 1_500));
		assert.equal(a.p.frames.slice(from).filter((f) => f.t === "msg" && f.m.from === "Ines" && f.m.kind === "say").length, 1, "Ines answered once");
		await stack.kill(first, "SIGKILL");
		await eventually(async () => { const owners = (await s.readAll({ type: "NpcOwner" })).map((e) => String(e.fields.owner)); return owners.length === 3 && new Set(owners).size === 1; }, 15_000, "the other process plays every role");
		assert.match(String((await s.readIfExists({ type: "NpcMemory", fields: { npcId: "ines" } }, 2_000))?.fields.text), /gesprochen/, "memory kept");
		const again = a.p.frames.length;
		a.p.send("say Ines, noch da?");
		await heard(a.p, "Ines: Hallo! Bringt Treibholz, dann bleibt das Licht.", 15_000, again);
		void second;
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});
