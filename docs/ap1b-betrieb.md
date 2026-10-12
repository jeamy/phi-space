# Phase 1b: provisionierter Start und Recovery-Schnittstellen

Stand: 2026-10-11. Dies beschreibt implementierte Werkzeuge und deren
Voraussetzungen. Die vollständige Betriebsabnahme steht in
[ap1b-abnahme.md](ap1b-abnahme.md). Data- und Control-Restore sind live geprüft; frische Erstkopplung über die Handy-UI ist bestanden. Die vollständige fünfteilige NetBird-Ausfallmatrix ist einschließlich Wiederaufnahme und Bereinigung bestanden.

## Normale Laufzeit

`PI_SERVERD_FEDERATION_CONFIG` aktiviert in `pi-serverd.mjs` die vollständige
Federation-Kette. Sie startet vor `harness.resume()` und ersetzt die statische
Space-Identität am nativen Unix-Adapter. Der Adapter bekommt ausschließlich die
provisionierte eigene Peer-ID mit frisch abgefragten NetBird-Gruppen; Client-
Presentation und Service-Argumente setzen keine Identität. Jede Verbindung
benötigt weiterhin ihren App-Schlüsselbeweis und passende Control-Grants.

Die JSON-Konfiguration muss eine reguläre Datei im Besitz des Dienstbenutzers
mit Modus `0600` sein. Beispielstruktur, alle Werte werden ausdrücklich
provisioniert:

```json
{
  "hostId": "host-1",
  "peerId": "NETBIRD-PEER-ID",
  "authorityId": "INITIAL-AUTHORITY-ID",
  "controlHostId": "control-host",
  "controlSpaceId": "STABLE-CONTROL-SPACE-ID",
  "mode": "member",
  "listen": {"host": "OVERLAY-IP", "port": 7421},
  "keyFile": "/private/host-key.json",
  "registerSshTarget": "register-reader@independent-admin",
  "installedRegisterFile": "/private/installed.sqlite",
  "management": {"url": "https://NETBIRD-MANAGEMENT", "tokenFile": "/private/auditor-token"},
  "groupRoles": {
    "space-hosts": ["member", "host"],
    "space-admin": ["admin"],
    "space-members": ["member"],
    "space-observer": ["observer"],
    "space-enroll": ["unpaired"]
  },
  "control": {
    "address": {"host": "CONTROL-OVERLAY-IP", "port": 7421},
    "algorithm": "ed25519",
    "publicKey": "PINNED-PUBLIC-KEY-BASE64"
  }
}
```

Alternativ zu `registerSshTarget` wird genau ein `registerTls` oder `registerReadSocket` angegeben,
beispielsweise ein ausdrücklich eingerichteter privater SSH-Socket-Tunnel.
Normale Member erhalten nur Reader-Zugänge. Ein administrativer, exklusiver
Member-Recovery-Prozess darf einen separaten TLS-Schreibzugang besitzen, dessen
`writeKeys` ausschließlich seinen Boot-Eintrag und das konkrete Authority-ACK
zulassen; er erhält keinen unbeschränkten Operatorzugang.
`provisionFileSigner(path, algorithm)` erzeugt einen Schlüssel einmalig;
`loadFileSigner(path)` verweigert fehlende, öffentliche, fremde oder verlinkte
Dateien und erzeugt keinen Ersatz. Schlüsseldatei und Management-Token bleiben
außerhalb Space-Snapshots.

Vor dem Start müssen Registry/Spaces, PeerKeys, ein aktiver externer `authority:CONTROL_SPACE_ID`-Record, ein externes `boot:HOST` und
lokale `installed:HOST:SPACE`-Records übereinstimmend provisioniert sein.
`mode: control` verlangt außerdem die richtige Control-Space-ID und den zum
Signer passenden öffentlichen Schlüssel/Algorithmus. Die Listen-IP muss laut
Management-API dem provisionierten Peer gehören. Nach Autoritätswechsel muss
der neue Control-Endpunkt ausdrücklich passend konfiguriert sein. Ein fehlender
oder inaktiver Boot-Nachweis verhindert den normalen Start.

Die Enrollment-Gruppe wird nach erfolgreicher Kopplung administrativ in die
gewünschte Betriebsgruppe geändert. Ein PeerKey allein erweitert Schicht A
nicht. Gepaarte Geräte können mit aktuellem Schlüssel ihre eigene gespeicherte
Enrollment-Anfrage auflösen, auch bei einem nur auf Data-Spaces begrenzten Scope.
Neue Tokens können sie darüber nicht verbrauchen.

## Unabhängiges Register und SSH

Auf dem unabhängig verwalteten Recovery-Admin-System:

```sh
npm run build
node scripts/recovery-register.mjs serve /private/register.sqlite /private/read.sock /private/operator.sock
node scripts/recovery-register.mjs get /private/read.sock boot:host-1
node scripts/recovery-register.mjs cas /private/operator.sock boot:host-1 null /private/initial-host-record.json
```

`cas` verlangt die aktuelle Versionsnummer oder `null` für einen neuen Record.
Die Datei mit dem neuen Wert ist ebenfalls privat. Der Dienst legt Socket-
Verzeichnis und Datenbank privat an; am Reader-Socket wird CAS serverseitig
abgewiesen, auch wenn der Client sich als Writer ausgibt. Das Register darf nicht
zusammen mit Space-Snapshots gesichert/zurückgerollt werden: ein bereits vergebener
Autoritätsnachfolger muss erhalten bleiben.

Ein dedizierter SSH-Schlüssel bekommt beispielsweise diesen festen Zugang in
`authorized_keys`; Pfade und Benutzer werden vom Betreiber installiert:

```text
restrict,command="/usr/bin/node /opt/pi-spaces/scripts/recovery-ssh.mjs read /private/read.sock" ssh-ed25519 PUBLIC_READER_KEY
restrict,command="/usr/bin/node /opt/pi-spaces/scripts/recovery-ssh.mjs recovery /private/recovery.sock" ssh-ed25519 PUBLIC_RECOVERY_ACCESS_KEY
```

Reader akzeptieren nur `SSH_ORIGINAL_COMMAND=pi-spaces-register-read`, ein
begrenztes JSON-`get` auf stdin und liefern einen JSON-Record auf stdout. Der
Client verwendet BatchMode und StrictHostKeyChecking; ohne provisionierten
SSH-Hostschlüssel oder ohne Register-Antwort wird abgewiesen. Der Recovery-Bridge
akzeptiert ausschließlich `pi-spaces-recovery` und reicht einen begrenzten
signierten RPC an den fest vorgegebenen privaten Socket weiter. SSH-Zugang
allein erteilt keine Recovery-Rolle: der Dienst prüft den separat provisionierten
Operator-Schlüssel bzw. den aktuellen Supervisor-Schlüssel und das Host-Ziel.

## F15 und dauerhafte Wiederanlaufsperre

`scripts/fence-ssh.mjs HOST UNIT STATE_DIR` ist ein weiterer fest installierter
Forced Command. `pi-spaces-fence` schreibt und synchronisiert `restart.lock`,
stoppt die festgelegte systemd-User-Unit und liefert ihren Zustand.
`pi-spaces-fence-status` prüft nur. Der Dienst muss mit `KillMode=control-group`
betrieben werden. Normaler `pi-serverd` verweigert bei vorhandener Sperre den
Start, auch außerhalb systemd. Unit, Host-ID und State-Verzeichnis stammen
niemals aus der SSH-Anfrage.

`verifySshFence` verwendet ausschließlich administrativ provisionierte
SSH-Ziele, verlangt einen gestoppten Dienst und die dauerhafte Sperre und setzt
anschließend den externen Host-Boot-Zustand per CAS auf `fenced`. F15 verweigert
Sync-/Replikat-Konfigurationen. Dies ist ein Adapter für den Single-Betrieb;
seine Abnahme mit dem echten Dienst steht aus. Ein unerreichbarer Alt-Host ohne
unabhängigen Fencing-Nachweis berechtigt nicht zum Restore. Sperre und externe
Berechtigung werden ausschließlich in einem separaten geprüften administrativen
Ablauf wieder freigegeben; eine höhere Epoche entfernt die Sperre nicht.

## Data-Restore und verbleibende Integration

`RecoveryController` journalisiert Argument-Hash, Snapshot-Hash, Quellhost und
Importzustand. Der Quellhost stammt aus `placement:SPACE` im unabhängigen
Register, nicht aus einer Behauptung des anfragenden Clients. Vor Import wird die
Space-Boot-Berechtigung entzogen. Registry-Inkarnation und Restore-Zustand ändern
sich atomar; Importcursor und Journal überstehen Prozessabbruch. Journal-Kosten
werden zusätzlich zum Import gegen das Commit-Budget reserviert.

`serveRecovery({ ..., handle: dataRecoveryHandler(controller) })` verbindet nur
`restoreDataSpace`, `advanceRestore`, `restoreStatus` und `releaseRestored` mit
dem privaten signierten Socket. Der Controller bekommt privilegierte
Host-Funktionen desselben Harness, vor dem normalen Boot-Guard gebunden; diese werden dem normalen Space-Service nicht übergeben. Ein zweiter gleichzeitig geöffneter Harness ist kein Ersatz.
Snapshot-Lader, Fencing-Ziele und der tatsächliche Control-ACK-Kanal müssen
administrativ bereitgestellt werden. `acknowledgeControl` muss ein dauerhaftes
Receipt mit exakt Recovery-ID, Space, Autorität, Inkarnation und Primary-Epoche
liefern; ein geratenes `true` genügt nicht.

Nach mindestens 62 Sekunden und gültigem ACK installiert der Controller die neue
lokale und externe Berechtigung und aktualisiert Placement. Restaurierte Daten
bleiben bis zur ausdrücklich begrenzten Freigabe quarantiniert. Auch diese
Freigabe verweigert inzwischen gefencte Hosts oder veränderte Boot-Records.
`hello` und Rahmenprüfung verwenden die gespeicherte Epoche des betreffenden
Space. Status-/Release-Retries verwenden dieselbe Recovery-/Command-ID.

`startConfiguredRecovery` ist in die normale Laufzeit integriert und liefert
Control-ACK sowie optional Data-Recovery. Der Control-Restore läuft ausschließlich
über `startRecoveryOnly` unter exklusivem Harness-Besitz und Neustartsperre.
Member-ACK, Boot-Abgleich und ausdrückliche neue Key-Freigabe sind implementiert;
die verteilten Data-/Control-Live-Restores sind inzwischen abgenommen. Die lokalen
Control-Importfunktionen halten Bootstrap geschlossen, widerrufen PeerKeys,
verwerfen Tokens/Commands/alte Policy-Regeln und setzen Member auf
`recoveryBlocked`; sie ersetzen diesen verteilten Ablauf nicht.

## Android-Bedienung

Die Seite `spaces.html` bietet Geräte-Schlüssel anlegen, Koppeln,
Enrollment-Status, Schlüsselbeweis, Rotation/Rotationsstatus und einen ausgewählten
Data-Space mit maximal 100 Objekten und Statistik. Peer-ID und vertrauenswürdige
Control-/Data-Host-IDs werden ausdrücklich eingegeben. Ein QR-JSON kann eingefügt
werden; Endpoint und optional bereits hinterlegte Control-Space-ID werden
abgeglichen. Eine Kamera-QR-Erfassung ist noch nicht implementiert.

`SpaceKeyStore` erzeugt P-256 in Android Keystore. Der private Schlüssel verlässt
Keystore nicht. Node erhält über einen nach App-UID geprüften lokalen Socket nur
öffentlichen Schlüssel und Signaturen. Signaturen sind auf frische,
identitätsgebundene Auth-/Rotationsnachrichten begrenzt. Ein ausdrücklich
hinzugefügter Data-Host wird in der lokalen Schlüsselbindung gespeichert.

Die private Profil-Datei enthält Aliase, öffentliche Metadaten und vor dem
Senden synchronisierte Anfragekennungen, niemals Enrollment-Tokens.
Unklare Rotationsergebnisse werden mit dem gleichen Command abgefragt; sie
lösen keinen zweiten Schlüsselwechsel aus. Ein vor dem Senden unterbrochener
Vorbereitungsschritt verwendet denselben bereits angelegten Ersatzschlüssel.
Der erfolgreiche APK-Build ist kein Nachweis für Handy–Server-Kommunikation,
Hintergrundbetrieb. Native Keystore-Ausführung und echte Handy–Server-Kopplung/
Authentifizierung über NetBird wurden am 2026-10-11 auf dem Gerät geprüft.
Eine Authentifizierung im kurzen App-Hintergrund ist ebenfalls bestanden;
Objektzugriff mit passender Overlay-Member-Rolle, Rotation und Wiederaufnahme
nach App-Neustart sind ebenfalls bestanden. Ein zehnminütiger Bildschirm-aus-/Hintergrundlauf und ein dreiminütiger
kontrollierter tiefer Doze-Test sind inzwischen bestanden, jeweils mit echten
Objektzugriffen. Die Tests belegen diese gemessenen Intervalle; vollständige
Erstkopplung über die sichtbaren Formulare und Kamera-QR bleiben separat.

## Installierter Betrieb auf big und vpsc

Das Register läuft auf `vpsc` unter
`/home/mux/.local/share/pi-spaces-recovery`; die Benutzer-Dienste
`pi-spaces-recovery-register.service` und `pi-spaces-recovery-register-tls.service`
sind aktiviert. `npm run build:operations` baut eigenständige `.mjs`-Artefakte
für den Register-/SSH-Betrieb ohne Anwendungsabhängigkeiten. Nur gebaute Artefakte
wurden übertragen. Der TLS-Zugang dient ausschließlich dem unabhängigen
administrativen Register außerhalb des Overlays; F3 bleibt ohne TLS/mTLS auf
Space-Port 7421. Es wird kein weiteres VPN benötigt.

`registerTls` enthält `host`, `port`, `caFile`, `certFile`, `keyFile` und optional
`serverName`/`timeoutMs`. CA-, Zertifikats- und Schlüsseldateien sind private,
reguläre Dateien; Servername/IP muss zum Zertifikat passen. Der Registerserver
lässt nur freigegebene Client-Zertifikats-Fingerprints zu. Reader haben kein CAS;
`writeKeys` beschränkt einen Dienst auf ausdrücklich genannte Registerschlüssel.
Unbeschränkte Operator-Zertifikate und der CA-Privatschlüssel gehören nicht in
normale Member-/Agenten-Konfigurationen. Auf big liegen ausschließlich Reader-
Zertifikat/Schlüssel in den normalen Laufzeiten.

Auf big laufen die beiden Benutzer-Dienste:

```sh
systemctl --user status pi-spaces-phase1b-host-a.service
systemctl --user status pi-spaces-phase1b-member-1.service
```

Ihre jeweiligen Container halten `/data/phase1b/harness.sqlite`, lokale
Installation, Konfiguration und eigenen Signer. Die echten Gate-Adressen sind
`100.89.128.128:7421` und `100.89.5.70:7421`. Die Registry-IDs und Key-Fingerprints
stehen in den öffentlichen [Nachweisen](../test/evidence/ap1b-2026-10-11/README.md).
Der Daemon `tools/federation-host.mjs` unterstützt `provision` (JSON auf stdin),
`bootstrap`, `enroll` (Token nur auf stdin), `run`, `stop`, `status`, `fence` und
`recovery`, `member-recovery` und `recovery-call`. `owner.lock` verhindert zwei Writer; `restart.lock` verweigert
Normalstart. Ein verwaister Owner-Lock wird nicht blind gelöscht.

`scripts/fence-docker-ssh.mjs` bindet Host, Unit, Container und Storage-Verzeichnis
in `authorized_keys`. Er prüft sowohl den tatsächlichen Node-Prozess im
Container als auch den gestoppten systemd-Dienst; ein verschwundener Docker-
Exec-Client allein gilt nicht als Fencing. `scripts/recovery-docker-ssh.mjs`
leitet nur den signierten privaten RPC zum festgelegten Container weiter.
Die lokalen SSH-Aliase `pi-spaces-fence-host-a`, `pi-spaces-fence-member-1` und
`pi-spaces-recovery-host-a` verwenden eigene Schlüssel mit Forced Commands.
`pi-spaces-register-reader` erreicht den read-only Registerzugang auf vpsc.

## Control-Restore unter exklusivem Recovery-Besitz

`startRecoveryOnly(host, ctx, privateConfigFile, assertQuiesced)` verlangt:
`hostId`, `path`, `installedRegisterFile`, `operatorKeyFile`,
`supervisorKeyFile`, `snapshotDirectory`, `fenceTargets` und genau einen
`registerTls`- oder `registerSshTarget`-Operatorzugang. Das Kontrollprogramm hält
bereits exklusiven Harness-Besitz; es startet weder Agenten noch ein normales
Gate. Der normale Dienst bleibt gestoppt und durch `restart.lock` gesperrt.
Bei Verwendung der SSH-F15-Prüfung muss die administrative Laufzeit einen
bereits vorhandenen SSH-Client und die fest provisionierten Ziele besitzen;
das unveränderte Node-slim-Testbed-Image hat keinen SSH-Client.

`restoreControlSpace` enthält Recovery-ID, stabile Control-Space-ID, private
Snapshot-Referenz, erwartete Authority/Inkarnation/Epoche, Zielhost und
`confirmedMembers` einschließlich des Ziels. Jeder Retry benutzt dieselben
Argumente. `advanceControlRestore` importiert begrenzt, installiert denselben
signierten Übergang lokal und verlangt passende unabhängige Member-ACKs.
`installAuthority` führt diesen Übergang auf jedem gestoppten Member durch.
`authorizeRecoveryKey` bestätigt die explizit gewählte **neue** App-Identität;
ein alter widerrufener Schlüssel wird darüber nicht wiederbelebt. Mindestens
ein neuer Admin mit Control-Scope ist nötig. Offline-Members bleiben sichtbar
und `recoveryBlocked`. Erst nach 62 Sekunden und gültigen ACKs wird die neue
Authority aktiv. Danach werden Control-Adresse/Host-ID/Signer ausdrücklich
neu provisioniert und die Normallaufzeiten administrativ freigegeben.
Ein ACK mit verlorenem Netz-Reply wird aus der lokalen Installation erneut
ins unabhängige Register geschrieben. Stale Snapshot-Marker öffnen keinen Boot.

Dieser Ablauf verwendet nur Single-Hosts; Sync-/Replikatkonfigurationen und
versiegelte Kandidaten verlangen den späteren Replikations-/Fencing-Pfad.
Die tatsächliche verteilte Data-/Control-Restore-Ausführung ist laut
[Abnahmestand](ap1b-abnahme.md) bestanden.


`startMemberRecoveryOnly(host, ctx, privateConfigFile, assertQuiesced)` benötigt
`hostId`, `path`, `installedRegisterFile`, den öffentlichen
`operator: { algorithm, publicKey }`-Pin und einen eng begrenzten `registerTls`-
Zugang. Private OP-/Control-Signierschlüssel werden nicht an Members verteilt.
Der Socket akzeptiert ausschließlich OP-signiertes `installAuthority`; Control-
Restore, Schlüsselautorisierung und beliebige Register-Commits sind gesperrt.
Normaler Gate-Start erfolgt erst nach installiertem Übergang, Entfernen der
administrativen Zugangsdaten und ausdrücklicher neuer Provisionierung.

`tools/recovery-data-host.mjs backup HOME [jobs|control]` sichert SQLite über die
Online-Backup-API und exportiert den Snapshot aus der Kopie; es öffnet keinen
zweiten Writer auf dem Live-Harness. `run` betreibt den administrativen privaten
Data-Recovery-Socket unter exklusivem Besitz; `inspect` prüft unter derselben
Neustartsperre lesbare, noch nicht freigegebene Restore-Objekte. Alle zusätzlichen
Restore-Testverzeichnisse sind in den Forced-Command-Werkzeugen ausdrücklich
zugelassen und jeder SSH-Schlüssel bleibt an einen festen Host/Container/Pfad
gebunden. Der administrative SSH-Client wurde nur in der separaten Recovery-
Laufzeit bereitgestellt. Normale Gate-Laufzeiten enthalten keine OP-TLS- oder
Fencing-Schlüssel.
