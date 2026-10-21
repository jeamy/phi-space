// Starts the processes of the codemode chat on this machine, each as its own OS process, and stops them together (the
// local counterpart of the docker services; docs/codemode-space-architektur.md). The space process comes first; the
// others connect to it over CODEMODE_SPACE. A process that ends on its own is started again after a second.
//
//   node --experimental-strip-types server/launch.ts [--dev]
//   CODEMODE_ROLES=space,judge,agents,web   which roles to start here (default all of them)
//   --dev                            every process restarts when its sources change (node --watch-path), web in dev mode
import { ROOT } from "./env.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { DEFAULT_SPACE } from "./space.ts";

const ROLES = { space: "server/space-host.ts", judge: "server/judge-host.ts", agents: "server/agent-host.ts", web: "server/index.ts" } as const;
type Role = keyof typeof ROLES;
const dev = process.argv.includes("--dev");
const wanted = (process.env.CODEMODE_ROLES || Object.keys(ROLES).join(",")).split(",").map((r) => r.trim()).filter(Boolean);
for (const r of wanted) if (!(r in ROLES)) throw new Error(`Unknown role in CODEMODE_ROLES: ${r} (known: ${Object.keys(ROLES).join(", ")})`);
// the others reach the space where it listens (unless CODEMODE_SPACE names another host)
const env = { ...process.env, CODEMODE_SPACE: process.env.CODEMODE_SPACE || process.env.CODEMODE_LISTEN || DEFAULT_SPACE };

const children = new Map<Role, ChildProcess>();
let stopping = false;
const pipe = (role: Role, stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream, onLine?: (l: string) => void) => {
	let rest = "";
	stream?.on("data", (d: Buffer) => {
		const lines = (rest + d.toString("utf8")).split("\n");
		rest = lines.pop() ?? "";
		for (const l of lines) { out.write(`${role.padEnd(6)} | ${l}\n`); onLine?.(l); }
	});
};

function start(role: Role): Promise<void> {
	return new Promise((ready) => {
		const args = [...(dev ? ["--watch-path=server", "--watch-path=../src"] : []), "--no-warnings", "--experimental-strip-types", ROLES[role], ...(dev && role === "web" ? ["--dev"] : [])];
		const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
		children.set(role, child);
		// the space is ready once it says so; the others as soon as they run (they reconnect on their own)
		if (role !== "space") ready();
		pipe(role, child.stdout, process.stdout, (l) => { if (role === "space" && l.startsWith("[space] ready")) ready(); });
		pipe(role, child.stderr, process.stderr);
		child.on("exit", (code, sig) => {
			children.delete(role);
			if (stopping) return;
			console.error(`${role.padEnd(6)} | exited (${sig ?? code}); starting it again`);
			setTimeout(() => { if (!stopping) void start(role); }, 1000);
		});
	});
}

const order = (["space", "judge", "agents", "web"] as Role[]).filter((r) => wanted.includes(r));
for (const role of order) await start(role);
console.log(`[launch] ${order.join(", ")} running${dev ? " (dev)" : ""}; space ${env.CODEMODE_SPACE}`);

const shutdown = () => {
	if (stopping) return;
	stopping = true;
	for (const c of children.values()) c.kill("SIGTERM");
	setTimeout(() => { for (const c of children.values()) c.kill("SIGKILL"); process.exit(0); }, 4000).unref();
	const check = setInterval(() => { if (!children.size) { clearInterval(check); process.exit(0); } }, 100);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
