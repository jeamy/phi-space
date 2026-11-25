// Directories of the service: the data directory, the blob directory and the deployment-state directory are readable
// only by the service account (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 3), and no two of them overlap
// (sections 3 and 6.6).
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

/** Refuses directories that are the same or nested: a data backup must never carry the state (and its content keys),
 *  and the blob sweep must never see the store's files. Pass the directories as name -> path; null entries are skipped. */
export function assertSeparateDirs(dirs: Record<string, string | null>): void {
	const inside = (x: string, y: string) => { const r = relative(y, x); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
	const list = Object.entries(dirs).filter((e): e is [string, string] => e[1] !== null).map(([n, d]) => [n, resolve(d)] as const);
	for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
		const [an, a] = list[i], [bn, b] = list[j];
		if (inside(a, b) || inside(b, a)) throw new Error(`the ${an} directory ${a} and the ${bn} directory ${b} must not overlap`);
	}
}
