// The standby of the deployment state and the blobs (docs/zanzibar-agent-filesystem-plan.en.md, section 6.7): what a
// promoted replica needs beside the Space store, which phi-spaces' primary/sync journal replicates. Every transaction of
// the deployment state reaches the standby as a numbered unit before the operation it belongs to is answered: SQLite's
// changeset of that transaction (node:sqlite sessions; every table has a primary key) and, before it, a key file that
// changed with it. Every blob reaches the standby before the content row that names it commits; a deletion is copied
// as well as it goes (an orphan left on the standby is the sweep's after a promotion).
//
// The primary seeds its standby on every open, from a snapshot of the state and a copy of the blobs it lacks, so a
// write made without the standby (an offline operator command, a restore) never leaves the two apart unnoticed. A
// promoted standby carries a marker that refuses every further seed or unit: the old primary, should it come back,
// stops at its next write. Here the standby is a pair of directories this process reaches (another disk, a mount); a
// transport to another machine implements the same two interfaces.
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { prepareDataDir } from "./dirs.ts";
import { STATE_FILE } from "./deployment.ts";

/** One transaction of the deployment state: its number, its changeset, and the key files that changed before it. */
export type StateUnit = { n: number; changeset: Uint8Array; files: Array<{ name: string; bytes: Buffer }> };
export interface StateReplica {
	/** Replaces the standby's state with the primary's: the database and key files of `snapshot()`, at unit `n`. */
	seed(n: number, entries: ReadonlyArray<{ name: string; bytes: Buffer }>): void;
	/** Applies the next unit; throws when it cannot (a gap, a conflict, a promoted standby, an unreachable one). */
	accept(unit: StateUnit): void;
}
export interface BlobReplica {
	write(tenantId: string, path: string, sealed: Buffer): Promise<void>;
	remove(tenantId: string, path: string): Promise<void>;
	/** The finished blobs the standby has of a tenant, as `shard/name`. */
	names(tenantId: string): Promise<string[]>;
}

/** The marker of a promoted standby, in both of its directories. */
export const PROMOTED = "standby-promoted";

export class StandbyRefused extends Error {
	readonly code = "unavailable";
	constructor(message: string) { super(message); this.name = "StandbyRefused"; }
}

const fsyncDir = (dir: string) => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const writeDurable = (path: string, bytes: Buffer) => {
	const tmp = `${path}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
	renameSync(tmp, path);
	fsyncDir(dirname(path));
};
const fenced = (dir: string) => { if (existsSync(join(dir, PROMOTED))) throw new StandbyRefused(`the standby in ${dir} has been promoted: this primary is fenced`); };

/** The standby in directories of this machine. */
export async function localStandby(o: { stateDir: string; blobDir: string }): Promise<{ state: StateReplica; blobs: BlobReplica; close(): void }> {
	await prepareDataDir(o.stateDir);
	await prepareDataDir(o.blobDir);
	let db: DatabaseSync | null = null;
	let last = 0;
	const state: StateReplica = {
		seed(n, entries) {
			fenced(o.stateDir);
			db?.close();
			db = null;
			const path = join(o.stateDir, STATE_FILE);
			for (const e of entries) if (e.name !== STATE_FILE) writeDurable(join(o.stateDir, e.name), e.bytes);
			// the database last, and never beside a log of another one
			for (const x of ["-wal", "-shm"]) rmSync(path + x, { force: true });
			writeDurable(path, entries.find((e) => e.name === STATE_FILE)!.bytes);
			db = new DatabaseSync(path);
			db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
			last = n;
		},
		accept(unit) {
			fenced(o.stateDir);
			if (db === null) throw new StandbyRefused("the standby was never seeded");
			if (unit.n <= last) return;                          // sent again after a lost acknowledgement
			if (unit.n !== last + 1) throw new StandbyRefused(`the standby is at unit ${last}, not ${unit.n - 1}`);
			for (const f of unit.files) writeDurable(join(o.stateDir, f.name), f.bytes);
			db.exec("BEGIN IMMEDIATE");
			try {
				// a true replica never conflicts: one that does has diverged, and nothing of the unit is taken
				const ok = db.applyChangeset(unit.changeset, { onConflict: () => constants.SQLITE_CHANGESET_ABORT });
				if (!ok) throw new StandbyRefused(`unit ${unit.n} conflicts with the standby's state`);
				db.exec("COMMIT");
			} catch (e) { db.exec("ROLLBACK"); throw e; }
			last = unit.n;
		},
	};
	const dirOf = (t: string, path: string) => join(o.blobDir, t, path.slice(0, path.indexOf("/")));
	const blobs: BlobReplica = {
		async write(t, path, sealed) {
			fenced(o.blobDir);
			const dir = dirOf(t, path), name = path.slice(path.indexOf("/") + 1);
			await mkdir(dir, { recursive: true, mode: 0o700 });
			const tmp = join(dir, `${name}.tmp`);
			const fh = await open(tmp, "w", 0o600);
			try { await fh.writeFile(sealed); await fh.sync(); } finally { await fh.close(); }
			await rename(tmp, join(dir, name));
			fsyncDir(dir);
		},
		async remove(t, path) {
			fenced(o.blobDir);
			await unlink(join(dirOf(t, path), path.slice(path.indexOf("/") + 1))).catch((e) => { if (e.code !== "ENOENT") throw e; });
		},
		async names(t) {
			const out: string[] = [];
			let shards: string[];
			try { shards = await readdir(join(o.blobDir, t)); } catch { return out; }
			for (const s of shards) for (const n of await readdir(join(o.blobDir, t, s))) if (!n.endsWith(".tmp")) out.push(`${s}/${n}`);
			return out;
		},
	};
	return { state, blobs, close: () => { db?.close(); db = null; } };
}

/**
 * Promotes the standby in these directories (after its Space store was promoted, section 6.7): the marker that fences
 * the old primary is written first, in both. The service then opens on them like any deployment.
 */
export function promoteStandby(o: { stateDir: string; blobDir: string }): void {
	for (const dir of [o.stateDir, o.blobDir]) {
		writeFileSync(join(dir, PROMOTED), `${new Date().toISOString()}\n`, { mode: 0o600 });
		fsyncDir(dir);
	}
}

/** Copies the finished blobs the standby lacks (the seed on open); `local` lists them as `shard/name` per tenant. */
export async function seedBlobs(root: string, replica: BlobReplica): Promise<number> {
	let n = 0;
	if (!existsSync(root)) return 0;
	for (const t of readdirSync(root)) {
		if (!statSync(join(root, t)).isDirectory()) continue;
		const have = new Set(await replica.names(t));
		for (const s of readdirSync(join(root, t))) for (const name of readdirSync(join(root, t, s))) {
			if (name.endsWith(".tmp") || have.has(`${s}/${name}`)) continue;
			await replica.write(t, `${s}/${name}`, await readFile(join(root, t, s, name)));
			n++;
		}
	}
	return n;
}

