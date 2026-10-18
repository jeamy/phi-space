import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const UPLOAD_NAME = /^upl-[a-z0-9-]+\.(png|jpe?g|gif|webp)$/;
/** Serialized quota checks include existing files; only generated uploads older than one day expire. */
export class UploadStore {
	#tail: Promise<unknown> = Promise.resolve();
	readonly dir: string;
	readonly maxBytes: number;
	readonly maxFiles: number;
	readonly ttlMs: number;
	constructor(dir: string, maxBytes = 64 * 1024 * 1024, maxFiles = 256, ttlMs = 86_400_000) { this.dir = dir; this.maxBytes = maxBytes; this.maxFiles = maxFiles; this.ttlMs = ttlMs; }
	put(data: Buffer, extension: string): Promise<string> {
		const work = this.#tail.catch(() => {}).then(async () => {
			if (!/^\.(png|jpg|gif|webp)$/.test(extension)) throw new Error("Invalid upload extension");
			await mkdir(this.dir, { recursive: true });
			let bytes = 0, files = 0;
			for (const name of await readdir(this.dir)) {
				if (!UPLOAD_NAME.test(name)) continue;
				const path = join(this.dir, name), info = await stat(path);
				if (!info.isFile()) continue;
				if (Date.now() - info.mtimeMs > this.ttlMs) { await unlink(path); continue; }
				bytes += info.size; files++;
			}
			if (files >= this.maxFiles || bytes + data.length > this.maxBytes) throw new Error("Upload quota exceeded");
			const name = "upl-" + randomUUID() + extension;
			await writeFile(join(this.dir, name), data, { flag: "wx" });
			return name;
		});
		this.#tail = work;
		return work;
	}
	async existsFresh(name: string): Promise<boolean> {
		if (!UPLOAD_NAME.test(name)) return false;
		try { return Date.now() - (await stat(join(this.dir, name))).mtimeMs <= this.ttlMs; } catch { return false; }
	}
}
