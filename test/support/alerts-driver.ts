// The views of src/alerts.ts over one control Space, for rust/phi-host/tests/alerts.rs. Runs and workers are not on a configured host.
//
//   node --experimental-strip-types --no-warnings test/support/alerts-driver.ts
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { createSpace, spaceDoc } from "../../src/spaces.ts";
import { auditLog, collectAlerts } from "../../src/alerts.ts";
import * as core from "../../src/core.ts";

const SPACE = "sp-00000000-0000-4000-8000-000000000001", host = openOwnMemoryHost();
await host.commit((tx) => createSpace(tx, "control", 1000, { spaceId: SPACE, incarnation: "0a0b0c0d" }), ctx);
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text), now = l.now as number;
	await host.commit(async (tx) => { const s = await spaceDoc(tx, SPACE, now); for (const [type, fields, lease] of l.write ?? []) core.write(s, now, { type, fields }, null, lease); }, ctx);
	console.log(JSON.stringify({ alerts: await collectAlerts({ host, ctx, controlSpaceId: SPACE, now: () => now }), audit: await auditLog(host, ctx, SPACE, { limit: l.limit, now: () => now }) }));
}
