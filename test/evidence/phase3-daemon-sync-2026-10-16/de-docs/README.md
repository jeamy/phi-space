# primary/sync im Federation-Daemon über echte Hosts — 2026-10-16

Zweiter echter Lauf. Anders als der [Fixture-Lauf](../../phase3-sync-2026-10-16/README.en.md) lief der Sync-Space diesmal
im produktiven Federation-Daemon (`federation-host.mjs`, Bündel `1cb5d7f1…`):

- **Hosts:** nanoi (`nano-test`, Primary) und Host 100 (`standby-100`, Standby).
- **Space:** `jobs-sync`, `sp-0bcf8f0d-…`, gemeinsame Inkarnation `67a91007`.
- **Speicher:** je ein eigener Store, provisioniert über `syncSpaces`.
- **Zugriff:** Clients schrieben über das Gate mit Schlüsselbeweis und Admin-Grant.
- **Übergänge:** liefen über den Werkzeugmodus `sync` des Daemons bei gestopptem Dienst.

## Ablauf (`report.json`, bestanden)

1. Neues Bündel auf beiden Hosts, normaler Neustart, Admin-Lesen geprüft. Danach `syncSpaces` provisioniert. 100
   startete zuerst als Standby, dann nanoi als Primary; die Anlage des Space wurde bereits synchron bestätigt
   (Revision 1 auf beiden).
2. Fünf Schreibvorgänge über das Gate von nanoi, jeweils von 100 bestätigt; beide Journal-Köpfe Revision 7.
3. Daemon auf 100 gestoppt. Der nächste Schreibvorgang wurde auf nanoi versiegelt (Revision 8, `3d50bed0…`,
   angewendet bis 7). Der Client erhielt „commit is durably sealed“.
4. Auf 100 `sync promote`: netcup-Fencing von nanoi (`SHUTOFF`, Autostart aus). Danach Primary `standby-100`,
   Epoche 2.
5. `sync degrade` mit erneutem Nachweis: Single-Betrieb mit Epoche 3. Daemon auf 100 gestartet, drei Schreibvorgänge
   über das Gate von 100; `hello` meldet Epoche 3 aus dem Journal.
6. Operator: `releaseHostToQuarantine` mit netcup-Adapter. Auf nanoi:
   - die verwaiste `owner.lock` nach PID-Prüfung entfernt;
   - die alte Sync-Historie mit dem Fork per `sync wipe` beiseitegelegt;
   - den Daemon gestartet. Er lief im neuen Quarantäne-Modus und hielt nur den Replikat-Listener bereit.
7. Auf 100 `sync set-standby`: nanoi lud die Kette nach und bestätigte den neuen Sync-Eintrag (Version 4). Der
   Quarantäne-Daemon auf nanoi erkannte `active` und beendete sich mit Hinweis. Danach:
   - Operator: `readmitSpace` für die beiden Federation-Spaces von nanoi;
   - normaler Start von nanoi: übernimmt die zugelassenen Berechtigungen und bedient den Sync-Space als Standby;
   - Start von 100.
8. Drei synchrone Schreibvorgänge in der neuen Richtung, über das Gate von 100 zu nanoi; beide Journal-Köpfe bei
   Revision 18.
9. Vergleich bei gestoppten Daemons nach Materialisierung: beide Replikate mit 11 Proben (5 + 3 + 3) und gleicher
   Snapshot-Prüfsumme `3a1c9678…`. An Revision 8 steht auf 100 `6e109ac6…`, in der beiseitegelegten Historie von
   nanoi der Fork `3d50bed0…`.

## Gefundene Fehler

Beide sind im Code behoben und durch Tests abgedeckt.

- **Verteilung umgangen:** Im echten Daemon gibt es einen vorgeschalteten Dienst für Hinweise (Delegation, Lauf-Gates).
  Dessen `handleText` umging die Verteilung, und Aufrufe an `jobs-sync` landeten im Haupt-Store („unknown space“).
  Behoben in `13039dc`; der Runtime-Test startet den Member jetzt mit diesem Dienst.
- **Lokale Berechtigung fehlte:** Vor dem Lauf fiel auf, dass niemand die lokale Boot-Berechtigung des Sync-Space
  installierte. `openSyncSpace` übernimmt sie seit `70b7bf6`.

## Rückbau (`report.json`, `cleanup`)

- Boot-Einträge beider Hosts auf ihre Werte vor dem Lauf zurückgesetzt; die Federation-Berechtigungen von nanoi
  sind aktiv.
- Konfigurationen aus `federation.json.before-sync-20261016` wiederhergestellt, also ohne `syncSpaces`.
- NetBird-Policy und nft-Laufzeitregel entfernt, Rechte des Steuerzertifikats in Register und Fencing-Dienst
  entzogen.
- Danach klappte das Admin-Lesen auf beiden Hosts.

Behalten:

- das neue Daemon-Bündel; die alten liegen als `federation-host.mjs.before-sync-20261016` daneben;
- die Sync-Stores samt beiseitegelegter Historie als Beleg.

## Grenzen

- **Kein Router:** host-a auf big läuft mit dem alten Bündel und weist `replicaNotice` ab; der Router hat die Notice
  daher nicht übernommen. Die Übernahme ist nur lokal geprüft.
- **Grants statt Delegationen:** Die Clients schrieben mit Admin-Grants, nicht über Router-Delegationen.
- **Manuelle Schritte:** Operator-Schritte (Freigabe, PID-Prüfung, `wipe`, `readmitSpace`, Neustarts) liefen von
  Hand, nicht automatisiert.
