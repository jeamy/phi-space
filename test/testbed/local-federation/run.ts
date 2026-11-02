// `npm run testbed:federation [-- rust|ts|both]`: the local federation in containers, with a Member killed, the control host and the
// register cut off and the host fenced, and what each pairing of control host and Member answered held against the others. Changes containers on this machine.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { core, snapshotSpace } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";
import { provision } from "./provision.ts";
import { IP } from "./net.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COMPOSE = join(ROOT, "test/testbed/local-federation/compose.yml"), NET = "phi-federation_fed";
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => execFileSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function scenario(impl: string, control: string) {
	const dir = mkdtempSync(join(tmpdir(), "phi-fed-"));
	const env = { FED_DIR: dir, FED_UID: String(process.getuid!()), FED_GID: String(process.getgid!()), MEMBER_IMPL: impl, CONTROL_IMPL: control };
	const compose = (...a: string[]) => sh("docker", ["compose", "-f", COMPOSE, ...a], env);
	const seen: string[] = [];
	const step = (name: string, service = "client") => { const out = compose("exec", "-T", service, "node", "--experimental-strip-types", "--no-warnings", "test/testbed/local-federation/driver.ts", name).trim().split("\n").at(-1)!; console.log(`  ${control}/${impl} ${out}`); seen.push(out); };
	const cut = (service: string) => sh("docker", ["network", "disconnect", NET, `phi-federation-${service}-1`]);
	const heal = (service: string) => sh("docker", ["network", "connect", "--ip", (IP as Record<string, string>)[service]!, NET, `phi-federation-${service}-1`]);
	try {
		await provision(dir);
		compose("up", "-d", "--no-build");
		step("ready"); step("routerReady", "router"); step("setup", "router");
		// the Root on the control host: a Member gone and back, the Root killed, its journal handed to the other server and back
		step("rootFirst", "control");
		sh("docker", ["kill", "-s", "KILL", "phi-federation-member-1"]);
		step("rootMemberDown", "control");
		sh("docker", ["start", "phi-federation-member-1"]);
		step("rootMemberBack", "control");
		sh("docker", ["kill", "-s", "KILL", "phi-federation-control-1"]);
		sh("docker", ["start", "phi-federation-control-1"]);
		step("rootAfterKill", "control");
		const other = control === "rust" ? "ts" : "rust", swap = (impl: string) => sh("docker", ["compose", "-f", COMPOSE, "up", "-d", "--no-build", "--no-deps", "--force-recreate", "control"], { ...env, CONTROL_IMPL: impl });
		swap(other); step("rootHandedOver", "control"); swap(control); step("rootAfterKill2", "control");
		step("prepare", "router"); step("work"); step("pause", "router"); step("waiting");
		sh("docker", ["kill", "-s", "KILL", "phi-federation-member-1"]);
		sh("docker", ["start", "phi-federation-member-1"]);
		step("afterKillRouter", "router"); step("afterKill");
		step("grant"); cut("control"); step("broken"); heal("control"); step("healed");
		step("grant"); cut("register"); step("broken"); heal("register"); step("healed");
		step("fence");
		step("finish", "router");
		return seen;
	} catch (e) {
		console.error((e as { stderr?: string }).stderr ?? e);
		for (const s of ["member", "control"]) console.error(compose("logs", "--tail", "12", s));
		process.exitCode = 1;
		throw new Error(`the scenario of ${control}/${impl} failed`);
	} finally {
		compose("down", "-v", "--remove-orphans");
		rmSync(dir, { recursive: true, force: true });
	}
}

/** `phone PHONE-IP BIND-IP [rust|ts]`: stays up for a real device on the LAN, which pairs at the control host and works on the Member. */
async function phone(ip: string, bind: string, impl: string) {
	const dir = mkdtempSync(join(tmpdir(), "phi-fed-"));
	const env = { FED_DIR: dir, FED_UID: String(process.getuid!()), FED_GID: String(process.getgid!()), MEMBER_IMPL: impl, CONTROL_IMPL: "ts", FED_PHONE_BIND: bind };
	const compose = (...a: string[]) => sh("docker", ["compose", "-f", COMPOSE, ...a], env);
	const done = () => { compose("down", "-v", "--remove-orphans"); rmSync(dir, { recursive: true, force: true }); process.exit(0); };
	process.on("SIGINT", done); process.on("SIGTERM", done);
	const p = await provision(dir, { ip });
	compose("up", "-d", "--no-build");
	compose("exec", "-T", "client", "node", "--experimental-strip-types", "--no-warnings", "test/testbed/local-federation/driver.ts", "ready");
	console.log(JSON.stringify({ pairing: { peerId: "phone", controlHostId: "control-host", endpoint: `tcp://${bind}:7431`, controlSpaceId: p.controlSpace, token: p.token }, data: { hostId: "data-host", endpoint: `tcp://${bind}:7432`, space: p.jobs }, member: impl, dir }));
	// the admin's step of a pairing: the paired peer changes its group; the gates see it within their directory's minute
	for (let paired = false; !paired;) {
		await new Promise((r) => setTimeout(r, 3000));
		const copy = mkdtempSync(join(tmpdir(), "phi-fed-copy-"));
		for (const f of readdirSync(dir).filter((n) => n.startsWith("control.sqlite"))) copyFileSync(join(dir, f), join(copy, f));
		const host = await openSqliteHost(join(copy, "control.sqlite"));
		paired = core.list((await snapshotSpace(host, p.controlSpace, ctx))!, Date.now(), { type: "PeerKey", fields: { peerId: "phone" } }).length > 0;
		await host.close(ctx);
		rmSync(copy, { recursive: true, force: true });
	}
	const peers = JSON.parse(readFileSync(join(dir, "peers.json"), "utf8")) as Array<{ id: string; groups: unknown[] }>;
	peers.find((x) => x.id === "phone")!.groups = [{ id: "g-space-hosts", name: "space-hosts" }];
	writeFileSync(join(dir, "peers.json"), JSON.stringify(peers), { mode: 0o600 });
	console.log(JSON.stringify({ paired: true }));
	await new Promise(() => {});
}

const which = process.argv[2] ?? "both";
sh("docker", ["build", "--network", "host", "-f", "test/testbed/local-federation/Dockerfile", "-t", "phi-federation:local", "."]);
if (which === "phone") await phone(process.argv[3]!, process.argv[4]!, process.argv[5] ?? "rust");
if (which === "control-restore") { await (await import("./control-restore.ts")).controlRestoreScenario(); process.exit(process.exitCode ?? 0); }
if (which === "restore") { await (await import("./restore.ts")).restoreScenario(); process.exit(process.exitCode ?? 0); }
if (which === "change") { await (await import("./change.ts")).changeScenario(); process.exit(process.exitCode ?? 0); }
if (which === "entry") { await (await import("./entry.ts")).entryScenario(); process.exit(process.exitCode ?? 0); }
if (which === "replica") { await (await import("./replica.ts")).replicaScenario(); process.exit(process.exitCode ?? 0); }
const runs = which === "both" ? [["ts", "ts"], ["ts", "rust"], ["rust", "ts"], ["rust", "rust"]] : [["ts", which]];
const results = [];
for (const [control, member] of runs) results.push(await scenario(member!, control!));
for (const r of results.slice(1)) assert.deepEqual(r, results[0], "every pairing answers alike");
if (results.length > 1) console.log("every pairing of control host and Member answered alike");
