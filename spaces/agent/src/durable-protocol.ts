// Structural IPC contract: applications do not import the agent runtime to use this boundary.
export type AgentUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; costUsd: number };
export type AgentRequest = {
  session: string;
  requestId: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  maxRequests?: number;
  mode?: "code" | "dialogue";
  resumeExisting?: boolean;
  metadata?: Record<string, unknown>;
};
export type AgentAnswer = { text: string; model: string; usage: AgentUsage };
export type AgentCallbacks = {
  permit: (request: AgentRequest, usage: AgentUsage) => Promise<void>;
  verify?: (source: string, metadata: Record<string, unknown>) => Promise<unknown>;
};
export type ParentMessage =
  | { kind: "run"; id: number; request: AgentRequest }
  | { kind: "cancel"; id: number }
  | { kind: "return"; id: number; value?: unknown; error?: string }
  | { kind: "close" };
export type WorkerMessage =
  | { kind: "ready" }
  | { kind: "result"; id: number; answer?: AgentAnswer; error?: string; usage?: AgentUsage }
  | { kind: "invoke"; id: number; request: number; method: "permit" | "verify"; source?: string; metadata?: Record<string, unknown>; value?: AgentRequest; usage?: AgentUsage };
