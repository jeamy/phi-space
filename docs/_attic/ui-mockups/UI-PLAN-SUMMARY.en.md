# Dashboard UI Implementation - Comprehensive Plan Summary

All files for implementing a live dashboard UI for phi-spaces.

> **Implementation status (Phase 1, implemented):** The first version is implemented as a read-only
> dashboard — [docs/dashboard.en.md](../../dashboard.en.md), `src/dashboard.ts` + `src/dashboard/`,
> `npm run dashboard`. Deliberate deviations from this plan: no new dependencies (no Express,
> no `ws`, no Vue/React, no Chart.js) — instead `node:http`, Server-Sent Events instead of WebSocket,
> native web components and SVG sparklines; no parallel `DashboardSpaceService` API, but a
> projection of the existing `SpaceService` boundaries; no JWT, but loopback binding and the
> trusted local socket boundary. The REST endpoints were not taken over 1:1: the dashboard serves `/api/spaces`, `/api/metrics`, `/api/live` (SSE), `/api/apps` as well as `/api/apps/{id}/history` and `/api/apps/{id}/entries` (without `/v1`).

## Overview: What Was Documented?

### Visual Mockups (5 PNG files, 196 KB)
- ui-mockup-dashboard.png (46 KB) - Central control room
- ui-mockup-space-detail.png (38 KB) - Space detail view
- ui-mockup-agents.png (35 KB) - Agent Monitoring
- ui-mockup-mobiles.png (38 KB) - Mobile Devices
- ui-mockup-metrics.png (37 KB) - Performance Dashboard

### Design Documentation (2 Markdown files)
1. **UI-MOCKUPS.en.md** (3 KB) - Gallery and overview
2. **ui-dashboard.en.md** (7 KB) - Detailed design documentation
   - Architecture (3-panel layout)
   - Mockup descriptions
   - Interactive elements
   - Color scheme
   - API requirements
   - Features

### Implementation Plan (2 Markdown files)
1. **ui-implementation-plan.en.md** (919 lines, 24 KB)
   - Architecture overview
   - REST API endpoints (fully specified)
   - WebSocket events
   - Backend services (TypeScript)
   - Frontend state management (Vue/React)
   - WebSocket client hook
   - Vue component examples
   - Event flows
   - 5-phase implementation roadmap
   - Technology stack
   - Security & performance

2. **ui-event-flows.en.md** (398 lines, 20 KB)
   - Entry write flow
   - Agent status update flow
   - Space entry query flow
   - WebSocket subscription & live updates
   - Multi-user scenario
   - Mobile device connection
   - Error & recovery scenarios
   - High-volume entry stream optimization

## Structure: How Does Communication Work?

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

## API Overview

### REST Endpoints
```
GET    /api/v1/spaces                          # All Spaces
GET    /api/v1/spaces/{spaceId}                # Space details
GET    /api/v1/spaces/{spaceId}/entries        # Entries with pagination
GET    /api/v1/spaces/{spaceId}/entries/{id}   # Entry details
GET    /api/v1/spaces/{spaceId}/transactions   # Transactions
GET    /api/v1/spaces/{spaceId}/waits          # Waiting clients
GET    /api/v1/agents                          # All agents
GET    /api/v1/agents/{agentId}                # Agent details
GET    /api/v1/clients                         # Mobile devices
GET    /api/v1/metrics?period=1m               # Performance metrics
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

### Phase 1 (week 1-2): Basic structure
- Express server + API endpoints
- WebSocket server skeleton
- Redux/Pinia store setup
- Vue/React component structure

### Phase 2 (week 3-4): Integration
- DashboardSpaceService with real Space data
- Event listeners for Space changes
- Aggregate metrics from Meter
- Agent status polling

### Phase 3 (week 5): Live updates
- WebSocket broadcaster for all event types
- Frontend event listener
- Auto-updates in the UI

### Phase 4 (week 6): UI polish
- Detail views
- Pagination & filters
- Search functionality
- Performance optimizations

### Phase 5 (week 7): Testing & launch
- Unit tests
- Integration tests
- E2E tests
- Documentation & deployment

## Key Properties

### Real-time updates
- WebSocket for live Space events
- Agent status every 5s
- Metrics every minute
- Sub-100ms UI update latency

### Scalability
- Pagination for large entry lists
- Virtual scrolling for performance
- Batching of WebSocket messages
- In-memory limits

### Usability
- 3-panel layout (simple & clear)
- Click-to-detail navigation
- Live status indicators
- Color coding (green/orange/red)

### Reliability
- Automatic WebSocket reconnect
- Error handling & recovery
- Race condition handling
- Multi-user scenarios

## Tech Stack (Proposal)

| Layer | Technology |
|---------|-------------|
| Backend HTTP | Express.js (Node.js) |
| Backend WebSocket | ws (WebSocket Library) |
| Frontend Framework | Vue 3 or React 18 |
| State Management | Pinia (Vue) or Redux (React) |
| Styling | Tailwind CSS |
| Charts | Recharts or Chart.js |
| HTTP Client | Axios or Fetch API |
| Testing | Vitest + Testing Library |

## Integration with pi-serverd

The dashboard can run directly on pi-serverd:

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

Reachable at:
- HTTP: http://localhost:8080
- WebSocket: ws://localhost:3001

## Security

- JWT token auth for WebSocket
- Rate limiting on the API
- Input validation
- CORS policy
- TLS/WSS in production

## Performance Targets

- API response time: < 100ms
- WebSocket broadcast latency: < 50ms
- UI Update Latency: < 100ms (from event to render)
- Memory per browser: < 50 MB
- Supported events/sec: 1000+

## Next Steps

1. **Requirements workshop** with the team
   - Confirm the feature set
   - Tech stack decision
   - Design review

2. **Proof of concept** (1 week)
   - Basic API + WebSocket
   - Hello World Component
   - Space Data Binding

3. **Beta release** (4 weeks)
   - Complete API
   - All mockups implemented
   - Testing & bug fixes

4. **Production release** (1 week)
   - Performance optimization
   - Security hardening
   - Documentation

## Files in docs/_attic/ui-mockups/

```
ui-implementation-plan.en.md       (919 lines) - Complete implementation plan
ui-event-flows.en.md               (398 lines) - Sequence diagrams & flows
ui-dashboard.en.md                 (7 KB) - Design documentation
UI-MOCKUPS.en.md                              (3 KB) - Gallery
UI-PLAN-SUMMARY.en.md             (this file)

ui-mockup-dashboard.png                    (46 KB) - Dashboard Overview
ui-mockup-space-detail.png                 (38 KB) - Space Details
ui-mockup-agents.png                       (35 KB) - Agent Monitoring
ui-mockup-mobiles.png                      (38 KB) - Mobile Devices
ui-mockup-metrics.png                      (37 KB) - Performance Metrics
```

## Contact & Questions

For questions or changes:
- See ui-implementation-plan.en.md for API details
- See ui-event-flows.en.md for technical flows
- See UI-MOCKUPS.en.md for the design gallery
