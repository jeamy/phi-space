// A small private JSON state file (fencing adapters): read whole, replaced atomically through a rename.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function atomicJsonFile<T>(path: string, empty: () => T): { read(): T; write(v: T): void } {
	return {
		read: () => {
			if (!existsSync(path)) return empty();
			try { return JSON.parse(readFileSync(path, "utf8")) as T; }
			catch (e) { throw new Error(`state file ${path} is not valid JSON; restore or remove it deliberately`, { cause: e }); }
		},
		write: v => { writeFileSync(path + ".tmp", JSON.stringify(v), { mode: 0o600 }); renameSync(path + ".tmp", path); },
	};
}
