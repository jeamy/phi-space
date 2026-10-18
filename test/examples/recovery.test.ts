import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PhiSpaces, FOREVER, Space } from "../../src/index.ts";
import { GolombMaster, GolombWorker, GolombRuler } from "../../examples/golomb.ts";
import { openWindow, collect, analyse, present } from "../../examples/sensor-pipeline.ts";
import { runArxivResearch } from "../../examples/arxiv-research.ts";
import { runDarkEnergyResearch } from "../../examples/dark-energy-research.ts";
import { researchSpaces, claimFreshDirectory } from "../../examples/research-support.ts";
import { parseFeed } from "../../examples/arxiv-tool.ts";
import { runChat } from "../../examples/chat.ts";
import { spawn } from "node:child_process";

async function memory() {
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
  return { h, s: new PhiSpaces(h, ctx) };
}
const task = { runId: "golomb-4-6", taskId: "golomb-4-task-0", order: 4, maxLength: 6, startPos: 1, endPos: 4, status: "pending" as const };

test("Golomb executes the real search and resumes a completed persistent run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "golomb-recovery-"));
  const open = async () => Harness.open(await openNodeJsonlStorage(dir, ctx), { models: createModels(), registry: createRegistry() }, ctx);
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

test("Killed Golomb process leaves a recoverable reservation on JSONL", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "golomb-process-crash-"));
  const code = `
    import { createRegistry, Harness } from "@earendil-works/pi-durable";
    import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
    import { createModels } from "@earendil-works/pi-ai/models";
    import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
    import { PhiSpaces, FOREVER } from "./src/index.ts";
    const h=await Harness.open(await openNodeJsonlStorage(process.argv[1],ctx),{models:createModels(),registry:createRegistry()},ctx);
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
    const h = await Harness.open(await openNodeJsonlStorage(dir, ctx), { models: createModels(), registry: createRegistry() }, ctx);
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

test("arXiv parser preserves date, full author list and full abstract", () => {
  const abstract = "A".repeat(700);
  const xml = `<feed><entry><id>http://arxiv.org/abs/1706.03762v2</id><title>Test</title><published>2017-06-12T00:00:00Z</published><summary>${abstract}</summary>${["A", "B", "C", "D"].map(n => `<author><name>${n}</name></author>`).join("")}<category term="cs.CL"/><arxiv:primary_category term="cs.CL"/></entry></feed>`;
  const [paper] = parseFeed(xml);
  assert.equal(paper.abstract, abstract);
  assert.deepEqual(paper.authorNames, ["A", "B", "C", "D"]);
  assert.equal(paper.published, "2017-06-12T00:00:00Z");
  assert.deepEqual(paper.categories, ["cs.CL"]);
});

function scriptedModels(dark = false) {
  const models = createModels();
  const faux = fauxProvider();
  const respond = (context: any) => {
    const name = /\[agent:([\w-]+)\]/.exec(JSON.stringify(context.messages))?.[1] ?? "unknown";
    const last = context.messages.filter((m: any) => m.role !== "system").at(-1);
    const event = [...context.messages].reverse().find((m: any) => m.role === "user");
    const text = typeof event?.content === "string" ? event.content : "";
    const txn = /transaction ([\w-]+)/.exec(text)?.[1];
    if (last?.role === "toolResult") {
      if (last.toolName === "space_write" && txn) return fauxAssistantMessage(fauxToolCall("space_txn", { action: "commit", txn }), { stopReason: "toolUse" });
      return fauxAssistantMessage("done");
    }
    const write = (type: string, fields: any) => fauxToolCall("space_write", { type, fields, ttlMs: "forever", ...(txn ? { txn } : {}) });
    if (text.includes("Beginne")) {
      if (name.startsWith("collector")) return fauxAssistantMessage([write("Paper", { arxivId: name, title: "Scripted fixture" }), write("CollectorDone", { collector: name, papers: 1 })], { stopReason: "toolUse" });
      if (name === "crawler") return fauxAssistantMessage([write("PaperMetadata", { arxivId: "fixture", abstract: "Scripted abstract", authorNames: ["A"], year: 2020, published: "2020-01-01" }), write("CrawlDone", { papersFound: 1 })], { stopReason: "toolUse" });
      const types: Record<string, string> = { analyst: "AnalyzeTask", presenter: "PresentTask", classifier: "ClassifyTask", summarizer: "SummarizeTask", chat: "UserQuery" };
      return fauxAssistantMessage(fauxToolCall("space_wait", { type: types[name] }), { stopReason: "toolUse" });
    }
    if (txn) {
      const calls = name === "analyst" ? [write("Analysis", { order: 99, summary: "Scripted analysis; no scientific claims" }), ...(!dark ? [write("PresentTask", { topic: "test" })] : [])]
        : name === "classifier" ? [write("ClassifiedPaper", { paperId: "fixture", relevance: "high" }), write("ClassificationDone", {})]
        : name === "presenter" ? [dark ? write("Presentation", { title: "test", markdown: "# Scripted report", dashboardData: { citations: null } }) : write("Report", { title: "test", markdown: "# Scripted report" })]
        : name === "chat" ? [write("QueryResponse", { queryId: "q1", response: "No source papers", sources: [] })]
        : [write("PaperSummary", { paperId: "fixture", citationCount: null, basis: "abstract", summary: "Scripted summary" }), write("SummarizationDone", {})];
      return fauxAssistantMessage(calls, { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("done");
  };
  faux.setResponses(Array.from({ length: 300 }, () => respond));
  models.setProvider(faux.provider);
  return { models, model: { provider: "faux", modelId: "faux-1" } };
}

test("Real research runners produce committed reports with scripted models", { timeout: 15_000 }, async () => {
  for (const run of [runArxivResearch, runDarkEnergyResearch]) {
    const dir = mkdtempSync(join(tmpdir(), "research-runner-"));
    try {
      await run({ dir, topic: "test", modelBundle: scriptedModels(run === runDarkEnergyResearch), pollMs: 20, phaseTimeoutMs: 2000 });
      assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "# Scripted report");
      await assert.rejects(run({ dir, modelBundle: scriptedModels() }), /not empty/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("Research result enforcement refuses a missing transaction", async () => {
  const tool = researchSpaces.tools!.find(t => t.name === "space_write")!;
  await assert.rejects(tool.execute({ type: "Report", fields: { markdown: "bad" } }, {} as any, ctx), /requires the transaction/);
  await assert.rejects(tool.execute({ type: "PaperSummary", fields: { citationCount: 100, basis: "abstract" } }, {} as any, ctx), /citationCount=null/);
  const dir = mkdtempSync(join(tmpdir(), "research-directory-"));
  try { claimFreshDirectory(dir); assert.throws(() => claimFreshDirectory(dir), /not empty/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Research timeouts fail instead of reporting successful incomplete work", { timeout: 5000 }, async () => {
  const models = createModels(); const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("done without completion")));
  models.setProvider(faux.provider);
  const dir = mkdtempSync(join(tmpdir(), "research-timeout-"));
  try {
    await assert.rejects(runDarkEnergyResearch({ dir, modelBundle: { models, model: { provider: "faux", modelId: "faux-1" } }, pollMs: 10, phaseTimeoutMs: 100 }), /Crawling timed out/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Actual scripted chat finishes its bounded ring", { timeout: 5000 }, async () => {
  const messages = await runChat({ maxTurns: 3, timeoutMs: 2000, topic: "test" });
  assert.deepEqual(messages.map(m => m.n).sort((a, b) => a - b), [0, 1, 2, 3]);
});
