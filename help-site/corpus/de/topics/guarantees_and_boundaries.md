---
standard: help_topic
id: help.topic.guarantees_and_boundaries
title: "Verbindliche Garantien und Systemgrenzen"
short: "Was phi-spaces bei lokalen Commits, Retries, Transaktionen, Restores und in der Federation verbindlich garantiert – und was bewusst ausgeschlossen ist."
tags: [guarantees, boundaries, idempotency, consistency, limits, restore, epochs]
owner: core
related: [help.topic.overview, help.topic.request_claims_and_generations, help.topic.gate_auth_grants_and_recovery]
since: 0.0.1
---

# Verbindliche Garantien und Systemgrenzen

## Überblick {#overview}

Ein verlässliches verteiltes System zeichnet sich dadurch aus, dass seine Garantien und seine Grenzen explizit benannt und durch Tests auf persistentem Speicher (JSONL und SQLite) nachgewiesen sind. Dieser Artikel fasst den aktuellen Ist-Stand (`docs/implementierungsstand.md`) und den Vertragsrahmen (`docs/federation-plan-v3.md`) zusammen.

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

### Garantienmatrix {#guarantee-matrix}

| Ebene | Verbindlicher Vertrag in `phi-spaces` | Was ausdrücklich NICHT daraus folgt |
|---|---|---|
| **Lokaler Commit** | Space-Mutation, RPC-Claim, Revisionsnummer `rev` und Mailbox-Event werden unteilbar zusammen gespeichert. | Keine externe Exactly-once-Wirkung für HTTP-Calls, E-Mails oder LLM-Tokenkosten außerhalb des Spaces. |
| **Idempotenter Retry** | Gleiches `{ principal, generation, requestId }` mit identischem RFC-8785-Argument-Hash liefert auch nach Prozessneustart dasselbe gespeicherte Ergebnis ohne zweite Mutation. | Nach Ablauf der Aufbewahrungsfrist (Standard 24 h) liefert ein Retry `ResultExpired` ohne erneute Ausführung. |
| **Take unter Txn** | Höchstens eine aktive Reservierung je Entry; `abort` oder Lease-Ablauf gibt den Entry wieder frei. | Keine globale FIFO-Auswahlreihenfolge über wartende Konsumenten hinweg. |
| **CompletionProfile** | Ein Take-Txn-Commit wird serverseitig mit `CompletionViolation` abgewiesen, wenn Ergebnistyp, korrelierende Felder oder Anzahl nicht stimmen. | Keine inhaltliche Qualitätsprüfung der berechneten Nutzdaten durch den Space-Kern. |
| **Data-Restore (5.2.2)** | Erhöht die Dateninkarnation; alte Generationen scheitern mit `IncarnationChanged`; restaurierte exklusive Tasks sind als `restoredUnverified` bis `releaseRestored` gegen `take` gesperrt. | Ein Restore aus einem asynchronen Backup ist **keine** verlustfreie Promotion. |
| **Operating Limits (Gate 4)** | Frame max. 256 KiB, Commit-Batch max. 192 KiB, Entry max. 64 KiB, max. 32 Verbindungen je Peer / 64 je Listener, Peer-Erkennung 5 s, Grant max. 60 s. | Keine unbegrenzten Batch-Transaktionen; große Vorbereitungen werden in Teilcommits aufgeteilt. |

### Die drei getrennten Epochenzähler {#three-epochs}

In `phi-spaces` ist der Begriff „Epoche“ ohne Präfix unzulässig. Es existieren zwei numerische Zähler und eine strikt getrennte opake Mailbox-Identität:

1. **`primaryEpoch`**: Gilt für einen logischen Space bei Replikation oder Data-Restore (+1 bei Data-Restore, Promotion oder Single-Umschaltung; beginnt nach Control-Restore unter neuer `authorityId` bei 1).
2. **`routerEpoch`**: Gilt für `RouterLease`-Ausstellungen einer Federation (+1 bei Router-Neustart/-Wechsel).
3. **`mailboxEpoch`**: Opake String-Identität einer Consumer-Mailbox. Bei Reset ändert sich der Token; auf Gleichheit prüfen, nicht numerisch inkrementieren oder ordnen.

## Fehler und Diagnose {#failures-and-diagnostics}

- **`OutcomeUnknown`**: Tritt auf, wenn die Client-Wartezeit (`maxClientWaitMs`) abläuft oder die Verbindung vor Empfang der Antwort abreißt. **Wichtig:** `OutcomeUnknown` ist kein Fehlerbeweis! Der Client muss mit derselben `requestId` über `pollOperation` nachfragen.
- **`RequestConflict`**: Dieselbe `requestId` wurde mit veränderten fachlichen Argumenten erneut gesendet.
- **`ResourceExhausted`**: Eine Transaktionserweiterung würde das Commit-/Abort-Bytebudget (`192 KiB`) oder die Dokumentgrenze überschreiten; die bisherige Transaktion bleibt abbrechbar bzw. abschließbar.

## Siehe auch {#see-also}

- [Request-Claims, Generationen und Idempotenz](help.topic.request_claims_and_generations#overview)
- [Overlay-Gate, Authentisierung, Grants und Recovery](help.topic.gate_auth_grants_and_recovery#overview)
