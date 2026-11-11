// A local agent host acts for its agents by `frame.agent` (docs/m1-mobile.en.md): a connection with the agentHost role
// names the agent a call is for, and the space treats the call as the principal {peerId, agentId}: its own mailbox, its
// own claims, and no agentHost role. Any other connection that names an agent is refused. With PHI_SPACES_SERVER_CMD
// the same holds for that server (test/support/service-under-test.ts).
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { RemoteSpace } from "../src/index.ts";
import { principalKey } from "../src/service.ts";
import { underTest, type Case } from "./support/service-under-test.ts";

const IDENTITIES: Case["identities"] = {
	phone: { principal: { peerId: "phone" }, roles: ["member", "agentHost"] },
	plain: { principal: { peerId: "plain" }, roles: ["member"] },
	worker: { principal: { peerId: "worker", agentId: "w1" }, roles: ["member", "agentHost"] },
};
const under = async (t: TestContext) => { const u = await underTest({ identities: IDENTITIES, background: true }); t.after(() => u.close()); return u; };

test("agent frame: the agent host's calls for an agent are that agent's principal, without the agentHost role", async (t) => {
	const u = await under(t);
	const own = await new RemoteSpace(u.transport("phone")).info();
	assert.equal(own.principal, principalKey({ peerId: "phone" }));
	assert.ok(own.roles.includes("agentHost"));
	const a = await new RemoteSpace(u.transport("phone"), { agent: "conversation-1" }).info();
	assert.equal(a.principal, principalKey({ peerId: "phone", agentId: "conversation-1" }));
	assert.deepEqual(a.roles, ["member"]);
});

test("agent frame: each agent has a mailbox of its own", async (t) => {
	const u = await under(t);
	const one = new RemoteSpace(u.transport("phone"), { agent: "conversation-1" });
	const two = new RemoteSpace(u.transport("phone"), { agent: "conversation-2" });
	const host = new RemoteSpace(u.transport("phone"));
	await one.notify({ type: "Task" }, { target: "self", lease: 60_000 });
	await host.write({ type: "Task", fields: { n: 1 } }, null, 60_000);
	let page = await one.events({ waitMs: 5_000 });
	for (let i = 0; i < 20 && page.events.length === 0; i++) page = await one.events({ waitMs: 1_000 });
	assert.equal(page.events.length, 1, "the agent that asked is told");
	assert.equal((await two.events({ waitMs: 0 })).events.length, 0, "another agent of the same host is not");
	assert.equal((await host.events({ waitMs: 0 })).events.length, 0, "nor the host itself");
});

test("agent frame: only an agent host may name an agent, and only a well-formed one", async (t) => {
	const u = await under(t);
	await assert.rejects(new RemoteSpace(u.transport("plain"), { agent: "conversation-1" }).info(), /agent host/);
	// a principal that already is an agent cannot act for another
	await assert.rejects(new RemoteSpace(u.transport("worker"), { agent: "conversation-1" }).info(), /agent host/);
	for (const bad of ["", "a b", "x".repeat(129), "ü"]) await assert.rejects(new RemoteSpace(u.transport("phone"), { agent: bad }).info(), /frame\.agent/);
});
