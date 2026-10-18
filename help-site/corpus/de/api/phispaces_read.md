---
standard: help_api
id: help.api.phispaces_read
title: "read & readIfExists – Entry zerstörungsfrei lesen"
short: "Sucht einen passenden sichtbaren Entry anhand eines Templates (fehlende/null-Felder sind Wildcards) und wartet bis zum Timeout."
tags: [read, readifexists, template, wildcard, timeout]
owner: client
related: [help.topic.entries_and_templates, help.api.phispaces_take]
since: 0.0.1
---

# read & readIfExists – Entry zerstörungsfrei lesen

## Überblick {#overview}

`read(template, timeout, options?)` gibt einen passenden `EntryView` zurück, ohne ihn aus dem Space zu entfernen. Ist noch kein Treffer sichtbar, wartet der Aufruf bis zu `timeout` Millisekunden (`NO_WAIT = 0` kehrt sofort zurück).

## Technische Referenz {#technical-reference}

```ts
const view = await space.read({ type: "SearchResult", fields: { searchId: "s-1" } }, 5_000);
const immediate = await space.readIfExists({ type: "Thread", fields: { threadId: "main" } }, 1_000);
```

- `readIfExists` wartet **nur**, solange passende Entries durch fremde offene Transaktionen gesperrt sind; gibt es überhaupt keinen Treffer, kehrt es sofort mit `null` zurück.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| `template` | `Template` | Suchmuster `{ type?, fields?, id? }`; fehlende oder `null`-Felder wirken als Wildcards, `types`-Subtypen werden mitgematcht. |
| `timeout` | `number` | Maximale Wartezeit in ms; `NO_WAIT = 0` kehrt sofort zurück, `FOREVER` wartet unbegrenzt. |
| `options.txn` | `string` | Optional: Liest auch eigene, noch nicht committete Entwürfe derselben Transaktion. |
| **Rückgabe** | `Promise<EntryView | null>` | Der passende Entry inklusive `gid`, `type`, `fields` und Metadaten – oder `null` bei Timeout. |

## Typische Anwendungsfälle {#use-cases}

- **Thread-Prüfung**: `readIfExists({ type: "Thread", fields: { threadId } })` prüft, ob ein Gesprächskontext bereits existiert, bevor ein Client ihn anlegt.
- **Ergebnis-Warte**: Der Subagent-Consumer wartet per `read({ type: "SearchResult", fields: { searchId } }, 60_000)` blockierend auf das Suchergebnis, statt zu pollen.
- **Zustandsabfragen**: `RunGate`-, `Worker`- und `Alert`-Entries werden von `AdminSpaces` genau so abgefragt.
