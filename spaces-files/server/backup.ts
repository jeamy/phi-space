// Backups (docs/zanzibar-agent-filesystem-plan.en.md, sections 6.5 and 6.6), each an encrypted archive
// (server/archive.ts) under a key file of its own, outside the data, state and blob directories.
//
// The deployment-state backup holds the state database and both key files. It is taken after every key or epoch
// change, and a new content-key generation seals nothing until one has been taken (deployment.ts). If the state is
// lost or older than the data has seen, the service refuses to start; `restoreState` installs the newest backup into
// an empty state directory and opens the service once to bring it forward: the time floor to the newest time any
// tenant recorded, a new session epoch, a new signing generation retiring every earlier one (never a content key), a
// sequence number beyond the data's mirror, maintenance mode until every tenant is reconciled.
//
// The data backup holds the store and the blob directory: blob deletion is held, the store is copied as one read
// transaction (VACUUM INTO from a read-only connection: consistent under WAL while the writer goes on), the blobs are
// copied, and deletion resumes. Blobs are never rewritten, so the copy holds every blob the store copy names, plus
// perhaps newer ones the sweep removes after a restore. It runs with the service up (online) or with the operator's
// own process owning the stores (clean); either way it never copies a live WAL file. Its plaintext names no file
// content: the blobs stay sealed with content keys that only the state backup holds.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { extractArchive, readEntry, verifyArchive, writeArchive } from "./archive.ts";
import { CONTENT_KEYS_FILE, DeploymentState, KEYS_FILE, STATE_FILE } from "./deployment.ts";
import { prepareDataDir } from "./dirs.ts";
import { FilesService, STORE_FILE, type FilesServiceOptions } from "./service.ts";

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
	extractArchive(archive, key, o.stateDir, (n) => n === STATE_FILE || n === KEYS_FILE || n === CONTENT_KEYS_FILE ? n : null);
	const svc = await FilesService.open({ ...o, stateRestore: true });
	try {
		if (svc.state.stateId() !== meta.stateId) throw new Error("the backup's state ID does not match its database");
		return { epoch: svc.state.epoch(), seq: svc.state.seq(), mode: svc.state.mode() };
	} finally { await svc.close(); }
}

/** Writes the data backup (store and blobs) to `file`. */
export async function backupData(svc: FilesService, file: string, key: Buffer): Promise<{ bytes: number; blobs: number }> {
	if (svc.storePath === null || svc.blobs.dir === null) throw new Error("an in-memory service has no data backup");
	const release = svc.blobs.holdDeletion();
	const snap = join(svc.storePath + ".backup.tmp");
	rmSync(snap, { force: true });
	try {
		const db = new DatabaseSync(svc.storePath, { readOnly: true });
		try { db.prepare("VACUUM INTO ?").run(snap); } finally { db.close(); }
		const blobDir = svc.blobs.dir;
		const blobs: string[] = [];
		for (const t of existsSync(blobDir) ? readdirSync(blobDir) : [])
			for (const shard of statSync(join(blobDir, t)).isDirectory() ? readdirSync(join(blobDir, t)) : [])
				for (const name of statSync(join(blobDir, t, shard)).isDirectory() ? readdirSync(join(blobDir, t, shard)) : [])
					if (/^[A-Za-z0-9_-]{22}$/.test(name)) blobs.push(`${t}/${shard}/${name}`);
		const meta: BackupMeta = { kind: "data", stateId: svc.state.stateId(), seq: svc.state.seq(), time: svc.state.now() };
		const r = writeArchive(file, key, [
			{ name: META, bytes: Buffer.from(JSON.stringify(meta)) },
			{ name: `store/${STORE_FILE}`, file: snap },
			...blobs.map((b) => ({ name: `blobs/${b}`, file: join(blobDir, b) })),
		]);
		return { bytes: r.bytes, blobs: blobs.length };
	} finally {
		rmSync(snap, { force: true });
		release();
	}
}

export type RestoreStep = "intent" | "verified" | "installing" | "installed" | "rekeyed" | "checked";
export type RestoreResult = { epoch: number; tenants: Array<{ tenantId: string; contents: number; missing: number }> };

/**
 * Restores a data backup (section 6.5, steps 1 and the start of 2) with the service stopped, as a journal in the
 * deployment state that a crash resumes at its step: the intent (maintenance mode persisted), the whole archive
 * verified and bound to this deployment, the current data and blob directories moved aside and the backup installed
 * (the store snapshot never has a WAL beside it), a new session epoch and a signing generation retiring every earlier
 * one, and the blob check that closes a tenant whose contents lack their blobs. The restore stays open afterwards:
 * maintenance admits only each tenant's approved reconciler, and normal admission waits until every tenant is marked
 * reconciled in the new epoch (`FilesService.setMode`).
 */
export async function restoreData(archive: string, key: Buffer, o: Pick<FilesServiceOptions, "dataDir" | "stateDir" | "blobDir" | "now" | "limits">, hook: (step: RestoreStep) => void = () => {}): Promise<RestoreResult> {
	if (o.dataDir === null || o.stateDir === null || o.blobDir === null) throw new Error("a restore needs the data, state and blob directories");
	const dataDir = o.dataDir, blobDir = o.blobDir;
	let state = await DeploymentState.open({ dir: o.stateDir, clock: o.now });
	try {
		let j = state.restoreJournal();
		if (j !== null && j.info.archive !== archive) throw new Error(`another restore is open (${String(j.info.archive)}); complete it first`);
		if (j === null) {
			state.journalRestore("intent", { archive });
			state.beginModeTransition("maintenance");
			state.completeModeTransition();
			hook("intent");
			j = state.restoreJournal()!;
		}
		if (j.step === "intent") {
			const meta = metaOf(archive, key, "data");
			if (meta.stateId !== state.stateId()) throw new Error("the data backup belongs to another deployment");
			state.journalRestore("verified", { backupSeq: meta.seq, backupTime: meta.time });
			hook("verified");
			j = state.restoreJournal()!;
		}
		if (j.step === "verified") {
			const stamp = state.now();
			state.journalRestore("installing", { asideData: `${dataDir}.before-restore-${stamp}`, asideBlobs: `${blobDir}.before-restore-${stamp}` });
			j = state.restoreJournal()!;
		}
		if (j.step === "installing") {
			const asideData = j.info.asideData as string, asideBlobs = j.info.asideBlobs as string;
			// the current directories go aside once; a partial install of an interrupted attempt is ours to remove
			if (!existsSync(asideData) && existsSync(dataDir)) renameSync(dataDir, asideData);
			else rmSync(dataDir, { recursive: true, force: true });
			if (!existsSync(asideBlobs) && existsSync(blobDir)) renameSync(blobDir, asideBlobs);
			else rmSync(blobDir, { recursive: true, force: true });
			await prepareDataDir(dataDir);
			await prepareDataDir(blobDir);
			extractArchive(archive, key, dataDir, (n) => n === `store/${STORE_FILE}` ? STORE_FILE : null);
			extractArchive(archive, key, blobDir, (n) => n.startsWith("blobs/") ? n.slice("blobs/".length) : null);
			state.journalRestore("installed");
			hook("installed");
			j = state.restoreJournal()!;
		}
		if (j.step === "installed") {
			const epoch = state.advanceEpoch();
			state.rotateKeyRetiringAll();
			state.journalRestore("rekeyed", { epoch });
			hook("rekeyed");
			j = state.restoreJournal()!;
		}
		if (j.step === "rekeyed") {
			state.close();
			const svc = await FilesService.open({ ...o });
			try {
				const tenants = await svc.checkRestoredBlobs();
				svc.state.journalRestore("checked", { tenants });
			} finally { await svc.close(); }
			hook("checked");
			state = await DeploymentState.open({ dir: o.stateDir, clock: o.now });
			j = state.restoreJournal()!;
		}
		return { epoch: j.info.epoch as number, tenants: j.info.tenants as RestoreResult["tenants"] };
	} finally { state.close(); }
}
