# Begrenzte NetBird-Ausfalltests auf big

Der administrative Testproxy verwendet ausschließlich eingebaute Node-Module und
bestehende TLS-Zertifikate auf big. Er verändert weder den produktiven nginx noch
dessen Port 443. Er lauscht auf Port 14443; die Fehlersteuerung ist nur auf
`127.0.0.1:19991` erreichbar. Zwei eigene Test-Peers (`host-b`, `member-2`)
leiten ausschließlich ausgehendes TCP zu `152.53.239.133:443` per markierter
NAT-Regel dorthin. Host-a, member-1, Handy und übrige VPN-Nutzer bleiben auf ihrem
normalen Pfad. Es wird kein zweites VPN eingesetzt.

Die Routen unterscheiden Management (HTTP-API/gRPC), Signal und Relay. Ein
Fehler schließt vorhandene Streams der betroffenen Komponente und verweigert
neue Requests; die anderen Komponenten bleiben weitergeleitet. HTTP/2-Trailer
und Relay-WebSocket-Upgrades müssen durchgereicht werden. Die Routentrennung
entspricht der [NetBird-Dokumentation](https://docs.netbird.io/selfhosted/external-reverse-proxy)
und wurde gegen die tatsächlichen Agenten 0.80.0 geprüft.

`fault-proxy.mjs CERT_FILE KEY_FILE` startet den administrativen Proxy. Auf big
läuft er als eigener zeitlich begrenzter Dienst `phi-spaces-fault-proxy.service`.
Zertifikatschlüssel werden weder kopiert noch protokolliert. Über
`POST /fault` mit `{"blocked":["management"]}` werden Komponenten gewählt;
eine leere Liste entfernt die Fehler. `GET /status` zeigt ausschließlich
Komponenten, aktive Stream-Anzahlen und Request-Zähler.

`run-fault-matrix.py --all` ist der auf big provisionierte administrative
Testtreiber. Er setzt einen gesunden Baseline-Objektzugriff voraus und führt
Management 5 min, Management 1 h, Signal 10 min, Relay 30 min und Management plus
Relay 1 h durch. Signal enthält nach 60 Sekunden einen Neustart nur des eigenen
host-b-Agenten, um einen frischen Tunnelaufbau zu prüfen. Jeder Lauf erfasst
reale Management-/Signal-/Relay-Zustände, P2P-/Relay-Verbindungstypen, tatsächliche
TCP-Verbindung und Objektzugriff gegen das zusätzliche restaurierte Data-Gate.
Nach jeder Fehlerphase muss der Objektzugriff wieder funktionieren.

Das Data-Gate auf member-2 verwendet den gleichen begrenzten Netzwerkpfad auch
für seine Management-API-Abfragen. Damit wird der echte Gate-Cache-Ablauf geprüft.
Der Testclient auf host-b besitzt einen separat eingeschriebenen App-Schlüssel
mit ausschließlich `jobs`-Scope; Dienstschlüssel werden nicht dafür umgewidmet.
Enrollment-Tokens stehen nur auf stdin; die vorübergehende Enrollment-Gruppe
wird anschließend wieder entfernt.

Die Python-Dateien werden auf big als private administrative Werkzeuge unter
`/home/mux/.local/share/phi-spaces-operations/` bereitgestellt. Der Treiber nutzt
nur die ausdrücklich festgelegten eigenen Testcontainer und Verzeichnisse.
Der Fortschritt steht atomar in `netbird-matrix-progress.json`; laufende Phasen
sind noch keine bestandenen Abnahmen. Der echte Desktop-/Relay-Zugriff wird
zusätzlich lokal protokolliert, ohne private App-Schlüssel auf big zu kopieren.

`fault-cleanup.py` entfernt ausschließlich die beiden markierten NAT-Regeln und
verbindet diese Test-Peers wieder zum ursprünglichen Endpunkt. Es läuft im
`finally` des Treibers und unabhängig als zeitgesteuerter Dienst. Der Proxy hat
eine maximale Laufzeit. Ein zusätzlicher lokaler Desktop-Monitor entfernt seine
eigene markierte Antwortregel nach Testende.

Die gezielte Nichterreichbarkeit der Komponenten für zwei Peers ist eine reale
Client-/Gate-Ausfallprüfung; sie prüft keinen globalen Serverabsturz oder dessen
Datenbank-Recovery. Eine echte Peer-Löschung und die zeitlich gemessene
Gruppenentziehung sind separate Fälle. Aus den gemessenen P2P-/Relay-Pfaden
werden Ergebnisse abgeleitet; die Hypothesen der Zielmatrix gelten nicht ohne
entsprechende Messwerte als bestätigt.
