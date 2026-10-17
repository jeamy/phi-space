# Promotion des Control-Replikats auf big — 2026-10-17

Erster echter Lauf der Promotion des Control Space in beide Richtungen. Die Autorität blieb dieselbe; nur der
Control-Host wechselte von `phase1b-host-a` auf den vorübergehenden Host `phase1b-host-c` und wieder zurück. Beide
liefen als Container auf big mit eigenem NetBird-Agenten und wurden per Container-Fencing gesperrt. Die Daten stehen
in `report.json`.

## Aufbau

- **host-c:** eigener Container mit NetBird-Sidecar (Gruppe `space-hosts`), eigener Supervisor-Schlüssel,
  `mainSync` mit derselben Genesis wie host-a. Als Replikat betreibt `run` nur Journal und Listener.
- **Container-Fencing:** `ContainerFencing` hinter `serveFencing` auf big, gepinnt auf die Container und Units von
  host-a und host-c. Sperre heißt: Container gestoppt, Neustartrichtlinie `no` und ein Drop-in, das die Unit am
  Start hindert. Der Dienst lauscht an der öffentlichen Adresse von big und verwirft jede andere Quelladresse vor
  dem TLS-Handshake.
- **Rechte und Netz:** Steuerzertifikate für beide Hosts mit befristeten Register-Rechten auf vpsc und eine eigene
  NetBird-Policy für den Replikat-Port.
- **Members:** member-1, restore-target, nano-test und standby-100 pinnen den Recovery-Admin-Schlüssel und laufen
  mit dem neuen Bündel.

## Ablauf

1. **Hinweg:**
   - `set-standby` host-a → host-c (sync, Epoche 3, Version 6). Ein Control-Write wurde von host-c bestätigt.
   - `promote` auf host-c sperrte host-a per Container-Fencing: Container gestoppt, Neustartrichtlinie `no`,
     Unit gesperrt. Danach `degrade` auf single (Epoche 5, Version 8).
   - Der Recovery-Admin zeichnete den Wechsel auf; das Register nennt jetzt host-c mit dessen Schlüssel.
   - host-c startete als Control-Host. Die vier Members folgten beim Neustart, und die Grundprüfung gegen host-c
     war grün.
2. **Rückweg:**
   - host-a wurde in Quarantäne freigegeben und legte seine Historie mit `wipe` beiseite; danach lief es als
     leerer Listener.
   - `set-standby` host-c → host-a (Epoche 5, Version 9).
   - `promote` auf host-a sperrte host-c per Container-Fencing; danach `degrade` (Epoche 7, Version 11).
   - Der zweite Wechsel wurde aufgezeichnet, host-a startete als Control-Host, und die Members folgten zurück.
     Die Grundprüfung war grün.

**Endstand:** host-a ist wieder Control-Host mit Boot-Version 26, aktiv, Primary, single, Epoche 7, Version 11.
Der Autoritäts-Eintrag behält beide Wechsel als Historie.

## Vorfälle

- **Fencing-Dienst über das Overlay nicht erreichbar:** Die Host-Firewall von big blockte den Port; ohne root ist
  sie nicht zu ändern.
  - Der Dienst zog auf die öffentliche Adresse um, mit einer Sperrliste für Quelladressen (`5c6b9a0`).
  - In der Zwischenzeit war host-c gestoppt, während host-a im Sync-Betrieb auf ihn wartete. Control-Writes
    standen deshalb von 12:37:51 bis 12:47:30 UTC.
- **Fehlende Berechtigung für den Standard-Space:** Das `set-standby` auf host-c lief noch mit dem älteren
  Bündel von host-a, also vor der Behebung `be44076`. host-c bekam keine Berechtigung für den Standard-Space, und
  die Promotion hielt nach dem Fencing von host-a an.
  - Der Betreiber trug die Standby-Berechtigung im Register nach, genau so, wie das behobene `set-standby` sie
    schreibt (Inkarnation `a0281666`).
- **Werkzeug sperrte den eigenen Host:** Beim Fortsetzen der Promotion nahm `main-sync` das Fencing-Ziel aus dem
  aktuellen Primary des Journals; das war schon host-c, also sperrte es sich selbst.
  - host-c wurde von Hand entsperrt, ohne seine Unit zu starten.
  - Das Werkzeug sperrt jetzt das jeweils andere Replikat und verweigert den eigenen Host (`8a3fbb7`).
- **Members mit altem Bündel:** Beim ersten Neustart liefen die Members noch mit Bündeln ohne Host-Wechsel und
  blieben mit `BootBlocked` stehen. Mit dem neuen Bündel folgten sie.
- **Control-Ausfall:**
  - Hinweg: von 12:47:33 UTC (host-a gesperrt) bis etwa 12:51:30 UTC (Members bereit).
  - Rückweg: von 12:55:18 bis etwa 12:56:40 UTC.

## Rückbau

- **host-c:** Container, Volumes, Unit und NetBird-Peer sind entfernt; `boot:phase1b-host-c` ist stillgelegt
  (`fenced`, ohne Berechtigungen).
- **Fencing-Dienst und Netz:** Fencing-Dienst samt Schlüssel und die eigene NetBird-Policy sind entfernt; auf vpsc
  ist `tls.json` zurückgesetzt.
- **host-a:** Steuerzertifikat, Sicherung und beiseitegelegte Historie sind entfernt. Die Unit von host-a wartet
  beim Stoppen jetzt 75 statt 25 Sekunden, länger als die 60 Sekunden von `stop`.
- **Bleibt:**
  - Die Members behalten das neue Bündel und den gepinnten Recovery-Admin-Schlüssel.
  - Die Konfiguration von host-a behält `mainSync.incarnation`, `recoveryAdmin` und host-c als letzten
    Replikat-Peer.

## Grenzen

- Ohne Root: Ein Root zieht bei der Promotion noch nicht mit.
- Die Members folgen erst beim Neustart; das Neustarten war geskriptet.
- Beide Hosts liefen auf big und lagen damit in derselben Ausfalldomäne.
