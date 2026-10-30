// These are process-crash self-tests of the VM probe, not physical power-cut tests.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./power-loss-probe.ts", import.meta.url));
for (const backend of ["sqlite", "jsonl"]) {
  test(`the ${backend} guest probe acknowledges commits, survives process kill and refuses unrelated state`, { timeout: 25_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-power-probe-")), id = randomUUID();
    const args = ["--dir", dir, "--backend", backend, "--profile", "strong", "--run-id", id];
    const child = spawn(process.execPath, ["--experimental-strip-types", probe, "write", ...args, "--commits", "20"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", killed = false;
    const ended = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
    child.stderr.on("data", chunk => { errors += chunk; });
    child.stdout.on("data", chunk => {
      output += chunk;
      if (!killed && output.split("\n").some(line => { try { return JSON.parse(line).n >= 5; } catch { return false; } })) {
        killed = true; child.kill("SIGKILL");
      }
    });
    try {
      await ended;
      clearTimeout(timer);
      const acknowledged = output.trim().split("\n").map(line => JSON.parse(line)).filter(line => line.kind === "ack");
      assert.ok(acknowledged.length >= 5, errors);
      const ack = Math.max(...acknowledged.map(line => Number(line.n)));
      const verify = spawnSync(process.execPath, ["--experimental-strip-types", probe, "verify", ...args, "--ack", String(ack)], { encoding: "utf8", timeout: 10_000 });
      assert.equal(verify.status, 0, verify.stderr);
      assert.ok(JSON.parse(verify.stdout).persisted >= ack);
      const overwrite = spawnSync(process.execPath, ["--experimental-strip-types", probe, "write", ...args], { encoding: "utf8", timeout: 10_000 });
      assert.notEqual(overwrite.status, 0);
      assert.match(overwrite.stderr, /nonempty directory/);
      const wrong = spawnSync(process.execPath, ["--experimental-strip-types", probe, "verify", ...args.map(value => value === id ? "unrelated-run" : value), "--ack", String(ack)], { encoding: "utf8", timeout: 10_000 });
      assert.notEqual(wrong.status, 0);
      assert.match(wrong.stderr, /disposable state/);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await ended; }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
