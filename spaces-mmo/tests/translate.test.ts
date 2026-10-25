// Plain language into commands: the free rules (engine/translate.ts) and, for what they miss, the model process with a
// scripted model (tests/fake-llm.ts; never a real one in the tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpaceLike } from "phi-spaces";
import { translateRules } from "../server/engine/translate.ts";
import { commandOf } from "../server/model-host.ts";
import { resolvePrototype, spawn } from "../server/engine/prototypes.ts";
import { loadWorld } from "../server/engine/world.ts";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer, startStack } from "./stack.ts";

const w = await loadWorld();
const view = { exits: [{ name: "ost", aliases: ["o", "osten", "east", "e", "klippenpfad"] }], listings: [{ nr: 1, itemName: "Muschel" }, { nr: 2, itemName: "Treibholz" }], carried: ["Treibholz"] };

test("rules: common sentences become commands; commands and talk stay as they are", () => {
	const t = (s: string) => translateRules(s, view);
	assert.equal(t("gehe nach osten"), "go ost");
	assert.equal(t("Ich möchte bitte nach Osten gehen"), null, "word order the rules do not know is for the model");
	assert.equal(t("nach osten"), "go ost");
	assert.equal(t("lauf richtung klippenpfad"), "go ost");
	assert.equal(t("go to the east"), "go ost");
	assert.equal(t("nimm das Treibholz auf"), "get treibholz");
	assert.equal(t("kaufe die Muschel am Markt"), "market kaufe 1");
	assert.equal(t("kaufe am markt treibholz"), "market kaufe 2");
	assert.equal(t("kaufe Kompass am markt"), "market", "not listed: show the board");
	assert.equal(t("biete Muschel am Markt für 2 an"), "market biete muschel für 2");
	assert.equal(t("verkaufe das treibholz für 3 münzen"), "market biete treibholz für 3");
	assert.equal(t("lege holz ins feuer"), "put holz in feuer");
	assert.equal(t("legeholz ins feuer"), "put holz in feuer");
	assert.equal(t("wirf das treibholz ins leuchtfeuer"), "put treibholz in leuchtfeuer");
	assert.equal(t("schau dich um"), "look");
	assert.equal(t("was trage ich?"), "inventory");
	for (const keep of ["go ost", "get treibholz", "move 9 9", "biete treibholz an Bert für muschel", "markt biete muschel für 2", "give münze an Bert"]) assert.equal(t(keep), null, keep);
});

test("the model's answer is taken only when it is a command", () => {
	assert.equal(commandOf("put treibholz in feuer", []), "put treibholz in feuer");
	assert.equal(commandOf("`look`\nbecause …", []), "look");
	assert.equal(commandOf("ost", ["ost"]), "ost");
	for (const bad of ["?", "rm -rf /", "", "I think you mean look"]) assert.equal(commandOf(bad, []), null, bad);
});

async function player(url: string, name: string) {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123" })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
async function does(p: Player, line: string, text: string | RegExp, ms = 15_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}
const give = async (s: SpaceLike, charId: string, proto: string) => spawn(s, null, w, (await eventually(() => resolvePrototype(s, proto), 10_000, proto))!, { location: charId, x: -1, y: -1 });

test("rules in play: walking, the market and looking by sentence, each saying how it was understood", async () => {
	const srv = await startServer();
	try {
		const s = srv.stack.space;
		const a = await player(srv.url, "Sprecherin"), b = await player(srv.url, "Kaeuferin");
		await give(s, a.me, "muschel");
		await give(s, b.me, "muenze"); await give(s, b.me, "muenze");
		assert.equal(await does(a.p, "biete die Muschel am Markt für 2 an", "→"), "„biete die Muschel am Markt für 2 an“ → market biete muschel für 2");
		await a.p.until((f) => f.t === "msg" && f.m.text === "Du hängst Muschel für 2 Münzen ans Marktbrett.");
		await does(b.p, "kaufe muschel am markt", "Du kaufst Muschel vom Marktbrett.");
		assert.match(await does(b.p, "schau dich um", "Graue Bucht"), /Ausgänge/);
		const n = b.p.frames.length;
		b.p.send("gehe nach osten");
		await b.p.until((f) => f.t === "hello" && f.room.roomId === "klippenpfad", 10_000, n);
		// without model calls a sentence the rules do not know is refused as before
		assert.match(await does(b.p, "ich hätte gern das holz im feuer", "Unbekannter Befehl"), /help/);
		await a.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("the model translates what the rules miss; nonsense is refused; the daily allowance is kept", async () => {
	const env = { SPACES_MMO_LLM: "1", SPACES_MMO_LLM_MODULE: "tests/fake-llm.ts", SPACES_MMO_TRANSLATE_PER_DAY: "2" };
	const stack = await startStack({ worldEnv: env });
	const srv = await startServer({ stack });
	try {
		await stack.modelProcess();
		const s = stack.space;
		const a = await player(srv.url, "Fragende");
		await give(s, a.me, "treibholz");
		a.p.send("move 9 9");
		await eventually(async () => (await s.readIfExists({ type: "Character", fields: { charId: a.me } }, 2_000))?.fields.y === 9, 10_000, "next to the fire");
		const from = a.p.frames.length;
		assert.match(await does(a.p, "ich hätte gern das holz im feuer", "einen Moment"), /versuche das zu verstehen/);
		await a.p.until((f) => f.t === "msg" && f.m.text === "„ich hätte gern das holz im feuer“ → put treibholz in feuer", 15_000, from);
		await a.p.until((f) => f.t === "msg" && f.m.text.startsWith("Du legst Treibholz ins Leuchtfeuer"));
		assert.match(await does(a.p, "mach alles kaputt", "nicht verstanden"), /help/);
		assert.match(await does(a.p, "zeig mir alles", "nicht übersetzen"), /Kontingent/);
		assert.equal(await s.count({ type: "Translate" }), 0);
		await a.p.leave();
	} finally { await srv.close(); await stack.close(); }
});
