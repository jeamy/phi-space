---
standard: help_topic
id: help.topic.leases_and_transactions
title: "Leases, Transaktionen und Sichtbarkeit"
short: "Wie Leases selbstheilende Zustände ermöglichen und wie Transaktionen (createTransaction, commit, abort) Writes und Takes atomar isolieren."
tags: [leases, transactions, txn, visibility, locks, ifexists, renew, cancel]
owner: core
related: [help.topic.entries_and_templates, help.topic.completion_profiles_and_limits, help.api.pispaces_txn]
since: 0.0.1
---

# Leases, Transaktionen und Sichtbarkeit

## Überblick {#overview}

In verteilten Systemen stürzen Prozesse ab und Netzwerkverbindungen brechen ab. `pi-spaces` löst dieses Problem durch zwei komplementäre Mechanismen: **Leases** (zeitlich begrenzte Lebensdauer für Entries, Transaktionen, Waiter und Abos) und **Space-Transaktionen** (atomare Gruppierung von `take`-Reservierungen und `write`-Entwürfen).

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
2. **`take(template, timeout, { txn: txn.id })`**: Der entnommene Entry wird **reserviert** (für alle anderen unsichtbar gesperrt). Erst `commit(txn.id)` entfernt ihn endgültig. Bei `abort(txn.id)` oder wenn die Transaktions-Lease abläuft, wird die Reservierung aufgehoben und der Entry ist sofort wieder für andere Worker verfügbar!
3. **`read` vs. `readIfExists` / `take` vs. `takeIfExists`**:
   - `read` und `take` warten bis `timeout`, falls noch kein passender Entry existiert.
   - `readIfExists` und `takeIfExists` kehren sofort mit `null` zurück, wenn kein passender Entry im Space liegt – sie warten **nur** dann bis `timeout`, wenn ein passender Entry zwar existiert, aber gerade durch eine fremde Transaktion gesperrt ist!

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
  await space.commit(txn.id); // Atomar: ChatTask verschwindet, Msg wird sichtbar!
} catch (err) {
  await space.abort(txn.id); // ChatTask kehrt sofort in den Space zurück
  throw err;
}
```

## Siehe auch {#see-also}

- [CompletionProfiles und Ressourcen-Limits](help.topic.completion_profiles_and_limits#overview)
- [Transaktionen – createTransaction, commit & abort](help.api.pispaces_txn)
