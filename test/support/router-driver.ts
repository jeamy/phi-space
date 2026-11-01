// RouterController (src/router.ts) line by line, for rust/phi-host/tests/router.rs: the same lines drive both and each answer, the
// journal index and every command document are compared. The Members are scripted: `plan` lists what the next calls of the target
// answer ("throw", or a receipt's outcome with what it changes), so a lost reply is a line of the plan.
//
//   node --experimental-strip-types --no-warnings test/support/router-driver.ts
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { digestJson } from "../../src/canonical.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { RouterCommands, RouterController, RouterJournal, type RouterReceipt, type RouterStep } from "../../src/router.ts";

type Line = Record<string, any>;
const host = openOwnMemoryHost();
let plan: any[] = [], reprepares: any[] = [], crash: string | null = null, denied = false, clock = 1000, router: RouterController | undefined;
class AuthorityLost extends Error {}
class Crash extends Error {}
const receipt = (s: Readonly<RouterStep>): RouterReceipt => {
	const next = plan.shift() ?? { outcome: "done", result: s.requestId };
	if (next === "throw") throw new Error("the line broke");
	const { tamper, ...rest } = next;
	return { target: s.target, principal: s.principal, method: s.method, generation: tamper ? "other" : s.generation, requestId: s.requestId, argHash: s.argHash, ...rest };
};
const open = (l: Line) => new RouterController({
	host, ctx, routerId: l.router, authorityId: l.authority, limits: l.limits ?? undefined, now: () => clock,
	assertAuthority: async () => { if (denied) throw new AuthorityLost("no authority"); },
	checkpoint: async (p) => { if (p === crash) { crash = null; throw new Crash(p); } },
	target: {
		protocol: "phi-spaces-rpc-v1",
		invoke: async (s) => receipt(s), resolve: async (s) => receipt(s),
		reprepare: async () => { const n = reprepares.shift() ?? "refuse"; if (n === "throw") throw new Error("the line broke"); return n; },
	},
});
async function run(l: Line): Promise<unknown> {
	plan = l.plan ?? []; reprepares = l.reprepares ?? []; crash = l.crash ?? null; denied = l.denied === true; clock += 1;
	switch (l.op) {
		case "open": router = open(l); return null;
		case "recover": return await router!.recover() ?? null;
		case "submit": return await router!.submit(l.spec, l.future ?? undefined);
		case "advance": return await router!.advance(l.id);
		case "review": return await router!.review(l.id, l.admin, l.note, l.release, async () => {});
		case "reserve": return await router!.reserveFuture(l.id, l.slots, l.bytes ?? undefined) ?? null;
		case "release": return await router!.releaseFuture(l.id) ?? null;
		case "get": return await router!.get(l.id) ?? null;
		default: throw new Error(`unknown line ${l.op}`);
	}
}
async function journal(id: string) {
	denied = false;
	const index = await host.snapshot(RouterJournal, id, ctx), commands: Record<string, unknown> = {};
	for (const k of Object.keys(index?.refs ?? {})) commands[k] = (await host.snapshot(RouterCommands, digestJson([id, k]), ctx))?.command ?? null;
	return { index: index ?? null, commands };
}
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Line;
	let out: Record<string, unknown>;
	try { out = { ok: true, result: await run(l) ?? null }; } catch (e) { out = { ok: false, error: (e as Error).constructor.name, message: (e as Error).message }; }
	console.log(JSON.stringify({ ...out, ...(await journal(l.router ?? "r1")) }));
}
