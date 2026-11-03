// FederationRpc (src/federation-rpc.ts) over a scripted line, for rust/phi-host/tests/federation_rpc.rs: `replies` answer the calls in
// turn, what is sent is returned, a missing reply is a broken line. Proofs and hello are the line's business and left out.
//
//   node --experimental-strip-types --no-warnings test/support/rpc-driver.ts
import { createInterface } from "node:readline";
import { createPrivateKey, sign } from "node:crypto";
import { FederationRpc } from "../../src/federation-rpc.ts";

type Line = Record<string, any>;
const seed = Buffer.alloc(32, 7);
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const signer = { keyId: "router-key", algorithm: "ed25519" as const, publicKey: "", sign: async (b: Uint8Array) => sign(null, b, key) };
let replies: unknown[] = [], sent: unknown[] = [], state: any = null;
const lease = { lease: { routerPeerId: "root", expiresAt: 100_000 } }, grant = { grant: { expiresAt: 90_000 } };
const transport = { request: async (text: string) => {
	const call = JSON.parse(text);
	// the line reaches the host of the installed target, as a Root's line does (the Rust side's proof is the line's)
	if (call.method === "challenge") return JSON.stringify({ ok: true, result: { gateHostId: (Object.values(state?.members ?? {})[0] as any)?.target?.hostId ?? "h1", observedPeerId: "root" } });
	if (call.method === "prove") return JSON.stringify({ ok: true, result: {} });
	if (call.method === "hello") return JSON.stringify({ ok: true, result: { limits: { maxFrameBytes: 16777216 } } });
	sent.push(call);
	if (!replies.length) throw new Error("the line broke");
	return JSON.stringify(replies.shift());
} };
const rpc = new FederationRpc({ state: async () => state, transport: () => transport as any, signer: signer as any, peerId: "root", lease: async () => lease as any, grant: async () => grant as any, now: () => 50_000 });
async function run(l: Line) {
	switch (l.op) {
		case "step": return await rpc.step(l.id, l.principal, l.method, l.args, l.policyVersion ?? undefined, l.origin ?? undefined);
		case "invoke": return await rpc.invoke(l.step);
		case "resolve": return await rpc.resolve(l.step);
		case "reprepare": { const r = await rpc.reprepare(l.step); return typeof r === "string" ? r : { outcome: "reprepared", spec: r }; }
		case "snapshot": return await rpc.snapshot(l.id, l.principal, l.template, l.txn ?? undefined);
		case "events": return await rpc.events(l.id, l.principal, l.step);
		case "txnActive": return await rpc.txnActive(l.id, l.principal, l.txn, l.step ?? undefined);
		default: throw new Error(`unknown line ${l.op}`);
	}
}
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Line;
	replies = l.replies ?? []; state = l.state; sent = [];
	let out: Record<string, unknown>;
	try { out = { ok: true, result: await run(l) ?? null }; } catch { out = { ok: false }; }
	console.log(JSON.stringify({ ...out, sent }));
}
