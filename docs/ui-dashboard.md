# pi-spaces Live Dashboard UI Mockup

Eine Übersicht für eine Echtzeit-Web-Oberfläche, die Spaces, Clients, Agents und Mobile Devices visualisiert.

## Architektur

Die Dashboard-UI zeigt ein **3-Panel-Layout**:

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

**Zweck:** Zentrale Übersicht aller Ressourcen im Live-Modus.

**Inhalte:**
- **Linke Spalte (Spaces & Clients):**
  - Auflistung aller Spaces mit Status (grüner Punkt = aktiv)
  - Anzahl Entries und verbundene Clients pro Space
  - Verbundene Clients mit letzter Aktivität
  - Status: online (grün), idle (orange), offline (rot)

- **Mittlere Spalte (Space Details):**
  - Statistiken des aktiven Spaces (Entries, Typen, Transaktionen, Größe)
  - Metriken: Reads/Writes pro Minute, durchschnittliche Latenz, Fehler
  - Live-Liste der letzten Entries
  - **Klickbar:** Jeder Space ist anklickbar → zeigt detaillierte Ansicht

- **Rechte Spalte (Agents & Mobiles):**
  - Liste der Agents mit Status und Ressourcennutzung
  - Mobile Geräte (Termux) mit Verbindungsstatus und Akku
  - Schneller Überblick über alle Clients

---

### 2. **Space Detail View**
`ui-mockup-space-detail.png`

**Zweck:** Tiefe Analyse eines einzelnen Spaces (nach Klick auf "workflows", "default", etc.)

**Inhalte:**
- **Workflows Space Section:**
  - Aktive Transaktionen und wartende
  - Eingehende Waits (Clients, die auf Entries warten)
  - Speichernutzung und letzte Aktivität
  - Transaktions-Locks (wer sperrt was, wie lange)

- **Entry Types Section:**
  - Übersicht der Entry-Typen im Space
  - Anzahl pro Typ, Besitzer (Agent oder Client)
  - Beispiele: TaskUpdate, Message, Result, Cache

- **Recent Events Section:**
  - Chronologische Logs von Writes, Reads, Takes
  - Zeitstempel und beteiligte Clients
  - Transaction IDs für Nachverfolgung

- **Notifications Section:**
  - Registrierte Waits (Clients, die auf Events warten)
  - Notify-Subscriptions mit TTL (Time to Live)

---

### 3. **Agents Detail View**
`ui-mockup-agents.png`

**Zweck:** Monitoring von Agents und System-Services.

**Inhalte:**
- **Agent Status Panels (z.B. "agent-7"):**
  - CPU, Memory, Running Task mit Progress
  - Spaces, auf die der Agent Zugriff hat
  - Fehlerrate und Last 1m
  
- **Agent Status Panels (z.B. "agent-5"):**
  - Idle State, wann zuletzt aktiv
  - Space-Zugriff, Uptime und Restarts
  
- **Connections Panel:**
  - SSH-Tunnel zu Mobiles
  - Unix-Socket-Verbindungen
  - Remote-Sessions
  
- **System Health Panel:**
  - Gesamtgröße aller Spaces
  - Transaction Slot-Auslastung
  - Event Queue Status

---

### 4. **Mobile Devices View**
`ui-mockup-mobiles.png`

**Zweck:** Management und Überwachung von Termux-Instanzen auf Mobiles.

**Inhalte:**
- **Device Panels (z.B. "iPhone 15"):**
  - Verbindungsart (SSH Tunnel, VPN, lokal)
  - pi-serverd Status (Running, Sleeping)
  - Akku, Speicher
  - Spaces, auf denen Daten verfügbar sind
  
- **Status Indicators:**
  - Grün = Online und aktiv
  - Orange = Idle (Standby)
  - Rot = Offline
  
- **Recent Activity Panel:**
  - Letzte Operationen (Read, Write, Sync)
  - Zeitstempel und Spaces
  - Hilft zu sehen, welche Geräte aktiv sind

---

### 5. **Metrics & Performance View**
`ui-mockup-metrics.png`

**Zweck:** Echtzeit-Monitoring von Performance und Auslastung.

**Inhalte:**
- **Operations Per Minute:**
  - Reads, Writes, Takes mit durchschn. Latenz
  - Error Rate
  
- **Space Utilization:**
  - Entry Count vs. Limit
  - Memory Usage
  - Transaction Slot Auslastung
  - Pending Waits
  
- **Per-Client Metrics:**
  - Operationen pro Minute pro Agent/Client
  - Durchschnittliche Latenz pro Client
  
- **System Health:**
  - Uptime, Crash-Log
  - Garbage Collection Pauses
  - Disk I/O

---

## Interaktivität

### Click-Aktionen

| Element | Action | Ziel |
|---------|--------|------|
| **Space name** (z.B. "default", "workflows") | Click | Öffnet Space-Detail-View |
| **Client name** (z.B. "agent-7", "mobile-iphone") | Click | Öffnet Client-Status-Panel mit Logs |
| **Entry** in Liste | Click | Zeigt vollständige Entry-Daten und Transaktionshistorie |
| **Transaction ID** (z.B. "txn-5a2f") | Click | Zeigt alle Entries dieser Transaktion |

### Live Updates

- **Automatische Refresh:** Alle Panels aktualisieren sich in Echtzeit (WebSocket)
- **Status-Indikatoren:** Farbliche Pulse für Aktivität (grüne Punkte blinken bei Aktivität)
- **Notifications:** Benachrichtigungen für Fehler, Crashes, Timeout
- **Scrollbare Listen:** Entries mit Infinite Scroll oder Pagination

---

## Farbschema

```
Background:     #0f172a (sehr dunkelblau)
Panels:         #1e293b (dunkelblau mit 80% opacity)
Borders:        #334155 (grau)
Text Primary:   #e2e8f0 (hellgrau)
Text Muted:     #94a3b8 (mittleres grau)
Accent:         #3b82f6 (blau)
Success:        #10b981 (grün)
Warning:        #f59e0b (orange)
Error:          #ef4444 (rot)
```

---

## Technologie-Stack (Vorschlag)

- **Frontend:** React oder Vue.js
- **Live Updates:** WebSocket (oder Server-Sent Events)
- **Charts:** Recharts, Chart.js oder D3.js für Metriken
- **State:** Redux oder Pinia für globalen State
- **Styling:** Tailwind CSS oder CSS-in-JS

---

## API-Anforderungen

Die UI benötigt folgende Endpoints:

```
GET  /api/spaces                    # Alle Spaces + Stats
GET  /api/spaces/{id}               # Space-Details
GET  /api/spaces/{id}/entries       # Entries mit Pagination
GET  /api/agents                    # Alle Agents
GET  /api/agents/{id}               # Agent-Details
GET  /api/clients                   # Alle Clients
GET  /api/mobiles                   # Mobile Devices
WS   /api/live                      # WebSocket für Echtzeit-Updates
```

---

## Features zum Implementieren

- [ ] Dashboard Overview (3-Panel-Layout)
- [ ] Echtzeit-Updates via WebSocket
- [ ] Detailansichten für Spaces
- [ ] Agent/Client Monitoring
- [ ] Mobile Device Management
- [ ] Performance Metrics & Graphs
- [ ] Entry Inspector (vollständige Daten anzeigen)
- [ ] Transaction Tracker (History anzeigen)
- [ ] Search & Filter (nach Entry-Type, Client, etc.)
- [ ] Dark/Light Mode Toggle
- [ ] Export (Logs, Metrics als CSV/JSON)
