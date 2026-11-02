// `phi-spaces-fence-status` behind sshd in `fence-ssh` (src/fencing.ts): the login names the fenced host, docker says whether its container runs, and the
// fencing service's restart policy and drop-in say whether it is locked. Bound to the login by ForceCommand; nothing a caller sends selects anything.
import { existsSync } from "node:fs";
import { request } from "node:http";
import { FENCED } from "./net.ts";

// the login sshd set, not the name of its uid: every login shares the uid that may read FED_DIR
const hostId = process.env.USER ?? "", service = FENCED[hostId];
if (process.env.SSH_ORIGINAL_COMMAND !== "phi-spaces-fence-status" || !service) { console.error("only phi-spaces-fence-status of a pinned host"); process.exit(1); }
const state = await new Promise<{ State: { Running: boolean }; HostConfig: { RestartPolicy: { Name: string } } }>((resolve, reject) => {
	request({ socketPath: "/var/run/docker.sock", path: `/containers/phi-federation-${service}-1/json` }, (res) => { let body = ""; res.on("data", (d) => body += d); res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`docker ${res.statusCode}`))); }).on("error", reject).end();
});
const locked = state.HostConfig.RestartPolicy.Name === "no" && existsSync(`/fed/units/phi-federation-${service}.service.d/zz-phi-spaces-fenced.conf`);
console.log(JSON.stringify({ hostId, stopped: !state.State.Running, restartLocked: locked }));
