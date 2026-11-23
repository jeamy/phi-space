// Remote repositories as a source (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 8): an https address whose
// host the operator allowed (FORUM_GIT_HOSTS), fetched once when the task is created: one commit, shallow, into a bare
// repository of the sources process's cache. From there on it is read like a local one, from the objects of that
// commit (sources.ts); nothing is ever checked out, so no hook, no filter (LFS) and no submodule comes into play.
//
// What the fetch may not do: follow a redirect (it could lead to a host that is not allowed), use another protocol
// than https, ask for or send credentials, read the machine's or the user's git configuration, take longer than
// FORUM_GIT_TIMEOUT_S (default 60 s) or bring more than FORUM_GIT_MAX_MB (default 200 MB).
import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./env.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** FORUM_GIT_HOSTS: the hosts a remote repository may be fetched from, comma-separated (`github.com,git.example.org:8443`). */
export function gitHosts(env: Env = process.env): string[] {
	const hosts = (env.FORUM_GIT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
	for (const h of hosts) if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/.test(h)) throw new Error(`FORUM_GIT_HOSTS: "${h}" is not a host name (with an optional port)`);
	return [...new Set(hosts)];
}

/** The limits of one fetch: bytes on the disk (FORUM_GIT_MAX_MB, default 200) and time (FORUM_GIT_TIMEOUT_S, default 60). */
export function remoteLimits(env: Env = process.env): { bytes: number; ms: number } {
	const num = (name: string, dflt: number) => { const n = Number(env[name]?.trim() || dflt); return Number.isFinite(n) && n > 0 ? n : dflt; };
	return { bytes: Math.round(num("FORUM_GIT_MAX_MB", 200) * 1_000_000), ms: Math.round(num("FORUM_GIT_TIMEOUT_S", 60) * 1000) };
}

/** Where the fetched repositories are kept (FORUM_GIT_CACHE; default codemode-forum/.local/git-cache). */
export const gitCache = (env: Env = process.env) => env.FORUM_GIT_CACHE?.trim() || join(ROOT, ".local", "git-cache");

/** Test only (FORUM_TEST=1): plain http to this machine, so that a test can serve a repository without a certificate. */
const plainLocal = (u: URL, env: Env) => env.FORUM_TEST === "1" && u.protocol === "http:" && u.hostname === "127.0.0.1";

/** The address of a remote repository as the fetch takes it, or an error that says why it is refused: https only, a
 *  host of the allowlist, no user or password, no query, a plain path. */
export function remoteUrl(raw: unknown, hosts: string[], env: Env = process.env): string {
	const text = String(raw ?? "").trim();
	if (!text || text.length > 300) throw new Error("A remote repository is named by its https address");
	let u: URL;
	try { u = new URL(text); } catch { throw new Error("A remote repository is named by its https address"); }
	if (u.protocol !== "https:" && !plainLocal(u, env)) throw new Error("A remote repository is fetched over https only");
	if (u.username || u.password) throw new Error("The address of a remote repository carries no user or password");
	if (u.search || u.hash) throw new Error("The address of a remote repository carries no query and no fragment");
	if (!hosts.includes(u.host.toLowerCase())) throw new Error(hosts.length ? `The host ${u.host} is not allowed for remote repositories (FORUM_GIT_HOSTS: ${hosts.join(", ")})` : "Remote repositories are off: the operator allowed no host (FORUM_GIT_HOSTS)");
	const path = u.pathname.replace(/\/+$/, "");
	if (!/^(\/[\w.~-]+)+$/.test(path) || path.split("/").some((p) => p === "." || p === "..")) throw new Error("The address of a remote repository has a plain path (letters, digits, . _ ~ -)");
	return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

/** The name a remote repository is shown under: its host and path, without the scheme and a trailing `.git`. */
export const remoteName = (url: string) => url.replace(/^https?:\/\//, "").replace(/\.git$/, "");

/** The bare repository of the cache that holds what was fetched from `url`. */
export const remoteDir = (url: string, cache = gitCache()) => join(cache, `${createHash("sha256").update(url).digest("hex").slice(0, 24)}.git`);

/** What git is told on every call for a remote repository: nothing but https, no redirect, no credentials, no hooks. */
const guards = (url: string, env: Env) => [
	"-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...(url.startsWith("http://") && env.FORUM_TEST === "1" ? ["-c", "protocol.http.allow=always"] : []),
	"-c", "http.followRedirects=false", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "core.hooksPath=/dev/null",
	"-c", "gc.auto=0", "-c", "fetch.fsckObjects=true", "-c", "fetch.recurseSubmodules=false",
];
/** Its environment: the machine's and the user's git configuration are not read, nothing is asked on a terminal. */
const gitEnv = (env: Env) => ({
	PATH: env.PATH, HOME: env.HOME, LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ASKPASS: "/bin/false", GIT_LFS_SKIP_SMUDGE: "1",
	...Object.fromEntries(["https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO"].flatMap((k) => (env[k] ? [[k, env[k]]] : []))),
}) as unknown as NodeJS.ProcessEnv;
const run = (dir: string, args: string[], env: Env) => new Promise<string>((ok, fail) => execFile("git", ["-C", dir, ...args], { env: gitEnv(env), maxBuffer: 1024 * 1024 }, (err, out, errOut) => (err ? fail(new Error(String(errOut).trim().split("\n")[0] || err.message)) : ok(String(out).trim()))));

const mb = (bytes: number) => (bytes < 10_000_000 ? (bytes / 1_000_000).toFixed(1) : String(Math.round(bytes / 1_000_000)));
/** The bytes a directory holds. */
async function dirBytes(dir: string): Promise<number> {
	let n = 0;
	for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const p = join(dir, e.name);
		if (e.isDirectory()) n += await dirBytes(p);
		else n += (await stat(p).catch(() => null))?.size ?? 0;
	}
	return n;
}

/** Whether the cache's repository holds the commit. */
export async function hasCommit(dir: string, commit: string, env: Env = process.env): Promise<boolean> {
	if (!existsSync(dir) || !/^[0-9a-f]{40,64}$/.test(commit)) return false;
	return run(dir, ["cat-file", "-e", `${commit}^{commit}`], env).then(() => true, () => false);
}

/** Fetches one commit of a remote repository (`ref`: a branch, a tag, a commit id or HEAD), shallow, into the cache;
 *  returns the cache's repository and the commit. `url` comes from remoteUrl. Throws with the reason when the fetch is
 *  refused, fails, takes too long or brings too much; a repository that was new is removed again then. */
export async function fetchRemote(url: string, ref: string, o: { cache?: string; limits?: { bytes: number; ms: number }; env?: Env } = {}): Promise<{ dir: string; commit: string }> {
	const env = o.env ?? process.env, limits = o.limits ?? remoteLimits(env), dir = remoteDir(url, o.cache ?? gitCache(env));
	if (!/^[\w][\w./-]{0,99}$/.test(ref) || ref.includes("..")) throw new Error(`Not a branch, tag or commit: ${ref.slice(0, 100)}`);
	const fresh = !existsSync(dir);
	if (fresh) { await mkdir(dir, { recursive: true }); await run(dir, ["init", "--bare", "--quiet"], env); }
	const tmp = `refs/forum/tmp-${randomBytes(6).toString("hex")}`;
	const undo = async () => {
		if (fresh) return rm(dir, { recursive: true, force: true });
		await run(dir, ["update-ref", "-d", tmp], env).catch(() => {});
		// what a killed fetch left behind
		const packs = join(dir, "objects", "pack");
		for (const f of await readdir(packs).catch(() => [])) if (f.startsWith("tmp_")) await rm(join(packs, f), { force: true });
	};
	try {
		await new Promise<void>((ok, fail) => {
			// a process group of its own: the kill takes git's helper for https with it
			const child = spawn("git", [...guards(url, env), "-C", dir, "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", url, `+${ref}:${tmp}`], { env: gitEnv(env), detached: true, stdio: ["ignore", "ignore", "pipe"] });
			let err = "", why = "";
			child.stderr.on("data", (d: Buffer) => { if (err.length < 4000) err += d.toString("utf8"); });
			const kill = (reason: string) => { why ||= reason; try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
			const timer = setTimeout(() => kill(`the fetch took longer than ${Math.round(limits.ms / 1000)} s`), limits.ms);
			const watch = setInterval(() => void dirBytes(dir).then((n) => { if (n > limits.bytes) kill(`the repository is larger than ${mb(limits.bytes)} MB`); }), 250);
			const done = () => { clearTimeout(timer); clearInterval(watch); };
			child.on("error", (e) => { done(); fail(e); });
			child.on("close", (code) => {
				done();
				if (why) return fail(new Error(why));
				if (code === 0) return ok();
				const line = err.split("\n").map((l) => l.trim()).filter(Boolean).find((l) => /^(fatal|error):/.test(l)) ?? err.trim().split("\n")[0] ?? "";
				fail(new Error(/couldn't find remote ref|no such ref/i.test(err) ? `No such branch, tag or commit: ${ref}` : `the fetch failed: ${line.replace(/^(fatal|error):\s*/, "").slice(0, 200) || `git ended with ${code}`}`));
			});
		});
		if ((await dirBytes(dir)) > limits.bytes) throw new Error(`the repository is larger than ${mb(limits.bytes)} MB`);
		const commit = await run(dir, ["rev-parse", "--verify", "--quiet", `${tmp}^{commit}`], env);
		// the commit stays reachable under a name of its own; the fetch's name goes
		await run(dir, ["update-ref", `refs/forum/${commit}`, commit], env);
		await run(dir, ["update-ref", "-d", tmp], env);
		return { dir, commit };
	} catch (e) { await undo().catch(() => {}); throw e; }
}
