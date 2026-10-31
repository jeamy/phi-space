# UI Implementation Plan: Verbindung Spaces -> Dashboard

> **Umsetzungsstand:** Dieses Dokument ist ein Entwurf. Umgesetzt ist nur das schreibgeschützte Dashboard — siehe [docs/dashboard.en.md](../../../dashboard.en.md) (`src/dashboard.ts`, `npm run dashboard`: `node:http`, Server-Sent Events statt WebSocket, keine Frameworks). Express, `ws`, JWT, `DashboardSpaceService` und die pi-durable-Aufrufe unten werden nicht gebaut.


Plan für die Integration der phi-spaces Daten mit der Live-Dashboard-UI.

## 1. Architektur-Übersicht

```
┌──────────────────────────────────────────────────────────────┐
│                     Browser (Dashboard UI)                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ React/Vue Components                                    │ │
│  │ - SpaceListPanel, EntryListPanel, AgentPanel, etc      │ │
│  │ - Redux/Pinia State Management                         │ │
│  └────────────────────┬────────────────────────────────────┘ │
│                       │                                       │
│  WebSocket Connection │ JSON Messages                        │
│  - Live Updates       │ - Space Events                       │
│  - Subscriptions      │ - Agent Status                       │
└───────────────────────┼───────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        v               v               v
   ┌─────────┐   ┌────────────┐  ┌───────────┐
   │ REST    │   │ WebSocket  │  │ GraphQL   │
   │ API     │   │ Server     │  │ (optional)│
   └────┬────┘   └──────┬─────┘  └─────┬─────┘
        │               │              │
        └───────────────┼──────────────┘
                        │
        ┌───────────────v──────────────┐
        │   phi-spaces Service Layer    │
        │  ┌───────────────────────┐   │
        │  │ SpaceService          │   │
        │  │ (federation-plan v3)  │   │
        │  └───────┬───────────────┘   │
        │          │                   │
        │  ┌───────v──────────┐        │
        │  │ Space Events     │        │
        │  │ - Writes         │        │
        │  │ - Takes          │        │
        │  │ - Reads          │        │
        │  │ - Transactions   │        │
        │  │ - Waits/Notifies │        │
        │  └──────────────────┘        │
        │                             │
        └─────────────────────────────┘
```

---

## 2. API-Design

### 2.1 REST API Endpoints

```
Base URL: /api/v1/spaces

GET    /spaces
       Response: SpaceListResponse
       {
         "spaces": [
           {
             "id": "uuid",
             "alias": "default",
             "entries": 42,
             "types": 8,
             "size_bytes": 12288,
             "status": "active",
             "created_at": "2026-10-11T20:00:00Z"
           }
         ]
       }

GET    /spaces/{spaceId}
       Response: SpaceDetailResponse
       {
         "id": "uuid",
         "alias": "default",
         "entries": 42,
         "types": 8,
         "size_bytes": 12288,
         "transactions": {
           "active": 3,
           "pending": 2
         },
         "memory": {
           "used_bytes": 12288,
           "max_bytes": 104857600
         },
         "stats": {
           "reads_1m": 127,
           "writes_1m": 18,
           "takes_1m": 4,
           "avg_latency_ms": 12,
           "errors": 0
         }
       }

GET    /spaces/{spaceId}/entries?limit=50&offset=0&type=Task
       Response: EntryListResponse
       {
         "entries": [
           {
             "id": "entry-uuid",
             "type": "Task",
             "fields": {
               "status": "running",
               "agent": "agent-7",
               "progress": 0.65
             },
             "owner": "agent-7",
             "created_at": "2026-10-11T20:15:30Z",
             "expires_at": "2026-10-11T21:15:30Z",
             "size_bytes": 256
           }
         ],
         "total": 42,
         "limit": 50,
         "offset": 0
       }

GET    /spaces/{spaceId}/entries/{entryId}
       Response: EntryDetailResponse
       {
         "id": "entry-uuid",
         "type": "Task",
         "fields": {...},
         "owner": "agent-7",
         "transactions": ["txn-5a2f"],
         "created_at": "...",
         "expires_at": "...",
         "history": [
           {
             "event": "created",
             "timestamp": "...",
             "owner": "agent-7"
           },
           {
             "event": "read",
             "timestamp": "...",
             "owner": "agent-5"
           }
         ]
       }

GET    /spaces/{spaceId}/transactions
       Response: TransactionListResponse
       {
         "transactions": [
           {
             "id": "txn-5a2f",
             "owner": "agent-5",
             "created_at": "...",
             "expires_at": "...",
             "status": "active",
             "entries": ["entry-id-1", "entry-id-2"]
           }
         ]
       }

GET    /spaces/{spaceId}/waits
       Response: WaitListResponse
       {
         "waits": [
           {
             "id": "wait-uuid",
             "client": "agent-7",
             "template": {
               "type": "Message",
               "fields": {...}
             },
             "created_at": "...",
             "timeout_at": "...",
             "mode": "take"
           }
         ]
       }

GET    /agents
       Response: AgentListResponse
       {
         "agents": [
           {
             "id": "agent-7",
             "status": "running",
             "cpu_percent": 23,
             "memory_mb": 512,
             "uptime_seconds": 14312,
             "current_task": "Process messages",
             "progress": 0.65,
             "spaces": ["default", "workflows"],
             "last_activity": "2026-10-11T20:25:10Z"
           }
         ]
       }

GET    /agents/{agentId}
       Response: AgentDetailResponse
       {
         "id": "agent-7",
         "status": "running",
         "cpu_percent": 23,
         "memory_mb": 512,
         "uptime_seconds": 14312,
         "current_task": "Process messages",
         "progress": 0.65,
         "spaces": ["default", "workflows"],
         "last_activity": "2026-10-11T20:25:10Z",
         "errors_1m": 0,
         "restarts": 0,
         "connections": [
           {
             "type": "socket",
             "local": "/tmp/pi.sock",
             "remote": "agent-7@server"
           }
         ],
         "recent_ops": [
           {
             "type": "read",
             "space": "default",
             "timestamp": "...",
             "latency_ms": 8
           }
         ]
       }

GET    /clients
       Response: ClientListResponse
       {
         "clients": [
           {
             "id": "mobile-iphone",
             "type": "mobile",
             "status": "connected",
             "connection": "ssh_tunnel",
             "battery_percent": 87,
             "battery_charging": true,
             "storage_free_mb": 512,
             "last_activity": "2026-10-11T20:22:45Z"
           }
         ]
       }

GET    /metrics?period=1m
       Response: MetricsResponse
       {
         "period": "1m",
         "timestamp": "2026-10-11T20:25:10Z",
         "global": {
           "reads": 127,
           "writes": 18,
           "takes": 4,
           "errors": 0
         },
         "by_space": {
           "default": {
             "reads": 95,
             "writes": 15,
             "takes": 3
           },
           "workflows": {
             "reads": 32,
             "writes": 3,
             "takes": 1
           }
         },
         "by_client": {
           "agent-7": {
             "reads": 45,
             "writes": 8,
             "avg_latency_ms": 9
           },
           "agent-5": {
             "reads": 32,
             "writes": 2,
             "avg_latency_ms": 14
           }
         },
         "latencies": {
           "p50_ms": 8,
           "p95_ms": 18,
           "p99_ms": 24
         }
       }
```

### 2.2 WebSocket Events

```
Connection: WS /api/v1/live?auth_token=...

Client -> Server:
{
  "type": "subscribe",
  "channels": [
    "spaces:*",           // Alle Spaces
    "spaces:default",     // Bestimmter Space
    "agents:*",           // Alle Agents
    "clients:*",          // Alle Clients
    "metrics:1m"          // Metriken alle 1min
  ]
}

Server -> Client (Space Events):
{
  "type": "space_event",
  "space_id": "uuid",
  "event": "entry_written",
  "data": {
    "entry_id": "entry-uuid",
    "entry_type": "Task",
    "owner": "agent-7",
    "timestamp": "2026-10-11T20:25:10Z"
  }
}

Server -> Client (Agent Status):
{
  "type": "agent_status",
  "agent_id": "agent-7",
  "status": "running",
  "cpu_percent": 23,
  "memory_mb": 512,
  "current_task": "Process messages",
  "progress": 0.65,
  "timestamp": "2026-10-11T20:25:10Z"
}

Server -> Client (Metrics):
{
  "type": "metrics_update",
  "period": "1m",
  "global": {
    "reads": 127,
    "writes": 18,
    "errors": 0
  },
  "timestamp": "2026-10-11T20:25:00Z"
}

Server -> Client (Client Status):
{
  "type": "client_status",
  "client_id": "mobile-iphone",
  "status": "connected",
  "battery_percent": 87,
  "storage_free_mb": 512,
  "timestamp": "2026-10-11T20:25:10Z"
}
```

---

## 3. Backend-Implementierung

### 3.1 Service Layer (TypeScript/Node.js)

```typescript
// src/api/spaces.service.ts
import { SpaceService, type Call, type Reply } from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";

export class DashboardSpaceService {
  constructor(private harness: Harness, private spaceService: SpaceService) {}

  async getSpaces(): Promise<SpaceListResponse> {
    // Lese Registry und sammle alle Spaces
    const registry = await this.harness.snapshot(Registry);
    return {
      spaces: Object.entries(registry?.spaces || {}).map(([id, space]) => ({
        id,
        alias: Object.entries(registry?.aliases || {})
          .find(([_, spaceId]) => spaceId === id)?.[0],
        entries: space.entries?.length || 0,
        // ... weitere Statistiken
      }))
    };
  }

  async getSpaceDetail(spaceId: string): Promise<SpaceDetailResponse> {
    const space = await this.harness.snapshot(NamedSpace, spaceId);
    return {
      id: spaceId,
      entries: space?.entries?.length || 0,
      // ... weitere Details aus space.* Feldern
    };
  }

  async getSpaceEntries(
    spaceId: string,
    limit: number,
    offset: number,
    type?: string
  ): Promise<EntryListResponse> {
    const space = await this.harness.snapshot(NamedSpace, spaceId);
    let entries = space?.entries || [];
    
    if (type) {
      entries = entries.filter(e => e.type === type);
    }
    
    return {
      entries: entries
        .slice(offset, offset + limit)
        .map(e => ({
          id: e.id,
          type: e.type,
          fields: e.fields,
          owner: e.owner,
          // ...
        })),
      total: entries.length,
      limit,
      offset
    };
  }

  async getAgents(): Promise<AgentListResponse> {
    // Lese Agent-Daten aus dediziertem Space oder externem System
    // Könnte auch vom pi-serverd kommen
    return { agents: [...] };
  }

  async getMetrics(period: string): Promise<MetricsResponse> {
    // Aggregiere Metriken aus Meter (src/meter.ts)
    const meter = this.harness.meter;
    return {
      period,
      global: {
        reads: meter.get("reads"),
        writes: meter.get("writes"),
        // ...
      }
    };
  }
}
```

### 3.2 WebSocket Server

```typescript
// src/api/websocket.server.ts
import { WebSocketServer } from "ws";

export class DashboardWebSocketServer {
  private wss: WebSocketServer;
  private subscriptions = new Map<string, Set<string>>();

  constructor(
    private spaceService: DashboardSpaceService,
    private meter: Meter,
    port: number = 3001
  ) {
    this.wss = new WebSocketServer({ port });
    this.setupHandlers();
    this.startBroadcasters();
  }

  private setupHandlers() {
    this.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe") {
          this.subscribe(ws, msg.channels);
        }
      });

      ws.on("close", () => {
        this.subscriptions.delete(ws.toString());
      });
    });
  }

  private subscribe(ws: WebSocket, channels: string[]) {
    const clientId = ws.toString();
    this.subscriptions.set(clientId, new Set(channels));
  }

  private startBroadcasters() {
    // Broadcast Space Events (von SpaceService)
    this.spaceService.onSpaceEvent((event) => {
      this.broadcast("space_event", event, `spaces:${event.space_id}`);
      this.broadcast("space_event", event, "spaces:*");
    });

    // Broadcast Metrics periodisch
    setInterval(() => {
      const metrics = this.spaceService.getMetrics("1m");
      this.broadcast("metrics_update", metrics, "metrics:1m");
    }, 60000);

    // Broadcast Agent Status (polling oder Events)
    setInterval(async () => {
      const agents = await this.spaceService.getAgents();
      agents.forEach(agent => {
        this.broadcast("agent_status", agent, "agents:*");
        this.broadcast("agent_status", agent, `agents:${agent.id}`);
      });
    }, 5000);
  }

  private broadcast(type: string, data: any, channel: string) {
    for (const [clientId, channels] of this.subscriptions) {
      if (channels.has(channel) || channels.has("*")) {
        const ws = this.wss.clients
          .values()
          .find(w => w.toString() === clientId);
        if (ws) {
          ws.send(JSON.stringify({ type, ...data }));
        }
      }
    }
  }
}
```

### 3.3 HTTP Server / Express Integration

```typescript
// src/api/http.server.ts
import express from "express";

export function setupDashboardAPI(
  app: express.Application,
  spaceService: DashboardSpaceService
) {
  const router = express.Router();

  router.get("/spaces", async (req, res) => {
    res.json(await spaceService.getSpaces());
  });

  router.get("/spaces/:spaceId", async (req, res) => {
    res.json(await spaceService.getSpaceDetail(req.params.spaceId));
  });

  router.get("/spaces/:spaceId/entries", async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 1000);
    const offset = parseInt(req.query.offset as string) || 0;
    const type = req.query.type as string | undefined;
    
    res.json(await spaceService.getSpaceEntries(
      req.params.spaceId,
      limit,
      offset,
      type
    ));
  });

  router.get("/agents", async (req, res) => {
    res.json(await spaceService.getAgents());
  });

  router.get("/metrics", async (req, res) => {
    const period = req.query.period as string || "1m";
    res.json(await spaceService.getMetrics(period));
  });

  app.use("/api/v1", router);
}
```

---

## 4. Frontend-Implementierung

### 4.1 State Management (Redux/Pinia)

```typescript
// store/spaces.ts
import { defineStore } from "pinia";

export const useSpacesStore = defineStore("spaces", {
  state: () => ({
    spaces: [] as Space[],
    currentSpaceId: null as string | null,
    entries: [] as Entry[],
    isLoading: false,
    error: null as string | null
  }),

  actions: {
    async fetchSpaces() {
      this.isLoading = true;
      try {
        const response = await fetch("/api/v1/spaces");
        this.spaces = await response.json();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.isLoading = false;
      }
    },

    async selectSpace(spaceId: string) {
      this.currentSpaceId = spaceId;
      await this.fetchEntries();
    },

    async fetchEntries(limit = 50, offset = 0) {
      if (!this.currentSpaceId) return;
      const response = await fetch(
        `/api/v1/spaces/${this.currentSpaceId}/entries?limit=${limit}&offset=${offset}`
      );
      this.entries = (await response.json()).entries;
    },

    updateFromWebSocket(event: SpaceEvent) {
      if (event.type === "entry_written") {
        // Füge neuen Entry am Anfang der Liste ein
        this.entries.unshift(event.data);
      }
    }
  }
});

export const useAgentsStore = defineStore("agents", {
  state: () => ({
    agents: [] as Agent[],
    metrics: null as Metrics | null
  }),

  actions: {
    async fetchAgents() {
      const response = await fetch("/api/v1/agents");
      this.agents = await response.json();
    },

    updateFromWebSocket(event: AgentStatusEvent) {
      const agent = this.agents.find(a => a.id === event.agent_id);
      if (agent) {
        Object.assign(agent, {
          status: event.status,
          cpu_percent: event.cpu_percent,
          memory_mb: event.memory_mb,
          progress: event.progress
        });
      }
    },

    updateMetrics(metrics: Metrics) {
      this.metrics = metrics;
    }
  }
});
```

### 4.2 WebSocket Client Hook

```typescript
// hooks/useWebSocket.ts
import { useSpacesStore } from "@/store/spaces";
import { useAgentsStore } from "@/store/agents";

export function useWebSocket() {
  const spacesStore = useSpacesStore();
  const agentsStore = useAgentsStore();

  const connect = (authToken: string) => {
    const ws = new WebSocket(`ws://localhost:3001/api/v1/live?auth_token=${authToken}`);

    ws.onopen = () => {
      // Subscribe zu allen Channels
      ws.send(JSON.stringify({
        type: "subscribe",
        channels: [
          "spaces:*",
          "agents:*",
          "clients:*",
          "metrics:1m"
        ]
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "space_event":
          spacesStore.updateFromWebSocket(msg);
          break;
        case "agent_status":
          agentsStore.updateFromWebSocket(msg);
          break;
        case "metrics_update":
          agentsStore.updateMetrics(msg);
          break;
      }
    };

    return ws;
  };

  return { connect };
}
```

### 4.3 Vue Component Example

```vue
<!-- components/SpacePanel.vue -->
<template>
  <div class="space-panel">
    <h2>Space: {{ currentSpace?.alias }}</h2>
    
    <div class="stats">
      <StatCard label="Entries" :value="currentSpace?.entries" />
      <StatCard label="Types" :value="currentSpace?.types" />
      <StatCard label="Transactions" :value="currentSpace?.transactions?.active" />
      <StatCard label="Size" :value="`${currentSpace?.size_bytes} bytes`" />
    </div>

    <div class="entries-list">
      <h3>Entries (latest first)</h3>
      <div v-for="entry in entries" :key="entry.id" class="entry-item">
        <div class="entry-type">{{ entry.type }} [{{ entry.id }}]</div>
        <div class="entry-fields">{{ JSON.stringify(entry.fields) }}</div>
        <div class="entry-meta">{{ entry.owner }} · {{ entry.created_at }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useSpacesStore } from "@/store/spaces";

const spacesStore = useSpacesStore();

const currentSpace = computed(() => 
  spacesStore.spaces.find(s => s.id === spacesStore.currentSpaceId)
);

const entries = computed(() => spacesStore.entries);

onMounted(() => {
  spacesStore.fetchSpaces();
});
</script>

<style scoped>
.space-panel {
  padding: 20px;
  border: 1px solid #334155;
  border-radius: 8px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.entries-list {
  max-height: 600px;
  overflow-y: auto;
}

.entry-item {
  padding: 12px;
  border-left: 3px solid #3b82f6;
  margin-bottom: 8px;
  background: rgba(51, 65, 85, 0.3);
}
</style>
```

---

## 5. Event-Fluss

### 5.1 Entry Write Event

```
Agent schreibt Entry
  ↓
SpaceService.write() in src/service.ts
  ↓
Meter.inc("writes")
  ↓
SpaceEvent emitted
  ↓
DashboardSpaceService.onSpaceEvent() listener
  ↓
WebSocket broadcast "space_event"
  ↓
Browser WebSocket receives
  ↓
useSpacesStore.updateFromWebSocket()
  ↓
Vue Component re-renders mit neuem Entry
```

### 5.2 Agent Status Update

```
Agent Prozess läuft
  ↓
System Monitor pollt Agent-Stats (CPU, Memory, Task)
  ↓
DashboardSpaceService.updateAgentStatus()
  ↓
WebSocket broadcast "agent_status"
  ↓
Browser WebSocket receives
  ↓
useAgentsStore.updateFromWebSocket()
  ↓
Vue Component re-renders mit neuen Metrics
```

---

## 6. Implementierungs-Roadmap

### Phase 1: Grundstruktur (1-2 Wochen)
- [ ] Express Server mit API Endpoints
- [ ] WebSocket Server grundstruktur
- [ ] Redux/Pinia Store für Spaces und Agents
- [ ] Vue Components für Panels

### Phase 2: SpaceService Integration (1-2 Wochen)
- [ ] DashboardSpaceService mit echten Space-Daten
- [ ] Event Listeners für Space-Changes
- [ ] Metriken aus Meter aggregieren
- [ ] Agent Status Polling implementieren

### Phase 3: WebSocket Live Updates (1 Woche)
- [ ] WebSocket Broadcaster für Space Events
- [ ] WebSocket Broadcaster für Agent Status
- [ ] WebSocket Broadcaster für Metrics
- [ ] Frontend Listener alle Events verarbeiten

### Phase 4: UI Refinement (1 Woche)
- [ ] Detail-Ansichten implementieren
- [ ] Scroll und Pagination für Listen
- [ ] Filter und Search
- [ ] Performance Optimierungen

### Phase 5: Testing & Deployment (1 Woche)
- [ ] Unit Tests für Services
- [ ] Integration Tests für API
- [ ] E2E Tests für UI
- [ ] Dokumentation

---

## 7. Integration mit pi-serverd

Wenn das Dashboard auf pi-serverd läuft (mobile):

```typescript
// In pi-serverd.mjs:

// 1. Import DashboardSpaceService
import { DashboardSpaceService } from "./dashboard-service.mjs";

// 2. Nach startSpaceService():
const dashboardService = new DashboardSpaceService(
  harness,
  spaceService,
  meter
);

// 3. Starte HTTP + WebSocket Server
import { setupDashboardAPI } from "./dashboard-api.mjs";
const app = express();
setupDashboardAPI(app, dashboardService);

const server = http.createServer(app);
new DashboardWebSocketServer(
  dashboardService,
  meter,
  3001
);

server.listen(8080, () => {
  console.log("Dashboard API on http://localhost:8080");
  console.log("WebSocket on ws://localhost:3001");
});
```

---

## 8. Technologie Stack

| Layer | Technologie |
|-------|-------------|
| Backend | Node.js + TypeScript |
| HTTP Server | Express.js |
| WebSocket | ws library |
| State Management | Pinia (Vue 3) oder Redux (React) |
| UI Framework | Vue 3 oder React 18 |
| Styling | Tailwind CSS |
| Charts | Recharts oder Chart.js |
| Testing | Vitest + Testing Library |

---

## 9. Sicherheit

- Authentication via JWT Token in WebSocket URL
- Rate Limiting auf API Endpoints
- Input Validation für alle API Requests
- CORS Policy für Browser Requests
- TLS/WSS für Produktion

---

## 10. Performance Considerations

- Pagination für Entry Lists (max 50-100 pro Page)
- WebSocket Message Compression
- Frontend De-Duplication von Events
- Metric Aggregation auf Backend (nicht per Entry)
- IndexedDB für Local Caching auf Mobile
