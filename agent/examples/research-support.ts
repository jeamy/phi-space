// Shared enforcement for the model-driven examples. Prompts alone cannot provide atomicity.
import { mkdirSync, readdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import { Space, type SpaceHost } from "../../src/index.ts";
import { createSpaces, localSpaces } from "../src/agent.ts";
import type { liveModels } from "../src/live-models.ts";

export type ModelBundle = Awaited<ReturnType<typeof liveModels>>;
export type ResearchOptions = {
  topic?: string; dir?: string; out?: string; outJson?: string; query?: string;
  modelBundle?: ModelBundle; pollMs?: number; phaseTimeoutMs?: number; resume?: boolean;
};

/** Fresh-only guard; ResearchRun handles explicitly requested, validated resume. */
export function claimFreshDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length) throw new Error("Research state directory is not empty; use an explicit compatible --resume");
  closeSync(openSync(join(dir, ".research-run"), "wx"));
}

const resultTasks: Record<string, string> = {
  Analysis: "AnalyzeTask", AnalysisResult: "AnalyzeTask", PresentTask: "AnalyzeTask",
  Report: "PresentTask", Presentation: "PresentTask", ClassifiedPaper: "ClassifyTask",
  ClassificationDone: "ClassifyTask", PaperSummary: "SummarizeTask", SummarizationDone: "SummarizeTask",
  QueryResponse: "UserQuery"
};

/** The space tools on `space`, with space_write checked against the research rules. */
export function researchSpaces(space: SpaceHost) {
  const spaces = createSpaces(localSpaces(space));
  return defineExtension({
  ...spaces,
  name: "research-spaces",
  tools: spaces.tools!.map(tool => tool.name !== "space_write" ? tool : {
    ...tool,
    execute: async (args, api, ctx) => {
      const a = args as { type: string; txn?: string; fields: Record<string, any> };
      if (a.type === "PaperSummary" && (a.fields.citationCount !== null || a.fields.basis !== "abstract")) {
        throw new Error("PaperSummary must declare basis=abstract and citationCount=null");
      }
      if (a.type === "AnalysisResult" && a.fields.analysisType === "citationAnalysis" &&
          (a.fields.data?.topCited !== null || a.fields.data?.citationGraph !== null || !a.fields.data?.unavailable)) {
        throw new Error("Citation analysis is unavailable from this data source");
      }
      if (a.type === "AnalysisResult" && a.fields.analysisType === "authorNetwork" &&
          (a.fields.data?.nodes ?? []).some((n: any) => (n.hIndex != null || n.citations != null || n.citationCount != null))) {
        throw new Error("Citation-derived author metrics are unavailable");
      }
      const taskType = resultTasks[a.type];
      if (taskType) {
        if (!a.txn) throw new Error(`${a.type} requires the transaction delivered with ${taskType}`);
        // a replay may occur after the task transaction was committed: the first check holds
        if (!(await api.memo<boolean>("research-checked", ctx))) {
          const state = await space.snapshot(Space, ctx);
          const txn = state?.txns[a.txn];
          if (!state || !txn || txn.owner !== api.conversationId || txn.expires <= Date.now() ||
            !state.entries.some(e => e.type === taskType && e.takenBy === a.txn)) {
            throw new Error("Result transaction must reserve the matching task and belong to this conversation");
          }
          await api.memo("research-checked", true, ctx);
        }
      }
      return tool.execute(args, api, ctx);
    }
  })
  });
}

export const TRANSACTION_RULE = `Für jede Ausgabe nach einem bedienten Take-Wait: übergib bei JEDEM space_write
das Argument txn mit der ID aus der Wait-Meldung, auch für Abschlussmarker und Folgeaufgaben. Erst danach
space_txn commit. Fehlt txn oder gehört sie nicht zur passenden Aufgabe, weist der Host den Write ab.
Nicht verfügbare Fakten bleiben unbekannt; erfinde keine Quellen, Zitationszahlen oder Messungen.`;
