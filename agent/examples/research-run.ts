// One owner, durable team identities, and idempotent phase handoffs across the two stores.
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness, type AgentChange, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { FOREVER, PhiSpaces, openSqliteHost, startService, type EntryDraft } from "../../src/index.ts";
import { withAgentEventSink } from "../src/agent.ts";
import { liveModels } from "../src/live-models.ts";
import { ensureDurableDirectory, openDurableJsonlStorage, syncDirectory } from "../src/storage.ts";
import type { ModelBundle, ResearchOptions } from "./research-support.ts";

type Manifest = { version: 1; runId: string; kind: string; topic: string; query: string | null };
type RunState = {
  runId: string | null;
  model: { provider: string; modelId: string } | null;
  agents: Record<string, ConversationId>;
  phase: string;
  finished: boolean;
};
export const ResearchRunDoc = defineDoc<RunState>({
  kind: "phi-spaces.research-run", version: 1, scope: "session",
  initial: () => ({ runId: null, model: null, agents: {}, phase: "initial", finished: false }),
  checkpointWhen: () => true,
});

export function writeResearchFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { flag: "wx", flush: true });
  renameSync(temporary, file);
  const directory = openSync(dirname(file), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export class ResearchRun {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly space: Awaited<ReturnType<typeof openSqliteHost>>;
  readonly host: PhiSpaces;
  private harness?: Harness;
  private stopService?: () => Promise<void>;
  private constructor(dir: string, manifest: Manifest, space: ResearchRun["space"]) {
    this.dir = dir; this.manifest = manifest; this.space = space;
    this.host = new PhiSpaces(space, ctx);
  }

  static async open(kind: string, defaultTopic: string, options: ResearchOptions): Promise<ResearchRun> {
    if (options.resume && !options.dir) throw new Error("Resume requires --dir");
    const dir = options.dir ?? mkdtempSync(join(tmpdir(), `phi-spaces-${kind}-`));
    await ensureDurableDirectory(dir);
    const file = join(dir, ".research-run.json");
    let manifest: Manifest;
    if (options.resume) {
      if (!existsSync(file)) throw new Error("No compatible research manifest; refusing to adopt this directory");
      manifest = JSON.parse(readFileSync(file, "utf8"));
      if (manifest.version !== 1 || typeof manifest.runId !== "string" || !manifest.runId ||
          manifest.kind !== kind || typeof manifest.topic !== "string" ||
          !(manifest.query === null || typeof manifest.query === "string")) throw new Error("Incompatible research manifest");
      if (options.topic !== undefined && options.topic !== manifest.topic ||
          options.query !== undefined && options.query !== manifest.query) throw new Error("Resume configuration conflicts with the existing run");
    } else {
      if (readdirSync(dir).length) throw new Error("Research state directory is not empty; use --resume with a compatible run");
      manifest = { version: 1, runId: randomUUID(), kind, topic: options.topic ?? defaultTopic, query: options.query ?? null };
    }
    // The own SQLite host's owner lock also serializes access to this run's manifest and agent store.
    const space = await openSqliteHost(join(dir, "space.sqlite"));
    try {
      if (!options.resume) {
        writeFileSync(file, JSON.stringify(manifest), { flag: "wx", flush: true });
        await syncDirectory(dir);
      }
      return new ResearchRun(dir, manifest, space);
    } catch (error) { await space.close(ctx); throw error; }
  }

  async connect(extensions: Extension[], options: ResearchOptions): Promise<ModelBundle["model"]> {
    const bundle = options.modelBundle ?? await liveModels();
    const registry = createRegistry();
    for (const extension of extensions) registry.install(extension);
    this.harness = await Harness.open(await openDurableJsonlStorage(this.dir, ctx), { models: bundle.models, registry }, ctx);
    const root = await this.harness.root(ctx);
    return root.commit(async tx => {
      const state = await tx.doc(ResearchRunDoc);
      if (state.runId !== null && state.runId !== this.manifest.runId) throw new Error("Research manifest does not match the agent store");
      if (state.model && options.modelBundle &&
          (state.model.provider !== bundle.model.provider || state.model.modelId !== bundle.model.modelId)) throw new Error("Resume model conflicts with the existing run");
      state.runId = this.manifest.runId;
      state.model ??= bundle.model;
      return { ...state.model };
    }, ctx);
  }

  status() { return this.harness!.snapshot(ResearchRunDoc, ctx); }

  async agent(name: string, agent: AgentChange) {
    const harness = this.harness!;
    const id = (await harness.snapshot(ResearchRunDoc, ctx))?.agents[name];
    if (id !== undefined) {
      const conversation = await harness.conversation(id, ctx);
      if (!conversation) throw new Error(`Missing persisted research agent: ${name}`);
      return conversation;
    }
    return harness.createConversation({
      ownership: { kind: "ownerless" }, agent,
      init: async (tx, id) => { (await tx.doc(ResearchRunDoc)).agents[name] = id; },
    }, ctx);
  }

  async start(team: Record<string, Awaited<ReturnType<ResearchRun["agent"]>>>): Promise<void> {
    if ((await this.status())?.finished) return;
    this.stopService = await startService(withAgentEventSink(this.space, this.harness!), ctx);
    this.harness!.resume();
    for (const [name, conversation] of Object.entries(team)) {
      await conversation.submit({
        type: "input", content: "Beginne.", requestId: `${this.manifest.runId}:start:${name}`, whenBusy: "followUp",
      }, ctx);
    }
  }

  async trigger(phase: string, entry?: EntryDraft): Promise<void> {
    if ((await this.status())?.finished) return;
    // A marker and its task share a Space transaction: a consumed task is never recreated after a crash.
    const txn = await this.host.createTransaction(10_000);
    try {
      const fields = { runId: this.manifest.runId, phase };
      if (!(await this.host.readIfExists({ type: "ResearchPhase", fields }, 0, { txn: txn.id }))) {
        if (entry) await this.host.write(entry, txn.id, FOREVER);
        await this.host.write({ type: "ResearchPhase", fields }, txn.id, FOREVER);
      }
      await this.host.commit(txn.id);
    } catch (error) { await this.host.abort(txn.id).catch(() => {}); throw error; }
    const root = await this.harness!.root(ctx);
    await root.commit(async tx => { (await tx.doc(ResearchRunDoc)).phase = phase; }, ctx);
  }

  async finish(): Promise<void> {
    const root = await this.harness!.root(ctx);
    await root.commit(async tx => {
      const state = await tx.doc(ResearchRunDoc);
      state.phase = "done"; state.finished = true;
    }, ctx);
  }

  async close(): Promise<void> {
    try { await this.stopService?.(); }
    finally {
      try { await this.harness?.close(ctx); }
      finally { await this.space.close(ctx); }
    }
  }
}
