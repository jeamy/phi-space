# Promotion des Control-Replikats mit nativem Root — 2026-10-17

Echter Lauf des Router-Wechsels (v3 5.2) bei einer Control-Promotion, in beide Richtungen:

- host-a → host-c → host-a, unter derselben Autorität, mit Container-Fencing auf big.
- Auf host-a lief ein nativer Root mit Routing-Policy und dem replizierten Member `promo-member`, einem
  Single-Sync-Space auf standby-100.
- Der Root zog jeweils auf den neuen Control-Host um, die Members folgten im laufenden Betrieb.
- Danach wurde host-a wie vereinbart zurückgesetzt.

Die Daten stehen in `report.json`.

## Vorbedingungen

- **Bündel:** Ein einziges Bündel (`0f64da41`) lief auf host-a, host-c und allen vier Members; die Prüfsummen
  wurden vor dem ersten Übergang verglichen.
- **Neustartrichtlinie:** nano-test und standby-100 hatten `Restart=no`. Ein Drop-in setzt dort `Restart=on-failure`;
  es bleibt, weil das Folgen im laufenden Betrieb darauf angewiesen ist. member-1 und restore-target warten beim
  Stoppen jetzt 75 Sekunden.
- **Fencing-Dienst:** Von beiden Containern aus mit einer wirkungslosen `verify`-Anfrage geprüft.
- **Root-Schlüssel:** Router- und Host-Schlüssel für host-a und host-c, beide bei host-a enrollt. host-c nutzte
  dafür `enroll-key` mit Ziel host-a.
- **Root-Konfiguration auf host-c:** derselbe Root-Block wie auf host-a (ID, Members), nur mit eigenen
  Schlüssel- und Lease-Dateien und `takeover`.

## Ergebnis

1. **Root auf host-a:** `addMember` (Policy-Version 1), dann drei geroutete Schreibvorgänge, der letzte im
   Sync-Betrieb mit host-c als Standby.
2. **Promotion auf host-c:** Fencing von host-a, `degrade` auf single (Epoche 9). Danach wurde der Wechsel
   aufgezeichnet.
3. **Root-Übernahme auf host-c:** host-c startete um 14:18:12 UTC; der Root wartete, bis die Lease von host-a
   abgelaufen war, und war um 14:18:34 bereit. Seine Lease: Router-Epoche 2 mit eigenem Router-Schlüssel,
   Control-Epoche 9.
4. **Members folgten im laufenden Betrieb:** Alle vier meldeten `controlHostChanged`, endeten mit Code 75,
   wurden von systemd neu gestartet und waren bereit, ohne Eingriff von außen.
5. **Root auf host-c arbeitet:**
   - Die gerouteten Schreibvorgänge setzten die Einträge fort (`e0687995b-4` …), die Zählung ergab 5.
   - Die `EpochNotice` kam beim Member an (Router-Epoche 2, Control-Epoche 9, Policy 3); vorher scheiterten zwei
     Versuche, weil standby-100 gerade neu startete.
   - Die Epochen-Marke des Members zeigt dieselben Werte.
6. **Rückweg:**
   - Freigabe von host-a, `wipe`, `set-standby` host-c → host-a, Promotion auf host-a mit Fencing von host-c,
     `degrade` (Epoche 11).
   - host-a übernahm seine überholte Root-Lease nach Ablauf der Lease von host-c (14:24:35, bereit 14:24:46) mit
     Router-Epoche 3.
   - Die Members folgten wieder von selbst. Ein gerouteter Schreibvorgang über host-a ergab Eintrag 7, die
     Zählung 7. Die `EpochNotice` kam mit Router-Epoche 3 an.

## Rücksetzung

- **host-a:** Die Dateien kamen aus der Sicherung zurück, die nach dem Verteilen des Bündels angelegt wurde; der
  Boot-Datensatz ist auf Epoche 7, Version 11 zurückgeschrieben. Im Control Space stehen 13 Schlüssel, es gibt
  keinen Root und keine Policy.
- **standby-100:** Konfiguration zurück, Member-Space entfernt, Boot-Datensatz wiederhergestellt.
- **host-c:** Container, Volumes, Unit und NetBird-Peer sind entfernt; der Boot-Eintrag ist stillgelegt.
- **vpsc und NetBird:** Rechte und Policy zurückgesetzt bzw. entfernt.
- Sicherungen und Hilfsdateien sind gelöscht.
- Der Autoritäts-Eintrag behält die beiden Host-Wechsel dieses Laufs als Historie.

## Grenzen

- Beide Control-Hosts liefen auf big und lagen damit in derselben Ausfalldomäne.
- Bereits zugelassene Root-Operationen, die über einen Wechsel hinweg offen waren, gab es in diesem Lauf nicht;
  geprüft sind neue Operationen vor und nach jedem Wechsel.
