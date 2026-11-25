// The blob store (docs/zanzibar-agent-filesystem-plan.en.md, section 3, *Contents*): file contents live outside the
// Space, one sealed blob per file version, in a directory of its own beside the data directory. A blob is never
// rewritten: a save writes a new one under a fresh random ID before its content row commits, and the old one is
// deleted only after a later commit has stopped naming it, so a committed row always finds its blob.
//
// Each blob is sealed with AES-256-GCM under a key derived by HKDF-SHA-256 from the content key of its generation and
// the blob ID, with a fresh 96-bit nonce. The associated data binds tenant, node, version, blob ID and generation, so a
// blob copied to another file, version or tenant fails authentication. A missing, truncated or foreign blob is
// `inconsistentState` for that tenant. The content keys live in the deployment state (section 6.6), never here.
//
// File format: "PSB1" (4 bytes) | nonce (12) | ciphertext | GCM tag (16).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "phi-spaces";
import { prepareDataDir } from "./dirs.ts";
import { InconsistentState } from "./schema.ts";

const MAGIC = Buffer.from("PSB1", "latin1");
const NONCE = 12, TAG = 16, HEADER = MAGIC.length + NONCE;
const INFO = Buffer.from("phi-spaces-files blob v1", "utf8");
/** A blob ID: 22 base64url characters (128 random bits). Never a content hash: equal files must not look equal. */
const BLOB_ID = /^[A-Za-z0-9_-]{22}$/;
const TMP = ".tmp";

/** What a content row records about its blob. */
export type BlobRef = { blobId: string; size: number; keyGeneration: number };
/** The content keys the blob store seals and opens with (held by the deployment state). */
export interface ContentKeys {
	currentContentKey(): { generation: number; secret: Buffer };
	/** The key of a generation, or undefined when the deployment state has none for it. */
	contentKeyFor(generation: number): Buffer | undefined;
}
/** The file a blob belongs to: part of its associated data. */
export type BlobOwner = { tenantId: string; nodeId: string; version: number };

export const newBlobId = (): string => randomBytes(16).toString("base64url");

const aad = (o: BlobOwner, blobId: string, generation: number): Buffer =>
	Buffer.from(canonicalJson({ t: o.tenantId, n: o.nodeId, v: o.version, b: blobId, g: generation }), "utf8");
const blobKey = (secret: Buffer, blobId: string): Buffer => Buffer.from(hkdfSync("sha256", secret, Buffer.from(blobId, "utf8"), INFO, 32));

export function seal(secret: Buffer, generation: number, o: BlobOwner, blobId: string, bytes: Uint8Array): Buffer {
	const nonce = randomBytes(NONCE);
	const c = createCipheriv("aes-256-gcm", blobKey(secret, blobId), nonce);
	c.setAAD(aad(o, blobId, generation));
	const body = Buffer.concat([c.update(bytes), c.final()]);
	return Buffer.concat([MAGIC, nonce, body, c.getAuthTag()]);
}

/** Opens a sealed blob; anything that does not authenticate as this owner's blob of this size is `inconsistentState`. */
export function unseal(secret: Buffer, o: BlobOwner, ref: BlobRef, sealed: Buffer): Buffer {
	const bad = (why: string) => new InconsistentState(`tenant ${o.tenantId}: blob ${ref.blobId} of node ${o.nodeId} version ${o.version} ${why}`);
	if (sealed.length !== HEADER + ref.size + TAG || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw bad("has the wrong length or format");
	const d = createDecipheriv("aes-256-gcm", blobKey(secret, ref.blobId), sealed.subarray(MAGIC.length, HEADER));
	d.setAAD(aad(o, ref.blobId, ref.keyGeneration));
	d.setAuthTag(sealed.subarray(sealed.length - TAG));
	try { return Buffer.concat([d.update(sealed.subarray(HEADER, sealed.length - TAG)), d.final()]); }
	catch { throw bad("does not authenticate"); }
}

/** Where sealed blobs are kept: a directory (fsynced files, atomic renames) or memory (tests). */
interface Medium {
	write(tenantId: string, blobId: string, sealed: Buffer): Promise<void>;
	read(tenantId: string, blobId: string): Promise<Buffer | null>;
	has(tenantId: string, blobId: string): Promise<boolean>;
	remove(tenantId: string, blobId: string): Promise<void>;
	/** Every file in the tenant's blob area as `shard/name`, finished blobs and leftover temporary files alike. */
	names(tenantId: string): Promise<string[]>;
	/** Removes one file `names` listed. */
	removeName(tenantId: string, path: string): Promise<void>;
}

class MemoryMedium implements Medium {
	readonly files = new Map<string, Map<string, Buffer>>();
	#t(tenantId: string) { let m = this.files.get(tenantId); if (!m) this.files.set(tenantId, m = new Map()); return m; }
	async write(t: string, id: string, b: Buffer) { this.#t(t).set(id, Buffer.from(b)); }
	async read(t: string, id: string) { const b = this.files.get(t)?.get(id); return b ? Buffer.from(b) : null; }
	async has(t: string, id: string) { return this.files.get(t)?.has(id) ?? false; }
	async remove(t: string, id: string) { this.files.get(t)?.delete(id); }
	async names(t: string) { return [...(this.files.get(t)?.keys() ?? [])].map((n) => `${n.slice(0, 2)}/${n}`); }
	async removeName(t: string, p: string) { this.files.get(t)?.delete(p.slice(p.indexOf("/") + 1)); }
}

const fsyncDir = (dir: string) => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };

class DirMedium implements Medium {
	readonly root: string;
	constructor(root: string) { this.root = root; }
	#dir(t: string, id: string) { return join(this.root, t, id.slice(0, 2)); }
	async #ensure(t: string, id: string): Promise<string> {
		const tenantDir = join(this.root, t), dir = this.#dir(t, id);
		try { await stat(dir); return dir; } catch { /* create below */ }
		let fresh = false;
		try { await stat(tenantDir); } catch { await mkdir(tenantDir, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; }); fresh = true; }
		await mkdir(dir, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
		// the new directory entries must be durable before a row names a blob inside them
		fsyncDir(tenantDir);
		if (fresh) fsyncDir(this.root);
		return dir;
	}
	async write(t: string, id: string, sealed: Buffer) {
		const dir = await this.#ensure(t, id);
		const tmp = join(dir, id + TMP), final = join(dir, id);
		const fh = await open(tmp, "wx", 0o600);
		try { await fh.writeFile(sealed); await fh.sync(); }
		finally { await fh.close(); }
		await rename(tmp, final);
		fsyncDir(dir);
	}
	async read(t: string, id: string) {
		try { return await readFile(join(this.#dir(t, id), id)); }
		catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
	}
	async remove(t: string, id: string) { await this.removeName(t, `${id.slice(0, 2)}/${id}`); }
	async has(t: string, id: string) {
		try { return (await stat(join(this.#dir(t, id), id))).isFile(); }
		catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
	}
	async names(t: string) {
		const out: string[] = [];
		let shards: string[];
		try { shards = await readdir(join(this.root, t)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return out; throw e; }
		for (const s of shards) for (const n of await readdir(join(this.root, t, s))) out.push(`${s}/${n}`);
		return out;
	}
	async removeName(t: string, p: string) {
		const [shard, n] = p.split("/");
		const dir = join(this.root, t, shard);
		try { await unlink(join(dir, n)); fsyncDir(dir); }
		catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
	}
}

export class BlobStore {
	readonly #m: Medium;
	readonly #keys: ContentKeys;
	readonly dir: string | null;
	/** While positive, no blob is deleted: a backup is copying the directory (section 6.5). */
	#holds = 0;

	private constructor(m: Medium, keys: ContentKeys, dir: string | null) { this.#m = m; this.#keys = keys; this.dir = dir; }

	/** Opens the blob directory (mode 700, refused when others can reach it), or memory with `dir` null. */
	static async open(dir: string | null, keys: ContentKeys): Promise<BlobStore> {
		if (dir === null) return new BlobStore(new MemoryMedium(), keys, null);
		await prepareDataDir(dir);
		return new BlobStore(new DirMedium(dir), keys, dir);
	}

	/** Seals `bytes` into a new blob under a fresh ID and makes it durable; returns what the content row records. */
	async put(o: BlobOwner, bytes: Uint8Array): Promise<BlobRef> {
		const { generation, secret } = this.#keys.currentContentKey();
		const blobId = newBlobId();
		await this.#m.write(o.tenantId, blobId, seal(secret, generation, o, blobId, bytes));
		return { blobId, size: bytes.length, keyGeneration: generation };
	}

	/** The plaintext of a content row's blob; missing, foreign or damaged is `inconsistentState`. */
	async get(o: BlobOwner, ref: BlobRef): Promise<Buffer> {
		if (!BLOB_ID.test(ref.blobId)) throw new InconsistentState(`tenant ${o.tenantId}: node ${o.nodeId} names a malformed blob ID`);
		const secret = this.#keys.contentKeyFor(ref.keyGeneration);
		if (!secret) throw new InconsistentState(`tenant ${o.tenantId}: blob ${ref.blobId} needs content key generation ${ref.keyGeneration}, which the deployment state lacks`);
		const sealed = await this.#m.read(o.tenantId, ref.blobId);
		if (sealed === null) throw new InconsistentState(`tenant ${o.tenantId}: blob ${ref.blobId} of node ${o.nodeId} version ${o.version} is missing`);
		return unseal(secret, o, ref, sealed);
	}

	/** Whether the blob exists (the restore check, section 6.5); says nothing about its authenticity. */
	async exists(tenantId: string, blobId: string): Promise<boolean> {
		return BLOB_ID.test(blobId) && this.#m.has(tenantId, blobId);
	}

	/** Deletes a blob no committed row names any more; false while deletion is held. */
	async delete(tenantId: string, blobId: string): Promise<boolean> {
		if (this.#holds > 0 || !BLOB_ID.test(blobId)) return false;
		await this.#m.remove(tenantId, blobId);
		return true;
	}

	/**
	 * Deletes up to `limit` blobs of the tenant that `referenced` does not contain, and leftover temporary files: the
	 * orphans of saves that crashed between the blob write and the commit, or after the commit before the old blob's
	 * deletion. The caller runs it in the tenant queue, where no save of the tenant is in flight, and passes every blobId
	 * the tenant's content rows name. Returns how many it removed; nothing while deletion is held.
	 */
	async sweep(tenantId: string, referenced: ReadonlySet<string>, limit = 1000): Promise<number> {
		if (this.#holds > 0) return 0;
		let n = 0;
		for (const path of (await this.#m.names(tenantId)).sort()) {
			if (n >= limit) break;
			const name = path.slice(path.indexOf("/") + 1);
			const blob = BLOB_ID.test(name);
			if (blob && referenced.has(name)) continue;
			if (!blob && !(name.endsWith(TMP) && BLOB_ID.test(name.slice(0, -TMP.length)))) continue; // not ours: leave it
			await this.#m.removeName(tenantId, path);
			n++;
		}
		return n;
	}

	/** Holds every deletion until the returned release runs (a backup copies the directory meanwhile, section 6.5). */
	holdDeletion(): () => void {
		this.#holds++;
		let released = false;
		return () => { if (!released) { released = true; this.#holds--; } };
	}

}
