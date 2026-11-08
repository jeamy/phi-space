// tests/durable-npcs.test.ts: one dialogue, then the process (the model process's part with its agent store) dies without closing anything.
import { PhiSpaces, openOwnMemoryHost } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { think } from "../server/npc/minds.ts";
import { saveSettings } from "../server/settings.ts";
import { serveThinks } from "../server/model-npc.ts";

const space = new PhiSpaces(openOwnMemoryHost(), ctx);
void serveThinks(space, new AbortController().signal); // the model process's part (the npc asks, this answers)
await saveSettings(space, { "npc.budgetDay": 20, "llm.perDay": 500, "llm.perMin": 20 });
const said = await think(space, { npcId: "ines", name: "Ines", persona: "Keep the beacon.", budgetDay: 20, worldId: "one" }, { room: "Hafen", people: ["Anna"], event: "talk", heard: ["Ich heiße Anna."] });
console.log(JSON.stringify(said));
process.kill(process.pid, "SIGKILL");
