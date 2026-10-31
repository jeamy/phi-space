# phi-spaces Live Dashboard — UI Mockups

Overview and documentation of the dashboard UI concepts for managing and monitoring phi-spaces.

## Mockup Gallery

### 1. [Dashboard Overview](ui-mockup-dashboard.png)
**Central control room** — The main view with a 3-panel layout:
- **Left column:** Spaces and clients
- **Middle column:** Space details and entries list
- **Right column:** Agents and mobile devices

Shows the live status of all resources at a glance.

---

### 2. [Space Detail View](ui-mockup-space-detail.png)
**In-depth analysis** — After clicking a Space:
- Active transactions and waits
- Entry types and their frequencies
- Chronological events (reads, writes, takes)
- Notification/subscription status

---

### 3. [Agents & Services](ui-mockup-agents.png)
**Agent monitoring** — Manage and observe your agents:
- CPU, memory, running tasks
- Space accesses per agent
- Connections (SSH, Unix socket)
- System health metrics

---

### 4. [Mobile Devices](ui-mockup-mobiles.png)
**Device management** — Overview of all Termux instances:
- Connection status (SSH, VPN, local)
- pi-serverd status
- Battery, storage, available Spaces
- Recent activities

---

### 5. [Live Metrics](ui-mockup-metrics.png)
**Performance dashboard** — Real-time statistics:
- Operations per minute (reads, writes, takes)
- Space utilization & memory
- Per-client metrics
- System health (uptime, GC, disk I/O)

---

## Design Principles

| Aspect | Details |
|--------|---------|
| **Layout** | 3-panel + detail views (grid-based) |
| **Updates** | Live via WebSocket, real-time refresh |
| **Colors** | Dark mode, blue-grey palette |
| **Interaction** | Click-to-detail, hover effects, scrollable lists |
| **Responsiveness** | Optimized for 1600×900 (scalable) |

---

## Use Cases

### Use Case 1: "I want to know which agents are active right now"
1. Open the dashboard → look at the right column
2. Green dots = active agents
3. Click an agent → details (CPU, task, errors)

### Use Case 2: "A client has been waiting a long time for a message"
1. Open the Space detail (click a Space)
2. "Notifications" section → sees the wait
3. Checks: who wrote the message? Is it still there?

### Use Case 3: "The iPhone is offline, I need to reconnect it"
1. Open the "Mobile Devices" view
2. Sees: iPhone battery low, connection lost 3h ago
3. Click the iPhone → shows the SSH command to reconnect

### Use Case 4: "Data flow is slow, I am checking performance"
1. "Metrics & Performance" view
2. Sees: reads 45/min instead of the normal 120/min
3. Per-client metrics show: agent-7 has high latency (24ms instead of 9ms)

---

## Documentation

See **[ui-dashboard.en.md](ui-dashboard.en.md)** for:
- Detailed descriptions of each column
- Interactive elements (click actions)
- Color scheme and styling
- API requirements
- Implementation roadmap

---

## Next Steps

1. **Frontend team:** use the mockups as a reference for React/Vue components
2. **Backend team:** implement API endpoints for Space stats and live updates
3. **UX testing:** test the dashboard with real data
4. **Iteration:** adjust based on feedback
