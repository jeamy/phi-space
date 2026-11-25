// Directories of the service: the data directory and the deployment-state directory are readable only by the service
// account (docs/zanzibar-agent-filesystem-plan.en.md, section 2), and they never overlap (section 6.6).
import { chmod, mkdir, stat } from "node:fs/promises";
import { relative, resolve, isAbsolute } from "node:path";

/** Creates the data directory readable only by the service account, and refuses one that others can reach. */
export async function prepareDataDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const s = await stat(dir);
	if (!s.isDirectory()) throw new Error(`${dir} is not a directory`);
	if (typeof process.getuid === "function" && s.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
	if ((s.mode & 0o077) !== 0) throw new Error(`${dir} is reachable by group or others (mode ${(s.mode & 0o777).toString(8)}); restrict it to the service account (chmod 700)`);
	await chmod(dir, 0o700);
}

/** Refuses a data and a state directory that are the same or nested: a data backup must never carry the state. */
export function assertSeparateDirs(dataDir: string, stateDir: string): void {
	const a = resolve(dataDir), b = resolve(stateDir);
	const inside = (x: string, y: string) => { const r = relative(y, x); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
	if (inside(a, b) || inside(b, a)) throw new Error(`the data directory ${a} and the deployment-state directory ${b} must not overlap`);
}
