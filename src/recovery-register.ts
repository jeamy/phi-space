// Independent CAS register. Deploy this database on the recovery-admin system, outside host/space snapshots.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { validateErasureRegisterUpdate } from "./erasure-register-policy.ts";
import type { Json } from "./core.ts";

export type RegisterRecord<T extends Json = Json> = { version: number; value: T };
export interface RecoveryRegister { get<T extends Json>(key: string): Promise<RegisterRecord<T> | null>; compareAndSet<T extends Json>(key: string, expected: number | null, value: T): Promise<RegisterRecord<T>>; }
export class RegisterConflict extends Error {}
export class SqliteRecoveryRegister implements RecoveryRegister {
	private db: DatabaseSync;
	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		try { if (lstatSync(path).isSymbolicLink()) throw new Error("register must not be a symlink"); } catch (e) { if ((e as any).code !== "ENOENT") throw e; }
		this.db = new DatabaseSync(path); chmodSync(path, 0o600);
		this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL)");
	}
	async get<T extends Json>(key: string): Promise<RegisterRecord<T> | null> {
		const r = this.db.prepare("SELECT version,value FROM records WHERE key=?").get(key) as { version: number; value: string } | undefined;
		return r ? { version: r.version, value: JSON.parse(r.value) as T } : null;
	}
	async compareAndSet<T extends Json>(key: string, expected: number | null, value: T): Promise<RegisterRecord<T>> {
		if (!key || (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))) throw new RegisterConflict("invalid register key/version");
		const encoded = canonicalJson(value);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const prior = this.db.prepare("SELECT version,value FROM records WHERE key=?").get(key) as { version: number; value: string } | undefined;
			if ((prior?.version ?? null) !== expected) throw new RegisterConflict("register version changed");
			validateErasureRegisterUpdate(key, JSON.parse(encoded), prior ? JSON.parse(prior.value) : null, relatedKey => {
                const related = this.db.prepare("SELECT value FROM records WHERE key=?").get(relatedKey) as {value: string} | undefined;
                return related ? JSON.parse(related.value) : null;
            }, message => { throw new RegisterConflict(message); });
            const version = (expected ?? 0) + 1;
			this.db.prepare("INSERT INTO records(key,version,value) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version,value=excluded.value").run(key, version, encoded);
			this.db.exec("COMMIT"); return { version, value: JSON.parse(encoded) as T };
		} catch (e) { this.db.exec("ROLLBACK"); throw e; }
	}
	close(): void { this.db.close(); }
}
