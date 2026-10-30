import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

export function modelBundle() {
  const models = createModels();
  const faux = fauxProvider({ provider: "scripted", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 300 }, () => (context: any) => {
    const users = context.messages.filter((m: any) => m.role === "user");
    return fauxAssistantMessage(users.some((m: any) => String(m.content).includes("Anna")) ? "say Du hei\u00dft Anna." : "say Das wei\u00df ich nicht.");
  }));
  models.setProvider(faux.provider);
  return { models, model: { provider: "scripted", modelId: "scripted" } };
}
