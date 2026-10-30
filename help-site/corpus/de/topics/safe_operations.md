---
standard: help_topic
id: help.topic.safe_operations
title: "Sicher starten, Modelle begrenzen, Daten sichern"
short: "Diese Anleitung sagt, wie du die Hilfeseite sicher startest, Modellkosten begrenzt und Daten sicherst. Anmeldung im Web, Kopplung von Geräten und Berechtigungen im Netz sind dabei drei getrennte Dinge. phi-spaces ist experimentell, also prüfe es selbst, bevor wichtige Daten davon abhängen."
tags: [password, PHI_SPACES_LLM, backup, restore, fsync, sqlite, grant, enrollment, security]
owner: security
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Sicher starten, Modelle begrenzen, Daten sichern

## Drei getrennte Sicherheitswege {#overview}

Diese Anleitung sagt, wie du die Hilfeseite sicher startest, Modellkosten begrenzt und Daten sicherst. Anmeldung im Web, Kopplung von Geräten und Berechtigungen im Netz sind dabei drei getrennte Dinge. phi-spaces ist experimentell, also prüfe es selbst, bevor wichtige Daten davon abhängen.

## Lokaler Start und Anmeldung {#startup}

Web-Login, Peer-Enrollment und Gate-Grants sind verschiedene Verträge. Eine lokale Demo provisioniert weder ein Telefon noch ein vertrauenswürdiges Multi-Host-Netz.

Im Repository-Root nach einem frischen Help-Build lokal starten; vorhandene .env niemals überschreiben. HELP_BIND=127.0.0.1 verhindert öffentliche Erreichbarkeit. Ohne privates PHI_SPACES_ADMIN_PASSWORD ist Web-Login deaktiviert; es gibt kein Standardpasswort. Compose verlangt das Passwort schon bei Konfigurationsauflösung. Im Production-Host-Network steuert HOST_BIND den Bind; leer öffnet 0.0.0.0. Rohe Shard-TCP-Sockets besitzen kein TLS: nur geschütztes Netz/SSH-Tunnel verwenden. Das gilt auch für den eigenständigen Dienst (npm run space-server): Wer dessen Socket erreicht, nutzt den Space. Der optionale Dashboard-Port HELP_SPACE_LISTEN hat eine eigene Rolle, die nur Spaces und Kennzahlen liest, keine Entries.

```bash
HELP_BIND=127.0.0.1 PHI_SPACES_LLM=0 npm --prefix help-site start
```


## Peer-Kopplung und Modellkosten {#pairing-and-models}

Enrollment-Tokens schreiben Peer-/App-Schlüssel ein, eröffnen aber keine Web-Admin-Session. Reale Gate-Verbindungen benötigen Peer-Erkennung, Schlüsselbeweis und passende Grants. AdminSpaces arbeitet mit den Berechtigungen seiner konfigurierten Instanz, nicht pauschal auf fremden Hosts. PHI_SPACES_LLM=0 hält die Demos deterministisch; Credentials allein aktivieren keine Modelle. Bei bewusstem PHI_SPACES_LLM=1 gelten gemeinsame Prozesslimits von sechs Aufrufen/Minute, zwei gleichzeitig, 400 Ausgabetokens und 20 s je Provider-Aufruf; Modelländerungen erfordern Admin-Session und CSRF-Token.

## Durabilität, Backup und Wiederherstellung {#backup}

Der Speicher im Arbeitsspeicher ist flüchtig. Der eigene SQLite-Speicher läuft im WAL-Modus mit synchronous=FULL (Option NORMAL: ein Prozessabsturz verliert nichts, ein Systemausfall schon); pi-durable ist daran nicht beteiligt, und JSONL ist kein Space-Speicher. SQLite-Reopen im Beispiel belegt nur den Wiederanlauf, nicht die eigene Strom- oder Hostausfallsicherheit. Eine Besitzersperre (Pfad + .owner) lässt nur einen Prozess zu. Die Datei wächst sonst nur: host.compact() gibt freie Seiten zurück, der erste Aufruf schreibt sie einmal mit VACUUM neu. Für Backups den Store exklusiv stoppen oder einen konsistenten SQLite-Backup-Weg nutzen, nicht blind eine aktive Datei samt WAL kopieren. Store, Uploaddateien und vertrauliche Host-Konfiguration berücksichtigen. Restore in isoliertem Ziel prüfen; Inkarnation/Authority, Quarantäne und Wiederfreigabe beachten. Ein asynchrones Backup ist keine verlustfreie Promotion, ein readPage-Token kein Disaster-Recovery-Backup.
