// Remote repositories as a source: an https address on a host the operator allowed, fetched once (one commit, into a
// bare repository of the sources process's cache), then read like a local one. A local git server stands in for the
// remote host (plain http to 127.0.0.1, which the sources process takes with FORUM_TEST=1 only).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "../server/hub.ts";
import { gitHosts, remoteLimits, remoteName, remoteUrl } from "../server/remote.ts";
import { askSources } from "../server/source-host.ts";
import { startServer } from "./stack.ts";

const BRIEF = "Plan how the world gets four times the resolution.";
const ADMIN = { "x-admin-token": "open sesame" };
let seq = 0;
const room = (scenario: string) => `${scenario}-g${process.pid}-${seq++}`;
const post = async (url: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** A directory of bare repositories as a git server would hold them: `demo.git` (text files, a tracked secret, a
 *  symbolic link) and `big.git` (a file that does not compress). */
function makeRemotes(): { root: string; head: string } {
	const root = mkdtempSync(join(tmpdir(), "forum-remote-")), work = join(root, "work");
	const make = (name: string, files: Record<string, string | Buffer>, link = false): string => {
		const dir = join(work, name);
		mkdirSync(dir, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
		git("init", "-q", "-b", "main");
		for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); }
		if (link) symlinkSync("/etc/hostname", join(dir, "link.txt"));
		git("add", "-A"); git("commit", "-q", "-m", "first");
		execFileSync("git", ["clone", "-q", "--bare", dir, join(root, `${name}.git`)]);
		// a commit may be asked for by its id (a cache that lost it fetches it again)
		execFileSync("git", ["-C", join(root, `${name}.git`), "config", "uploadpack.allowAnySHA1InWant", "true"]);
		return git("rev-parse", "HEAD");
	};
	const head = make("demo", { "README.md": "# Demo\nThe world has a resolution of 64.\n", "src/world.ts": "export const RESOLUTION = 64;\n", ".env": "SECRET=tracked-secret\n", "keys/server.pem": "-----BEGIN PRIVATE KEY-----\n" }, true);
	make("big", { "README.md": "# Big\n", "blob.bin": randomBytes(400_000) });
	return { root, head };
}

/** A git server over http on this machine (`git http-backend` behind a small CGI bridge). `mode`: "redirect" answers
 *  every request with a redirect to `to`; "stall" never answers. */
async function gitServer(root: string, mode?: "redirect" | "stall", to?: string): Promise<{ host: string; requests: string[]; close: () => Promise<void> }> {
	const requests: string[] = [];
	const server = http.createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		if (mode === "stall") return;
		if (mode === "redirect") { res.writeHead(302, { location: `${to}${req.url}` }); return void res.end(); }
		const u = new URL(req.url ?? "/", "http://localhost");
		const child = spawn("git", ["http-backend"], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: req.method, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: String(req.headers["content-type"] ?? ""), HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""), GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""), REMOTE_ADDR: "127.0.0.1", ...(req.headers["content-length"] ? { CONTENT_LENGTH: String(req.headers["content-length"]) } : {}) } as unknown as NodeJS.ProcessEnv });
		req.pipe(child.stdin);
		child.stdin.on("error", () => {});
		let head: Buffer | null = Buffer.alloc(0);
		child.stdout.on("data", (d: Buffer) => {
			if (!head) return void res.write(d);
			head = Buffer.concat([head, d]);
			const at = head.indexOf("\r\n\r\n");
			if (at < 0) return;
			const lines = head.subarray(0, at).toString("latin1").split("\r\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()] as const);
			const status = Number(lines.find(([k]) => k.toLowerCase() === "status")?.[1].split(" ")[0] ?? 200);
			res.writeHead(status, Object.fromEntries(lines.filter(([k]) => k.toLowerCase() !== "status")));
			res.write(head.subarray(at + 4));
			head = null;
		});
		child.stdout.on("end", () => res.end());
	});
	await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
	const port = (server.address() as { port: number }).port;
	return { host: `127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

test("the address of a remote repository: https, an allowed host, no credentials, a plain path", () => {
	const hosts = gitHosts({ FORUM_GIT_HOSTS: " GitHub.com, git.example.org:8443 ,github.com" });
	assert.deepEqual(hosts, ["github.com", "git.example.org:8443"]);
	assert.throws(() => gitHosts({ FORUM_GIT_HOSTS: "https://github.com" }), /is not a host name/);
	assert.deepEqual(gitHosts({}), []);
	assert.equal(remoteUrl(" https://GitHub.com/org/repo.git/ ", hosts), "https://github.com/org/repo.git");
	assert.equal(remoteUrl("https://git.example.org:8443/a/b/c", hosts), "https://git.example.org:8443/a/b/c");
	assert.equal(remoteName("https://github.com/org/repo.git"), "github.com/org/repo");
	for (const [url, why] of [
		["http://github.com/org/repo", /over https only/], ["ssh://git@github.com/org/repo", /over https only/], ["git@github.com:org/repo.git", /https address/], ["file:///etc", /over https only/], ["/home/me/repo", /https address/], ["", /https address/],
		["https://user:secret@github.com/org/repo", /no user or password/], ["https://token@github.com/org/repo", /no user or password/],
		["https://github.com/org/repo?x=1", /no query/], ["https://github.com/org/repo#main", /no query/],
		["https://gitlab.com/org/repo", /The host gitlab.com is not allowed/], ["https://github.com.evil.org/org/repo", /is not allowed/], ["https://git.example.org/a/b", /is not allowed/], ["https://github.com:444/org/repo", /is not allowed/],
		["https://github.com/", /plain path/], ["https://github.com/org/re po", /plain path/], ["https://github.com/org/re%3Bpo", /plain path/],
	] as const) assert.throws(() => remoteUrl(url, hosts), why, url);
	assert.throws(() => remoteUrl("https://github.com/org/repo", []), /Remote repositories are off/);
	// plain http to this machine is for the tests alone
	assert.throws(() => remoteUrl("http://127.0.0.1:9/demo.git", ["127.0.0.1:9"], {}), /over https only/);
	assert.equal(remoteUrl("http://127.0.0.1:9/demo.git", ["127.0.0.1:9"], { FORUM_TEST: "1" }), "http://127.0.0.1:9/demo.git");
	assert.throws(() => remoteUrl("http://localhost:9/demo.git", ["localhost:9"], { FORUM_TEST: "1" }), /over https only/);
	assert.deepEqual([remoteLimits({}), remoteLimits({ FORUM_GIT_MAX_MB: "0.5", FORUM_GIT_TIMEOUT_S: "2" }), remoteLimits({ FORUM_GIT_MAX_MB: "x", FORUM_GIT_TIMEOUT_S: "-1" })], [{ bytes: 200_000_000, ms: 60_000 }, { bytes: 500_000, ms: 2000 }, { bytes: 200_000_000, ms: 60_000 }]);
});

test("a task with a remote repository: fetched once at one commit into a bare cache, read like a local one, and refused from a host that is not allowed", async (t) => {
	const remotes = makeRemotes(), git = await gitServer(remotes.root), other = await gitServer(remotes.root), bounce = await gitServer(remotes.root, "redirect", `http://${other.host}`);
	const cache = mkdtempSync(join(tmpdir(), "forum-git-cache-"));
	process.env.FORUM_ADMIN_PASSWORD = "open sesame";
	const srv = await startServer();
	t.after(async () => { process.env.FORUM_ADMIN_PASSWORD = ""; await srv.close(); await Promise.all([git.close(), other.close(), bounce.close()]); await rm(remotes.root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });
	const env = { FORUM_TEST: "1", FORUM_GIT_HOSTS: `${git.host},${bounce.host}`, FORUM_GIT_CACHE: cache };
	let sources = await srv.stack.sources({ env });
	const id = room("remote"), url = `http://${git.host}/demo.git`;
	// only an admin learns the hosts and may name a remote repository
	await until("the hosts to be offered", async () => (await (await fetch(`${srv.url}/api/sources`, { headers: ADMIN })).json() as { hosts: string[] }).hosts.includes(git.host));
	assert.deepEqual(await (await fetch(`${srv.url}/api/sources`)).json(), { repos: [], hosts: [] });
	const refused = async (repo: Record<string, unknown>, why: RegExp, headers: Record<string, string> = ADMIN) => { const r = await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, repo }, headers); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(r.body.error, why); };
	await refused({ url }, /needs the admin login/, {});
	await refused({ url, name: "demo" }, /not both/);
	await refused({ url: "git@example.org:x/y.git" }, /named by its https address/);
	// a host that is not on the list is never contacted
	await refused({ url: `http://${other.host}/demo.git` }, /is not allowed for remote repositories/);
	assert.equal(other.requests.length, 0);
	await refused({ url: `http://user:pw@${git.host}/demo.git` }, /no user or password/);
	// a redirect is not followed, even from an allowed host
	await refused({ url: `http://${bounce.host}/demo.git` }, /the fetch failed/);
	assert.ok(bounce.requests.length > 0 && other.requests.length === 0);
	await refused({ url, ref: "nope" }, /No such branch, tag or commit: nope/);
	await refused({ url: `http://${git.host}/missing.git` }, /the fetch failed/);
	// what the refused fetches left: nothing
	assert.deepEqual(readdirSync(cache), []);
	assert.equal((await snapshot(srv.url, id)).blocks.length, 0);

	const created = await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, repo: { url, ref: "main" } }, ADMIN);
	assert.equal(created.status, 200, JSON.stringify(created.body));
	const s = await snapshot(srv.url, id), src = s.blocks[0]!.sources[0]!;
	assert.deepEqual(src, { sourceId: "repo", kind: "repo", name: `${git.host}/demo`, url, commit: remotes.head, ref: "main", files: 2, bytes: src.bytes });
	assert.match(s.lines.at(-1)!.text, new RegExp(`^Plan task created with ${git.host.replace(".", "\\.")}/demo at ${remotes.head.slice(0, 12)} \\(2 files\\)`));
	// tracked files only, without the secret, the key and the symbolic link
	const index = (await srv.stack.space.readAll({ type: "SourceIndex", fields: { session: id, sourceId: "repo" } }, { limit: 10 })).flatMap((e) => (e.fields as unknown as { paths: Array<[string, number]> }).paths);
	assert.deepEqual(index.map(([p]) => p), ["README.md", "src/world.ts"]);
	// the cache holds one bare repository: objects, no file of the repository anywhere, and a shallow history
	const [repoDir] = readdirSync(cache);
	assert.match(repoDir!, /^[0-9a-f]{24}\.git$/);
	const inCache = (...args: string[]) => execFileSync("git", ["-C", join(cache, repoDir!), ...args], { encoding: "utf8" }).trim();
	assert.deepEqual([inCache("rev-parse", "--is-bare-repository"), inCache("rev-parse", "--is-shallow-repository"), inCache("rev-parse", `refs/forum/${remotes.head}`)], ["true", "true", remotes.head]);
	assert.ok(!existsSync(join(cache, repoDir!, "README.md")) && !existsSync(join(cache, repoDir!, "hooks", "post-checkout")));
	// the reading calls work as on a local repository
	const key = { session: id, blockId: created.body.blockId as string, ts: Date.now() };
	const read = async (n: number) => (await askSources(srv.stack.space, { requestId: `t${n}-${id}`, ...key, op: "call", sourceId: "repo", call: { op: "read", path: "README.md" } })).text!;
	assert.ok((await read(1)).includes("# Demo\nThe world has a resolution of 64."));
	const denied = await askSources(srv.stack.space, { requestId: `t2-${id}`, ...key, op: "call", sourceId: "repo", call: { op: "read", path: ".env" } });
	assert.doesNotMatch(denied.text!, /tracked-secret/);
	// a sources process that lost its cache fetches the task's commit again, and nothing else
	const before = git.requests.length;
	await srv.stack.kill(sources);
	await rm(join(cache, repoDir!), { recursive: true, force: true });
	sources = await srv.stack.sources({ env });
	assert.ok((await read(3)).includes("# Demo"));
	assert.ok(git.requests.length > before);
	assert.equal(execFileSync("git", ["-C", join(cache, repoDir!), "rev-parse", `refs/forum/${remotes.head}`], { encoding: "utf8" }).trim(), remotes.head);
	// once its host is off the list, a lost cache is not filled again
	await srv.stack.kill(sources);
	await rm(join(cache, repoDir!), { recursive: true, force: true });
	await srv.stack.sources({ env: { ...env, FORUM_GIT_HOSTS: bounce.host } });
	await assert.rejects(read(4), /is not allowed for remote repositories/);
});

test("a remote repository that is too large or too slow is refused, and nothing of it stays", async (t) => {
	const remotes = makeRemotes(), git = await gitServer(remotes.root), slow = await gitServer(remotes.root, "stall");
	const cache = mkdtempSync(join(tmpdir(), "forum-git-cache-"));
	process.env.FORUM_ADMIN_PASSWORD = "open sesame";
	const srv = await startServer();
	t.after(async () => { process.env.FORUM_ADMIN_PASSWORD = ""; await srv.close(); await Promise.all([git.close(), slow.close()]); await rm(remotes.root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });
	// 0.1 MB and 2 s instead of 200 MB and 60 s
	await srv.stack.sources({ env: { FORUM_TEST: "1", FORUM_GIT_HOSTS: `${git.host},${slow.host}`, FORUM_GIT_CACHE: cache, FORUM_GIT_MAX_MB: "0.1", FORUM_GIT_TIMEOUT_S: "2" } });
	const id = room("limits");
	await until("the hosts to be offered", async () => (await (await fetch(`${srv.url}/api/sources`, { headers: ADMIN })).json() as { hosts: string[] }).hosts.includes(git.host));
	const big = await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, repo: { url: `http://${git.host}/big.git` } }, ADMIN);
	assert.deepEqual([big.status, big.body.error], [400, "the repository is larger than 0.1 MB"]);
	const started = Date.now();
	const late = await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, repo: { url: `http://${slow.host}/demo.git` } }, ADMIN);
	assert.deepEqual([late.status, late.body.error], [400, "the fetch took longer than 2 s"]);
	assert.ok(Date.now() - started < 15_000 && slow.requests.length > 0);
	assert.deepEqual(readdirSync(cache), []);
	assert.equal((await snapshot(srv.url, id)).blocks.length, 0);
	// the small repository of the same host passes the same limits
	assert.equal((await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, repo: { url: `http://${git.host}/demo.git` } }, ADMIN)).status, 200);
	assert.equal((await snapshot(srv.url, id)).blocks[0]!.sources[0]!.commit, remotes.head);
});
