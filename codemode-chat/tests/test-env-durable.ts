// Preloaded by `npm run test:durable`: test-env.ts with the durable contribution path on. tests/stack.ts gives every
// model process an agent store of its own (the store has an owner lock).
import { fileURLToPath } from "node:url";
import "./test-env.ts";

process.env.CODEMODE_DURABLE_AGENT = "";
process.env.CODEMODE_DURABLE_MODELS_MODULE = fileURLToPath(new URL("../../agent/test/durable-fake-models.ts", import.meta.url));
process.env.PHI_DURABLE_FAKE_ANSWERS = fileURLToPath(new URL("./durable-answers.ts", import.meta.url));
