// Backups (docs/zanzibar-agent-filesystem-plan.en.md, sections 6.5 and 6.6), each an encrypted archive
// (server/archive.ts) under a key file of its own, outside the data, state and blob directories.
//
// The deployment-state backup holds the state database and both key files. It is taken after every key or epoch
// change, and a new content-key generation seals nothing until one has been taken (deployment.ts). If the state is
// lost or older than the data has seen, the service refuses to start; `restoreState` installs the newest backup into
// an empty state directory and opens the service once to bring it forward: the time floor to the newest time any
// tenant recorded, a new session epoch, a new signing generation retiring every earlier one (never a content key), a
// sequence number beyond the data's mirror, maintenance mode until every tenant is reconciled.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractArchive, readEntry, verifyArchive, writeArchive } from "./archive.ts";
import { CONTENT_KEYS_FILE, DeploymentState, KEYS_FILE, STATE_FILE } from "./deployment.ts";
import { prepareDataDir } from "./dirs.ts";
import { FilesService, type FilesServiceOptions } from "./service.ts";

const META = "backup.json";
type BackupMeta = { kind: "state" | "data"; stateId: string; seq: number; time: number };

/** Writes the deployment state's backup to `file`, then records it as backed up (which frees newer content keys). */
export function backupState(svc: FilesService, file: string, key: Buffer): { seq: number; bytes: number } {
	const snap = svc.state.snapshot();
	const meta: BackupMeta = { kind: "state", stateId: svc.state.stateId(), seq: snap.seq, time: svc.state.now() };
	const r = writeArchive(file, key, [{ name: META, bytes: Buffer.from(JSON.stringify(meta)) }, ...snap.entries]);
	svc.state.markBackedUp(snap.seq);
	return { seq: snap.seq, bytes: r.bytes };
}

function metaOf(archive: string, key: Buffer, kind: BackupMeta["kind"]): BackupMeta {
	verifyArchive(archive, key);
	const raw = readEntry(archive, key, META);
	const meta = raw === null ? null : JSON.parse(raw.toString("utf8")) as BackupMeta;
	if (!meta || meta.kind !== kind) throw new Error(`${archive} is no ${kind} backup`);
	return meta;
}

/**
 * Installs a deployment-state backup into the empty `stateDir` and brings it forward (see above). The service must be
 * stopped: the owner locks refuse otherwise. Returns the new epoch and sequence number.
 */
export async function restoreState(archive: string, key: Buffer, o: Pick<FilesServiceOptions, "dataDir" | "stateDir" | "blobDir" | "now" | "limits">): Promise<{ epoch: number; seq: number; mode: string }> {
	if (o.stateDir === null) throw new Error("restore-state needs a state directory");
	if (DeploymentState.existsIn(o.stateDir)) throw new Error(`${o.stateDir} already holds a deployment state; move it aside first`);
	const meta = metaOf(archive, key, "state");
	await prepareDataDir(o.stateDir);
	for (const f of [KEYS_FILE, CONTENT_KEYS_FILE, `${STATE_FILE}-wal`, `${STATE_FILE}-shm`])
		if (existsSync(join(o.stateDir, f))) throw new Error(`${join(o.stateDir, f)} is left from an earlier state; move it aside first`);
	extractArchive(archive, key, o.stateDir, (n) => n === STATE_FILE || n === KEYS_FILE || n === CONTENT_KEYS_FILE);
	const svc = await FilesService.open({ ...o, stateRestore: true });
	try {
		if (svc.state.stateId() !== meta.stateId) throw new Error("the backup's state ID does not match its database");
		return { epoch: svc.state.epoch(), seq: svc.state.seq(), mode: svc.state.mode() };
	} finally { await svc.close(); }
}
