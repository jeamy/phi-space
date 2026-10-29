// End-to-end encryption of the chat between players (docs/siedeln.md, "Chat zwischen Spielern"): only the people of a
// talk can read it, not the server and not its operator. WebCrypto only (browsers, Node 22), no dependency.
//
// - Every account has one ECDH key pair (P-256), made in the browser. The private key leaves it only sealed with the
//   player's chat password (PBKDF2-SHA-256, ITER rounds, then AES-GCM): the server keeps that backup and the public key,
//   so another device unlocks the same key with the same password. A forgotten chat password cannot be recovered; a new
//   key reads nothing written for the old one.
// - A message is sealed once per reader (the server keeps a copy per reader anyway): AES-GCM with a key derived (HKDF)
//   from ECDH between the sender's private and the reader's public key. The reader derives the same key from its private
//   and the sender's public key, which travels with the box. The additional data binds the copy to its message, sender,
//   reader and group, so the server cannot move a copy into another talk.
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;
/** PBKDF2 rounds for a new backup (OWASP's figure for SHA-256). */
export const ITER = 600_000;
export const MIN_PASSWORD = 8;

/** The private key as the server keeps it: sealed with the chat password. */
export type KeyBackup = { pub: string; wrapped: string; salt: string; iter: number };
/** A sealed message: `pub` the sender's public key. */
export type Box = { iv: string; ct: string; pub: string };

export const b64 = (b: ArrayBuffer | Uint8Array) => { let s = ""; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s); };
export const unb64 = (s: string): Uint8Array<ArrayBuffer> => { const t = atob(s), u = new Uint8Array(new ArrayBuffer(t.length)); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
const random = (n: number): Uint8Array<ArrayBuffer> => globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));

async function passwordKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
	const base = await subtle.importKey("raw", enc.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
	return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(pkcs8: ArrayBuffer, pub: string, password: string): Promise<KeyBackup> {
	const salt = random(16), iv = random(12);
	const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`mmo-chat-key|${pub}`) }, await passwordKey(password, salt, ITER), pkcs8);
	return { pub, wrapped: `${b64(iv)}.${b64(ct)}`, salt: b64(salt), iter: ITER };
}
/** The private key's bytes from a backup; throws on a wrong password. */
async function unseal(k: KeyBackup, password: string): Promise<ArrayBuffer> {
	const [iv = "", ct = ""] = k.wrapped.split(".");
	try { return await subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(`mmo-chat-key|${k.pub}`) }, await passwordKey(password, unb64(k.salt), k.iter), unb64(ct)); }
	catch { throw new Error("Das Chat-Passwort stimmt nicht."); }
}
const importPrivate = (pkcs8: ArrayBuffer) => subtle.importKey("pkcs8", pkcs8, CURVE, false, ["deriveBits"]);

/** A new key pair: the private key for this device (not extractable) and the backup for the server. */
export async function newKey(password: string): Promise<{ priv: CryptoKey; backup: KeyBackup }> {
	if (password.length < MIN_PASSWORD) throw new Error(`Das Chat-Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
	const kp = await subtle.generateKey(CURVE, true, ["deriveBits"]);
	const pub = b64(await subtle.exportKey("raw", kp.publicKey)), pkcs8 = await subtle.exportKey("pkcs8", kp.privateKey);
	return { priv: await importPrivate(pkcs8), backup: await seal(pkcs8, pub, password) };
}
/** The private key from the server's backup, with the chat password. */
export async function unlock(k: KeyBackup, password: string): Promise<CryptoKey> { return importPrivate(await unseal(k, password)); }
/** The same key under a new chat password. */
export async function rewrap(k: KeyBackup, oldPassword: string, newPassword: string): Promise<KeyBackup> {
	if (newPassword.length < MIN_PASSWORD) throw new Error(`Das Chat-Passwort braucht mindestens ${MIN_PASSWORD} Zeichen.`);
	return seal(await unseal(k, oldPassword), k.pub, newPassword);
}

async function pairKey(priv: CryptoKey, pub: string): Promise<CryptoKey> {
	const other = await subtle.importKey("raw", unb64(pub), CURVE, false, []);
	const bits = await subtle.deriveBits({ name: "ECDH", public: other }, priv, 256);
	const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
	return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("mmo-chat-v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/** What a copy is bound to: the message, its sender, its reader and its group ("" between two). */
export const aad = (msgId: string, fromId: string, to: string, groupId: string) => `${msgId}|${fromId}|${to}|${groupId}`;

/** `text` sealed for the reader with public key `readerPub`. */
export async function sealFor(priv: CryptoKey, myPub: string, readerPub: string, text: string, ad: string): Promise<Box> {
	const iv = random(12);
	const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(ad) }, await pairKey(priv, readerPub), enc.encode(text));
	return { iv: b64(iv), ct: b64(ct), pub: myPub };
}
/** The text of a box sealed for this key; throws when it was not (another key, a changed copy). */
export async function openBox(priv: CryptoKey, box: Box, ad: string): Promise<string> {
	return dec.decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: enc.encode(ad) }, await pairKey(priv, box.pub), unb64(box.ct)));
}

/** A public key's fingerprint, to compare outside the game: 8 groups of 4 hex digits of its SHA-256. */
export async function fingerprint(pub: string): Promise<string> {
	const h = new Uint8Array(await subtle.digest("SHA-256", unb64(pub)));
	return [...h.slice(0, 16)].map((x) => x.toString(16).padStart(2, "0")).join("").match(/.{4}/g)!.join(" ");
}
