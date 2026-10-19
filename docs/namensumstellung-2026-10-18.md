# Vollständige Namensumstellung auf phi-spaces

Stand: 18. Oktober 2026. Die vollständige Vereinheitlichung umfasst nicht nur sichtbare
Produkttexte, sondern auch persistente Dokumenttypen und Build-Verträge. Es bleiben
keine alten Projektbezeichnungen als absichtliche Ausnahmen in den Repository-Texten.
Externe Projekte und Fremdprodukte wie pi-durable, pi-ai und pi-server behalten ihre eigenen Namen.

## Umsetzung

- [x] Root- und Help-READMEs, technische Dokumentation, Planungsunterlagen und DE/EN-Corpus vereinheitlicht.
- [x] Persistente Dokumenttypen in Core, Federation, Recovery, Replikation, Worker-Steuerung,
  Help-Admin und Beispielen auf `phi-spaces.*` umgestellt; passende Prüfungen und Audit-Helfer angepasst.
- [x] Runtime-/Testbed-Bundles, Importpfade, Docker-Copy-Regeln, Fixture-Labels und Build-Skripte vereinheitlicht.
- [x] Lokalen Admin-Passwort-Variablennamen auf `PHI_SPACES_ADMIN_PASSWORD` umgestellt;
  der Passwortwert wurde weder verändert noch ausgegeben.
- [x] Historische Textnachweise normalisiert und ihre redaktionelle Veränderung ausdrücklich
  im [Evidence-Hinweis](../test/evidence/README.md) dokumentiert. Sie sind keine unveränderten Rohlogs mehr;
  enthaltene Hashes/Signaturen belegen weiterhin nur die damaligen Originalartefakte.
- [x] Corpus-Build bereinigt nur entfallene Artikel, die der vorherige generierte Index ausdrücklich
  als Eigentum des Generators ausweist. Unbekannte Dateien bleiben erhalten; unsichere Pfade werden
  vor der ersten Löschung abgewiesen. Regression prüft Eigentum, Schutz vor Traversal und Wiederholung.
- [x] Alte Distribution und Next-Ausgabe gesichert und anschließend frisch erzeugt, statt gemischte
  Namen oder überholte Development-Chunks weiterzuverwenden.
- [x] Neuer rein lesender Check `npm run check:branding` prüft versionierte/neue Projekttexte,
  generierte Distribution/Help-/Next-Ausgaben und lokale Umgebungsvariablennamen. Er prüft nicht
  Git-Historie, Fremdabhängigkeiten, binäre Stores oder Passwortwerte.

## Inkompatibler Speicher- und Integrationswechsel

Die Dokumenttyp-Namespace-Änderung ist **kein kosmetisches Refactoring**. Dokumentversion 5 allein
migriert keine Dokumenttypen. Eine bisherige Datenbank darf nicht unverändert als produktiver Store
dieser Version gestartet werden: Dokumente im bisherigen Namespace werden nicht automatisch gefunden;
ein neuer leerer Namespace ist kein Nachweis, dass frühere Daten gelöscht wären.

Eine automatische In-place-Umstellung findet nicht statt. Im anschließenden Migrationslauf wurde
[`scripts/migrate-namespace.mjs`](../scripts/migrate-namespace.mjs) ergänzt: Dry-run als Standard,
SQLite-Backup in eine neue Datei, ausschließliche Änderung von Dokumenttyp und zugehörigem Metadatenindex,
Integritäts-/Kollisionsprüfung und gestreamte Hashprüfung aller übrigen Tabellen sowie normalisierter
Dokumentmetadaten. Die neue Datei wird erst nach erfolgreicher Prüfung atomar und ohne Überschreiben veröffentlicht.
Originalstores bleiben unverändert. Replikationsmarker und unbekannte Schemata werden abgewiesen;
JSONL und die koordinierte Migration von Journal-/Hash-/Signaturketten sind nicht implementiert.
Blindes Ersetzen innerhalb von Datenbankbytes oder signierten Inhalten ist keine Migration.

```bash
# Namespace als Argument angeben; kein implizites Ersetzen beliebiger Inhalte.
node scripts/migrate-namespace.mjs --input /absolut/store.sqlite --from BISHERIGER_NAMESPACE
node scripts/migrate-namespace.mjs --input /absolut/store.sqlite --from BISHERIGER_NAMESPACE \
  --output /absolut/store.phi.sqlite --apply
npm run test:migration
```

Die Tests belegen echten Harness-Reopen mit identischem Entry, unveränderte Quelldatei,
Abbruch vor Veröffentlichung ohne Teilergebnis, Schutz vor Überschreiben, Zielkollision
und Ablehnung replizierter Stores. Lokale Datenkopien wurden zusätzlich geöffnet; siehe Abschlussnachtrag unten.

Das Bundle heißt jetzt `phi-spaces.mjs`. Verbraucher außerhalb dieses Repositories müssen ihre
Imports, Artefaktmanifeste und Bereitstellung entsprechend anpassen. Der lokale Prüflauf nutzt
`npm run bundle -- --local`: Das baut das neue Bundle, ohne den benachbarten Mobile-Checkout
halbseitig zu verändern. Ohne `--local` gilt weiterhin die dokumentierte automatische Synchronisation.
Umbenannte Help-IDs/Anker besitzen keine alten Namensaliase; alte externe Bookmarks sind entsprechend
anzupassen. Bestehende Hosts, Container und produktive Dienste wurden nicht umgestellt oder neu gestartet.

## Nachprüfung: übersehene Verträge

Die Umstellung ändert mehr als Dokumenttypen und das Bundle. Die folgenden Namen sind Teil von Wire-,
Krypto- oder Betriebsverträgen; alte und neue Version sind dort **nicht interoperabel**.

1. **Signaturdomänen.** Alle signierten Bytes beginnen mit einer Domäne, die jetzt `phi-spaces/…` lautet:
   `auth/v1`, `rotate/v1`, `grant/v1`, `recovery-rpc/v1`, `recovery-authority/v1`, `router-lease/v1`,
   `federation-policy/v1`, `replica-config-notice/v1`, `replica-sync/v1/request|response`,
   `control-host-change/v1`, `worker-assignments/v1`, `run-gate-…`, `space-lifecycle-…`, `membership-…`
   und `delegation` (`phi-spaces/<kind>/v1`). Folgen: Hosts verschiedener Versionen akzeptieren gegenseitig
   keine Challenge, keinen Grant und keine Instruktion; vor der Umstellung signierte und gespeicherte
   Nachweise (z. B. eine signierte Authority-Transition in einem Recovery-Kit, noch nicht zugestellte signierte
   Instruktionen in Outbox/Mailbox) verifizieren danach nicht mehr. Die Store-Migration ändert daran nichts.
2. **Protokoll- und Request-IDs.** `phi-spaces-rpc-v1` (Router/Federation), `phi-spaces-claim-receipt-v1`
   (Claim-Quittungen) und das Request-Präfix `phi-spaces:` für Zustellungen an Konversationen
   (`src/index.ts`). Eine zum Umstellungszeitpunkt offene Zustellung bekommt eine neue Request-ID und kann
   einmal doppelt ankommen.
3. **SSH-Forced-Commands.** `scripts/recovery-ssh.mjs`, `fence-ssh.mjs`, `fence-docker-ssh.mjs` und
   `recovery-docker-ssh.mjs` vergleichen `SSH_ORIGINAL_COMMAND` exakt (`phi-spaces-recovery`,
   `phi-spaces-register-read|operator`, `phi-spaces-fence`, `phi-spaces-fence-status`). Client und
   serverseitige Skripte samt `authorized_keys` (`/opt/phi-spaces/…`, siehe `docs/abnahme/ap1b-betrieb.md`)
   müssen gleichzeitig umgestellt werden, sonst scheitern Recovery und Fencing.
4. **Fencing-Drop-in.** `ContainerFencing` sperrt die Unit mit `zz-phi-spaces-fenced.conf`. Ein vor der
   Umstellung gefencter Host trägt das Drop-in der alten Version: `verify` erkennt ihn nicht als gefenct
   (fail-safe), und `release` hätte nur das neue Drop-in entfernt, die Unit wäre gesperrt geblieben.
   **Behoben:** `release` bricht jetzt ab und nennt jedes fremde `zz-*-fenced.conf`
   (Test in `test/test-container-fencing.test.ts`); entfernt wird es bewusst nur vom Operator.
5. **Server- und Testbed-Namen.** Compose-Projekt und Container `phi-spaces-test-*`, Images, die
   iptables-Regel `phi-spaces-component-fault-proxy`, der Dienst `phi-spaces-fault-proxy.service` und die
   Verzeichnisse `~/.local/share/phi-spaces-operations/` bzw. `/opt/phi-spaces`. Auf `big` noch laufende
   Ressourcen unter altem Namen findet `npm run testbed -- status|down` nicht, `fault-cleanup.py` entfernt die
   alte DNAT-Regel nicht. Vor dem ersten Lauf der neuen Version: alte Ressourcen mit der alten Version
   abbauen oder gezielt von Hand entfernen.
6. **Umgebungsvariablen.** Alte Variablen werden still ignoriert. Betroffen sind u. a.
   `PHI_SPACES_ADMIN_PASSWORD` (Help-Admin; ohne Wert ein zufälliges Passwort, der Admin ist dann
   ausgesperrt — Docker Compose bricht dank `:?` laut ab), `PHI_SPACES_MOBILE_ROOT`, `PHI_SPACES_LLM*`,
   `PHI_SPACES_ROOT_ACCEPTANCE_FILE`, `PHI_SPACES_TESTBED_TRACE` und auf dem Gerät
   `PHI_SPACES_KEY_SOCKET`. Server-`.env`, systemd-Units und Compose-Dateien außerhalb des Repositories
   sind anzupassen; `check:branding` prüft nur die lokalen `.env`-Schlüssel.
7. **Gerätezustand (Mobile).** Die Mobile-Anpassung steht im Nachtrag unten. Konkret persistent auf dem Gerät
   und damit nach dem Update unerreichbar: Keystore-Aliasse (`SpaceKeyStore.alias` erzwingt per Regex das
   neue Präfix, alte Aliasse werden als „invalid key alias“ abgewiesen), der SharedPreferences-Name der
   Key-Bindings und der Key-Socket-Name. Beim Re-Enrollment den alten Geräteschlüssel im Key-Directory
   widerrufen; der alte Keystore-Eintrag bleibt ungenutzt auf dem Gerät.
8. **Lücke im Branding-Check.** Das Muster erfasste weder den Singular ohne Trenner noch die Form mit Punkt,
   und wegen `\b` keine Vorkommen mit `_`-Präfix (z. B. in längeren Variablennamen). **Behoben:** Der Check
   akzeptiert jetzt jeden Trenner (`-`, `_`, `.`, Leerzeichen) oder keinen, Singular und Plural, solange der
   Name nicht innerhalb eines Worts steht. Mit dem strengeren Muster gibt es weiterhin keinen Treffer.

### Umstellungsreihenfolge für bestehende Installationen

1. Föderation ruhig stellen: keine laufende Recovery oder Promotion, kein gefencter Host, Outboxen,
   Mailboxen und Fanout-Jobs geleert, Runs gestoppt oder pausiert.
2. Alle Hosts gemeinsam stoppen (gemischte Versionen sind nicht interoperabel, siehe 1–3).
3. Je Store eine Offline-Kopie migrieren (`migrate-namespace.mjs`, zuerst ohne `--apply`); replizierte Stores
   und JSONL nicht mit diesem Werkzeug.
4. Serverseitige Skripte, `authorized_keys`, systemd-Units, `.env`/Compose-Variablen und Pfade umstellen;
   alte Testbed-Ressourcen abbauen.
5. Hosts mit der neuen Version starten; Grants und Leases neu ausstellen lassen, Telefone neu paaren.

**Umgesetzt am 2026-10-18** für die Testföderation auf big, vpsc, nanoi und 100: Die Daten waren nicht übernehmbar
(siehe 1–3), die Föderation wurde deshalb gestoppt, gesichert und unter den neuen Namen frisch aufgesetzt; neue CA
und Zertifikate, neue Authority und Schlüssel, Forced Commands, Units, Verzeichnisse und SSH-Aliase umbenannt,
Altbestände entfernt. Details und Prüfungen: [Testumgebung §20](testumgebung-big.md#20-neuaufbau-unter-phi-spaces-2026-10-18).
Das Handy `xi` ist mit neuer APK und neuem Keystore-Schlüssel neu gekoppelt. Offen: der primary/sync-Haupt-Store von
host-a wurde nicht wieder eingerichtet.

## Prüfungen und Evidenz

Die folgenden Prüfungen wurden im Abschlusslauf ausgeführt:

```bash
npm run typecheck
./node_modules/.bin/tsc -p help-site/tsconfig.json --noEmit --incremental false
npm test
npm run test:examples -- --test-concurrency=1
npm --prefix help-site test
npm --prefix help-site run test:production
npm run build
npm run bundle -- --local
npm run build:operations
node test/testbed/build-artifacts.mjs /media/data/programming/phi-spaces/dist/testbed-artifacts
npm run check:branding
git diff --check
```

| Prüfung nach Änderung aller Dokumenttypen | Ergebnis |
|---|---|
| Root- und Help-Typecheck | erfolgreich |
| Root-Suite einschließlich persistenter JSONL-/SQLite-Reopen-/Recoveryfälle | 741 Tests: 740 bestanden, ein optionaler Bootstrap-Kopie-Fall übersprungen, keine Fehler |
| Modellfreie Beispiele seriell | 158/158 bestanden |
| Vollständige Help-Suite | 46 Tests: 45 bestanden, separater SSR-Fall übersprungen, keine Fehler |
| Frischer Next-Produktionsbuild und SSR | Build erfolgreich, separater SSR-Test 1/1 bestanden |
| Dokumentationsgate | 45 Artikel, 90 Sprachdatensätze, 14 Signaturgruppen, 60 TypeScript-Beispiele erfolgreich geprüft |
| Distribution, lokales Bundle und Operations-Build | erfolgreich |
| Testbed-Artefakte | 47 Dateien gebaut, ohne Übertragung oder Deployment |
| Branding einschließlich generierter Ausgaben und lokaler Variablennamen | 1.393 Textdateien geprüft, kein alter Projektname gefunden |
| Compose-Konfiguration | erfolgreich validiert, ohne Containerstart |
| Relative Dokumentationslinks | 173 Ziele geprüft, kein fehlendes Ziel |
| `git diff --check` | erfolgreich |

Temporäre lokale Logs: `/tmp/phi-spaces-rename-root-final.log`,
`/tmp/phi-spaces-rename-help-final.log`, `/tmp/phi-spaces-rename-production-final.log`,
`/tmp/phi-spaces-rename-examples-final.log`, `/tmp/phi-spaces-rename-artifacts.log` und
`/tmp/phi-spaces-branding-final.log`. Keine kostenpflichtigen Modellaufrufe, produktiven Stores,
externen Mobile-Dateien oder Hosts wurden für diese Nachweise verändert.

## Sicherungen und verbleibender Betriebsaufwand

**Stand 2026-10-19:** Alle in diesem Dokument genannten temporären Logs, Quell- und Release-Sicherungen unter `/tmp`
(lokal und auf big) sowie die Release-Verzeichnisse `/media/docker/phi-spaces-release-*` sind gelöscht. Die
Ergebnisse stehen in diesem Dokument und im Git-Verlauf; die Pfadangaben unten sind nur noch historisch.

Die 44 gezielt geänderten Code-/Testdateien wurden vor der Umstellung gesichert:
`/tmp/phi-namespace-source-backup-4HiS6d/sources.json`. Die Prüfung fand keine bereits vergebenen
Ziel-Namespace-Werte. Die zuvor erzeugten `dist`-/Next-Dateien liegen für lokale Wiederherstellung unter
`/tmp/phi-generated-before-rebuild-1LUZSz/`; diese Sicherung ist weder eine Store-Sicherung noch ein Deployment.
Temporäre Sicherungen enthalten bewusst den vorherigen Zustand und liegen außerhalb des Projektverzeichnisses.

Der folgende Nachtrag ersetzt für den anschließenden Arbeitslauf die pauschale Offen-Markierung
der lokalen Kopiermigration und Mobile-Quellcodeanpassung. Laufende Dienste, Geräte und produktive
Umschaltungen bleiben ausdrücklich getrennt.

## Nachtrag: bestehende Stores und Mobile-Verbraucher

### Lokale SQLite-Stores

- [x] `help-site/.local/spaces-eibrain.sqlite` nach `spaces-eibrain.phi.sqlite` kopiert und migriert:
  sieben Dokumenttypen-Metadaten geändert; übrige Tabellen und Dokumentinhalte unverändert geprüft.
- [x] `help-site/.local/swarm-b.sqlite` nach `swarm-b.phi.sqlite` kopiert und migriert:
  drei Dokumenttypen-Metadaten geändert; übrige Tabellen und Dokumentinhalte unverändert geprüft.
- [x] Beide Kopien mit aktuellem Harness geöffnet. Die Help-Kopie enthält dieselben fünf Space-Identitäten,
  die Shard-Kopie dieselben zwei. Die Migration schreibt nicht in die Originaldatenbanken;
  der laufende Shard kann seinen Originalstore unabhängig weiter verändern.
- [x] Nach erneuter Prüfung, dass die Help-Originaldatenbank nicht benutzt wird, ausschließlich
  `HELP_SQLITE` in der lokalen `.env` auf die geprüfte Help-Kopie gesetzt. Keine Passwortwerte verändert.
- [x] Den laufenden lokalen Shard kontrolliert gestoppt, **danach eine neue aktuelle Kopie**
  migriert und auf `swarm-b.phi.sqlite` umgeschaltet. Der erste Snapshot wurde nicht als letzter
  Datenstand verwendet. Auch die inaktive Help-Kopie wurde vor dem Abschluss frisch erzeugt.
- [x] Beide lokalen Originaldatenbanken samt vorhandenen WAL/SHM-Dateien nach der Prüfung
  ausdrücklich freigegeben gelöscht. Der Shard liefert vorhandene Posts mit unveränderter Space-ID;
  die Help-Kopie öffnet mit denselben fünf Space-Identitäten. Startskript und direkter Nano-Host-Start
  verwenden standardmäßig den migrierten Shard-Pfad; ein Regressionstest sichert dies ab.

Die Migrationsfunktion verändert ausschließlich eine neue Ausgabedatei, bietet keine automatische
Dienstumschaltung und verweigert bestehende Zielpfade. JSONL und replizierte Stores benötigen
ein eigenes koordiniertes Verfahren und wurden nicht blind umgeschrieben.

### Externer Mobile-Checkout

Im Checkout `/media/data/programming/pi-termux-mobile`:

- [x] Zwölf identifizierte Verbraucher-/Build-/Java-/Testdateien angepasst; Runtime-Bundle umbenannt.
- [x] Aktuelles Bundle und zwölf CLI-Beispielmodule synchronisiert; Quelltexte vorher gesichert unter
  `/tmp/phi-mobile-source-backup-eMzhUt/sources.json`.
- [x] Node-Imports, Provisionierungsmanifest, Packaging-Quellpfad/-Variablen und Android-Signaturdomänen vereinheitlicht.
- [x] Offline-Runtime-Tests 20/20 und isolierte Mobile-/Schutztests 6/6 bestanden.
- [x] Debug-APK offline gebaut. Der erste Versuch traf eine noch unvollständige parallele Core-Änderung;
  ein erneuter Lauf nach erfolgreichem Bundle endete mit `BUILD SUCCESSFUL`.
- [x] Im APK enthaltenes `assets/runtime.bin` geöffnet: das enthaltene `runtime/phi-spaces.mjs`
  ist byte-identisch zum getesteten Runtime-Bundle. Import und `Space.definition.kind` geprüft.
- [x] Installation und Geräte-Grundtest im anschließenden Fix-Lauf erledigt: Gerät erreichbar,
  aktualisierte APK als reguläres Upgrade installiert und neues Bundle auf dem Gerät verifiziert.
  Vorhandene Android-Keystore-Identitäten und Profile wurden nicht gelöscht oder umgeschrieben.
- [ ] Kontrolliertes Re-Enrollment am separaten Federation-Koordinator: siehe letzten Nachtrag.
  Private Hardware-Schlüssel werden nicht exportiert oder blind umbenannt.

APK: `/media/data/programming/pi-termux-mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
SHA-256: `4c220e4692bba3a8de77d5edf999e012b32ae9ef5ca089b586186c1ac0af3d3b`.
Bundle-SHA-256: `1c9d0dc242c28c7713f21098d31369eb9f0566991ce44469a0923ad20a564220`.
Diese Hashes gehören zu einem Quellstand vor den Korrekturen aus `docs/codeanalyse-src-2026-10-18.md`
(Core, Service, Recovery-Service, Fencing, Replikation). Bundle und APK sind vor einer Verwendung neu zu bauen.

**Transparenz zum Testlauf:** Das vorhandene `runtime/test-remote-client.mjs` war entgegen der
ursprünglichen Einordnung ein Live-Skript. Ein Start legte eine lokale Testsitzung an und führte
eine deduplizierte kurze Modell-Submission aus. Die Sitzung wurde anschließend auf dem verifizierten
Server gezielt entfernt; keine bestehenden Nutzersitzungen wurden gelöscht. Kosten wurden nicht ermittelt.
Das Skript verlangt jetzt ausdrücklich `PI_MOBILE_LIVE_TEST=1`; ein isolierter Regressionstest beweist,
dass es ohne Freigabe vor Lesen der Serveridentität und vor jeder Verbindung abbricht.

### Produktiver Help-Dienst auf big

- [x] Ausschließlich lesende Inventur: vorhandenen Help-Produktionscontainer, Compose-Verzeichnis
  `/media/docker/spaces/help-site/docker`, Datenträgermount und Dokumenttypen festgestellt.
  Konfiguration: Help auf `127.0.0.1:3500`, Store `/data/spaces-eibrain.sqlite`, zweiter Shard
  unter `tcp:127.0.0.1:3600`. Dieser Schreiber muss in die koordinierte Wartung einbezogen werden.
  Der Listener ist ein bestehender SSH-Tunnel von big nach nano, kein zweiter Container auf big.
  Er ist nicht mit dem zusätzlich laufenden lokalen Entwicklungs-Shard gleichzusetzen.
- [x] Nach ausdrücklicher Freigabe Help auf big und den tatsächlichen Swarm-Shard auf nano koordiniert
  gestoppt, ihren letzten Datenstand migriert und beide Dienste unter neuen Namen gestartet.
  Der frühere Rollback-Vorbehalt gilt nach der zusätzlich freigegebenen Original-DB-Löschung nicht mehr.
  Andere Test-/NetBird-Container sind nicht Teil dieser Umschaltung.

### Prüfgrenzen bei parallelen Änderungen

Während dieses Laufs wurden unabhängig weitere Core-/Recovery-/Replikationsdateien bearbeitet.
Ein Gesamtlauf meldete fünf Recovery-Fehler bei einem vorübergehend undefinierten `failure`;
die gezielte Wiederholung nach zwischenzeitlicher Korrektur bestand 13/13 Tests.
Ein weiterer Gesamtlauf traf einen vorübergehend fehlenden `digestJson`-Import und war ebenfalls
kein grüner Abnahmenachweis. Vorher-/Nachher-Hashes bestätigten Änderungen während des Laufs.
Diese fremden Änderungen wurden weder überschrieben noch als eigene Migrationsfixes ausgegeben.
Beide vorübergehenden Fehler (`failure`, `digestJson`) waren Zwischenstände der parallel laufenden Korrekturen
aus `docs/codeanalyse-src-2026-10-18.md`; im fertigen Stand sind sie aufgelöst.
Ein produktives Deployment benötigt einen stabilen, vollständig erneut geprüften Quellstand.

Die anschließende Gesamtsuite bestand **748/749 Tests**, ein optionaler Bootstrap-Kopie-Fall
übersprungen und keine Fehler. Allerdings änderte sich der Quellhash auch während dieses Laufs;
das ist ein grüner Testlauf, aber noch kein unveränderlich gepinnter Release-Nachweis.

Nach Abschluss der Codeanalyse-Korrekturen und dieser Nachprüfung: `npm run typecheck` sauber, `npm test`
**753/754** (ein optionaler Fall übersprungen, keine Fehler), `npm run check:branding` mit verschärftem Muster
grün, `git diff --check` sauber. Während des Laufs änderten sich nur fremde Dateien (`.dockerignore`,
`help-site/scripts/swarm-shards.sh`, `help-site/server/nano-host.ts` und die Dateien des laufenden lokalen
Shards), keine Quelldatei unter `src/`. Auch dieser Lauf ist kein gepinnter Release-Nachweis.

Aktuelle Logs: `/tmp/phi-mobile-offline-final.log`, `/tmp/phi-mobile-unit-tests-final.log`,
`/tmp/phi-mobile-android-build-final.log`, `/tmp/phi-spaces-concurrent-recovery-recheck.log`
und `/tmp/phi-spaces-migration-root-recheck.log`. Der Status des letzten Gesamtlaufs ist vor
einer Deploymentfreigabe getrennt zu prüfen; ältere grüne Ergebnisse oben gelten für ihren damaligen Stand.

## Abschlussnachtrag: tatsächliche Dienstumschaltung und Original-DB-Löschung

### Durchgeführt

- [x] Eine unveränderliche Release-Kopie unter `/tmp/phi-release-vWcoTqoR` erstellt und unabhängig
  von weiteren Änderungen im Arbeitscheckout geprüft. Quellarchiv ohne Datenbanken, `.env`,
  Abhängigkeiten oder Git-Historie: SHA-256
  `fb345112fe31cd5314be00eabb85a6be9fd83cc69d98bf89cbf87ee7c754eb0b`.
- [x] Docker-Kontext gegen versehentliches Einpacken von `.env`-Dateien, SQLite-Dateien und
  privaten PEM-/Key-Dateien abgesichert. Produktions- und Nano-Image auf big aus derselben
  Release-Kopie erfolgreich gebaut; das Nano-Image anschließend auf nano geladen.
- [x] Neue Dienste `phi-spaces-help-prod` auf big und `phi-spaces-swarm-nano` auf nano gestartet.
  Neue Datenvolumes: `phi-spaces-help_spaces-help-data` und `phi-spaces-help_swarm-nano-data`.
  Die bestehenden Listen-Adressen, private Konfiguration, Zugangsdaten und der SSH-Tunnel auf
  Port 3600 einschließlich seiner anderen Weiterleitung wurden beibehalten.
- [x] Private Compose-Konfigurationen unter
  `/media/docker/phi-spaces-release-vWcoTqoR` auf big und
  `/home/mux/phi-spaces-release-vWcoTqoR` auf nano bereitgestellt. Vorherige Umgebungsdateien
  ausschließlich bezüglich des Projekt-Variablenpräfixes angepasst; Auflösung mit Compose gegen
  die laufenden Container verglichen: alle Service-Umgebungswerte identisch, ohne Geheimnisausgabe.
  Die Container wurden direkt erstellt, nicht von Compose übernommen. Für einen späteren Wechsel
  zur Compose-Verwaltung müssen diese **neuen** Container kontrolliert ersetzt werden; blindes
  `compose up` würde mit den bereits vergebenen Containernamen kollidieren. Für einen gewöhnlichen
  Neustart genügt `docker restart` mit dem jeweiligen neuen Containernamen.
- [x] Während beide ursprünglichen Writer gestoppt waren, auf big zehn und auf nano drei
  Dokumenttypen-Metadaten migriert. Alle anderen Tabellen und Dokumentinhalte wurden per
  Fingerprint unverändert nachgewiesen. Anschließend meldeten beide produktiven Datenbanken
  `PRAGMA integrity_check = ok`; alle Projekt-Dokumenttypen verwenden den neuen Namespace.
- [x] Beide Dienste gesund; Help liefert 90 lokalisierte Artikel. Der Feed meldet zwei erreichbare
  Shards und nach dem Wiederanlauf mehr als 25.500 erhaltene Posts; der normale Produktionsbetrieb
  erzeugt weitere Posts. Ein interner WebSocket-Test lieferte zwei vollständige 100er-Seiten ohne
  doppelte Post-IDs. Das ist kein Nachweis, dass beide Shards neue Writes akzeptieren: siehe Quota unten.
- [x] Nach Integritäts-, Payload- und Funktionsprüfung ausschließlich die ausdrücklich freigegebenen
  Original-DB-Dateien samt gegebenenfalls vorhandenen WAL/SHM-Dateien gelöscht:
  lokal `help-site/.local/spaces-eibrain.sqlite` und `help-site/.local/swarm-b.sqlite`,
  auf big der ursprüngliche Store `/data/spaces-eibrain.sqlite`, auf nano der ursprüngliche
  Store `/data/swarm-b.sqlite`, jeweils **im alten Volume**, nicht in den gleichnamigen neuen Stores.
  Die migrierten Datenbanken bleiben erhalten. Die Originale sind ohne eine externe Sicherung
  nicht wiederherstellbar; dieser Lauf hat keine weitere Original-DB-Sicherung zurückbehalten.

Beim ersten Nano-Migrationsversuch konnte SQLite auf dem schreibgeschützten Originalmount
seine WAL-Koordinationsdatei nicht erzeugen. Der Versuch brach ohne veröffentlichte Zieldatei ab.
Die erfolgreiche Wiederholung arbeitete mit einer privaten, beschreibbaren Kopie des bereits
gestoppten Originals, einschließlich vorhandener Sidecars. Diese Staging-Dateien wurden nach
erfolgreicher Migration entfernt; das Original blieb bis zur abschließend freigegebenen Löschung
schreibgeschützt. Die normale Betriebsunterbrechung wurde dadurch verlängert.

### Erneute Prüfungen

| Prüfung | Ergebnis |
| --- | --- |
| Eingefrorener Release: Typecheck und Root-Suite | 749 bestanden, 3 übersprungen, 0 Fehler |
| Eingefrorener Release: Help-Suite | 45 bestanden, 1 SSR-Test übersprungen, 0 Fehler |
| Docker-Produktionsbuild und Nano-Build | erfolgreich, aus demselben Quellarchiv |
| Abschließender Arbeitscheckout: Typecheck und Root-Suite | 751 bestanden, 1 übersprungen, 0 Fehler |
| Help-Suite einschließlich neuer Startpfad-Regression | 46 bestanden, 1 SSR-Test übersprungen, 0 Fehler |
| Brandingprüfung | 1.397 Textdateien einschließlich generierter Dateien und lokaler Umgebungsschlüssel bestanden |
| Produktive SQLite-Integrität und Typen | beide Stores `ok`, keine früheren Projekt-Dokumenttypen |
| Internes Feed-Paging | zwei 100er-Seiten, `complete:true`, keine Duplikate |
| Öffentliches HTTPS/WSS | HTTP und Feed-Initialisierung erreichbar; Paging nicht als stabil abgenommen, siehe unten |

Der zusätzliche lokale Next-Build aus der temporären Release-Kopie war **kein** grüner Nachweis:
zunächst lehnte Turbopack die nach außen verlinkten Abhängigkeiten ab, nach lokaler Kopie der
Abhängigkeiten schlug die TypeScript-`--showConfig`-Auswertung fehl. Der tatsächlich ausgerollte
Produktionsbuild wurde dagegen im Docker-Builder mit den Lockfile-Abhängigkeiten erfolgreich erstellt.

Logs: `/tmp/phi-spaces-cutover-root-tests.log`, `/tmp/phi-spaces-cutover-help-tests.log`,
`/tmp/phi-spaces-cutover-branding.log`, `/tmp/phi-release-root-tests.log`,
`/tmp/phi-release-help-tests.log`; auf big `/tmp/phi-release-production-build.log` und
`/tmp/phi-release-nano-build.log`.

### Befunde nach der ersten Umschaltung; aktueller Stand siehe Fix-Nachtrag

- [x] **Öffentliches History-Paging stabilisieren.** Im anschließenden Fix-Lauf implementiert und
  mit frischen Stores öffentlich geprüft; Details und Lastprüfgrenze siehe letzten Nachtrag.
  Ursprünglicher Befund: Der interne Zwei-Seiten-Test bestand,
  war aber deutlich langsam. Ein öffentlicher HTTPS/WSS-Test erreichte Index, Feed und beide Shards,
  erhielt beim Paging jedoch `complete:false` mit `remote shard timeout after 20000ms`.
  Auch die Wiederholung lieferte zwar die erste vollständige 100er-Seite, scheiterte aber bei der
  nächsten Seite mit demselben Shard-Timeout. Erreichbarkeit und Datenerhalt sind nachgewiesen,
  dauerhaft latenzarmes Paging nicht. Ohne gleichartigen Vorher-Lasttest ist nicht belegt, ob die
  beobachtete Latenz bereits im Altbetrieb genauso auftrat; sie wird nicht als abgenommen ausgegeben.
  Nach den wiederholten Leseprüfungen meldete Help auch Healthcheck-Timeouts und `unhealthy`.
  Ein kontrollierter Neustart ausschließlich des neuen Help-Containers stellte `healthy` und
  HTTP 200 am Help-Index wieder her (gemessener Einzelaufruf: 2.823 ms). Danach keine weiteren
  schweren Paging-Lasttests. Mögliche nach einem `Promise.race`-Timeout fortlaufende Abfragen und
  deren Last müssen gesondert untersucht werden; der Neustart ist kein Performance-Fix.
- [x] **Standardmäßige Entry-Anzahlgrenzen entfernen.** Nach ausdrücklicher Freigabe projektweit
  umgesetzt; neue Defaults stehen auf `FOREVER`. Ursprünglicher Befund: Der Shard meldete bei Worker-Writes die Grenze
  von 10.000 Entries. Die Vorgabe ist in alten und neuen Images identisch; keine Quota wurde bei
  dieser Migration erhöht. Dauerhaft mehr Posts benötigen eine bewusste Limits-/Retention-Entscheidung,
  nicht das Löschen von History-Daten zur Kaschierung des Limits.
- [x] **Altcontainer und alte Volumes entfernen.** Nach der anschließenden ausdrücklichen
  Freigabe beide alten Help-/Swarm-Container und ihre erneut als leer geprüften Volumes entfernt.
  Ursprünglicher Freigabestand: Die Sicherheitsprüfung
  lehnte deren vollständige Entfernung als weitergehend als die Original-DB-Löschfreigabe ab.
  Deshalb blieben die gestoppten Altcontainer und die alten Volumes bestehen; nur die explizit
  freigegebenen DB-Dateien wurden gelöscht. **Die Altcontainer dürfen nicht neu gestartet werden:**
  ihre ursprünglichen Datenbanken sind entfernt. Ohne zusätzliche Freigabe keine Umgehung der Sperre.
- [x] **Android-Gerät aktualisieren und Bundle prüfen.** Im Fix-Lauf ausgeführt; Re-Enrollment
  ist davon getrennt weiterhin offen. Bestehende Hardware-Schlüssel und Profile bleiben erhalten.
- [ ] **Separate Federation-/Testbed-Stores und -Dienste.** Nicht Teil der freigegebenen Help-/Swarm-
  Wartung. Signierte beziehungsweise hashverkettete Replikationsstores dürfen nicht durch bloßes
  Ersetzen von Dokumenttypen oder Original-DB-Löschen migriert werden; das Kopierwerkzeug lehnt
  bekannte Replikationsmarker ausdrücklich ab.
- [x] **Historische Inhalte auf den beiden produktiven Help-/Swarm-Stores bereinigen.** Durch den
  anschließend ausdrücklich angeforderten vollständigen DB-Reset dieser beiden Dienste erledigt,
  nicht durch blindes Ersetzen in alten Entries. Lokale Entwicklungskopien wurden nicht zusätzlich
  zurückgesetzt. Ursprüngliche Grenze der Kopiermigration:
  Die Kopiermigration
  ändert Dokumenttypen, nicht historische Posts, Texte oder darin enthaltene Kanal-IDs. In bestehenden
  Demo-Entries können daher weiterhin frühere Projektbezeichner vorkommen; das wurde beim lesenden
  lokalen Post-Test tatsächlich beobachtet. Eine vollständige Inhalts-/Kanalreferenzmigration muss
  Posts, History-Nodes, Channel-Einträge und ihre Verweise konsistent über den vorgesehenen
  Änderungsweg behandeln. Sie ist durch den Payload-Unverändert-Nachweis dieser Migration
  ausdrücklich nicht abgedeckt. Kein blindes Ersetzen in serialisierten Daten oder Replikationsjournalen.

## Fix-Nachtrag: Anzahlgrenzen, History-Paging und frischer Produktionsstart

### Implementiert und ausgerollt

- [x] Ursache der Nano-Grenze konkret identifiziert: `src/core.ts`, `DEFAULT_LIMITS.maxEntries = 10_000`
  und `maxEntriesPerOwner = 1_000`; Prüfung in `core.write` für externe Teilnehmer. Host-Writes waren
  ausgenommen, weshalb big über diese Anzahl hinauswachsen konnte und der Remote-Shard trotzdem blockierte.
- [x] Nach ausdrücklicher projektweiter Freigabe beide Default-Anzahlquoten auf `FOREVER`
  (`Number.MAX_SAFE_INTEGER`, JSON-sicher) gesetzt. Es gibt keine standardmäßige Entry-Anzahlobergrenze
  mehr. Explizit gespeicherte Quotas bleiben wirksam; Byte-, Commit-, Frame-, Transaktions- und
  Dokumentbudgets wurden **nicht** abgeschaltet. Bereits individuell konfigurierte Quotas werden
  durch ein Update nicht stillschweigend gelöscht. Regression prüft externe Writes bei über 10.000
  bestehenden Entries sowie weiterhin wirksame explizite Anzahlquoten.
- [x] `readChain` als optionale `SpaceLike`-Fähigkeit eingeführt: eine bytebegrenzte Kettenseite aus
  einem unveränderlichen Snapshot, ohne Commit. Remote über den bestehenden `readAll`-Pfad und
  Feature `read.chain`; normale Authentifizierung, Typrechte auch für den Head und Frame-Budgets
  bleiben erhalten. Zyklen, abgelaufene/unsichtbare Nodes, ungültige Cursors und zu kleine Budgets
  werden geprüft. Kein spezialisierter ungeschützter Nebenport.
- [x] History nutzt gebündelte Kettenseiten statt eines RPC pro History-Node. Ältere Peers behalten
  den Kompatibilitätspfad. Deadlines, Verbindungsabbruch und ein fehlgeschlagener anderer Shard
  stoppen weitere Traversierungsschritte. Bereits versandte einzelne Reads können noch fertig werden;
  es läuft danach aber keine unkontrollierte Folge weiterer Reads. Auch der Fallback-Scan ist
  seitenweise und abbrechbar statt eines nur äußerlich zeitbegrenzten vollständigen `readAll`.
- [x] README EN/DE, API-Referenz und zweisprachigen Help-Limits-Artikel an die neuen Defaults angepasst.
- [x] Eigenständigen Release-Stand gebaut und geprüft. Finales Quellarchiv:
  `/tmp/phi-fix-release-C954sUxC-source.tgz`, SHA-256
  `0771159a03257e53f6fd6fa4a4d7ffce70573ea9064538f9940eb2d0f62d579d`.
  Ein erster Docker-Build scheiterte an zwei vom Next-Typechecker verlangten expliziten
  Typannotationen; diese wurden korrigiert und Build sowie Suites erneut ausgeführt.
- [x] Nach zusätzlichem ausdrücklichem Reset-Auftrag beide aktuellen Writer gestoppt und **nur**
  `/data/spaces-eibrain.sqlite` auf big beziehungsweise `/data/swarm-b.sqlite` auf nano samt ihren
  SQLite-Sidecars gelöscht. Die alten Posts, Chats, Claims, Space-Identitäten und Historien dieser
  beiden Stores wurden damit absichtlich und ohne zusätzliche Sicherung verworfen.
  Separate Testbed-/Federation-Stores, Zugangsdaten und andere Volumedateien blieben unangetastet.
- [x] Beide Anwendungen mit dem neuen Image und **frisch erzeugten Spaces** gestartet. Sie werden
  jetzt regulär von Compose verwaltet; die vorherige Namenskollision beim zukünftigen `compose up`
  ist damit ebenfalls beseitigt. Releases:
  `/media/docker/phi-spaces-release-C954sUxC` auf big und
  `/home/mux/phi-spaces-release-C954sUxC` auf nano. Private Umgebungswerte vor Umschaltung identisch geprüft.
- [x] Neue Nano-Space-ID `sp-8b106cfb-2eb4-420f-b261-2655b6b297da`, gegenüber der vorherigen
  Identität geändert. Neue Nano-Posts, neue Defaults und `read.chain` über echte RPCs bestätigt.
  Der Feed enthält ausschließlich die neuen Seed-/Produktionsposts und den Kanal `phi-spaces`.
- [x] Öffentliches HTTPS/WSS: bei 229 frisch entstandenen Posts zwei vollständige 100er-Seiten,
  `complete:true`, keine doppelten Post-IDs, Posts aus beiden Shards, **56 ms insgesamt** ab
  WebSocket-Aufbau. Beide Container danach `healthy`. Das ist der Live-Nachweis auf frischen Stores,
  **kein** neuer Produktionslasttest mit 34.000 Entries; der frühere große Datenstand wurde auf
  ausdrücklichen Wunsch gelöscht. Unit-/RPC-Regressionen prüfen unter anderem die 100-Node-Seite in einem RPC.
- [x] Beide gestoppten Altcontainer und ihre beiden alten, unmittelbar zuvor erneut als leer und
  exklusiv zugeordnet geprüften Help-/Swarm-Volumes nach gesonderter Freigabe endgültig entfernt.
- [x] Android-APK aus dem gleichen Core-Release offline gebaut und auf dem nun erreichbaren
  Gerät als `adb install -r` erfolgreich aktualisiert; kein Uninstall und keine App-Datenlöschung.
  App gestartet. Tatsächlich installiertes Bundle auf dem Gerät per SHA-256 und Modulimport
  geprüft: `phi-spaces.space`, `readChain` und beide `FOREVER`-Defaults vorhanden.

APK-SHA-256: `314cd8ef58f755f9e5e904dfe7a9dd42e3b8427b251668ad1d69e8983dba3987`.
Bundle-SHA-256, identisch auf dem Gerät:
`eca8d56a8a53be7c4438734b92b4186af4b99120f6a3e10603de9009c01ef8cc`.

### Prüfnachweise dieses Fix-Laufs

| Prüfung | Ergebnis |
| --- | --- |
| Arbeitscheckout: Typecheck und Gesamtsuite | 755 bestanden, 1 übersprungen, 0 Fehler |
| Finaler eingefrorener Release: Typecheck und Gesamtsuite | 753 bestanden, 3 übersprungen, 0 Fehler |
| Finaler Release: Help-Suite | 47 bestanden, 1 SSR-Test übersprungen, 0 Fehler |
| Corpus-Check | 45 Artikel, 90 lokalisierte Datensätze, 14 Signaturgruppen, 60 typegeprüfte Beispiele |
| Produktions- und Nano-Dockerbuild | erfolgreich |
| Mobile-Runtime offline | 20/20 bestanden |
| Android-Build / Installation / installiertes Bundle | erfolgreich / `Success` / Import und Hash stimmen |
| Öffentliches Zwei-Shard-History-Paging | 2 × 100 Posts, vollständig, ohne Duplikate, 56 ms |
| Erweiterte Brandingprüfung einschließlich privater Testbed-Projektwerte | Zwei offene Treffer: `TESTBED_REMOTE_DIR` und `TESTBED_PROJECT`; keine Ausgabe ihrer Werte oder anderer Geheimnisse |

Release-Logs: `/tmp/phi-fix-release-root-final.log`, `/tmp/phi-fix-release-help-final.log`,
`/tmp/phi-fix-mobile-runtime-tests.log`, `/tmp/phi-fix-android-build.log`;
auf big `/tmp/phi-fix-production-build-final.log` und `/tmp/phi-fix-nano-build-final.log`.

### Noch nicht abgeschlossen

- [ ] **Separate Federation-/Testbed-Umstellung:** Auf big laufen weiterhin die bisherige
  Federation-/NetBird-Testumgebung und deren signierte Stores. Ihr zusätzliches Verwerfen und
  frisches Provisionieren wurde als eigene Entscheidung angefragt, da der konkret bestätigte
  DB-Reset nur Help und Swarm betraf. Bis zur Antwort keine Daten oder aktiven Federation-Prozesse
  ändern. Auch die ignorierte lokale `test/testbed/testbed.env` verweist noch auf das bisherige
  Testbed-Projekt/-Verzeichnis; sie darf nicht stillschweigend auf eine andere, leere Umgebung zeigen.
  Die Brandingprüfung berücksichtigt diese beiden ausdrücklich projektidentifizierenden privaten
  Einstellungen jetzt ebenfalls und meldet den offenen Punkt als Fehler, statt ihn zu übersehen.
- [ ] **Android-Re-Enrollment:** Das erhaltene Geräteprofil ist noch `paired` zum bisherigen
  Federation-Koordinator `phase1b-host-a`, mit einem Alias aus dem vorherigen Namespace.
  Installation ist erledigt, eine gültige neue Paarung ist es nicht. Keine Schlüssel oder
  ausstehenden Benutzeroperationen löschen; erst Ziel-Koordinator koordinieren und danach eine
  neue hardwaregebundene Identität kontrolliert anmelden.
- [ ] **Lokale historische Demo-Inhalte:** Die lokalen Entwicklungskopien waren nicht Teil des
  zusätzlich angeforderten Server-Resets. Deren historische Entry-Texte/Kanal-IDs sind deshalb
  weiterhin Nutzdaten aus dem vorherigen Zustand; Code und Dokumenttypen sind bereits umgestellt.
