# phi-spaces Live Dashboard — UI Mockups

Übersicht und Dokumentation der Dashboard-UI-Konzepte für die Verwaltung und Überwachung von phi-spaces.

## Mockup-Galerie

### 1. [Dashboard Overview](../ui-mockup-dashboard.png)
**Zentrale Kontrollzentrale** — Die Hauptansicht mit 3-Panel-Layout:
- **Linke Spalte:** Spaces und Clients
- **Mittlere Spalte:** Space-Details und Entries-Liste
- **Rechte Spalte:** Agents und Mobile Devices

Zeigt Live-Status aller Ressourcen auf einen Blick.

---

### 2. [Space Detail View](../ui-mockup-space-detail.png)
**Tiefenanalyse** — Nach Klick auf einen Space:
- Aktive Transaktionen und Waits
- Entry-Typen und deren Häufigkeiten
- Chronologische Events (Reads, Writes, Takes)
- Notification/Subscription-Status

---

### 3. [Agents & Services](../ui-mockup-agents.png)
**Agent Monitoring** — Verwalte und beobachte deine Agents:
- CPU, Memory, Running Tasks
- Space-Zugriffe pro Agent
- Verbindungen (SSH, Unix-Socket)
- System Health Metrics

---

### 4. [Mobile Devices](../ui-mockup-mobiles.png)
**Device Management** — Übersicht aller Termux-Instanzen:
- Connection Status (SSH, VPN, lokal)
- pi-serverd Status
- Akku, Speicher, verfügbare Spaces
- Letzte Aktivitäten

---

### 5. [Live Metrics](../ui-mockup-metrics.png)
**Performance Dashboard** — Echtzeit-Statistiken:
- Operations per Minute (Reads, Writes, Takes)
- Space Utilization & Memory
- Per-Client Metriken
- System Health (Uptime, GC, Disk I/O)

---

## Design-Prinzipien

| Aspekt | Details |
|--------|---------|
| **Layout** | 3-Panel + Detailansichten (Grid-basiert) |
| **Updates** | Live via WebSocket, Echtzeit-Refresh |
| **Farben** | Dark Mode, blau-grau Palette |
| **Interaktion** | Click-to-detail, Hover-Effekte, Scrollable Listen |
| **Responsivität** | Optimiert für 1600×900 (skalierbar) |

---

## Use Cases

### Use Case 1: "Ich möchte wissen, welche Agents gerade aktiv sind"
1. Dashboard öffnen → Rechte Spalte sehen
2. Grüne Punkte = aktive Agents
3. Click auf Agent → Details (CPU, Task, Errors)

### Use Case 2: "Ein Client wartet lange auf eine Message"
1. Space-Detail öffnen (Click auf Space)
2. "Notifications" Section → sieht die Wait
3. Überprüft: Wer hat die Message geschrieben? Ist sie noch da?

### Use Case 3: "iPhone ist offline, ich muss es wiederverbinden"
1. "Mobile Devices" View öffnen
2. Sieht: iPhone battery low, connection lost 3h ago
3. Click auf iPhone → zeigt SSH-Befehl zum Reconnect

### Use Case 4: "Datenfluss ist langsam, ich checke Performance"
1. "Metrics & Performance" View
2. Sieht: Reads 45/min statt normal 120/min
3. Per-Client Metriken zeigen: agent-7 hat High Latency (24ms statt 9ms)

---

## Dokumentation

Siehe **[ui-dashboard.md](../ui-dashboard.en.md)** für:
- Detaillierte Beschreibungen jeder Spalte
- Interaktive Elemente (Click-Aktionen)
- Farbschema und Styling
- API-Anforderungen
- Implementierungs-Roadmap

---

## Nächste Schritte

1. **Frontend-Team:** Mockups als Referenz für React/Vue-Komponenten verwenden
2. **Backend-Team:** API-Endpoints für Space Stats, Live Updates implementieren
3. **UX-Testing:** Dashboard mit echten Daten testen
4. **Iteration:** Basierend auf Feedback anpassen
