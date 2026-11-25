// The encrypted backup archive (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 6.5: "authenticated
// encryption for every exported backup with the backup key held separately"). One format for the data backup and the
// deployment-state backup, each with a key file of its own.
//
// Plaintext: a sequence of entries, each `u16 nameLength | name (UTF-8) | u64 size | bytes`, ended by an entry with
// an empty name. It is cut into chunks of at most CHUNK bytes; chunk i is sealed with AES-256-GCM under a key derived
// for this archive alone (HKDF-SHA-256 of the backup key and a random archive ID), nonce = i as 12 bytes, and
// associated data `archive ID | i | final flag`. File: `PSBK1 | archive ID (32) | { u32 length | ciphertext | tag }*`.
// A reordered, dropped, truncated or foreign chunk fails its tag or the final flag, so `verifyArchive` reads every
// chunk before `extractArchive` lets one byte of plaintext out.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const MAGIC = Buffer.from("PSBK1");
const CHUNK = 1 << 20;
const TAG = 16;

export class ArchiveInvalid extends Error {
	constructor(message: string) { super(message); this.name = "ArchiveInvalid"; }
}

/** Reads a backup key file: 32 random bytes, base64, mode 600. */
export function readBackupKey(path: string): Buffer {
	if ((statSync(path).mode & 0o077) !== 0) throw new Error(`the backup key ${path} is reachable by group or others; restrict it (chmod 600)`);
	const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
	if (key.length !== 32) throw new Error(`the backup key ${path} does not hold 32 bytes`);
	return key;
}

/** Writes a new backup key file (mode 600); refuses to replace one. */
export function newBackupKey(path: string): void {
	if (existsSync(path)) throw new Error(`refusing to replace the existing backup key ${path}`);
	writeFileSync(path, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
}

const archiveKey = (key: Buffer, id: Buffer) => Buffer.from(hkdfSync("sha256", key, id, "phi-spaces-files backup v1", 32));
const nonce = (i: number) => { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(i), 4); return n; };
const aad = (id: Buffer, i: number, final: boolean) => { const a = Buffer.alloc(41); id.copy(a, 0); a.writeBigUInt64BE(BigInt(i), 32); a[40] = final ? 1 : 0; return a; };

/** An entry to archive: a name (relative, `/`-separated) and either bytes or a file to stream. */
export type ArchiveSource = { name: string; bytes: Buffer } | { name: string; file: string };

/**
 * Writes `sources` to `dest` as one archive: to a temporary file, flushed, renamed, its directory flushed. Files are
 * streamed in chunks, so a large blob directory never sits in memory.
 */
export function writeArchive(dest: string, key: Buffer, sources: Iterable<ArchiveSource>): { bytes: number; entries: number } {
	const id = randomBytes(32);
	const k = archiveKey(key, id);
	const tmp = `${dest}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	let index = 0, written = 0, entries = 0;
	let buf: Buffer = Buffer.alloc(0);
	const seal = (plain: Buffer, final: boolean) => {
		const c = createCipheriv("aes-256-gcm", k, nonce(index));
		c.setAAD(aad(id, index, final));
		const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
		const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
		writeSync(fd, len); writeSync(fd, body);
		written += 4 + body.length;
		index++;
	};
	const push = (b: Buffer) => {
		buf = buf.length ? Buffer.concat([buf, b]) : b;
		while (buf.length > CHUNK) { seal(buf.subarray(0, CHUNK), false); buf = buf.subarray(CHUNK); }
	};
	const header = (name: string, size: number) => {
		const n = Buffer.from(name, "utf8");
		if (n.length > 0xffff) throw new Error(`archive entry name too long: ${name}`);
		const h = Buffer.alloc(2 + n.length + 8);
		h.writeUInt16BE(n.length, 0); n.copy(h, 2); h.writeBigUInt64BE(BigInt(size), 2 + n.length);
		push(h);
	};
	try {
		writeSync(fd, MAGIC); writeSync(fd, id); written += MAGIC.length + id.length;
		for (const s of sources) {
			if (s.name === "" ) throw new Error("an archive entry needs a name");
			entries++;
			if ("bytes" in s) { header(s.name, s.bytes.length); push(s.bytes); continue; }
			const size = statSync(s.file).size;
			header(s.name, size);
			const f = openSync(s.file, "r");
			try {
				const chunk = Buffer.alloc(CHUNK);
				let left = size;
				while (left > 0) {
					const n = readSync(f, chunk, 0, Math.min(CHUNK, left), null);
					if (n === 0) throw new Error(`${s.file} shrank while it was archived`);
					push(Buffer.from(chunk.subarray(0, n)));
					left -= n;
				}
			} finally { closeSync(f); }
		}
		header("", 0);
		seal(buf, true);
		fsyncSync(fd);
	} finally { closeSync(fd); }
	renameSync(tmp, dest);
	const dfd = openSync(dirname(dest), "r");
	try { fsyncSync(dfd); } finally { closeSync(dfd); }
	return { bytes: written, entries };
}

/** Each chunk's plaintext in order; throws ArchiveInvalid on any tampering, truncation or a wrong key. */
function* chunks(path: string, key: Buffer): Generator<Buffer> {
	const fd = openSync(path, "r");
	try {
		const head = Buffer.alloc(MAGIC.length + 32);
		if (readSync(fd, head, 0, head.length, null) !== head.length || !head.subarray(0, MAGIC.length).equals(MAGIC)) throw new ArchiveInvalid("not a backup archive");
		const id = head.subarray(MAGIC.length);
		const k = archiveKey(key, id);
		const lenBuf = Buffer.alloc(4);
		for (let i = 0; ; i++) {
			const got = readSync(fd, lenBuf, 0, 4, null);
			if (got === 0) throw new ArchiveInvalid("the archive is truncated (no final chunk)");
			if (got !== 4) throw new ArchiveInvalid("the archive is truncated");
			const len = lenBuf.readUInt32BE();
			if (len < TAG || len > CHUNK + TAG) throw new ArchiveInvalid("a chunk has an impossible length");
			const body = Buffer.alloc(len);
			if (readSync(fd, body, 0, len, null) !== len) throw new ArchiveInvalid("the archive is truncated");
			// a chunk is final when its associated data says so: try the flag that the position allows
			let plain: Buffer | null = null, final = false;
			for (const f of [false, true]) {
				try {
					const d = createDecipheriv("aes-256-gcm", k, nonce(i));
					d.setAAD(aad(id, i, f));
					d.setAuthTag(body.subarray(len - TAG));
					plain = Buffer.concat([d.update(body.subarray(0, len - TAG)), d.final()]);
					final = f;
					break;
				} catch { /* the other flag, or tampered */ }
			}
			if (plain === null) throw new ArchiveInvalid("a chunk fails authentication (tampered, reordered or another key)");
			yield plain;
			if (final) {
				if (readSync(fd, lenBuf, 0, 1, null) !== 0) throw new ArchiveInvalid("data after the final chunk");
				return;
			}
		}
	} finally { closeSync(fd); }
}

type Visitor = { begin(name: string, size: number): void; data(b: Buffer): void; end(): void };

function walk(path: string, key: Buffer, v: Visitor): number {
	let buf: Buffer = Buffer.alloc(0);
	let cur: { left: number } | null = null;
	let entries = 0, done = false;
	for (const c of chunks(path, key)) {
		if (done) throw new ArchiveInvalid("data after the archive's end entry");
		buf = buf.length ? Buffer.concat([buf, c]) : c;
		for (;;) {
			if (cur) {
				const n = Math.min(cur.left, buf.length);
				if (n > 0) { v.data(buf.subarray(0, n)); buf = buf.subarray(n); cur.left -= n; }
				if (cur.left > 0) break;
				v.end(); cur = null;
			}
			if (done || buf.length < 2) break;
			const nl = buf.readUInt16BE(0);
			if (buf.length < 2 + nl + 8) break;
			const name = buf.subarray(2, 2 + nl).toString("utf8");
			const size = Number(buf.readBigUInt64BE(2 + nl));
			buf = buf.subarray(2 + nl + 8);
			if (name === "") { done = true; if (buf.length) throw new ArchiveInvalid("data after the archive's end entry"); break; }
			entries++;
			v.begin(name, size);
			cur = { left: size };
		}
	}
	if (!done || cur) throw new ArchiveInvalid("the archive ends inside an entry");
	return entries;
}

/** Reads the whole archive and checks every chunk and the entry framing; returns the entry names and sizes. */
export function verifyArchive(path: string, key: Buffer): Array<{ name: string; size: number }> {
	const out: Array<{ name: string; size: number }> = [];
	walk(path, key, { begin: (name, size) => out.push({ name, size }), data: () => {}, end: () => {} });
	return out;
}

/** Reads one small entry into memory (after `verifyArchive`). */
export function readEntry(path: string, key: Buffer, name: string): Buffer | null {
	let parts: Buffer[] | null = null, hit: Buffer | null = null;
	walk(path, key, { begin: (n) => { parts = n === name ? [] : null; }, data: (b) => { parts?.push(Buffer.from(b)); }, end: () => { if (parts) hit = Buffer.concat(parts); parts = null; } });
	return hit;
}

/**
 * Verifies the whole archive first, then writes the entries `map` places (a relative target name, or null to skip;
 * default: the entry's own name) below `dest` (files mode 600, directories 700), each flushed. Targets are checked to
 * stay inside `dest`.
 */
export function extractArchive(path: string, key: Buffer, dest: string, map: (name: string) => string | null = (n) => n): string[] {
	verifyArchive(path, key);
	const written: string[] = [];
	let fd: number | null = null;
	walk(path, key, {
		begin: (entry) => {
			const name = map(entry);
			if (name === null) return;
			const target = normalize(join(dest, name));
			if (!target.startsWith(normalize(dest) + sep) || name.includes("\0")) throw new ArchiveInvalid(`an entry escapes the destination: ${name}`);
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			fd = openSync(target, "wx", 0o600);
			written.push(name);
		},
		data: (b) => { if (fd !== null) writeSync(fd, b); },
		end: () => { if (fd !== null) { fsyncSync(fd); closeSync(fd); fd = null; } },
	});
	return written;
}
