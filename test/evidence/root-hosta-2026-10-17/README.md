# Nativer Root auf host-a mit repliziertem Member — 2026-10-17

Echter Lauf des Router-Pfads aus 5.3.1:

- Ein nativer Root auf dem Control-Host `phase1b-host-a` routet Schreibvorgänge an den replizierten Member
  `sync-member`, einen primary/sync-Space auf `nano-test` mit Standby `standby-100`.
- Nach Promotion und Degrade auf 100 übernimmt der Root die `ReplicaConfigNotice` aus dem Notice-Brett im
  Control Space.
- Danach gehen geroutete Schreibvorgänge an den neuen Primary.
- Anschließend wurde alles auf den Stand vor dem Lauf zurückgesetzt. Diese Rücksetzung war vorher so
  entschieden, weil sich eine Routing-Policy regulär nicht mehr entfernen lässt (siehe unten).

Die Daten stehen in `report.json`.

## Ablauf

1. **Schlüssel.** host-a war kurz zusätzlich in der leeren Gruppe `space-enroll` (Rolle `unpaired` am Gate) und
   blieb dabei in `space-hosts`; die Members verloren also keine Verbindung.
   - Router- und Host-Schlüssel entstanden im Container über den neuen sperrfreien Modus `enroll-key` und wurden
     mit `createEnroll` (Scope `*`) eingetragen. Die privaten Schlüssel haben host-a nie verlassen.
   - Danach war `space-enroll` wieder leer.
2. **Member.** Neuer Sync-Space `root-member` (`sp-8a6d5b1d-…`, Inkarnation `29982a8a`) auf nano-test und
   standby-100, mit `membership: sync-member`, eigener befristeter NetBird-Policy für Port 17432 und Boot-Permits.
   Beide Replikate standen bei Revision 1 mit demselben Hash.
3. **Root-Start.**
   - Konfiguration `root` in `federation.json`. Die Abnahme-Variable kam über ein systemd-Drop-in mit
     `docker exec -e`, weil die Unit selbst `docker exec` ist.
   - Die ersten beiden Starts scheiterten an zwei übersehenen Stellen aus 3.8 (siehe Fehler).
   - Der dritte Start lief.
4. **`addMember`** als Supervisor-Befehl des Admins: Phase `completed`, Policy-Version 1.
5. **Geroutete Schreibvorgänge.** Drei Schreibvorgänge über `root.space.write` landeten im Member (Einträge
   `e29982a8a-1…3`). Der geroutete Zähler ergab 3. Beide Replikate standen bei Revision 10 mit demselben Hash.
6. **Promotion von standby-100** mit netcup-Fencing (nanoi `SHUTOFF`), danach Degrade auf single: Epoche 3,
   Version 3.
7. **Übernahme.** standby-100 bot seine Notice an. Beim nächsten Abruf zeigte der Root für `sync-member` das Ziel
   `standby-100`, Epoche 3, `replication` mit Version 3 und `recoveryId: root-degrade`.
8. **Neue Richtung.** Drei weitere geroutete Schreibvorgänge (`e29982a8a-4…6`). Der Zähler ergab 6, also alle
   Einträge vor und nach der Umschaltung. Da nanoi ausgeschaltet war, konnten die neuen Einträge nur auf 100
   landen (Kopf dort bei Revision 20).

## Rücksetzung

- **host-a:** Der Stand nach 3.8 kam aus der Sicherung `/data/phase1b-backup-20261017-post38` zurück: Harness,
  `installed.sqlite`, Journal des Hauptstores und Konfiguration. Vorher wurden die WAL-Dateien entfernt, danach
  das Drop-in.
  - Der Boot-Datensatz ist unverändert (Version 10, single, Epoche 3, Version 5); der Root hat keine
    Replikat-Übergänge ausgelöst.
  - Im Control Space stehen wieder 13 Schlüssel, ohne Router- und Host-Schlüssel von host-a. Es gibt keine
    Routing-Policy.
- **nano-test und standby-100:**
  - nanoi in Quarantäne freigegeben (eingeschaltet), Daemon sofort gestoppt.
  - Konfigurationen aus `*.before-root-20261017`, Sync-Verzeichnisse beiseitegelegt
    (`sync-root.after-root-20261017`).
  - Die ursprünglichen Boot-Datensätze zurückgeschrieben; nano-test ist wieder `active` mit seinen beiden lokalen
    Spaces.
- **vpsc:** `tls.json` und `fencing.json` aus `*.before-root-20261017`. Damit sind die befristeten Rechte des
  Werkzeugzertifikats auf 100 wieder entfernt.
- **NetBird:** Die eigene Gruppe und Policy `root-hosta-20261017` sind gelöscht.
- **Grundprüfung danach:** vollständig grün.

Mit der Rücksetzung verloren gingen alle Control-Writes, die host-a im Zeitfenster bekam: die Enrollments, der
Member-Eintrag, die Admin-Befehle des Laufs und die harmlosen Schreibvorgänge der Grundprüfungen. Ob es in dieser
Zeit fremde Control-Writes gab, wurde nicht geprüft.

## Gefundene Fehler

Beide Fehler betreffen einen Control-Store auf primary/sync, dessen Space-Dokument die Epoche 1 behält, während
das Journal nach zwei Degrades bei 3 steht:

- **Journal-Wächter des Roots** (`federation-controller.ts`): Er verglich die Lease mit der Epoche des
  Space-Dokuments und brach den Start mit „RouterLease was superseded by Control“ ab. Behoben in `2be7885`.
- **Erneuerung der aufbewahrten Router-Lease** (`delegation.ts`): Nach einem Neustart prüfte sie die Signatur
  ebenfalls gegen das Space-Dokument und lehnte ab („lease renewal no longer owns current epoch“). Behoben in
  `f0a879a`.

Der 3.8-Test deckt jetzt beide Pfade ab und scheitert ohne die jeweilige Behebung.

## Ausfälle und Betriebsbefunde

- **Erster Fehlstart:** host-a war rund vier Minuten ohne Control. Beim manuellen Zurücksetzen traf `stop` einen
  noch startenden Prozess, der auf SIGTERM ohne Aufräumen endete. Die verwaiste `owner.lock` aus demselben Boot
  wurde nach Prüfung entfernt.
- **Zweiter Fehlstart:** Das Startskript setzte nach weniger als 30 Sekunden selbst zurück.
- **Langsames Stoppen:** Mit ausgeschaltetem nanoi brauchte der Root-Daemon länger als die 15 Sekunden von
  `stop`. Er endete danach selbst und entfernte seine Sperre. Ein `ExecStop`-Fehler bleibt bei `docker exec`
  ohne Folgen für den Prozess; deshalb prüft jeder Schritt danach die Prozesse.
- **Besitzrechte:** Die als root angelegten Konfigurationssicherungen auf nanoi und 100 brachten beim
  Zurückkopieren root als Besitzer mit. Die Folge waren EACCES beim Start und eine Sperre aus demselben Boot.
  Behoben durch `chown` und Entfernen der Sperre, nachdem geprüft war, dass kein Daemon läuft.

Nachtrag: Das langsame Stoppen und die Sperre nach einem Stopp während des Starts sind in `4d2eaac` behoben. Der
Root schließt zuerst seine Member-Verbindungen und wartet höchstens 5 Sekunden auf den Heartbeat. Der Daemon fängt
SIGTERM ab der Sperre ab, beendet sich nach dem Aufräumen explizit, und `stop` wartet 60 Sekunden. Das Bündel
`f372966a` läuft auf host-a, nano-test und standby-100.

## Grenzen

- Der Lauf deckt die Übernahme nach Promotion und Degrade ab, nicht nach `setStandby`.
- Die Delegation mit `targetReplicaConfigVersion` vor der Übernahme (`ReplicaConfigPending`) war nicht Teil der
  Messung.
- Für Control-Übergänge mit installierter Routing-Policy fehlt weiter Schritt 6.
