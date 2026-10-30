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

`read` sucht einen Eintrag, der zu einem Muster passt, und lässt ihn im Space. Findet es noch keinen, wartet es bis zur angegebenen Zeit. Du nutzt es, um einen Zustand zu prüfen oder auf ein Ergebnis zu warten. `readIfExists` wartet nicht auf neue Einträge, sondern nur auf laufende Änderungen an vorhandenen.

## Technische Referenz {#technical-reference}

`read(template, timeout, options?)` gibt einen passenden `EntryView` zurück, ohne ihn aus dem Space zu entfernen. Ist noch kein Treffer sichtbar, wartet der Aufruf bis zu `timeout` Millisekunden (`NO_WAIT = 0` kehrt sofort zurück).

```ts
const view = await space.read({ type: "SearchResult", fields: { searchId: "s-1" } }, 5_000);
const immediate = await space.readIfExists({ type: "Thread", fields: { threadId: "main" } }, 1_000);
```

- `readIfExists` wartet **nur**, solange passende Entries durch fremde offene Transaktionen gesperrt sind; gibt es überhaupt keinen Treffer, kehrt es sofort mit `null` zurück.
- `probe(template, timeout, { take? })` sagt, warum nichts kam: `{ entry, locked }`, wobei `locked: true` einen Fehlschlag allein wegen gehaltener Treffer meldet. Es ist in `SpaceLike` optional; remote gehört es zum Feature `read.locked`.
- `readExisting(space, template, waitMs, { txn })` aus `phi-spaces` baut darauf auf: `null` heißt weg, ein noch gehaltener Treffer wirft `StillHeld`. Ohne `probe` gilt `null` als weg.
- `peek(space, template, { txn })` liest den ersten Treffer als Schnappschuss (`readAll` mit `limit: 1`) und hinterlässt keinen Claim.
- **Warten kostet wenig**: Lokal weckt eine Änderung den Aufruf, er schaut nach 20 bis 40 ms erneut. Remote pollt der Dienst alle 50 ms; mit `wakeOnCommit` schaut er beim ersten Commit und dann höchstens alle 25 ms.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| `template` | `Template` | Suchmuster `{ type?, fields?, id? }`; fehlende oder `null`-Felder wirken als Wildcards, `types`-Subtypen werden mitgematcht. |
| `timeout` | `number` | Maximale Wartezeit in ms; `NO_WAIT = 0` kehrt sofort zurück, `FOREVER` wartet unbegrenzt. |
| `options.txn` | `string` | Optional: Liest auch eigene, noch nicht committete Entwürfe derselben Transaktion. Weitere Optionen: `deadline`, `request`, lokal `once`. |
| **Rückgabe** | `Promise<EntryView | null>` | Der passende Entry inklusive `gid`, `type`, `fields` und Metadaten – oder `null` bei Timeout. |

## Typische Anwendungsfälle {#use-cases}

- **Thread-Prüfung**: `readIfExists({ type: "Thread", fields: { threadId } })` prüft, ob ein Gesprächskontext bereits existiert, bevor ein Client ihn anlegt.
- **Ergebnis-Warte**: Der Subagent-Consumer wartet per `read({ type: "SearchResult", fields: { searchId } }, 60_000)` blockierend auf das Suchergebnis, statt zu pollen.
- **Zustand prüfen**: Einen Konfigurations- oder Ergebnis-Entry prüfen, ohne ihn zu verbrauchen. Reicht ein Schnappschuss ohne Claim, ist `peek` günstiger.
