import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { PhiSpaces, FOREVER, Space, openSqliteHost } from "../../src/index.ts";
import { GolombMaster, GolombWorker, GolombRuler } from "../../examples/golomb.ts";
import { openWindow, collect, analyse, present } from "../../examples/sensor-pipeline.ts";
import { spawn } from "node:child_process";
import { openTestHost } from "../support/host.ts";

async function memory() {
  const h = await openTestHost(ctx);
  return { h, s: new PhiSpaces(h, ctx) };
}
const task = { runId: "golomb-4-6", taskId: "golomb-4-task-0", order: 4, maxLength: 6, startPos: 1, endPos: 4, status: "pending" as const };

test("Golomb executes the real search and resumes a completed persistent run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "golomb-recovery-"));
  const open = () => openSqliteHost(join(dir, "space.sqlite"));
  try {
    let h = await open();
    let s = new PhiSpaces(h, ctx);
    await s.write({ type: "GolombTaskDone", fields: { runId: "other", taskId: "old" } }, null, FOREVER);
    const [best] = await Promise.all([new GolombMaster(s, 4, 6, 1).run(), new GolombWorker(s, "w", 4, 6).loop()]);
    assert.ok(best);
    assert.equal(best.length, 6);
    assert.equal(GolombRuler.isValid(best.positions), true);
    assert.equal(await s.count({ type: "GolombTaskDone", fields: { runId: task.runId } }), 1);
    await h.close(ctx);
    h = await open(); s = new PhiSpaces(h, ctx);
    try {
      const resumed = await new GolombMaster(s, 4, 6, 1).run();
      assert.deepEqual(resumed?.positions, best.positions);
      assert.equal(await s.count({ type: "GolombTaskDone", fields: { runId: task.runId } }), 1);
      await assert.rejects(new GolombMaster(s, 4, 6, 2).run(), /configuration changed/);
    } finally { await h.close(ctx); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Golomb failure returns the task and hides uncommitted results", async () => {
  const { h, s } = await memory();
  try {
    await s.write({ type: "GolombSearchTask", fields: task }, null, FOREVER);
    const original = s.write.bind(s);
    s.write = async (entry, txn, lease) => {
      if (entry.type === "GolombTaskDone") throw new Error("injected completion failure");
      return original(entry, txn, lease);
    };
    await assert.rejects(new GolombWorker(s, "w", 4, 6).loop(), /injected/);
    assert.equal(await s.count({ type: "GolombSearchTask" }), 1);
    assert.equal(await s.count({ type: "GolombRuler" }), 0);
    assert.equal(await s.count({ type: "GolombTaskDone" }), 0);
  } finally { await h.close(ctx); }
});

test("Legacy partial checkpoint cannot skip unpersisted solutions", async () => {
  const { h, s } = await memory();
  const dir = mkdtempSync(join(tmpdir(), "golomb-checkpoint-"));
  try {
    const path = join(dir, "cp.json");
    writeFileSync(path, JSON.stringify({ taskId: task.taskId, order: 4, nextA2: 2 }));
    const result = await new GolombWorker(s, "w", 4, 6, path).run(task);
    assert.equal(result.rulers.some(r => r.length === 6 && GolombRuler.isValid(r.positions)), true);
  } finally { await h.close(ctx); rmSync(dir, { recursive: true, force: true }); }
});

test("Killed Golomb process leaves a recoverable reservation in its store", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "golomb-process-crash-"));
  const code = `
    import { BACKGROUND_CONTEXT as ctx } from "./src/context.ts";
    import { PhiSpaces, FOREVER, openSqliteHost } from "./src/index.ts";
    const h=await openSqliteHost(process.argv[1]+"/space.sqlite");
    const s=new PhiSpaces(h,ctx);
    await s.write({type:"GolombSearchTask",fields:${JSON.stringify(task)}},null,FOREVER);
    const txn=await s.createTransaction(120000);
    await s.take({type:"GolombSearchTask"},0,{txn:txn.id});
    await s.write({type:"GolombRuler",fields:{runId:"golomb-4-6",positions:[0,1,4,6]}},txn.id,FOREVER);
    console.log("READY");
    setInterval(()=>{},1000);
  `;
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code, dir], { cwd: process.cwd(), env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", data => { output += String(data); });
  child.stderr.on("data", data => { errors += String(data); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not persist reservation: ${output} ${errors}`)), 4000);
      child.stdout.on("data", data => { if (String(data).includes("READY")) { clearTimeout(timer); resolve(); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`child exited early: ${code}`)); });
    });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
    const h = await openSqliteHost(join(dir, "space.sqlite"));
    const s = new PhiSpaces(h, ctx);
    try {
      assert.equal(await s.count({ type: "GolombSearchTask" }), 0);
      assert.equal(await s.count({ type: "GolombRuler" }), 0);
      const state = await h.snapshot(Space, ctx);
      for (const txn of Object.values(state!.txns)) await s.abort(txn.id);
      assert.equal(await s.count({ type: "GolombSearchTask" }), 1);
      assert.equal(await s.count({ type: "GolombRuler" }), 0);
      const [best] = await Promise.all([new GolombMaster(s, 4, 6, 1).run(), new GolombWorker(s, "recovered", 4, 6).loop()]);
      assert.equal(best?.length, 6);
    } finally { await h.close(ctx); }
  } finally { child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});

test("Sensor validation precedes deduplication and presenter rolls back failures", async () => {
  const { h, s } = await memory();
  try {
    await openWindow(s, "w", ["station"]);
    await collect(s, "station", "w", [{ ts: 0, kind: "temp", value: "bad" }, { ts: 0, kind: "temp", value: 10 }]);
    const summary = await analyse(s);
    assert.equal(summary?.stats.temp.avg, 10);
    assert.equal(summary?.rejected, 1);
    const original = s.write.bind(s);
    s.write = async (entry, txn, lease) => {
      if (entry.type === "Report") throw new Error("injected report failure");
      return original(entry, txn, lease);
    };
    await assert.rejects(present(s), /injected/);
    assert.equal(await s.count({ type: "Summary" }), 1);
    assert.equal(await s.count({ type: "Report" }), 0);
    s.write = original;
    assert.ok(await present(s));
    assert.equal(await s.count({ type: "Summary" }), 0);
    assert.equal(await s.count({ type: "Report" }), 1);
  } finally { await h.close(ctx); }
});

test("Sensor refuses an oversized window instead of publishing a partial summary", async () => {
  const { h, s } = await memory();
  try {
    await openWindow(s, "large", []);
    const count = s.count.bind(s);
    s.count = async (template, txn) => template?.type === "Reading" ? 1001 : count(template, txn);
    await assert.rejects(analyse(s), /1000-reading/);
    assert.equal(await s.count({ type: "Window" }), 1);
    assert.equal(await s.count({ type: "Summary" }), 0);
  } finally { await h.close(ctx); }
});
