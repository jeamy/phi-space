// The admin's test setting "epoch.force" (engine/commands/epoch.ts): every island stands at that epoch whatever its stock is,
// the commands that ask for an epoch follow it at once, the map's state names it for the header; 0 gives the stock back its say.
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerFrame } from "../server/gateway.ts";
import { eventually, Player, startServer } from "./stack.ts";

async function does(p: Player, line: string, text: string | RegExp, ms = 30_000): Promise<string> {
	const from = p.frames.length;
	p.send(line);
	const f = await p.until((f) => f.t === "msg" && (typeof text === "string" ? f.m.text.includes(text) : text.test(f.m.text)), ms, from);
	return (f as Extract<ServerFrame, { t: "msg" }>).m.text;
}

test("epoch.force: every island at the forced epoch, at once for the commands and in the map's state", { timeout: 120_000 }, async () => {
	const srv = await startServer({ worldEnv: { SPACES_MMO_EPOCH_FORCE: "3" } });
	try {
		const p = new Player(srv.url);
		assert.equal((await p.post("/api/register", { name: "Teststufe", password: "geheim-123" })).status, 200);
		await p.play();
		assert.match(await does(p, "epoche", /\(Epoche 3\)/), /festgesetzt/);
		assert.match(await does(p, "beam", /braucht/), /Epoche 4/, "beaming asks for the fourth epoch");
		await eventually(async () => p.frames.some((f) => f.t === "atlasState" && f.state.epochs?.["Graue Insel"] === 3) || null, 10_000, "the forced epoch in the map's state");
		await p.leave();
	} finally { await srv.close(); }
});
