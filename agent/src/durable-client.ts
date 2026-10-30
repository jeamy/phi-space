// Optional process boundary: no pi-durable/chord imports reach a Space application.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentAnswer, AgentCallbacks, AgentRequest, WorkerMessage } from "./durable-protocol.ts";

type Pending = {
  resolve: (answer: AgentAnswer) => void;
  reject: (error: Error) => void;
  callbacks: AgentCallbacks;
  cleanup: () => void;
};

export class DurableAgentClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private closed = false;
  private stderr = "";
  private readonly ready: Promise<void>;

  constructor(store: string, options: { modelsModule?: string; timeoutMs?: number; maxTokens?: number } = {}) {
    this.child = fork(fileURLToPath(new URL("./durable-worker.ts", import.meta.url)), [store, String(options.maxTokens ?? 1400)], {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, PHI_DURABLE_MODELS_MODULE: options.modelsModule ?? "" },
    });
    this.child.stderr?.on("data", data => { this.stderr = (this.stderr + data).slice(-8000); });
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Agent worker startup timeout: ${this.stderr}`));
        this.child.kill("SIGKILL");
      }, options.timeoutMs ?? 15_000);
      this.child.on("message", message => {
        if ((message as WorkerMessage).kind === "ready") { clearTimeout(timeout); resolve(); }
      });
      this.child.once("error", error => { clearTimeout(timeout); reject(error); });
      this.child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Agent worker exited: ${this.stderr}`)); });
    });
    this.ready.catch(() => {});
    this.child.on("message", message => { void this.receive(message as WorkerMessage); });
    this.child.on("exit", () => {
      this.closed = true;
      for (const p of this.pending.values()) { p.cleanup(); p.reject(new Error(`Agent worker exited: ${this.stderr}`)); }
      this.pending.clear();
    });
  }

  async run(request: AgentRequest, callbacks: AgentCallbacks, signal?: AbortSignal): Promise<AgentAnswer> {
    await this.ready;
    if (this.closed) throw new Error("Agent worker is closed");
    signal?.throwIfAborted();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => { if (this.child.connected) this.child.send({ kind: "cancel", id }, () => {}); };
      this.pending.set(id, { resolve, reject, callbacks, cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      this.child.send({ kind: "run", id, request }, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { pending.cleanup(); pending.reject(error); this.pending.delete(id); }
      });
    });
  }

  private async receive(message: WorkerMessage): Promise<void> {
    if (message.kind === "ready") return;
    if (message.kind === "result") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); pending.cleanup();
      if (message.error) pending.reject(Object.assign(new Error(message.error), { usage: message.usage }));
      else if (message.answer) pending.resolve(message.answer);
      else pending.reject(new Error("Agent worker returned no answer"));
      return;
    }
    const pending = this.pending.get(message.request);
    try {
      if (!pending) throw new Error("Agent request is no longer active");
      const value = message.method === "permit"
        ? await pending.callbacks.permit(message.value!, message.usage!)
        : await pending.callbacks.verify?.(message.source!, message.metadata ?? {});
      if (message.method === "verify" && !pending.callbacks.verify) throw new Error("No verification tool is permitted");
      if (this.child.connected) this.child.send({ kind: "return", id: message.id, value });
    } catch (error) {
      if (this.child.connected) this.child.send({ kind: "return", id: message.id, error: (error as Error).message });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const exited = new Promise<void>(resolve => this.child.once("exit", () => resolve()));
    const timeout = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    if (this.child.connected) this.child.send({ kind: "close" });
    else this.child.kill("SIGTERM");
    try { await exited; } finally { clearTimeout(timeout); }
  }
}
