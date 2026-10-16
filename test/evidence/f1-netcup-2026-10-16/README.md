# Echter Fencing-Lauf gegen nanoi über die netcup-SCP-API — 2026-10-16

Erster realer Lauf des netcup-Fencing-Adapters (`src/netcup-fencing.ts`). Der Fencing-Dienst lief auf vpsc
(`pi-spaces-fencing.service`); der Lauf wurde von lux27 aus mit dem Operator-Zertifikat gesteuert. Das Skript
liegt nicht im Repository; der Ablauf steht vollständig in `report.json`.

Ablauf und Ergebnis (`report.json`, Zeiten in UTC):

1. `boot:nano-test` Version 1, `active`, zwei aktive Space-Berechtigungen; Gate `100.89.28.88:7421` erreichbar.
2. `fenceHostBoot`: Host `fenced`, beide Berechtigungen `revoked`.
3. `fence` über den Dienst, 7,2 s: Autostart aus, harter Power-off, danach Server 964249 `SHUTOFF` mit
   `autostart: false`. Nachweis `kind: cloud`, `restartLocked: true`.
4. `verify`: `true`. Das Gate war während des Fencings nicht erreichbar.
5. `releaseHostToQuarantine` mit Adapter, 9,9 s: Boot-Zustand `quarantine` (Berechtigungen bleiben `revoked`),
   Autostart wiederhergestellt, Server eingeschaltet. `verify` danach `false`.
6. Der ursprüngliche Boot-Wert wurde per Operator-CAS wiederhergestellt (Version 4, `active`).

Befund: Nach dem harten Ausschalten blieb die Owner-Sperre `/data/nano/owner.lock` des Test-Daemons liegen. Wie
vorgesehen (`test/testbed/federation-host.ts`) startete der Daemon deshalb nicht von selbst. Der Operator prüfte,
dass der eingetragene Prozess (PID 8) im Container nicht mehr existierte, entfernte die Sperre und startete
`pi-spaces-nano`. Danach war der Dienst `ready`, und ein Admin las den Data Space über das Overlay. Das Gate blieb
deshalb rund sechs Minuten unerreichbar; das liegt nicht am Fencing.

Grenzen:

- Geprüft ist der Fencing-Baustein (F1): Abschalten, Nachweis, Prüfung, Freigabe in Quarantäne.
- Keine Promotion und kein degradeToSingle mit echten Primary-/Standby-Daten.
- Der Standby-Platz ist noch nicht festgelegt.
- Phase 3 ist damit nicht abgenommen.
