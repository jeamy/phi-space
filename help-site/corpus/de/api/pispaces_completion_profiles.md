---
standard: help_api
id: help.api.pispaces_completion_profiles
title: "setCompletionProfiles & setLimits – Serverseitige Ergebnis- und Budgetverträge"
short: "Erzwingt vor dem Commit einer Take-Transaktion den erwarteten Ergebnistyp, korrelierende Felder (equalFields) und Anzahl; verwaltet Byte-Limits."
tags: [setcompletionprofiles, setlimits, completionprofile, completionviolation]
owner: core
related: [help.topic.completion_profiles_and_limits]
since: 0.0.1
---

# setCompletionProfiles & setLimits – Serverseitige Ergebnis- und Budgetverträge

## Überblick {#overview}

Nur administrativer Host-Code (ohne gesetztes `conversationId`) darf `setCompletionProfiles(profiles)` und `setLimits(partialLimits)` aufrufen. Eine Absenkung von Limits unter bereits bestehende Abschlussverpflichtungen wird vom Space-Kern abgewiesen.

## Technische Referenz {#technical-reference}

```ts
await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
```

## Profil-Felder und Fehler {#parameters}

| Feld | Bedeutung |
| --- | --- |
| `taskType` | Entry-Typ, der unter der Transaktion genommen wurde und eine Ergebnispflicht auslöst. |
| `resultTypes` | Entry-Typ, der in derselben Transaktion geschrieben werden muss. |
| `equalFields` | Felder, deren Werte zwischen Task und Ergebnis übereinstimmen müssen (Korrelation). |
| `maxResultCount` | Höchstzahl korrelierender Ergebnisse; mindestens eines ist erforderlich. |
| `maxResultBytes` | Gesamtbytegrenze der zu einem Task gehörenden Ergebnisse; zusätzlich maxLeaseMs für begrenzte Reservierungen und optional gateField. |

Verletzt ein Commit das Profil, schlägt `commit` mit `CompletionViolation` fehl und nichts wird sichtbar. `setLimits` verwaltet Byte-/Größenbudgets des Spaces (z.B. `maxFrameBytes`, `maxEventBytes`, `mailboxTtlMs`).

## Typische Anwendungsfälle {#use-cases}

- **Antwortgarantie im Chat**: Der Commit scheitert serverseitig, wenn der Worker den `ChatTask` entnimmt, aber keine passende `Msg` mit gleicher `taskId`/`threadId` schreibt – die Reservierung kann bei Abort zurückgegeben werden, solange Task-Lease und Storage bestehen.
- **Subagent-Vertrag**: `SearchTask → SearchResult` garantiert, dass jede föderierte Suche mit einem korrelierten Ergebnis endet.
