# Automatisierter primary/sync-Zyklus im Federation-Daemon — 2026-10-17

Dritter echter Lauf auf nanoi (`nano-test`) und Host 100 (`standby-100`), diesmal vollständig gesteuert durch den
Treiber `test/testbed/scenarios/phase3-daemon-cycle.ts`. Daemon-Bündel `b10c160b…`, Space `jobs-cycle`
(`sp-a5274943-…`, Inkarnation `bfcc180d`).

## Ergebnis (`report.json`, bestanden)

Der Treiber führte alle 17 Schritte ohne Handeingriff aus:

1. Vorabprüfung.
2. Fünf synchrone Schreibvorgänge.
3. Standby gestoppt.
4. Versiegelter Fork auf nanoi (Revision 8).
5. `promote` mit netcup-Fencing.
6. `degrade`.
7. Start des neuen Primary.
8. Drei Schreibvorgänge im Single-Betrieb.
9. Freigabe von nanoi in Quarantäne.
10. `wipe` der alten Historie.
11. Quarantäne-Start.
12. `set-standby`.
13. `readmitSpace` der übrigen Spaces.
14. Start des alten Primary als Standby.
15. Start des neuen Primary.
16. Drei Schreibvorgänge in der neuen Richtung.
17. Vergleich.

Ergebnis des Vergleichs:

- Beide Replikate haben 11 Proben, dieselbe Snapshot-Prüfsumme und denselben Journal-Kopf bei Revision 18.
- An Revision 8 steht auf 100 ein anderer Eintrag; der Fork liegt nur in der beiseitegelegten Historie von nanoi.

Die Kernphase vom Abschalten bis zum Vergleich dauerte rund vier Minuten.

Die verwaiste `owner.lock` nach dem harten Ausschalten hat der Daemon auf nanoi selbst entfernt, weil sie aus
einem früheren Boot stammte (`staleOwnerLockCleared`, `boot_id` in der Sperre). Eine Prüfung der PID durch den
Operator war nicht mehr nötig.

## Unterbrechungen

- **Lokale NetBird-Verbindung:** Der erste Start scheiterte an der Verbindung von lux27. Tailscale hatte die lokale
  Ausnahme in `ts-input` entfernt, und der lokale NetBird-Client hing. Nach dem Neustart des Clients und schmalen
  Ausnahmen nur für Antworten der drei Gates auf 7421 setzte der Treiber fort.
- **Fehler im Treiber:** Ein Lauf deckte zwei Fehler auf:
  - Das Heredoc hing an `grep` statt am Werkzeug.
  - `journalctl --since` wurde mit UTC gegen CEST-Hosts aufgerufen.

  Beides war folgenlos, denn die Prüfungen erkannten den ausgebliebenen Übergang. Behoben: Eingabe direkt an
  `docker exec`, Zeitmarken als Epoch-Sekunden des Zielhosts, Erfolgsprüfungen nach `promote` und `degrade`. Danach
  setzte der Treiber ab `promote` fort.

## Rückbau

- Boot-Einträge und Konfigurationen auf den Stand vor dem Lauf zurückgesetzt.
- NetBird-Policy und nft-Regel entfernt, Rechte des Steuerzertifikats entzogen.
- Danach klappte das Admin-Lesen auf beiden Hosts.

## Grenzen

- Schreibvorgänge mit Admin-Grants, nicht über Router-Delegationen. host-a hat keinen nativen Root, und die
  Router-Übernahme ist weiterhin nur lokal geprüft.
