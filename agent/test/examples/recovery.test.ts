// The model-driven examples (research runners, chat) under failure: scripted models, the space on its own store.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openOwnMemoryHost } from "../../../src/index.ts";
import { runArxivResearch } from "../../examples/arxiv-research.ts";
import { runDarkEnergyResearch } from "../../examples/dark-energy-research.ts";
import { researchSpaces, claimFreshDirectory } from "../../examples/research-support.ts";
import { parseFeed } from "../../examples/arxiv-tool.ts";
import { runChat } from "../../examples/chat.ts";

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
