---
standard: help_topic
id: help.topic.task_lifecycle
title: "Task-Lebenszyklus und sichere Wiederholung"
short: "Ein Task-Entry und seine Transaktionsreservierung haben getrennte Leases. Die Reservierung verhindert gleichzeitige Übernahme; erst der fachliche Commit macht Taskentnahme und Ergebnis endgültig."
tags: [task, abort, lease, retry, completion, ThreadSequence, unique, fork]
owner: core
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Task-Lebenszyklus und sichere Wiederholung

## Zwei Lebensdauern, zwei Abschlüsse {#overview}

Ein Task-Entry und seine Transaktionsreservierung haben getrennte Leases. Die Reservierung verhindert gleichzeitige Übernahme; erst der fachliche Commit macht Taskentnahme und Ergebnis endgültig.

## Ablauf und Fehlergrenzen {#states}

1. Producer schreibt den Task mit ausreichender Lease und bei Bedarf RequestRef.
2. Worker öffnet eine begrenzte Transaktion und nimmt den Task.
3. Worker berechnet außerhalb langer Storage-Callbacks und schreibt ein korreliertes Ergebnis unter derselben txn.
4. commit prüft CompletionProfile und Budgets; erst danach Feed-/Cache-Zustand veröffentlichen.
5. Vor Commit führt ein Fehler zu abort; nach Workerabbruch hebt Lease-Ablauf die Reservierung auf, sofern der Task noch lebt.
6. Nach verlorener Commit-Antwort bleibt der Ausgang unklar: dieselbe Request-Identität klären, nicht blind eine neue Wirkung anstoßen.

## Chat: Sequenzen, Singleton und Fork {#chat}

ThreadSequence ist ein Space-Entry und wird für die Sequenzvergabe transaktional reserviert; Msg und neuer Zählerstand committen zusammen. Nicht allein einen lokalen ++-Zähler verwenden. write mit unique: ["threadId"] prüft die Singleton-Erstanlage atomar; vorangestelltes read + write wäre ein Rennen. Ein Fork schreibt parentThreadId/forkUpToSeq; geerbte Nachrichten werden beim Lesen aufgelöst, nicht kopiert. [write API](help.api.pispaces_write#parameters).

## Abnahme und Grenzen {#failure-test}

Prüfen: zwei konkurrierende Worker, Fehler vor Ergebnis, CompletionViolation, abgelaufene Task-Lease, Prozess-Reopen und doppelte Request-ID mit gleichen/anderen Argumenten. Erwartung: maximal ein committed Take, kein Phantomcache und kein neuer Effekt unter einem alten Retry. Eine abgelaufene Task-Lease darf den Task entfernen. Externe E-Mail-/HTTP-/LLM-Wirkungen brauchen eigene Idempotenz; ein CompletionProfile prüft keine inhaltliche Ergebnisqualität.
