# Primary/sync über echte Hosts: Fencing, Promotion, degradeToSingle, setStandby — 2026-10-16

Lauf von `test/testbed/scenarios/phase3-sync-run.ts --remote`, gesteuert von lux27:

- **Primary:** nanoi (netcup, nur IPv6), Host `nano-test`.
- **Standby:** Host 100 (Heimnetz, nur IPv4), Host `standby-100`.
- **Verbindung:** über NetBird mit Relay.

Je Host lief ein gebündelter Fixture-Knoten `phase3-sync-node.mjs` im vorhandenen Container, mit eigenem Journal
und Speicher; der Federation-Daemon blieb unberührt. Die Replikate sprachen über den signierten Transport
(`src/replica-transport.ts`, Host-Schlüssel, festgelegtes Gegenüber, Nonce und Zeitfenster) auf TCP 17432.

- **Boot-Berechtigungen:** im unabhängigen Register auf vpsc.
- **Fencing:** echter netcup-Power-off über den Fencing-Dienst auf vpsc.
- **Rechte:** Nur 100 hatte für den Lauf ein eigenes Zertifikat. Es durfte im Register `boot:nano-test` und
  `boot:standby-100` schreiben und am Fencing-Dienst abschalten. nanoi hatte nur sein Reader-Zertifikat. Ein Host,
  der gefenct werden kann, schreibt nie seinen eigenen Boot-Eintrag.

## Ergebnis (`report.json`, bestanden)

1. Fünf synchrone Schreibvorgänge von nanoi, jeweils von 100 bestätigt; beide Journal-Köpfe gleich.
2. Listener auf 100 gestoppt: Der sechste Schreibvorgang wird auf nanoi versiegelt (`CommitSealed`), nicht
   bestätigt (Fork, Revision 6, `61712a21…`).
3. nanoi-Knoten gestoppt; 100 fenct nanoi über netcup. Der Nachweis lautet `SHUTOFF`, Autostart aus,
   `restartLocked`; `verify` ist `true`.
4. `promote` auf 100: Primary `standby-100`, Epoche 2, nanoi als Standby eingetragen. An Revision 6 steht auf 100
   der Konfigurationseintrag (`9de2c771…`), nicht der Fork.
5. Ein Schreibvorgang auf 100 ohne erreichbaren Standby bleibt versiegelt (Revision 7).
6. `degradeToSingle` mit demselben Nachweis: Der Kandidat aus Revision 7 wird genau einmal abgeschlossen
   (`recoveredCommitted: [7]`), danach Single-Betrieb mit Epoche 3. Drei Schreibvorgänge im Single-Betrieb.
7. Operator: `releaseHostToQuarantine` mit netcup-Adapter. nanoi wird eingeschaltet, sein Boot-Zustand ist
   `quarantine`.
8. Auf nanoi wird die alte Sync-Historie mit dem Fork beiseitegelegt (`aside-…`); der Knoten startet leer. Dann
   `setStandby` von 100 aus: vollständiges Nachladen ab Revision 1 und Bestätigung des neuen Sync-Eintrags. Danach
   ist nanoi aktiver Standby (Version 4).
9. Drei synchrone Schreibvorgänge in der neuen Richtung, von 100 zu nanoi.
10. Beide materialisierten Stände sind identisch: 12 Einträge, gleiche Snapshot-Prüfsumme und gleicher
    Journal-Kopf bei Revision 15. Der Fork ist nicht enthalten.

Gesamtdauer etwa eine Minute; nanoi lief 16 s nach dem Einschalten wieder.

## Rückbau (`cleanup.json`)

- Beide Boot-Einträge sind auf ihre Werte vor dem Lauf zurückgesetzt (`fenceHostBoot` hatte auch die
  Federation-Berechtigungen von nanoi widerrufen).
- Auf nanoi wurde die verwaiste `owner.lock` nach PID-Prüfung entfernt und `pi-spaces-nano` gestartet.
- NetBird-Gruppe und -Policy für 17432 sind gelöscht, die nft-Laufzeitregel auf 100 ist entfernt.
- Die Rechte des Steuerzertifikats in Register und Fencing-Dienst sind entzogen.
- Danach klappte das Admin-Lesen auf beiden Hosts wieder.

## Grenzen

- Dieser Lauf verwendete noch eigene Dateninkarnationen je Replikat (`sync-nano-1`, `sync-100-1`, `sync-nano-2`).
  Seit dem Folgestand teilen beide Replikate eines Space genau eine Inkarnation, und die Übergänge setzen das
  durch.

- Fixture-Ebene: eigener Sync-Space neben dem Federation-Daemon, nicht der produktive Space-Dienst.
- Der Transport authentifiziert über festgelegte Host-Schlüssel, nicht über Gate und Grants.
- Für 100 gibt es keinen Fencing-Adapter. `degradeToSingle` auf nanoi mit 100 als ausgefallenem Standby ist
  deshalb nicht abnehmbar.
- Das Pausieren aller Schreibquellen inklusive Reaper ist nicht geprüft, ebenso der Control Space auf
  primary/sync (3.8).
