// `npm run test:durable`: tests/*.test.ts with the durable path on (tests/test-env-durable.ts), without the tests of
// tests/durable-deviations.ts. Further arguments go to node's test runner.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVIATIONS } from "./durable-deviations.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`);
const skip = DEVIATIONS.map((d) => `--test-skip-pattern=^${d.test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
for (const d of DEVIATIONS) console.log(`# skipped: ${d.test}\n#   ${d.reason}`);
const dirname = mkdtempSync(join(tmpdir(), "durable-matrix-")), log = join(dirname, "answers");
const run = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--import", "./tests/test-env-durable.ts", "--test", "--test-concurrency=8", ...skip, ...process.argv.slice(2), ...files], { cwd: root, stdio: "inherit", env: { ...process.env, PHI_DURABLE_FAKE_LOG: log } });
const answers = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
rmSync(dirname, { recursive: true, force: true });
console.log(`# ${answers} model answers through the agent worker's fake bridge`);
process.exit(run.status || (answers ? 0 : 1)); // none: the path was not on, and the green run would prove nothing
