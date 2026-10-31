# AP 2.1 und 2.8: Router-Grundgerüst und Simulator

Stand: 2026-10-11. Diese beiden Arbeitspakete sind implementiert und auf JSONL
und SQLite geprüft. Delegation, Routing und Membership sind inzwischen separat
als [AP 2.2–2.5](../ap2-delegation-routing-membership.en.md) implementiert; die vollständige System- und Lastabnahme bleibt offen.

## Router

`src/router.ts` implementiert `RouterController` über separate, session-scoped
Dokumentfamilien `phi-spaces.router-journal` und `phi-spaces.router-command`.
Journal und Commands liegen damit im gleichen persistenten Harness; Index,
Zustand und Reservierung werden atomar verändert. Diese Dokumente sind keine
über die normale Space-API lesbaren oder nehmbaren Entries.

Ein Command bindet ID, Routingbereich, unveränderliche Ziele, Principal,
Generation, Methode, Argument-Hash und pro Schritt eine stabile Unterrequest-ID.
Ein Wiederholungsversuch mit derselben Command-ID und anderen Argumenten wird
verweigert. Ziel, Inkarnation oder Unterrequest werden bei Transportfehlern nie
ersetzt. Vor dem ersten entfernten Aufruf steht der Schritt dauerhaft auf
`inflight`. Ein Neustart rekonstruiert den Index, die Reservierungen und die
Bindings und fragt solche Schritte zuerst am ursprünglichen Ziel ab.

Der Zieladapter muss das idempotente RPC-Claim-Protokoll implementieren.
`done`, `pending`, endgültiger Fehler und `notAdmitted` benötigen gebundene
Nachweise mit Ziel, Principal, Methode, Generation, Unterrequest und Hash.
Nur der Nachweis einer noch gültigen Generation ohne jemals angenommenen Claim
ermöglicht eine erneute Übermittlung derselben Unterrequest-ID. Fehlende oder
abgelaufene Historie sowie eine neue Inkarnation ergeben `needsReview`.
Transportausfälle lassen den Command `applying`; sie beweisen keinen Fehler.

`recover()` sendet keine neuen Wirkungen. Nach der Rekonstruktion nimmt der
Router unabhängige Arbeit an, obwohl FOREVER-Waiter oder unerreichbare Ziele
offen bleiben. `blocksArea` reserviert einen Bereich für ungeklärte Policy- oder
Membership-Änderungen. Eine normale ausstehende Datenoperation blockiert den
Bereich nicht. `advance()` betreut die Schritte; ein späteres Poll entscheidet
einen inzwischen erfüllten Waiter. Mehrere Schritte sind sequenziell und können
Teilwirkungen haben; sie bilden keine verteilte Transaktion.

`reconcileDataRestore()` persistiert für Unterrequests der restaurierten alten
Inkarnation `needsReview`, einschließlich noch nicht gesendeter Schritte.
Vorhandene Resultate bleiben historische Nachweise; es gibt keine Neuplatzierung
und keinen automatischen Ersatzrequest. `review()` verlangt eine separate
Admin-Autorisierung, speichert begrenzte Notizen und kann eine Bereichssperre
aufheben. Der historische Command wird dadurch nicht als erfolgreich umgeschrieben.

`ingest()` bestätigt eine Mailbox erst nach dauerhafter, deduplizierter Übernahme
des Commands. Bei unbekanntem Storage-Commit wird die Instanz gesperrt und der
Aufrufer muss den Harness neu öffnen und rekonstruieren. Auch ein verlorenes
ACK darf mit derselben Command-ID wiederholt werden.

Die Startbudgets sind 128 Commands, 16 Schritte, 128 KiB je Command einschließlich
reservierter Ergebnisse/Reviews, 32 KiB Index, 192 KiB Commit und 4 MiB Journal
inklusive Indexreservierung. Pro Schritt werden standardmäßig 16 KiB für das
Ergebnis reserviert. Deshalb können 16 Schritte kleinere explizite Ergebnisbudgets
benötigen. Aufnahme scheitert vor einer Wirkung, wenn eine Grenze überschritten
wird. Alte IDs werden nicht zugunsten neuer Arbeit gelöscht. Diese Werte ersetzen
nicht den Lasttest aus AP 2.9.

Der verpflichtende `assertAuthority`-Adapter muss konkurrierende Journal-Besitzer
fencen. Er wird vor Zugriffen, vor Commits, innerhalb des Commits und unmittelbar
vor dem Senden geprüft. Die Tests verwenden einen ausdrücklichen Fixture-Guard.
Die produktive Verbindung zu signierter RouterLease, Delegation, Policy-Versionen
und geschützten Router-RPCs ist in AP 2.2 implementiert und separat geprüft.

## Simulator

`test/support/federation-simulator.ts` betreibt mehrere echte persistente Harnesses
mit `PhiSpaces`, `SpaceService` und RPC-Claims. Der Transport ist simuliert;
Overlay-Identität, TLS, Fencing-Hardware und Android werden damit nicht abgenommen.

Eine virtuelle Ereignisuhr ordnet gleiche Zeitpunkte durch eine Sequenznummer.
Host-Uhren können separat vor- und zurückspringen; die Ereignisreihenfolge läuft
weiter monoton. Ein gesetzter Seed reproduziert die Latenz- und Fehlerfolge.
Gültige Generationen verwenden weiterhin echte Kryptografie; öffentliche
Traces ersetzen ihre zufälligen Werte durch stabile Bezeichnungen.

Fehler umfassen verzögerte Zustellung, Verlust vor Zustellung, verlorene Antwort
nach dem tatsächlichen Ziel-Commit, Duplikate, Partitionen und Crash/Reopen.
Ein separates Gegenmodell verfolgt Inventar, Reservierungen, Request-Hashes,
Entscheidungen und Gewinner. Es verhindert einen zweiten destruktiven Gewinner,
konkurrierende Reservierungen und Änderungen bereits entschiedener Ergebnisse.
Vergleiche verwenden tatsächliche Entries und Claims aus den Ziel-Harnesses.

## Nachweise

`test/test-router.test.ts` enthält 45 Fälle und läuft regulär in `npm test`.
Der abschließende Gesamtprüflauf hat 345 Tests bestanden; Typprüfung, 158 Beispieltests und
vier Mobile-Tests sind ebenfalls grün. Zusätzlich wird das gebaute
Produktionsbundle auf beiden Backends mit Duplikat, verlorener Take-Antwort und
Router-Crash/Reopen geprüft. [Nachweise](../../../../test/evidence/ap2-2026-10-11/checks.json). Die Fälle umfassen:

- Duplikat plus verlorene Take-Antwort und Neustart von Router und Ziel;
- Crash vor Senden, nach Antwort und vor/nach dem Resultat-Journal-Commit;
- FOREVER-Waiter mit unabhängigem neuen Write nach Rekonstruktion;
- Partition eines Members und weiter nutzbare unabhängige Routingbereiche;
- Ergebnisablauf, fehlende Historie, Inkarnationswechsel und gefälschte Bindings;
- Ablehnung vor Wirkung bei Budgetüberschreitung, unverbrauchte Mailbox bei Commit-Fehler;
- drei Members mit sequenziellen Teilwirkungen und deterministischen Fehlerfolgen;
- echte Transaktionsreservierung, Neustart, konkurrierender Take und Abort;
- Data-Restore-Sperre für bereits entschiedene und noch nicht gesendete Schritte;
- Autoritätsverlust und korrupte Reservierungsbilanz.

Take-Gewinnerwahl, Drain, HRW und Delegationsfälschung sind inzwischen in AP 2.2–2.5 geprüft. Weitere Admin-Kommandos, MemberStatus, Drei-Member-Sieb und Lastabnahme folgen separat.
