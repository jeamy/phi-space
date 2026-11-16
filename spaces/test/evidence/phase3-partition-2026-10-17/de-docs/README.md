# Gesamtbetrieb 3.7: Partition, Prozessabbrüche und Failover über den produktiven Dienst — 2026-10-17

Echter Lauf auf nanoi (`nano-test`, Primary) und Host 100 (`standby-100`, Standby) mit dem Treiber
`test/testbed/scenarios/phase3-partition.ts`. Die Daten stehen in `report.json`.

- **Space:** `jobs-part` (`sp-233186d7-…`), primary/sync, je ein eigener Store.
- **Clients:** schrieben über das Gate mit Schlüsselbeweis und Admin-Grant von host-a.
- **Schreibvorgänge:** alle 2 Sekunden einer, jeder mit eigener Nummer und Request-ID. Ein unklarer Ausgang
  (`CommitSealed`, Zeitüberschreitung, Verbindungsabbruch) wurde mit derselben ID wiederholt, bis er entschieden war.
- **Bündel:** zuerst `ef99a5fb` (Stand `523831b`), ab `partition-bounded` `88842c99` (Stand `f96a7f7`).

## Ergebnis (bestanden)

| Phase | Schreibvorgänge | sofort bestätigt | nach Klärung | `CommitSealed`-Antworten | längste offene Zeit |
|---|---|---|---|---|---|
| Partition 60 s | 11 | 10 | 1 | 1 | 77 s |
| Partition 10 min | 30 | 29 | 1 | 122 | 602 s |
| Partition 3 min, begrenzte Wartezeit | 10 | 9 | 1 | 73 | 205 s |
| Standby per SIGKILL beendet | 36 | 35 | 1 | 2 | 11 s |
| Primary per SIGKILL beendet | 29 | 28 | 1 | 0 | 13 s |

- **Ohne Verlust:** Nach jeder Phase stand jeder entschiedene Schreibvorgang genau einmal im Space, insgesamt 116,
  und die Journal-Köpfe beider Replikate waren gleich.
- **Partition:** Eine nft-Regel auf 100 verwarf alles von nanos Overlay-Adresse. Andere Spaces von nanoi blieben
  benutzbar, Lese- und Zählaufrufe auf `jobs-part` antworteten `CommitSealed`. Nach dem Heilen klärte nanoi den
  versiegelten Kandidaten selbst und bediente den Space ohne Neustart wieder.
- **Prozessabbrüche:**
  - Der Daemon wurde per SIGKILL beendet; der Operatorschritt entfernte die Sperre `owner.lock`, nachdem der Prozess
    weg war; systemd startete neu.
  - Beim Standby wurde der offene Schreibvorgang nach seinem Neustart bestätigt.
  - Beim Primary bekam der Client währenddessen `ECONNREFUSED` und erhielt nach dem Neustart das eine Ergebnis.
- **Failover mit `NotCommitted`:**
  1. Frische Generation, dann Standby gestoppt.
  2. Ein Schreibvorgang wurde nur auf nanoi versiegelt (Revision 120).
  3. `promote` mit netcup-Fencing (`SHUTOFF`), danach `degrade` (Epoche 3).
  4. Auf 100 beantwortete `resolveOperation` den Request mit `NotCommitted`; der verspätete Originalaufruf bekam
     ebenfalls `NotCommitted`. Der Eintrag erschien auf keinem Replikat.
- **Rückweg:** Freigabe in Quarantäne, `wipe`, `set-standby`, `readmitSpace`, Neustarts.
  - Danach sind beide materialisierten Replikate gleich: 116 Einträge, gleiche Snapshot-Prüfsumme, Kopf 123.
  - Der Fork steht nur in der beiseitegelegten Historie von nanoi.

## Gefundener Fehler

- **Unbegrenztes Warten auf den Standby:** In den ersten beiden Partitionen wartete der Primary auf die Antwort des
  Standby, solange die abgeschnittene TCP-Verbindung bestand.
  - Lesen ging weiter, Schreibvorgänge hingen aber minutenlang, bevor `CommitSealed` kam.
  - Behoben in `f96a7f7`: `socketTransport` hat jetzt eine Antwortfrist (`requestTimeoutMs`), der Replikat-Peer
    wartet 15 Sekunden.
  - Die dritte Partition zeigt das Ergebnis: Rund 19 Sekunden nach dem Schnitt antworteten Lesezugriffe bereits
    `CommitSealed`; 30 Sekunden nach dem Heilen war der Schreibvorgang geklärt.

## Vorfälle

- **`kill` im Treiber:** Der erste Versuch des Standby-Abbruchs rief `docker exec … kill` auf; im Image ist `kill`
  aber nur ein Shell-Befehl. Behoben über `sh -c`, Schritt wiederholt.
- **Absturz von `set-standby`:** Der erste Versuch brach im Sync-Werkzeug mit einer unbehandelten Ausnahme ab. Die
  Ursache ging verloren, weil der Treiber nur die letzte Ausgabezeile behielt.
  - Die Fortsetzung mit derselben Übergangs-ID von Hand gelang; nanoi verließ die Quarantäne.
  - Der Treiber behält die Ausgabe des Werkzeugs jetzt vollständig.

## Rückbau

- Boot-Einträge auf den Stand vor dem Lauf zurückgesetzt.
- Konfigurationen ohne `syncSpaces` wiederhergestellt.
- nft-Regeln und NetBird-Policy entfernt.
- Rechte des Steuerzertifikats auf vpsc entzogen und das Zertifikat auf 100 gelöscht.
- Die Grundprüfung danach war grün.
- **Behalten:** das Bündel `88842c99` (Sicherungen `*.before-part-20261017`) und die Sync-Stores als Beleg.

## Grenzen

- **Keine Router-Delegation:** Die Schreibvorgänge liefen mit Admin-Grants.
- **Degrade mit Fencing-Adapter:** `degrade` lief mit netcup-Fencing; der Weg ohne Adapter (`revokeStandbySpace`) kann
  das Sync-Werkzeug noch nicht.
- **Prozessabbruch mit Operatorschritt:** Die Sperre `owner.lock` desselben Boots entfernte der Treiber nach der
  PID-Prüfung, nicht der Daemon.
- **Nicht geprüft:** Ausfall eines NetBird-Agenten und erschöpfter Speicher.
