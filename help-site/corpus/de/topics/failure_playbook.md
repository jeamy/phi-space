---
standard: help_topic
id: help.topic.failure_playbook
title: "Fehlerdiagnose und sichere nächste Schritte"
short: "Wenn ein Aufruf scheitert, ist nicht immer klar, ob er gewirkt hat. Diese Anleitung zeigt für jeden Fehler den sicheren nächsten Schritt. Die wichtigste Regel: Unklar heißt nicht fehlgeschlagen. Wiederhole also mit derselben Request-ID, nie mit einer neuen."
tags: [OutcomeUnknown, RequestConflict, ResultExpired, SnapshotExpired, ResourceExhausted, NotCommitted, needsReview, poisoned, recovery]
owner: remote
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Fehlerdiagnose und sichere nächste Schritte

## Erst Ausgang und Schicht bestimmen {#overview}

Wenn ein Aufruf scheitert, ist nicht immer klar, ob er gewirkt hat. Diese Anleitung zeigt für jeden Fehler den sicheren nächsten Schritt. Die wichtigste Regel: Unklar heißt nicht fehlgeschlagen. Wiederhole also mit derselben Request-ID, nie mit einer neuen.

## Entscheidungstabelle {#decisions}

Transportfehler, fachliche Ablehnung und Storage-Fehler sind verschieden. Vor jeder Wiederholung Request-ID, Generation, Argumente, Ziel-Space, Inkarnation und gegebenenfalls Epoche festhalten.

| Fehler | Sichere Aktion | Nicht tun |
|---|---|---|
| OutcomeUnknown / CommitSealed | Dieselbe Request-Identität per pollOperation bzw. zuständigem Recovery-Pfad klären. | Neue ID als vermeintliche Wiederholung senden. |
| RequestConflict | Gespeicherte Argumente/Identität vergleichen; fachliche Änderung als neuen Auftrag behandeln. | Alte ID mit neuen Argumenten erzwingen. |
| ResultExpired / RequestExpired | Fachliche Wirkung unabhängig prüfen; Retention/Zulassungsfrist beachten. | Mutation unter einer neuen ID blind wiederholen. |
| SnapshotExpired / RevisionAhead | Vollständige Baseline neu laden. | Neue erste Seite an alte Daten anhängen. |
| ResourceExhausted | Grenze identifizieren, Transaktion begrenzen/abbrechen, kleinere Batches versuchen. | Quoten unkontrolliert erhöhen. |
| NotCommitted | Autoritative Negativentscheidung und aktuellen Rahmen prüfen; zulässigen neuen Auftrag bewusst starten. | Mit OutcomeUnknown gleichsetzen. |
| needsReview | Tatsächliche Wirkung und Journal prüfen; Entscheidung dokumentieren. | Zweiten Admin-Befehl blind starten. |
| PrimarySyncBlocked (poisoned by a sealed candidate) | Neue Writes stoppen, Host neu öffnen und den versiegelten Kandidaten auflösen. | Unbestätigte Writes fortsetzen. |
| StillHeld | Eintrag ist nicht weg, nur gehalten; später erneut prüfen. | Als gelöscht behandeln. |
| UniqueConflict | Vorhandenen Entry lesen und weiterverwenden oder bewusst ablehnen. | Mit anderem Schlüssel ein Duplikat anlegen. |
| StoreUnavailable | Laufenden Besitzerprozess oder falsche Datei prüfen; Format prüfen. | Sperrdatei löschen oder die Datei kopieren, während ein Prozess läuft. |

## Welche Diagnoseinformationen? {#evidence}

Zeitpunkt, Methode, RequestRef, Argument-Hash statt vertraulicher Nutzdaten, Space-ID, Inkarnation, streamId/rev, primaryEpoch/routerEpoch, Limitname, benötigte Bytes und Queue-/Mailboxstatus protokollieren. Keine Passwörter, privaten Schlüssel, Grants oder Enrollment-Tokens in öffentliche Logs schreiben. Ein Logger allein beweist keine erfolgte Wirkung.

## Gezielt testen {#test}

Antwort nach erfolgreichem Commit verlieren, identischen Retry senden und exakt ein Ergebnis prüfen. Danach andere Argumente unter derselben ID senden: RequestConflict. Tests für Storage-Ablehnung müssen Writes nach Fehler sperren; Reopen separat nachweisen. Diese Anleitung ersetzt keinen ungeprüften Produktions-Recovery-Befehl und keine Fencing-Abnahme.
