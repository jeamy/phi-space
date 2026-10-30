// Agent-only process. Models run only after the application reattaches and admits each attempt.
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import {
  AssistantEntry, createRegistry, defineDoc, defineDocFamily, defineExtension, defineTool,
  GenerationTask, Harness, hook, type ConversationId, type JsonObject,
} from "@earendil-works/pi-durable";
import { liveModels } from "./live-models.ts";
import { ensureDurableDirectory, openDurableSqliteStorage } from "./storage.ts";
import type { AgentAnswer, AgentRequest, AgentUsage, ParentMessage, WorkerMessage } from "./durable-protocol.ts";

const zero = (): AgentUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 });
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
const Sessions = defineDoc<{ sessions: Record<string, { id: ConversationId; mode: string; turns: number }> }>({
  kind: "phi-spaces.bridge-sessions", version: 1, scope: "session",
  initial: () => ({ sessions: {} }), checkpointWhen: () => true,
});
const Current = defineDocFamily<{ key: string | null }, null>({
  kind: "phi-spaces.bridge-current", version: 1, scope: "session", family: true,
  initial: () => ({ key: null }), checkpointWhen: () => true,
});
const Jobs = defineDocFamily<{
  request: JsonObject | null; conversation: ConversationId | null; attempts: number;
  usage: AgentUsage; answer: AgentAnswer | null; error: string | null;
}, null>({
  kind: "phi-spaces.bridge-jobs", version: 1, scope: "session", family: true,
  initial: () => ({ request: null, conversation: null, attempts: 0, usage: zero(), answer: null, error: null }),
  checkpointWhen: () => true,
});

function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Agent request cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}
const send = (message: WorkerMessage) => { if (process.connected) process.send!(message); };
let next = 0;
const replies = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
async function invoke(request: number, method: "permit" | "verify", data: { value?: AgentRequest; source?: string; metadata?: Record<string, unknown>; usage?: AgentUsage }, signal?: AbortSignal) {
  const id = ++next;
  try {
    return await wait(new Promise<unknown>((resolve, reject) => {
      replies.set(id, { resolve, reject }); send({ kind: "invoke", id, request, method, ...data });
    }), signal);
  } finally { replies.delete(id); }
}
const active = new Map<ConversationId, number>();
const attachments = new Map<ConversationId, { promise: Promise<number>; resolve: (id: number) => void }>();
function attached(id: ConversationId, signal?: AbortSignal): Promise<number> {
  const known = active.get(id);
  if (known !== undefined) return Promise.resolve(known);
  let pending = attachments.get(id);
  if (!pending) {
    let resolve!: (id: number) => void;
    const promise = new Promise<number>(r => { resolve = r; });
    pending = { promise, resolve }; attachments.set(id, pending);
  }
  return wait(pending.promise, signal);
}

const file = process.argv[2]!;
const maxTokens = Number(process.argv[3] ?? 1400);
if (!file || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw new Error("Invalid agent worker configuration");
await ensureDurableDirectory(dirname(file));
// Same OS-released owner-lock pattern as the own Space store, without importing that store.
const owner = new DatabaseSync(`${file}.owner`, { timeout: 0 });
owner.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
const module = process.env.PHI_DURABLE_MODELS_MODULE;
const { models }: { models: Models } = module ? await (await import(pathToFileURL(module).href)).modelBundle() : await liveModels();
const tagged = new WeakMap<object, { id: ConversationId; signal?: AbortSignal }>();
const failures = new Map<ConversationId, string>();
const boundedModels = new Proxy(models, {
  get(target, key) {
    if (key === "streamSimple") return (...[model, context, options]: Parameters<Models["streamSimple"]>) => {
      const output = createAssistantMessageEventStream();
      const marker = context.messages.map(message => tagged.get(message)).find(Boolean);
      const signal = marker?.signal ?? options?.signal;
      void (async () => {
        try {
          // Hooks are best-effort in pi-durable: only the provider boundary can enforce admission.
          if (!marker) throw new Error("Unadmitted model request");
          const parent = await attached(marker.id, signal);
          const jobKey = (await harness.snapshot(Current, String(marker.id), ctx))?.key;
          if (!jobKey) throw new Error("No active job");
          const admitted = await (await root()).commit(async tx => {
            const job = await tx.doc(Jobs, jobKey, null), request = job.request as AgentRequest | null;
            if (!request || job.attempts >= (request.maxRequests ?? 4)) throw new Error("Agent model request budget exhausted");
            job.attempts++;
            return { request: JSON.parse(JSON.stringify(request)) as AgentRequest, usage: { ...job.usage } };
          }, ctx);
          await invoke(parent, "permit", { value: admitted.request, usage: admitted.usage }, signal);
          signal?.throwIfAborted();
          const stream = target.streamSimple(model, { ...context, messages: context.messages.filter(message => !tagged.has(message)) },
            { ...options, signal, maxTokens: Math.min(admitted.request.maxTokens ?? maxTokens, options?.maxTokens ?? maxTokens, maxTokens) });
          for await (const event of stream) output.push(event);
          output.end(await stream.result());
        } catch (error) {
          if (marker) failures.set(marker.id, (error as Error).message);
          const message: AssistantMessage = {
            role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: signal?.aborted ? "aborted" : "error", errorMessage: (error as Error).message, timestamp: Date.now(),
          };
          output.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
          output.end(message);
        }
      })();
      return output;
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
let harness: Harness;
const root = async () => harness.root(ctx);
const verify = defineTool({
  name: "verify_code", description: "Test a JavaScript function in the application's isolated sandbox. Fix failures before answering.",
  parameters: Type.Object({ source: Type.String({ maxLength: 16000 }) }),
  replay: "safe",
  execute: async ({ source }, api, context) => {
    const key = (await api.snapshot(Current, String(api.conversationId), context))?.key;
    if (!key) throw new Error("No active job");
    const job = await api.snapshot(Jobs, key, context);
    const request = job?.request as AgentRequest | undefined;
    if (!request || request.mode !== "code") throw new Error("Verification is not permitted");
    const parent = await attached(api.conversationId, context.abortSignal);
    const value = await invoke(parent, "verify", { source, metadata: request.metadata }, context.abortSignal);
    return { output: [{ type: "text" as const, text: JSON.stringify(value) }] };
  },
});
const bridge = defineExtension({
  name: "phi-durable-bridge", tools: [verify],
  hooks: [hook(GenerationTask, {
    beforeRequest: (request, api, context) => {
      const marker = { role: "system" as const, content: "", timestamp: 0 };
      tagged.set(marker, { id: api.conversationId, signal: context.abortSignal });
      return { messages: [marker, ...request.messages] };
    },
    afterResponse: async (message, api, context) => {
      const key = (await api.snapshot(Current, String(api.conversationId), context))?.key;
      if (!key) return;
      await (await root()).commit(async tx => {
        const job = await tx.doc(Jobs, key, null), u = message.usage;
        job.usage.input += u.input; job.usage.output += u.output;
        job.usage.cacheRead += u.cacheRead; job.usage.cacheWrite += u.cacheWrite;
        job.usage.total += u.totalTokens; job.usage.costUsd += u.cost.total;
      }, context);
    },
  })],
});
const registry = createRegistry(); registry.install(bridge);
harness = await Harness.open(await openDurableSqliteStorage(file), {
  models: boundedModels, registry,
  settings: { stream: { timeoutMs: 30_000, maxRetries: 0 }, retry: { maxRetries: 0 }, compaction: { enabled: false } },
}, ctx);

const queued = new Map<string, Promise<unknown>>();
const running = new Map<number, AbortController>();

async function run(id: number, supplied: AgentRequest, signal: AbortSignal): Promise<AgentAnswer> {
  signal.throwIfAborted();
  if (!supplied.session || supplied.session.length > 512 || !supplied.requestId || supplied.requestId.length > 512 ||
      !supplied.model.includes("/") || !supplied.prompt || !supplied.system ||
      supplied.maxRequests !== undefined && (!Number.isInteger(supplied.maxRequests) || supplied.maxRequests < 1 || supplied.maxRequests > 8) ||
      supplied.maxTokens !== undefined && (!Number.isInteger(supplied.maxTokens) || supplied.maxTokens < 1 || supplied.maxTokens > 8192) ||
      JSON.stringify(supplied).length > 200_000) throw new Error("Invalid durable agent request");
  const key = JSON.stringify([supplied.session, supplied.requestId]);
  const saved = await harness.snapshot(Jobs, key, ctx);
  if (saved?.request && !supplied.resumeExisting &&
      canonical(saved.request) !== canonical(supplied)) throw new Error("Request identity conflicts with stored input");
  if (saved?.answer) return JSON.parse(JSON.stringify(saved.answer));
  if (saved?.error) throw Object.assign(new Error(saved.error), { usage: saved.usage });
  const request = (saved?.request ?? supplied) as AgentRequest;
  const sessions = (await harness.snapshot(Sessions, ctx))?.sessions ?? {};
  const known = sessions[request.session];
  if (known && known.mode !== (request.mode ?? "dialogue")) throw new Error("Session mode conflict");
  const split = request.model.indexOf("/");
  const agent = {
    model: { provider: request.model.slice(0, split), modelId: request.model.slice(split + 1) },
    instructions: request.system, extensions: [bridge], tools: request.mode === "code" ? [verify] : [],
  };
  const conversation = known && (known.turns < 64 || request.mode === "code")
    ? await harness.conversation(known.id, ctx)
    : await harness.createConversation({
      ownership: { kind: "ownerless" }, agent,
      init: async (tx, conversation) => {
        (await tx.doc(Sessions)).sessions[request.session] = { id: conversation, turns: 0, mode: request.mode ?? "dialogue" };
      },
    }, ctx);
  if (!conversation) throw new Error("Missing stored conversation");
  const current = (await harness.snapshot(Current, String(conversation.id), ctx))?.key;
  if (current && current !== key) await conversation.abort(ctx);
  await conversation.configure(agent, ctx);
  await conversation.commit(async tx => {
    const job = await tx.doc(Jobs, key, null);
    job.request ??= JSON.parse(JSON.stringify(request));
    job.conversation = conversation.id;
    (await tx.doc(Current, String(conversation.id), null)).key = key;
  }, ctx);
  signal.throwIfAborted();
  active.set(conversation.id, id);
  attachments.get(conversation.id)?.resolve(id); attachments.delete(conversation.id);
  const abort = () => { void conversation.abort(ctx).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    harness.resume();
    const submission = await conversation.submit({ type: "input", content: request.prompt, requestId: request.requestId, whenBusy: "followUp" }, ctx);
    const settled = await wait(submission.wait(ctx), signal);
    if (settled.status !== "done" || !settled.answer) throw new Error(`Agent submission ${settled.status}`);
    const entry = await conversation.commit(tx => tx.entry(AssistantEntry, settled.answer!), ctx);
    const text = entry?.model?.flatMap(message => typeof message.content === "string" ? [message.content]
      : message.content.filter(part => part.type === "text").map(part => part.text)).join("\n") ?? "";
    if (!text.trim()) throw new Error("Empty durable agent answer");
    return await conversation.commit(async tx => {
      const job = await tx.doc(Jobs, key, null);
      const answer = { text, model: request.model, usage: { ...job.usage } };
      job.answer = answer;
      (await tx.doc(Sessions)).sessions[request.session]!.turns++;
      return answer;
    }, ctx);
  } catch (error) {
    const reason = failures.get(conversation.id) ?? (error as Error).message;
    const usage = await conversation.commit(async tx => {
      const job = await tx.doc(Jobs, key, null); job.error = reason;
      return { ...job.usage };
    }, ctx);
    throw Object.assign(new Error(reason), { usage });
  } finally { signal.removeEventListener("abort", abort); active.delete(conversation.id); failures.delete(conversation.id); }
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try { await harness.close(ctx); } finally { owner.close(); process.disconnect?.(); }
}
process.on("message", (message: ParentMessage) => {
  if (message.kind === "return") {
    const pending = replies.get(message.id);
    if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.value);
  } else if (message.kind === "cancel") {
    running.get(message.id)?.abort();
  } else if (message.kind === "close") {
    void close();
  } else {
    const controller = new AbortController(); running.set(message.id, controller);
    const task = (queued.get(message.request.session) ?? Promise.resolve()).catch(() => {}).then(() => run(message.id, message.request, controller.signal));
    queued.set(message.request.session, task);
    task.then(answer => send({ kind: "result", id: message.id, answer }), error => {
      send({ kind: "result", id: message.id, error: (error as Error).message, usage: (error as Error & { usage?: AgentUsage }).usage });
    }).finally(() => {
      running.delete(message.id);
      if (queued.get(message.request.session) === task) queued.delete(message.request.session);
    });
  }
});
process.on("disconnect", () => { void close(); });
send({ kind: "ready" });
