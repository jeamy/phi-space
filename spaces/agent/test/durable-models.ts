import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export function modelBundle() {
  const models = createModels(), faux = fauxProvider();
  faux.setResponses(Array.from({ length: 500 }, () => async (context: any) => {
    const messages = context.messages.filter((m: any) => m.role !== "system");
    const user = messages.filter((m: any) => m.role === "user").at(-1)?.content ?? "";
    if (typeof user === "string" && user.startsWith("loop:")) appendFileSync(user.slice(5), "model called\n");
    if (typeof user === "string" && user.startsWith("deny:")) appendFileSync(user.slice(5), "model called\n");
    if (typeof user === "string" && user.startsWith("crash:") && !existsSync(user.slice(6))) {
      writeFileSync(user.slice(6), "crashed once");
      process.kill(process.pid, "SIGKILL");
      await new Promise<void>(() => {});
    }
    if (typeof user === "string" && user.startsWith("fail:")) throw new Error(user.slice(5));
    const last = messages.at(-1);
    // Tests of an interruption between two model answers: PHI_TEST_MODEL_LOG logs each attempt; at the attempt after the
    // tool, PHI_TEST_MODEL_CRASH kills the worker once, and PHI_TEST_MODEL_PAUSE holds until its ".go" file exists.
    const after = last?.role === "toolResult", { PHI_TEST_MODEL_LOG: log, PHI_TEST_MODEL_CRASH: crash, PHI_TEST_MODEL_PAUSE: pause } = process.env;
    if (log) appendFileSync(log, `${after ? "after-tool" : "first"}\n`);
    if (after && crash && !existsSync(crash)) {
      writeFileSync(crash, "crashed once");
      process.kill(process.pid, "SIGKILL");
      await new Promise<void>(() => {});
    }
    while (after && pause && !existsSync(`${pause}.go`)) await new Promise(resolve => setTimeout(resolve, 20));
    const code = user === "repair" || JSON.stringify(context.messages.filter((m: any) => m.role === "system")).includes("[durable-code]");
    const message = user === "loop" || String(user).startsWith("loop:") || code && last?.role !== "toolResult"
      ? fauxAssistantMessage(fauxToolCall("verify_code", { source: "(a, b) => a + b" }), { stopReason: "toolUse" })
      : fauxAssistantMessage(code ? "```js\n(a, b) => a + b\n```\nNOTE: plain addition" : `answer:${user}; previous:${messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("|")}`);
    message.usage.input = 5; message.usage.output = 2; message.usage.totalTokens = 7; message.usage.cost.total = 0.03;
    return message;
  }));
  models.setProvider(faux.provider);
  const observed = new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") return (...[model, context, options]: Parameters<typeof models.streamSimple>) => {
        const user = context.messages.filter(m => m.role === "user").at(-1)?.content;
        if (typeof user === "string" && user.startsWith("tokens:")) writeFileSync(user.slice(7), String(options?.maxTokens));
        return target.streamSimple(model, context, options);
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { models: observed, model: { provider: "faux", modelId: "faux-1" } };
}
