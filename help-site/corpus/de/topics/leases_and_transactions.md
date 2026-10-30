---
standard: help_topic
id: help.topic.leases_and_transactions
title: "Leases, Transaktionen und Sichtbarkeit"
short: "Wie Leases selbstheilende Zustände ermöglichen und wie Transaktionen (createTransaction, commit, abort) Writes und Takes atomar isolieren."
tags: [leases, transactions, txn, visibility, locks, ifexists, renew, cancel]
owner: core
related: [help.topic.entries_and_templates, help.topic.completion_profiles_and_limits, help.api.phispaces_txn]
since: 0.0.1
---

# Leases, Transaktionen und Sichtbarkeit

## Überblick {#overview}

Programme stürzen ab und Verbindungen reißen. Deshalb bekommt man im Space alles nur auf Zeit: Wer sich nicht mehr meldet, verliert es automatisch wieder. Mehrere Schritte lassen sich außerdem bündeln, sodass entweder alle gelten oder keiner. So bleibt nichts halb fertig liegen.

### Technische Details {#technical-details}

Dafür gibt es zwei Mechanismen: **Leases** (zeitlich begrenzte Lebensdauer für Entries, Transaktionen, Waiter und Abos) und **Space-Transaktionen** (atomare Gruppierung von `take`-Reservierungen und `write`-Entwürfen).

## Begriffs- und Systemmodell {#concept-model}

### Leases und Selbstheilung {#leases-self-healing}

Jede Ressource im Space besitzt eine Ablaufzeit `expires` (in Millisekunden seit Epoch oder `FOREVER`):

- `ANY` (`-1`): Überlässt die Standarddauer dem Space (Standard: 1 Stunde).
- `FOREVER`: Unbefristeter Entry (z.B. kommittierte Chat-Nachrichten `Msg` oder `Thread`).
- Endliche Dauer (z.B. `30_000` ms): Ideal für Teilnehmer-Präsenz (`Presence`) oder verzögerte Sperren (`TimerLock`).
- Mit `space.renew(leaseId, ms)` verlängert der Besitzer die Lease; mit `space.cancel(leaseId)` beendet er sie sofort.

### Transaktions-Isolation und Sichtbarkeit {#transaction-visibility}

Eine Space-Transaktion wird mit `const txn = await space.createTransaction(leaseMs)` geöffnet:

1. **`write(entry, txn.id)`**: Der neue Entry ist bis zum `commit(txn.id)` **nur innerhalb derselben Transaktion `txn.id` sichtbar**. Für alle anderen Teilnehmer existiert er noch nicht. Bei `abort(txn.id)` wird er verworfen.
2. **`take(template, timeout, { txn: txn.id })`**: Der entnommene Entry wird **reserviert** (für alle anderen unsichtbar gesperrt). Erst `commit(txn.id)` entfernt ihn endgültig. Bei `abort(txn.id)` oder wenn die Transaktions-Lease abläuft, wird die Reservierung aufgehoben und der Entry ist wieder für andere Worker verfügbar. Ohne `txn` entfernt `take` den Entry sofort.
3. **`read` vs. `readIfExists` / `take` vs. `takeIfExists`**:
   - `read` und `take` warten bis `timeout`, falls noch kein passender Entry existiert.
   - `readIfExists` und `takeIfExists` kehren sofort mit `null` zurück, wenn kein passender Entry im Space liegt. Sie warten **nur** dann bis `timeout`, wenn ein passender Entry zwar existiert, aber gerade durch eine fremde Transaktion gesperrt ist.

### Fehlt der Entry oder ist er nur gesperrt? {#typed-misses}

Ein `null` sagt nicht, warum nichts kam. `probe(template, timeout, { take? })` liefert deshalb `{ entry, locked }`: `locked` ist gesetzt, wenn Treffer existieren, aber jeder von einer anderen Transaktion gehalten wird. `probe` ist eine optionale Fähigkeit von `SpaceLike`; `PhiSpaces` und `RemoteSpace` bieten sie an.

Bequemer sind `readExisting` und `takeExisting` aus den Client-Helfern: `null` heißt weg, ein Fehlschlag nur wegen gehaltener Treffer wirft `StillHeld`. Ohne `probe` gilt `null` als weg.

### Lange Arbeit und mehrere Schritte {#long-work-and-batches}

- **`keepAlive(space, lease, leaseMs)`** erneuert eine Lease alle `leaseMs / 3`, solange lange Arbeit darin läuft, und liefert die Stopp-Funktion.
- **`batch(ops, { request? })`** führt bis zu 64 Schritte (`begin`, `write`, `take`, `read`, `commit`, `abort`) in einem Commit aus, alle oder keiner. `txn: "$"` meint die Transaktion, die ein `begin` weiter vorn im selben Batch geöffnet hat. Das kostet eine Runde statt einer je Schritt. `take` und `read` warten im Batch nie.

## Beispiele {#examples}

```ts
// Transaktionale Bearbeitung eines ChatTasks im Multiplayer Space-Chat:
const txn = await space.createTransaction(30_000);
try {
  const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
  if (!task) {
    await space.abort(txn.id);
    return;
  }
  await space.write({
    type: "Msg",
    fields: {
      msgId: "msg-2",
      threadId: "main",
      seq: 2,
      author: "pi-agent",
      role: "assistant",
      text: "Antwort auf: " + task.fields.prompt,
      taskId: task.fields.taskId,
      createdAt: Date.now()
    }
  }, txn.id, FOREVER);
  await space.commit(txn.id); // Atomar: ChatTask verschwindet, Msg wird sichtbar
} catch (err) {
  await space.abort(txn.id); // ChatTask kehrt in den Space zurück
  throw err;
}
```

```ts
import { readExisting, StillHeld } from "phi-spaces";

// Unterscheidet "weg" von "gerade von jemand anderem gehalten":
try {
  const job = await readExisting(space, { type: "Job" }, 1_000);
  if (job === null) console.log("Kein Job mehr da");
} catch (err) {
  if (!(err instanceof StillHeld)) throw err;
  console.log("Job wird gerade bearbeitet");
}
```

## Siehe auch {#see-also}

- [CompletionProfiles und Ressourcen-Limits](help.topic.completion_profiles_and_limits#overview)
- [Transaktionen – createTransaction, commit & abort](help.api.phispaces_txn)
