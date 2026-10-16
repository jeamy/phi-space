// Deployment bootstrap CLI (docs/betrieb-und-mobile-steuerung.md §4, §8 B8).
//   --check  --config deployment.json                              offline validation, prints the config hash
//   --plan | --apply | --start-workers | --export  --config deployment.json  <admin connection>
//   --bind <hostAlias>=<hostId>                                     <admin connection>
// Admin connection: --coordinator host:port --gate-host <hostId> --peer <ownPeerId> --key <keyFile> [--local-address ip]
// Every remote mode writes one admin Command into the control Space and waits for its Result; the coordinator's
// supervisor applies it. SSH or the host role alone never authorize these commands.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CONTROL_SPACE, RemoteSpace, loadFileSigner, socketTransport, validateDeployment } from "../src/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
const modes = ["--check", "--plan", "--apply", "--start-workers", "--export", "--bind"].filter(flag);
if (modes.length !== 1) { process.stderr.write("choose exactly one of --check --plan --apply --start-workers --export --bind\n"); process.exit(64); }
const mode = modes[0]!;

let config: unknown, configHash: string | undefined;
if (mode !== "--bind") {
	const file = value("--config");
	if (!file) { process.stderr.write("--config <file> required\n"); process.exit(64); }
	config = JSON.parse(readFileSync(file, "utf8"));
	const v = validateDeployment(config);
	if (!v.config) { print({ valid: false, errors: v.errors }); process.exit(1); }
	configHash = v.configHash;
	if (mode === "--check") { print({ valid: true, deployment: v.config.deployment, configHash, hosts: v.config.hosts.length, spaces: v.config.spaces.length, workers: v.config.workers?.length ?? 0 }); process.exit(0); }
}

const target = value("--coordinator"), gateHost = value("--gate-host"), peer = value("--peer"), keyFile = value("--key");
if (!target || !gateHost || !peer || !keyFile) { process.stderr.write("remote modes need --coordinator host:port --gate-host --peer --key\n"); process.exit(64); }
const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
const transport = socketTransport({ host, port }, { ...(value("--local-address") ? { localAddress: value("--local-address") } : {}), connectTimeoutMs: 5000 });
try {
	const admin = new RemoteSpace(transport, { space: CONTROL_SPACE, signer: loadFileSigner(keyFile), ownPeerId: peer, expectedGateHostId: gateHost, attempts: 3, callTimeoutMs: 30_000 });
	await admin.authenticate();
	const deployment = (config as { deployment?: string } | undefined)?.deployment;
	const [kind, args]: [string, Record<string, unknown>] =
		mode === "--plan" ? ["planDeployment", { config }]
		: mode === "--apply" ? ["applyDeployment", { config }]
		: mode === "--start-workers" ? ["startWorkers", { deployment }]
		: mode === "--export" ? ["exportDeployment", { deployment }]
		: ["bindHostAlias", (() => { const [alias, hostId] = String(value("--bind")).split("="); return { alias, hostId }; })()];
	// A fresh command ID per invocation: the coordinator's job is idempotent per deployment and config hash.
	const commandId = `${kind}-${(configHash ?? "bind").slice(0, 12)}-${randomBytes(6).toString("hex")}`;
	await admin.write({ type: "Command", fields: { commandId, kind, args } as any }, null, 3_600_000);
	const deadline = Date.now() + Number(value("--wait-ms") ?? 120_000);
	for (;;) {
		const found = await admin.readAll({ type: "Result", fields: { commandId } });
		if (found.length) {
			const r = found[0]!.fields as any, result = r.result;
			print({ commandId, kind, state: r.state, ...(r.error ? { error: r.error } : {}), result });
			const failed = r.state !== "completed" || result?.phase === "failed" || result?.state === "blocked" || (kind === "planDeployment" && result?.ready === false);
			process.exitCode = failed ? 2 : 0;
			break;
		}
		if (Date.now() > deadline) { print({ commandId, kind, state: "pending", note: "no result yet; the coordinator keeps the command, check again with --export" }); process.exitCode = 3; break; }
		await new Promise(r => setTimeout(r, 500));
	}
} finally { transport.close(); }
