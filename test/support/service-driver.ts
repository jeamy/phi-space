// The service as a process (docs/rust-portierung.md, R3): the text of a call in, the text of its reply out, on one store
// with the clock and the randomness of the line, so another implementation can be held against this one byte for byte.
//
//   node --experimental-strip-types --no-warnings test/support/service-driver.ts
//
// In:  {"op": "init", "seed": "...", "now": <ms>, "store"?: "<file>", "limits"?: {...}, "maxCallsPerWindow"?: n}
//      {"now": <ms>, "peer"?: "local", "text": "<the call>", "maxFrame"?: n}
//      {"op": "setLimits", "now": <ms>, "limits": {...}}
//      {"op": "maintain"|"deliver", "now": <ms>} one round of the reaper, of delivery (src/index.ts)
//      {"op": "event", "now": <ms>, "event": {...}} an event in the outbox, as an agent host leaves it in the file
//      {"op": "close"}
// Out: {"reply": "<text>", "state": "<sha256 of the default space>"} (one line each). Randomness and the clock as in
// core-driver.ts, randomUUID included: ids of the registry come from the same stream.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { reseed, seeded, install, tick } from "./core-driver.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { deliverEvents } from "../../src/index.ts";
import { spaceDoc } from "../../src/spaces.ts";
import { SpaceService, StaticIdentity, DEFAULT_POLICY, METHODS } from "../../src/service.ts";
import { PhiSpaces, Space } from "../../src/client.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import { digestJson } from "../../src/canonical.ts";
import * as core from "../../src/core.ts";
import type { ClosableStoreHost } from "../../src/store/types.ts";

install();
(crypto as unknown as { randomUUID: () => string }).randomUUID = () => {
	const b = seeded(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
	const h = b.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
syncBuiltinESMExports();

const identity = new StaticIdentity({
	local: { principal: { peerId: "local" }, roles: ["member"] },
	agent: { principal: { peerId: "local", agentId: "a1" }, roles: ["member"] },
	watcher: { principal: { peerId: "watcher" }, roles: ["observer"] },
	typed: { principal: { peerId: "typed" }, roles: ["tasks"] },
});
const policy = { roles: { ...DEFAULT_POLICY.roles, tasks: { methods: METHODS, types: ["Task"] } } };
let host: ClosableStoreHost | undefined, service: SpaceService | undefined, file: string | undefined;
/** The state's hash; on a file without its claims, which are not enumerated. */
const state = async (): Promise<string> => {
	const s = await host!.snapshot(Space, ctx);
	if (!s) return "";
	const v = core.previewOf(s) as unknown as core.Json;
	if (process.env.PHI_SERVICE_DUMP) process.stderr.write(JSON.stringify(v) + "\n");
	return digestJson(v);
};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const text of rl) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Record<string, any>;
	let out: Record<string, unknown>;
	if (l.op === "init") {
		reseed(String(l.seed ?? ""), l.now ?? 0);
		file = l.store;
		host = file ? await openSqliteHost(file) : openOwnMemoryHost();
		reseed(String(l.seed ?? ""), l.now ?? 0); // what opening a store draws is not part of what is compared
		service = new SpaceService({ host, ctx, identity, policy, ...(l.maxCallsPerWindow ? { maxCallsPerWindow: l.maxCallsPerWindow } : {}), ...(l.maxPending ? { maxPendingPerPrincipal: l.maxPending, maxPendingPerPeer: l.maxPending * 2 } : {}) });
		if (l.limits) await new PhiSpaces(host, ctx).setLimits(l.limits);
		out = { reply: "" };
	} else if (l.op === "close") { await host!.close(ctx); out = { reply: "" }; }
	else if (l.op === "event") {
		tick(l);
		await host!.commit(async (tx) => { const s = await spaceDoc(tx, undefined, Date.now()); s.outbox.push(l.event); delete s.outboxBytes; }, ctx);
		out = { reply: "" };
	} else if (l.op === "maintain") {
		tick(l);
		const next = await host!.commit(async (tx) => { const s = await spaceDoc(tx, undefined, Date.now()); core.settle(s, Date.now()); return core.nextExpiry(s); }, ctx);
		out = { reply: next >= core.FOREVER ? "forever" : String(next) };
	} else if (l.op === "deliver") {
		tick(l);
		const before = (await host!.snapshot(Space, ctx))?.outbox.length ?? 0;
		await deliverEvents(host!, ctx);
		out = { reply: String(before - ((await host!.snapshot(Space, ctx))?.outbox.length ?? 0)) };
	} else {
		tick(l);
		if (process.env.PHI_SERVICE_TRACE) process.stderr.write(`TRACE ${l.now} ${l.peer} ${l.text.slice(0, 600)}\n`);
		const reply = await service!.handleText(l.text, { peerId: l.peer ?? "local" }, l.maxFrame);
		out = { reply };
	}
	if (l.op !== "close") out.state = await state();
	process.stdout.write(JSON.stringify(out) + "\n");
}
