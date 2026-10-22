// Persistent chat queues and immutable stage reports share the same snapshot interface.
import type { Context } from "../../../src/context.ts";
import { core, createSpace, FOREVER, listSpaces, Meter, PhiSpaces, spaceDoc, type SpaceHost } from "../../../src/index.ts";
import { SpaceChatEngine, type ReplyGenerator, type SpaceChatSnapshot } from "../../examples/shared/chat-core.ts";
import { runStageV1 } from "../../examples/v1-local-memory/run.ts";
import { runStageV2 } from "../../examples/v2-local-durable/run.ts";
import { runStageV3 } from "../../examples/v3-remote-socket/run.ts";
import { runStageV4 } from "../../examples/v4-gated-auth/run.ts";
import { runStageV5 } from "../../examples/v5-federated-cluster/run.ts";
import { runStageV6 } from "../../examples/v6-mobile-control/run.ts";
import { dispatchChatCommand } from "./commands.ts";
import type { WsConnection } from "../ws.ts";

export type StageId = "v1" | "v2" | "v3" | "v4" | "v5" | "v6";
type Session = { sessionId: string; spaceId: string; engine: SpaceChatEngine; clients: Set<WsConnection>; expiresAt: number; readOnly: boolean; work?: Promise<void>; error?: string };

export class SpaceChatHub {
 readonly host: SpaceHost;
 readonly ctx: Context;
 readonly meter: Meter;
 replyGenerator?: ReplyGenerator;
 #sessions = new Map<string, Session>();
 #initializing = new Map<string, Promise<Session>>();
 #timer?: ReturnType<typeof setTimeout>;
 #active: Promise<void> = Promise.resolve();
 #closed = false;
 #stageRunning = false;
 constructor(host: SpaceHost, ctx: Context, meter: Meter, replyGenerator?: ReplyGenerator) {
  this.host = host; this.ctx = ctx; this.meter = meter; this.replyGenerator = replyGenerator;
  this.#timer = setTimeout(() => this.#tick(), 400);
 }
 async initialize(): Promise<void> {
  for (const s of await listSpaces(this.host, this.ctx)) {
   if (s.alias.startsWith("chat-session-")) await this.ensureSession(s.alias.slice(13), { seed: false });
  }
 }
 async close(): Promise<void> {
  this.#closed = true;
  clearTimeout(this.#timer);
  await this.#active;
  await Promise.allSettled(this.#initializing.values());
  await Promise.allSettled([...this.#sessions.values()].map(s => s.work));
  for (const s of this.#sessions.values()) for (const c of s.clients) c.close();
  this.#sessions.clear();
 }
 #tick(): void {
  this.#active = (async () => {
   for (const s of this.#sessions.values()) {
    if (this.#closed) break;
    if (s.expiresAt <= Date.now()) { for (const c of s.clients) c.close(); s.clients.clear(); continue; }
    if (!s.readOnly) await this.#drain(s);
   }
   if (!this.#closed) this.#timer = setTimeout(() => this.#tick(), 400);
  })();
 }
 #drain(s: Session): Promise<void> {
  if (s.work) return s.work;
  s.work = (async () => {
   try {
    await s.engine.tickAlarms();
    let changed = false;
    for (let n = 0; n < 16; n++) {
     if (!await s.engine.processNextChatTask({ autoRunSubagent: true })) break;
     changed = true;
    }
    s.error = undefined;
    if (changed) await this.broadcastSnapshot(s.sessionId);
   } catch (e) { s.error = e instanceof Error ? e.message : String(e); }
  })();
  void s.work.finally(() => { s.work = undefined; }).catch(() => {});
  return s.work;
 }
 ensureSession(sessionId: string, options: { seed?: boolean } = {}): Promise<Session> {
  const cleanId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 48) || "lobby";
  const old = this.#sessions.get(cleanId);
  if (old) return Promise.resolve(old);
  const pending = this.#initializing.get(cleanId);
  if (pending) return pending;
  if (this.#closed) return Promise.reject(new Error("Chat hub closed"));
  if (this.#sessions.size + this.#initializing.size >= 64) return Promise.reject(new Error("Chat session quota reached (64); remove old demo spaces before creating more"));
  const p = this.#createSession(cleanId, options);
  this.#initializing.set(cleanId, p);
  void p.finally(() => this.#initializing.delete(cleanId)).catch(() => {});
  return p;
 }
 async #createSession(cleanId: string, options: { seed?: boolean }): Promise<Session> {
  const info = await this.host.commit(async tx => {
   const info = await createSpace(tx, "chat-session-" + cleanId, Date.now());
   const s = await spaceDoc(tx, info.spaceId, Date.now());
   core.setLimits(s, { maxEntries: 2_000, maxSpaceBytes: 2_097_152, maxClaimBytes: 262_144, maxLogBytes: 65_536, maxDocBytes: 8_388_608, maxSnapshotBytes: 4_194_304, maxSnapshots: 2 });
   return info;
  }, this.ctx);
  const space = new PhiSpaces(this.host, this.ctx, Date.now, this.meter, undefined, { space: info.spaceId });
  const engine = new SpaceChatEngine(space);
  engine.setReplyGenerator(this.replyGenerator);
  const report = await space.read({ type: "ChatReport" }, 0);
  if (!report) await engine.installProfilesIfSupported();
  let policy = await space.read({ type: "ChatSessionPolicy" }, 0);
  if (!policy) {
   await space.write({ type: "ChatSessionPolicy", fields: { key: "policy", expiresAt: Date.now() + 3_600_000 } }, null, FOREVER, { unique: ["key"] });
   policy = await space.read({ type: "ChatSessionPolicy" }, 0);
  }
  const reportSession = /^stage-v[1-6]$/.test(cleanId);
  if (!report && !reportSession && options.seed !== false && !(await engine.inspectSnapshot()).threads.length) {
   await engine.createThread({ threadId: "thread-main", title: "1. Architektur & Event-Store", createdBy: "alice", requestId: "seed-t1-" + cleanId });
   await engine.submitMessage({ threadId: "thread-main", author: "alice", text: "Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.", requestId: "seed-m1-" + cleanId });
   await engine.processNextChatTask();
   await engine.createThread({ threadId: "thread-ops", title: "2. Rückfragen & Subagent-Suche", createdBy: "bob", requestId: "seed-t2-" + cleanId });
  }
  const entry: Session = { sessionId: cleanId, spaceId: info.spaceId, engine, clients: new Set(), expiresAt: Number(policy!.fields.expiresAt), readOnly: !!report || reportSession };
  this.#sessions.set(cleanId, entry);
  return entry;
 }
 async executeAction(sessionId: string, command: Record<string, unknown>): Promise<SpaceChatSnapshot> {
  const s = await this.ensureSession(sessionId);
  if (s.readOnly) throw new Error("Stage reports are immutable; create a live session to send commands");
  if (s.expiresAt <= Date.now()) throw new Error("Chat session expired");
  if ((await s.engine.space.stats()).entries >= 1900) throw new Error("Chat entry quota reached");
  await dispatchChatCommand(s.engine, command);
  await this.broadcastSnapshot(s.sessionId);
  await this.#drain(s);
  return this.broadcastSnapshot(s.sessionId);
 }
 async broadcastSnapshot(sessionId: string): Promise<SpaceChatSnapshot> {
  const s = await this.ensureSession(sessionId);
  const snapshot = await s.engine.inspectSnapshot();
  for (const c of s.clients) c.send({ type: "session.snapshot", sessionId: s.sessionId, spaceId: s.spaceId, snapshot, workerError: s.error ?? null, readOnly: s.readOnly, expiresAt: s.expiresAt });
  return snapshot;
 }
 async attachWebSocket(sessionId: string, ws: WsConnection): Promise<void> {
  const s = await this.ensureSession(sessionId);
  if (s.expiresAt <= Date.now() || s.clients.size >= 16) throw new Error("Session expired or client quota reached");
  s.clients.add(ws);
  ws.onClose(() => s.clients.delete(ws));
  ws.onMessage(async raw => {
   try { await this.executeAction(s.sessionId, JSON.parse(raw)); }
   catch (e) { ws.send({ type: "session.error", message: e instanceof Error ? e.message : String(e) }); }
  });
  await this.broadcastSnapshot(s.sessionId);
 }
 async runStageDemo(stage: StageId): Promise<unknown> {
  if (this.#stageRunning) throw new Error("A stage demo is already running");
  this.#stageRunning = true;
  try {
   const runners = { v1: runStageV1, v2: runStageV2, v3: runStageV3, v4: runStageV4, v5: runStageV5, v6: runStageV6 };
   if (!Object.hasOwn(runners, stage)) throw new Error("Unknown stage: " + stage);
   const report = await runners[stage]() as unknown as Record<string, unknown>;
   const snapshot = (report.snapshot ?? report.chatSnapshot) as SpaceChatSnapshot;
   if (!snapshot) throw new Error("Stage returned no report snapshot");
   const s = await this.ensureSession("stage-" + stage, { seed: false });
   s.readOnly = true;
   await s.work;
   // Replace the dedicated report in one host commit. Tasks and timers are report data.
   await this.host.commit(async tx => {
    const state = await spaceDoc(tx, s.spaceId, Date.now());
    if (Object.keys(state.txns).length) throw new Error("Report space has an active transaction");
    core.setCompletionProfiles(state, []);
    while (core.probe(state, Date.now(), null, null, true).status === "found") { /* report replacement */ }
    for (const t of snapshot.threads) core.write(state, Date.now(), { type: "Thread", fields: { ...t } }, null, FOREVER);
    for (const m of snapshot.messages) if (!m.projectionOf) core.write(state, Date.now(), { type: "Msg", fields: { ...m } }, null, FOREVER);
    core.write(state, Date.now(), { type: "ChatReport", fields: { schema: 1, executable: false, snapshot: JSON.stringify(snapshot) } }, null, FOREVER);
    core.write(state, Date.now(), { type: "ChatSessionPolicy", fields: { key: "policy", expiresAt: s.expiresAt } }, null, FOREVER);
   }, this.ctx);
   const mirrored = await this.broadcastSnapshot(s.sessionId);
   return { ...report, snapshot: mirrored, mirrorMode: "immutable-report", inspectableSpaceAlias: "chat-session-stage-" + stage, inspectableSpaceId: s.spaceId };
  } finally { this.#stageRunning = false; }
 }
}
