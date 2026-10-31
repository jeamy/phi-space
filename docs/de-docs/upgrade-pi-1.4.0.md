# Upgrade der Earendil-Anbindung auf 1.4.0

Stand: 30.10.2026. Das Upgrade betrifft das Agent-Paket, CodeMode und die benachbarte mobile Runtime.
Der eigenständige Space-Kern und sein SQLite-Format werden nicht auf pi-durable umgestellt.

## Paketstand

| Bereich | Version |
|---|---|
| `agent/`: pi-durable, pi-ai, Chord | exakt `1.4.0` |
| Root-Beispiele und Codemode-Chat: pi-codemode | exakt `1.4.0` |
| Mobile Runtime: pi-durable, pi-ai, Chord und pi-coding-agent | exakt `1.4.0` |
| Mobile Runtime: pi-client, pi-server und transitives pi-protocol | `1.1.0`, letzte veröffentlichte Version dieser Pakete |

**Transport-Ausnahme:** pi-client/pi-server/pi-protocol wurden nicht als 1.4.0 veröffentlicht.
Ihre Version 1.1.0 importiert alte Chord-RPC-Exports, die in 1.4.0 fehlen
(unter anderem `createServiceCatalogueCall`). Die Runtime isoliert deshalb mit npm-Overrides
deren Chord-Abhängigkeit auf `1.1.0`. Das Harness verwendet weiterhin Chord `1.4.0`.
Ein pauschales Deduping auf eine einzige Chord-Version würde diese Grenze wieder brechen.

## Anpassungen

- Werkzeugergebnisse verwenden `output` statt `content`; das betrifft Space-Werkzeuge,
  das arXiv-Beispiel und das mobile Subagent-Werkzeug. Nachrichten an das Modell behalten ihre eigene
  `content`-Struktur.
- Das kleine Generationen-Dokument schreibt jede Änderung als Basis (`checkpointWhen: () => true`).
  Der mobile Session-Katalog schreibt spätestens mit der 500. Änderung seit der letzten Basis eine neue Basis.
- Agentenbeispiele und -tests benutzen den Chord-Kontext. Der Space-Kern behält seinen eigenen Kontext
  ohne Earendil-Abhängigkeiten.
- `agentContext` ergänzt für einen Space-/Legacy-Transport-Kontext einen NOOP-Telemetrie-Span.
  Abbruchsignal und Anwendungswerte bleiben erhalten; ein vorhandener Agentenkontext wird unverändert verwendet.
- `withAgentEventSink` adaptiert Conversation-Zustellung an beiden Aufrufgrenzen.
  Der Mobil-Bundle exportiert diese Brücke zusätzlich unter dem bisherigen Namen `withEventSink`.
- pi-serverd adaptiert den Kontext des älteren RPC-Transports vor Harness-Aufrufen.

## Daten und Betrieb

pi-durable 1.4.0 migriert seine SQLite-Datenbank automatisch auf Schema 2.
Eine so migrierte Agentendatenbank kann nicht mehr mit 1.3.0 oder älter geöffnet werden.
Vor dem Start einer aktualisierten Installation müssen Agentendatenbanken gesichert werden,
einschließlich des zugehörigen WAL-Zustands beziehungsweise über eine konsistente SQLite-Sicherung.
Ein Rollback auf die alte Laufzeit braucht den alten Datenbankstand.

Das ist unabhängig von Format 2 des eigenen phi-spaces-Speichers.
Vorhandene Laufzeitdatenbanken werden beim lokalen Installieren oder Bündeln nicht geöffnet.
Die Tests verwenden isolierte Testverzeichnisse; dieses Upgrade startet keine produktiven Dienste,
führt keine Remote-Bereitstellung aus und baut keine Android-APK.

Die Mobile-Runtime wird durch `npm run bundle` mit dem Agenten-/Space-Bundle und den Beispielen synchronisiert.
Ein späteres Deployment oder Android-Build ist ein gesonderter Schritt; vor dem ersten Start auf einem
Gerät oder Server gilt die Sicherungsanforderung.

## Prüfungen

- Root: `npm run typecheck`, `npm test`.
- Agenten: `npm run typecheck:agent`, `npm run test:agent`; einschließlich gebautem Bundle im echten pi-serverd.
- CodeMode-Chat: eigener Typecheck und Tests.
- Hilfeseite: Dokumentationsprüfung und Tests des gemeinsamen Modellzugriffs.
- spaces-mmo: eigener Typecheck und Tests; Live-Modellaufrufe bleiben aus.
- Mobile: `npm test` in `runtime/` und `node --test test/spaces-mobile.test.mjs`.
- Bundle: `npm run bundle`; keine Änderung an laufenden Hosts.

Lokale Tests ersetzen weder eine reale Modell-/OAuth-Abnahme noch eine Android-Geräteabnahme.
Eine bestehende produktive Agentendatenbank wird nicht als Testfixture verwendet.

### Ergebnis des lokalen Prüflaufs

| Prüfung | Ergebnis |
|---|---|
| Root-Typecheck und Importwächter | bestanden |
| Root-Tests | 604 bestanden, 1 übersprungen (`PHI_SPACES_BOOTSTRAP_COPY` nicht gesetzt) |
| Agenten-Typecheck und -Tests | bestanden; 91 Tests, einschließlich echter pi-serverd-Abnahme |
| CodeMode-Chat | Typecheck bestanden; 113 Tests bestanden |
| Hilfeseite | Typecheck und Dokumentationsprüfung bestanden; 59 Tests bestanden, 1 produktionsabhängiger Test übersprungen |
| spaces-mmo | Typecheck bestanden; 160 Tests bestanden, 1 Gartentest fehlgeschlagen |
| Mobile Runtime | 22 Offline-Tests bestanden, einschließlich Session-Katalog-Wiederöffnung und Subagent-Ergebnis |
| Mobiler Space-Lebenszyklus | 6 Tests bestanden |
| Bundle und mobile CLI | Bundle synchronisiert; CLI meldet `1.4.0` |

**Offene MMO-Abweichung:** `spaces-mmo/tests/garden.test.ts:173` scheitert bei
`every harvested plant gave its yield once`. Im Gesamtlauf wurden 2 statt 3,
im isolierten Wiederholungslauf 3 statt 4 Ertragseinheiten gezählt.
Die Gartentests und mehrere zugehörige MMO-Dateien waren schon vor diesem Upgrade geändert;
diese Änderungen bleiben unangetastet. Modellaufrufe sind in der Suite abgeschaltet.
Die MMO-Gesamtsuite ist damit ausdrücklich **nicht grün**.
Der spätere Stand vom 31.10.2026 steht im [Prüflauf des Vergleichs](../vergleich-pi-durable.en.md#check-run): 173 von 173 bestanden, unter Last vereinzelte Fehlschläge.

Ein erster, gleichzeitig mit den großen Suiten gestarteter mobiler Prüflauf hatte zwei
Zeitüberschreitungen. Der anschließende isolierte Lauf und der abschließende Lauf mit den beiden
neuen Regressionstests bestanden vollständig.

## Zusammenhang mit dem Vergleich

[vergleich-pi-durable.md](../vergleich-pi-durable.en.md) beschreibt den Stand nach diesem Upgrade.
Die dort genannten 1.0.3-Abhängigkeiten und Upgrade-Hürden sind der historische Ausgangspunkt,
nicht der aktuelle Paketstand.
Der unveröffentlichte Earendil-main-Stand wird ausdrücklich nicht übernommen.
