// Offline guest workload/verifier. The controlling host must retain acknowledgements outside the guest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ensureDurableDirectory, openDurableJsonlStorage, openDurableSqliteStorage, syncDirectory } from "../src/storage.ts";

const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const mode = process.argv[2], backend = arg("--backend"), profile = arg("--profile"), id = arg("--run-id");
const directory = arg("--dir");
assert.ok(mode === "write" || mode === "verify", "mode: write or verify");
assert.ok(backend === "sqlite" || backend === "jsonl", "--backend sqlite|jsonl is required");
assert.ok(profile === "strong" || profile === "weak", "--profile strong|weak is required");
assert.ok(id && /^[a-zA-Z0-9_-]{8,80}$/.test(id), "provide a fresh --run-id of 8-80 safe characters");
assert.ok(directory, "--dir is required; never use production state");
const dir = resolve(directory), marker = join(dir, ".power-loss-probe.json");
const identity = { version: 1, id, backend, profile };
if (mode === "write") {
  await ensureDurableDirectory(dir);
  assert.equal(readdirSync(dir).length, 0, "write mode refuses any nonempty directory");
  writeFileSync(marker, JSON.stringify(identity), { flag: "wx", flush: true });
  await syncDirectory(dir);
} else {
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), identity, "not this probe's disposable state");
  assert.ok(existsSync(join(dir, backend === "sqlite" ? "agent.sqlite" : "main.jsonl")), "missing store");
}

const State = defineDoc<{ id: string | null; n: number; digest: string }>({
  kind: "phi-spaces.power-loss-probe", version: 1, scope: "session",
  initial: () => ({ id: null, n: 0, digest: "" }), checkpointWhen: () => true,
});
const digest = (n: number) => createHash("sha256").update(`${id}:${n}:${"probe".repeat(1024)}`).digest("hex");
const storage = backend === "sqlite"
  ? profile === "strong" ? await openDurableSqliteStorage(join(dir, "agent.sqlite")) : await openNodeSqliteStorage(join(dir, "agent.sqlite"))
  : profile === "strong" ? await openDurableJsonlStorage(dir, ctx) : await openNodeJsonlStorage(dir, ctx);
const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
if (mode === "verify") {
  const ack = Number(arg("--ack"));
  assert.ok(Number.isSafeInteger(ack) && ack > 0, "--ack must be the highest acknowledgement observed by the controlling host");
  try {
    const value = await harness.snapshot(State, ctx);
    assert.ok(value, "the acknowledged document was lost");
    assert.equal(value.id, id, "the acknowledged run identity was lost");
    assert.ok(value.n >= ack, `lost acknowledged commits: durable=${value.n}, acknowledged=${ack}`);
    assert.equal(value.digest, digest(value.n), "document contents are inconsistent");
    console.log(JSON.stringify({ kind: "verified", id, backend, profile, acknowledged: ack, persisted: value.n }));
  } finally { await harness.close(ctx); }
  if (backend === "sqlite") {
    const db = new DatabaseSync(join(dir, "agent.sqlite"), { readOnly: true });
    try { assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok"); }
    finally { db.close(); }
  }
} else {
  const count = Number(arg("--commits") ?? 100_000);
  assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 1_000_000, "invalid --commits");
  const root = await harness.root(ctx);
  for (let n = 1; n <= count; n++) {
    const start = performance.now();
    await root.commit(async tx => {
      const value = await tx.doc(State);
      value.id = id; value.n = n; value.digest = digest(n);
    }, ctx);
    const line = JSON.stringify({ kind: "ack", id, backend, profile, n, ms: performance.now() - start });
    if (!process.stdout.write(`${line}\n`)) await once(process.stdout, "drain");
  }
  // Do not turn the power-loss scenario into a graceful database close.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}
