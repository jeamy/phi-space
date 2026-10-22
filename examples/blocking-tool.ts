// An agent calls space_take with a timeout; another party writes the entry 300ms later.
import { BACKGROUND_CONTEXT as ctx } from "../src/context.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { FOREVER, PhiSpaces } from "../src/index.ts";
import { spaces } from "../src/agent.ts";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(spaces);
const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
const root = await h.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [spaces] } });
const s = new PhiSpaces(h, ctx);
setTimeout(() => void s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER), 300);
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("space_take", { type: "Job", timeoutMs: 5000 }), { stopReason: "toolUse" }),
	fauxAssistantMessage("done"),
]);
await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
const page = await root.entries({}, 10, undefined, ctx);
console.log(JSON.stringify(page.items).includes('n\\":1') || JSON.stringify(page.items).includes('"n":1') ? "tool took the job" : "NOT FOUND");
await h.close(ctx);
