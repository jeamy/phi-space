// A model NPC answers in the language of who spoke to it: the page says its language with each command (server/gateway.ts), the
// said line carries it, and the NPC's prompt follows (server/npc/minds.ts). Without a language the speaker's words decide.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { languageRule } from "../server/npc/minds.ts";
import { eventually, Player, startServer } from "./stack.ts";

test("the rule of an NPC's language", () => {
	assert.match(languageRule("en"), /You speak English, whatever language/);
	assert.match(languageRule(), /language you are spoken to in.*German/);
	assert.match(languageRule("en"), /commands and the names of things stay/);
});

test("what a player says carries the language the page shows", { timeout: 120_000 }, async () => {
	const srv = await startServer();
	try {
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/guest")).status, 200);
		await p.play();
		const said = async (text: string) => eventually(async () => (await srv.stack.space.readAll({ type: "Msg", fields: { kind: "say" } })).find((e) => String(e.fields.text).endsWith(text)));
		p.send("say hello there", "en");
		assert.equal((await said("hello there")).fields.lang, "en");
		p.send("say guten tag");
		assert.equal((await said("guten tag")).fields.lang, undefined);
		await p.leave();
	} finally { await srv.close(); }
});
