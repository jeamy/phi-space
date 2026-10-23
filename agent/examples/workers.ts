// One conversation puts jobs in the space, another takes one. Scripted with the faux provider.
import { BACKGROUND_CONTEXT as context } from "../../src/context.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Space, openOwnMemoryHost } from "../../src/index.ts";
import { createSpaces, localSpaces } from "../src/agent.ts";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
// The space is a host of its own; the agents' tools act on it.
const space = openOwnMemoryHost();
const spaces = createSpaces(localSpaces(space));
const registry = createRegistry();
registry.install(spaces);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const agent = { model: { provider: "faux", modelId: "faux-1" }, extensions: [spaces] };

const boss = await harness.root(context, { agent });
const worker = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);

faux.setResponses([
	fauxAssistantMessage(fauxToolCall("space_write", { type: "Job", fields: { op: "resize", file: "a.png" } }), { stopReason: "toolUse" }),
	fauxAssistantMessage("posted"),
	fauxAssistantMessage(fauxToolCall("space_take", { type: "Job" }), { stopReason: "toolUse" }),
	fauxAssistantMessage("took it"),
]);
await (await boss.submit({ type: "input", content: "post a job" }, context)).wait(context);
await (await worker.submit({ type: "input", content: "take a job" }, context)).wait(context);
console.log("space:", JSON.stringify((await space.snapshot(Space, context))?.entries));
await harness.close(context);
await space.close(context);
