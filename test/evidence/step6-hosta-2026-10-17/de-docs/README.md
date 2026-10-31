# Schritt 6 echt: Control-Übergänge mit Routing-Policy auf host-a — 2026-10-17

Echter Lauf des Control-Sonderfalls aus v3 5.3.1 Schritt 6 mit dem Bündel `c04fd5b5` (Stand `3e817bb`). Auf
host-a liefen ein nativer Root und eine Routing-Policy. Der Control-Store machte `setStandby` und `degradeToSingle`
durch. Bisher hat `main-sync` das abgewiesen, sobald eine Policy installiert war. Danach wurde alles auf den Stand
vor dem Lauf zurückgesetzt. Die Daten stehen in `report.json`.

## Aufbau

- **Control-Standby:** neue Identität `control-standby-nano-2` als `replica-listen` auf nanoi, Boot-Eintrag in
  Quarantäne.
- **Rechte:** Steuerzertifikat für host-a mit befristeten Register- und Fencing-Rechten auf vpsc, dazu Fencing-Pin,
  ufw-Regel 17423 und eine eigene NetBird-Policy für 17433.
- **Root:** Router- und Host-Schlüssel per `enroll-key`; host-a war dafür kurz zusätzlich in `space-enroll`.
  Root-Konfiguration über das Startskript mit automatischem Zurücksetzen.
- **Member:** `step6-member` als Single-Sync-Space auf standby-100. Er bleibt erreichbar, wenn der Control-Degrade
  nanoi abschaltet.
- **Policy:** `addMember` legte sie mit Version 1 an. Ein gerouteter Schreibvorgang lief durch.

## Ergebnis

1. **`set-standby` mit Policy:** sync, Epoche 3, Version 6. Nach dem Neustart steht die Policy bei Version 2,
   die Erhöhung durch den Abgleich beim Start. Der geroutete Schreibvorgang lief durch.
2. **`degrade` mit Policy:** single, Epoche 4, Version 7, netcup-Nachweis `SHUTOFF` für nanoi.
3. **Root-Neustart nach Ablauf der Lease:**
   - Die aufbewahrte Lease (Epoche 3) lief um 11:37:56 UTC ab; host-a startete um 11:38:23. Damit zählte nur
     der signierte Erneuerungsweg.
   - Die Lease erneuerte sich mit derselben ID und Router-Epoche 1 in Control-Epoche 4. Genau das hat beim
     vorigen Root-Lauf ohne Schritt 6 den Start verhindert.
4. **Nach dem Degrade:** Policy-Version 3. Ein gerouteter Schreibvorgang lief durch, die geroutete Zählung ergab 3.
5. **Member:** Seine Epochen-Marke im Store des Member-Space stieg von Epoche 3/Policy 1 über Policy 2 auf
   Epoche 4/Policy 3. Auf host-a wurde kein Fehler beim Versand der `EpochNotice` protokolliert.
   - Ob die Marke aus der Notice oder aus der ersten Delegation der neuen Epoche stammt, ist im Store nicht zu
     unterscheiden.
6. **Stoppen:** Jeder Stopp von host-a mit Root endete in etwa 2 Sekunden ohne Restprozess. Beim Stoppen erscheint
   einmal „phi-spaces supervisor: Error: database is not open“: Der Supervisor-Takt läuft gegen den schon
   geschlossenen Store. Das ist harmlos und noch nicht behoben.

## Rücksetzung

- **host-a:**
  - Dateien aus der Sicherung vor dem Lauf zurück: Harness, `installed.sqlite`, Journal des Hauptstores,
    Konfiguration, `private/` und `pki/` ohne Steuerzertifikat. Das Drop-in ist entfernt.
  - Der Boot-Datensatz ist auf Epoche 3, Version 5 zurückgeschrieben (Register-Version 15).
  - Im Control Space stehen wieder 13 Schlüssel, ohne Root-Schlüssel; es gibt keine Policy.
  - Das neue Bündel bleibt.
- **standby-100:** Konfiguration zurück, Member-Space entfernt, Boot-Datensatz wiederhergestellt.
- **nanoi:** freigegeben (eingeschaltet). Unit und Verzeichnis des Control-Standbys sind entfernt.
  `boot:control-standby-nano-2` ist stillgelegt (`fenced`, ohne Permits).
- **vpsc und NetBird:** `tls.json` und `fencing.json` zurück, ufw-Regel entfernt, NetBird-Gruppe und -Policy
  gelöscht.
- **Grundprüfung danach:** grün. Danach wurden die Sicherungen entfernt.

Mit der Rücksetzung verloren gingen alle Control-Writes von host-a im Zeitfenster des Laufs: die Enrollments,
das Member, die Admin-Befehle und die Schreibvorgänge der Grundprüfungen. Ob es fremde Writes gab, wurde nicht
geprüft.
