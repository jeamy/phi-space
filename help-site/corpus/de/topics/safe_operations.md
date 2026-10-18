---
standard: help_topic
id: help.topic.safe_operations
title: "Sicher starten, Modelle begrenzen, Daten sichern"
short: "Web-Login, Peer-Enrollment und Gate-Grants sind verschiedene Verträge. Eine lokale Demo provisioniert weder ein Telefon noch ein vertrauenswürdiges Multi-Host-Netz. Experimentelle Software unabhängig validieren, bevor wichtige Daten davon abhängen."
tags: [password, PI_SPACES_LLM, backup, restore, fsync, sqlite, grant, enrollment, security]
owner: security
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Sicher starten, Modelle begrenzen, Daten sichern

## Drei getrennte Sicherheitswege {#overview}

Web-Login, Peer-Enrollment und Gate-Grants sind verschiedene Verträge. Eine lokale Demo provisioniert weder ein Telefon noch ein vertrauenswürdiges Multi-Host-Netz. Experimentelle Software unabhängig validieren, bevor wichtige Daten davon abhängen.

## Lokaler Start und Anmeldung {#startup}

Im Repository-Root nach einem frischen Help-Build lokal starten; vorhandene .env niemals überschreiben. HELP_BIND=127.0.0.1 verhindert öffentliche Erreichbarkeit. Ohne privates PI_SPACES_ADMIN_PASSWORD ist Web-Login deaktiviert; es gibt kein Standardpasswort. Compose verlangt das Passwort schon bei Konfigurationsauflösung. Im Production-Host-Network steuert HOST_BIND den Bind; leer öffnet 0.0.0.0. Rohe Shard-TCP-Sockets besitzen kein TLS: nur geschütztes Netz/SSH-Tunnel verwenden.

```bash
HELP_BIND=127.0.0.1 PI_SPACES_LLM=0 npm --prefix help-site start
```


## Peer-Kopplung und Modellkosten {#pairing-and-models}

Enrollment-Tokens schreiben Peer-/App-Schlüssel ein, eröffnen aber keine Web-Admin-Session. Reale Gate-Verbindungen benötigen Peer-Erkennung, Schlüsselbeweis und passende Grants. AdminSpaces arbeitet mit den Berechtigungen seiner konfigurierten Instanz, nicht pauschal auf fremden Hosts. PI_SPACES_LLM=0 hält die Demos deterministisch; Credentials allein aktivieren keine Modelle. Bei bewusstem PI_SPACES_LLM=1 gelten gemeinsame Prozesslimits von sechs Aufrufen/Minute, zwei gleichzeitig, 400 Ausgabetokens und 20 s je Provider-Aufruf; Modelländerungen erfordern Admin-Session und CSRF-Token.

## Durabilität, Backup und Wiederherstellung {#backup}

MemoryStorage ist flüchtig. SQLite/JSONL-Reopen belegt Wiederanlauf, nicht automatisch Strom- oder Hostausfallsicherheit. fsync-/SQLite-synchronous-Einstellungen, WAL/Checkpoint und verwendetes Backend prüfen; keine pauschalen Garantien aus dem Dateinamen ableiten. Für Backups einen unterstützten konsistenten Export/Backup-Pfad oder exklusiv gestoppten Store nutzen, nicht blind eine aktive DB-Datei kopieren. Store, Uploaddateien und vertrauliche Host-Konfiguration berücksichtigen. Restore in isoliertem Ziel prüfen; Inkarnation/Authority, Quarantäne und Wiederfreigabe beachten. Ein asynchrones Backup ist keine verlustfreie Promotion, ein readPage-Token kein Disaster-Recovery-Backup.
