// The recovery building blocks as a process (docs/rust-portierung.en.md, R6b step 4): one JSON line in, one out, each a
// step of the data restore (RecoveryController with the control host's ControlAckService), the control restore
// (ControlRecoveryController) or a Member's installation (MemberTransitionInstaller) on the files of one directory, so
// that rust/phi-host/tests/recovery_cross.rs runs the same steps through the Rust ports on a copy and compares every
// answer and every row. `setup` builds the directory; every other line opens what it needs and closes it again.
//
//   In:  {"op": "<name>", "dir": "...", "now": <ms>, "seed": "...", ...arguments}
//   Out: {"ok": true, "result": ...} or {"ok": false, "code": "RequestConflict" | "PermissionDenied", "message": "..."}
//
// The fence checks are the real ones over `ssh` (verifySshFence): the test puts a stand-in for ssh first on PATH that
// answers each target's `fence/<target>.json`. Whether a host's normal runtime is stopped is `quiesced-<host>.json`.
// Randomness (a restore's incarnation, a successor's id) is the seeded stream of core-driver.ts, anew with each line.
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { syncBuiltinESMExports } from "node:module";
import { install, reseed, seeded } from "./core-driver.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { openSqliteHost } from "../../src/store/sqlite.ts";
import { PhiSpaces, core, createSpace, listSpaces, snapshotSpace, spaceDoc, provisionFileSigner, loadFileSigner, SqliteRecoveryRegister, RegisterConflict, controlBackup } from "../../src/index.ts";
import { RecoveryController } from "../../src/recovery-controller.ts";
import { ControlAckService } from "../../src/control-ack.ts";
import { ControlRecoveryController } from "../../src/control-recovery.ts";
import { MemberTransitionInstaller } from "../../src/member-transition.ts";
import { verifySshFence } from "../../src/fencing.ts";
import { FederationRouting } from "../../src/federation-policy.ts";

type Line = Record<string, any> & { op: string; dir: string; now?: number; seed?: string };
const FENCES = { "source-host": "source-host@fence", "control-host": "control-host@fence" };

function quiesced(dir: string, host: string) {
	const file = join(dir, `quiesced-${host}.json`);
	return async () => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { hostId: host, normalStopped: false, restartLocked: false };
}
const snapshots = (dir: string) => async (ref: string) => JSON.parse(readFileSync(join(dir, "snapshots", ref), "utf8"));
const registers = (dir: string) => ({ external: new SqliteRecoveryRegister(join(dir, "external.sqlite")), target: new SqliteRecoveryRegister(join(dir, "installed-target.sqlite")), member: new SqliteRecoveryRegister(join(dir, "installed-member.sqlite")), controlB: new SqliteRecoveryRegister(join(dir, "installed-control-b.sqlite")) });

async function setup(dir: string, now: number) {
	mkdirSync(join(dir, "snapshots"), { recursive: true }); mkdirSync(join(dir, "fence"), { recursive: true });
	const operator = provisionFileSigner(join(dir, "operator-key.json")), control = provisionFileSigner(join(dir, "control-key.json")), successor = provisionFileSigner(join(dir, "control-key-2.json")), target = provisionFileSigner(join(dir, "target-key.json"));
	provisionFileSigner(join(dir, "admin-key.json"));
	const r = registers(dir);
	try {
		// the data source: a Space with notes, a decided and an open request; its backup
		const source = await openSqliteHost(join(dir, "source.sqlite"));
		const notes = await source.commit((tx) => createSpace(tx, "notes", now), ctx);
		const client = new PhiSpaces(source, ctx, () => now, undefined, undefined, { space: "notes" } as never);
		for (const label of ["n1", "n2", "n3"]) await client.write({ type: "Note", fields: { label } }, null, core.FOREVER);
		const generation = await client.issueGeneration({ peerId: "worker" });
		await client.write({ type: "Note", fields: { label: "decided" } }, null, core.FOREVER, { request: { principal: { peerId: "worker" }, ...generation, requestId: "decided" } } as never);
		await client.beginOperation({ type: "Future" }, core.FOREVER, { request: { principal: { peerId: "worker" }, ...generation, requestId: "pending" } } as never, true, false);
		writeFileSync(join(dir, "snapshots", "notes.json"), JSON.stringify(await snapshotSpace(source, notes.spaceId, ctx)));
		await source.close(ctx);
		// the data target holds the Space under the same identity, admitted like any Space of its own
		const data = await openSqliteHost(join(dir, "target.sqlite"));
		await data.commit((tx) => createSpace(tx, "notes", now, { spaceId: notes.spaceId, incarnation: notes.incarnation }).then(() => {}), ctx);
		await data.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
		const permits = (infos: Array<{ spaceId: string; incarnation: string }>, authorityId = "authority") => Object.fromEntries(infos.map((i) => [i.spaceId, { state: "active", authorityId, dataIncarnation: i.incarnation, role: "local", transitionId: "t1" }]));
		await r.external.compareAndSet("boot:target-host", null, { hostId: "target-host", state: "active", spaces: permits(await listSpaces(data, ctx)) } as never);
		await data.close(ctx);
		await r.external.compareAndSet("boot:source-host", null, { hostId: "source-host", state: "active", spaces: permits([notes]) } as never);
		await r.external.compareAndSet(`placement:${notes.spaceId}`, null, { hostId: "source-host", authorityId: "authority", incarnation: notes.incarnation, primaryEpoch: 1 } as never);
		await r.external.compareAndSet("host-key:target-host", null, { peerId: "target-peer", keyId: target.keyId, algorithm: target.algorithm, publicKey: target.publicKey, state: "active", authorityId: "authority" } as never);
		// the control host: its Space knows the target's key and a Member, its routing table the Member; its backup
		const main = await openSqliteHost(join(dir, "control.sqlite"));
		const space = await main.commit((tx) => createSpace(tx, "control", now), ctx);
		await main.commit(async (tx) => {
			const s = await spaceDoc(tx, space.spaceId, now);
			core.write(s, now, { type: "PeerKey", fields: { peerId: "target-peer", keyId: target.keyId, principal: "target-peer", algorithm: target.algorithm, publicKey: target.publicKey, roles: ["host"], scope: ["*"], state: "active" } }, null, core.FOREVER);
			core.write(s, now, { type: "Member", fields: { memberId: "m1", hostId: "member-host", state: "active", authorityId: "authority" } }, null, core.FOREVER);
			const routing = await tx.doc(FederationRouting, space.spaceId, null);
			routing.members = { m1: { id: "m1", state: "active", target: { hostId: "member-host", spaceId: "sp-member", dataIncarnation: "aa000001", authorityId: "authority", primaryEpoch: 1 }, capacity: { slots: 2 } }, m2: { id: "m2", state: "active", target: { hostId: "other-host", spaceId: "sp-other", dataIncarnation: "aa000002", authorityId: "authority", primaryEpoch: 1 } } } as never;
		}, ctx);
		await r.external.compareAndSet(`authority:${space.spaceId}`, null, { authorityId: "authority", hostId: "control-host", supervisorKey: control.publicKey, state: "active" } as never);
		await r.external.compareAndSet("boot:control-host", null, { hostId: "control-host", state: "active", spaces: permits(await listSpaces(main, ctx)) } as never);
		writeFileSync(join(dir, "snapshots", "control.json"), JSON.stringify(await controlBackup(main, space.spaceId, ctx)));
		await main.close(ctx);
		// the control target holds the control Space under the same identity
		const b = await openSqliteHost(join(dir, "control-b.sqlite"));
		await b.commit((tx) => createSpace(tx, "control", now, { spaceId: space.spaceId, incarnation: space.incarnation }).then(() => {}), ctx);
		await b.commit((tx) => spaceDoc(tx, undefined, now).then(() => {}), ctx);
		await r.external.compareAndSet("boot:control-host-b", null, { hostId: "control-host-b", state: "active", spaces: permits(await listSpaces(b, ctx)) } as never);
		await b.close(ctx);
		// a Member host with work, a decided and an open request, and a generation, under the old authority
		const member = await openSqliteHost(join(dir, "member.sqlite"));
		const m = new PhiSpaces(member, ctx, () => now);
		await m.write({ type: "Task", fields: { n: 1 } }, null, core.FOREVER);
		const g = await m.issueGeneration({ peerId: "worker" });
		await m.write({ type: "Decided", fields: { retained: true } }, null, core.FOREVER, { request: { principal: { peerId: "worker" }, ...g, requestId: "decided" } } as never);
		await m.beginOperation({ type: "Future" }, core.FOREVER, { request: { principal: { peerId: "worker" }, ...g, requestId: "pending" } } as never, true, false);
		const infos = await listSpaces(member, ctx);
		await r.external.compareAndSet("boot:member-host", null, { hostId: "member-host", state: "active", spaces: permits(infos) } as never);
		for (const i of infos) await r.member.compareAndSet(`installed:member-host:${i.spaceId}`, null, permits(infos)[i.spaceId] as never);
		await member.close(ctx);
		for (const reg of [r.member, r.controlB]) await reg.compareAndSet(`installed-authority:${space.spaceId}`, null, { authorityId: "authority" } as never);
		writeFileSync(join(dir, "state.json"), JSON.stringify({ notes: notes.spaceId, notesIncarnation: notes.incarnation, control: space.spaceId, controlIncarnation: space.incarnation, operator: operator.publicKey, successor: successor.publicKey }));
	} finally { for (const reg of Object.values(r)) reg.close(); }
}

async function step(l: Line): Promise<unknown> {
	const dir = l.dir, now = l.now ?? 0, r = registers(dir), opened: Array<{ close(c: typeof ctx): Promise<void> }> = [];
	const open = async (name: string) => { const h = await openSqliteHost(join(dir, `${name}.sqlite`)); opened.push(h); return h; };
	const operator = () => loadFileSigner(join(dir, "operator-key.json"));
	const verifyFence = (id: string) => verifySshFence(r.external, id, FENCES);
	try {
		switch (l.op) {
			case "submit": case "advance": case "status": case "release": {
				const host = await open("target"), main = await open("control"), state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
				const ack = new ControlAckService({ host: main, ctx, register: r.external, hostId: "control-host", authorityId: "authority", controlSpaceId: state.control, now: () => now });
				const c = new RecoveryController({ host, ctx, hostId: "target-host", authorityId: "authority", external: r.external, installed: r.target, loadSnapshot: snapshots(dir), verifyFence, now: () => now,
					acknowledgeControl: async (job) => await ack.acknowledge({ recoveryId: job.request.recoveryId, space: job.request.space, incarnation: job.incarnation!, primaryEpoch: job.primaryEpoch!, authorityId: "authority", targetHostId: "target-host", argsHash: job.argsHash }, true) });
				return l.op === "submit" ? await c.submit(l.request) : l.op === "advance" ? await c.advance(l.recoveryId) : l.op === "status" ? await c.status(l.recoveryId) : await c.release(l.request);
			}
			case "hostKey": {
				const main = await open("control"), state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
				return await new ControlAckService({ host: main, ctx, register: r.external, hostId: "control-host", authorityId: "authority", controlSpaceId: state.control, now: () => now }).hostKey({ args: l.args } as never);
			}
			case "install": {
				const host = await open("member"), pinned = { algorithm: operator().algorithm, publicKey: operator().publicKey };
				return await new MemberTransitionInstaller({ host, ctx, hostId: "member-host", external: r.external, installed: r.member, pinned, assertQuiesced: quiesced(dir, "member-host"), now: () => now }).advance(l.proof);
			}
			case "controlSubmit": case "controlAdvance": case "authorizeKey": case "controlStatus": {
				const host = await open("control-b");
				const c = new ControlRecoveryController({ host, ctx, hostId: "control-host-b", external: r.external, installed: r.controlB, operator: operator(), supervisor: loadFileSigner(join(dir, "control-key-2.json")), loadSnapshot: snapshots(dir), verifyFence, assertQuiesced: quiesced(dir, "control-host-b"), now: () => now });
				return l.op === "controlSubmit" ? await c.submit(l.request) : l.op === "controlAdvance" ? await c.advance(l.recoveryId) : l.op === "authorizeKey" ? await c.authorizeKey(l.recoveryId, l.key) : await c.status(l.recoveryId);
			}
			default: throw new TypeError(`recovery-driver: unknown op ${l.op}`);
		}
	} finally {
		for (const h of opened) await h.close(ctx);
		for (const reg of Object.values(r)) reg.close();
	}
}

install();
// randomUUID from the same seeded stream, version 4 as node forms it
(crypto as unknown as { randomUUID: () => string }).randomUUID = () => { const b = seeded(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80; const h = b.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
syncBuiltinESMExports();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const queue: string[] = [];
let busy = false;
const run = async () => {
	if (busy) return;
	busy = true;
	while (queue.length) {
		const l = JSON.parse(queue.shift()!) as Line;
		reseed(l.seed ?? "", l.now ?? 0);
		let reply: Record<string, unknown>;
		try { reply = l.op === "setup" ? (await setup(l.dir, l.now ?? 0), { ok: true, result: null }) : { ok: true, result: core.plain((await step(l) ?? null) as never) }; }
		catch (e) { reply = { ok: false, code: e instanceof RegisterConflict ? "RequestConflict" : "PermissionDenied", message: e instanceof Error ? e.message : String(e) }; }
		process.stdout.write(JSON.stringify(reply) + "\n");
	}
	busy = false;
};
rl.on("line", (text) => { if (text.trim()) { queue.push(text); void run(); } });
