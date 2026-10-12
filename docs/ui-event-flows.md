# UI Event Flows: Detailed Sequences

Detaillierte Sequenzdiagramme für die Kommunikation zwischen Spaces und Dashboard.

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

**Zeittafel:**
1. Agent ruft `space.write()` auf
2. SpaceService verarbeitet, emitted `entry_written` Event
3. Meter.inc("writes") inkrementiert Counter
4. DashboardSpaceService empfängt Event
5. WebSocket Server broadcastet zu allen verbundenen Clients
6. Browser empfängt über WebSocket
7. Redux/Pinia Store aktualisiert
8. Vue/React Components re-rendern

**Latency Budget:**
- Agent -> SpaceService: < 1ms
- SpaceService -> Meter: < 0.1ms
- Meter -> DashboardService: < 1ms (event listener)
- DashboardService -> WebSocket: < 1ms
- WebSocket -> Browser: 10-100ms (Netzwerk)
- Browser Store -> UI: < 5ms (React/Vue)
- **Total: 15-110ms bis UI aktualisiert**

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

**Komponenten:**
- **System Monitor:** Pollt Agent-Metriken alle 5s
- **DashboardService:** Aggregiert und versendet Updates
- **WebSocket Server:** Broadcastet zu allen Clients
- **Browser Store:** Aktualisiert Agent-Status
- **UI:** Re-rendert Agent Panel mit neuen Daten

**Update-Häufigkeiten:**
- CPU/Memory: 5s
- Current Task: 5s (oder event-driven)
- Errors: Sofort (event-driven)
- Uptime: 1s (von Timestamp kalkuliert)

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

**Optimierungen:**
1. **Caching:** Spaces List 5s cachen
2. **Pagination:** Nur 50 Entries initial laden
3. **Lazy Load:** Detail-Daten on-demand
4. **Compression:** GZIP für API Responses

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

**WebSocket Lifecycle:**
1. Browser öffnet WebSocket Connection
2. Sendet `subscribe` Message mit Channels
3. Server bestätigt Subscription
4. Server sent Events sobald sie eintreten
5. Browser verarbeitet und re-rendert
6. Bei Disconnect: Automatischer Reconnect mit Backoff

**Channel-Pattern:**
- `spaces:*` → Alle Spaces
- `spaces:{id}` → Bestimmter Space
- `agents:*` → Alle Agents
- `agents:{id}` → Bestimmter Agent
- `metrics:*` → Alle Metriken
- `clients:*` → Alle Mobile Devices

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

**Szenario:**
1. Agent 1 schreibt Entry (beide Browsers sehen Update)
2. Agent 2 nimmt Entry (Take entfernt aus Space)
3. Beide Browsers werden benachrichtigt
4. Wenn Agent 2 Take bereits in-flight war: Error handling nötig

**Konflikt-Resolution:**
- Optimistic Update: UI zeigt sofort an
- Revert on Error: Bei Konflikt zurück ändern
- Event-Sourcing: Alle Changes tracken

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

**Mobile Besonderheiten:**
- SSH Tunnel für Firewall-Durchbruch
- Periodische Battery/Storage Checks
- Offline-Detection
- Reconnect mit Backoff

---

## 7. Error & Recovery Scenarios

```
Szenario 1: Network Disconnect
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


Szenario 2: Race Condition
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
- Pessimistic Locking: Nur eine Operation gleichzeitig
- Optimistic Concurrency: Version Checks
- MVCC: Multi-Version Concurrency Control
- Retry mit Backoff bei Konflikten

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

**Optimierungsmetriken:**
- Batch Size: 100-500 events pro Batch
- Batch Interval: 100ms
- Virtual Scroll Window: 50 items visible
- Memory Limit: 1000 entries in memory
