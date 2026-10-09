# pi-spaces: aktueller Implementierungsstand

Stand: 2026-10-09. Diese Seite ist die Ist-Stand-Referenz für Code und
automatisierte Nachweise. Der [Föderationsplan v3](federation-plan-v3.md) bleibt
der Zielvertrag: Seine Garantien gelten nicht allein deshalb, weil einzelne
Bausteine unten bereits vorhanden sind.

## Umfang und Grenzen

Ein Space ist ein persistentes Dokument im `@earendil-works/pi-durable`-Harness.
Der Default-Space (`pi-spaces.space`) und benannte Spaces
(`pi-spaces.named-space`) haben Dokumentversion 5. Eine Registry ordnet Aliase
unveränderlichen `spaceId`s zu; Entry-Views tragen zusätzlich
`gid = <spaceId>/<localId>`.

Der lokale Client `PiSpaces` und der Dienst `SpaceService` benutzen dieselbe
Kernsemantik. Der Dienst ist über In-Process-, Unix-Socket- und TCP-Transport
nutzbar; `RemoteSpace` implementiert dafür den gemeinsamen Basisvertrag
`SpaceLike`. Das ist ein vorhandener Single-Host-RPC-Unterbau, keine Federation:
es gibt noch keinen Router, keine Replikation, keine
Overlay-Peer-Authentisierung mit Challenge und keine v3-Recovery-/Promotion-
Abnahme.

| Baustein | Vorhanden | Nicht daraus ableitbar |
|---|---|---|
| Core | Entries, Templates, Leases, Txns, Notify, Waiter, Limits, Revisionslog und Abschlussprofile | globale Reihenfolge oder externe Exactly-once-Wirkung |
| Lokaler Client | `PiSpaces`, benannte Spaces, Claims, Seiten, Changes | Zugriff auf einen fremden Host ohne Dienst |
| Dienst | Rollen-/Typprüfung, signierte Generationen, dauerhafte Pending/Poll, Mailbox-ACK, Token-Seiten und Quoten | Gate, Enrollment oder Federation-Autorität |
| Remote | `RemoteSpace`, stabile Retries, Notify/Wait/Events/ACK, Unix/TCP und pi-server-Adapter | Overlay-Identität und automatische Federation |
| Betrieb | Testbed und Szenario `sieve-remote` | Produktivfreigabe der Federation oder mobiler Bedienabläufe |

## Daten- und Konsistenzmodell

- Einträge haben `{ type, types?, fields }`; `types` enthält den Haupttyp und
  optionale Supertypen. Ein Template kann `type`, `fields` und `id` enthalten;
  `null` bzw. fehlende Template-Felder sind Wildcards. Feldvergleich ist tiefe
  JSON-Gleichheit.
- `write` erzeugt immer einen neuen Entry. Ein `take` ist direkt destruktiv oder
  reserviert unter einer Transaktion; Abort oder Lease-Ablauf stellt ihn wieder
  bereit. Writes einer Transaktion bleiben bis Commit unsichtbar.
- `read` und `take` warten bis Timeout. Die `IfExists`-Varianten warten nur,
  solange passende Entries durch fremde Transaktionen gesperrt sind.
- Claims binden Mutation bzw. blockierendes Read/Take und Ergebnis atomar an
  `{ principal, generation, requestId }`. Ein Retry mit gleichen Argumenten
  erhält das gespeicherte Ergebnis; er wiederholt nicht die Mutation. Das
  betrifft keine externen Nebeneffekte.
- Jede fachliche oder interne State-Änderung erhält eine Revision pro Storage-Txn und Space.
  `readPage` liefert `token`, `rev` und `streamId`; `changes` liefert begrenzte Entry-Batches,
  bei reinen State-Änderungen auch leere Batches. Dies ist kein vollständiger Primary-Replikationsstrom. Bei einer
  abgelaufenen Log-Historie ist ein erneuter Seiten-Snapshot erforderlich.

## Ressourcen- und Zugriffsgrenzen

Standardwerte sind in `DEFAULT_LIMITS` definiert und werden pro Space im
Dokument gespeichert. Dazu gehören 64 KiB je Entry/Handback, 64 MiB
Entry-Felder insgesamt, 32 MiB Claims, 8 MiB Outbox, 128 MiB Gesamtdokument,
192 KiB Commit, 256 KiB Frame, 160 KiB Event und 4 MiB Revisionslog. Weitere
Owner-Quoten begrenzen Entries, Registrierungen, Waiter und Transaktionen. Mailboxes sind auf
8 MiB und höchstens 7 Tage begrenzt, Snapshot-Caches je Space auf 64 MiB/16 Tokens/60 s;
dauerhafte Folgeaufträge auf 16 MiB. Spätere Subscriptions aktualisieren Txn-Reservierungen;
Limits dürfen bestehende Abschlussverpflichtungen nicht unterschreiten.

Conversation-Clients besitzen ihre erstellten Transaktionen, Leases,
Registrierungen und Waiter. Host-Code ohne `as` ist administrativ; nur er kann
Limits ändern. Der Dienst leitet die Identität ausschließlich aus seinem
`IdentityAdapter` ab und prüft Methoden sowie erlaubte Entry-Typen per Policy.

## Nachweise

Die [AP-1-Abnahme](ap1-abnahme.md) beschreibt die neuen Regressionen, das persistente v4-Fixture,
Mailbox-TTL/ACK, Profile, begrenzte Wartung und den echten pi-serverd mit gebautem Bundle.

`npm test` deckt Core, Persistenz, Claims, Budgets, Stream, Dienst,
`RemoteSpace`, Socket, Szenario und TUI ab. Der Socket-Test enthält parallele
Aufrufe, verlorene Antworten, Host-Neustart und TCP auf Loopback. Das Testbed
führt zusätzlich das produktionsnahe Szenario `sieve-remote` über das
NetBird-Overlay aus. Details und die weiterhin offenen Sicherheits- und
Federation-Gates stehen im [Implementierungsplan](implementierungsplan-v3.md)
und in [testumgebung-big.md](testumgebung-big.md).

## Abgrenzung zu älteren Dokumenten

[spaces-v1.md](spaces-v1.md) beschreibt den lokalen Stand vom 2026-10-07 und
bleibt als historische Momentaufnahme erhalten. Seine offenen Punkte L2, L3,
L7 und L13 sind durch Revisionen/Changes, globale IDs, Byte-Budgets und
bytebegrenzte Seiten überholt. Historische v1/v2-Föderationspläne sind keine
Implementierungsvorgabe.

Die nutzbare API steht in [api.md](api.md).

## Mailboxes und Task-Abschluss

Remote-Events adressieren strukturierte Principals. ACK bestätigt ausschließlich einen bereits
ausgelieferten zusammenhängenden Präfix der passenden Epoche, keinen Task-Abschluss. Nach TTL-Verlust
meldet der Server Gap und neue Epoche; nicht bestätigte Take-Events führen zur dauerhaften Freigabe
der zugehörigen Transaktion. ACKed Takes behalten ihre separate Txn-Entscheidung. Abschlussprofile
prüfen vor Commit Ergebnis-Typ, Zuordnungsfelder und Anzahl; das Sieb setzt sie im benannten Space ein.

Pending-RPCs benötigen nach Reopen keinen alten Aufrufer: separate persistente Waiter halten die
Ausführungsdaten, Claims behalten Hash/Deadline/Ergebnisreservierung. `ResultExpired` wiederholt keine Wirkung.
`count`/`stats` und die mitgelieferte Revision stammen im Dienst aus demselben Snapshot.
