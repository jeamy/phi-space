// The sources of a plan task, read-only (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 8). A source pack is
// fixed when the task is created: uploaded documents (kept in the space as pages), or a local git repository at one
// commit. A repository is never copied or unpacked: every read goes to the objects of that commit (`git ls-tree`,
// `git cat-file`, `git grep`), so only tracked files exist for a reader, no path leads out of the tree, a symbolic
// link is an entry that is not offered, and a later commit changes nothing.
//
// There are three calls and no fourth: list a directory, read lines of a file, search for a text. None writes.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export const SOURCE_LIMITS = { docs: 10, docsBytes: 800_000, fileBytes: 200_000, files: 20_000, list: 200, readLines: 400, readBytes: 16_000, hits: 40, hitChars: 200, query: 200 };

/** A source pack of a block, as its PlanSource entry says: `docs` (uploaded documents) or `repo` (a repository of the
 *  operator's list, by its name there, at `commit`). */
export type PlanSource = { session: string; blockId: string; sourceId: "docs" | "repo"; kind: "docs" | "repo"; name: string; commit?: string; ref?: string; files: number; bytes: number; indexHash: string; ts: number };
/** A file of a pack: its path and size in bytes. */
export type IndexEntry = [path: string, size: number];
/** A pack as the calls see it: what files there are, and how one is read. */
export type Pack = { index: IndexEntry[]; read: (path: string) => Promise<Buffer>;
	/** Lines that contain `query` (fixed text, any case): [path, line number, line]; without it the files are read. */
	grep?: (query: string, glob?: string) => Promise<Array<[string, number, string]>> };
/** One reading call. */
export type SourceCall = { op: "list"; dir?: string } | { op: "read"; path: string; from?: number; lines?: number } | { op: "search"; query: string; glob?: string };

/** Files no reader gets, whatever the pack holds: keys and local settings. */
const DENY = [/(^|\/)\.env[^/]*$/i, /\.(pem|key|p12|pfx|keystore)$/i, /(^|\/)auth\.json$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/i, /(^|\/)\.npmrc$/i, /(^|\/)\.netrc$/i];
export const denied = (path: string) => DENY.some((r) => r.test(path));

/** A path as a caller wrote it, normalized to a path inside the pack; null when it is none (it leads up or out, or
 *  holds a character no path of a pack has). */
export function safePath(raw: string): string | null {
	const p = raw.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
	if (p === "" || p === ".") return "";
	if (p.startsWith("/") || p.includes("\\") || p.includes("\0") || p.length > 400) return null;
	const parts = p.split("/");
	return parts.some((x) => x === ".." || x === "." || x === "") ? null : parts.join("/");
}

export const indexHash = (index: IndexEntry[]) => createHash("sha256").update(index.map(([p, n]) => `${p}\t${n}`).join("\n")).digest("hex").slice(0, 24);
const glob = (g: string) => new RegExp("^" + g.split("**").map((part) => part.split("*").map((x) => x.replace(/[.+^${}()|[\]\\?]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
/** A glob a caller may give: letters, digits, `. _ - /` and `*`. */
export const safeGlob = (g: string | undefined): string | undefined => (g && /^[\w.*/-]{1,120}$/.test(g) && !g.includes("..") ? g : undefined);

/** `list`: the directories and files directly in `dir`. */
export function listDir(pack: Pack, dir = ""): string {
	const at = safePath(dir);
	if (at === null) return `No such directory: ${dir}`;
	const prefix = at ? `${at}/` : "", dirs = new Map<string, number>(), files: IndexEntry[] = [];
	for (const [path, size] of pack.index) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length), cut = rest.indexOf("/");
		if (cut < 0) files.push([rest, size]); else dirs.set(rest.slice(0, cut), (dirs.get(rest.slice(0, cut)) ?? 0) + 1);
	}
	if (!dirs.size && !files.length) return `No such directory: ${at || "/"}`;
	const byName = ([a]: [string, number], [b]: [string, number]) => (a < b ? -1 : a > b ? 1 : 0); // the same order on every host
	const rows = [...[...dirs].sort(byName).map(([d, n]) => `${d}/  (${n} files)`), ...files.sort(byName).map(([f, n]) => `${f}  (${n} bytes)`)];
	const more = rows.length - SOURCE_LIMITS.list;
	return [`${at || "/"}: ${dirs.size} directories, ${files.length} files`, ...rows.slice(0, SOURCE_LIMITS.list), ...(more > 0 ? [`… and ${more} more`] : [])].join("\n");
}

/** `read`: lines of a file, from line `from` (1 is the first), at most 400 lines or 16 kB. */
export async function readLines(pack: Pack, raw: string, from = 1, lines: number = SOURCE_LIMITS.readLines): Promise<string> {
	const path = safePath(raw);
	if (!path || !pack.index.some(([p]) => p === path)) return `No such file in the source: ${raw.trim().slice(0, 200)} (list a directory to see what is there)`;
	const buf = await pack.read(path);
	if (buf.subarray(0, 8000).includes(0)) return `${path} is not a text file`;
	const all = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
	if (all.at(-1) === "") all.pop();
	const first = Math.max(1, Math.floor(from) || 1), want = Math.min(SOURCE_LIMITS.readLines, Math.max(1, Math.floor(lines) || SOURCE_LIMITS.readLines));
	const out: string[] = [];
	let bytes = 0;
	for (const l of all.slice(first - 1, first - 1 + want)) { bytes += Buffer.byteLength(l) + 1; if (bytes > SOURCE_LIMITS.readBytes && out.length) break; out.push(l.length > 2000 ? l.slice(0, 2000) + "…" : l); }
	if (!out.length) return `${path} has ${all.length} lines; none from line ${first}`;
	return `${path} (lines ${first}-${first + out.length - 1} of ${all.length})\n${out.join("\n")}`;
}

/** `search`: the lines that contain `query` (fixed text, any case), in the files `glob` names (all without it). */
export async function search(pack: Pack, rawQuery: string, rawGlob?: string): Promise<string> {
	const query = rawQuery.trim().slice(0, SOURCE_LIMITS.query), g = safeGlob(rawGlob?.trim());
	if (query.length < 2) return "A search needs at least two characters";
	if (rawGlob?.trim() && !g) return `Not a file pattern: ${rawGlob.trim().slice(0, 120)} (letters, digits, . _ - / and *)`;
	const allowed = new Set(pack.index.map(([p]) => p)), match = g ? glob(g.includes("/") ? g : `**${g}`) : null;
	let hits: Array<[string, number, string]>;
	if (pack.grep) hits = (await pack.grep(query, g)).filter(([p]) => allowed.has(p) && (!match || match.test(p)));
	else {
		hits = [];
		const needle = query.toLowerCase();
		for (const [path] of pack.index) {
			if (match && !match.test(path)) continue;
			const text = (await pack.read(path)).toString("utf8");
			text.split("\n").forEach((line, i) => { if (line.toLowerCase().includes(needle)) hits.push([path, i + 1, line]); });
			if (hits.length > SOURCE_LIMITS.hits) break;
		}
	}
	if (!hits.length) return `No line contains "${query}"${g ? ` in ${g}` : ""}`;
	const shown = hits.slice(0, SOURCE_LIMITS.hits).map(([p, n, l]) => `${p}:${n}: ${l.trim().slice(0, SOURCE_LIMITS.hitChars)}`);
	return [`"${query}"${g ? ` in ${g}` : ""}: ${hits.length > SOURCE_LIMITS.hits ? `the first ${SOURCE_LIMITS.hits} lines` : `${hits.length} lines`}`, ...shown].join("\n");
}

/** One call on a pack, answered as text. What a caller got wrong (no such file, no pattern) is part of the answer. */
export function answer(pack: Pack, call: SourceCall): Promise<string> | string {
	return call.op === "list" ? listDir(pack, call.dir) : call.op === "read" ? readLines(pack, call.path, call.from, call.lines) : search(pack, call.query, call.glob);
}

// ---- uploaded documents ----

/** Documents as a person uploads them, checked: names become paths of the pack. Throws what is wrong. */
export function checkDocs(raw: unknown): Array<{ path: string; text: string }> {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error("docs: a list of { name, text }");
	if (raw.length > SOURCE_LIMITS.docs) throw new Error(`At most ${SOURCE_LIMITS.docs} documents`);
	const out: Array<{ path: string; text: string }> = [];
	for (const d of raw as Array<{ name?: unknown; text?: unknown }>) {
		const path = safePath(String(d?.name ?? "").replace(/\\/g, "/").split("/").pop() ?? ""), text = typeof d?.text === "string" ? d.text.replace(/\r\n/g, "\n") : "";
		if (!path || !/\.(md|markdown|txt|csv|json|ya?ml)$/i.test(path)) throw new Error(`A document is a text file (.md, .txt, .csv, .json, .yaml): ${String(d?.name ?? "").slice(0, 80)}`);
		if (denied(path)) throw new Error(`Not a document to share: ${path}`);
		if (text.includes("\0") || !text.trim()) throw new Error(`${path} is empty or not text`);
		if (out.some((x) => x.path.toLowerCase() === path.toLowerCase())) throw new Error(`Two documents are called ${path}`);
		out.push({ path, text });
	}
	const bytes = out.reduce((n, x) => n + Buffer.byteLength(x.text), 0);
	if (bytes > SOURCE_LIMITS.docsBytes) throw new Error(`The documents have ${bytes} bytes together; at most ${SOURCE_LIMITS.docsBytes}`);
	return out;
}
/** A pack of documents held in memory. */
export function docsPack(docs: Array<{ path: string; text: string }>): Pack {
	const by = new Map(docs.map((d) => [d.path, Buffer.from(d.text, "utf8")]));
	return { index: docs.map((d): IndexEntry => [d.path, by.get(d.path)!.length]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), read: async (p) => by.get(p) ?? Buffer.alloc(0) };
}

// ---- a local git repository at a commit ----

const git = (repo: string, args: string[], maxBuffer = 64 * 1024 * 1024) => new Promise<Buffer>((ok, fail) => {
	// read-only commands on the objects; no prompt, no optional lock, nothing of the user's or system's configuration
	execFile("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repo, ...args], { encoding: "buffer", maxBuffer, timeout: 30_000, env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" } as unknown as NodeJS.ProcessEnv },
		(err: Error | null, out: Buffer, errOut: Buffer) => (err ? fail(Object.assign(new Error(String(errOut).trim().split("\n")[0] || err.message), { code: (err as { code?: unknown }).code })) : ok(out)));
});

/** The commit a branch, tag or commit id names in the repository; throws when it names none. */
export async function resolveCommit(repo: string, ref: string): Promise<string> {
	if (!/^[\w][\w./-]{0,99}$/.test(ref) || ref.includes("..")) throw new Error(`Not a branch, tag or commit: ${ref.slice(0, 100)}`);
	try { return (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).toString().trim(); }
	catch { throw new Error(`No such branch, tag or commit: ${ref}`); }
}

/** The pack of a repository at `commit`: its tracked regular files up to 200 kB each, without the denied ones. */
export async function gitPack(repo: string, commit: string): Promise<Pack> {
	if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("not a commit id");
	const index: IndexEntry[] = [];
	// mode, type, object and size, a tab, the path; entries end with NUL (so no path is quoted)
	for (const row of (await git(repo, ["ls-tree", "-r", "-l", "-z", commit])).toString("utf8").split("\0")) {
		const m = /^(\d{6}) (\w+) [0-9a-f]+ +(\d+|-)\t([\s\S]+)$/.exec(row);
		if (!m || m[2] !== "blob" || (m[1] !== "100644" && m[1] !== "100755")) continue; // a symbolic link is 120000, a submodule a commit
		const path = m[4]!, size = Number(m[3]);
		if (safePath(path) !== path || denied(path) || size > SOURCE_LIMITS.fileBytes) continue;
		index.push([path, size]);
		if (index.length >= SOURCE_LIMITS.files) break;
	}
	index.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return {
		index,
		read: (path) => git(repo, ["cat-file", "blob", `${commit}:${path}`], 4 * 1024 * 1024),
		grep: async (query, g) => {
			let out: Buffer;
			// -I: no binary files; -F: the query is text, not a pattern; exit code 1 means no line
			try { out = await git(repo, ["grep", "-n", "-I", "-F", "-i", "-z", "-e", query, commit, "--", ...(g ? [`:(glob)${g.includes("/") ? g : `**/${g}`}`, ...(g.includes("/") ? [] : [`:(glob)${g}`])] : [])]); }
			catch (e) { if ((e as { code?: unknown }).code === 1) return []; throw e; }
			const hits: Array<[string, number, string]> = [];
			// <commit>:<path> NUL <line number> NUL <line> newline
			for (const row of out.toString("utf8").split("\n")) {
				const [head, n, ...line] = row.split("\0");
				if (!head || n === undefined) continue;
				hits.push([head.slice(commit.length + 1), Number(n), line.join("\0")]);
				if (hits.length > SOURCE_LIMITS.hits * 50) break;
			}
			return hits;
		},
	};
}

/** FORUM_REPOS: `name=/path,name2=/path2`, the repositories the operator offers. */
export function reposOf(env: Readonly<Record<string, string | undefined>> = process.env): Map<string, string> {
	const out = new Map<string, string>();
	for (const pair of (env.FORUM_REPOS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
		const eq = pair.indexOf("="), name = pair.slice(0, eq).trim(), path = pair.slice(eq + 1).trim();
		if (eq <= 0 || !/^[\w.-]{1,40}$/.test(name) || !path.startsWith("/")) throw new Error(`FORUM_REPOS: "${pair}" is not name=/absolute/path`);
		out.set(name, path);
	}
	return out;
}
