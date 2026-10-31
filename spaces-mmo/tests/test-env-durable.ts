// Preloaded by `npm run test:durable`: test-env.ts with the durable NPC dialogues on wherever a test names a scripted
// model. tests/stack.ts gives every process an agent store of its own (the store has an owner lock); this process's
// own, for tests that think in-process, goes with it.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./test-env.ts";

process.env.SPACES_MMO_TEST = "1";
process.env.SPACES_MMO_DURABLE_NPCS = "";
process.env.SPACES_MMO_DURABLE_MATRIX = "1";
process.env.SPACES_MMO_DURABLE_MODELS_MODULE = fileURLToPath(new URL("../../agent/test/durable-fake-models.ts", import.meta.url));
process.env.PHI_DURABLE_FAKE_ANSWERS = fileURLToPath(new URL("./durable-answers.ts", import.meta.url));
const own = join(tmpdir(), `mmo-durable-${process.pid}`);
process.env.SPACES_MMO_DURABLE_STORE = join(own, "agent.sqlite");
process.on("exit", () => rmSync(own, { recursive: true, force: true }));
