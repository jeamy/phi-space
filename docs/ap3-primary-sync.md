# Synchroner Storage-Commit-Baustein

Stand: 2026-10-15. Der Baustein erfasst die vollständigen `StorageWrite`-Batches
unterhalb eines Harness. Er ist noch keine produktive Primary-/Standby-Freigabe
und aktiviert keinen Sync-Modus der FederationPolicy.

## Versiegelung und Entscheidung

`PrimarySyncJournal` hält einen lokalen SQLite-Journal mit `synchronous=FULL`.
Es ist kein unabhängiges Recovery-Register. Seine feste Konfiguration bindet
Space, Autorität, Primary-/Standby-Replikat, Epoche und Konfigurationsversion.
Eine abweichende Konfiguration beim Wiederöffnen wird abgewiesen.

`primarySyncStorage(storage, journal, peer, { assertPrimary })` umschließt den
Storage vor dem Öffnen des Harness. Der Callback wird frisch vor Versiegelung und
Anwendung geprüft; er muss Boot-/Rollen-/Fencing-Berechtigungen prüfen und darf
keine erneute fachliche Autorisierung des bereits versiegelten Kandidaten sein.
Die normale Session validiert Geschäftsoperationen vor dem Storage-Aufruf.

Der Journal speichert unveränderliche Intents mit Revision, Vorgängerhash,
Batchhash, vollständigen Deltas und Validierungszeit **vor** dem Senden. Es gibt
am Primary höchstens einen nicht lokal angewendeten Kandidaten. Der Standby nimmt
nur das lückenlos nächste Intent derselben Konfiguration an. Identische Zustellung
liefert dasselbe ACK; geänderter Inhalt derselben Revision oder eine Lücke scheitert.
Das ACK erfolgt nach dauerhaftem Journal-Commit. Der Standby muss dafür noch keinen
öffentlichen Space-Dienst öffnen.

Erst nach dem passenden ACK speichert der Primary Daten und einen kleinen
Replikationsmarker in einem einzigen tatsächlichen Storage-Commit. Der Marker
bindet Konfiguration, Revision, Batchhash und Vorgängerhash. Dadurch kann ein
Neustart einen bereits dauerhaft angewendeten Batch erkennen, ohne dessen
Create-/Append-Wirkungen doppelt auszuführen. Anschließend wird die lokale
Anwendungsposition im Journal gespeichert.

Es werden keine Document-Kinds herausgefiltert: Claims, Transaktionen, Sperren,
Mailboxes, Directory-/Policy-/Root-Dokumente sowie Conversation-/Task-/Submission-
Tabellen gehören zum selben abgefangenen Storage-Batch. Das unterscheidet diesen
Pfad von der fachlichen Entry-Changes-API.

## Neustart und Fehlergrenzen

`recoverPrimarySync(...)` muss **vor** dem erneuten Öffnen des Harness laufen.
Es prüft den materialisierten Präfix und klärt den exakt gespeicherten Kandidaten
mit dem festen Standby. Deadline, Cancel oder Widerruf dürfen dessen Geschäftsdeltas
nicht nachträglich verändern. Ein fehlender Standby oder falsches ACK verhindert
weiterhin eine Bestätigung. Ein Fehler nach Versiegelung liefert `CommitSealed`
mit Revision/Hash und ursprünglicher Fehlerursache.

Die bestehende Persistenzbibliothek sperrt nach einer fehlgeschlagenen Storage-
Annahme die gesamte Session. Sie darf dann weder weitere Mutationen noch Reads
beantworten. Der Adapter verlangt ebenfalls Wiederöffnung und Klärung; es gibt
keinen stillen asynchronen Rückfall.

`materializeSyncHistory(...)` wendet den vollständig angenommenen Standby-Präfix
auf dessen gestoppten Datenstore an, bevor ein Harness geöffnet wird. Vor/nach
Storage-Commit verlorene Antworten sind wiederholbar. Das erteilt ausdrücklich
keine Promotions- oder Boot-Berechtigung.

Der Journal besitzt standardmäßig 256 KiB je Intent und 64 MiB Gesamtbudget;
beide sind beschränkt konfigurierbar. Bei Erschöpfung wird abgewiesen, keine
Bestätigungshistorie zeitbasiert entfernt. Ein nicht leerer, bisher ungetrackter
Store wird nicht als Startpräfix akzeptiert. Bestehende Stores brauchen einen
später explizit gebundenen Snapshot-/Stream-Bootstrap.

## Einbindung und noch offene Gesamtgarantien

Der Adapter gilt für einen dedizierten vollständigen Storagebereich mit einer
Replikatkonfiguration. Mehrere Spaces eines Harness mit unabhängig wechselnden
Replikatversionen brauchen noch eine passende Trennung beziehungsweise einen
vollständigen atomaren Domain-Vertrag. Die vorhandenen produktiven Stores werden
nicht nachträglich ungeprüft umschlossen.

Offen bleiben der authentifizierte Diensttransport, öffentliches `pending/commitSealed`
mit Claim-Auflösung vor lokaler Anwendung, Boot-/Löschintegration einschließlich
des neuen Journals, Snapshot-Bootstrap bestehender Stores, verifiziertes reales
Fencing und Control-/Router-Umschaltung. Konfigurationsübergänge, `setStandby`,
degradeToSingle und Promotion sind seit 2026-10-16 mit Simulator-Adapter
vorhanden ([Replikatsteuerung](ap3-replica-control.md)). Deshalb bleiben produktive Sync-Regeln durch den bestehenden
Policy-Validator gesperrt. Ein ACK des Journal-Bausteins ist kein Promotionsnachweis.

16 neue Fälle auf JSONL und SQLite prüfen verlorene ACKs, Ausfall vor Annahme,
Commit-Verluste vor/nach Primary- und Standby-Anwendung, unveränderte Kandidaten,
Claim-Replay, Transaktionen, Konfigurationskonflikte, falsche ACKs, Lücken/Forks,
ungetrackte Daten und beschädigte Marker. Die vollständigen aktuellen
[Nachweise](../test/evidence/ap3-next-2026-10-15/README.md) enthalten den gebauten
Serverlauf. Physischer Storage-/Hostverlust und Power-Loss besitzen dadurch noch
keine neue Gesamtfreigabe.
