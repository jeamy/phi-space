# Stromausfalltests fuer Agentenspeicher

## Stand und Nachweisgrenze

Die Integration verwendet SQLite WAL mit `synchronous=FULL` sowie JSONL mit synchronisierten
Sidecars, Commit-Markern und Verzeichniseintraegen. Siehe [Speicheradapter](../agent/src/storage.ts).
Das gilt auch fuer den mobilen Harness; der Space behaelt seinen eigenen Speicher.

**Ein echter Stromausfallversuch wurde noch nicht ausgefuehrt.** FULL/fsync ist eine Schreibpolitik,
kein Hardware-Zertifikat. Datentraeger und Dateisystem muessen Flushes korrekt umsetzen.
Auch ein bestandener endlicher Test beweist nicht alle moeglichen Schreibunterbrechungen.

Die [lokalen Regressionen](../agent/test/storage.test.ts) pruefen:

- WAL/FULL auf jeder neu geoeffneten SQLite-Verbindung, nicht nur beim ersten Start.
- JSONL: Sidecars vor Marker, Marker-Flush und Namespace-Barriere vor Bestaetigung.
- Wiederherstellung eines Dokuments aus ausschliesslich geflushten Dateiinhalten in einem vereinfachten
  Cache-Verlust-Modell; das modelliert weder Sektor-Torn-Writes noch ein bestimmtes Dateisystem.
- Verweigerte Bestaetigung und vergifteten JSONL-Speicher nach einem fehlgeschlagenen Marker-Flush.
- Den Gegenfall aus pi-durable 1.4.0: `{ fsync: true }` alleine flusht einen reinen Marker-Commit nicht.

Die [Probe-Selbsttests](../agent/test/power-loss-probe.test.ts) beenden ihren eigenen Writer mit SIGKILL.
Das prueft Writer, extern beobachtete Bestaetigungen und Verifier, aber **keinen Stromverlust**.

## Warum ein Adapter notwendig ist

Die veroeffentlichte Node-SQLite-Anbindung setzt `NORMAL` und bietet keinen Sync-Parameter.
Unser Adapter stellt die Verbindung vor der Schemaoeffnung auf `FULL`, prueft den Wert und bricht bei
einem Fehler ab. Er waehlt niemals stillschweigend das schwaechere Profil.

JSONL `{ fsync: true }` synchronisiert in Version 1.4.0 die Sidecars. `main.jsonl` wird beim normalen
Commit aber nicht zwingend synchronisiert, sondern erst bei bestimmten Bereinigungen. Unser
Dateisystemadapter sichert Sidecar-Namen vor dem Marker und flusht den Marker vor der Bestaetigung.
Atomare Sidecar-Umbenennungen erhalten ebenfalls eine Verzeichnisbarriere. Manifest und atomare
Rechercheexporte werden mit File-Flush und Verzeichnis-Flush geschrieben.

Mehr Flushes koennen die Schreibzeit erhoehen. Eine belastbare Messung muss auf dem jeweiligen
Produktivdateisystem erfolgen; aus den kleinen Temporaerdatei-Tests folgt kein Leistungsversprechen.

## Wegwerf-VM: vorbereiteter Ablauf

Die [Probe](../agent/test/power-loss-probe.ts) braucht nur Node und die bereits vorhandenen
Agentenabhaengigkeiten. Sie ruft keine Modelle oder kostenpflichtigen Dienste auf.

1. Eine eigenstaendige Wegwerf-VM und ein eigenes Test-Disk-Image verwenden. Keine Produktionsvolumes,
   Host-Blockgeraete oder Benutzerverzeichnisse einbinden. Netzwerk nur fuer den Kontrollkanal.
2. Die VM mit einem bekannten Dateisystem und dokumentierter QEMU-/Hypervisor-Cache-Konfiguration
   vorbereiten. Root-Images und Abhaengigkeiten nicht ungefragt herunterladen oder installieren.
3. Einen Testlauf mit frischer ID starten; `--dir` muss leer sein. Die Kontrollinstanz ausserhalb der VM
   speichert jede empfangene `ack`-Zeile. Der Writer wartet nach der letzten Ausgabe weiter und schliesst
   den Speicher nicht freiwillig.
4. Die VM zu variierenden Zeitpunkten hart ausschalten, waehrend der Writer arbeitet. Kein Gast-Shutdown,
   kein `sync` und kein `fsfreeze` unmittelbar vor dem Abbruch: das wuerde den Fehler verdecken.
5. Nach Wiederanlauf die hoechste ausserhalb beobachtete Bestaetigung mit dem wiedergefundenen
   Dokument vergleichen. Weitergeschriebene, aber noch nicht beobachtete Commits sind zulaessig.
6. SQLite-Integritaet, Dokument-Pruefsumme und Laufidentitaet pruefen; bei weniger wiedergefundenen
   als bestaetigten Commits ist das starke Profil durchgefallen. Ein Verifier-Fehler ist kein PASS.

Beispiel vom **Kontrollhost** fuer einen vorher separat vorbereiteten lokalen VM-Zugang
(`probe-vm` ist kein Produktivhost):

```sh
ssh probe-vm 'cd /work/phi-spaces && node --experimental-strip-types agent/test/power-loss-probe.ts write --backend sqlite --profile strong --dir /test-disk/run-001 --run-id power-run-001 --commits 100000' > /tmp/out-power-acks.txt 2>&1
```

Der Kontrollhost liest danach die vollstaendigen JSON-Zeilen mit `kind: "ack"` und der passenden ID,
zum Beispiel bis `n=42`. Nach hartem VM-Aus und Wiederanlauf:

```sh
ssh probe-vm 'cd /work/phi-spaces && node --experimental-strip-types agent/test/power-loss-probe.ts verify --backend sqlite --profile strong --dir /test-disk/run-001 --run-id power-run-001 --ack 42' > /tmp/out-power-verify.txt 2>&1
```

Dieselbe Matrix mit `--backend jsonl` wiederholen. Mit `--profile weak` werden absichtlich die
Upstream-Standards NORMAL bzw. JSONL ohne fsync verwendet; diese Kontrolllaeufe duerfen Bestaetigungen
verlieren. Sie sind kein alternatives Produktionsprofil. Ein nicht eingetretener Verlust in einem
schwachen Kontrolllauf ist kein Beweis fuer dessen Haltbarkeit.

Die Probe verweigert einen nicht leeren Writer-Pfad und prueft im Verifier eine eigene Guard-Datei
mit Backend, Profil und Lauf-ID. Sie loescht keine Daten. Fehlerhafte/unterbrochene Images bleiben
fuer die Analyse erhalten; Loeschen ist ein separater ausdruecklicher Operator-Schritt.

## Was ein hartes VM-Aus noch nicht beweist

Ein VM-Abbruch verwirft Gast-RAM. Bereits an den Host uebergebene Schreibvorgaenge koennen aber im
Host-Cache erhalten bleiben. QEMU zu beenden oder einen Docker-Container zu killen bedeutet deshalb
nicht automatisch Verlust des fluechtigen Laufwerkscaches.

Fuer einen kontrollierten Geraete-Cache-Verlust braucht es zusaetzlich einen isolierten Block-Backend-
Simulator, der bestaetigte, aber nicht geflushte Writes verwirft und FLUSH/FUA korrekt behandelt,
oder einen gesonderten physischen Teststand. `cache=unsafe` ignoriert Flushes und eignet sich nur als
bewusst kaputte Gegenprobe, nicht zur Bewertung der korrekten FULL-Konfiguration.

Die zu erfassende Matrix umfasst mindestens WAL-Append und Checkpoint sowie JSONL-Sidecar-Append,
Marker-Append, Sidecar-Replacement und neue Verzeichniseintraege. Fuer reproduzierbare Ergebnisse
sind Seed, Schnittpunkt, Hypervisor, Cache-Modus, Dateisystem, Mount-Optionen, Node-/SQLite-/Pi-Version
und ausserhalb beobachtete Bestaetigungen zu protokollieren.

## Grenzen zwischen Agent und Space

Agent und Space haben weiterhin keinen gemeinsamen atomaren Commit. Die Probe testet nur einen
Agentenspeicher, nicht bereits eine vollstaendige Wiederaufnahme von Quoten, Work Items und Weltaktionen
unter Stromverlust. Die vorhandenen Workflow-Regressionen belegen deren Prozessabsturzverhalten.
Ein entsprechender VM-End-to-End-Lauf mit Faux-Modellen ist eine zusaetzliche, noch offene Abnahme.

FULL/fsync beseitigt auch keine bereits ausgefuehrten externen Wirkungen: Ein Anbieter kann vor einem
Abbruch bezahlt worden sein, obwohl seine Antwort noch nicht gespeichert war. Sicherung, Fencing,
Wiederherstellung und Anbieter-Idempotenz bleiben getrennte Anforderungen.
