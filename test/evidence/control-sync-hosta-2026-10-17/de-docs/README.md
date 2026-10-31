# Control-Store von host-a auf primary/sync — 2026-10-17

Erster echter Lauf von 3.8: Der bestehende Hauptstore von `phase1b-host-a` mit dem Control Space
(`sp-75fb6996-…`) und dem Geschwister-Space `default` (`sp-a1eadc94-…`) wurde per Bootstrap auf primary/sync
gestellt. Danach durchlief er zweimal den Zyklus `setStandby` → `degradeToSingle` mit dem Standby
`control-standby-nano`, einer `replica-listen`-Einheit auf nanoi. Am Ende läuft host-a wieder `single`.
Die Daten stehen in `report.json`.

## Ablauf

| Schritt | Ergebnis |
|---|---|
| Sicherung | Store, Konfiguration, Bündel und Signer im Container (`/data/phase1b-backup-20261017`), Unit-Datei auf big |
| `main-sync bootstrap` | Revision 1; die Store-Prüfsumme nach dem letzten Chunk stimmt |
| `set-standby` `control-standby-1` | sync, Epoche 1, Version 2; Standby-Kopf auf nanoi bei Revision 8 (`0e982e25…`) |
| `degrade` `control-degrade-1` | single, Epoche 2, Version 3; netcup-Nachweis `SHUTOFF` für Server 964249 |
| Freigabe `control-release-1` | Boot-Datensatz von `control-standby-nano` in `quarantine`, Permit `revoked/standby`; nanoi läuft wieder |
| Standby geleert | alte Replik nach `replica.after-degrade-1` verschoben; Listener startet mit Revision 0 |
| `set-standby` `control-standby-2` | sync, Epoche 2, Version 4; Standby-Kopf nach dem Degrade bei Revision 16 (`50fc0708…`) |
| `degrade` `control-degrade-2` | single, Epoche 3, Version 5; erneut `SHUTOFF` |
| Freigabe `control-release-2` | nanoi wieder in Quarantäne und gestartet; die Einheit `phi-spaces-control-standby` bleibt deaktiviert |

Vor und nach jedem Übergang lief eine Grundprüfung: Admin-Lesen und ein harmloser Schreibvorgang im Control
Space, dazu `info`/`stats` an jedem Member-Gate.

- Alle Prüfungen bestanden, mit einer Ausnahme: Nach einem Degrade ist `nano-test` nicht erreichbar, solange
  nanoi ausgeschaltet ist. Das ist erwartet.
- Unmittelbar nach dem zweiten Wiederanlauf von nanoi lief eine Prüfung noch einmal in eine Zeitüberschreitung,
  weil die NetBird-Relay-Verbindung noch nicht stand. Der Lauf eine Minute später war vollständig grün
  (`baseline-6-final`).

Die Boot-Datensätze am Ende stehen in `bootRecordsFinal`:

- host-a ist für beide Spaces `active/primary/single` mit Epoche 3 und Version 5 (`control-degrade-2`).
- `control-standby-nano` steht in `quarantine`; sein Permit ist widerrufen.

## Vorfall: Daemon endete nicht nach SIGTERM

Beim Stoppen vor `control-standby-2` liefen im Container zwei `run`-Prozesse. Ursache:

1. Der Daemon aus dem ersten Sync-Betrieb (Neustart nach `control-standby-1`) hatte auf SIGTERM seinen Harness
   geschlossen und `owner.lock` entfernt.
2. Er blieb aber am Leben, weil Standby-Transport, Journal und Register-Client des Hauptstores offen blieben.
   Das `ExecStop` vor `control-degrade-1` scheiterte deshalb unbemerkt; systemd beendete nur den
   `docker exec`-Client.
3. `control-degrade-1` und die Grundprüfung danach liefen also mit diesem verwaisten Prozess. Er hatte seinen
   Harness bereits geschlossen, Journal und Transport aber noch offen.
4. Der nächste Start bekam die Sperre, und `stop` verweigerte danach zu Recht die Arbeit („ownership disagrees“).

Behebung:

- Den hängenden Prozess (Harness bereits geschlossen) hat der Operator beendet; den aktuellen Prozess hat `stop`
  regulär beendet.
- `federation-host` schließt diese Handles jetzt in `cleanup`. Bündel `74f3f071…` ist auf host-a eingespielt.
- Nach `control-standby-2` endete der Daemon im Sync-Betrieb ohne Restprozess.

## Grenzen

- Die Promotion des Control-Replikats und Schritt 6 (Übergänge, sobald eine Routing-Policy existiert) sind nicht
  umgesetzt. `main-sync` lehnt beides ab.
- Der Standby auf nanoi diente nur der Abnahme; host-a bleibt dauerhaft `single`.
