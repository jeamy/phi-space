import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runArxivResearch } from "../../examples/arxiv-research.ts";
import { scriptedResearchModels } from "./utils/research-models.ts";

const dir = process.argv[2]!;
const models = scriptedResearchModels(false, async (name, text) => {
  if (name === "analyst" && text.includes("transaction ")) {
    writeFileSync(join(dir, "ready"), "pending generation");
    await new Promise<void>(() => {});
  }
});
await runArxivResearch({ dir, topic: "test", modelBundle: models, pollMs: 20 });
