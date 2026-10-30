// The model-driven examples (research runners, chat) under failure: scripted models, the space on its own store.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openOwnMemoryHost } from "../../../src/index.ts";
import { runArxivResearch } from "../../examples/arxiv-research.ts";
import { runDarkEnergyResearch } from "../../examples/dark-energy-research.ts";
import { researchSpaces, claimFreshDirectory } from "../../examples/research-support.ts";
import { parseFeed } from "../../examples/arxiv-tool.ts";
import { runChat } from "../../examples/chat.ts";
import { ResearchRun } from "../../examples/research-run.ts";
import { scriptedResearchModels as scriptedModels } from "./utils/research-models.ts";

test("arXiv parser preserves date, full author list and full abstract", () => {
  const abstract = "A".repeat(700);
  const xml = `<feed><entry><id>http://arxiv.org/abs/1706.03762v2</id><title>Test</title><published>2017-06-12T00:00:00Z</published><summary>${abstract}</summary>${["A", "B", "C", "D"].map(n => `<author><name>${n}</name></author>`).join("")}<category term="cs.CL"/><arxiv:primary_category term="cs.CL"/></entry></feed>`;
  const [paper] = parseFeed(xml);
  assert.equal(paper.abstract, abstract);
  assert.deepEqual(paper.authorNames, ["A", "B", "C", "D"]);
  assert.equal(paper.published, "2017-06-12T00:00:00Z");
  assert.deepEqual(paper.categories, ["cs.CL"]);
});

test("SIGKILL during analysis resumes the same research team and finishes its report", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-crash-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./research-child.ts", import.meta.url)), dir], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, "ready"))) {
      assert.equal(child.exitCode, null, output);
      assert.ok(Date.now() < deadline, output);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await runArxivResearch({ dir, resume: true, modelBundle: scriptedModels(), pollMs: 20, phaseTimeoutMs: 3000 });
    assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "# Scripted report");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Real research runners produce committed reports with scripted models", { timeout: 15_000 }, async () => {
  for (const run of [runArxivResearch, runDarkEnergyResearch]) {
    const dir = mkdtempSync(join(tmpdir(), "research-runner-"));
    try {
      await run({ dir, topic: "test", modelBundle: scriptedModels(run === runDarkEnergyResearch), pollMs: 20, phaseTimeoutMs: 2000 });
      assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "# Scripted report");
      await assert.rejects(run({ dir, modelBundle: scriptedModels() }), /not empty/);
      writeFileSync(join(dir, "report.md"), "interrupted export");
      const bundle = scriptedModels(run === runDarkEnergyResearch);
      await run({ dir, resume: true, modelBundle: bundle, pollMs: 10, phaseTimeoutMs: 1000 });
      assert.equal(readFileSync(join(dir, "report.md"), "utf8"), "# Scripted report");
      await assert.rejects(run({ dir, resume: true, topic: "different", modelBundle: bundle }), /conflicts/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("research resume reuses team IDs and never recreates a phase task after it was consumed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-resume-"));
  const bundle = scriptedModels();
  let run: ResearchRun | undefined;
  try {
    run = await ResearchRun.open("test", "topic", { dir });
    const model = await run.connect([], { modelBundle: bundle });
    const agent = await run.agent("analyst", { model });
    const id = agent.id;
    // The Space commit succeeded, but the process did not checkpoint its phase in the agent store.
    const txn = await run.host.createTransaction(10_000);
    await run.host.write({ type: "ResearchPhase", fields: { runId: run.manifest.runId, phase: "analysis" } }, txn.id, Infinity);
    await run.host.write({ type: "AnalyzeTask", fields: { topic: "topic" } }, txn.id, Infinity);
    await run.host.commit(txn.id);
    await run.host.take({ type: "AnalyzeTask" }, 0);
    await run.close(); run = undefined;
    run = await ResearchRun.open("test", "ignored default", { dir, resume: true });
    await run.connect([], { modelBundle: bundle });
    assert.equal((await run.agent("analyst", { model })).id, id);
    await run.trigger("analysis", { type: "AnalyzeTask", fields: { topic: "topic" } });
    assert.equal(await run.host.count({ type: "AnalyzeTask" }), 0);
    assert.equal((await run.status())?.phase, "analysis");
    assert.deepEqual(Object.keys((await run.status())!.agents), ["analyst"]);
  } finally { await run?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("research resume refuses unknown directories, conflicting kinds and concurrent owners", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-ownership-"));
  let run: ResearchRun | undefined;
  try {
    await assert.rejects(ResearchRun.open("test", "topic", { dir, resume: true }), /No compatible/);
    run = await ResearchRun.open("test", "topic", { dir });
    await assert.rejects(ResearchRun.open("other", "topic", { dir, resume: true }), /Incompatible/);
    await assert.rejects(ResearchRun.open("test", "topic", { dir, resume: true }), /locked|owner|busy/i);
  } finally { await run?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Research result enforcement refuses a missing transaction", async () => {
  const tool = researchSpaces(openOwnMemoryHost()).tools!.find(t => t.name === "space_write")!;
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
