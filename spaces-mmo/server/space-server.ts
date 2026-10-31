// Which program is the space process: server/space-host.ts, or the Rust server (rust/phi-space-server) when
// SPACES_MMO_SPACE_SERVER names its binary. A name that leads nowhere ends the start: it never falls back to the other server.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./env.ts";

/** The command of the space process, or null when it is server/space-host.ts. */
export function spaceServer(env: Readonly<Record<string, string | undefined>> = process.env): { command: string; args: string[] } | null {
	const binary = env.SPACES_MMO_SPACE_SERVER?.trim();
	if (!binary) return null;
	const command = resolve(ROOT, binary);
	if (!existsSync(command)) throw new Error(`SPACES_MMO_SPACE_SERVER: no such binary: ${command}`);
	return { command, args: ["--profile", "mmo"] };
}
