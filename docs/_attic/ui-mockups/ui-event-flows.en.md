# UI Event Flows: Detailed Sequences

> **Implementation status:** This document is a draft. Only the read-only dashboard is implemented — see [docs/dashboard.en.md](../../dashboard.en.md) (`src/dashboard.ts`, `npm run dashboard`: `node:http`, Server-Sent Events instead of WebSocket, no frameworks). Express, `ws`, JWT, `DashboardSpaceService` and the pi-durable calls below are not going to be built.


Detailed sequence diagrams for the communication between Spaces and the dashboard.

## 1. Entry Write Flow

```
Agent          SpaceService      Meter         Dashboard         WebSocket         Browser
 |                 |              |             Service          Server            State
 |                 |              |               |                |                 |
 +--write()------->|               |               |                |                 |
 |                 |               |               |                |                 |
 |                 +--inc("writes")--->|          |                |                 |
 |                 |               |               |                |                 |
 |                 |--emit("entry_written")------->|                |                 |
 |                 |               |               |                |                 |
 |                 |               |               +--broadcast("space_event")------>|
 |                 |               |               |                |                 |
 |                 |               |               |                +--send()-------->|
 |                 |               |               |                |                 |
 |                 |               |               |                |       +----updateFromWebSocket()
 |                 |               |               |                |       |         |
 |                 |               |               |                |       +------->|
 |                 |               |               |                |                 |
 |<--------done-----+               |               |                |       +-----re-render()
 |                 |               |               |                |       |         |
 |                 |               |               |                |       +------->|
 |                 |               |               |                |                 |
```

**Timeline:**
1. Agent calls `space.write()`
2. SpaceService processes it, emits an `entry_written` event
3. Meter.inc("writes") increments the counter
4. DashboardSpaceService receives the event
5. WebSocket server broadcasts to all connected clients
6. Browser receives it over WebSocket
7. Redux/Pinia store updates
8. Vue/React components re-render

**Latency Budget:**
- Agent -> SpaceService: < 1ms
- SpaceService -> Meter: < 0.1ms
- Meter -> DashboardService: < 1ms (event listener)
- DashboardService -> WebSocket: < 1ms
- WebSocket -> Browser: 10-100ms (network)
- Browser Store -> UI: < 5ms (React/Vue)
- **Total: 15-110ms until the UI is updated**

---

## 2. Agent Status Update Flow

```
System Monitor    Agent Process    DashboardService   WebSocket      Browser
     |                 |                  |            Server         Store
     |                 |                  |              |              |
     +--poll()-------->|                  |              |              |
     |                 |                  |              |              |
     |<---metrics------+                  |              |              |
     |  (cpu, mem)     |                  |              |              |
     |                 |                  |              |              |
     +--updateAgentStatus()------+       |              |              |
     |                 |         |       |              |              |
     |                 |         +--broadcast("agent_status")-------->|
     |                 |         |       |              |              |
     |                 |         |       +--send()----->|              |
     |                 |         |       |              |              |
     |                 |         |       |       +---updateAgentStore()
     |                 |         |       |       |      |              |
     |                 |         |       |       +----->|              |
     |                 |         |       |              |              |
     |                 |         |       |       +---------re-render()
     |                 |         |       |       |      |              |
     |                 |         |       |       +----->|              |
     |                 |         |       |              |              |
     |<-----repeat-----+         |       |              |              |
     | (every 5s)     |         |       |              |              |
     |                 |                  |              |              |
```

**Components:**
- **System Monitor:** Polls agent metrics every 5s
- **DashboardService:** Aggregates and sends updates
- **WebSocket Server:** Broadcasts to all clients
- **Browser Store:** Updates agent status
- **UI:** Re-renders the agent panel with new data

**Update frequencies:**
- CPU/Memory: 5s
- Current task: 5s (or event-driven)
- Errors: immediately (event-driven)
- Uptime: 1s (calculated from timestamp)

---

## 3. Space Entry Query Flow (Initial Load)

```
Browser UI          Store           HTTP API      DashboardService    Harness
   |                  |               |                 |               |
   +-load()-----------+                |                 |               |
   |                  |                |                 |               |
   |                  +-GET /spaces----->|                 |               |
   |                  |                |                 |               |
   |                  |                +--getSpaces()------>|             |
   |                  |                |                 |               |
   |                  |                |                 +--snapshot()---->|
   |                  |                |                 |               |
   |                  |                |                 |<--Registry----+
   |                  |                |                 |               |
   |                  |<----200 OK-----+                 |               |
   |                  | [spaces]       |                 |               |
   |                  |                |                 |               |
   |<--data-----------+                |                 |               |
   |                  |                |                 |               |
   +-click space------+                |                 |               |
   |                  |                |                 |               |
   |                  +-GET /spaces/{id}/entries?limit=50
   |                  |                |                 |               |
   |                  |                +--getEntries()---->|             |
   |                  |                |                 |               |
   |                  |                |                 +--snapshot()---->|
   |                  |                |                 |               |
   |                  |                |                 |<--Entries----+
   |                  |                |                 |               |
   |                  |<----200 OK-----+                 |               |
   |                  | [entries]      |                 |               |
   |                  |                |                 |               |
   |<--entries-------+                |                 |               |
   |                  |                |                 |               |
   +-render----------+                |                 |               |
   |                  |                |                 |               |
```

**Optimizations:**
1. **Caching:** Cache the Spaces list for 5s
2. **Pagination:** Load only 50 entries initially
3. **Lazy load:** Detail data on demand
4. **Compression:** GZIP for API responses

---

## 4. WebSocket Subscription & Live Updates

```
Browser          WebSocket Connection     Server Router    DashboardService
  |                      |                    |                   |
  +--open()-----------+   |                    |                   |
  |                   |   |                    |                   |
  |                   +---handshake--------->  |                   |
  |                   |   |                    |                   |
  |                   |<------accept-----------+                   |
  |                   |   |                    |                   |
  +--send()----------+    |                    |                   |
  | subscribe msg   |    |                    |                   |
  |                   |   +---route--------->  |                   |
  |                   |   |                    +--addSubscriber()--+
  |                   |   |                    |                   |
  |                   |   |<---subscribed-----+                   |
  |                   |   |                    |                   |
  |  (waiting...)     |   |                    |                   |
  |                   |   |                    |                   |
  | Agent writes     (in separate thread)     |                   |
  |                   |   |                    |        event      |
  |                   |   |<-- broadcast(event) <---emitted--------+
  |                   |   |                    |                   |
  |<----message------+    |                    |                   |
  | {type, data}    |   |                    |                   |
  |                   |   |                    |                   |
  +-process()--------+   |                    |                   |
  |                   |   |                    |                   |
  +-updateStore()    |   |                    |                   |
  |                   |   |                    |                   |
  +-render()        |   |                    |                   |
  |                   |   |                    |                   |
```

**WebSocket lifecycle:**
1. Browser opens the WebSocket connection
2. Sends a `subscribe` message with channels
3. Server confirms the subscription
4. Server sends events as soon as they occur
5. Browser processes them and re-renders
6. On disconnect: automatic reconnect with backoff

**Channel pattern:**
- `spaces:*` → all Spaces
- `spaces:{id}` → a specific Space
- `agents:*` → all agents
- `agents:{id}` → a specific agent
- `metrics:*` → all metrics
- `clients:*` → all mobile devices

---

## 5. Multi-User Scenario

```
Agent 1          Agent 2          Space State      DashboardService     UI Browser1    UI Browser2
  |                |                  |                  |               |              |
  +-write()---->   |                  |                  |               |              |
  |                |                  |                  |               |              |
  |                |              +---store entry----->  |               |              |
  |                |              |    |                 |               |              |
  |                |              |    +--emit()------->  |               |              |
  |                |              |    |                 |               |              |
  |                |              |    |       +---broadcast("space_event")------------>|
  |                |              |    |       |         |       +-----broadcast()-----+->|
  |                |              |    |       |         |       |     |              |
  |                |              |    |       |         |       +---->| update      |
  |                |              |    |       |         |       |     | & render    |
  |                |              |    |       |         |       |     |              |
  |                +-take()------>|    |       |         |       |     |              |
  |                |              |    |       |         |       |     |              |
  |                |          +---remove--------->       |       |     |              |
  |                |          |    |       +----broadcast("space_event")------------>|
  |                |          |    |       |   |       |       |     |              |
  |                |          |    |       |   |       |       |     |    update    |
  |                |          |    |       |   |       |       |     | +  render    |
  |                |          |    |       |   |       |       |     | |            |
  |<--entry--------+          |    |       |   |       |       |     | |            |
  |                |<--done----+   |       |   |       |       |     | |            |
  |                |          |    |       |   |       |       |     | |            |
  |                |          |    |       |   |       |       |     | |            |
  +--take()--------+          |    |       |   |       |       |     | |            |
  |                |          |    |       |   |       |       |     | |            |
  |                +-error!---+    |       |   |       |       |     | |            |
  |                  (already       |       |   |       |       |     | |            |
  |                   taken)        |       |   |       |       |     | |            |
  |                |          |    |       |   |       |       |     | |            |
```

**Scenario:**
1. Agent 1 writes an entry (both browsers see the update)
2. Agent 2 takes the entry (take removes it from the Space)
3. Both browsers are notified
4. If Agent 2's take was already in flight: error handling needed

**Conflict resolution:**
- Optimistic update: the UI displays immediately
- Revert on error: change back on conflict
- Event sourcing: track all changes

---

## 6. Mobile Device Connection

```
Mobile Device         pi-serverd       DashboardService      WebSocket      Dashboard UI
  |                      |                   |                   |              |
  +--connect SSH------+   |                   |                   |              |
  |  port forward     |   |                   |                   |              |
  |                   +   |                   |                   |              |
  |                   |   |                   |                   |              |
  |<--unix socket-----+   |                   |                   |              |
  |  /tmp/pi.sock     |   |                   |                   |              |
  |                   |   |                   |                   |              |
  +-write entry-------->  |                   |                   |              |
  |                   |   |                   |                   |              |
  |                   +---emit(event)------->  |                   |              |
  |                   |   |                   |                   |              |
  |                   |   |       +---broadcast()-------+           |              |
  |                   |   |       |   |                 |           |              |
  |                   |   |       |   |       +---send WebSocket msg----------->|
  |                   |   |       |   |       |         |           |              |
  |                   |   |       |   |       |         |       +-render + update
  |                   |   |       |   |       |         |       |   |              |
  |                   |   |       |   |       |         |       +-->|              |
  |                   |   |       |   |       |         |           |              |
  |<--ACK-------------+   |       |   |       |         |           |              |
  |                   |   |       |   |       |         |           |              |
  | (battery check)   |   |       |   |       |         |           |              |
  |<-- battery: 87%---+   |       |   |       |         |           |              |
  |                   |   |       |   |       |         |           |              |
```

**Mobile specifics:**
- SSH tunnel to get through the firewall
- Periodic battery/storage checks
- Offline detection
- Reconnect with backoff

---

## 7. Error & Recovery Scenarios

```
Scenario 1: Network Disconnect
─────────────────────────────
Browser          WebSocket          Server
  |                 |                 |
  +-connected------+                 |
  |  send msg      |                 |
  |                 +---message----->|
  |<---ACK---------+                 |
  |                 |                 |
  | [network dies]  |                 |
  |                 |  [timeout]      |
  |<---close-------+                 |
  |                 |                 |
  +-reconnect------+ [with backoff: 1s, 2s, 4s, 8s, 16s]
  |                 |                 |
  +---new conn-----+                 |
  |                 +--re-handshake-->|
  |<---ACK---------+                 |
  |                 |                 |
  | [re-subscribe]  |                 |
  |                 |                 |
  +---subscribe----+                 |
  |                 +--subscription-->|
  |<---confirm-----+                 |
  |                 |                 |
  | (continue)      |                 |
  |                 |                 |


Scenario 2: Race Condition
──────────────────────────
Agent 1          Agent 2          Space            WebSocket
  |                |                |               |
  +-read()----+   |                |               |
  |           |   |                |               |
  |           +---[lock]--------->  |               |
  |           |   |                |               |
  |<--entry---+   |                |               |
  |           |   +-read()----+    |               |
  |           |   |           +---[wait lock]---->
  |           |   |           |    |               |
  |           +---[unlock]----+    |               |
  |           |   |           |    |               |
  |           |   |<----------+    |               |
  |           |   |                |               |
  | [write]   |   |                |               |
  +-write()---+   |                |               |
  |           +---[lock]--------->  |               |
  |           |                +--broadcast()----->|
  |           +---[unlock]----------+               |
  |           |   |                |               |
```

**Handling:**
- Pessimistic locking: only one operation at a time
- Optimistic concurrency: version checks
- MVCC: multi-version concurrency control
- Retry with backoff on conflicts

---

## 8. Performance: High-Volume Entry Stream

```
Scenario: 1000 writes/min in Space
─────────────────────────────────

Timeline (10s):
  Sec 0-1:   ~16 writes -> Entries += 16
             WebSocket sends 16 messages
             Browser processes 16 updates
  
  Sec 1-2:   ~17 writes (slightly bursty)
             ...
  
  ...
  
  Sec 9-10:  ~18 writes
             ...

Problem 1: Too many WebSocket messages
Solution: Batch events
  - Aggregate writes every 100ms
  - Send: {type: "entries_written", count: 16, latest: [...top 3]}

Problem 2: React re-renders on every update
Solution: Optimize rendering
  - Virtual scrolling (only visible entries)
  - Memoization of Components
  - Virtualized lists (react-window, vue-virtual-list)

Problem 3: Memory in Browser
Solution: Limit list in memory
  - Keep only last 500 entries
  - Older ones on-demand from server

Optimized Timeline:
  Sec 0-1:   16 writes -> WebSocket batches -> 1 message
             Browser: merge 16 items into list
             Re-render only visible items (e.g. 10)
             
  Sec 1-2:   17 writes -> 1 batched message
             ...
```

**Optimization metrics:**
- Batch size: 100-500 events per batch
- Batch interval: 100ms
- Virtual scroll window: 50 items visible
- Memory limit: 1000 entries in memory
