---
standard: help_topic
id: help.topic.completion_profiles_and_limits
title: "CompletionProfiles und Ressourcen-Limits"
short: "Serverseitige Ergebnisprüfung beim Commit von Take-Transaktionen (CompletionProfile) sowie die festen Byte- und Owner-Quoten (DEFAULT_LIMITS)."
tags: [completionprofile, completionviolation, limits, quotas, bytes, budget]
owner: core
related: [help.topic.leases_and_transactions, help.api.phispaces_completion_profiles]
since: 0.0.1
---

# CompletionProfiles und Ressourcen-Limits

## Überblick {#overview}

Ein Worker nimmt sich einen Auftrag und soll ein Ergebnis abliefern. Hier legst du fest, dass er den Auftrag nur abschließen kann, wenn das Ergebnis wirklich da ist. Ein fehlerhaftes Programm oder ein KI-Agent kann eine Aufgabe so nicht einfach verschwinden lassen. Dazu kommen Größengrenzen, damit kein Teilnehmer den Space volllaufen lässt.

### Technische Details {#technical-details}

Der Space erzwingt das serverseitig mit **`CompletionProfiles`** und strikten **Byte- und Objekt-Budgets (`DEFAULT_LIMITS`)**. Beides gilt auch dann, wenn ein Worker sich nicht an die Absprachen hält.

## Begriffs- und Systemmodell {#concept-model}

### Serverseitige Ergebnisverträge (CompletionProfile) {#completion-profiles}

Ein `CompletionProfile` legt fest, welche Ergebnis-Entries beim `commit(txn)` für jeden in dieser Transaktion genommenen Task-Entry geschrieben worden sein müssen:

```ts
await space.setCompletionProfiles([
  {
    taskType: "ChatTask",
    resultTypes: ["Msg"],
    equalFields: ["taskId", "threadId"],
    maxResultCount: 1
  },
  {
    taskType: "SearchTask",
    resultTypes: ["SearchResult"],
    equalFields: ["searchId", "parentThreadId"],
    maxResultCount: 1
  }
]);
```

Versucht ein Worker `commit(txn)` aufzurufen, ohne dass für den genommenen `ChatTask` in derselben Transaktion mindestens ein und höchstens `maxResultCount` passende Ergebnisse mit identischer `taskId` und `threadId` geschrieben wurden, wirft der Space-Kern `CompletionViolation`. Mit `maxResultCount: 1` heißt das: genau eine `Msg`. Die Transaktion bleibt offen und kann korrigiert oder mit `abort(txn)` zurückgerollt werden.

Weitere Regeln eines Profils:

- Ein Task mit Profil lässt sich nur unter einer Transaktion nehmen; ohne `txn` folgt ebenfalls `CompletionViolation`.
- Ein Ergebnis-Entry in der Transaktion, das zu keinem genommenen Task passt, verhindert den Commit (`unmatched completion result`).
- `maxResultBytes` begrenzt die Summe der Ergebnisse eines Tasks.
- `maxLeaseMs` begrenzt, wie weit die Transaktions-Lease reichen darf.
- `gateField` bindet Tasks an den RunGate ihres Laufs. Das Feld muss in `equalFields` stehen, und `maxLeaseMs` ist dann Pflicht.

### Byte-Budgets und Owner-Quoten (DEFAULT_LIMITS) {#default-limits}

Die Entry-Anzahl ist standardmäßig weder pro Space noch pro Owner begrenzt:
`maxEntries` und `maxEntriesPerOwner` verwenden `FOREVER` (JSON-sicherer unbegrenzter Wert).
Explizite Anzahlquoten sind mit `setLimits` weiterhin möglich. Die folgenden Byte-Budgets und
die Quoten für Registrierungen, Waiter und Transaktionen bleiben wirksam; unbegrenzte Anzahl
bedeutet nicht unbegrenzten Arbeitsspeicher oder unbegrenzte Dokumentgröße.

| Limit | Standardwert | Bedeutung |
|---|---|---|
| `maxEntryBytes` | `64 KiB` | Maximale Größe eines einzelnen Entry oder Handbacks |
| `maxCommitBytes` | `192 KiB` | Maximale Summe aller Delta-Bytes eines Commits (inkl. Claims & Folgearbeit) |
| `maxFrameBytes` | `256 KiB` | Maximale RPC-Framegröße am Gate/Socket |
| `maxEventBytes` | `160 KiB` | Maximale Größe eines zugestellten Events |
| `maxSpaceBytes` | `64 MiB` | Summe aller Entry-Felder in einem Space |
| `maxClaimBytes` | `32 MiB` | Speicherbudget für Request-Claims |
| `maxOutboxBytes` | `8 MiB` | Budget für noch nicht zugestellte Events; darüber werden neue Abos und Waits abgewiesen, kein Event geht verloren |
| `maxMailboxBytes` | `8 MiB` | Budget der Consumer-Mailboxes (`mailboxTtlMs` standardmäßig und höchstens 7 Tage) |
| `maxLogBytes` | `4 MiB` | Revisionslog für `changes` |
| `maxSnapshotBytes` | `64 MiB` | Snapshot-Cache für `readPage` (höchstens `maxSnapshots` = 16, `snapshotTtlMs` = 60 s) |
| `maxJobBytes` | `16 MiB` | Budget für ausstehende Fanout-Jobs und Abschlussreservierungen |
| `maxDocBytes` | `128 MiB` | Gesamtdokumentgröße eines Spaces |

Dazu kommen Zeitvorgaben: `claimResultMs` hält Ergebnisse von Request-Claims 24 Stunden, `generationAdmitMs` lässt eine Generation 1 Stunde neue Anfragen zu, und `notifyIntervalMs` bündelt Abo-Benachrichtigungen auf höchstens eine pro Sekunde. Je Owner gelten standardmäßig höchstens 20 Registrierungen, 20 Waiter und 20 Transaktionen.

Vor **jeder** Erweiterung einer Transaktion reserviert `core.ts` die konservativen Kosten für **Commit und Abort**. Überschreitet ein Schritt das Budget, scheitert dieser Schritt sofort mit `ResourceExhausted`, sodass die bisherige Transaktion niemals beim abschließenden `commit` oder `abort` am Byte-Limit hängenbleibt.

## Siehe auch {#see-also}

- [Leases, Transaktionen und Sichtbarkeit](help.topic.leases_and_transactions#overview)
- [setCompletionProfiles & setLimits](help.api.phispaces_completion_profiles)
