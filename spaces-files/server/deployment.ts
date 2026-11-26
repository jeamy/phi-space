// The deployment state (docs/zanzibar-agent-filesystem-plan.en.md, section 6.6): what must survive a restore of the data
// store unchanged, so it lives beside it in a directory of its own: the session epoch, the signing-key generations,
// the durable time floor, the session table and the login index. A plain SQLite database (node:sqlite) with an
// exclusive owner lock like the data store's, every change committed with synchronous=FULL before the service acts on
// it. Key material sits in `keys.json` (mode 600) beside it; the database holds only generation numbers and times.
// The content keys that seal the file blobs (section 3, *Contents*) are a second set of generations with their own
// file, `content-keys.json`: a restore retires signing keys but never a content key, since that would make every blob
// it sealed unreadable, and losing them loses every file content.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareDataDir } from "./dirs.ts";
import type { StateReplica } from "./standby.ts";

export const STATE_FILE = "state.sqlite";
export const KEYS_FILE = "keys.json";
export const CONTENT_KEYS_FILE = "content-keys.json";

export class StateUnavailable extends Error {
	constructor(message: string) { super(message); this.name = "StateUnavailable"; }
}

/** The standby did not confirm a change of the state (section 6.7): nothing more is written until a restart seeds it anew. */
export class StateNotReplicated extends Error {
	readonly code = "unavailable";
	readonly retryAfterMs = 1000;
	constructor(message: string) { super(message); this.name = "StateNotReplicated"; }
}

/** The effective clock jumped further ahead than allowed: issuance and cleanup wait for operator review (section 6.2). */
export class ClockJump extends Error {
	readonly code = "unavailable";
	constructor(message: string) { super(message); this.name = "ClockJump"; }
}

export type ActorKind = "user" | "agent";
/** A session's actor: a tenant actor, or a recoverer of the open restore (section 6.5, step 2). */
export type SessionKind = ActorKind | "recoverer";
export type SessionView = { tenantId: string; actorKind: SessionKind; actorId: string; epoch: number; expiresAt: number };
export type KeyGeneration = { generation: number; secret: Buffer; createdAt: number; validUntil: number | null };

export type DeploymentOptions = {
	/** The state directory; `null` keeps everything in memory (tests). */
	dir: string | null;
	/** The wall clock; the effective time never goes below the durable floor (section 6.2). */
	clock?: () => number;
	/** A forward step of the clock larger than this stops `now()` until `acceptClock()` (default one day). */
	maxClockJumpMs?: number;
	/** Session lifetimes. */
	sessionIdleMs?: number;
	sessionAbsoluteMs?: number;
	/** Called after every change that raises the state's sequence number (keys, epoch), with the new number: the
	 *  service mirrors it beside the data, so a lost or older state is refused on the next start. */
	onSeq?: (stateId: string, seq: number) => void;
	/** The standby (section 6.7): seeded on open, then every transaction reaches it before it returns. */
	replica?: StateReplica;
	/** The standby failed to confirm a transaction: the state refuses every further write from then on. */
	onPoisoned?: (e: Error) => void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS key_generations (generation INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, valid_until INTEGER);
CREATE TABLE IF NOT EXISTS content_key_generations (generation INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, created_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (handle_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
	epoch INTEGER NOT NULL, created_at INTEGER NOT NULL, idle_until INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS closed_tenants (tenant_id TEXT PRIMARY KEY, reason TEXT NOT NULL, action TEXT NOT NULL, closed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logins (issuer TEXT NOT NULL, subject TEXT NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY (issuer, subject, tenant_id));
CREATE TABLE IF NOT EXISTS restore_journal (id INTEGER PRIMARY KEY CHECK (id = 1), step TEXT NOT NULL, info TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roster (tenant_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, issuer, subject));
CREATE TABLE IF NOT EXISTS reconcilers (tenant_id TEXT NOT NULL, epoch INTEGER NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (tenant_id, epoch));
CREATE TABLE IF NOT EXISTS reconciled (tenant_id TEXT NOT NULL, epoch INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (tenant_id, epoch));
CREATE TABLE IF NOT EXISTS recoverers (actor_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS operator_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, operation TEXT NOT NULL, detail TEXT NOT NULL);
`;

const hashHandle = (handle: string) => createHash("sha256").update(handle, "utf8").digest("hex");

export class DeploymentState {
	readonly #db: DatabaseSync;
	readonly #lock: DatabaseSync | null;
	readonly #keysPath: string | null;
	#keys = new Map<number, Buffer>();
	readonly #contentKeysPath: string | null;
	#contentKeys = new Map<number, Buffer>();
	readonly #clock: () => number;
	readonly #maxJump: number;
	readonly #idleMs: number;
	readonly #absoluteMs: number;
	#highWater: number;
	#closed = false;
	readonly #onSeq?: (stateId: string, seq: number) => void;
	#replica: StateReplica | null = null;
	readonly #onPoisoned?: (e: Error) => void;
	#poisoned: Error | null = null;
	/** The key files written since the last transaction: they go to the standby ahead of its changeset. */
	#pendingFiles: Array<{ name: string; bytes: Buffer }> = [];
	/** True when this open created the state: a deployment whose data already exists must never get one this way. */
	fresh = false;

	private constructor(db: DatabaseSync, lock: DatabaseSync | null, dir: string | null, o: DeploymentOptions) {
		this.#db = db;
		this.#lock = lock;
		this.#keysPath = dir === null ? null : join(dir, KEYS_FILE);
		this.#contentKeysPath = dir === null ? null : join(dir, CONTENT_KEYS_FILE);
		this.#clock = o.clock ?? Date.now;
		this.#maxJump = o.maxClockJumpMs ?? 24 * 3600_000;
		this.#idleMs = o.sessionIdleMs ?? 3600_000;
		this.#absoluteMs = o.sessionAbsoluteMs ?? 12 * 3600_000;
		this.#highWater = 0;
		this.#onSeq = o.onSeq;
		this.#onPoisoned = o.onPoisoned;
	}

	/** Whether a state directory holds a deployment state (checked before opening, so that a lost one is not recreated). */
	static existsIn(dir: string): boolean { return existsSync(join(dir, STATE_FILE)); }

	static async open(o: DeploymentOptions): Promise<DeploymentState> {
		if (o.dir === null) {
			const s = new DeploymentState(new DatabaseSync(":memory:"), null, null, o);
			s.#init();
			return s;
		}
		await prepareDataDir(o.dir);
		const path = join(o.dir, STATE_FILE);
		const lock = new DatabaseSync(`${path}.owner`, { timeout: 0 });
		try { lock.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;"); }
		catch (e) { lock.close(); throw new StateUnavailable(`another process owns the deployment state ${path} (${(e as Error).message})`); }
		let db: DatabaseSync | null = null;
		try {
			db = new DatabaseSync(path, { timeout: 10_000 });
			db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
			const s = new DeploymentState(db, lock, o.dir, o);
			s.#init();
			if (o.replica) {
				// the standby starts from this state as it is now; from here on every transaction follows it
				const snap = s.snapshot();
				o.replica.seed(s.#meta("replica_unit"), snap.entries);
				s.#pendingFiles = [];
				s.#replica = o.replica;
			}
			return s;
		} catch (e) { db?.close(); lock.close(); throw e; }
	}

	#init(): void {
		this.fresh = this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() === undefined;
		this.#db.exec(SCHEMA);
		// a state from before the sequence number: its content keys count as created before any backup
		if (!(this.#db.prepare("PRAGMA table_info(content_key_generations)").all() as Array<{ name: string }>).some((c) => c.name === "created_seq"))
			this.#db.exec("ALTER TABLE content_key_generations ADD COLUMN created_seq INTEGER NOT NULL DEFAULT 0");
		this.#tx(() => {
			if (this.#text("state_id") === null) { this.#setText("state_id", randomBytes(16).toString("hex")); this.#setMeta("state_seq", 0); this.#setMeta("backed_up_seq", 0); }
			const put = this.#db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)");
			put.run("format_version", "1"); put.run("session_epoch", "1"); put.run("time_floor", "0");
		});
		if (this.#meta("format_version") > 1) throw new StateUnavailable("the deployment state has a newer format");
		this.#highWater = Math.max(this.#highWater, this.#meta("time_floor"));
		this.#keys = loadKeyFile(this.#keysPath, this.#db, "key_generations");
		if (this.currentKey() === undefined) this.#installGeneration(null);
		this.#contentKeys = loadKeyFile(this.#contentKeysPath, this.#db, "content_key_generations");
		if (this.#contentKeys.size === 0) this.rotateContentKey();
	}

	// ---------------------------------------------------------------- time (section 6.2)

	/** The effective time: never below the durable floor or an earlier answer, also when the wall clock goes back. */
	now(): number {
		const wall = this.#clock();
		if (wall > this.#highWater + this.#maxJump && this.#highWater > 0) throw new ClockJump(`the clock jumped ${wall - this.#highWater} ms ahead; accept it with acceptClock() after review`);
		this.#highWater = Math.max(this.#highWater, wall);
		return this.#highWater;
	}

	/** Accepts a large forward step of the clock after operator review. */
	acceptClock(): number {
		this.#highWater = Math.max(this.#highWater, this.#clock());
		this.commitFloor(this.#highWater);
		return this.#highWater;
	}

	/** Persists `t` as the durable floor before a decision that depends on it (an expiry, a receipt removal). */
	commitFloor(t: number): void {
		if (t <= this.#meta("time_floor")) return;
		this.#tx(() => this.#setMeta("time_floor", t));
		this.#highWater = Math.max(this.#highWater, t);
	}

	timeFloor(): number { return this.#meta("time_floor"); }

	// ---------------------------------------------------------------- identity, sequence, backup (section 6.6)

	/** Random at creation, kept by a backup and its restore: a state from another deployment is never taken. */
	stateId(): string { return this.#text("state_id")!; }
	/** Raised by every change a restore must not roll back unnoticed (keys, epoch); mirrored beside the data. */
	seq(): number { return this.#meta("state_seq"); }
	/** The sequence number of the newest backup taken. */
	backedUpSeq(): number { return this.#meta("backed_up_seq"); }

	/** Inside a transaction: the next sequence number, announced once the transaction has committed. */
	#bump(): number { const next = this.seq() + 1; this.#setMeta("state_seq", next); this.#announce = next; return next; }
	#announce: number | null = null;

	/** Raises the sequence number to at least `n` (a restored state goes beyond the mirror it is checked against). */
	raiseSeq(n: number): void {
		if (n <= this.seq()) return;
		this.#tx(() => { this.#setMeta("state_seq", n); this.#announce = n; });
	}

	/**
	 * A consistent copy of the state for its backup: the database (VACUUM INTO, one read transaction) and both key
	 * files, as archive entries; `markBackedUp(seq)` records it once the archive is durable.
	 */
	snapshot(): { seq: number; entries: Array<{ name: string; bytes: Buffer }> } {
		if (this.#keysPath === null) throw new StateUnavailable("an in-memory deployment state has no backup");
		const tmp = join(dirname(this.#keysPath), "backup.tmp.sqlite");
		rmSync(tmp, { force: true });
		const seq = this.seq();
		try {
			this.#db.prepare("VACUUM INTO ?").run(tmp);
			return { seq, entries: [
				{ name: STATE_FILE, bytes: readFileSync(tmp) },
				{ name: KEYS_FILE, bytes: readFileSync(this.#keysPath) },
				{ name: CONTENT_KEYS_FILE, bytes: readFileSync(this.#contentKeysPath!) },
			] };
		} finally { rmSync(tmp, { force: true }); }
	}

	markBackedUp(seq: number): void {
		if (seq > this.backedUpSeq()) this.#tx(() => this.#setMeta("backed_up_seq", seq));
	}

	// ---------------------------------------------------------------- session epoch

	epoch(): number { return this.#meta("session_epoch"); }

	/** Advances the session epoch (on restore): every session of an older epoch stops working, and is deleted. */
	advanceEpoch(): number {
		const next = this.epoch() + 1;
		this.#tx(() => {
			this.#setMeta("session_epoch", next);
			this.#db.prepare("DELETE FROM sessions WHERE epoch < ?").run(next);
			this.#bump();
		});
		return next;
	}

	// ---------------------------------------------------------------- signing keys (section 6.2)

	/** The generation new operation IDs are signed with. */
	currentKey(): KeyGeneration | undefined {
		const row = this.#db.prepare("SELECT generation, created_at, valid_until FROM key_generations WHERE valid_until IS NULL ORDER BY generation DESC LIMIT 1").get() as { generation: number; created_at: number; valid_until: null } | undefined;
		return row ? this.#generation(row) : undefined;
	}

	/** A generation that may still verify at `at`: the current one, or a retired one before its `validUntil`. */
	keyFor(generation: number, at: number): KeyGeneration | undefined {
		const row = this.#db.prepare("SELECT generation, created_at, valid_until FROM key_generations WHERE generation = ?").get(generation) as { generation: number; created_at: number; valid_until: number | null } | undefined;
		if (!row || (row.valid_until !== null && at >= row.valid_until)) return undefined;
		return this.#generation(row);
	}

	/** Ordinary rotation: a new current generation; the previous one verifies for one more retry window. Earlier retired
	 *  generations keep their own `validUntil`, so two rotations within one window invalidate nothing early. */
	rotateKey(retryWindowMs: number): KeyGeneration {
		if (!(retryWindowMs > 0)) throw new RangeError("retryWindowMs must be positive");
		const now = this.now();
		this.commitFloor(now);
		return this.#installGeneration(now + retryWindowMs);
	}

	/** Restore rotation: a new current generation, every earlier one retired at once. */
	rotateKeyRetiringAll(): KeyGeneration {
		const now = this.now();
		this.commitFloor(now);
		const g = this.#installGeneration(now);
		this.#tx(() => { this.#db.prepare("UPDATE key_generations SET valid_until = ? WHERE generation < ? AND (valid_until IS NULL OR valid_until > ?)").run(now, g.generation, now); this.#bump(); });
		return g;
	}

	#installGeneration(previousValidUntil: number | null): KeyGeneration {
		const now = this.#highWater || this.#clock();
		const generation = ((this.#db.prepare("SELECT MAX(generation) AS g FROM key_generations").get() as { g: number | null }).g ?? 0) + 1;
		const secret = randomBytes(32);
		// the key file first: a generation in the database without its key would refuse every start
		this.#keys.set(generation, secret);
		saveKeyFile(this.#keysPath, this.#keys);
		this.#shipFile(this.#keysPath);
		this.#tx(() => {
			if (previousValidUntil !== null) this.#db.prepare("UPDATE key_generations SET valid_until = ? WHERE valid_until IS NULL").run(previousValidUntil);
			this.#db.prepare("INSERT INTO key_generations (generation, created_at, valid_until) VALUES (?, ?, NULL)").run(generation, now);
			this.#bump();
		});
		return { generation, secret, createdAt: now, validUntil: null };
	}

	#generation(row: { generation: number; created_at: number; valid_until: number | null }): KeyGeneration {
		const secret = this.#keys.get(row.generation);
		if (!secret) throw new StateUnavailable(`no key material for generation ${row.generation}`);
		return { generation: row.generation, secret, createdAt: row.created_at, validUntil: row.valid_until };
	}

	// ---------------------------------------------------------------- content keys (section 3, *Contents*)

	/**
	 * The generation new blobs are sealed with: the newest one that a state backup already holds (the first one always),
	 * so that losing the state after a rotation never loses a key that sealed a blob.
	 */
	currentContentKey(): { generation: number; secret: Buffer } {
		const backed = this.backedUpSeq();
		const row = this.#db.prepare("SELECT generation FROM content_key_generations WHERE created_seq <= ? OR generation = (SELECT MIN(generation) FROM content_key_generations) ORDER BY generation DESC LIMIT 1").get(backed) as { generation: number };
		return { generation: row.generation, secret: this.#contentKeys.get(row.generation)! };
	}

	/** The newest content-key generation, backed up or not. */
	newestContentKey(): number { return Math.max(...this.#contentKeys.keys()); }

	/** Every generation stays readable: a content key is never retired, neither by rotation nor by a restore. */
	contentKeyFor(generation: number): Buffer | undefined { return this.#contentKeys.get(generation); }

	/** A new content-key generation for new blobs; blobs sealed earlier keep theirs. The key file is written first. */
	rotateContentKey(): number {
		const generation = Math.max(0, ...this.#contentKeys.keys()) + 1;
		this.#contentKeys.set(generation, randomBytes(32));
		saveKeyFile(this.#contentKeysPath, this.#contentKeys);
		this.#shipFile(this.#contentKeysPath);
		this.#tx(() => { const seq = this.#bump(); this.#db.prepare("INSERT INTO content_key_generations (generation, created_at, created_seq) VALUES (?, ?, ?)").run(generation, this.#highWater || this.#clock(), seq); });
		return generation;
	}

	// ---------------------------------------------------------------- sessions (section 2)

	/** Creates a session and returns its opaque handle. Only the handle's hash is stored. */
	createSession(s: { tenantId: string; actorKind: SessionKind; actorId: string }): { handle: string; expiresAt: number } {
		const now = this.now();
		const handle = randomBytes(32).toString("base64url");
		const expiresAt = now + this.#absoluteMs;
		this.#tx(() => this.#db.prepare("INSERT INTO sessions (handle_hash, tenant_id, actor_kind, actor_id, epoch, created_at, idle_until, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.run(hashHandle(handle), s.tenantId, s.actorKind, s.actorId, this.epoch(), now, Math.min(now + this.#idleMs, expiresAt), expiresAt));
		return { handle, expiresAt };
	}

	/** The session of a handle, or null when it is unknown, expired, idle too long or of an older epoch. A hit extends the
	 *  idle deadline (written at most once a minute, so that every request is not a durable write). */
	lookupSession(handle: string): SessionView | null {
		if (typeof handle !== "string" || handle.length === 0 || handle.length > 128) return null;
		const now = this.now();
		const row = this.#db.prepare("SELECT tenant_id, actor_kind, actor_id, epoch, idle_until, expires_at FROM sessions WHERE handle_hash = ?").get(hashHandle(handle)) as
			{ tenant_id: string; actor_kind: SessionKind; actor_id: string; epoch: number; idle_until: number; expires_at: number } | undefined;
		if (!row) return null;
		if (row.epoch !== this.epoch() || now >= row.expires_at || now >= row.idle_until) {
			this.#tx(() => this.#db.prepare("DELETE FROM sessions WHERE handle_hash = ?").run(hashHandle(handle)));
			return null;
		}
		const idleUntil = Math.min(now + this.#idleMs, row.expires_at);
		if (idleUntil - row.idle_until > 60_000) this.#tx(() => this.#db.prepare("UPDATE sessions SET idle_until = ? WHERE handle_hash = ?").run(idleUntil, hashHandle(handle)));
		return { tenantId: row.tenant_id, actorKind: row.actor_kind, actorId: row.actor_id, epoch: row.epoch, expiresAt: row.expires_at };
	}

	/** Logout. */
	endSession(handle: string): void {
		this.#tx(() => this.#db.prepare("DELETE FROM sessions WHERE handle_hash = ?").run(hashHandle(handle)));
	}

	/** Removes expired sessions; returns how many. */
	pruneSessions(): number {
		const now = this.now();
		let n = 0;
		this.#tx(() => { n = Number(this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ? OR idle_until <= ? OR epoch < ?").run(now, now, this.epoch()).changes); });
		return n;
	}

	// ---------------------------------------------------------------- login index (section 2: a lookup aid only)

	addLogin(issuer: string, subject: string, tenantId: string): void {
		this.#tx(() => this.#db.prepare("INSERT OR IGNORE INTO logins (issuer, subject, tenant_id) VALUES (?, ?, ?)").run(issuer, subject, tenantId));
	}

	/** The tenants an issuer/subject pair may be bound in; each candidate is checked again against its FsActor row. */
	tenantsFor(issuer: string, subject: string): string[] {
		return (this.#db.prepare("SELECT tenant_id FROM logins WHERE issuer = ? AND subject = ? ORDER BY tenant_id").all(issuer, subject) as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
	}

	/** Replaces the whole index (startup rebuild from the tenants' FsActor rows). */
	replaceLogins(entries: Iterable<{ issuer: string; subject: string; tenantId: string }>): void {
		this.#tx(() => {
			this.#db.exec("DELETE FROM logins");
			const put = this.#db.prepare("INSERT OR IGNORE INTO logins (issuer, subject, tenant_id) VALUES (?, ?, ?)");
			for (const e of entries) put.run(e.issuer, e.subject, e.tenantId);
		});
	}

	// ---------------------------------------------------------------- admission mode (section 6.1)

	/** The admission mode: normal, or maintenance (section 6.5). */
	mode(): "normal" | "maintenance" { return this.#text("admission_mode") === "maintenance" ? "maintenance" : "normal"; }
	/** A transition persisted before the gate closes; a restart with one pending completes it before serving. */
	pendingMode(): "normal" | "maintenance" | null { const v = this.#text("mode_intent"); return v === "normal" || v === "maintenance" ? v : null; }
	beginModeTransition(to: "normal" | "maintenance"): void { this.#tx(() => this.#setText("mode_intent", to)); }
	/** Persists the destination mode and clears the intent, in one transaction, before the transition is acknowledged. */
	completeModeTransition(): "normal" | "maintenance" {
		const to = this.pendingMode() ?? this.mode();
		this.#tx(() => { this.#setText("admission_mode", to); this.#db.prepare("DELETE FROM meta WHERE key = 'mode_intent'").run(); });
		return to;
	}

	// ---------------------------------------------------------------- restore (section 6.5)

	/** The restore under way: its journal step and what it recorded, or null. */
	restoreJournal(): { step: string; info: Record<string, unknown> } | null {
		const r = this.#db.prepare("SELECT step, info FROM restore_journal WHERE id = 1").get() as { step: string; info: string } | undefined;
		return r ? { step: r.step, info: JSON.parse(r.info) as Record<string, unknown> } : null;
	}
	/** Records a restore step durably before the next one starts; `info` is merged into what earlier steps recorded. */
	journalRestore(step: string, info: Record<string, unknown> = {}): void {
		const prev = this.restoreJournal()?.info ?? {};
		this.#tx(() => this.#db.prepare("INSERT INTO restore_journal (id, step, info) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET step = excluded.step, info = excluded.info").run(step, JSON.stringify({ ...prev, ...info })));
	}
	/** The epoch of the restore whose reconciliation is open, or null: until every tenant is reconciled in it, normal
	 *  admission stays closed and maintenance admits only each tenant's approved reconciler. */
	restoreEpoch(): number | null {
		const j = this.restoreJournal();
		return j && typeof j.info.epoch === "number" ? j.info.epoch : null;
	}
	endRestore(): void { this.#tx(() => this.#db.prepare("DELETE FROM restore_journal").run()); }

	/** The recovery roster: identities the host operator approved, per tenant, outside the restorable data. */
	rosterAdd(tenantId: string, issuer: string, subject: string): void {
		this.#tx(() => { this.#db.prepare("INSERT OR IGNORE INTO roster (tenant_id, issuer, subject, added_at) VALUES (?, ?, ?, ?)").run(tenantId, issuer, subject, this.#highWater || this.#clock()); this.#bump(); });
		this.operatorAudit("rosterAdd", { tenantId, issuer, subject });
	}
	rosterRemove(tenantId: string, issuer: string, subject: string): void {
		this.#tx(() => { this.#db.prepare("DELETE FROM roster WHERE tenant_id = ? AND issuer = ? AND subject = ?").run(tenantId, issuer, subject); this.#bump(); });
		this.operatorAudit("rosterRemove", { tenantId, issuer, subject });
	}
	roster(tenantId?: string): Array<{ tenantId: string; issuer: string; subject: string }> {
		return (this.#db.prepare("SELECT tenant_id, issuer, subject FROM roster WHERE ? IS NULL OR tenant_id = ? ORDER BY tenant_id, issuer, subject").all(tenantId ?? null, tenantId ?? null) as Array<{ tenant_id: string; issuer: string; subject: string }>)
			.map((r) => ({ tenantId: r.tenant_id, issuer: r.issuer, subject: r.subject }));
	}
	/** Approves one rostered identity as the reconciler of a tenant for the open restore's epoch. */
	approveReconciler(tenantId: string, issuer: string, subject: string): void {
		const epoch = this.restoreEpoch();
		if (epoch === null) throw new StateUnavailable("no restore is open");
		if (!this.roster(tenantId).some((r) => r.issuer === issuer && r.subject === subject)) throw new StateUnavailable(`${issuer} ${subject} is not on the recovery roster of ${tenantId}`);
		this.#tx(() => this.#db.prepare("INSERT INTO reconcilers (tenant_id, epoch, issuer, subject) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, epoch) DO UPDATE SET issuer = excluded.issuer, subject = excluded.subject").run(tenantId, epoch, issuer, subject));
		this.operatorAudit("approveReconciler", { tenantId, epoch, issuer, subject });
	}
	reconciler(tenantId: string): { issuer: string; subject: string } | null {
		const epoch = this.restoreEpoch();
		if (epoch === null) return null;
		const r = this.#db.prepare("SELECT issuer, subject FROM reconcilers WHERE tenant_id = ? AND epoch = ?").get(tenantId, epoch) as { issuer: string; subject: string } | undefined;
		return r ?? null;
	}
	/**
	 * The recoverer actor ID of a rostered identity for a tenant in the open restore (section 6.5, step 2): derived from
	 * the tenant, issuer, subject and restore epoch, so its operation IDs and receipts belong to this restore alone, and
	 * recorded so the external audit can name the identity behind it.
	 */
	recovererId(tenantId: string, issuer: string, subject: string): string {
		const epoch = this.restoreEpoch();
		if (epoch === null) throw new StateUnavailable("no restore is open");
		const id = "rcv-" + createHash("sha256").update(`phi-spaces-files recoverer\0${tenantId}\0${issuer}\0${subject}\0${epoch}`).digest("base64url").slice(0, 32);
		this.#tx(() => this.#db.prepare("INSERT OR IGNORE INTO recoverers (actor_id, tenant_id, issuer, subject, epoch) VALUES (?, ?, ?, ?, ?)").run(id, tenantId, issuer, subject, epoch));
		return id;
	}
	/** The identity behind a recoverer actor ID, or null. */
	recovererOf(actorId: string): { tenantId: string; issuer: string; subject: string; epoch: number } | null {
		const r = this.#db.prepare("SELECT tenant_id, issuer, subject, epoch FROM recoverers WHERE actor_id = ?").get(actorId) as { tenant_id: string; issuer: string; subject: string; epoch: number } | undefined;
		return r ? { tenantId: r.tenant_id, issuer: r.issuer, subject: r.subject, epoch: r.epoch } : null;
	}
	/** Whether an identity is on a tenant's recovery roster. */
	onRoster(tenantId: string, issuer: string, subject: string): boolean {
		return this.#db.prepare("SELECT 1 FROM roster WHERE tenant_id = ? AND issuer = ? AND subject = ?").get(tenantId, issuer, subject) !== undefined;
	}

	/** The tenants whose approved reconciler is this identity, in the open restore. */
	reconcilerTenants(issuer: string, subject: string): string[] {
		const epoch = this.restoreEpoch();
		if (epoch === null) return [];
		return (this.#db.prepare("SELECT tenant_id FROM reconcilers WHERE epoch = ? AND issuer = ? AND subject = ? ORDER BY tenant_id").all(epoch, issuer, subject) as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
	}
	/** The operator records a tenant reconciled in the open restore's epoch (after its reconciler reports completion). */
	markReconciled(tenantId: string): void {
		const epoch = this.restoreEpoch();
		if (epoch === null) throw new StateUnavailable("no restore is open");
		this.#tx(() => { this.#db.prepare("INSERT OR IGNORE INTO reconciled (tenant_id, epoch, at) VALUES (?, ?, ?)").run(tenantId, epoch, this.#highWater || this.#clock()); this.#bump(); });
		this.operatorAudit("markReconciled", { tenantId, epoch });
	}
	isReconciled(tenantId: string, epoch: number): boolean {
		return this.#db.prepare("SELECT 1 FROM reconciled WHERE tenant_id = ? AND epoch = ?").get(tenantId, epoch) !== undefined;
	}

	/** The external operator audit: what the host operator did, outside the restorable data. */
	operatorAudit(operation: string, detail: Record<string, unknown>): void {
		this.#tx(() => this.#db.prepare("INSERT INTO operator_audit (time, operation, detail) VALUES (?, ?, ?)").run(this.#highWater || this.#clock(), operation, JSON.stringify(detail)));
	}
	operatorAuditRows(limit = 100): Array<{ seq: number; time: number; operation: string; detail: Record<string, unknown> }> {
		return (this.#db.prepare("SELECT seq, time, operation, detail FROM operator_audit ORDER BY seq DESC LIMIT ?").all(limit) as Array<{ seq: number; time: number; operation: string; detail: string }>)
			.map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));
	}

	// ---------------------------------------------------------------- closed tenants (section 3, budgets)

	/** Closes a tenant durably with its pending security action: it stays closed across restarts until `reopenTenant`. */
	closeTenant(tenantId: string, reason: string, action: Record<string, unknown>): void {
		this.#tx(() => this.#db.prepare("INSERT INTO closed_tenants (tenant_id, reason, action, closed_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id) DO NOTHING")
			.run(tenantId, reason, JSON.stringify(action), this.#highWater || this.#clock()));
	}

	closedTenants(): Array<{ tenantId: string; reason: string; action: Record<string, unknown> }> {
		return (this.#db.prepare("SELECT tenant_id, reason, action FROM closed_tenants ORDER BY tenant_id").all() as Array<{ tenant_id: string; reason: string; action: string }>)
			.map((r) => ({ tenantId: r.tenant_id, reason: r.reason, action: JSON.parse(r.action) as Record<string, unknown> }));
	}

	/** The operator's repair is done: the tenant may be admitted again. */
	reopenTenant(tenantId: string): void {
		this.#tx(() => this.#db.prepare("DELETE FROM closed_tenants WHERE tenant_id = ?").run(tenantId));
	}

	// ---------------------------------------------------------------- plumbing

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
		this.#lock?.close();
	}

	#meta(key: string): number {
		const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row ? Number(row.value) : 0;
	}

	#text(key: string): string | null {
		const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row ? row.value : null;
	}

	#setText(key: string, value: string): void {
		this.#db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}

	#setMeta(key: string, value: number): void {
		this.#db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
	}

	#shipFile(path: string | null): void {
		if (path !== null) this.#pendingFiles.push({ name: path.slice(dirname(path).length + 1), bytes: readFileSync(path) });
	}

	#tx(f: () => void): void {
		if (this.#poisoned) throw new StateNotReplicated(`the standby did not confirm an earlier change: restart to seed it anew (${this.#poisoned.message})`);
		const session = this.#replica ? this.#db.createSession() : null;
		let unit = 0;
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			f();
			// every transaction has its number, so the standby sees a gap and takes a repeat once
			unit = this.#meta("replica_unit") + 1;
			this.#setMeta("replica_unit", unit);
			this.#db.exec("COMMIT");
		} catch (e) { this.#db.exec("ROLLBACK"); this.#announce = null; session?.close(); throw e; }
		if (session !== null) {
			const changeset = session.changeset();
			session.close();
			const files = this.#pendingFiles;
			this.#pendingFiles = [];
			try { this.#replica!.accept({ n: unit, changeset, files }); }
			catch (e) {
				// committed here, unconfirmed there: never answered as if it had succeeded (section 6.7)
				this.#poisoned = e as Error;
				this.#announce = null;
				this.#onPoisoned?.(e as Error);
				throw new StateNotReplicated(`the standby did not confirm a change of the state: ${(e as Error).message}`);
			}
		}
		const seq = this.#announce;
		this.#announce = null;
		if (seq !== null) this.#onSeq?.(this.stateId(), seq);
	}
}

/** Reads a key file (mode 600) and checks that it holds the material of every generation the table lists. */
function loadKeyFile(path: string | null, db: DatabaseSync, table: string): Map<number, Buffer> {
	let keys = new Map<number, Buffer>();
	if (path === null) return keys;
	if (existsSync(path)) {
		if ((statSync(path).mode & 0o077) !== 0) throw new StateUnavailable(`${path} is reachable by group or others; restrict it (chmod 600)`);
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
		keys = new Map(Object.entries(raw).map(([g, k]) => [Number(g), Buffer.from(k, "base64")]));
	}
	const live = db.prepare(`SELECT generation FROM ${table}`).all() as Array<{ generation: number }>;
	const missing = live.filter((r) => !keys.has(r.generation)).map((r) => r.generation);
	if (missing.length) throw new StateUnavailable(`${path} lacks the key material of generation ${missing.join(", ")}`);
	return keys;
}

/** Replaces a key file atomically (temporary file, fsync, rename, fsync of the directory). */
function saveKeyFile(path: string | null, keys: Map<number, Buffer>): void {
	if (path === null) return;
	const tmp = `${path}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try { writeSync(fd, JSON.stringify(Object.fromEntries([...keys].map(([g, k]) => [String(g), k.toString("base64")])))); fsyncSync(fd); }
	finally { closeSync(fd); }
	renameSync(tmp, path);
	const dfd = openSync(dirname(path), "r");
	try { fsyncSync(dfd); } finally { closeSync(dfd); }
}
