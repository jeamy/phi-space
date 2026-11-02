// One replica host of `run.ts replica|entry`, a control host of `run.ts change` whose main store runs on primary/sync, or the recovery-only service of
// `run.ts control-restore` (`recovery NAME`), on the configured runtime: `run NAME` is the daemon, or its quarantine start; `tool NAME JSON` is
// the operator's tool for one primary/sync Space, with the daemon stopped (test/testbed/federation-host.ts, mode sync).
import { renameSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { EntryReplicationController, startMemberRecoveryOnly, startRecoveryOnly, OWN_SYNC_FACTORIES, OwnSyncStore, SqliteRecoveryRegister, assertSyncPrimary, lastConfigTransition, openSyncSpace, primarySyncStorage, promotionEvidence, recoverPrimarySync, PrimarySyncJournal, TlsFencing, TlsRecoveryRegister, assertSyncStandby, canonicalJson, degradeToSingle, loadFileSigner, materializeSyncHistory, promote, setStandby, signedReplicaPeer, snapshotSpace, socketTransport, startConfiguredFederation, startQuarantineReplicas } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";

const [mode, name, input] = process.argv.slice(2);
const file = `/fed/${name}.config.json`, cfg = JSON.parse(readFileSync(file, "utf8"));
const stopOn = (close: () => Promise<unknown>) => { for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => void close().finally(() => process.exit(0))); };

if (mode === "recovery") {
	// the recovery-only service of a stopped, restart-locked host (federation-host.ts, modes recovery and member-recovery): quiesced is what the
	// independent fence status says over ssh, the same answer the restore itself asks for
	const recoveryFile = `/fed/${name}.recovery.json`, rc = JSON.parse(readFileSync(recoveryFile, "utf8")), host = await openSqliteHost(`/fed/${name}.sqlite`);
	const assertQuiesced = async () => { const status = JSON.parse(execFileSync("ssh", ["-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", rc.fenceStatus, "phi-spaces-fence-status"], { encoding: "utf8" })); return { hostId: status.hostId, normalStopped: status.stopped === true, restartLocked: status.restartLocked === true }; };
	const recovery = await (cfg.mode === "control" ? startRecoveryOnly : startMemberRecoveryOnly)(host, ctx, recoveryFile, assertQuiesced);
	stopOn(async () => { await recovery.close(); await host.close(ctx); });
	console.log(JSON.stringify({ recoveryReady: true }));
} else if (mode === "run" && cfg.mainSync) {
	// a host whose main store runs on primary/sync (test/testbed/federation-host.ts): not its primary, or in quarantine, it only listens
	const m = cfg.mainSync, external = new TlsRecoveryRegister(cfg.registerTls), probe = new PrimarySyncJournal(join(m.dir, "journal.sqlite"), m.genesis, { self: cfg.hostId }), primary = probe.config.primaryReplica;
	probe.close();
	if (primary !== cfg.hostId || (await external.get<{ state: string }>(`boot:${cfg.hostId}`))?.value.state === "quarantine") {
		const installed = new SqliteRecoveryRegister(cfg.installedRegisterFile);
		const sp = await openSyncSpace({ config: { alias: "control-main", spaceId: m.genesis.spaceId, incarnation: m.incarnation, dir: m.dir, genesis: m.genesis, port: m.port, peers: m.peers }, hostId: cfg.hostId, authorityId: m.genesis.authorityId, bindIp: cfg.listen.host, signer: loadFileSigner(cfg.keyFile), external, installed, ctx,
			openStorage: async (path) => new OwnSyncStore(path), openHarness: async () => { throw new Error("no Harness on a main store replica"); }, listenOnly: true });
		stopOn(async () => { await sp.close(); external.close(); installed.close(); });
		console.log(JSON.stringify({ mainReplicaListening: true, head: sp.journal.head() }));
	} else {
		const journal = new PrimarySyncJournal(join(m.dir, "journal.sqlite"), m.genesis, { self: cfg.hostId, assertStandby: assertSyncStandby(external, cfg.hostId) });
		const standby = journal.config.durability === "single" ? undefined : m.peers.find((p: { hostId: string }) => p.hostId === journal.config.standbyReplica);
		const transport = standby ? socketTransport({ host: standby.ip, port: m.port }, { localAddress: cfg.listen.host, connectTimeoutMs: 8000, maxFrameBytes: 1 << 20 }) : undefined;
		const peer = transport ? signedReplicaPeer({ transport, signer: loadFileSigner(cfg.keyFile), self: cfg.hostId, remote: standby }) : null;
		const raw = new OwnSyncStore(`/fed/${name}.sqlite`), assert = assertSyncPrimary(external, cfg.hostId, journal);
		await recoverPrimarySync(raw, journal, peer, ctx, assert);
		const host = await primarySyncStorage(raw, journal, peer, { assertPrimary: assert }).open();
		const runtime = await startConfiguredFederation(host, ctx, file, { openSyncStorage: OWN_SYNC_FACTORIES.openStorage, openSyncHarness: OWN_SYNC_FACTORIES.openHarness, mainReplica: () => journal.config, mainTransition: () => lastConfigTransition(journal), mainPromotionProof: (e: number) => promotionEvidence(journal, e, cfg.hostId) });
		stopOn(async () => { await runtime.close(); await host.close(ctx); transport?.close(); journal.close(); external.close(); });
		console.log(JSON.stringify({ ready: true }));
	}
} else if (mode === "run" && process.env[`${name!.replace("-", "_").toUpperCase()}_IMPL`] === "rust") {
	// the Rust host (phi-space-server --member with syncSpaces): the same lines, its quarantine start included
	const child = spawn("phi-space-server", ["--store", `/fed/${name}.sqlite`, "--member", file], { stdio: "inherit" });
	child.on("exit", (code) => process.exit(code ?? 1));
	for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => child.kill(s));
} else if (mode === "run") {
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
} else if (!cfg.mainSync && process.env[`${name!.replace("-", "_").toUpperCase()}_IMPL`] === "rust" && !JSON.parse(input!).materialize) {
	// the Rust tool (phi-space-server --replica-tool); what the stores hold is read by the TypeScript one below
	console.log(execFileSync("phi-space-server", ["--replica-tool", file, input!], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1));
	process.exit(0);
} else {
	// the main store (its harness is the host's store, its sibling Spaces follow) or the primary/sync Space
	const q = JSON.parse(input!), c = cfg.mainSync ? { ...cfg.mainSync, spaceId: cfg.mainSync.genesis.spaceId, harness: `/fed/${name}.sqlite` } : { ...cfg.syncSpaces[0], harness: join(cfg.syncSpaces[0].dir, "harness.sqlite"), siblings: [] }, reader = new TlsRecoveryRegister(cfg.registerTls);
	const journal = new PrimarySyncJournal(join(c.dir, "journal.sqlite"), c.genesis, { ...c.journal, self: cfg.hostId, assertStandby: assertSyncStandby(reader, cfg.hostId) });
	const raw = async () => new OwnSyncStore(c.harness);
	const status = () => ({ head: journal.head(), applied: journal.appliedRevision, config: journal.config, recoveredCommitted: journal.recoveredCommitted });
	let result: Record<string, unknown>;
	if (q.op === "status") {
		result = status();
		if (journal.head().revision > journal.appliedRevision) result.candidate = JSON.stringify(journal.intent(journal.head().revision));
		if (q.revision !== undefined) result.atRevision = journal.intent(q.revision)?.hash ?? null;
		result.appliedHash = journal.appliedRevision ? journal.intent(journal.appliedRevision)!.hash : null;
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
		const register = new TlsRecoveryRegister(q.register), storage = await raw(), base = { storage, journal, register, hostId: cfg.hostId, dataIncarnation: c.incarnation, ctx, siblingSpaces: c.siblings };
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
