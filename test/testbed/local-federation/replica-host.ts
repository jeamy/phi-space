// One replica host of `run.ts replica`, on the configured runtime: `run NAME` is the daemon, or its quarantine start; `tool NAME JSON` is
// the operator's tool for one primary/sync Space, with the daemon stopped (test/testbed/federation-host.ts, mode sync).
import { renameSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { EntryReplicationController, OwnSyncStore, PrimarySyncJournal, TlsFencing, TlsRecoveryRegister, assertSyncStandby, canonicalJson, degradeToSingle, loadFileSigner, materializeSyncHistory, promote, setStandby, signedReplicaPeer, snapshotSpace, socketTransport, startConfiguredFederation, startQuarantineReplicas } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";

const [mode, name, input] = process.argv.slice(2);
const file = `/fed/${name}.config.json`, cfg = JSON.parse(readFileSync(file, "utf8"));
const stopOn = (close: () => Promise<unknown>) => { for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => void close().finally(() => process.exit(0))); };

if (mode === "run") {
	const register = new TlsRecoveryRegister(cfg.registerTls), state = (await register.get<{ state: string }>(`boot:${cfg.hostId}`))?.value.state;
	register.close();
	if (state === "quarantine") {
		const q = await startQuarantineReplicas(ctx, file, {}, { pollMs: 500 });
		stopOn(() => q.close());
		console.log(JSON.stringify({ quarantine: true }));
		if (await q.untilActive()) { await q.close(); console.log(JSON.stringify({ leftQuarantine: true })); }
		process.exit(0);
	}
	const host = await openSqliteHost(`/fed/${name}.sqlite`), runtime = await startConfiguredFederation(host, ctx, file);
	stopOn(async () => { await runtime.close(); await host.close(ctx); });
	console.log(JSON.stringify({ ready: true }));
} else if (cfg.entryReplication) {
	// what the store holds of the replicated types, read with the daemon stopped
	const er = cfg.entryReplication, host = await openSqliteHost(`/fed/${name}.sqlite`);
	const controller = new EntryReplicationController({ host, ctx, config: { spaceId: er.spaceId, authorityId: cfg.authorityId, replicaId: er.replicaId, incarnation: er.incarnation, members: er.members, rules: er.rules }, authorize: async () => {}, assertActive: async () => {}, clockUncertaintyMs: () => 1000 });
	const entries = (await controller.read()).map((v) => JSON.stringify({ type: v.type, fields: v.fields })).sort().map((e) => JSON.parse(e));
	await host.close(ctx);
	console.log(JSON.stringify({ entries }));
	process.exit(0);
} else {
	const q = JSON.parse(input!), c = cfg.syncSpaces[0], reader = new TlsRecoveryRegister(cfg.registerTls);
	const journal = new PrimarySyncJournal(join(c.dir, "journal.sqlite"), c.genesis, { ...c.journal, self: cfg.hostId, assertStandby: assertSyncStandby(reader, cfg.hostId) });
	const raw = async () => new OwnSyncStore(join(c.dir, "harness.sqlite"));
	const status = () => ({ head: journal.head(), applied: journal.appliedRevision, config: journal.config, recoveredCommitted: journal.recoveredCommitted });
	let result: Record<string, unknown>;
	if (q.op === "status") {
		result = status();
		if (journal.head().revision > journal.appliedRevision) result.candidate = JSON.stringify(journal.intent(journal.head().revision));
		if (q.revision !== undefined) result.atRevision = journal.intent(q.revision)?.hash ?? null;
		if (q.materialize) {
			const st = await raw();
			await materializeSyncHistory(st, journal, ctx);
			await st.close(ctx);
			const view = await (await raw()).openHost(), space = await snapshotSpace(view, c.spaceId, ctx);
			result.entries = space?.entries.filter((e: { type: string }) => e.type === "Ledger").map((e: { fields: unknown }) => e.fields);
			result.snapshot = createHash("sha256").update(canonicalJson(space as never)).digest("hex");
			await view.close(ctx);
		}
	} else if (q.op === "wipe") {
		journal.close();
		result = { aside: c.dir + ".aside" };
		renameSync(c.dir, c.dir + ".aside");
	} else {
		const register = new TlsRecoveryRegister(q.register), storage = await raw(), base = { storage, journal, register, hostId: cfg.hostId, dataIncarnation: c.incarnation, ctx };
		if (q.op === "set-standby") {
			const peer = c.peers.find((p: { hostId: string }) => p.hostId === q.target), t = socketTransport({ host: peer.ip, port: c.port }, { localAddress: cfg.listen.host, connectTimeoutMs: 8000, maxFrameBytes: 1 << 20 });
			result = await setStandby({ ...base, transitionId: q.tid, target: signedReplicaPeer({ transport: t, signer: loadFileSigner(cfg.keyFile), self: cfg.hostId, remote: peer }), targetDataIncarnation: c.incarnation });
			t.close();
		} else {
			const adapter = new TlsFencing({ ...q.fencing, kind: "container" }), other = (q.op === "promote" ? journal.config.primaryReplica : journal.config.standbyReplica) ?? "", proof = await adapter.fence(other, `${q.op} ${q.tid}`), o = { ...base, recoveryId: q.tid, expectedPrimaryEpoch: q.epoch, expectedReplicaConfigVersion: q.version, adapter, proof };
			result = { ...(q.op === "promote" ? await promote(o) : await degradeToSingle(o)), proof: { kind: proof.kind, evidence: proof.evidence }, verified: await adapter.verify(proof) };
		}
		await storage.close(ctx);
		register.close();
	}
	try { journal.close(); } catch { /* wipe closed it */ }
	reader.close();
	console.log(JSON.stringify(result));
	process.exit(0);
}
