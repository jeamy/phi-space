// The operator's window (client/AdminPanel.tsx, server/settings.ts): only an admin reads and changes the settings; a
// saved value comes from the space, a reset goes back to the .env or the default; every process follows without a
// restart; the model choice switches model calls off and names the allowed models.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventually, Player, startServer, startStack } from "./stack.ts";
import type { ServerFrame } from "../server/gateway.ts";

process.env.SPACES_MMO_SETTINGS_MS = "200"; // the processes look at the settings this often (tests: at once)

async function player(url: string, name: string, token?: string): Promise<{ p: Player; me: string }> {
	const p = new Player(url);
	assert.equal((await p.post("/api/register", { name, password: "geheim-123", ...(token ? { setupToken: token } : {}) })).status, 200);
	return { p, me: (await p.play()).me.charId };
}
const settings = async (p: Player, body?: unknown) => {
	const r = await fetch(p.base + "/api/admin/settings", body === undefined ? { headers: { cookie: p.cookie } } : { method: "POST", headers: { "content-type": "application/json", "x-mmo": "1", cookie: p.cookie }, body: JSON.stringify(body) });
	return { status: r.status, body: await r.json() as any };
};
const field = (s: any, key: string) => s.fields.find((f: any) => f.key === key);

test("the window: only an admin; a saved value comes from the space, a reset goes back; values out of range are refused", async () => {
	const srv = await startServer({ accountOptions: { setupToken: "t" } });
	try {
		const admin = await player(srv.url, "Betreiberin", "t"), other = await player(srv.url, "Spielerin");
		assert.equal((await settings(other.p)).status, 403);
		assert.equal((await settings(other.p, { values: { "llm.perMin": 3 } })).status, 403);
		const before = (await settings(admin.p)).body;
		assert.deepEqual([field(before, "llm.perMin").value, field(before, "llm.perMin").source], [20, "default"]);
		assert.equal(field(before, "cmd.burst").source, "env", "tests/test-env.ts sets it");
		const saved = await settings(admin.p, { values: { "llm.perMin": 7 } });
		assert.equal(saved.status, 200);
		assert.deepEqual([field(saved.body, "llm.perMin").value, field(saved.body, "llm.perMin").source], [7, "space"]);
		assert.equal((await srv.stack.space.readAll({ type: "Setting", fields: { key: "llm.perMin" } })).length, 1, "kept in the space");
		assert.equal((await settings(admin.p, { values: { "llm.perMin": 100_000 } })).status, 400);
		assert.equal((await settings(admin.p, { values: { "keine.einstellung": 1 } })).status, 400);
		const reset = (await settings(admin.p, { values: { "llm.perMin": null } })).body;
		assert.deepEqual([field(reset, "llm.perMin").value, field(reset, "llm.perMin").source], [20, "default"]);
		await admin.p.leave(); await other.p.leave();
	} finally { await srv.close(); }
});

test("a saved limit holds at once, without a restart: two typed commands at once, the third is refused", async () => {
	const srv = await startServer({ accountOptions: { setupToken: "t" } });
	try {
		const admin = await player(srv.url, "Drossel", "t");
		assert.equal((await settings(admin.p, { values: { "cmd.burst": 2, "cmd.perSec": 1 } })).status, 200);
		const b = await player(srv.url, "Vieltipper"); // a new page: its account starts with the new burst
		const from = b.p.frames.length;
		for (let i = 1; i <= 4; i++) b.p.send(`say ${i}`);
		await b.p.until((f) => f.t === "msg" && f.m.kind === "error" && /Zu viele Befehle/.test(f.m.text), 10_000, from);
		await new Promise((r) => setTimeout(r, 600));
		const said = b.p.frames.slice(from).filter((f) => f.t === "msg" && (f as Extract<ServerFrame, { t: "msg" }>).m.kind === "say").length;
		assert.ok(said >= 2 && said <= 3, `two at once (and what refilled meanwhile), not four: ${said}`);
		await admin.p.leave(); await b.p.leave();
	} finally { await srv.close(); }
});

test("the models: the model process publishes what it can use; the admin allows them or switches model calls off", async () => {
	const stack = await startStack({ worldEnv: { SPACES_MMO_LLM: "1", SPACES_MMO_LLM_MODULE: "tests/fake-llm.ts", SPACES_MMO_SETTINGS_MS: "200" } });
	const srv = await startServer({ stack, accountOptions: { setupToken: "t" } });
	try {
		await stack.modelProcess();
		const admin = await player(srv.url, "Modellwahl", "t");
		const m = await eventually(async () => { const s = (await settings(admin.p)).body; return s.models.published ? s.models : null; }, 10_000, "the models published");
		assert.equal(m.enabled, true);
		assert.deepEqual(m.available.map((x: any) => x.label), ["scripted/scripted"]);
		assert.deepEqual([m.allowed, m.model, m.custom], [["scripted/scripted"], "scripted/scripted", false]);
		assert.equal((await settings(admin.p, { models: { on: true, allowed: ["nirgends/kein-modell"], model: null } })).status, 400);
		assert.equal((await settings(admin.p, { models: { on: true, allowed: [], model: null } })).status, 400);
		// switched off: a sentence the rules miss is not translated, and says why
		const off = (await settings(admin.p, { models: { on: false, allowed: ["scripted/scripted"], model: "scripted/scripted" } })).body;
		assert.deepEqual([off.models.on, off.models.custom], [false, true]);
		await new Promise((r) => setTimeout(r, 400)); // the model process reads the settings again
		const from = admin.p.frames.length;
		admin.p.send("zeig mir doch bitte alles");
		await admin.p.until((f) => f.t === "msg" && /nicht übersetzen/.test(f.m.text), 15_000, from);
		assert.equal((await settings(admin.p, { models: null })).body.models.custom, false, "Standard: the default choice again");
		await admin.p.leave();
	} finally { await srv.close(); await stack.close(); }
});
