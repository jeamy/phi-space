# Dashboard UI Implementation - Comprehensive Plan Summary

Alle Dateien für die Implementierung einer Live-Dashboard UI für phi-spaces.

> **Umsetzungsstand (Phase 1, implementiert):** Die erste Version ist als schreibgeschütztes Dashboard
> umgesetzt — [docs/dashboard.en.md](../../../dashboard.en.md), `src/dashboard.ts` + `src/dashboard/`,
> `npm run dashboard`. Bewusste Abweichungen von diesem Plan: keine neuen Abhängigkeiten (kein Express,
> kein `ws`, kein Vue/React, kein Chart.js) — stattdessen `node:http`, Server-Sent Events statt WebSocket,
> native Web Components und SVG-Sparklines; keine parallele `DashboardSpaceService`-API, sondern eine
> Projektion der vorhandenen `SpaceService`-Grenzen; kein JWT, sondern Loopback-Bindung und die
> vertrauenswürdige lokale Socket-Grenze. Die REST-Endpunkte sind nicht 1:1 übernommen: das Dashboard bedient `/api/spaces`, `/api/metrics`, `/api/live` (SSE), `/api/apps` sowie `/api/apps/{id}/history` und `/api/apps/{id}/entries` (ohne `/v1`).

## Überblick: Was wurde dokumentiert?

### Visuelle Mockups (5 PNG Dateien, 196 KB)
- ui-mockup-dashboard.png (46 KB) - Zentrale Kontrollzentrale
- ui-mockup-space-detail.png (38 KB) - Space Detailansicht
- ui-mockup-agents.png (35 KB) - Agent Monitoring
- ui-mockup-mobiles.png (38 KB) - Mobile Devices
- ui-mockup-metrics.png (37 KB) - Performance Dashboard

### Design-Dokumentation (2 Markdown Dateien)
1. **UI-MOCKUPS.md** (3 KB) - Galerie und Übersicht
2. **ui-dashboard.md** (7 KB) - Detaillierte Designdokumentation
   - Architektur (3-Panel-Layout)
   - Mockup-Beschreibungen
   - Interaktive Elemente
   - Farbschema
   - API-Anforderungen
   - Features

### Implementierungsplan (2 Markdown Dateien)
1. **ui-implementation-plan.md** (919 Zeilen, 24 KB)
   - Architektur-Übersicht
   - REST API Endpoints (vollständig spezifiziert)
   - WebSocket Events
   - Backend Services (TypeScript)
   - Frontend State Management (Vue/React)
   - WebSocket Client Hook
   - Vue Component Beispiele
   - Event Flows
   - 5-phasiger Implementierungs-Roadmap
   - Technologie Stack
   - Sicherheit & Performance

2. **ui-event-flows.md** (398 Zeilen, 20 KB)
   - Entry Write Flow
   - Agent Status Update Flow
   - Space Entry Query Flow
   - WebSocket Subscription & Live Updates
   - Multi-User Scenario
   - Mobile Device Connection
   - Error & Recovery Szenarien
   - High-Volume Entry Stream Optimierung

## Struktur: Wie läuft die Kommunikation?

```
┌────────────────────────────┐
│    Browser Dashboard       │
│  (Vue/React Components)    │
└────────────┬───────────────┘
             │
    ┌────────┴────────┐
    │                 │
    v                 v
 REST API         WebSocket
 /api/v1/        ws://...
    │                 │
    ├─────────────────┤
    │
    v
┌────────────────────────┐
│  Node.js Backend       │
│  - Express HTTP Server │
│  - WebSocket Server    │
│  - DashboardService    │
└────────────┬───────────┘
             │
    ┌────────┴────────┐
    │                 │
    v                 v
SpaceService     Meter
(phi-spaces)      (Metrics)
    │                 │
    ├─────────────────┤
    │
    v
┌────────────────────────┐
│  Space State           │
│  - Entries             │
│  - Transactions        │
│  - Waits/Notifications │
└────────────────────────┘
```

## API-Übersicht

### REST Endpoints
```
GET    /api/v1/spaces                          # Alle Spaces
GET    /api/v1/spaces/{spaceId}                # Space Details
GET    /api/v1/spaces/{spaceId}/entries        # Entries mit Pagination
GET    /api/v1/spaces/{spaceId}/entries/{id}   # Entry Details
GET    /api/v1/spaces/{spaceId}/transactions   # Transaktionen
GET    /api/v1/spaces/{spaceId}/waits          # Wartende Clients
GET    /api/v1/agents                          # Alle Agents
GET    /api/v1/agents/{agentId}                # Agent Details
GET    /api/v1/clients                         # Mobile Devices
GET    /api/v1/metrics?period=1m               # Performance Metriken
```

### WebSocket Messages
```
Client Subscribe:
{
  "type": "subscribe",
  "channels": ["spaces:*", "agents:*", "metrics:1m"]
}

Server Broadcasts:
{
  "type": "space_event",
  "space_id": "uuid",
  "event": "entry_written",
  "data": {...}
}

{
  "type": "agent_status",
  "agent_id": "agent-7",
  "status": "running",
  "cpu_percent": 23,
  ...
}

{
  "type": "metrics_update",
  "global": {
    "reads": 127,
    "writes": 18,
    ...
  }
}
```

## Implementation Roadmap

### Phase 1 (Woche 1-2): Grundstruktur
- Express Server + API Endpoints
- WebSocket Server Grundgerüst
- Redux/Pinia Store Setup
- Vue/React Component Struktur

### Phase 2 (Woche 3-4): Integration
- DashboardSpaceService mit echten Space-Daten
- Event Listeners für Space-Changes
- Metriken aus Meter aggregieren
- Agent Status Polling

### Phase 3 (Woche 5): Live Updates
- WebSocket Broadcaster für alle Event-Typen
- Frontend Event Listener
- Auto-Updates in UI

### Phase 4 (Woche 6): UI Polish
- Detail-Ansichten
- Pagination & Filter
- Search Funktionalität
- Performance Optimierungen

### Phase 5 (Woche 7): Testing & Launch
- Unit Tests
- Integration Tests
- E2E Tests
- Dokumentation & Deployment

## Schlüsseleigenschaften

### Echtzeit-Updates
- WebSocket für Live Space Events
- Agent Status alle 5s
- Metriken jede Minute
- Sub-100ms UI Update Latency

### Skalierbarkeit
- Pagination für große Entry-Listen
- Virtual Scrolling für Performance
- Batching von WebSocket Messages
- In-Memory Limits

### Benutzerfreundlichkeit
- 3-Panel-Layout (einfach & übersichtlich)
- Click-to-Detail Navigation
- Live Status Indikatoren
- Farbcodierung (grün/orange/rot)

### Zuverlässigkeit
- Automatischer WebSocket Reconnect
- Error Handling & Recovery
- Race Condition Handling
- Multi-User Szenarien

## Tech Stack (Vorschlag)

| Schicht | Technologie |
|---------|-------------|
| Backend HTTP | Express.js (Node.js) |
| Backend WebSocket | ws (WebSocket Library) |
| Frontend Framework | Vue 3 oder React 18 |
| State Management | Pinia (Vue) oder Redux (React) |
| Styling | Tailwind CSS |
| Charts | Recharts oder Chart.js |
| HTTP Client | Axios oder Fetch API |
| Testing | Vitest + Testing Library |

## Integration mit pi-serverd

Das Dashboard kann direkt auf pi-serverd laufen:

```typescript
// In pi-serverd.mjs:

import { DashboardSpaceService } from "./dashboard-service.mjs";
import { setupDashboardAPI } from "./dashboard-api.mjs";

const dashboardService = new DashboardSpaceService(
  harness,
  spaceService,
  meter
);

const app = express();
setupDashboardAPI(app, dashboardService);
app.listen(8080);

new DashboardWebSocketServer(dashboardService, meter, 3001);
```

Zugänglich unter:
- HTTP: http://localhost:8080
- WebSocket: ws://localhost:3001

## Sicherheit

- JWT Token Auth für WebSocket
- Rate Limiting auf API
- Input Validation
- CORS Policy
- TLS/WSS in Produktion

## Performance Targets

- API Response Time: < 100ms
- WebSocket Broadcast Latency: < 50ms
- UI Update Latency: < 100ms (vom Event zum Render)
- Memory per Browser: < 50 MB
- Supported Events/sec: 1000+

## Nächste Schritte

1. **Anforderungs-Workshop** mit Team
   - Bestätigen von Feature Set
   - Tech Stack Entscheidung
   - Design Review

2. **Proof of Concept** (1 Woche)
   - Basic API + WebSocket
   - Hello World Component
   - Space Data Binding

3. **Beta Release** (4 Wochen)
   - Vollständige API
   - Alle Mockups implementiert
   - Testing & Bugfixes

4. **Production Release** (1 Woche)
   - Performance Optimization
   - Security Hardening
   - Documentation

## Dateien in docs/_attic/ui-mockups/

```
ui-implementation-plan.md       (919 Zeilen) - Vollständiger Implementierungsplan
ui-event-flows.md               (398 Zeilen) - Sequenzdiagramme & Flows
ui-dashboard.md                 (7 KB) - Design-Dokumentation
UI-MOCKUPS.md                              (3 KB) - Galerie
UI-PLAN-SUMMARY.md             (diese Datei)

ui-mockup-dashboard.png                    (46 KB) - Dashboard Overview
ui-mockup-space-detail.png                 (38 KB) - Space Details
ui-mockup-agents.png                       (35 KB) - Agent Monitoring
ui-mockup-mobiles.png                      (38 KB) - Mobile Devices
ui-mockup-metrics.png                      (37 KB) - Performance Metrics
```

## Kontakt & Fragen

Für Fragen oder Änderungen:
- Siehe ui-implementation-plan.md für API Details
- Siehe ui-event-flows.md für technische Flows
- Siehe UI-MOCKUPS.md für Design Galerie
