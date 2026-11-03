// A stand-in for `ssh TARGET COMMAND` (rust/phi-host/tests/recovery_ssh.rs): the provisioned forced commands of the
// recovery tools, answered on this machine for the files of SSH_STAND_IN_DIR. `phi-spaces-register-read` and
// `phi-spaces-register-operator` serve one register call from stdin on `register.sqlite` (the read-only one refuses a
// write), `phi-spaces-recovery` hands the envelope on stdin to the recovery socket `recovery.sock`, and an unknown
// target (one without a `target-<TARGET>` file) fails as a refused login does.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteRecoveryRegister, RegisterConflict } from "../../src/index.ts";
import { socketTransport } from "../../src/socket.ts";

const args = process.argv.slice(2), [target, command] = args.slice(-2) as [string, string], dir = process.env.SSH_STAND_IN_DIR!;
if (!existsSync(join(dir, `target-${target}`))) process.exit(255);
let input = "";
for await (const part of process.stdin) input += part.toString();
if (command === "phi-spaces-recovery") {
	const socket = socketTransport({ path: join(dir, "recovery.sock") });
	try { process.stdout.write(await socket.request(input)); } finally { socket.close(); }
	process.exit(0);
}
if (command !== "phi-spaces-register-read" && command !== "phi-spaces-register-operator") process.exit(1);
const register = new SqliteRecoveryRegister(join(dir, "register.sqlite"));
try {
	const call = JSON.parse(input);
	let result: unknown;
	if (call.method === "get") result = await register.get(call.key);
	else if (call.method === "compareAndSet" && command === "phi-spaces-register-operator") result = await register.compareAndSet(call.key, call.expectedVersion, call.value);
	else throw new Error("this login may only read the register");
	process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (e) {
	process.stdout.write(JSON.stringify({ ok: false, error: { code: e instanceof RegisterConflict ? "RequestConflict" : "Failed", message: (e as Error).message } }));
} finally { register.close(); }
