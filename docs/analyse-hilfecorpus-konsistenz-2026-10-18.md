# Help-Corpus: Konsistenz, Umsetzung und Abschluss

Stand: 18. Oktober 2026. Ergänzt die [Hilfesystem-/Demo-Analyse](analyse-hilfesystem-demo-apps-2026-10-18.md).
Die historischen Befunde bleiben dort erhalten; F01–F23 und die nachfolgenden Corpus-Korrekturen
sind lokal umgesetzt. „Erledigt“ bezeichnet die beschriebene Änderung und ihren lokalen Nachweis,
nicht eine pauschale Produktionsfreigabe.

## 1. Ergebnis und Pflegevertrag

Der Help-Corpus enthält jetzt **45 eindeutige Artikel, 90 lokalisierte DE/EN-Datensätze,
neun Bereiche und 14 API-Referenzgruppen**. Acht zusätzliche Praxisleitfäden schließen die
Lücke zwischen API-Beschreibung und einem tatsächlich ausführbaren Arbeitsablauf.

Die maßgeblichen Textquellen liegen unter `help-site/scripts/`:

- `corpus-articles-data.ts`: Grundlagen und übergreifende Themen.
- `corpus-workflows-and-api.ts`: Stufen und API-Referenz.
- `corpus-practical-guides.ts`: zusätzliche Praxisleitfäden.
- `corpus.ts`: gemeinsame Artikelliste für Generator und Prüfungen.

`help-site/corpus/{de,en}/` und ausgelieferte JSON-/Markdown-Artefakte sind generiert.
Direkte Änderungen dort würden beim nächsten Build verloren gehen. Katalog und API-Klassifikation
liegen in `help_product_catalog.json` und `api_facts.json`; API-Signaturen werden aus dem
TypeScript-Programm abgeleitet, nicht als zweite manuelle API gepflegt.

## 2. Abgeschlossene Befunde

| ID | Status | Korrektur und Nachweis |
|---|---|---|
| C01 | Erledigt | `CompletionProfile` auf `resultTypes`, `equalFields`, `maxResultCount` berichtigt; echte Limitfelder und `ResourceExhausted` statt erfundener Schemata/Fehlernamen. Tatsächliche TS-Codeblöcke werden kompiliert. |
| C02 | Erledigt | `readPage`/`changes` mit `items`, `next`, `token`, `rev`, `streamId`, `batches`, `more` dokumentiert. Snapshot-Ablauf und Streamwechsel führen zum Neuaufbau, nicht zum stillen Weiterzählen. |
| C03 | Erledigt | Lokale Conversation-Zustellung von Remote-Consumer-Mailboxes getrennt; tatsächliche `events`-/`ack`-Signaturen, opake String-Epoch und Verarbeitung vor Präfix-ACK beschrieben. Volle Mailbox ist keine zugesagte verlustfreie Unendlichqueue. |
| C04 | Erledigt | EntryView/Lease-Felder, Entry-ID, Reaper-/Service-Rolle und Fork als Parent-/Sequenzgrenzverweis berichtigt. Keine Nachrichtenduplikation durch vermeintliche Fork-Kopie. |
| C05 | Erledigt | JavaSpaces als semantische Grundlage eingeordnet. Promise-/RPC-Aufruf, wartende Operation, persistente Registrierung und CPU-Arbeit unterschieden. Entkopplung ist keine Behauptung, dass jede Operation sofort oder ohne Service funktioniert. |
| C06 | Erledigt | `FederatedSpace` nicht als austauschbarer `SpaceLike` dargestellt. Host-/Controller-/Run-/Alert-Beispiele an echte Parameter angepasst. V4 = Gate, V5 = Routing, V6 = Betriebssteuerung; Web-Login und Peer-Enrollment getrennt. |
| C07 | Erledigt | API-Signaturen aus echten Exports/Methoden abgeleitet. `strictNullChecks` erhält mögliche Miss-/`null`-Ergebnisse. In inferierten Typen enthaltene absolute Checkout-Pfade werden in relative Quellmodulreferenzen umgewandelt; Regressionen prüfen beides. |
| C08 | Erledigt | IDs, Katalog-/Related-Verweise, API-Fakten, Linkziele, Anker, DE/EN-Ankerparität, Codezäune und Tabellenspalten vor Generierung validiert. Negative Tests verwerfen bewusst defekte Eingaben. Inhaltshash umfasst vollständigen Inhalt; Quelle zeigt echte Git-Revision und Dirty-Status. |
| C09 | Erledigt | API-Suche, Filter, Sprache und gewünschte Workbench-Stufe werden in URLs erhalten. Related-Artikel und interner Ankerwechsel funktionieren. Suchtext berücksichtigt Artikelinhalt; Indexladefehler bieten sichtbaren Fehler und Retry, veraltete Antworten werden verworfen. |
| C10 | Erledigt | Markdown-Tabellen berücksichtigen Pipes in Code-Spans/escaped Pipes; verschachtelte Listen und nicht bei 1 beginnende Nummerierung bleiben erhalten. Unsichere Linkschemata werden verworfen. |
| C11 | Erledigt | Browserprüfung deckte fehlendes Mounting der Standalone-App auf. Neuer `client/main.tsx` erzeugt den React-Root; der Standalone-Build nutzt diesen Einstieg. Next importiert weiterhin nur die gemeinsame App. Bundle-Assertion und tatsächliche Browserprüfung ergänzen SSR. |
| C12 | Erledigt | Shutdown-Rennen behoben: ein während `close()` noch laufendes Init darf danach keine Swarm-Timer starten. History-Arbeit wird abgebrochen/abgewartet; Regression zählt echte Timer. Die vollständige Help-Suite beendet sich jetzt ohne Timeout. |
| C13 | Erledigt | Tests deaktivieren Modelle, operatorseitige Remote-Shards und hohe Swarm-Last vor Serverimport. Der Abschlusslauf verwendet keine produktiven Shards. Docker-Compose-Testbefehl auf dieselbe vollständige Help-Suite umgestellt, statt nur die Integrationsdatei auszuwählen. Containerlauf bleibt separat offen. |
| C14 | Erledigt | Root-README Englisch, deutsche Version `README_DE.md`; Help-README Englisch mit deutscher Fassung. Experimental-Hinweis oben in beiden Root-Fassungen, MIT-Lizenzdatei und Paketmetadaten vorhanden. Veraltete Shutdown-Prüfhinweise sowie Dokumentationsindex korrigiert. |

Die frühere unbedingte Aussage, `write` erzeuge „immer“ einen neuen Entry, wurde auch im
API-Kurztext ersetzt: Request-Replay erzeugt keinen zweiten Entry; `unique` ermöglicht eine
atomare Singleton-Erstanlage. Dies ist keine globale shardübergreifende Eindeutigkeitsgarantie.

## 3. Konkret ergänzte Leitfäden

Alle folgenden Artikel sind **erledigt**, auf Deutsch und Englisch vorhanden und in Katalog/Suche eingebunden:

| Help-ID (`help.topic.…`) | Inhalt |
|---|---|
| `first_running_space` | Vollständiges modellfreies Programm mit Imports, Harness, Service, Task, Read/Take, Ergebnis, Commit/Abort, Cleanup und exakter Ausgabe. |
| `async_interaction` | Zeit-/Orts-/Referenzentkopplung im tatsächlich implementierten System; Promise versus Wait/Notify und persistente Zustellung; CPU-/Commitkosten. |
| `task_lifecycle` | Task-Lease versus Transaktionslease, Reservierung/Commit, Completion, sichere Wiederholung, externe Idempotenz; ThreadSequence, `unique` und Pointer-Forks. |
| `live_sync_recipe` | Vollständiger Snapshot über alle Seiten, anschließende Changes inklusive Delete/Leerrevision, Streamwechsel/Ablauf, atomare Veröffentlichung und UI-Filter. |
| `social_swarm_pipeline` | Producer → Task → Worker-Reservierung → Berechnung → Abschlussbatch → History/Feed; zwei echte Worker-Storagecommits, Shards und verbleibende Kosten. |
| `failure_playbook` | Fehlerbild, wahrscheinliche Ursache und sichere nächste Aktion; insbesondere unbekannter Ausgang, Completion, Budget, Snapshot, Mailbox und vergifteter Store. |
| `safe_operations` | Lokaler Start, Passwort/Enrollment/Grants, Modellbudget, Limits, Backup/Restore sowie Grenzen bei Prozess-, Strom- und Hostausfall. |
| `topology_and_readiness` | Stufenmatrix v1–v6, tatsächlich lokale Komponenten versus reale Hosts; Merge versus Primary/Sync, Fencing und getrennte Abnahmegates. |

Das ausführbare [Tutorial](../help-site/examples/tuple-basics.ts) liefert
`{ inspected: 7, squared: 49, jobsRemaining: 0 }` (CLI als JSON).
Die [Live-Mirror-Implementierung](../help-site/examples/shared/live-mirror.ts) wird mit
mehrseitigen Fake-Protokollen und echten PhiSpaces-Put-/Delete-Operationen geprüft.
Unvollständige oder gescheiterte Aktualisierungen verändern den vorher publizierten Mirror nicht.

## 4. Automatisierte Nachweise

| Prüfung | Ergebnis |
|---|---|
| Root `npm run typecheck` | erfolgreich |
| Help `tsc -p help-site/tsconfig.json --noEmit --incremental false` | erfolgreich |
| Root-Suite | 741 Tests: 740 bestanden, ein optionaler Bootstrap-Kopie-Test übersprungen, keine Fehler |
| Beispiele seriell | 158/158 bestanden |
| Vollständige Help-Suite | 45 Tests: 44 bestanden, separater SSR-Fall übersprungen, keine Fehler; Prozess beendet sauber |
| Frischer Produktionsbuild + SSR | Build erfolgreich, separater SSR-Test 1/1 bestanden |
| Dokumentationsgate | 45 Artikel/90 Datensätze, 14 abgeleitete Signaturgruppen, 60 tatsächliche TypeScript-Codeblöcke geprüft |
| Lokale Dokumentationslinks | 172 relative Dateiverweise in Abschlussbericht, Index, Implementierungsstand und vier READMEs geprüft, kein fehlendes Ziel |
| Compose-Konfiguration | `docker compose … --profile test config --quiet` erfolgreich; kein Image-/Containerlauf |
| Whitespace/Diff-Prüfung | `git diff --check` erfolgreich |

Der reguläre Build führt das rein lesende Dokumentationsgate vor der Generierung aus:

```bash
npm --prefix help-site run check:docs
npm --prefix help-site test
npm --prefix help-site run test:production
```

`help-consistency.test.ts` prüft auch bewusst kaputte Links, fehlende API-Fakten,
Sprachabweichungen, ungültigen Beispielcode, Renderer, URL-Roundtrips, Retry/Stale-Load,
Tutorial-Ausgabe, Shutdown und Mirror-Fehlergrenzen. Die Tests ersetzen keine pauschale
Abnahme sämtlicher Prosa, Browsergeräte oder Ausfallszenarien.

Aktuelle temporäre lokale Logs: `/tmp/phi-spaces-root-completion-final.log`,
`/tmp/phi-spaces-examples-completion-final.log`, `/tmp/phi-spaces-help-completion-final.log`,
`/tmp/phi-spaces-help-production-completion-final.log`. Die früheren Läufe bleiben unter
`/tmp/phi-spaces-root-help-consistency.log`, `/tmp/phi-spaces-help-fixes-examples.log` und
den `*-completion.log`-Dateien nachvollziehbar. Diese Logs sind keine versionierten CI-Artefakte.

## 5. Browserprüfung

Isolierter lokaler In-Memory-Server, keine Modelle, keine Remote-Shards:

- Standalone-App rendert nach echtem Neuladen statt einer leeren Mount-Fläche.
- Vollständiger Einstiegsartikel auf Englisch und Deutsch; Sprachwechsel erhält Artikel.
- Interner Link zum Task-Lebenszyklus lädt den richtigen Artikel.
- Startseite enthält 45 Artikel und den Einstiegsleitfaden.
- API-Suche `write` mit Provider `client` und Kategorie `mutation`: URL enthält alle Filter;
  vollständiges Neuladen rekonstruiert Eingabe und Auswahl.
- Stufe-5-Ressource öffnet Workbench mit `stage=v5` und sichtbarer aktiver Stufe V5;
  die Stufe wird nicht heimlich als externer Lauf gestartet.
- Volltextsuche nach `SnapshotExpired` findet vier passende Artikel, darunter die neuen
  Fehler- und Live-Synchronisationsleitfäden.
- Frisch geladene API-Parametertabelle zeigt `Promise<EntryView | null>` in einer einzigen
  Typzelle, ohne eine zusätzliche Tabellenspalte aus dem Pipe-Zeichen zu erzeugen.
- Frisch geladene Security-API zeigt relative Typreferenzen statt lokaler Checkout-Pfade.

Dies ist ein begrenzter interaktiver Smoke-Test, keine vollständige E2E-Matrix.
Der Prüftab und beide während der Arbeit gestarteten In-Memory-Prüfserver wurden nach den
Kontrollen geschlossen. Bestehende operatorseitige Dienste/Shards wurden nicht beendet.

## 6. Offene Punkte und Zuständigkeit

Im beschriebenen lokalen Korrekturumfang sind keine bekannten Implementierungspunkte
bewusst unbearbeitet geblieben. Folgende Nachweise/Aktionen bleiben davon getrennt offen:

1. **Deployment und Containerabnahme:** geänderte Images bauen/starten, Dienst veröffentlichen,
   Migration/Start im tatsächlichen Zielbetrieb prüfen. Wegen gemeinsam genutzter Hosts nicht
   ohne gesonderte Freigabe ausgeführt; Compose-/Dockerfile-Änderung ist kein Containerlauf.
2. **Großstore-Performance:** CPU, Event-Loop-Lag, Durchsatz und HTTP-p95/p99 am tatsächlichen
   34k-Entry-Store und auf `big` messen. Der lokale Zwei-Commit-Nachweis garantiert keinen
   pauschalen Geschwindigkeitsfaktor; Dokumentserialisierung und Core-Scans bleiben Kosten.
3. **Reale Geräte-/Netz-/Ausfallabnahme:** Browsermatrix, Handy, Proxy/TLS, neue Multi-Host-
   Konfiguration sowie Kill-/Strom-/Hostausfall und Wiederherstellung für genau diesen Stand.
   Historische andere Abnahmen werden durch diesen Bericht weder ersetzt noch rückwirkend aufgehoben.
4. **Kostenpflichtige Provider:** Live-Modellpfad mit ausdrücklicher Kostenfreigabe prüfen.
   Alle Abschlussprüfungen verwenden deterministische Antworten.
5. **Optionaler Bootstrap-Kopie-Test:** benötigt eine ausdrücklich konfigurierte geeignete
   Store-Kopie; im normalen Root-Lauf bewusst übersprungen.
6. **Veröffentlichung:** Git-Commit/Push und GitHub-About-Änderung nicht ausgeführt. Der
   angeforderte About-Einzeiler wurde geliefert; Schreiben in Remote-Repositories war nicht beauftragt.

Bewusste Architektur-/Betriebsgrenzen sind keine versteckten erledigten Garantien:
ein Space bleibt ein vollständiges Durable-Dokument, externe Effekte benötigen eigene
Idempotenz, unklare Admin-Ausgänge können `needsReview` verlangen, und Stage-Berichte sind
keine ausführbaren Backups. Neue Betriebsabnahmen sind gegen den aktuellen
[Implementierungsstand](implementierungsstand.md) zu planen, nicht allein gegen Help-Prosa.
