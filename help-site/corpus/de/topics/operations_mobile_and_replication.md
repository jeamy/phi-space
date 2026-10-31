---
standard: help_topic
id: help.topic.operations_mobile_and_replication
title: "Betriebserweiterung (RunGate, Worker, Mobile/Web-Admin) & Phase-3-Replikation"
short: "Wie Läufe über RunGate-Barrieren, Worker über signierte Zuweisungen und Spaces über die Mobile App (pi-termux-mobile) sowie den Web-Admin-Bereich (AdminSpaces) gesteuert werden."
tags: [rungate, runcontroller, workersupervisor, mobile, adminspaces, alerts, audit, replication, lww, hlc]
owner: ops
related: [help.workflow.stage_v6_mobile_control, help.api.operations_runs_workers]
since: 0.0.1
---

# Betriebserweiterung (RunGate, Worker, Mobile/Web-Admin) & Phase-3-Replikation

## Überblick {#overview}

Wenn viele Rechner an einer großen Aufgabe arbeiten, will man sie anhalten, fortsetzen und überwachen können. Dieser Bereich bringt die Werkzeuge dafür: Läufe steuern, Helfer hoch- und herunterfahren, Spaces anlegen und löschen. Das geht vom Handy aus oder über eine Weboberfläche. Jeder Befehl ist so gebaut, dass doppeltes Tippen nichts doppelt auslöst.

### Technische Details {#technical-details}

Die Betriebserweiterung (Schritte B1–B10 in `docs/betrieb-und-mobile-steuerung.en.md`) ergänzt über dem Federation-Kern die operative Steuerung für **Rechenläufe (`RunGate` / `RunController`)**, **Host-Worker (`WorkerSupervisor`)**, **Space-Lebenszyklen (`SpaceLifecycle`)**, **Deployment-Bootstrap (`DeploymentController`)** und **Alarmierung/Audit (`collectAlerts` / `auditLog`)**. Alle Funktionen sind sowohl über die Android-App (`pi-termux-mobile`) als auch über den login-geschützten Web-Bereich **`AdminSpaces`** auf `https://spaces.eibrain.org` bedienbar.

## Begriffs- und Systemmodell {#concept-model}

### RunGate und bestätigte Pause-/Resume-Barriere {#rungate-barrier}

Ein `RunGate { runId, controlRevision, state: "preparing" | "running" | "paused" | "stopped" }` ist ein geschützter Steuerzustand im Space-Dokument:

- Tasks werden über `CompletionProfile.gateField` an den `RunGate` ihres Laufs gebunden. Für solche Tasks prüft der Space-Kern bei **jedem** `take` (auch bei wartenden Takes und Host-Code), ob der `RunGate` auf `running` steht.
- Bei `pauseRun` installiert jeder beteiligte Member zuerst einen **Fence** (keine neuen Run-Transaktionen, keine Lease-Verlängerung laufender Run-Transaktionen), lässt bereits reservierte Tasks innerhalb ihrer Lease abschließen und meldet erst danach sein signiertes ACK an den `RunController`. Erst wenn alle Member-ACKs vorliegen, wechselt der Lauf global auf `paused`.
- Der Laufzustand `RunView.state` im `RunController` kennt mehr Stufen als das Gate im Space, etwa `pausing`, `pauseIncomplete`, `reconciling` und `needsReview`.

### Signierte Worker-Steuerung (WorkerSupervisor) {#worker-supervisor}

Statt ungeschützter Entries im Control-Space speichert der Koordinator den gewünschten Worker-Sollzustand im geschützten Journal `WorkerAssignments` (`setWorkers`). Jeder Host ruft über die Gate-Methode `workerAssignments` nur seinen eigenen, vom Control-Host signierten Anteil ab. Der lokale `WorkerSupervisor` startet registrierte Worker-Schleifen (z.B. `chat-worker`, `search-subagent`, `sieve`) oder fährt sie bei `count: 0` nach dem aktuellen Task sauber herunter.

### Steuerung über Mobile App (pi-termux-mobile) & Web-Admin (AdminSpaces) {#mobile-and-web-admin}

Sowohl `MobileSpaces` (`pi-termux-mobile/runtime/spaces-mobile.mjs`) als auch unser Web-Admin-Controller (`help-site/server/admin/`) folgen demselben Sicherheitsvertrag:

1. **Vorab persistierte `commandId`**: Vor jedem Senden wird `commandId = m-<kind>-<hex>` bzw. `w-<kind>-<hex>` lokal gespeichert. Bei Timeout oder Doppeltippen wird exakt dieselbe `commandId` erneut gesendet („Ausgang wird geprüft“ statt doppelter Ausführung).
2. **Schlüsselbeweis & 60s-Grants**: Jede Verbindung beweist ihren `Ed25519`/`P-256`-Schlüssel am Gate und nutzt kurzlebige Grants.
3. **Phase-3-Replikationsbausteine**: Für verzögerungstolerante Metadaten und Präsenz steht `EntryReplicationController` (persistenter HLC, Last-Writer-Wins mit versionierten Tombstones und Add-Wins-Sets) bereit. Er nutzt ein eigenes Dokument und repliziert bestehende `PhiSpaces`-Entries nicht automatisch. Primary/Sync, Fencing und Promotion sind implementiert, Phase 3 ist aber nicht vollständig abgenommen (`docs/_attic/abnahme/ap3-abnahme.en.md`).

## Siehe auch {#see-also}

- [Stufe 6 (v6-mobile-control): Mobile App & Web-Admin Steuerung](help.workflow.stage_v6_mobile_control#overview)
- [RunController, WorkerSupervisor, SpaceLifecycle & Alerts API](help.api.operations_runs_workers)
