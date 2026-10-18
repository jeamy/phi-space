# AP 1.1–1.9: lokale Implementierung und Abnahme

Stand: 2026-10-09. Bezug: [Implementierungsplan](../implementierungsplan-v3.md),
[Federation-Vertrag](../federation-plan-v3.md), [API](../api.md),
[Implementierungsstand](../implementierungsstand.md). Nachweise beziehen sich auf den lokalen Arbeitsstand.

| AP | Geschlossene Punkte | Nachweis |
|---|---|---|
| 1.1 | v4→v5 erhält den Default-Singleton, lokale IDs, Ownership und uncommitted Daten; benannte Spaces separat | persistentes Fixture `test/fixtures/space-v4.json`, JSONL und SQLite mit Reopen |
| 1.2 | stabile Registry-/Space-Identitäten, Inkarnation und globale Entry-ID | bestehende Spaces-Tests und Migrations-Reopen |
| 1.3 | ein Revisionsbatch je Space/Storage-Txn, auch bei mehrfachem Dokumentzugriff; unveränderliche Snapshot-Tokens | konkurrierende Änderungen und Ablauf während fünf großer Entry-Seiten, Query-/Owner-Bindung; begrenzte Changes |
| 1.4 | gemeinsame Commit-Abrechnung, Abschlussreservierungen einschließlich späterer Subscriptions; echte UTF-8-Seiten mit Antwortumschlag; kein stiller 1000er-Cutoff | atomarer Rollback bei kumulierten Writes, abgewiesene unsichere Limitabsenkung, Seiten-/Frame-Grenzen |
| 1.5 | HMAC-Generationen mit persistentem Host-Schlüssel; Hash-/Space-Prüfung auch bei Pending-Retry; separate dauerhafte Ausführung und Ergebnisreservierung | Reopen ohne alten Aufrufer, feste Deadline, Manipulation, Ergebnisablauf und bekannte Wiederholung unter Pending-Quota |
| 1.6 | Principal-Mailboxes, Prefix-ACK nur ausgelieferter Sequenzen, TTL/Byte-Grenze, Gap/Epochwechsel und registrationClosed | Cursor darf keine ungelesenen Events überspringen; alte ACKs isoliert; verlorener unbestätigter FOREVER-Take wird freigegeben, ACKed Take bleibt separat reserviert |
| 1.7 | dauerhafte Wartungs-/Fanout-Fortsetzung unter Byte-Budget; CompletionProfile bei jedem Task-Take-Commit | begrenzte Cleanup-Batches und Crash/Reopen; voller Consumer verzögert Events, nicht reservierten Abschluss; Sieb-Commit ohne Ergebnis abgewiesen |
| 1.8 | alle lokalen Space-Methoden, eigene Claims/Mailboxes/Txns, Raten- und Pending-Quoten; count/stats plus Revision aus einem Snapshot | Service-/AP-Tests, Peer-Quota über Agenten hinweg, Zeitfenster für Rate-Limit |
| 1.9 | vollständiger RemoteSpace, begrenzte Client-Wartezeit auch bei hängendem Transport, stabile Retry-Identität; Socket- und pi-server-Adapter | verlorene Antworten, Fristen, sichere Socket-Dateibehandlung, echte pi-server/pi-client-Pakete und gebautes Bundle im wirklichen pi-serverd |

## Reproduzierbare Prüfungen

```bash
npm run typecheck
npm run build
npm test
npm run test:examples
npm run test:pi-server
npm run bundle
```

Die Kern-/Integrationssuite umfasst 184 bestandene Tests, die Beispielsuite 158;
keine Fehler oder Skips bei der lokalen Abnahme. `test/test-pi-server.test.ts` verwendet vorhandene
Pakete des benachbarten mobilen Runtimes. Ohne diese Pakete werden die zwei nativen Tests
explizit übersprungen; dadurch ist keine pi-serverd-Abnahme nachgewiesen. Alternativer Pfad:
`PI_SERVER_RUNTIME_DIR=/pfad/zur/runtime npm run test:pi-server`. Es wird nichts installiert.

Der native Test baut die aktuelle Bibliothek, kopiert die Runtime in ein temporäres Verzeichnis
und startet den wirklichen `pi-serverd.mjs` mit isolierter SQLite-Datenbank, privatem Socket und
leerer Credential-Datei. `sessions.list` bleibt nutzbar; `RemoteSpace` schreibt/nimmt Entries.
Ein zweiter Start ohne konfigurierte Space-Identität verweigert Space-RPC, auch mit gefälschtem
Principal im JSON. Es gibt keine Modellanfrage, keinen Zugriff auf die produktive Datenbank.

Das zusätzliche lokale Szenario:

```bash
node --experimental-strip-types test/testbed/scenarios/sieve-remote.ts all \
  --dir /tmp/phi-spaces-ap1-sieve-run --fresh --end 1001 --block 100 \
  --workers 3 --crash-workers 2 --work-ms 60 --lease-ms 600 \
  --kill-host --timeout-s 25
```

Ergebnis: benannter Space `sieve-remote`, 10/10 Ergebnisblöcke ohne Duplikate, 168 Primzahlen
wie unabhängige Probedivision; nach Host-SIGKILL/Reopen und zwei sterbenden Workern bleiben
keine Tasks, Locks, uncommitted Entries oder offenen Txns zurück. Dieses Szenario verwendet
Unix-Sockets auf dem lokalen Rechner; es belegt keine Overlay-Authentifizierung.

## Einbindung und verbleibende Stufen

`withSpaceService` erweitert die vorhandene pi-server-Serverroute; Session-/Chat-Aufrufe bleiben
auf ihrer Route. `piServerTransport` benutzt den vorhandenen pi-client. Im mobilen Nachbarprojekt
ist der Space-Zugang opt-in über `PI_SERVERD_SPACE_PRINCIPAL` und `PI_SERVERD_SPACE_ROLES`.
SSH-/Socket-Zugang erzeugt keine implizite Rolle. Der Socket repräsentiert eine ausdrücklich
konfigurierte lokale Identität; getrennte entfernte Principals benötigen das Gate aus Phase 1b.

Snapshot-Tokens sind begrenzter hostlokaler Lesecache und nach Host-Reopen ungültig.
Changes bilden sichtbare Entry-Deltas ab; interne State-Commits können leere Batches erzeugen.
Vollständiger Primary-Strom, `pending/commitSealed`, sync-Replikation, Fencing, Promotion,
Gate/Schicht A/B, Router und mobile Verwaltungsoberfläche gehören zu den weiteren Stufen.
Es wurde kein laufender Daemon oder Container auf `big` aktualisiert.

Die Sieb-Vorbereitung ist nun budgetbegrenzt fortsetzbar: Seed und Cursor werden pro Commit
persistiert. Bei Überlast kann ein akzeptierter Präfix stehen bleiben; Wiederholung nach Behebung
setzt dort fort und dupliziert keine Tasks. Der gesamte Seed-Lauf ist keine einzelne Transaktion.
