// What an administrator types into a provider's login (a key, a pasted code) crosses the space sealed to the model
// process that asked for it (docs/forum-seite-plan-2026-11-26.en.md, section 8): the model process makes an X25519
// key pair for one login and puts the public half into each prompt; the web process seals the answer to it with a key
// pair of its own for this answer alone (X25519, HKDF-SHA256, AES-256-GCM, all node:crypto). The additional data names
// the login, the prompt and the model process, so an answer cannot be replayed to another prompt. The private key
// never leaves the model process's memory. No pi-ai here: the web process loads this.
import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";

export type Sealed = { epk: string; iv: string; ct: string; tag: string };
const INFO = Buffer.from("phi-forum provider answer v1");

const rawPublic = (k: KeyObject): Buffer => Buffer.from(k.export({ format: "jwk" }).x!, "base64url");
const publicFromRaw = (raw: string): KeyObject => {
	const x = Buffer.from(raw, "base64url");
	if (x.length !== 32) throw new Error("not an X25519 public key");
	return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: x.toString("base64url") }, format: "jwk" });
};
const keyOf = (shared: Buffer, epk: Buffer, pk: Buffer) => Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, pk]), INFO, 32));

/** A key pair for one login: the public half as base64url (it goes into the prompts), the private half stays here. */
export function loginKeys(): { publicKey: string; privateKey: KeyObject } {
	const { publicKey, privateKey } = generateKeyPairSync("x25519");
	return { publicKey: rawPublic(publicKey).toString("base64url"), privateKey };
}

/** Seals `text` to the public key `to` (base64url), bound to `aad`. */
export function seal(to: string, text: string, aad: string): Sealed {
	const pk = publicFromRaw(to);
	const eph = generateKeyPairSync("x25519");
	const epk = rawPublic(eph.publicKey);
	const key = keyOf(diffieHellman({ privateKey: eph.privateKey, publicKey: pk }), epk, rawPublic(pk));
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	c.setAAD(Buffer.from(aad));
	const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
	return { epk: epk.toString("base64url"), iv: iv.toString("base64url"), ct: ct.toString("base64url"), tag: c.getAuthTag().toString("base64url") };
}

/** Opens what `seal` made for this private key and the same `aad`; throws when anything differs. */
export function open(privateKey: KeyObject, s: Sealed, aad: string): string {
	const epk = Buffer.from(s.epk, "base64url");
	const pk = rawPublic(createPublicKey(privateKey));
	const key = keyOf(diffieHellman({ privateKey, publicKey: publicFromRaw(s.epk) }), epk, pk);
	const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64url"));
	d.setAAD(Buffer.from(aad));
	d.setAuthTag(Buffer.from(s.tag, "base64url"));
	return Buffer.concat([d.update(Buffer.from(s.ct, "base64url")), d.final()]).toString("utf8");
}

/** The additional data of one answer. */
export const answerAad = (loginId: string, promptId: string, procId: string) => `${loginId}\n${promptId}\n${procId}`;
