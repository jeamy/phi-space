---
standard: help_api
id: help.api.phispaces_completion_profiles
title: "setCompletionProfiles & setLimits – Serverseitige Ergebnis- und Budgetverträge"
short: "Erzwingt vor dem Commit einer Take-Transaktion den erwarteten Ergebnistyp, korrelierende Felder (equalFields) und Anzahl; verwaltet Byte-Limits."
tags: [setcompletionprofiles, setlimits, completionprofile, completionviolation]
owner: core
related: [help.topic.completion_profiles_and_limits]
since: 0.0.1
---

# setCompletionProfiles & setLimits – Serverseitige Ergebnis- und Budgetverträge

## Überblick {#overview}

`setCompletionProfiles` legt fest, welches Ergebnis zu einer Aufgabe gehört. Der Space lehnt dann jeden Abschluss ab, bei dem das Ergebnis fehlt. `setLimits` setzt Größengrenzen für den Space. Beide Aufrufe sind dem Host vorbehalten, und du machst sie einmal beim Einrichten.

## Technische Referenz {#technical-reference}

Nur administrativer Host-Code (ohne gesetztes `conversationId`) darf `setCompletionProfiles(profiles)` und `setLimits(partialLimits)` aufrufen. Das erneute Setzen identischer Profile ist ein No-op. Eine Absenkung von Limits unter bereits bestehende Abschlussverpflichtungen wird vom Space-Kern abgewiesen; das gilt auch für ein kleineres `maxEventBytes`, solange eine bestehende Registrierung oder ein Wait damit ein zu großes Event erzeugen könnte.

```ts
await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
```

## Profil-Felder und Fehler {#parameters}

| Feld | Bedeutung |
| --- | --- |
| `taskType` | Entry-Typ, der unter der Transaktion genommen wurde und eine Ergebnispflicht auslöst. |
| `resultTypes` | Entry-Typen, von denen in derselben Transaktion ein Ergebnis geschrieben werden muss. |
| `equalFields` | Felder, deren Werte zwischen Task und Ergebnis übereinstimmen müssen (Korrelation). |
| `maxResultCount` | Höchstzahl korrelierender Ergebnisse; mindestens eines ist erforderlich. |
| `maxResultBytes` | Gesamtbytegrenze der zu einem Task gehörenden Ergebnisse. |
| `maxLeaseMs` | Obergrenze für die Reservierung. |
| `gateField` | Bindet Tasks an den `RunGate` ihres Laufs; muss in `equalFields` stehen, `maxLeaseMs` ist dann Pflicht. |

Verletzt ein Commit das Profil, schlägt `commit` mit `CompletionViolation` fehl und nichts wird sichtbar. `setLimits` verwaltet Byte-/Größenbudgets des Spaces (z.B. `maxFrameBytes`, `maxEventBytes`, `mailboxTtlMs`). Eine Anzahlquote gibt es standardmäßig nicht: `maxEntries` und `maxEntriesPerOwner` stehen auf `FOREVER`, Byte-, Commit-, Frame- und Dokumentbudgets gelten weiter.

## Typische Anwendungsfälle {#use-cases}

- **Antwortgarantie im Chat**: Der Commit scheitert serverseitig, wenn der Worker den `ChatTask` entnimmt, aber keine passende `Msg` mit gleicher `taskId`/`threadId` schreibt – die Reservierung kann bei Abort zurückgegeben werden, solange Task-Lease und Storage bestehen.
- **Subagent-Vertrag**: `SearchTask → SearchResult` garantiert, dass jede föderierte Suche mit einem korrelierten Ergebnis endet.
