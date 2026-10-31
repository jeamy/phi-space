// tests/durable-npcs.test.ts: one dialogue, then the process dies without closing anything.
import { PhiSpaces, openOwnMemoryHost } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { think } from "../server/npc/minds.ts";
import { saveSettings } from "../server/settings.ts";

const space = new PhiSpaces(openOwnMemoryHost(), ctx);
await saveSettings(space, { "npc.budgetDay": 20, "llm.perDay": 500, "llm.perMin": 20 });
const said = await think(space, { npcId: "ines", name: "Ines", persona: "Keep the beacon.", budgetDay: 20, worldId: "one" }, { room: "Hafen", people: ["Anna"], event: "talk", heard: ["Ich heiße Anna."] });
console.log(JSON.stringify(said));
process.kill(process.pid, "SIGKILL");
