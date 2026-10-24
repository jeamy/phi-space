// Accounts, guests and web logins (docs/architektur.md, "Konten und Login", "Gastzugang"). Used only by the web process.
//
// The account and its character live in the world space; the credential (salted scrypt hash) and the web sessions in
// the accounts space, which nothing else reaches. A registration therefore spans two spaces and runs in three
// idempotent steps: claim the name as a pending credential (under the names lock, so two registrations of one name
// cannot both succeed), turn the account into a registered one in the world (or create it), then activate the
// credential. A run that stops after step 1 leaves a pending credential whose lease frees the name again; one that
// stops after step 2 is completed by the next login.
import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { walkable, type WorldDef } from "./engine/world.ts";
import { asFields, fieldsOf, NAMES_LOCK, type AccountFields, type CharacterFields, type CredentialFields, type WebSessionFields } from "./model.ts";
import { envMs, readExisting, StillHeld } from "./space.ts";

const scrypt = (password: string, salt: Buffer): Promise<Buffer> =>
	new Promise((ok, fail) => scryptCb(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, key) => (e ? fail(e) : ok(key))));

/** A refusal the web process answers with `status`. */
export class AuthError extends Error {
	readonly status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}

export type AccountOptions = {
	/** Lease of a guest account, renewed on activity (SPACES_MMO_GUEST_TTL_MS, default 7 days). */
	guestTtlMs?: number;
	/** Lease of a pending credential: how long a broken registration keeps its name (SPACES_MMO_PENDING_MS, 2 min). */
	pendingMs?: number;
	/** Lease of a web session, renewed on use (SPACES_MMO_WEB_SESSION_MS, 12 h). */
	webSessionMs?: number;
	/** The one-time token that makes the first registered account an admin (SPACES_MMO_SETUP_TOKEN). */
	setupToken?: string;
};

export type Me = { accountId: string; name: string; guest: boolean; admin: boolean; charId: string };

const NAME = /^[\p{L}\p{N}_-]{3,20}$/u;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const id = (prefix: string) => `${prefix}-${randomBytes(8).toString("hex")}`;

export class Accounts {
	readonly guestTtlMs: number;
	readonly pendingMs: number;
	readonly webSessionMs: number;
	readonly #setupToken: string | undefined;
	/** Test hook: runs between step 1 and step 2 of a registration (a throw stands for a web process that died there). */
	faults: { afterPendingCredential?: () => Promise<void> | void } = {};

	private readonly world: SpaceLike;
	private readonly store: SpaceLike;
	private readonly w: WorldDef;

	constructor(world: SpaceLike, store: SpaceLike, w: WorldDef, o: AccountOptions = {}) {
		this.world = world; this.store = store; this.w = w;
		this.guestTtlMs = o.guestTtlMs ?? envMs("SPACES_MMO_GUEST_TTL_MS", 7 * 24 * 3600_000);
		this.pendingMs = o.pendingMs ?? envMs("SPACES_MMO_PENDING_MS", 120_000);
		this.webSessionMs = o.webSessionMs ?? envMs("SPACES_MMO_WEB_SESSION_MS", 12 * 3600_000);
		this.#setupToken = o.setupToken ?? (process.env.SPACES_MMO_SETUP_TOKEN || undefined);
	}

	/** A new guest: an account with a lease and a character at the start of the world. */
	async createGuest(): Promise<Me> {
		const now = Date.now();
		const account: AccountFields = { accountId: id("a"), name: `${this.w.guestName}-${randomInt(1000, 10000)}`, guest: true, admin: false, createdAt: now, touchedAt: now };
		const char = this.#newCharacter(account);
		const txn = (await this.world.createTransaction(10_000)).id;
		try {
			await this.world.write({ type: "Account", fields: asFields(account) }, txn, this.guestTtlMs);
			await this.world.write({ type: "Character", fields: asFields(char) }, txn, FOREVER);
			await this.world.commit(txn);
		} catch (e) { await this.world.abort(txn).catch(() => {}); throw e; }
		return { ...pick(account), charId: char.charId };
	}

	/** Registers `name`. With `guestAccountId` the guest's own account becomes the registered one (same account id,
	 *  character and progress); without, a new account and character are created. */
	async register(name: string, password: string, o: { guestAccountId?: string; setupToken?: string } = {}): Promise<Me> {
		name = String(name ?? "").trim();
		if (!NAME.test(name)) throw new AuthError(400, "Name: 3 bis 20 Buchstaben, Ziffern, _ oder -");
		if (name.toLowerCase().startsWith(`${this.w.guestName.toLowerCase()}-`)) throw new AuthError(400, `Namen wie „${this.w.guestName}-…“ sind Gästen vorbehalten`);
		if (typeof password !== "string" || password.length < 8 || password.length > 200) throw new AuthError(400, "Passwort: 8 bis 200 Zeichen");
		const key = name.toLowerCase();
		const guest = o.guestAccountId ? await this.#account(o.guestAccountId) : null;
		if (o.guestAccountId && !guest?.guest) throw new AuthError(409, "Dieses Gastkonto gibt es nicht mehr; bitte neu als Gast beginnen oder ohne Gast registrieren");
		const accountId = guest?.accountId ?? id("a");
		const admin = !!o.setupToken && this.#tokenOk(o.setupToken) && !(await this.world.readIfExists({ type: "Account", fields: { admin: true } }, NO_WAIT));
		const salt = randomBytes(16);
		const hash = await scrypt(password, salt);

		// step 1: claim the name (the names lock makes the check and the claim one step for all web processes)
		const cred: CredentialFields = { key, name, accountId, salt: salt.toString("hex"), hash: hash.toString("hex"), state: "pending" };
		const t1 = (await this.store.createTransaction(15_000)).id;
		try {
			const lock = await this.store.take(NAMES_LOCK, 10_000, { txn: t1 });
			if (!lock) throw new AuthError(503, "Die Namensvergabe ist gerade belegt; bitte gleich noch einmal");
			// waits for a credential another transaction holds (an activation in step 3): held is not free
			const taken = await readExisting(this.store, { type: "Credential", fields: { key } }, { txn: t1 }).catch((e) => { throw e instanceof StillHeld ? new AuthError(503, "Die Namensvergabe ist gerade belegt; bitte gleich noch einmal") : e; });
			if (taken) {
				const c = fieldsOf<CredentialFields>(taken);
				// a pending claim of this very account (its earlier attempt broke off) is taken over; anything else is taken
				if (c.state !== "pending" || c.accountId !== accountId) throw new AuthError(409, "Dieser Name ist schon vergeben");
				await this.store.take({ type: "Credential", id: taken.id }, NO_WAIT, { txn: t1 });
			}
			await this.store.write({ type: "Credential", fields: asFields(cred) }, t1, this.pendingMs);
			await this.store.write({ type: NAMES_LOCK.type, fields: { ...NAMES_LOCK.fields } }, t1, FOREVER);
			await this.store.commit(t1);
		} catch (e) { await this.store.abort(t1).catch(() => {}); throw e; }
		await this.faults.afterPendingCredential?.();

		// step 2: the account in the world becomes (or is created as) a registered one
		const t2 = (await this.world.createTransaction(15_000)).id;
		let charId: string;
		try {
			if (guest) {
				const a = await this.world.take({ type: "Account", fields: { accountId, guest: true } }, 5_000, { txn: t2 });
				if (!a) throw new AuthError(409, "Dieses Gastkonto gibt es nicht mehr");
				await this.world.write({ type: "Account", fields: asFields<AccountFields>({ ...fieldsOf<AccountFields>(a), name, guest: false, admin, touchedAt: Date.now() }) }, t2, FOREVER);
				const c = await this.world.take({ type: "Character", fields: { accountId } }, 5_000, { txn: t2 });
				if (!c) throw new AuthError(409, "Zu diesem Gastkonto gibt es keine Figur mehr");
				const char = { ...fieldsOf<CharacterFields>(c), name, guest: false };
				await this.world.write({ type: "Character", fields: asFields(char) }, t2, FOREVER);
				charId = char.charId;
			} else {
				const now = Date.now();
				const account: AccountFields = { accountId, name, guest: false, admin, createdAt: now, touchedAt: now };
				const char = this.#newCharacter(account);
				await this.world.write({ type: "Account", fields: asFields(account) }, t2, FOREVER);
				await this.world.write({ type: "Character", fields: asFields(char) }, t2, FOREVER);
				charId = char.charId;
			}
			await this.world.commit(t2);
		} catch (e) { await this.world.abort(t2).catch(() => {}); throw e; }

		// step 3: the credential becomes permanent
		await this.#activate(key, accountId);
		return { accountId, name, guest: false, admin, charId };
	}

	/** The account a name and password belong to. A credential left pending by a registration that got as far as the
	 *  world is completed here. */
	async login(name: string, password: string): Promise<Me> {
		const key = String(name ?? "").trim().toLowerCase();
		const e = NAME.test(key) && typeof password === "string" && password.length <= 200 ? await readExisting(this.store, { type: "Credential", fields: { key } }) : null;
		if (!e) { await scrypt(String(password ?? ""), randomBytes(16)); throw new AuthError(403, "Name oder Passwort stimmt nicht"); }
		const c = fieldsOf<CredentialFields>(e);
		const got = await scrypt(password, Buffer.from(c.salt, "hex"));
		if (!timingSafeEqual(got, Buffer.from(c.hash, "hex"))) throw new AuthError(403, "Name oder Passwort stimmt nicht");
		const account = await this.#account(c.accountId);
		if (c.state === "pending") {
			if (!account || account.guest) throw new AuthError(403, "Diese Registrierung ist nicht abgeschlossen; bitte noch einmal registrieren");
			await this.#activate(key, c.accountId);
		}
		if (!account) throw new AuthError(403, "Zu diesem Namen gibt es kein Konto mehr");
		return this.#me(account);
	}

	/** A web session for an account: the cookie value (only its hash is stored). */
	async openSession(accountId: string): Promise<string> {
		const sid = randomBytes(24).toString("hex");
		await this.store.write({ type: "WebSession", fields: asFields<WebSessionFields>({ key: sha256(sid), accountId, at: Date.now() }) }, null, this.webSessionMs);
		return sid;
	}

	/** Who a session cookie belongs to, or null (unknown, expired, or its guest account lapsed). A session older than
	 *  a twelfth of its lifetime is renewed. */
	async resolve(sid: string | undefined): Promise<Me | null> {
		if (!sid || !/^[0-9a-f]{48}$/.test(sid)) return null;
		const e = await this.store.readIfExists({ type: "WebSession", fields: { key: sha256(sid) } }, NO_WAIT);
		if (!e) return null;
		const s = fieldsOf<WebSessionFields>(e);
		const account = await this.#account(s.accountId);
		if (!account) return null;
		if (Date.now() - s.at > this.webSessionMs / 12) {
			const t = await this.store.takeIfExists({ type: "WebSession", id: e.id }, NO_WAIT);
			if (t) await this.store.write({ type: "WebSession", fields: asFields<WebSessionFields>({ ...s, at: Date.now() }) }, null, this.webSessionMs);
		}
		return this.#me(account);
	}

	async closeSession(sid: string | undefined): Promise<void> {
		if (!sid || !/^[0-9a-f]{48}$/.test(sid)) return;
		while (await this.store.takeIfExists({ type: "WebSession", fields: { key: sha256(sid) } }, NO_WAIT));
	}

	/** Renews a guest account's lease, at most every quarter of the lifetime (activity keeps a guest alive). */
	async touchGuest(accountId: string): Promise<void> {
		const e = await this.world.readIfExists({ type: "Account", fields: { accountId, guest: true } }, NO_WAIT);
		if (!e || Date.now() - fieldsOf<AccountFields>(e).touchedAt < this.guestTtlMs / 4) return;
		const txn = (await this.world.createTransaction(10_000)).id;
		try {
			const a = await this.world.takeIfExists({ type: "Account", id: e.id }, NO_WAIT, { txn });
			if (a) await this.world.write({ type: "Account", fields: asFields<AccountFields>({ ...fieldsOf<AccountFields>(a), touchedAt: Date.now() }) }, txn, this.guestTtlMs);
			await this.world.commit(txn);
		} catch { await this.world.abort(txn).catch(() => {}); }
	}

	async #activate(key: string, accountId: string): Promise<void> {
		const txn = (await this.store.createTransaction(10_000)).id;
		try {
			const p = await this.store.take({ type: "Credential", fields: { key, accountId, state: "pending" } }, 5_000, { txn });
			if (p) await this.store.write({ type: "Credential", fields: asFields<CredentialFields>({ ...fieldsOf<CredentialFields>(p), state: "active" }) }, txn, FOREVER);
			await this.store.commit(txn);
		} catch (e) { await this.store.abort(txn).catch(() => {}); throw e; }
	}

	async #account(accountId: string): Promise<AccountFields | null> {
		const e: Taken | null = await readExisting(this.world, { type: "Account", fields: { accountId } });
		return e ? fieldsOf<AccountFields>(e) : null;
	}

	async #me(account: AccountFields): Promise<Me> {
		const c = await readExisting(this.world, { type: "Character", fields: { accountId: account.accountId } });
		if (!c) throw new AuthError(409, "Zu diesem Konto gibt es keine Figur");
		return { ...pick(account), charId: fieldsOf<CharacterFields>(c).charId };
	}

	#newCharacter(account: AccountFields): CharacterFields {
		const room = this.w.rooms.find((r) => r.roomId === this.w.start)!;
		let at = room.spawn;
		for (let i = 0; i < 20; i++) {
			const x = room.spawn.x + randomInt(-3, 4), y = room.spawn.y + randomInt(-2, 3);
			if (walkable(this.w, room.ground, x, y)) { at = { x, y }; break; }
		}
		return { charId: id("c"), accountId: account.accountId, name: account.name, room: room.roomId, x: at.x, y: at.y, skin: randomInt(0, this.w.skins.length), guest: account.guest };
	}

	#tokenOk(got: string): boolean {
		if (!this.#setupToken) return false;
		return timingSafeEqual(createHash("sha256").update(this.#setupToken).digest(), createHash("sha256").update(got).digest());
	}
}

const pick = (a: AccountFields) => ({ accountId: a.accountId, name: a.name, guest: a.guest, admin: a.admin });
