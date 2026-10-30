// Default multi-step contribution backend. The Space queue and final judge remain authoritative.
import { dirname, join, resolve } from "node:path";
import { DurableAgentClient } from "../../agent/src/durable-client.ts";
import type { AgentUsage } from "../../agent/src/durable-protocol.ts";
import { ROOT } from "./env.ts";
import { extractCode, teamPrompt, type llmContribution } from "./llm.ts";
import { judge, loadCodemode, verdictFields } from "./judge.ts";
import type { LlmCall } from "./context.ts";
import type { Task } from "./tasks.ts";

type Controls = {
  model: (call: LlmCall, requested?: string) => Promise<string>;
  permit: (call: LlmCall, model: string, usage: AgentUsage, signal: AbortSignal) => Promise<void>;
};

export class DurableContributions {
  private readonly client: DurableAgentClient;
  private readonly controls: Controls;

  constructor(store: string, controls: Controls, modelsModule?: string) {
    this.client = new DurableAgentClient(store, { modelsModule, maxTokens: 1500 });
    this.controls = controls;
  }

  async contribute(call: LlmCall, context: Parameters<typeof llmContribution>[0], signal: AbortSignal) {
    const prompt = teamPrompt(context);
    const model = await this.controls.model(call, context.model);
    const answer = await this.client.run({
      session: `code:${call.session}:${call.callId}`, requestId: call.callId, model,
      system: `${prompt.system}\n[durable-code] You can use verify_code to test your function in an isolated sandbox. Check and repair it before the final answer.`,
      prompt: prompt.user, mode: "code", maxRequests: 4, maxTokens: 1500,
      metadata: { task: context.task }, resumeExisting: true,
    }, {
      permit: async (request, usage) => this.controls.permit(call, request.model, usage, signal),
      verify: async (source, metadata) => {
        signal.throwIfAborted();
        const cm = await loadCodemode();
        if (!cm) throw new Error("The verification sandbox is unavailable");
        return verdictFields(await judge(cm, metadata.task as Task, source));
      },
    }, signal);
    return { source: extractCode(answer.text), model: answer.model, usage: answer.usage };
  }

  close() { return this.client.close(); }
}

export function durableContributionOptions(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (["0", "false", "off"].includes((env.CODEMODE_DURABLE_AGENT ?? "").trim().toLowerCase())) return null;
  if (env.CODEMODE_TEST !== "1" && !["1", "true", "on"].includes((env.CODEMODE_CHAT_LLM ?? "").toLowerCase())) return null;
  const module = env.CODEMODE_DURABLE_MODELS_MODULE;
  if (env.CODEMODE_TEST === "1" && !module) return null;
  if (module && env.CODEMODE_TEST !== "1") throw new Error("Durable model fixtures require CODEMODE_TEST=1");
  const sqlite = env.CODEMODE_SQLITE?.trim();
  return {
    store: resolve(ROOT, env.CODEMODE_DURABLE_STORE?.trim() || join(sqlite ? dirname(sqlite) : ".local", "codemode-agent.sqlite")),
    modelsModule: module ? resolve(ROOT, module) : undefined,
  };
}

export function openDurableContributions(controls: Controls): DurableContributions | null {
  const options = durableContributionOptions();
  return options ? new DurableContributions(options.store, controls, options.modelsModule) : null;
}
