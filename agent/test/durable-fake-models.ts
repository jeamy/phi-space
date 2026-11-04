// The models of the matrices with the durable path on (`npm run test:durable` of codemode-chat and spaces-mmo): the
// worker's models answer with the project's own test fake, so its scenarios run through the real worker, conversation
// and storage. PHI_DURABLE_FAKE_ANSWERS names the project's adapter, loaded at run time so that neither side imports the
// other: `modelLabels()` the provider/id labels to know, `answer(request)` what the fake says. Nothing here calls a model.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; costUsd: number };
type Reply = { text: string; usage?: Usage };
type Adapter = {
  modelLabels: () => string[];
  answer: (request: { system: string; user: string; model: string; signal?: AbortSignal }) => Promise<Reply>;
};

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("") : "";
const usageOf = (u?: Usage): AssistantMessage["usage"] => ({
  input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0, totalTokens: u?.total ?? 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u?.costUsd ?? 0 },
});

export async function modelBundle() {
  const path = process.env.PHI_DURABLE_FAKE_ANSWERS;
  if (!path) throw new Error("PHI_DURABLE_FAKE_ANSWERS names no adapter");
  const adapter = await import(pathToFileURL(path).href) as Adapter;
  const models = createModels(), byProvider = new Map<string, string[]>();
  for (const label of new Set(adapter.modelLabels())) {
    const split = label.indexOf("/"), provider = label.slice(0, split);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), label.slice(split + 1)]);
  }
  // the faux provider streams, but replaces a message's usage by an estimate: the fake's exact usage goes on afterwards
  const prepared = new AsyncLocalStorage<AssistantMessage>();
  for (const [provider, ids] of byProvider) {
    const faux = fauxProvider({ provider, models: ids.map(id => ({ id })) });
    faux.setResponses(Array.from({ length: 5000 }, () => () => prepared.getStore()!));
    models.setProvider(faux.provider);
  }
  const observed = new Proxy(models, {
    get(target, key) {
      if (key !== "streamSimple") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...[model, context, options]: Parameters<Models["streamSimple"]>) => {
        const output = createAssistantMessageEventStream();
        void (async () => {
          const system = context.messages.filter(m => m.role === "system").map(getSystemMessageText).join("\n");
          const user = textOf(context.messages.filter(m => m.role === "user").at(-1)?.content);
          let message: AssistantMessage;
          try {
            const reply = await adapter.answer({ system, user, model: `${model.provider}/${model.id}`, ...(options?.signal ? { signal: options.signal } : {}) });
            message = { ...fauxAssistantMessage(reply.text), usage: usageOf(reply.usage) };
          } catch (error) {
            const paid = (error as { usage?: Usage }).usage;
            message = { ...fauxAssistantMessage([], { stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: (error as Error).message }), usage: usageOf(paid) };
          }
          // the runner's proof that the scenarios came through a worker and not past it
          if (process.env.PHI_DURABLE_FAKE_LOG) appendFileSync(process.env.PHI_DURABLE_FAKE_LOG, `${message.stopReason}\n`);
          const exact = message.usage;
          const stream = prepared.run(message, () => target.streamSimple(model, context, options));
          for await (const event of stream) {
            if (event.type === "done") output.push({ ...event, message: { ...event.message, usage: exact } });
            else if (event.type === "error") output.push({ ...event, error: { ...event.error, usage: exact } });
            else output.push(event);
          }
          output.end({ ...(await stream.result()), usage: exact });
        })();
        return output;
      };
    },
  });
  // the Space connection of a fake must not keep a worker alive once its model process is gone
  process.once("disconnect", () => { setTimeout(() => process.exit(0), 500).unref(); });
  return { models: observed, model: { provider: [...byProvider.keys()][0]!, modelId: [...byProvider.values()][0]![0]! } };
}
