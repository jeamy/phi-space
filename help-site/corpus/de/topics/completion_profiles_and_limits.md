---
standard: help_topic
id: help.topic.completion_profiles_and_limits
title: "CompletionProfiles und Ressourcen-Limits"
short: "Serverseitige Ergebnisprüfung beim Commit von Take-Transaktionen (CompletionProfile) sowie die festen Byte- und Owner-Quoten (DEFAULT_LIMITS)."
tags: [completionprofile, completionviolation, limits, quotas, bytes, budget]
owner: core
related: [help.topic.leases_and_transactions, help.api.pispaces_completion_profiles]
since: 0.0.1
---

# CompletionProfiles und Ressourcen-Limits

## Überblick {#overview}

Damit ein fehlerhafter Worker oder ein halluzinierender KI-Agent niemals eine Aufgabe aus dem Space entnehmen und die Transaktion ohne gültiges Ergebnis committen kann, erzwingt `pi-spaces` serverseitige **`CompletionProfiles`** sowie strikte **Byte- und Objekt-Budgets (`DEFAULT_LIMITS`)**.

## Begriffs- und Systemmodell {#concept-model}

### Serverseitige Ergebnisverträge (CompletionProfile) {#completion-profiles}

Ein `CompletionProfile` legt fest, welche Ergebnis-Entries beim `commit(txn)` für jeden in dieser Transaktion genommenen Task-Entry geschrieben worden sein müssen:

```ts
await space.setCompletionProfiles([
  {
    taskType: "ChatTask",
    resultType: "Msg",
    matchFields: ["taskId", "threadId"],
    minResults: 1,
    maxResults: 1
  },
  {
    taskType: "SearchTask",
    resultType: "SearchResult",
    matchFields: ["searchId", "parentThreadId"],
    minResults: 1,
    maxResults: 1
  }
]);
```

Versucht ein Worker `commit(txn)` aufzurufen, ohne dass für den genommenen `ChatTask` genau eine `Msg` mit identischer `taskId` und `threadId` in derselben Transaktion geschrieben wurde, wirft der Space-Kern `CompletionViolation`. Die Transaktion bleibt offen und kann korrigiert oder mit `abort(txn)` zurückgerollt werden.

### Byte-Budgets und Owner-Quoten (DEFAULT_LIMITS) {#default-limits}

| Limit | Standardwert | Bedeutung |
|---|---|---|
| `maxEntryBytes` | `64 KiB` | Maximale Größe eines einzelnen Entry oder Handbacks |
| `maxCommitBytes` | `192 KiB` | Maximale Summe aller Delta-Bytes eines Commits (inkl. Claims & Folgearbeit) |
| `maxFrameBytes` | `256 KiB` | Maximale RPC-Framegröße am Gate/Socket |
| `maxEventBytes` | `160 KiB` | Maximale Größe eines zugestellten Events |
| `maxSpaceBytes` | `64 MiB` | Summe aller Entry-Felder in einem Space |
| `maxClaimsBytes` | `32 MiB` | Speicherbudget für Request-Claims |
| `maxOutboxBytes` | `8 MiB` | Speicherbudget für Outbox / Mailboxes (max. 7 Tage TTL) |
| `maxStorageBytes` | `128 MiB` | Gesamtdokumentgröße eines Spaces |

Vor **jeder** Erweiterung einer Transaktion reserviert `core.ts` die konservativen Kosten für **Commit und Abort**. Überschreitet ein Schritt das Budget, scheitert dieser Schritt sofort mit `ResourceExhausted`, sodass die bisherige Transaktion niemals beim abschließenden `commit` oder `abort` am Byte-Limit hängenbleibt.

## Siehe auch {#see-also}

- [Leases, Transaktionen und Sichtbarkeit](help.topic.leases_and_transactions#overview)
- [setCompletionProfiles & setLimits](help.api.pispaces_completion_profiles)
