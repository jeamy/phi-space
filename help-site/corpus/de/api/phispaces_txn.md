---
standard: help_api
id: help.api.phispaces_txn
title: "Transaktionen – createTransaction, commit & abort"
short: "Bündelt Takes (Reservierungen) und Writes (unsichtbare Entwürfe) atomar; prüft beim Commit alle CompletionProfiles und Byte-Budgets."
tags: [createtransaction, commit, abort, txn, atomic]
owner: client
related: [help.topic.leases_and_transactions, help.topic.completion_profiles_and_limits]
since: 0.0.1
---

# Transaktionen – createTransaction, commit & abort

## Überblick {#overview}

`createTransaction(lease?, options?)` erzeugt eine neue Space-Transaktion. `commit(txnId, options?)` macht alle unter `txnId` geschriebenen Entries sichtbar und entfernt alle unter `txnId` genommenen Entries endgültig. `abort(txnId, options?)` verwirft alle Writes und gibt alle reservierten Takes frei.

## Technische Referenz {#technical-reference}

```ts
const txn = await space.createTransaction(60_000, { request: reqBegin });
// ... space.take(..., { txn: txn.id }) & space.write(..., txn.id) ...
await space.commit(txn.id, { request: reqCommit });
```

## Verhalten und Garantien {#parameters}

- **Isolation**: Unter `txn` geschriebene Entries sind nur für Operationen mit derselben `txnId` sichtbar; reservierte Takes sind für andere Consumer gesperrt.
- **Atomarität**: `commit` wendet alle Writes und Takes gemeinsam an, erhöht `rev` genau einmal und stößt die zugehörigen Mailbox-Ereignisse an. `abort` verwirft alles und gibt reservierte Entries frei.
- **Lease**: Die Transaktion besitzt eine eigene Lease (Argument `lease`); bei Ablauf ohne Commit erfolgt implizit ein `abort`.
- **Vertragsprüfung**: Vor dem Commit prüft der Kern alle `CompletionProfiles` (`CompletionViolation` bei fehlenden Ergebnissen) und die konfigurierten Byte-Budgets (`ResourceExhausted`).

## Typische Anwendungsfälle {#use-cases}

- **Task-Verarbeitung**: `take(ChatTask, { txn })` + `write(Msg, txn)` + `commit(txn)` – die Antwort existiert nie ohne den konsumierten Task und umgekehrt.
- **Mehrschritt-Zustandswechsel**: `take(Thread) + write(Thread')` in einer `txn` ersetzt In-Place-Updates sicher.
- **Abbruch bei Fehlern**: Wirft die Verarbeitung (z.B. Modellaufruf), ruft der Worker `abort(txn)`, wird nichts halbfertig sichtbar.
