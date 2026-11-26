// One site of the replica handover across processes (tests/replica-processes.test.ts): its own directories, its own
// primary/sync journal and store, the signed replica transport of phi-spaces to the other site over TCP, the standby of
// the deployment state and the blobs over mutual TLS (server/standby-host.ts's server, in this process), boot permits in
// the recovery register and a fencing adapter. Driven line by line over stdin ({id, op, ...} -> one JSON answer).
//
//   node tests/support/replica-site.ts <config.json>
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FOREVER } from "phi-spaces/core";
import {
	assertQuarantine, assertSyncPrimary, PhiSpaces, assertSyncStandby, degradeToSingle, loadFileSigner, OwnSyncStore, primarySyncStorage, PrimarySyncJournal, promote,
	recoverPrimarySync, replicaSyncHandler, serveSpace, signedReplicaPeer, SimulatorFencing, socketTransport, SqliteRecoveryRegister,
	TlsFencing, type FencingAdapter, type FenceProof, type PrimarySyncConfig, type ReplicaPin, type SpaceServer,
} from "phi-spaces";
import { FilesService } from "../../server/service.ts";
import { netStandby, serveStandby } from "../../server/standby-net.ts";
import { promoteStandby } from "../../server/standby.ts";
import { storeOnHost } from "../../server/store.ts";

type Tls = { cert: string; key: string; ca: string };
type Config = {
	self: string; root: string; signerFile: string; register: string; genesis: PrimarySyncConfig; dataIncarnation: string;
	/** The other site: its replica key, its journal port and its standby port, known once it listens. */
	remote: ReplicaPin; standbyTls: Tls; clientTls: Tls;
	/** Where this site listens and where it reaches the other one (default: this machine, ports chosen on listen). */
	bind?: string; remoteHost?: string; journalPort?: number; standbyPort?: number;
	/** The lease of a save's transaction (default 300 ms: a lost one lapses quickly). */
	saveTxnLeaseMs?: number;
	/** The fencing adapter of a promotion: the simulator (admitted by allowSimulator), or a fencing service over mutual TLS. */
	fencing?: { simulator: true } | { tls: { host: string; port: number; serverName: string; caFile: string; certFile: string; keyFile: string } };
};
const cfg: Config = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const dirs = { dataDir: join(cfg.root, "data"), stateDir: join(cfg.root, "state"), blobDir: join(cfg.root, "blobs"), store: join(cfg.root, "store") };
mkdirSync(dirs.store, { recursive: true, mode: 0o700 });
const signer = loadFileSigner(cfg.signerFile), register = new SqliteRecoveryRegister(cfg.register);
const adapter: FencingAdapter = !cfg.fencing || "simulator" in cfg.fencing ? new SimulatorFencing() : new TlsFencing({ ...cfg.fencing.tls, kind: "container" });
const bind = cfg.bind ?? "127.0.0.1", remoteHost = cfg.remoteHost ?? "127.0.0.1";
const journal = new PrimarySyncJournal(join(dirs.store, "journal.sqlite"), cfg.genesis, { self: cfg.self, assertStandby: assertSyncStandby(register, cfg.self) });
const storeFile = join(dirs.store, "files.sqlite");
let svc: FilesService | null = null, journalServer: SpaceServer | null = null, standbyServer: { close(): Promise<void> } | null = null, proof: FenceProof | null = null;
let failAt: string | null = null;
const status = () => ({ self: cfg.self, head: journal.head(), applied: journal.appliedRevision, config: journal.config, recoveredCommitted: journal.recoveredCommitted });
const need = () => { if (!svc) throw new Error("open first"); return svc; };
const common = (storage: OwnSyncStore) => ({ storage, journal, register, hostId: cfg.self, dataIncarnation: cfg.dataIncarnation, ctx, allowSimulator: adapter.kind === "simulator" });

async function handle(q: Record<string, any>): Promise<unknown> {
	switch (q.op) {
		// the standby's side: the journal over the signed transport, the state and blobs over mutual TLS
		case "listen": {
			journalServer = await serveSpace({ handleText: replicaSyncHandler({ journal: () => journal, signer, self: cfg.self, remotes: [cfg.remote], assertQuarantine: assertQuarantine(register, cfg.self) }) },
				{ listen: { host: bind, port: cfg.journalPort ?? 0 }, connection: () => ({}), maxConnections: 4, maxFrameBytes: 64 << 20 });
			const s = await serveStandby({ stateDir: dirs.stateDir, blobDir: dirs.blobDir, host: bind, port: cfg.standbyPort ?? 0, tls: cfg.standbyTls });
			standbyServer = s;
			return { journal: (journalServer.address() as { port: number }).port, standby: s.address().port };
		}
		case "unlisten": { await journalServer?.close(); journalServer = null; await standbyServer?.close(); standbyServer = null; return null; }
		// the primary's side: the store as the primary of the journal, the service with its standby on the other site
		case "open": {
			const peer = signedReplicaPeer({ transport: socketTransport({ host: remoteHost, port: q.journal }, { connectTimeoutMs: 5000, maxFrameBytes: 64 << 20 }), signer, self: cfg.self, remote: cfg.remote });
			const assert = assertSyncPrimary(register, cfg.self, journal), raw = new OwnSyncStore(storeFile);
			await recoverPrimarySync(raw, journal, peer, ctx, assert);
			const host = await primarySyncStorage(raw, journal, peer, { assertPrimary: assert }).open();
			const standby = netStandby({ host: remoteHost, port: q.standby, servername: "localhost", tls: cfg.clientTls, timeoutMs: 5000 });
			try {
				svc = await FilesService.open({
					dataDir: dirs.dataDir, stateDir: dirs.stateDir, blobDir: dirs.blobDir, saveTxnLeaseMs: cfg.saveTxnLeaseMs ?? 300, standby,
					openStore: () => storeOnHost(host, storeFile), faultHook: (p) => { if (p === failAt) { failAt = null; throw new Error("the reply was lost"); } },
				});
			} catch (e) { await host.close(ctx).catch(() => {}); throw e; }
			return status();
		}
		// the promotion of this standby: the old primary fenced, promoted under a new epoch, then alone (single), and the
		// deployment state and blobs promoted with it; the service opens on this site
		case "promote": {
			await journalServer?.close(); journalServer = null; await standbyServer?.close(); standbyServer = null;
			proof = await adapter.fence(cfg.remote.hostId, "primary lost");
			if (!(await adapter.verify(proof))) throw new Error("the fencing proof does not verify");
			const c = journal.config;
			const s1 = new OwnSyncStore(storeFile);
			try { await promote({ ...common(s1), recoveryId: "promote-b", expectedPrimaryEpoch: c.primaryEpoch, expectedReplicaConfigVersion: c.replicaConfigVersion, adapter, proof }); }
			finally { await s1.close(ctx); }
			const s2 = new OwnSyncStore(storeFile);
			try { await degradeToSingle({ ...common(s2), recoveryId: "single-b", expectedPrimaryEpoch: c.primaryEpoch + 1, expectedReplicaConfigVersion: c.replicaConfigVersion + 1, adapter, proof }); }
			finally { await s2.close(ctx); }
			promoteStandby({ stateDir: dirs.stateDir, blobDir: dirs.blobDir });
			const assert = assertSyncPrimary(register, cfg.self, journal), raw = new OwnSyncStore(storeFile);
			await recoverPrimarySync(raw, journal, null, ctx, assert);
			const host = await primarySyncStorage(raw, journal, null, { assertPrimary: assert }).open();
			svc = await FilesService.open({ dataDir: dirs.dataDir, stateDir: dirs.stateDir, blobDir: dirs.blobDir, saveTxnLeaseMs: cfg.saveTxnLeaseMs ?? 300, openStore: () => storeOnHost(host, storeFile) });
			return { ...status(), boot: (await register.get(`boot:${cfg.remote.hostId}`))?.value, proof };
		}
		// the old primary's store alone, without the service: one commit, which its fenced boot permit must refuse
		case "probeStore": {
			const peer = signedReplicaPeer({ transport: socketTransport({ host: remoteHost, port: q.journal }, { connectTimeoutMs: 1000 }), signer, self: cfg.self, remote: cfg.remote });
			const assert = assertSyncPrimary(register, cfg.self, journal), raw = new OwnSyncStore(storeFile);
			const host = await primarySyncStorage(raw, journal, peer, { assertPrimary: assert }).open();
			try { await new PhiSpaces(host, ctx).write({ type: "Probe", fields: {} }, null, FOREVER); return { committed: true }; }
			finally { await host.close(ctx).catch(() => {}); }
		}
		case "failNext": failAt = q.at; return null;
		case "createTenant": return need().createTenant(q.tenant, q.admin);
		case "provisionActor": return need().provisionActor(q.tenant, q.by, "user", q.actorId, q.home, q.login);
		case "login": return (await need().login(q.tenant, "user", q.login)).handle;
		case "ids": return need().issueOperationIds(q.handle, q.n);
		case "createWorkspace": return need().createWorkspace(q.handle, q.name, q.owner, q.opId);
		case "write": return need().write(q.handle, q.workspace, q.path, Buffer.from(q.text), q.base, q.opId);
		case "read": { const r = await need().read(q.handle, q.workspace, q.path); return { version: r.version, text: r.bytes.toString() }; }
		case "grant": return need().grant(q.handle, q.workspace, q.path, q.role, q.who, q.opId);
		case "revoke": return need().revoke(q.handle, q.workspace, q.path, q.role, q.who, q.opId);
		case "status": return status();
		default: throw new Error(`unknown op ${String(q.op)}`);
	}
}

console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
	if (!line.trim()) continue;
	let q: Record<string, any> = {};
	try { q = JSON.parse(line); console.log(JSON.stringify({ id: q.id, ok: true, result: (await handle(q)) ?? null })); }
	catch (e) { console.log(JSON.stringify({ id: q.id, ok: false, code: (e as { code?: string }).code ?? null, error: (e as Error).message.slice(0, 400) })); }
}
await (svc as FilesService | null)?.close();
journal.close();
