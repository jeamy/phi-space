// Whether model calls are allowed at all: the environment's opt-in (SPACES_MMO_LLM=1; the admin can switch them off on
// top, server/settings.ts). Apart from server/llm.ts, so the processes that only decide by it (the npc process, the
// world's translation requests) need nothing of the model calls themselves.
export const llmEnabled = () => process.env.SPACES_MMO_LLM === "1";
