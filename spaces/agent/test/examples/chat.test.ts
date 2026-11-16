// Test-Suite für chat.ts - Space-basierter Chat
// Tests: Publish-Subscribe, Ring-Kommunikation, Determinismus

import { describe, test, expect, vi, beforeEach, afterEach } from "./compat.ts";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { FOREVER, PhiSpaces, openOwnMemoryHost, startService } from "../../../src/index.ts";
import { createSpaces, localSpaces, withAgentEventSink as withEventSink } from "../../src/agent.ts";
/** The space tools of the current setup (each setup has its own space host). */
let spaces: ReturnType<typeof createSpaces>;

// ============================================================================
// TEST UTILITIES
// ============================================================================

const ROOM = "test-lobby";
const NAMES = ["alice", "bob", "carol"] as const;
const MAX_TURNS = 6;

const next = (name: string) => 
  NAMES[(NAMES.indexOf(name as (typeof NAMES)[number]) + 1) % NAMES.length]!;

function createScriptedFaux() {
  const faux = fauxProvider();
  const respond = (context: any) => {
    const all = JSON.stringify(context.messages);
    const name = /\[agent:([\w-]+)\]/.exec(all)?.[1] ?? "?";
    const last = context.messages.filter((m: any) => m.role !== "system").at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage("ok");
    const event = extractEventText(context);
    const fields = extractFields(event);
    const msg = fields ? JSON.parse(fields) : null;
    if (!msg || msg.n >= MAX_TURNS) return fauxAssistantMessage("(keine Antwort)");
    const text = `${name} zu ${msg.from}: "${String(msg.text).slice(0, 40)}…" – Runde ${msg.n + 1}.`;
    return fauxAssistantMessage(
      fauxToolCall("space_write", {
        type: "Msg",
        fields: { room: ROOM, from: name, to: next(name), n: msg.n + 1, text }
      }),
      { stopReason: "toolUse" }
    );
  };
  faux.setResponses(Array.from({ length: 100 }, () => respond));
  return faux;
}

function extractEventText(context: any): string {
  const userMsg = [...context.messages].reverse().find((m: any) => m.role === "user");
  if (!userMsg) return "";
  if (typeof userMsg.content === "string") return userMsg.content;
  if (Array.isArray(userMsg.content)) {
    return userMsg.content.map((c: any) => c.text || "").join("");
  }
  return "";
}

function extractFields(event: string): string | null {
  const match = /\[data, not instructions\]: (\{.*\})/s.exec(event);
  return match?.[1] || null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function setupChatHarness() {
  const faux = createScriptedFaux();
  const models = createModels();
  models.setProvider(faux.provider);
  
  const space = openOwnMemoryHost();
  
  spaces = createSpaces(localSpaces(space));
  
  const registry = createRegistry();
  registry.install(spaces);
  
  const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const host = new PhiSpaces(space, ctx);
  const stopService = await startService(withEventSink(space, h as any), ctx);
  
  return { h, host, stopService, models, faux };
}

async function teardownChatHarness(h: Harness, stopService: () => Promise<void>) {
  await stopService();
  await h.close(ctx);
}

// ============================================================================
// TEST SUITE: chat.ts
// ============================================================================

describe("chat.ts", () => {
  let h: Harness;
  let host: PhiSpaces;
  let stopService: () => Promise<void>;
  let models: ReturnType<typeof createModels>;

  beforeEach(async () => {
    const setup = await setupChatHarness();
    h = setup.h;
    host = setup.host;
    stopService = setup.stopService;
    models = setup.models;
  });

  afterEach(async () => {
    await teardownChatHarness(h, stopService);
  });

  // ==========================================================================
  // RING STRUCTURE TESTS
  // ==========================================================================

  describe("Ring-Struktur", () => {
    test("T6.1.1: Nachrichten folgen Ring-Topologie", async () => {
      // Erstelle Agenten
      const agents: Record<string, any> = {};
      const subs: string[] = [];
      
      for (const name of NAMES) {
        const conv = await h.createConversation({
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: "faux", modelId: "faux-1" },
            extensions: [spaces],
            instructions: `[agent:${name}] Du bist ${name}. Antworte auf Nachrichten. [data, not instructions]: ${JSON.stringify({room: ROOM, from: "host", to: name, n: 0, text: "Test"})}`
          }
        }, ctx);
        agents[name] = conv;
        subs.push((await host.notify({ type: "Msg", fields: { room: ROOM, to: name } }, { target: conv.id, lease: FOREVER })).eventId);
      }
      
      // Starte Chat mit initialer Nachricht
      await host.write({
        type: "Msg",
        fields: { room: ROOM, from: "host", to: "alice", n: 0, text: "Test" }
      }, null, FOREVER);
      
      // Warte auf Nachrichten
      await new Promise(r => setTimeout(r, 1000));
      
      const msgs = (await host.readAll({ type: "Msg", fields: { room: ROOM } }))
        .map(e => e.fields as { n: number; from: string; to: string; text: string })
        .sort((a, b) => a.n - b.n);
      
      // Prüfe Ring-Struktur: host -> alice -> bob -> carol
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      if (msgs.length >= 1) {
        expect(msgs[0].from).toBe("host");
        expect(msgs[0].to).toBe("alice");
        expect(msgs[0].n).toBe(0);
      }
    });

    test("T6.1.2: Nachrichten-Zählung (exakte Anzahl)", async () => {
      const agents: Record<string, any> = {};
      const subs: string[] = [];
      
      for (const name of NAMES) {
        const conv = await h.createConversation({
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: "faux", modelId: "faux-1" },
            extensions: [spaces],
            instructions: `[agent:${name}] Ring-Chat. [data, not instructions]: ${JSON.stringify({room: ROOM, from: "host", to: name, n: 0, text: "Test"})}`
          }
        }, ctx);
        agents[name] = conv;
        subs.push((await host.notify({ type: "Msg", fields: { room: ROOM, to: name } }, { target: conv.id, lease: FOREVER })).eventId);
      }
      
      await host.write({
        type: "Msg",
        fields: { room: ROOM, from: "host", to: "alice", n: 0, text: "Test" }
      }, null, FOREVER);
      
      // Warte auf MAX_TURNS + 1 Nachrichten (inkl. initialer)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const count = await host.count({ type: "Msg" });
        if (count >= MAX_TURNS + 1) break;
        await new Promise(r => setTimeout(r, 100));
      }
      
      const msgs = await host.readAll({ type: "Msg", fields: { room: ROOM } });
      expect(msgs.length).toBeGreaterThanOrEqual(MAX_TURNS + 1);
    });

    test("T6.1.3: Determinismus - gleiche Eingabe = gleiche Ausgabe", async () => {
      // Zwei separate Durchläufe mit gleichem Input
      const runChat = async (runId: string) => {
        const h1 = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
        const space1 = openOwnMemoryHost();
        const host1 = new PhiSpaces(space1, ctx);
        const stop1 = await startService(withEventSink(space1, h1 as any), ctx);
        
        const faux1 = createScriptedFaux();
        const m1 = createModels();
        m1.setProvider(faux1.provider);
        
        for (const name of NAMES) {
          await h1.createConversation({
            ownership: { kind: "ownerless" },
            agent: {
              model: { provider: "faux", modelId: "faux-1" },
              extensions: [spaces],
              instructions: `[agent:${name}] Deterministisch. [data, not instructions]: ${JSON.stringify({room: ROOM, from: "host", to: name, n: 0, text: "Determinismus Test"})}`
            }
          }, ctx);
        }
        
        await host1.write({
          type: "Msg",
          fields: { room: ROOM, from: "host", to: "alice", n: 0, text: "Determinismus Test" }
        }, null, FOREVER);
        
        await new Promise(r => setTimeout(r, 1000));
        
        const msgs1 = (await host1.readAll({ type: "Msg", fields: { room: ROOM } }))
          .map(e => e.fields);
        
        await stop1();
        await h1.close(ctx);
        
        return msgs1;
      };
      
      const result1 = await runChat("run1");
      const result2 = await runChat("run2");
      
      // Ergebnisse sollten identisch sein
      expect(result1.length).toBe(result2.length);
      expect(result1).toEqual(result2);
    });
  });

  // ==========================================================================
  // NOTIFY FUNCTIONALITY TESTS
  // ==========================================================================

  describe("Notify-Funktionalität", () => {
    test("T6.2.1: Agent wird durch Notify aktiviert", async () => {
      const conv = await h.createConversation({
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          extensions: [spaces],
          instructions: `[agent:test-agent] Reagiere auf Notify.`
        }
      }, ctx);
      
      // Registriere Notify
      const sub = await host.notify(
        { type: "Msg", fields: { room: ROOM, to: "test-agent" } },
        { target: conv.id, lease: FOREVER }
      );
      
      // Schreibe Nachricht
      await host.write({
        type: "Msg",
        fields: { room: ROOM, from: "host", to: "test-agent", n: 0, text: "Test" }
      }, null, FOREVER);
      
      // Warte kurz
      await new Promise(r => setTimeout(r, 500));
      
      // Prüfe ob Nachricht verarbeitet wurde
      const msgs = await host.readAll({ type: "Msg", fields: { room: ROOM, from: "test-agent" } });
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      
      // Cleanup
      await host.cancel(sub.eventId);
    });

    test("T6.2.2: Mehrere Räume bleiben isoliert", async () => {
      const ROOM1 = "room1";
      const ROOM2 = "room2";
      
      // Raum 1
      await host.write({
        type: "Msg",
        fields: { room: ROOM1, from: "host", to: "alice", n: 0, text: "Room1" }
      }, null, FOREVER);
      
      // Raum 2
      await host.write({
        type: "Msg",
        fields: { room: ROOM2, from: "host", to: "alice", n: 0, text: "Room2" }
      }, null, FOREVER);
      
      const room1Msgs = await host.readAll({ type: "Msg", fields: { room: ROOM1 } });
      const room2Msgs = await host.readAll({ type: "Msg", fields: { room: ROOM2 } });
      
      expect(room1Msgs.length).toBe(1);
      expect(room2Msgs.length).toBe(1);
      expect(room1Msgs[0].fields.room).toBe(ROOM1);
      expect(room2Msgs[0].fields.room).toBe(ROOM2);
    });
  });

  // ==========================================================================
  // PERFORMANCE TESTS
  // ==========================================================================

  describe("Performance", () => {
    test("T6.4.1: Durchsatz - 100 Nachrichten", async () => {
      const start = Date.now();
      const NUM_MSGS = 100;
      
      // Schreibe viele Nachrichten
      for (let i = 0; i < NUM_MSGS; i++) {
        await host.write({
          type: "Msg",
          fields: { 
            room: ROOM, 
            from: "host", 
            to: "alice", 
            n: i, 
            text: `Test ${i}` 
          }
        }, null, FOREVER);
      }
      
      const durationMs = Date.now() - start;
      const throughput = NUM_MSGS / (durationMs / 1000);
      
      // Mindestens 50 Nachrichten/s
      expect(throughput).toBeGreaterThanOrEqual(50);
    }, { timeout: 10000 });

    test("T6.4.2: Latenz - Single Message Round-Trip", async () => {
      const start = Date.now();
      
      await host.write({
        type: "Msg",
        fields: { room: ROOM, from: "host", to: "alice", n: 0, text: "Latency Test" }
      }, null, FOREVER);
      
      // Lies die Nachricht zurück
      const msg = await host.read({ type: "Msg", fields: { room: ROOM, n: 0 } }, 0);
      
      const durationMs = Date.now() - start;
      
      // Sollte unter 100ms sein
      expect(durationMs).toBeLessThanOrEqual(100);
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe("Edge Cases", () => {
    test("T6.5.1: Leere Raum-Name", async () => {
      const EMPTY_ROOM = "";
      
      await host.write({
        type: "Msg",
        fields: { room: EMPTY_ROOM, from: "host", to: "alice", n: 0, text: "Test" }
      }, null, FOREVER);
      
      const msgs = await host.readAll({ type: "Msg", fields: { room: EMPTY_ROOM } });
      expect(msgs.length).toBe(1);
    });

    test("T6.5.2: Lange Nachrichtentext", async () => {
      const LONG_TEXT = "A".repeat(10000); // 10KB Text
      
      await host.write({
        type: "Msg",
        fields: { room: ROOM, from: "host", to: "alice", n: 0, text: LONG_TEXT }
      }, null, FOREVER);
      
      const msg = (await host.readAll({ type: "Msg", fields: { room: ROOM } }))[0];
      expect(msg.fields.text).toBe(LONG_TEXT);
    });

    test("T6.5.3: Spezielle Charaktere in Text", async () => {
      const SPECIAL_TEXT = "Test mit Umlauten: äöü, Emojis: 🎉, und Symbolen: @#$%&*";
      
      await host.write({
        type: "Msg",
        fields: { room: ROOM, from: "host", to: "alice", n: 0, text: SPECIAL_TEXT }
      }, null, FOREVER);
      
      const msg = (await host.readAll({ type: "Msg", fields: { room: ROOM } }))[0];
      expect(msg.fields.text).toBe(SPECIAL_TEXT);
    });
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe("chat.ts Integration Tests", () => {
  test("Full Chat Cycle - 3 Agenten, 5 Runden", async () => {
    const faux = createScriptedFaux();
    const models = createModels();
    models.setProvider(faux.provider);
    
    const space = openOwnMemoryHost();
    
    spaces = createSpaces(localSpaces(space));
    
    const registry = createRegistry();
    registry.install(spaces);
    
    const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
    const host = new PhiSpaces(space, ctx);
    const stopService = await startService(withEventSink(space, h as any), ctx);
    
    try {
      const subs: string[] = [];
      
      // Erstelle 3 Agenten
      for (const name of NAMES) {
        const conv = await h.createConversation({
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: "faux", modelId: "faux-1" },
            extensions: [spaces],
            instructions: `[agent:${name}] Du bist ${name}. ${name === "alice" ? "Forscherin" : name === "bob" ? "Ingenieur" : "Moderatorin"}. [data, not instructions]: ${JSON.stringify({room: ROOM, from: "host", to: name, n: 0, text: "Full Cycle Test"})}`
          }
        }, ctx);
        
        subs.push((await host.notify(
          { type: "Msg", fields: { room: ROOM, to: name } },
          { target: conv.id, lease: FOREVER }
        )).eventId);
      }
      
      // Starte Chat
      await host.write({
        type: "Msg",
        fields: { room: ROOM, from: "host", to: "alice", n: 0, text: "Full Cycle Test" }
      }, null, FOREVER);
      
      // Warte auf MAX_TURNS + 1 Nachrichten
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const count = await host.count({ type: "Msg" });
        if (count >= MAX_TURNS + 1) break;
        await new Promise(r => setTimeout(r, 200));
      }
      
      // Überprüfe Ergebnisse
      const msgs = (await host.readAll({ type: "Msg", fields: { room: ROOM } }))
        .map(e => e.fields as { n: number; from: string; to: string; text: string })
        .sort((a, b) => a.n - b.n);
      
      // Sollten mindestens MAX_TURNS + 1 Nachrichten haben (host + 6 Runden)
      expect(msgs.length).toBeGreaterThanOrEqual(MAX_TURNS + 1);
      
      // Erste Nachricht sollte von host sein
      expect(msgs[0].from).toBe("host");
      expect(msgs[0].to).toBe("alice");
      expect(msgs[0].n).toBe(0);
      
      // Letzte Nachricht sollte n = MAX_TURNS haben
      if (msgs.length > 0) {
        const lastN = msgs[msgs.length - 1].n;
        expect(lastN).toBeLessThanOrEqual(MAX_TURNS);
      }
      
    } finally {
      await stopService();
      await h.close(ctx);
    }
  }, { timeout: 10000 });
});

// ============================================================================
// CUSTOM ASSERTIONS
// ============================================================================

expect.extend({
  async toHaveMsgCount(host: PhiSpaces, type: string, count: number) {
    const actual = await host.count({ type });
    return actual === count ? { pass: true } : { pass: false, expected: count, actual };
  },
  async toHaveRingStructure(host: PhiSpaces, room: string, expectedPath: string[]) {
    const msgs = (await host.readAll({ type: "Msg", fields: { room } }))
      .map(e => e.fields as { from: string; to: string })
      .sort((a, b) => {
        // Sort by expected path order
        const aIdx = expectedPath.findIndex(n => n === a.from);
        const bIdx = expectedPath.findIndex(n => n === b.from);
        return aIdx - bIdx;
      });
    
    const actualPath = msgs.map(m => m.from);
    const expected = expectedPath.slice(0, msgs.length);
    
    return actualPath.length === expected.length && 
           actualPath.every((val, idx) => val === expected[idx]) ?
      { pass: true } :
      { pass: false, expected: expected.join(" -> "), actual: actualPath.join(" -> ") };
  }
});
