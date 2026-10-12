// Provisioned desktop/service keys. Loading never creates a replacement identity.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Algorithm, Signer } from "./auth.ts";

export function privateFile(path: string): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const s = fstatSync(fd), current = lstatSync(path);
		if (!s.isFile() || current.isSymbolicLink() || s.ino !== current.ino || s.dev !== current.dev || s.nlink !== 1 || (process.getuid && s.uid !== process.getuid()) || (s.mode & 0o077) !== 0) throw new Error("provisioned file must be a regular private file (0600)");
		return readFileSync(fd);
	} finally { closeSync(fd); }
}
export function provisionFileSigner(path: string, algorithm: Algorithm = "ed25519"): Signer & { publicKey: string } {
	if (!["ed25519", "ecdsa-p256"].includes(algorithm)) throw new Error("unsupported key algorithm");
	const pair = algorithm === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "P-256" });
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify({ algorithm, privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }) }) + "\n", { flag: "wx", mode: 0o600 });
	return loadFileSigner(path);
}
export function loadFileSigner(path: string): Signer & { publicKey: string } {
	const record = JSON.parse(privateFile(path).toString("utf8"));
	if (!["ed25519", "ecdsa-p256"].includes(record.algorithm) || typeof record.privateKey !== "string") throw new Error("invalid provisioned key");
	const key = createPrivateKey(record.privateKey), algorithm = record.algorithm as Algorithm;
	if (algorithm === "ed25519" ? key.asymmetricKeyType !== "ed25519" : key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("key algorithm mismatch");
	const der = createPublicKey(key).export({ format: "der", type: "spki" });
	const publicKey = Buffer.from(algorithm === "ed25519" ? der.subarray(12) : der).toString("base64");
	return { algorithm, publicKey, keyId: createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 32), sign: data => sign(algorithm === "ed25519" ? null : "sha256", Buffer.from(data), key) };
}
