# Phase 1b: Umsetzung und Abnahme

Stand: 2026-10-11. Der [Föderationsplan](federation-plan-v3.md) ist der Zielvertrag.
Die folgenden Nachweise schließen Phase 1b im geprüften F15-Modell ab; sie sind keine Freigabe der
vollständigen Federation oder von Recovery im Produktivbetrieb.

## Zusammengeführte Laufzeit

`startFederationHost` verbindet Gate, Overlay-Identität, Schlüsselbeweis,
Enrollment, Control-Berechtigungen, Grants, Schlüsselrotation, Supervisor und
Wartung auf einem persistenten Harness. Nur die konfigurierte Control-Laufzeit
stellt Grants aus. Ein Data-Member fragt das Schlüsselverzeichnis über den
bewiesenen Control-Dienst ab und prüft Grants gegen einen vorab provisionierten
öffentlichen Control-Schlüssel.

Der Laufzeitstart verlangt ein externes Boot-Register und eine separate lokale
Installation. Beide müssen für jeden Space dieselbe aktive Autorität,
Dateninkarnation und Rolle enthalten. `unsafeSkipBootGuardForTests` ist eine
ausdrückliche Ausnahme für Fixtures und darf nicht in einem ausgerollten Host
gesetzt werden. Auch Snapshot-Lesezugriffe scheitern bei fehlender Berechtigung;
vor einem Commit werden die gelesenen Registerversionen erneut verglichen.

## Grants und Rotation

Grants sind mit Ed25519 oder P-256 signiert, höchstens 60 Sekunden gültig und
an Autorität, Aussteller, Principal, App-Schlüssel und Space-Scope gebunden.
Die Prüfung berücksichtigt zwei Sekunden Zeitunsicherheit. Die Control-Seite
fragt vor jeder Ausstellung die aktuelle Overlay-Identität ab. Bei einem
Management-Ausfall werden keine neuen Grants ausgestellt.

Ein Pending-Take/Read darf nur bis zum gespeicherten Grant-Ablauf entscheiden.
Ein neuer Effect-Grant kann die eigene Pending-Arbeit erneut autorisieren,
wenn er auch die ursprüngliche Operation erlaubt. Ein Resolution-Grant erlaubt
Abfrage, Cancel und Abort, jedoch keine neue Ausführung. Txn-Commit und
Lease-Renew prüfen zusätzlich Rechte auf die ursprünglichen Entries bzw.
Operationen. Die Frist eines Remote-Aufrufs umfasst auch einen hängenden
Grant-Provider.

Rotation verlangt eine persistierte einmalige Challenge und Signaturen des
alten sowie des neuen Schlüssels. Der Supervisor widerruft den alten Schlüssel
und schreibt den neuen Schlüssel atomar; Rollen und Scope werden übernommen.
Die eigene Rotation ist auch bei einem auf Data-Spaces begrenzten Schlüssel
möglich, ohne dadurch Control-Entries lesen zu dürfen. Nach Verlust der Antwort
wird das eigene Command-Ergebnis mit `rotationStatus` abgefragt.

## Recovery-Bausteine

`SqliteRecoveryRegister` stellt persistentes Compare-and-Set bereit.
`RecoveryCoordinator.reserve` verlangt eine unabhängige Bestätigung des
Fencings einschließlich Wiederanlaufsperre und reserviert genau einen
Nachfolger der alten Autorität. Member prüfen die signierte Transition gegen
einen provisionierten Recovery-Schlüssel und installieren sie außerhalb der
Space-Snapshots.

`RecoveryController` verbindet die Restore-Bausteine mit einem dauerhaften Data-Recovery-Journal, unabhängiger Placement-/Boot-Prüfung und einem exakt geprüften Control-Receipt. `dataRecoveryHandler` bindet diese Methoden an den signierten privaten Socket. `ControlAckService` und `startConfiguredRecovery` stellen den echten signierten ACK-Kanal bereit; sein privater Socket und Forced-Command-Zugang sind auf host-a installiert. Ein erfolgreicher ACK innerhalb eines echten verteilten Data-Restores ist nun nachgewiesen (siehe Live-Data-Restore unten). Der Import hat einen
persistierten Cursor, hält die aktuellen Space-/Commit-Limits ein und wartet
mindestens 62 Sekunden. Alte Txns, Registrierungen, aktive Waiter und
Reservierungen werden entfernt. Alte Claims bleiben historische Nachweise;
ein offener Ausgang wird `unknownOutcome`, ein alter Request darf keine Arbeit
neu ausführen. Data-Entries bleiben lesbar, sind jedoch bis zur ausdrücklich
begrenzten Freigabe `restoredUnverified` und weder takebar noch unter einer Txn
verwendbar. Freigabe reserviert auch Stream- und Benachrichtigungskosten.

Diese Funktionen ersetzen keinen Fencing-Nachweis: Der aufrufende Recovery-Dienst
muss Admission sperren, Registry-Inkarnation im selben Commit aktualisieren,
Fencing, Control-ACK und externe/lokale Boot-Installation prüfen und erst danach
`completeRestore` verwenden. Beim Control-Import werden alte PeerKeys widerrufen, Bootstrap dauerhaft geschlossen, alte Policy-, Enroll-, Command- und RouterLease-Entries verworfen und Member auf `recoveryBlocked` gesetzt. Die Control-Primary-Epoche beginnt bei 1. Die erneute Freigabe der Overlay-Gruppen und verteilte Member-ACKs gehören weiterhin in den administrativen Ablauf.

## Automatisierte Nachweise

- `test/test-federation-runtime.test.ts`: zwei eigenständige persistente Harnesses
  über echte TCP-Gates, auf JSONL und SQLite. Bootstrap, Host-Enrollment,
  Schlüsselabfrage über die Leitung, Boot-Prüfung, Grants, abgelaufener Take,
  Resolution ohne Wirkung, Management-Ausfall, Rotation und Crash/Reopen.
- `test/test-grants.test.ts`: manipulierte Signatur, fremde Principals/Schlüssel und
  Scopes, Resolution ohne Effect, Ablauf unmittelbar vor Mutation und
  Rollenentzug vor Txn-Commit.
- `test/test-recovery.test.ts`: konkurrierende CAS-Nachfolger, ungültiger
  Fencing-Nachweis, signierte Installation und Reopen; Berechtigung pro Space,
  gesperrte Reads und Rollback bei gleichzeitigem Fence; Restore in mehreren
  Batches mit Reopen, historische Pending-Claims und begrenzte Task-Freigabe.

Der Gesamtprüflauf umfasst 233 bestandene Tests ohne Auslassungen. Typprüfung und alle 158 Beispieltests sind ebenfalls bestanden (Beispieltests mit `--test-concurrency=1`). Der Duplikat-Test verwendet nun ausdrücklich dieselbe Zeitmarke für beide Samples; getrennte `Date.now()`-Aufrufe waren instabil. Die simulierte
Overlay-Verzeichnisquelle und die kontrollierte Uhr in den neuen Tests sind
ausdrücklich Fixtures; diese Tests belegen keine NetBird-Ausfallmessungen.

Das gebaute Szenario verwendet dieselbe Bibliothek wie das Testbed:

```sh
npm run testbed -- --dry-run scenario federation-runtime
npm run testbed -- scenario federation-runtime
```

Es prüft zwei persistente Hosts innerhalb des Runner-Containers. Eine echte
Verteilung auf mehrere Container, das NetBird-Overlay und das Handy sind
gesonderte Abnahmen.

## Ergebnis der vollständigen Phase-1b-Abnahme

Data- und Control-Restore sind auf isolierten zusätzlichen Testhosts live bestanden
(siehe Nachweise unten). Das F15-Fencing prüft Prozess, Dienst und persistente
Neustartsperre; Promotion-/Cloud-Fencing ist damit nicht abgenommen.

Die frische Erstkopplung über die tatsächlichen Handy-Formulare ist inzwischen
bestanden, ebenso Objektzugriff, Rotation, Schlüsselwiderruf, App-Neustart,
zehn Minuten Bildschirm-aus/Hintergrund und kontrollierter tiefer Doze.
Der QR-Inhalt wurde über das vorgesehene Eingabefeld übernommen; eine Kamera-
Scannerfunktion ist gemäß 4.5 kein verpflichtendes Phase-1b-Gate. Temporäre
Enrollment-Mitgliedschaften und die verbrauchte private Eingabe sind entfernt.
Das normale APK enthält keine UI-Testinstrumentierung und hat danach erneut
das Jobs-Objekt gelesen.

Die vollständige Ausfallmatrix ist abgeschlossen und bereinigt. Gemessen wurden
Management 305,3 s und 3604,3 s, Signal 608,6 s, Relay 1807,3 s und
Management + Relay 3604,0 s. Jeder Fall endet mit erfolgreichem Objektzugriff.
Auch der Desktop konnte nach dem letzten Fall wieder ein Objekt lesen; seine
temporäre Firewall-Ausnahme wurde entfernt. Die drei Hauptdienste bleiben aktiv.

[Zusammenfassung der Abnahme](../test/evidence/ap1b-2026-10-11/acceptance-summary.json)
und [vollständige Messungen](../test/evidence/ap1b-2026-10-11/netbird-fault-matrix.json)
belegen damit die Phase-1b-Abnahme im geprüften F15-Betriebsmodell. Die Ausfälle
betrafen gezielt die Erreichbarkeit der Komponenten für zwei eigene Testpeers,
nicht einen globalen Server-/Datenbankausfall. Ein bestehender direkter Tunnel
blieb bei Management-Ausfall erreichbar, während der Space-Zugriff nach Ablauf
des Gate-Caches gesperrt war. Messzeitpunkte enthalten Abtast- und Probezeiten.
RunGate, Replikation und Promotion bleiben Aufgaben späterer Phasen.

## Betriebsprüfung vom 2026-10-10

Der erste Transfer auf big scheiterte mit `No space left on device`. Der danach
beauftragte Wiederholungslauf ist bestanden: vollständiger Artefakttransfer,
Image-Neubau, Neustart ausschließlich des Runner-Containers und Ausführung des
gebauten Szenarios `federation-runtime`. Ergebnis: `passed: true` auf JSONL und
SQLite mit zwei persistenten Hosts, TCP-Loopback und aktivierter Boot-Prüfung.
Das Overlay-Verzeichnis ist eine Fixture; dies ist keine Live-NetBird-Ausfallmatrix.
Die übrigen Host-/Member- und NetBird-Container liefen weiter mit ihren bisherigen
Images. Der neue Federation-Dienst wurde nicht in diese Container ausgerollt.

Die anschließende Handy-Abnahme ist bestanden: Xiaomi M2007J17G, Android 12,
Node v26.4.0, WLAN-ADB. Die zwei frisch gebauten Testmodule wurden im separaten
App-Verzeichnis `files/runtime/phi-spaces-acceptance` ausgeführt. Ergebnis:
1 Federation-Integrationstest und 3 Recovery-/Boot-/Restore-Tests bestanden,
keine Fehler und keine Auslassungen. Die Backend-Fälle laufen auf JSONL und SQLite;
Testdaten verwenden eigene temporäre Verzeichnisse.

Der erste Federation-Lauf scheiterte an TCP-Timeouts. Ein unabhängiger Minimaltest
reproduzierte dies sowohl für die Standard-Loopback-Verbindung als auch für
`127.0.0.3`. Nach Start der pi-mobile-App im Vordergrund funktionierten beide
Verbindungen; anschließend bestand das unveränderte Federation-Testmodul.
Der Nachweis gilt für die aktive App. Er belegt keinen dauerhaften Hintergrund-
oder Bildschirm-aus-Betrieb. VPN-Lockdown war nicht gesetzt und die App besaß
bereits die Internetberechtigung; diese Einstellungen wurden nicht verändert.

Beim direkten Start der Termux-Node-Laufzeit müssen die app-eigenen Pfade gesetzt
sein: insbesondere `LD_LIBRARY_PATH`, `OPENSSL_CONF`, `PREFIX`, `HOME` und
`TMPDIR`, entsprechend `PiService.startNode`. Der OpenSSL-Standardpfad verweist
sonst auf das private Verzeichnis der anderen App `com.termux` und ist unzugänglich.

Auf dem Handy laufen im Test zwei lokale TCP-Gates mit simulierten Overlay-Peers
und Software-Schlüsseln. Dies ist ein echter Android-Laufzeit-/Persistenznachweis,
jedoch für diesen Lauf weiterhin keine Verbindung Handy–big über NetBird, kein Android-Keystore-
Nachweis und keine Abnahme der sichtbaren Enrollment-/QR-Bedienung. Der native
Keystore-Nachweis wurde separat am 2026-10-11 erbracht (unten).

## Ergänzte Implementierung vom 2026-10-10

Die Bausteine und konkreten Konfigurations-/SSH-Aufrufe stehen in
[ap1b-betrieb.md](ap1b-betrieb.md). `test/test-operations.test.ts` prüft private
Schlüsseldateien, Reader-/CAS-Trennung, signierten privaten Recovery-Zugang,
Data-Restore mit Journal/Registry/ACK/Boot-Abgleich nach Reopen auf beiden
Backends, idempotente Freigabe über den echten Socket, gesperrte Freigabe nach
Fencing, den konfigurierten Federation-Start und geschlossene Control-Rechte nach
Snapshot-Import. Die externen Fencing-/ACK-Nachweise in Restore-Tests sind
explizite Fixtures. Kein realer systemd-/SSH-Fencing-Nachweis wird daraus abgeleitet.

`pi-termux-mobile/test/spaces-mobile.test.mjs` enthält inzwischen drei Prüfungen für vor dem
Senden gespeicherte Anfragekennungen, Token-Abwesenheit in Profilen und
Rotationsauflösung nach Reopen. Der Keystore ist dabei ein Adapter-Fixture;
der native Java-Signer wurde durch den erfolgreichen APK-Build kompiliert,
in diesem Build-Lauf noch nicht auf dem Gerät ausgeführt. Die spätere native
Geräteprüfung vom 2026-10-11 ist unten dokumentiert. Der erfolgreiche Build ersetzt keine
sichtbare UI-/NetBird-Geräteabnahme.

## Betriebs- und Geräteprüfung vom 2026-10-11

Nachweise: [öffentliche Ergebnisdateien](../test/evidence/ap1b-2026-10-11/README.md).
Keine Tokens, privaten Schlüssel oder noch gültigen signierten Grants sind darin
enthalten.

- **Register:** `vpsc` ist vom Space-Testbed auf `big` unabhängig. Zwei aktive,
  beim Benutzerstart aktivierte systemd-Dienste stellen private Reader-/Operator-
  Sockets und einen mTLS-Metadatenzugang auf TCP 17422 bereit. Datenbank/Keys/
  Konfigurationen sind `0600`, Verzeichnisse `0700`. Die Firewall erlaubt nur
  big und den aktuellen Operatoranschluss. Reader-CAS wird abgewiesen, Operator-
  CAS-Konflikte behalten ihre Fehlerklasse; der Testrecord bleibt nach Neustart
  erhalten. Der CA-Privatschlüssel blieb auf dem Operator-Rechner.
- **Zwei reale Hosts:** `host-a` und `member-1` führen eigene SQLite-Harnesses und
  eigene Node-Prozesse aus. Gate-IP/Peer-Gruppen kommen aus der echten NetBird-
  Management-API; kein Fixture-Verzeichnis und kein übersprungener Boot-Guard.
  Bootstrap/Admin-Proof, Supervisor-Host-Enrollment, Objektabfrage, Write/Take,
  Control-Grants und P-256-Rotation sind bestanden. Die alte App-Identität wird
  abgewiesen; neue Identität/Rotation bleiben nach Dienstneustart nutzbar.
- **Dauerhafter Betrieb:** `phi-spaces-phase1b-host-a.service` und
  `phi-spaces-phase1b-member-1.service` starten ihre vorhandenen Container und
  den gebauten Federation-Daemon. Exklusiver Owner-Lock verhindert einen zweiten
  Writer. Stop prüft die tatsächlichen Container-Prozesse; Recovery startet nur
  bei gesperrtem Normalbetrieb, ohne Gate und ohne Agenten.
- **F15:** Ein auf member-1 fest gebundener SSH-Befehl stoppt Normalprozess und
  systemd-Dienst und schreibt eine persistente Neustartsperre. Ein erneuter
  Normalstart wurde tatsächlich abgewiesen. Dieser Test installierte keinen
  Restore/Nachfolger; erst nach unverändertem Authority-/Boot-Abgleich wurde die
  Test-Sperre entfernt. Das ist kein Promotion-/Cloud-Fencing-Nachweis.
- **Privater ACK-Zugang:** Auf host-a läuft der signierte private Recovery-Socket
  hinter einem fest gebundenen Docker-/SSH-Bridge-Befehl. Fremde Signatur,
  falsche Authority im ACK und beliebiger Commit sind live abgewiesen. Ein
  gültiges Restore-ACK wurde auf beiden Backends automatisiert und anschließend
  innerhalb des verteilten Live-Data-Restores geprüft.
- **Android:** Aktualisierte APK auf Xiaomi M2007J17G/Android 12 installiert;
  echte P-256-Signaturen aus Android Keystore durch phi-spaces und Node crypto
  geprüft. Fremder Peer/Host, abgelaufene Challenge, beliebige Nachricht und
  Private-Key-Export werden abgewiesen. Beide Rotationssignaturen funktionieren;
  Aliase/öffentliche Schlüssel bleiben nach Force-stop und App-Neustart gleich.
  Die Test-Peer-/Hostnamen sind Fixtures; dies ist keine Overlay-/UI-Abnahme.

Der Operator-TCP-Timeout wurde auf eine vorhandene Tailscale-Regel zurückgeführt:
`ts-input` verwirft fremde Interfaces mit Quelladressen aus `100.64.0.0/10`.
SYN-ACKs waren auf `wt0` sichtbar, kamen aber nicht beim Socket an. Zwei enge
Laufzeitregeln vor dieser Kette erlauben nur etablierte TCP-Antworten von
100.89.128.128 bzw. 100.89.5.70 mit Quellport 7421. Es wurde kein VPN installiert
oder deaktiviert. Diese lokalen Regeln sind noch keine persistente allgemeine
VPN-Konfiguration.

`test/test-recovery-boundaries.test.ts` prüft zusätzlich den verlorenen externen ACK,
einen zweiten Authority-Wechsel, stale Snapshot-Marker, begrenzte Orphan-Audits,
TLS-Clientrechte/Serveridentität, signierte ACKs und deren Schlüsselwiderruf vor
Receipt-Commit sowie den vollständigen Control-Controller mit zwei persistenten
Members. Fencing und Uhr sind darin Fixtures. `test/test-grants.test.ts` verweigert
nach Restore A-only-Observerrechte und lässt für Unpaired nur Enrollment-Scope.
Die TUI liest nun auch laufende `harness.sqlite` über SQLite-Backup in eine private
Kopie; Historie, ungültige Generationen und Restore-/Authority-Zustände werden
angezeigt.

### Erneute Handy-Verbindung und finaler Serverstand

WLAN-ADB ist wieder verbunden. Das Handy besitzt nun eine echte gekoppelte
Keystore-Identität für `phase1b-host-a` und authentifiziert sich über NetBird.
Die Rollenbegrenzung und die verbleibenden Abnahmen stehen oben; der Test erfolgte
über die lokale Mobile-API, nicht durch sichtbare UI-Bedienung. Siehe
[Handy-Nachweis](../test/evidence/ap1b-2026-10-11/phone.json).

Die finalen Artefakte wurden auf host-a und member-1 ausgerollt; beide Dienste
laufen. Die Prüfungen von Grants, Write/Take, bestehender Rotation und privatem
Recovery-Zugang wurden danach wiederholt. Der gebaute TUI-Inspektor liest auf
beiden laufenden Hosts `harness.sqlite` und zeigt Control-/Jobs-Space samt
Objekten ohne Lesefehler: [TUI-Nachweis](../test/evidence/ap1b-2026-10-11/tui.json).

Ein erneuter Authentifizierungsaufruf nach kurzem Wechsel der App in den
Hintergrund ist bestanden. Danach wurde die App wieder angezeigt. Das belegt
keinen Doze-, Bildschirm-aus- oder langfristigen Hintergrundbetrieb. Das finale
gebaute Runner-Szenario ist auf JSONL und SQLite erneut bestanden; sein
Overlay-Verzeichnis bleibt ein Fixture.

### Handy-Tests nach Aufnahme in die Member-Gruppe

Der erste Data-Zugriff meldete `grant belongs to another app key`: Der mobile
Client forderte einen Grant über eine separate, noch nicht authentifizierte
Control-Verbindung an. `MobileSpaces.connect` beweist nun dort zuerst denselben
Keystore-Schlüssel; beim Fehlschlag werden beide Verbindungen geschlossen.
Ein Regressionstest über zwei echte TCP-Verbindungen reproduziert den alten
Fehler und besteht mit der Korrektur. Alle drei mobilen Tests bestehen.
Die korrigierte APK wurde gebaut und ohne Datenlöschung installiert.

Live auf dem Xiaomi sind Jobs-Objektzugriff über NetBird, eigene P-256-Rotation,
Abweisung des alten Schlüssels sowie Auflösung einer noch ausstehenden Rotation
nach Force-stop/Neustart und anschließender Objektzugriff bestanden. Der Grant-
Test verwendet einen Fixture-Signer; die Geräteprüfung verwendet den nativen
Android Keystore. Die sichtbare UI-Bedienung ist noch nicht vollständig abgenommen.
Der Bildschirm-aus-Versuch zählt nicht als Erfolg: `dumpsys power` meldete
`Awake`, daher ist keine Bildschirm-aus-Dauer belegt. Der Bildschirm wurde am
Ende wieder eingeschaltet. Nachweis: [phone.json](../test/evidence/ap1b-2026-10-11/phone.json).

Auch der kontrollierte 90-Sekunden-Versuch konnte keine volle Ruhephase
belegen: Android wechselte zunächst in `Dozing`, war nach rund 11 Sekunden
aber wieder `Awake`. Der Test brach deshalb ab und zählt nicht als
Bildschirm-aus-Abnahme. Es wurden keine Energie- oder VPN-Einstellungen geändert.

### Verteilter Live-Data-Restore und sichtbare Objektanzeige

Die Handy-Objektanzeige wurde über den sichtbaren Button ausgelöst; nach der
Antwort wurde das Testobjekt in der UI nachgewiesen. Die vollständige sichtbare
Enrollment-/Rotations-Bedienung bleibt von dieser Einzelprüfung getrennt.

Ein konsistentes Online-SQLite-Backup von `phase1b-restore-source` auf host-b
wurde auf `phase1b-restore-target` auf member-2 restauriert. Die alten Normal-
Prozesse wurden über fest gebundene SSH-Kommandos tatsächlich gestoppt und
restart-gesperrt; das externe Register auf vpsc hält die Quelle weiterhin fenced.
Der private Control-Dienst auf host-a bestätigte das exakt passende Tupel.
Der Recovery-Prozess wurde mit SIGKILL beendet; erst nach nachgewiesenem Prozessende
wurde der stale Owner-Lock entfernt. Der persistierte Wartestand wurde nach
Neustart mit identischer Inkarnation/Epoche wieder geladen und nach der echten
Wartefrist abgeschlossen.

Am exklusiv geöffneten Ziel-Storage waren die restaurierten Objekte lesbar,
aber vor `releaseRestored` nicht entnehmbar. Der signierte, typbegrenzte Release
zählte genau ein Objekt; Wiederholung war idempotent. Operator-TLS- und private
SSH-Zugangsdaten wurden vor dem Normalstart entfernt. Vom echten Handy wurde
das freigegebene Objekt über NetBird gelesen, entnommen und zurückgeschrieben.
Der ursprüngliche Handy-Jobs-Zugriff funktioniert weiterhin. Alle 232 Tests
bestanden nach den Änderungen erneut ohne Auslassungen. Nachweis:
[data-restore.json](../test/evidence/ap1b-2026-10-11/data-restore.json).


### Verteilter Live-Control-Restore mit separatem Member

Die isolierte Control-Autorität wurde aus einer echten SQLite-Sicherung auf einen
anderen Testhost restauriert. Der alte Control-Prozess und sein systemd-Dienst
wurden über den fest gebundenen F15-Zugang gestoppt und dauerhaft gesperrt.
Das unabhängige Register auf vpsc reservierte genau die neue Autorität
`a-de6377f2-2916-46ad-be65-8869dbc541c7` für
`live-control-restore-20261011`.

Ziel und separater Member installierten die signierte Transition dauerhaft.
Der Member erhielt ausschließlich den öffentlichen OP-Pin; sein zeitweiliges
TLS-Zertifikat durfte nur seinen Boot-Eintrag und sein Authority-ACK schreiben.
Ohne Member-ACK verweigerte der Controller die Freigabe. Nach Installation des
Members verweigerte er sie weiterhin ohne frischen Admin. Erst nach expliziter
Autorisierung neuer Admin-/Host-Schlüssel wurde der Restore abgeschlossen.

Die Recovery-Prozesse wurden geschlossen und ihre privaten administrativen
Zugangsdaten entfernt. Nach ausdrücklicher Neuprovisionierung starteten beide
normalen Gates: Der neue Admin authentifizierte sich und erhielt Grants, der
alte Admin-Schlüssel wurde abgewiesen, vorhandene Member-Objekte waren lesbar,
und Schreiben/Entnehmen funktionierten über das echte NetBird-Overlay.

Anschließend wurden die zusätzlichen Control-Gates gestoppt, die ursprünglichen
Hauptdienste und das bereits restaurierte Data-Ziel wieder gestartet sowie die
temporäre Register-Schreibfreigabe und Firewall-Regeln entfernt. Die alte
Control-Quelle bleibt gesperrt. Alle 233 Tests und die Typprüfung sind bestanden;
Mobile-Bundle und Testbed-Artefakte wurden neu gebaut. Öffentlicher Nachweis:
[control-restore.json](../test/evidence/ap1b-2026-10-11/control-restore.json).


### Wiederholter kurzer Bildschirm-aus-Test

Der erste Versuch war wegen vorzeitigem Aufwachen nicht akzeptiert. Die
Wiederholung belegt das ununterbrochene kurze Intervall anhand fortlaufender
`dumpsys power`-Samples (`Dozing`/`Asleep`), danach erfolgreichen echten
Handy-Objektzugriff und abschließend weiterhin `Asleep`. Der Gesamtlauf dauerte
115,2 Sekunden; der Bildschirm wurde anschließend wieder eingeschaltet.
Das schließt den kurzen Bildschirm-aus-Nachweis, nicht die Langzeit-/Doze-Abnahme.
Samples und beide Versuche stehen in
[phone.json](../test/evidence/ap1b-2026-10-11/phone.json).


### Sichtbare Handy-Steuerung nach Rotation

Die Live-UI-Prüfung fand einen echten Fehler: Der Kopplungsstatus verglich das
historische Enrollment-Ergebnis mit dem bereits rotierten aktuellen Schlüssel.
Die mobile Laufzeit prüft bei `paired` jetzt den aktuellen App-Schlüssel; ein
widerrufener Schlüssel wird weiter abgewiesen. Pending-Enrollment wird weiterhin
über sein dauerhaft gespeichertes ursprüngliches Request-Tupel aufgelöst.
Abgeschlossene Rotations-Command-IDs bleiben für erneute Statusabfragen erhalten.

Die korrigierte APK wurde offline gebaut und auf dem Xiaomi aktualisiert.
Sichtbar bedient und bestanden: Kopplungsstatus, Schlüsselbeweis, eigene Rotation,
Rotation auswerten (einschließlich Wiederholung nach Abschluss) und Objektanzeige
mit dem neuen Schlüssel. Alle vier Mobile-Regressionen sind bestanden.
Öffentlicher Nachweis: [phone-ui.json](../test/evidence/ap1b-2026-10-11/phone-ui.json).
Frische Erstkopplung über die sichtbaren Formulare und Kamera-QR-Erfassung wurden
in diesem Lauf nicht erneut durchgeführt. Der Zehn-Minuten-Bildschirm-aus-Versuch
wurde nach 192 Sekunden durch Aufwachen unterbrochen und zählt nicht als bestanden.

### Begrenzte NetBird-Ausfallmatrix in Ausführung

Der separate administrative Fehlerproxy und seine Messwerkzeuge sind unter
[test/testbed/netbird/FAULT-TESTS.md](../test/testbed/netbird/FAULT-TESTS.md)
beschrieben. Nur die eigenen Test-Peers host-b/member-2 und das zusätzliche
restaurierte Data-Gate laufen darüber; ursprüngliche Hauptdienste und Handy
bleiben auf ihrem normalen Pfad. Management, Signal und Relay wurden jeweils
in gesunder Baseline als verbunden gemessen; der neue auf `jobs` beschränkte
Testclient las das vorhandene restaurierte Objekt erfolgreich.

Historische Fortschrittsnotiz vor Abschluss: Die zeitlich vollständige Matrix lief unter `phi-spaces-netbird-matrix.service`
auf big mit atomarem Fortschrittsbericht und unabhängiger zeitgesteuerter
Rückkehr zum ursprünglichen Netzwerkpfad. Im laufenden Management-Fall blieben
Signal/Relay und direkter TCP-Tunnel erhalten, während das echte Data-Gate nach
Cache-Ablauf den Objektzugriff verweigerte. Laufende Zeitspannen sind noch keine
abgeschlossenen Nachweise. Desktop-/Relay-Zugriff wird ergänzend lokal gemessen.


Der erste vollständige Management-Fall ist beendet: 305,3 Sekunden Fehlerphase,
Signal/Relay und direkter TCP-Zugriff erhalten, Objektzugriff nach Gate-Cache-
Ablauf gesperrt und anschließend wiederhergestellt. Der separate Stundenlauf
ist gestartet. [Messnachweis](../test/evidence/ap1b-2026-10-11/netbird-management-5m.json).


### Zehn Minuten Hintergrundbetrieb mit ausgeschaltetem Bildschirm

Die Wiederholung ist bestanden: 600 Sekunden angeforderte Dauer, 608 Sekunden
Gesamtlauf, fortlaufend `Asleep`/`Dozing`, sechs erfolgreiche Objektprüfungen
(einschließlich Ende). Vorher wurde die App mit HOME in den Hintergrund versetzt;
Android bestätigte während des Laufs `STOPPED` und nicht sichtbar. Der Dienst,
NetBird und native Schlüsselbeweis funktionierten weiter. Die Samples für das
alte Resumed-Activity-Feld sind nicht auf allen Android-Versionen aussagekräftig;
die unabhängige Activity-Prüfung und der fortlaufende Bildschirmzustand ergänzen
sie. Der Bildschirm wurde anschließend wieder eingeschaltet.
[phone-background-10m.json](../test/evidence/ap1b-2026-10-11/phone-background-10m.json).
Das belegt das gemessene Zehn-Minuten-Intervall, keine unbegrenzte Laufzeit und
keine automatisch eingetretene tiefe Doze-Phase.


### Kontrollierter tiefer Doze-Test

Der erzwungene tiefe Doze-Test ist bestanden: 180 Sekunden angeforderte Dauer,
187,8 Sekunden Gesamtlauf, durchgehend `mState=IDLE` und `mForceIdle=true` sowie
vier erfolgreiche echte Objektprüfungen. Vorher war kein Force-Idle aktiv.
Anschließend wurde die eigene Testsperre aufgehoben; Android meldete wieder
`mForceIdle=false` und `ACTIVE`. Es wurden keine Batterieausnahmen oder
Energieeinstellungen geändert. Der Bildschirm wurde wieder eingeschaltet.
[phone-doze.json](../test/evidence/ap1b-2026-10-11/phone-doze.json).

Der kontrollierte Doze-Test mit WLAN-ADB und der zehnminütige Bildschirm-aus-Lauf
sind bestanden. Sie ersetzen keine uninstrumentierte Messung über Nacht.
Offen sind weiterhin die noch laufenden langen NetBird-Zeitfälle, gemessene
Gruppen-/Peer-Entziehung und die vollständige Erstkopplung über die sichtbaren
Formulare beziehungsweise Kamera-QR-Funktion.

### Frische Erstkopplung und gemessener Gruppen-/Peer-Entzug

Auf dem realen Xiaomi wurden Prepare, Übernahme eines frischen QR-Payloads,
Datenformular, Authentifizierung und Objektanzeige durch die tatsächlichen
UI-Handler ausgeführt. Das neue native Keystore-Profil ist gepairt; der zuvor
verwendete Schlüssel ist widerrufen und wird zurückgewiesen. Nach Installation
des normalen APKs ohne Instrumentierung funktioniert der Objektzugriff weiter.
[phone-first-pair-ui.json](../test/evidence/ap1b-2026-10-11/phone-first-pair-ui.json).

Ein eigens angelegter NetBird-Peer verlor den Zugriff nach Gruppenentzug in
2,895 Sekunden. Nach bestätigter Rückaufnahme wurde genau dieser Test-Peer
gelöscht; der Zugriff war nach 2,823 Sekunden verweigert. Die Messung betrifft
den Ende-zu-Ende-Zugriff einschließlich Overlay-ACL und Gate, nicht eine isolierte
Messung ausschließlich des Schicht-A-Caches. Wegwerf-Peer, Container und Setup-Key
wurden entfernt beziehungsweise widerrufen. Bestehende Peers wurden nicht verändert.
[peer-withdrawal.json](../test/evidence/ap1b-2026-10-11/peer-withdrawal.json).
