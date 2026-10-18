---
standard: help_topic
id: help.topic.failure_playbook
title: "Fehlerdiagnose und sichere nächste Schritte"
short: "Transportfehler, fachliche Ablehnung und Storage-Fehler sind verschieden. Vor jeder Wiederholung Request-ID, Generation, Argumente, Ziel-Space, Inkarnation und gegebenenfalls Epoche festhalten. Unklar heißt nicht fehlgeschlagen."
tags: [OutcomeUnknown, RequestConflict, ResultExpired, SnapshotExpired, ResourceExhausted, NotCommitted, needsReview, poisoned, recovery]
owner: remote
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Fehlerdiagnose und sichere nächste Schritte

## Erst Ausgang und Schicht bestimmen {#overview}

Transportfehler, fachliche Ablehnung und Storage-Fehler sind verschieden. Vor jeder Wiederholung Request-ID, Generation, Argumente, Ziel-Space, Inkarnation und gegebenenfalls Epoche festhalten. Unklar heißt nicht fehlgeschlagen.

## Entscheidungstabelle {#decisions}

| Fehler | Sichere Aktion | Nicht tun |
|---|---|---|
| OutcomeUnknown / CommitSealed | Dieselbe Request-Identität per pollOperation bzw. zuständigem Recovery-Pfad klären. | Neue ID als vermeintliche Wiederholung senden. |
| RequestConflict | Gespeicherte Argumente/Identität vergleichen; fachliche Änderung als neuen Auftrag behandeln. | Alte ID mit neuen Argumenten erzwingen. |
| ResultExpired / RequestExpired | Fachliche Wirkung unabhängig prüfen; Retention/Zulassungsfrist beachten. | Mutation unter einer neuen ID blind wiederholen. |
| SnapshotExpired / RevisionAhead | Vollständige Baseline neu laden. | Neue erste Seite an alte Daten anhängen. |
| ResourceExhausted | Grenze identifizieren, Transaktion begrenzen/abbrechen, kleinere Batches versuchen. | Quoten unkontrolliert erhöhen. |
| NotCommitted | Autoritative Negativentscheidung und aktuellen Rahmen prüfen; zulässigen neuen Auftrag bewusst starten. | Mit OutcomeUnknown gleichsetzen. |
| needsReview | Tatsächliche Wirkung und Journal prüfen; Entscheidung dokumentieren. | Zweiten Admin-Befehl blind starten. |
| Session is poisoned | Neue Writes stoppen, versiegelten Kandidaten auflösen und Harness wieder öffnen. | Async-Fallback oder unbestätigte Writes fortsetzen. |

## Welche Diagnoseinformationen? {#evidence}

Zeitpunkt, Methode, RequestRef, Argument-Hash statt vertraulicher Nutzdaten, Space-ID, Inkarnation, streamId/rev, primaryEpoch/routerEpoch, Limitname, benötigte Bytes und Queue-/Mailboxstatus protokollieren. Keine Passwörter, privaten Schlüssel, Grants oder Enrollment-Tokens in öffentliche Logs schreiben. Ein Logger allein beweist keine erfolgte Wirkung.

## Gezielt testen {#test}

Antwort nach erfolgreichem Commit verlieren, identischen Retry senden und exakt ein Ergebnis prüfen. Danach andere Argumente unter derselben ID senden: RequestConflict. Tests für Storage-Ablehnung müssen Writes nach Fehler sperren; Reopen separat nachweisen. Diese Anleitung ersetzt keinen ungeprüften Produktions-Recovery-Befehl und keine Fencing-Abnahme.
