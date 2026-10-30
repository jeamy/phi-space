---
standard: help_api
id: help.api.phispaces_lease
title: "Leases – renew & cancel"
short: "Verlängert oder beendet die Lebensdauer eigener Entries, Transaktionen, Notify-Abos und Waiter (Grundlage für Presence & Heartbeats)."
tags: [renew, cancel, lease, ttl, presence, heartbeat]
owner: client
related: [help.topic.leases_and_transactions, help.workflow.stage_v1_local_memory]
since: 0.0.1
---

# Leases – renew & cancel

## Überblick {#overview}

Alles im Space hat eine Lebensdauer. `renew` verlängert sie, `cancel` beendet sie sofort. Du nutzt das zum Beispiel für Anwesenheit: Solange ein Programm verlängert, gilt es als online. Bleibt die Verlängerung aus, räumt der Space den Eintrag selbst weg.

## Technische Referenz {#technical-reference}

`renew(leaseId, ms, options?)` setzt die neue Ablaufzeit einer eigenen Ressource auf `now + ms` (oder `FOREVER`) und gibt den neuen Ablauf-Zeitstempel zurück. `cancel(leaseId, options?)` beendet die Ressource sofort (entfernt den Entry, bricht die Transaktion ab oder kündigt das Abo/den Waiter).

```ts
const presence = await space.write({ type: "Presence", fields: { username: "alice" } }, null, 30_000);
const newExpires = await space.renew(presence.id, 30_000);
await space.cancel(presence.id);
```

## Verhalten {#parameters}

- **Ownership**: Eine Conversation darf nur eigene Leases ändern, fremde Aufrufe werden abgewiesen. Host-Code (ohne `conversationId`) ist nicht beschränkt; remote gilt die Identität der Verbindung.
- **`renew`**: Setzt `expires = now + ms` (oder `FOREVER`); funktioniert für Entry-Leases, Transaktions-Leases, Notify-Abos und geparkte Waiter.
- **`cancel`**: Beendet die Ressource sofort – bei einem Entry entspricht das dem Entfernen, bei einer Transaktion einem `abort`.
- **`keepAlive(space, lease, leaseMs)`** aus `phi-spaces`: Erneuert eine Lease alle `leaseMs / 3`, solange lange Arbeit läuft, und liefert die Stopp-Funktion. Stirbt der Prozess, läuft die Lease binnen `leaseMs` aus.

## Typische Anwendungsfälle {#use-cases}

- **Presence-Heartbeat**: Ein Client erneuert seine `Presence`-Lease regelmäßig vor Ablauf; bei Verbindungsabbruch läuft sie aus, und der Teilnehmer verschwindet automatisch aus der Online-Liste.
- **Lange Tasks**: Ein Worker mit aufwendiger Verarbeitung hält seine Transaktion mit `keepAlive` am Leben, damit die Reservierung nicht vorzeitig abläuft.
- **Sauberes Abmelden**: `cancel(presence.id)` beim geordneten Disconnect entfernt den Eintrag sofort statt auf den Reaper zu warten.
