// MembershipController (src/membership.ts) over scripted Members, for rust/phi-host/tests/membership_control.rs: each reply carries the
// instructions sent, the routing, the journal and the counters of the control Space, so both sides can be held against each other.
//
//   node --experimental-strip-types --no-warnings test/support/membership-driver.ts
import { createInterface } from "node:readline";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { createSpace, snapshotSpace } from "../../src/spaces.ts";
import { FederationRouting } from "../../src/federation-policy.ts";
import { MembershipController, MembershipJournal, signMembership } from "../../src/membership.ts";

type Line = Record<string, any>;
export const SPACE = "sp-00000000-0000-4000-8000-000000000001";
const signerOf = (fill: number, keyId: string) => {
	const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, fill)]), format: "der", type: "pkcs8" });
	const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
	return { keyId, algorithm: "ed25519" as const, publicKey, sign: async (b: Uint8Array) => sign(null, b, key) };
};
const control = signerOf(5, "control"), memberKey = signerOf(6, "member");
let host = openOwnMemoryHost();
let plan: any[] = [], refs = false, sent: unknown[] = [];
const transport: any = {
	pin: async () => ({ issuer: "member-peer", algorithm: memberKey.algorithm, publicKey: memberKey.publicKey }),
	apply: async (member: any, t: any) => {
		sent.push([member.id, t]);
		const q = t.value, next = plan.shift() ?? {};
		if (next === "throw") throw new Error("the line broke");
		const proof = { id: q.id, authorityId: q.authorityId, memberId: next.wrong ? "other" : q.memberId, spaceId: q.spaceId, action: q.action, state: q.action === "freeze" ? "removing" : "active", stock: next.stock ?? [], empty: next.empty ?? true };
		return signMembership("proof", proof as never, next.issuer ?? "member-peer", memberKey as never);
	},
};
const open = async () => { host = openOwnMemoryHost(); await host.commit((tx) => createSpace(tx, "control", 1000, { spaceId: SPACE, incarnation: "0a0b0c0d" }), ctx); return controller(); };
const controller = () => new MembershipController({ host, ctx, controlSpaceId: SPACE, authorityId: "a", peerId: "control-peer", signer: control as never, transport, assertAuthority: async () => {}, authorize: async () => {}, hasReferences: async () => refs, hasReferencesIn: async () => refs });
let m = await open();
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Line;
	if (l.reset) { m = await open(); if (l.routing) await host.commit(async (tx) => { Object.assign(await tx.doc(FederationRouting, SPACE, null), l.routing); }, ctx); console.log("{}"); continue; }
	plan = l.plan ?? []; refs = l.refs === true; sent = [];
	let out: Record<string, unknown>;
	try { out = { ok: true, result: await m.execute(l.id, l.kind, l.member, l.newDefault ?? undefined) }; } catch (e) { out = { ok: false, error: (e as Error).constructor.name, message: (e as Error).message }; }
	const space = await snapshotSpace(host, SPACE, ctx);
	console.log(JSON.stringify({ ...out, sent, routing: (await host.snapshot(FederationRouting, SPACE, ctx)) ?? null, journal: (await host.snapshot(MembershipJournal, SPACE, ctx)) ?? null, version: (space as any)?.authorityCounters?.policyVersion ?? null }));
}
