// The fencing service of `run.ts replica|change`: a process of this machine, outside every fenced container, behind mutual TLS. Started with FED_DIR.
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ContainerFencing, execRunner, serveFencing, type CommandRunner } from "../../../src/index.ts";
import { GATEWAY, RPORT, fencedIn } from "./net.ts";

const dir = process.argv[2]!, unitDir = join(dir, "units");
const container = (host: string) => `phi-federation-${host}-1`;

/** docker stays real; systemctl is answered over the container, and `start` obeys the drop-in as ConditionPathExists would, so that no unit of this machine's user is touched. */
const fenceRunner = (unitDir: string): CommandRunner => async (command, args) => {
	if (command !== "systemctl") return execRunner(command, args);
	const [, action, name] = args, host = name?.replace(/^phi-federation-|\.service$/g, "");
	if (action === "daemon-reload") return { code: 0, stdout: "", stderr: "" };
	if (action === "is-active") { const r = await execRunner("docker", ["inspect", "--format", "{{.State.Running}}", container(host!)]); return { code: 0, stdout: r.stdout.trim() === "true" ? "active\n" : "inactive\n", stderr: "" }; }
	if (action === "stop") return execRunner("docker", ["stop", "--time", "30", container(host!)]);
	if (action === "start") return existsSync(join(unitDir, `${name}.d`, "zz-phi-spaces-fenced.conf")) ? { code: 1, stdout: "", stderr: "unit is fenced" } : execRunner("docker", ["start", container(host!)]);
	return { code: 1, stdout: "", stderr: `unexpected systemctl ${action}` };
};

mkdirSync(unitDir);
const pins = Object.fromEntries(Object.entries(await fencedIn(dir)).map(([host, service]) => [host, { container: container(service), unit: `phi-federation-${service}.service` }]));
const operator = createHash("sha256").update(new X509Certificate(readFileSync(join(dir, "operator.crt"))).raw).digest("hex");
await serveFencing(new ContainerFencing({ pins, unitDir, stateFile: join(dir, "fence-state.json"), run: fenceRunner(unitDir) }), { caFile: `${dir}/ca.crt`, certFile: `${dir}/fencing.crt`, keyFile: `${dir}/fencing.key`, host: GATEWAY, port: RPORT.fencing, peers: { [operator]: { operator: true } } });
console.log("ready");
