// Which program is the space process: server/space-host.ts, or the Rust one (rust/codemode-space) when CODEMODE_SPACE_SERVER
// names its binary. A name that leads nowhere ends the start: it never falls back to the other server.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ROOT } from "./env.ts";

/** The command of the space process, or null when it is server/space-host.ts. */
export function spaceServer(env: Readonly<Record<string, string | undefined>> = process.env): { command: string; args: string[] } | null {
	const binary = env.CODEMODE_SPACE_SERVER?.trim();
	if (!binary) return null;
	const command = resolve(ROOT, binary);
	if (!existsSync(command)) throw new Error(`CODEMODE_SPACE_SERVER: no such binary: ${command}`);
	// the generic server lost `--profile codemode` (docs/umstellung-verzeichnisse.en.md): started bare it would only print its usage
	if (basename(command) === "phi-space-server") throw new Error(`CODEMODE_SPACE_SERVER: ${command} is the generic server; the space process of codemode-chat is rust/target/release/codemode-space`);
	return { command, args: [] };
}
