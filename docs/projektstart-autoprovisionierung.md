# Projektstart am Handy: Spaces und Monitoring automatisch bereitstellen

Stand: 2026-10-07. **Ergänzender Zielvertrag**, nicht implementiert. Verbindliche Federation-Grundlage
ist [v3](federation-plan-v3.md); die [v2-Zusammenfassung](federation-plan-v2-summary.md) bleibt ein Archiv.
Architektur und manueller Bootstrap: [Betrieb und mobile Steuerung](betrieb-und-mobile-steuerung.md).

## 1. Gewünschte Bedienung

**Projekt auswählen → Starten → automatische Vorbereitung → Bereitschaft prüfen → Worker starten.**

Die Auswahl lädt die Projektkonfiguration und zeigt Hosts, Spaces, Modus und Ressourcenbedarf.
Erst Starten löst die Bereitstellung aus. Voraussetzung sind zuvor eingerichteter Host-Zugang und
autorisierte Installations-/Enrollment-Rechte. Danach muss der Benutzer nicht jeden Space einzeln installieren.

pi-spaces ist unsere TypeScript-Bibliothek. Sie läuft als Erweiterung im pi-durable-Harness
des jeweiligen pi-serverd. Logische Spaces sind persistente Dokumente mit stabilen IDs.

## 2. Was die vorhandene mobile Runtime bereits macht

Codebefund im Nachbarprojekt pi-termux-mobile:

- `runtime/server.mjs`: `remoteState.connect` ruft `ensureRemoteServer` vor dem Remote-Attach auf.
- `runtime/remote-provision.mjs`: prüft Node/npm, überträgt pi-serverd, common.mjs, pi-spaces.mjs und
  Paketdateien; bereitet Dependencies vor, startet den Daemon und prüft das Sessions-Protokoll.
- Runtime-Release wird vorbereitet, bevor der alte Daemon beendet wird; bei fehlgeschlagenem Start
  wird ein Rückwechsel zum vorherigen Release versucht. Das ist keine atomare Datenmigration.
- tmux wird gegebenenfalls installiert, andernfalls nohup verwendet. Node muss bereits in unterstützter
  Version vorhanden sein; es wird durch diesen Code nicht automatisch installiert.
- `runtime/pi-serverd.mjs`: öffnet den SQLite-Harness mit Spaces-Erweiterung und startet Reaper/Delivery.

Dies erfolgt heute beim **Remote-Verbinden**, nicht beim Start eines deklarativen Federation-Projekts.
Es gibt eine aktive Remote-Verbindung; keine Mehrhost-Provisionierung, benannten Projekt-Spaces,
Monitoring-Installation oder Bereitschaftsprüfung einer Federation. Ein erfolgreicher `sessions.list`
belegt nicht, dass der geplante Space-RPC und seine Garantien vorhanden sind.
Der Codebefund ist keine ausgeführte Remote-Installations- oder mobile E2E-Abnahme.

### 2.1 Voraussetzungen nach Rolle

NetBird und Node.js allein reichen nicht. Vor dem Start prüft der geplante Bootstrap folgende
Voraussetzungen; vorhandene passende Komponenten werden wiederverwendet.

| Ort | Voraussetzung | Warum / heutiger Stand |
|---|---|---|
| Jeder Remote-Host | unterstützte Linux-Umgebung, Node.js und npm | mobile Runtime verlangt laut package.json Node ≥ 22.19.0; tatsächliches freigegebenes Release prüfen |
| Jeder Remote-Host | funktionsfähiges `node:sqlite` | SQLite-Adapter verwendet Nodes DatabaseSync; Import und Schreibtest prüfen, nicht nur Versionsnummer |
| Jeder Remote-Host | OpenSSH-Server, autorisierter SSH-Zugang | erster Bootstrap und heutige Remote-Verbindung; späterer Space-RPC ersetzt nicht die erstmalige Provisionierung |
| Jeder Remote-Host | bash, tar mit gzip-Unterstützung, base64 und übliche Unix-Werkzeuge | bestehender SSH-Provisionierer verwendet diese Werkzeuge; Linux-Prozessprüfung benötigt /proc |
| Jeder Federation-Host | NetBird-Client, Enrollment und erreichbares Overlay | Installation allein genügt nicht; Peer-Zuordnung, Gruppen und ACLs prüfen |
| Jeder Remote-Host | freigegebenes Runtime-Release mit passenden npm-Dependencies und Spaces-Bundle | pi-durable, pi-server, pi-ai, chord und weitere Pakete gemäß Runtime-Lockfile; Bundle-Version gesondert prüfen |
| Jeder Remote-Host | privates, beschreibbares persistentes State-Verzeichnis | ein Storage-Besitzer; Platz für DB/Journal und Backups, korrekte Datei-/Socket-Rechte |
| Jeder Remote-Host | Host-/App-Identität und autorisierte Grants | v3 verlangt zusätzlich zur NetBird-Netzidentität App-Schlüssel und Rollen |
| Jeder Remote-Host | funktionierende Zeitsynchronisierung | Leases/Deadlines und spätere Replikation benötigen den vorgesehenen Zeitvertrag |
| Jeder Remote-Host | unabhängige Dienstausführung | heutiger Start über tmux oder nohup; Boot-Autostart und Neustartüberwachung zusätzlich vorsehen |
| Jeder Federation-Host | Space-RPC, Supervisor, Recovery, Reaper/Delivery und Host-Monitor | Teile vorhanden; Federation-/Monitoringdienste noch zu implementieren |
| Koordinator | Control Space, Router, Journal und Provisionierungszugänge | dauerhafte Fortsetzung nach Handy-Trennung; eigener geschützter Steuerzustand |
| Erstinstallation | erreichbare Paketquelle oder vorbereitetes Offline-Release | npm-/OS-Pakete müssen beschaffbar sein; für spätere Runs kein erneuter Download nötig |
| Native mobile Steuerung | mobile Runtime, SSH-Client/-Schlüssel und für v3 NetBird/App-Pairing | Android/Termux-Umgebung entsprechend freigegebenem mobilen Build; mehrfache Host-Verbindungen noch offen |
| NetBird-Infrastruktur | Management-, Signal- und Relay-Dienste, DNS/Domain und passende Netzfreigaben | self-hosted v3-Plan: eigene VM und Docker Compose; genaue Version/Ports folgen Gate 5 |
| Browserzugriff | HTTPS-Gateway, TLS-Zertifikat und Benutzer-/App-Anmeldung | nur für Browserweg; Browsergerät braucht nicht selbst Node.js oder SSH, Gateway braucht Overlay-Zugang |

NetBird ist für die geplante Overlay-Federation erforderlich. Das lokale Sieb und die heutige reine
SSH-Remote-Steuerung benötigen NetBird nicht. Bei einer vorhandenen NetBird-Installation wird die
Infrastruktur wiederverwendet; nicht jeder Worker-Host betreibt Management/Signal/Relay.

**Keine allgemeinen Pflichtinstallationen:** eigenständiger SQLite-Server, PostgreSQL/Redis,
Docker auf jedem Worker, Git, globales TypeScript oder Prometheus/Grafana. Der SQLite-Adapter verwendet
Nodes eingebaute SQLite-Anbindung. TypeScript wird für Entwicklung benötigt, Git bei Deployment aus Source;
für ein fertiges JS-Release nicht grundsätzlich. tmux ist im vorhandenen Provisionierer optional.
Docker Compose betrifft den geplanten self-hosted NetBird-Infrastrukturhost, nicht automatisch jeden Member.
Provider-Zugangsdaten sind nur für echte LLM-Agenten nötig; reine Sieb-Worker benötigen keine.

Installationsrechte für fehlende OS-Komponenten werden beim Host-Onboarding festgelegt; die normale
Worker-Runtime kann unter einem eigenen unprivilegierten Benutzer laufen. NetBird-Dienst/Netzaufbau und
Paketinstallation benötigen passende Systemrechte. Fehlende Rechte blockieren den Vorbereitungsschritt.
Ein einfacher Projektstart installiert Node/NetBird nicht schon heute automatisch.

Der Bootstrap prüft anschließend nicht nur installierte Pakete, sondern auch SSH-Zugang, SQLite-Schreibbarkeit,
Storage-Besitzer, Runtime-/Protokollfeatures, Overlay-Erreichbarkeit, App-Rechte und Monitoring-Heartbeat.
Erst dann gilt der Host als bereit. Genaue OS-/NetBird-Kompatibilität bleibt eine Integrationsabnahme.

## 3. Drei getrennte Zustände

| Zustand | Bedeutung | Lebensdauer |
|---|---|---|
| Host-Runtime bereit | passendes pi-serverd, pi-durable, Spaces-Bundle, Supervisor und Monitor vorhanden | wird von Projekten wiederverwendet |
| Projekt bereit | Spaces, Membership, Policy, Rechte und Monitoring diesem Projekt zugeordnet | bleibt nach Laufende erhalten |
| Rechenlauf aktiv | runId und konkrete Worker bearbeiten Aufgaben | unabhängig vom geöffneten Handy-Dashboard |

Starten prüft und ergänzt den gewünschten Zustand; es installiert nicht bei jedem Klick erneut.
Ein zweiter Start derselben Anfrage darf weder doppelte Spaces noch einen zweiten Rechenlauf erzeugen.
Ein bewusst neuer Lauf erhält eine neue runId. Zugriffe verschiedener Projekte werden nach dem
konfigurierten Rechtevertrag getrennt; ein ausdrücklich gemeinsam genutzter Space bleibt möglich.

### Vorhandene Runtime und Spaces wiederverwenden

Ein Space ist ein allgemeiner Bestand für typisierte Entries, keine Installation eines bestimmten
Algorithmus. Sieb, Recherche, Pipeline und andere Arbeitsarten können dieselbe Runtime und bei passenden
Regeln auch denselben Data Space benutzen. Neu sind dann Aufgaben und Workerbindungen, nicht der Space.
Ein Space ist normalerweise kein eigener Serverprozess, der pro Arbeitsart gestartet werden müsste.

Der Startauftrag löst die ausgewählten stabilen Space-IDs auf und prüft den tatsächlichen Zustand:

| Vorhandener Zustand | Verhalten beim Projektstart |
|---|---|
| Runtime und ausgewählter Space erreichbar und kompatibel | verbinden und wiederverwenden; kein zweiter Daemon, kein weiterer Space |
| Space persistent vorhanden, sein Host-Dienst gestoppt | denselben Dienst mit demselben Storage starten; vorhandenen Space öffnen |
| ausgewählter Space nachweislich nicht vorhanden | bei erlaubter Anlage einmal unter der vorgesehenen ID erzeugen |
| Host nicht erreichbar oder Zustand unbekannt | Start blockieren und Zustand auflösen; keinen Ersatz-Space unter neuer ID anlegen |
| bestehender Space hat unpassende Rechte, Modus, Schema oder Policy | konkreten Konflikt melden; keine stille Änderung oder Neuinstallation |

Die Wiederverwendung richtet sich nach **ausgewählten IDs und geprüften Rechten**, nicht nach dem ersten
zufällig gefundenen Space. Auf dem Handy kann ein Projekt bestehende Spaces/Federation auswählen und diese
Zuordnung speichern. Die gleiche Einstellung gilt beim Script-Bootstrap. Auch Enrollment, Member-Aufnahme,
Router und Host-Monitor werden bei passendem Zustand wiederverwendet.

In einem gemeinsam genutzten Space müssen Entry-Verträge und Typregeln zusammenpassen. Worker filtern
Aufgaben nach Arbeitsart und runId; bei gemeinsam genutzten projektbezogenen Typen zusätzlich nach
projectId. Solche Filter verhindern versehentliche Vermischung, ersetzen aber keine serverseitigen
Zugriffsrechte. Harte Isolation oder widersprüchliche Replikations-/Routingverträge können separate Spaces
erfordern. Task-Verarbeitung mit exklusivem Take benötigt expand/primary; ein LWW-Space eignet sich dafür nicht.

## 4. Projektkonfiguration

Folgendes JSON zeigt ein **vorgeschlagenes Schema**, keinen heute vorhandenen Parser. Release, Projekt-
und Config-Revision werden eingefroren, sobald ein Startauftrag angenommen ist. Zugangsdaten liegen
außerhalb der Datei; eine neue Revision verändert keinen laufenden Auftrag.

```json
{
  "schemaVersion": 1,
  "projectId": "prime-demo",
  "configRevision": 1,
  "runtimeRelease": "approved-space-runtime-1",
  "provisioning": { "reuseExisting": true, "createMissing": true },
  "coordinatorHost": "host-a",
  "hosts": [
    { "alias": "host-a", "ssh": "pi@vps-a" },
    { "alias": "host-b", "ssh": "pi@vps-b" }
  ],
  "federation": {
    "federationAlias": "prime-demo-fed",
    "controlSpace": "prime-demo-control",
    "mode": "expand",
    "members": [
      { "space": "prime-demo-a", "host": "host-a" },
      { "space": "prime-demo-b", "host": "host-b" }
    ],
    "routingProfile": "sieve-hrw-by-taskid"
  },
  "monitoring": { "enabled": true, "sampleIntervalMs": 2000 },
  "workload": {
    "kind": "sieve",
    "start": 1,
    "end": 1001,
    "blockSize": 128,
    "workersPerMember": 1,
    "partition": "hrw-by-taskId"
  }
}
```

Release-Namen und Aliase sind Beispiele. Hosts, Spaces und Federation stehen nur als Aliase in der Config;
`hostId` und `spaceId` werden nach v3 beim Anlegen erzeugt und serverseitig dem Alias zugeordnet.
Der Projektcontroller übersetzt das Routing-Profil in eine validierte Policy und ein Lauf-Manifest; der String
selbst ist kein zusätzlicher v3-Routingmodus. `sieve-hrw-by-taskid` bedeutet je eine expand-Regel nach `taskId`
mit derselben Member-Menge für SieveTask und SieveResult. Damit bindet jede `taskId` Task, Ergebnis und Txn an
denselben Member; das Manifest hält die berechnete Zuordnung fest. Gezielt angeheftete Teilbereiche
(`disjoint-ranges` je Member) sind eine Erweiterung außerhalb von v3
([Betrieb, Abschnitt 6](betrieb-und-mobile-steuerung.md#später-mehrere-task-spaces)).
Capability-/Kapazitätsauswahl darf nicht unabhängig Task und Ergebnis auf verschiedene Hosts verteilen.

## 5. Automatischer Startauftrag

| Schritt | Aktion | Voraussetzung für den nächsten Schritt |
|---|---|---|
| 1. Prüfen | Config, Benutzerrechte, Host-Zugang, Features, Release und Speicherbedarf prüfen | kein ungeklärter Konflikt mit bestehendem Zustand |
| 2. Koordinator sichern | Runtime auf A vorbereiten, Control/Supervisor erreichbar machen | dauerhafter Deployment-Auftrag auf A gespeichert |
| 3. Hosts vorbereiten | passendes Runtime-Release auf allen erforderlichen Hosts installieren oder wiederverwenden | authentifizierter Space-/Supervisor-Healthcheck erfolgreich |
| 4. Monitoring starten | Host-Sampler starten/wiederverwenden; projektbezogene Space-/Worker-Sichten aktivieren | frischer Status von jedem erforderlichen Host |
| 5. Spaces bereitstellen | ausgewählte IDs auflösen und bestehende Spaces prüfen/wiederverwenden; nur fehlende erlaubte Spaces anlegen | Rechte, Limits, Projektzugriff und Schema kompatibel |
| 6. Federation bereitstellen | bestehende Membership/Policy/Router prüfen und wiederverwenden; nur erforderliche zulässige Ergänzungen anwenden | alle benötigten Members erreichbar; Policy konsistent |
| 7. Lauf vorbereiten | runId und Teilbereichsmanifest speichern; Tasks je Member idempotent vorbereiten | jeder erforderliche Teilbereich bestätigt vorbereitet |
| 8. Worker aktivieren | registrierte Sieb-Worker mit festen Memberbindungen starten | Startgeneration und gewünschte Anzahl gespeichert |

Die Infrastruktur wird mit **einem dauerhaften Deployment-Auftrag** und separaten Unterrequest-IDs
gesteuert. Ein fachlicher Laufstart ist ebenfalls dedupliziert. Der Koordinator führt nach seiner
Bereitschaft die Schritte weiter; das Handy beobachtet und liefert keine dauerhafte Worker-Ausführung.

Vor Schritt 2 kann ein Verbindungsabbruch den ersten Bootstrap unterbrechen. Das Handy speichert
Auftrags-ID und Config-Hash und gleicht sie beim Wiederverbinden mit dem Host ab. Es darf keinen
zweiten Bootstrap unter neuer Identität starten, wenn der Ausgang des ersten unbekannt ist.
Nach Schritt 2 müssen Arbeitsauftrag, Fortschritt und Host-Antworten auf dem Koordinator dauerhaft sein.
Wie der Koordinator SSH-Provisionierungsrechte erhält, ist noch zu implementieren: entweder ausdrücklich
autorisierte Host-Zugänge oder vorinstallierte Bootstrap-Supervisoren. Handy-Schlüssel werden nicht
automatisch an den Koordinator kopiert. Ohne diesen Ausführungspfad gibt es keine autonome Fortsetzung.

Die Gesamtabfolge ist **kein verteilter atomarer Commit**. Jeder Host bestätigt seine eigene Wirkung.
Bei Teilfehlern bleiben bereits angelegte Spaces erhalten; der Controller zeigt den Zustand an und
setzt denselben Auftrag nach Fehlerbehebung fort. Unbekannte RPC-Ausgänge werden mit derselben
Unterrequest-ID aufgelöst. Ein Timeout allein rechtfertigt keinen erneuten Task-/Space-Start.

## 6. Bereitschaft, Updates und Fehler

Projektzustände: `checking → provisioning → configuring → preparing → ready → starting → running`.
`ready` bedeutet, dass Infrastruktur und Tasks bereit sind; es bedeutet nicht, dass Worker bereits laufen.
Fehlende Voraussetzungen führen zu `blocked`, ein bestätigter endgültiger Fehler zu `failed`.
Diese Projektzustände ersetzen nicht die v3-Zustände einzelner Commands.

Vor Workerstart müssen alle im Manifest erforderlichen Members, Rechte, Space-Features, Policy-Versionen,
Speicherbudgets und frischen Monitor-Heartbeats geprüft sein. Bei primary/sync muss zusätzlich der feste
Standby tatsächlich bestätigen können. Ein Ausfall erzeugt keinen stillen Wechsel zu expand oder async.
LWW/set sind für die exklusive Vergabe von Sieb-Tasks unzulässig.

Ein schon belegter Host wird nicht stillschweigend neu gestartet. Release- und Schemawechsel benötigen
einen kompatiblen Upgradepfad; konfliktbehaftete Updates warten auf ein vorgesehenes Wartungsfenster.
Provisionierungsaufträge verschiedener Projekte werden pro Host serialisiert. Ein Bundle-Rollback ist
nur zulässig, wenn der gespeicherte Zustand zum älteren Release kompatibel bleibt.

Nach Laufstart ist ein Monitor-Ausfall von Worker-/Member-Ausfall zu unterscheiden. Die Anzeige meldet
veraltete Daten; sie erklärt den Lauf nicht automatisch für beendet und löscht keine Aufgaben.
Eine unbekannte Member-Antwort bleibt unaufgelöst; vollständiger Erfolg erfordert alle erwarteten Ergebnisse.

## 7. Was automatisch überwacht wird

- **Host:** Erreichbarkeit, Runtime-Version, CPU, RAM, Disk und Commit-Latenz; zusätzlicher Sampler erforderlich.
- **Space:** Entries, Reservierungen, Txns, Waiter, Limits; vorhandene lokale stats/count als Grundlage.
- **Worker:** gewünschte/aktive Anzahl, gebundener Member, aktueller Task, letzter Fehler und Heartbeat.
- **Lauf:** erwartete taskIds je Teilbereich, committed Ergebnisse, Vollständigkeit und Ergebnisexport.
- **Federation:** Members, policyVersion, offene Commands/RPCs, gegebenenfalls Replikationslag.

Für den Einstieg genügt ein Monitor im Host-Runtime-Prozess; Prometheus/Grafana sind keine Voraussetzung.
Persistenter Lauf-/Deployment-Status bleibt von prozesslokalen Meter-Zählern getrennt. Host-Sampler und
Monitoring-Endpunkte sind noch zu implementieren. Sie verwenden Observer-Sichten mit Zeitstempeln;
internes Journal, Schlüssel und Enrollment-Tokens werden nicht an die UI ausgeliefert.
Die mobilen Statusabfragen pausieren bei geschlossener Seite, die serverseitigen Sampler laufen weiter.

## 8. Stoppen, Entfernen und Beispielabnahme

**Lauf stoppen:** keine neuen Claims, laufende Txns entscheiden/sauber abbrechen, Worker dieses Laufs stoppen.
Runtime, Monitor und gespeicherte Ergebnisse bleiben erhalten. **Projekt entfernen** ist eine separate Aktion
mit drain, Ergebnisaufbewahrung, Leerungsprüfung und removeMember. Ein gemeinsam genutzter Host-Daemon
wird dabei nicht pauschal beendet. **Handy trennen** beendet weder Lauf noch Monitoring.

Abnahme für prime-demo mit zwei Members:

1. Auf vorbereiteten Testhosts fehlt das Projekt: einmal Starten legt Infrastruktur an und liefert
   für [1,1001) genau die 168 Referenzprimzahlen; pro Task ein committed Ergebnis.
2. Derselbe Start wird nach verlorener Antwort wiederholt: keine doppelten Spaces, Worker oder Tasks.
3. Fehler auf B während Installation/Vorbereitung: A bleibt erhalten; kein Workerstart vor der Bereitschaft;
   Fortsetzen verwendet dieselben IDs und das gleiche Manifest.
4. Handy und später Koordinatorprozess werden unterbrochen: Auftrag wird nach Wiederaufnahme anhand
   persistierter Wirkungen fortgesetzt; keine Behauptung von Fortschritt ohne Ausführungsnachweis.
5. Worker stirbt nach Reservierung: Task kehrt nach Lease-Ablauf auf seinem Member zurück.
6. Monitor auf B fällt aus: UI zeigt veralteten Status; vorhandene Arbeit wird nicht als fehlgeschlagen gelöscht.
7. Ein anderes Projekt läuft auf A: Stoppen/Entfernen von prime-demo beendet dessen Worker oder Runtime nicht.

Diese Mehrhost-/Installationsfälle sind **noch nicht getestet**. Heutige Siebtests belegen lokale
Berechnung, Txn-Rollback, Lease-Ablauf und JSONL-Reopen. Für die automatische mobile Bereitstellung fehlen
Projektcontroller, benannte Spaces/RPC, Enrollment/Router, Supervisor-Aufträge, Host-Monitor und mobile Projektseite.
