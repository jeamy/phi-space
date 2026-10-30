// Conversation history only: world ownership, memory summaries and commands remain in the Space.
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DurableAgentClient } from "../../../agent/src/durable-client.ts";
import { ROOT } from "../env.ts";
import type { Completion } from "../llm.ts";

let backend: { store: string; client: DurableAgentClient } | null = null;

export function npcDialogueOptions(npcId: string, worldId: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  if (env.SPACES_MMO_LLM !== "1") return undefined;
  const selection = env.SPACES_MMO_DURABLE_NPCS?.trim() || "*";
  if (["0", "false", "off", "none"].includes(selection.toLowerCase())) return undefined;
  const selected = selection.split(",").map(id => id.trim()).filter(Boolean);
  if (!selected.includes("*") && !selected.includes(npcId)) return undefined;
  const module = env.SPACES_MMO_DURABLE_MODELS_MODULE;
  // A scripted application must never accidentally launch real models in its agent process.
  if (env.SPACES_MMO_LLM_MODULE && !module) return undefined;
  if (env.SPACES_MMO_TEST === "1" && !module) return undefined;
  if (module && env.SPACES_MMO_TEST !== "1") throw new Error("Durable NPC model fixtures require SPACES_MMO_TEST=1");
  const segment = (value: string) => encodeURIComponent(value).replaceAll(".", "%2E");
  return {
    store: resolve(ROOT, env.SPACES_MMO_DURABLE_STORE?.trim() ||
      join(env.SPACES_MMO_DATA || ".local", "npc-agents", segment(worldId), `${segment(env.SPACES_MMO_REGION || "world")}.sqlite`)),
    modelsModule: module ? resolve(ROOT, module) : undefined,
  };
}

export function npcDialogue(
  npcId: string, worldId: string, system: string, prompt: string, signal?: AbortSignal,
): ((model: string, permit: () => Promise<boolean>) => Promise<Completion | null>) | undefined {
  const options = npcDialogueOptions(npcId, worldId);
  if (!options) return undefined;
  return async (model, permit) => {
    signal?.throwIfAborted();
    const store = options.store;
    if (backend && backend.store !== store) throw new Error("Close the NPC agent before changing its store");
    backend ??= { store, client: new DurableAgentClient(store, { maxTokens: 200, modelsModule: options.modelsModule }) };
    return backend.client.run({
      session: JSON.stringify(["npc", worldId, npcId]), requestId: randomUUID(), model, mode: "dialogue",
      system: `${system}\nOnly the latest situation is authoritative. Earlier turns are history; never replay their commands or assume their world state still holds.`,
      prompt, maxTokens: 200, maxRequests: 1,
    }, {
      permit: async () => {
        signal?.throwIfAborted();
        if (!(await permit())) throw new Error("NPC model disabled or budget exhausted");
        signal?.throwIfAborted();
      },
    }, signal);
  };
}

export async function closeDurableNpcs(): Promise<void> {
  const current = backend;
  backend = null;
  await current?.client.close();
}
