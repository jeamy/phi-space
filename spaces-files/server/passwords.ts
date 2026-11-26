// Password sign-in (docs/zanzibar-agent-filesystem-plan.en.md, section 2): the alternative to an OpenID provider for a
// deployment without one. A username is the subject of the issuer `local`, so it binds to actors, the login index and
// the recovery roster exactly as an OIDC identity does. The deployment state keeps one scrypt hash per username, set by
// the host operator (`operator set-password`); the password itself is never stored, logged or sent to the service: the
// operator's command line hashes it. Failed attempts are bounded per username and in all.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const LOCAL_ISSUER = "local";
/** 1 to 64 of a-z 0-9 . _ -, starting with a letter or digit. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const PARAMS = { N: 1 << 15, r: 8, p: 1 };
const KEYLEN = 32;

const scrypt = (pw: string, salt: Buffer, o: ScryptOptions) => new Promise<Buffer>((resolve, reject) =>
	scryptCb(pw.normalize("NFC"), salt, KEYLEN, { ...o, maxmem: 128 * o.N! * o.r! * 2 }, (e, k) => e ? reject(e) : resolve(k)));

export class PasswordRefused extends Error {
	readonly code = "invalidInput";
	constructor(message: string) { super(message); this.name = "PasswordRefused"; }
}

export function checkUsername(u: string): string {
	if (!USERNAME.test(u)) throw new PasswordRefused("a username is 1 to 64 of a-z 0-9 . _ -, starting with a letter or digit");
	return u;
}

/** `scrypt$N$r$p$salt$hash`, salt and hash base64url. */
export async function hashPassword(pw: string): Promise<string> {
	if (pw.length < MIN_PASSWORD) throw new PasswordRefused(`a password has at least ${MIN_PASSWORD} characters`);
	if (pw.length > MAX_PASSWORD) throw new PasswordRefused("the password is too long");
	const salt = randomBytes(16);
	const k = await scrypt(pw, salt, PARAMS);
	return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64url")}$${k.toString("base64url")}`;
}

export function validHash(h: unknown): h is string {
	return typeof h === "string" && /^scrypt\$\d{1,8}\$\d{1,2}\$\d{1,2}\$[A-Za-z0-9_-]{16,64}\$[A-Za-z0-9_-]{40,64}$/.test(h);
}

// a hash nobody's password matches, so an unknown username costs the same as a wrong password
let dummy: Promise<string> | null = null;

/** Whether `pw` matches `stored`; with no stored hash, the same work against a dummy, and false. */
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
	if (pw.length > MAX_PASSWORD) return false;
	const h = stored ?? await (dummy ??= hashPassword(randomBytes(24).toString("base64url")));
	const [kind, n, r, p, salt, key] = h.split("$");
	if (kind !== "scrypt") return false;
	const want = Buffer.from(key, "base64url");
	const got = await scrypt(pw, Buffer.from(salt, "base64url"), { N: Number(n), r: Number(r), p: Number(p) });
	return stored !== null && got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The bounds on failed attempts: per username `perUser` failures in `windowMs` lock it for the rest of the window, and
 * `total` failures in a window close password sign-in for everyone until it ends. A success clears the username's count.
 */
export class Attempts {
	#users = new Map<string, { n: number; since: number }>();
	#total = { n: 0, since: 0 };
	readonly #o: { perUser: number; total: number; windowMs: number; now: () => number };
	constructor(o: Partial<{ perUser: number; total: number; windowMs: number; now: () => number }> = {}) {
		this.#o = { perUser: o.perUser ?? 5, total: o.total ?? 200, windowMs: o.windowMs ?? 15 * 60_000, now: o.now ?? Date.now };
	}
	#fresh(e: { n: number; since: number }) { const t = this.#o.now(); if (t - e.since >= this.#o.windowMs) { e.n = 0; e.since = t; } return e; }
	/** Whether an attempt for this username may be checked at all. */
	allowed(user: string): boolean {
		if (this.#fresh(this.#total).n >= this.#o.total) return false;
		const e = this.#users.get(user);
		return !e || this.#fresh(e).n < this.#o.perUser;
	}
	failed(user: string): void {
		this.#fresh(this.#total).n++;
		if (this.#users.size > 10_000) this.#users.clear();
		const e = this.#users.get(user) ?? { n: 0, since: this.#o.now() };
		this.#fresh(e).n++;
		this.#users.set(user, e);
	}
	succeeded(user: string): void { this.#users.delete(user); }
}
