import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export function scriptedResearchModels(dark = false, beforeAnswer?: (name: string, text: string) => Promise<void>) {
  const models = createModels();
  const faux = fauxProvider();
  const respond = async (context: any) => {
    const name = /\[agent:([\w-]+)\]/.exec(JSON.stringify(context.messages))?.[1] ?? "unknown";
    const last = context.messages.filter((m: any) => m.role !== "system").at(-1);
    const event = [...context.messages].reverse().find((m: any) => m.role === "user");
    const text = typeof event?.content === "string" ? event.content : "";
    const txn = /transaction ([\w-]+)/.exec(text)?.[1];
    await beforeAnswer?.(name, text);
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
