// Loads codemode-chat/.env at import time, like the help system: values already in the environment win, so explicit
// `env VAR=...` prefixes and docker `environment:` entries override the file. Imported first by both servers.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadDotEnv(file = join(ROOT, ".env")): void {
	if (!existsSync(file)) return;
	for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		const val = line.slice(eq + 1).replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, ""); // inline comments are not part of the value
		if (process.env[key] === undefined) process.env[key] = val;
	}
}
loadDotEnv();
