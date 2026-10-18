---
standard: help_api
id: help.api.pispaces_lease
title: "Leases – renew & cancel"
short: "Verlängert oder beendet die Lebensdauer eigener Entries, Transaktionen, Notify-Abos und Waiter (Grundlage für Presence & Heartbeats)."
tags: [renew, cancel, lease, ttl, presence, heartbeat]
owner: client
related: [help.topic.leases_and_transactions, help.workflow.stage_v1_local_memory]
since: 0.0.1
---

# Leases – renew & cancel

## Überblick {#overview}

`renew(leaseId, ms, options?)` setzt die neue Ablaufzeit einer eigenen Ressource auf `now + ms` (oder `FOREVER`) und gibt den neuen Ablauf-Zeitstempel zurück. `cancel(leaseId, options?)` beendet die Ressource sofort (entfernt den Entry, bricht die Transaktion ab oder kündigt das Abo/den Waiter).

## Technische Referenz {#technical-reference}

```ts
const presence = await space.write({ type: "Presence", fields: { username: "alice" } }, null, 30_000);
const newExpires = await space.renew(presence.id, 30_000);
await space.cancel(presence.id);
```

## Verhalten {#parameters}

- **Ownership**: Nur der Besitzer der Lease (Principal bzw. Besitz-Claim) darf `renew` und `cancel` aufrufen; fremde Aufrufe werden abgewiesen.
- **`renew`**: Setzt `expires = now + ms` (oder `FOREVER`); funktioniert für Entry-Leases, Transaktions-Leases, Notify-Abos und geparkte Waiter.
- **`cancel`**: Beendet die Ressource sofort – bei einem Entry entspricht das dem Entfernen, bei einer Transaktion einem `abort`.

## Typische Anwendungsfälle {#use-cases}

- **Presence-Heartbeat**: Der Browser-Client erneuert seine `Presence`-Lease alle ~15 s; bei Verbindungsabbruch läuft sie aus und der Teilnehmer verschwindet automatisch aus der Online-Liste.
- **Lange Tasks**: Ein Worker mit aufwendiger Verarbeitung verlängert seine Transaktions-Lease periodisch, damit die Reservierung nicht vorzeitig abläuft.
- **Sauberes Abmelden**: `cancel(presence.id)` beim geordneten Disconnect entfernt den Eintrag sofort statt auf den Reaper zu warten.
