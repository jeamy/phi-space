// ProfileTransitionController (src/profile-transition.ts) over scripted Members, for rust/phi-host/tests/profile_transition.rs: each reply
// carries the instructions sent, the routing, the ledger and the policy counter, so both sides can be held against each other.
//
//   node --experimental-strip-types --no-warnings test/support/profile-driver.ts
import { createInterface } from "node:readline";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openOwnMemoryHost } from "../../src/store/host.ts";
import { createSpace, snapshotSpace } from "../../src/spaces.ts";
import { FederationRouting } from "../../src/federation-policy.ts";
import { FederationOperations } from "../../src/federated-space.ts";
import { MembershipJournal, signMembership } from "../../src/membership.ts";
import { ProfileTransitionController, ProfileTransitions } from "../../src/profile-transition.ts";
import { parentJournalKey } from "../../src/federation-journals.ts";

type Line = Record<string, any>;
const SPACE = "sp-00000000-0000-4000-8000-000000000001";
const signerOf = (fill: number, keyId: string) => {
	const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, fill)]), format: "der", type: "pkcs8" });
	const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
	return { keyId, algorithm: "ed25519" as const, publicKey, sign: async (b: Uint8Array) => sign(null, b, key) };
};
const control = signerOf(5, "control"), memberKey = signerOf(6, "member");
let host = openOwnMemoryHost(), plan: any[] = [], sent: unknown[] = [];
const transport: any = {
	pin: async () => ({ issuer: "member-peer", algorithm: memberKey.algorithm, publicKey: memberKey.publicKey }),
	apply: async (member: any, t: any) => {
		sent.push([member.id, t]);
		const q = t.value, next = plan.shift() ?? {};
		if (next.throws) throw new Error("the line broke");
		const proof = { id: q.id, authorityId: q.authorityId, memberId: next.wrong ? "other" : q.memberId, spaceId: q.spaceId, action: next.action ?? q.action, state: next.state ?? (q.action === "profileResume" ? "active" : "profileFrozen") };
		return signMembership("proof", proof as never, next.issuer ?? "member-peer", memberKey as never);
	},
};
const open = async () => { host = openOwnMemoryHost(); await host.commit((tx) => createSpace(tx, "control", 1000, { spaceId: SPACE, incarnation: "0a0b0c0d" }), ctx); };
const controller = () => new ProfileTransitionController({ host, ctx, controlSpaceId: SPACE, authorityId: "a", federationId: "root", journalPartitions: 1, peerId: "control-peer", signer: control as never, transport, assertAuthority: async () => {}, authorize: async () => {} });
await open();
let c = controller();
for await (const text of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	if (!text.trim()) continue;
	const l = JSON.parse(text) as Line;
	if (l.reset) {
		await open(); c = controller();
		await host.commit(async (tx) => {
			Object.assign(await tx.doc(FederationRouting, SPACE, null), l.routing);
			if (l.journal) Object.assign(await tx.doc(MembershipJournal, SPACE, null), l.journal);
			if (l.ledger) Object.assign(await tx.doc(ProfileTransitions, SPACE, null), l.ledger);
			if (l.parents) Object.assign(await tx.doc(FederationOperations, parentJournalKey("root", 1, 0), null), l.parents);
		}, ctx);
		console.log("{}"); continue;
	}
	if (l.edit) await host.commit(async (tx) => { const d = await tx.doc(FederationRouting, SPACE, null); if (l.edit.target) d.members[l.edit.target]!.target.primaryEpoch += 1; if (l.edit.policy) d.policy = l.edit.policy; }, ctx);
	plan = l.plan ?? []; sent = [];
	let out: Record<string, unknown>;
	try { out = { ok: true, result: l.op === "start" ? await c.start(l.id, l.next) : l.op === "advance" ? await c.advance(l.id) : await c.execute(l.id, l.next) }; } catch (e) { out = { ok: false, error: (e as Error).constructor.name, message: (e as Error).message }; }
	const space = await snapshotSpace(host, SPACE, ctx);
	console.log(JSON.stringify({ ...out, sent, routing: (await host.snapshot(FederationRouting, SPACE, ctx)) ?? null, ledger: (await host.snapshot(ProfileTransitions, SPACE, ctx)) ?? null, version: (space as any)?.authorityCounters?.policyVersion ?? null }));
}
