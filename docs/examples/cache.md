# Lokaler atomarer Cache

Stand: 2026-10-07. Implementierung: [cache.ts](../../examples/cache.ts).
Tests: [cache.test.ts](../../test/examples/cache.test.ts). Kein Modell oder Netzwerk erforderlich.

```bash
npm run example:cache
```

Die Demo schreibt Alice, ersetzt den Wert versionsgebunden durch Bob und löscht ihn wieder.
Sie verwendet MemoryStorage. Mit persistentem Harness bleiben Werte und Versionszähler über
JSONL-Reopen erhalten; dies ist getestet.

## Vertrag von SpaceCache

`new SpaceCache(host, namespace?, now?)` bindet den Cache an einen lokalen Harness.
Jede Operation wird in einem Host-Commit serialisiert. Ein Schlüssel ist innerhalb seines Namespace eindeutig.
Ein gewöhnliches Space-write bleibt ein zusätzlicher Entry; die Cache-Klasse implementiert atomaren Ersatz.

| Operation | Semantik |
|---|---|
| get(key) | `{value, version, expiresAt}` oder null bei Miss; gespeicherter null-Wert bleibt ein Hit |
| set(key, value, ttlMs?, expectedVersion?) | atomarer Ersatz; Standard-TTL 60.000 ms; FOREVER möglich |
| expectedVersion weggelassen | unbedingter Ersatz |
| expectedVersion = null | nur schreiben, wenn kein lebender Wert vorhanden ist |
| expectedVersion = Zahl | Compare-and-set; veraltete Version führt zum Fehler ohne Zustandsänderung |
| delete(key, expectedVersion?) | true bei Löschung, false bei Miss; optionale Version schützt vor veraltetem Delete |

Der persistente, gemeinsame Versionszähler steigt bei erfolgreichen Writes auch nach Delete oder Ablauf.
So kann eine alte Version keinen später neu angelegten Wert ersetzen. TTL wird beim Write festgelegt;
get verlängert sie nicht. TTL 0 ersetzt den alten Wert durch einen sofort abgelaufenen Wert.
Erneuerung erzeugt eine neue Version mit neuer Deadline.

Werte sind JSON-kompatibel, werden kopiert und sind auf 60 KiB begrenzt. Namespace-Länge 1–128,
Schlüssellänge 1–256, TTL eine nichtnegative sichere Ganzzahl. Binärdaten müssen explizit kodiert werden.
Ein fehlgeschlagener Ersatz (CAS oder Space-Byte-Limit) stellt den alten Wert wieder her.
Die Host-Operationen verwenden das Space-Byte-Limit, keine Conversation-Quotas oder Agenten-Tools.
Verwaltete Schlüssel ausschließlich über SpaceCache schreiben: externe Reservierungen, uncommitted
Writes und doppelte Entries werden als Konflikte abgewiesen; die Klasse repariert sie nicht automatisch.

Getestet sind Namespace-Isolation, Null-Hits, konkurrierende Ersetzungen und CAS, TTL/Erneuerung,
veraltete Deletes, Rollback, externe Txn-Konflikte und JSONL-Reopen.

## Zukünftiger verteilter Cache

LWW, HLC sowie Partition/Resync einer Federation sind **nicht implementiert** und folgen dem
[v3-Zielplan](../federation-plan-v3.md). Der lokale Versionszähler ist keine verteilte Merge-Regel.
Ein beidseitig beschreibbarer LWW-Cache kann während einer Partition unterschiedliche Reads liefern;
Abnahme verlangt deterministische Konvergenz nach vollständigem Austausch. Versionierte Tombstones
müssen dieselbe Merge-Regel wie Werte verwenden, damit alte Replikate gelöschte Werte nicht wiederbeleben.
Replay darf Deadlines nicht verlängern; Zeitunsicherheit, Offline-Rejoin und Tombstone-GC benötigen eigene Tests.
LWW-Zähler sind kein korrektes Aggregationsverfahren für Hits/Misses.

Keine gemessenen Latenz-, Durchsatz- oder Verfügbarkeitswerte.
[Zur Übersicht](README.md).
