# phi-spaces Live Dashboard UI Mockup

An overview of a real-time web interface that visualizes Spaces, clients, agents and mobile devices.

> **Implementation status:** Draft; the read-only Phase 1 is implemented (Spaces, metrics, apps; Server-Sent Events instead of WebSocket) — see [docs/dashboard.en.md](../../dashboard.en.md). Agent, mobile and transaction views, search and export are not built.

## Architektur

The dashboard UI shows a **3-panel layout**:

```
┌─────────────────────────────────────────────────────────────────┐
│                        LIVE DASHBOARD                      ● LIVE│
├─────────────────┬──────────────────────────────┬─────────────────┤
│                 │                              │                 │
│  Left Panel     │    Main Panel (Spaces)       │  Right Panel    │
│  - Spaces       │    - Stats & Metrics         │  - Agents       │
│  - Clients      │    - Space Entries List      │  - Mobiles      │
│  - Connected    │    - Live Data (↓ scroll)    │  - Status       │
│                 │                              │                 │
└─────────────────┴──────────────────────────────┴─────────────────┘
```

## Mockups

### 1. **Dashboard Overview** 
`ui-mockup-dashboard.png`

**Purpose:** Central overview of all resources in live mode.

**Contents:**
- **Left column (Spaces & Clients):**
  - List of all Spaces with status (green dot = active)
  - Number of entries and connected clients per Space
  - Connected clients with last activity
  - Status: online (green), idle (orange), offline (red)

- **Middle column (Space Details):**
  - Statistics of the active Space (entries, types, transactions, size)
  - Metrics: reads/writes per minute, average latency, errors
  - Live list of the latest entries
  - **Clickable:** Every Space is clickable → shows a detailed view

- **Right column (Agents & Mobiles):**
  - List of agents with status and resource usage
  - Mobile devices (Termux) with connection status and battery
  - Quick overview of all clients

---

### 2. **Space Detail View**
`ui-mockup-space-detail.png`

**Purpose:** In-depth analysis of a single Space (after clicking "workflows", "default", etc.)

**Contents:**
- **Workflows Space Section:**
  - Active and waiting transactions
  - Incoming waits (clients waiting for entries)
  - Memory usage and last activity
  - Transaction locks (who locks what, for how long)

- **Entry Types Section:**
  - Overview of the entry types in the Space
  - Count per type, owner (agent or client)
  - Examples: TaskUpdate, Message, Result, Cache

- **Recent Events Section:**
  - Chronological logs of writes, reads, takes
  - Timestamps and clients involved
  - Transaction IDs for tracing

- **Notifications Section:**
  - Registered waits (clients waiting for events)
  - Notify subscriptions with TTL (time to live)

---

### 3. **Agents Detail View**
`ui-mockup-agents.png`

**Purpose:** Monitoring of agents and system services.

**Contents:**
- **Agent Status Panels (e.g. "agent-7"):**
  - CPU, memory, running task with progress
  - Spaces the agent has access to
  - Error rate and load 1m
  
- **Agent Status Panels (e.g. "agent-5"):**
  - Idle state, when last active
  - Space access, uptime and restarts
  
- **Connections Panel:**
  - SSH tunnels to mobiles
  - Unix socket connections
  - Remote sessions
  
- **System Health Panel:**
  - Total size of all Spaces
  - Transaction slot utilization
  - Event queue status

---

### 4. **Mobile Devices View**
`ui-mockup-mobiles.png`

**Purpose:** Management and monitoring of Termux instances on mobiles.

**Contents:**
- **Device Panels (e.g. "iPhone 15"):**
  - Connection type (SSH tunnel, VPN, local)
  - pi-serverd status (running, sleeping)
  - Battery, storage
  - Spaces on which data is available
  
- **Status Indicators:**
  - Green = online and active
  - Orange = idle (standby)
  - Red = offline
  
- **Recent Activity Panel:**
  - Latest operations (read, write, sync)
  - Timestamps and Spaces
  - Helps to see which devices are active

---

### 5. **Metrics & Performance View**
`ui-mockup-metrics.png`

**Purpose:** Real-time monitoring of performance and load.

**Contents:**
- **Operations Per Minute:**
  - Reads, writes, takes with average latency
  - Error rate
  
- **Space Utilization:**
  - Entry count vs. limit
  - Memory usage
  - Transaction slot utilization
  - Pending waits
  
- **Per-Client Metrics:**
  - Operations per minute per agent/client
  - Average latency per client
  
- **System Health:**
  - Uptime, crash log
  - Garbage collection pauses
  - Disk I/O

---

## Interactivity

### Click Actions

| Element | Action | Target |
|---------|--------|------|
| **Space name** (e.g. "default", "workflows") | Click | Opens the Space detail view |
| **Client name** (e.g. "agent-7", "mobile-iphone") | Click | Opens the client status panel with logs |
| **Entry** in list | Click | Shows the full entry data and transaction history |
| **Transaction ID** (e.g. "txn-5a2f") | Click | Shows all entries of this transaction |

### Live Updates

- **Automatic refresh:** All panels update in real time (WebSocket)
- **Status indicators:** Colored pulses for activity (green dots blink on activity)
- **Notifications:** Notifications for errors, crashes, timeouts
- **Scrollable lists:** Entries with infinite scroll or pagination

---

## Color Scheme

```
Background:     #0f172a (very dark blue)
Panels:         #1e293b (dark blue at 80% opacity)
Borders:        #334155 (grey)
Text Primary:   #e2e8f0 (light grey)
Text Muted:     #94a3b8 (medium grey)
Accent:         #3b82f6 (blue)
Success:        #10b981 (green)
Warning:        #f59e0b (orange)
Error:          #ef4444 (red)
```

---

## Technology Stack (Proposal)

- **Frontend:** React or Vue.js
- **Live Updates:** WebSocket (or Server-Sent Events)
- **Charts:** Recharts, Chart.js or D3.js for metrics
- **State:** Redux or Pinia for global state
- **Styling:** Tailwind CSS or CSS-in-JS

---

## API Requirements

The UI needs the following endpoints:

```
GET  /api/spaces                    # All Spaces + stats
GET  /api/spaces/{id}               # Space details
GET  /api/spaces/{id}/entries       # Entries with pagination
GET  /api/agents                    # All agents
GET  /api/agents/{id}               # Agent details
GET  /api/clients                   # All clients
GET  /api/mobiles                   # Mobile Devices
WS   /api/live                      # WebSocket for real-time updates
```

---

## Features to Implement

- [ ] Dashboard Overview (3-panel layout)
- [ ] Real-time updates via WebSocket
- [ ] Detail views for Spaces
- [ ] Agent/client monitoring
- [ ] Mobile device management
- [ ] Performance metrics & graphs
- [ ] Entry inspector (show full data)
- [ ] Transaction tracker (show history)
- [ ] Search & filter (by entry type, client, etc.)
- [ ] Dark/Light Mode Toggle
- [ ] Export (logs, metrics as CSV/JSON)
