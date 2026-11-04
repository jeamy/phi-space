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
  private child: ChildProcess | null = null;
  private ready: Promise<void> = Promise.resolve();
  private readonly pending = new Map<number, Pending>();
  private next = 0;
  private closed = false;
  private stderr = "";
  private readonly store: string;
  private readonly options: { modelsModule?: string; timeoutMs?: number; maxTokens?: number };

  constructor(store: string, options: { modelsModule?: string; timeoutMs?: number; maxTokens?: number } = {}) {
    this.store = store;
    this.options = options;
    this.start();
  }

  /** A worker that died takes its running requests with it; the next request starts a new one on the same store. */
  private start(): ChildProcess {
    const { options } = this;
    const child = fork(fileURLToPath(new URL("./durable-worker.ts", import.meta.url)), [this.store, String(options.maxTokens ?? 1400)], {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, PHI_DURABLE_MODELS_MODULE: options.modelsModule ?? "" },
    });
    this.child = child;
    child.stderr?.on("data", data => { this.stderr = (this.stderr + data).slice(-8000); });
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Agent worker startup timeout: ${this.stderr}`));
        child.kill("SIGKILL");
      }, options.timeoutMs ?? 15_000);
      const started = (message: unknown) => {
        if ((message as WorkerMessage).kind === "ready") { clearTimeout(timeout); child.off("message", started); resolve(); }
      };
      child.on("message", started);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Agent worker exited: ${this.stderr}`)); });
    });
    this.ready.catch(() => {});
    const gone = (error: Error) => {
      if (this.child === child) this.child = null;
      for (const p of this.pending.values()) { p.cleanup(); p.reject(error); }
      this.pending.clear();
    };
    child.on("message", message => { void this.receive(child, message as WorkerMessage); });
    child.on("exit", () => gone(new Error(`Agent worker exited: ${this.stderr}`)));
    // a fork that failed never exits: without this the dead child would count as the running worker
    child.on("error", error => { if (child.pid === undefined) gone(error); });
    return child;
  }

  async run(request: AgentRequest, callbacks: AgentCallbacks, signal?: AbortSignal): Promise<AgentAnswer> {
    if (this.closed) throw new Error("Agent worker is closed");
    if (!this.child) this.start();
    const child = this.child!;
    await this.ready;
    if (this.closed) throw new Error("Agent worker is closed");
    if (this.child !== child) throw new Error(`Agent worker exited: ${this.stderr}`);
    signal?.throwIfAborted();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => { if (child.connected) child.send({ kind: "cancel", id }, () => {}); };
      this.pending.set(id, { resolve, reject, callbacks, cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      child.send({ kind: "run", id, request }, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { pending.cleanup(); pending.reject(error); this.pending.delete(id); }
      });
    });
  }

  private async receive(child: ChildProcess, message: WorkerMessage): Promise<void> {
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
      if (child.connected) child.send({ kind: "return", id: message.id, value });
    } catch (error) {
      if (child.connected) child.send({ kind: "return", id: message.id, error: (error as Error).message });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const { child } = this;
    if (!child || child.pid === undefined) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    if (child.connected) child.send({ kind: "close" }, error => { if (error) child.kill("SIGKILL"); });
    else child.kill("SIGTERM");
    try { await exited; } finally { clearTimeout(timeout); }
  }
}
