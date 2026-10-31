# Stromausfalltests fuer Agentenspeicher

## Stand und Nachweisgrenze

Die Integration verwendet SQLite WAL mit `synchronous=FULL` sowie JSONL mit synchronisierten
Sidecars, Commit-Markern und Verzeichniseintraegen. Siehe [`agent/src/storage.ts`](../../agent/src/storage.ts).
Das gilt auch fuer den mobilen Harness; der Space behaelt seinen eigenen Speicher.

**Am 30. und 31.10.2026 liefen Versuche in einer VM, siehe [Ergebnis](#ergebnis-vom-30102026). In den untersuchten Profilen und Schnittpunkten
wurde im starken Profil kein Verlust festgestellt. Offen bleiben Laufwerke, andere Dateisysteme und alles, was unter Grenzen steht.** FULL/fsync ist eine Schreibpolitik,
kein Hardware-Zertifikat. Datentraeger und Dateisystem muessen Flushes korrekt umsetzen.
Auch ein bestandener endlicher Test beweist nicht alle moeglichen Schreibunterbrechungen.

Die [lokalen Regressionen](../../agent/test/storage.test.ts) pruefen:

- WAL/FULL auf jeder neu geoeffneten SQLite-Verbindung, nicht nur beim ersten Start.
- JSONL: Sidecars vor Marker, Marker-Flush und Namespace-Barriere vor Bestaetigung.
- Wiederherstellung eines Dokuments aus ausschliesslich geflushten Dateiinhalten in einem vereinfachten
  Cache-Verlust-Modell; das modelliert weder Sektor-Torn-Writes noch ein bestimmtes Dateisystem.
- Verweigerte Bestaetigung und vergifteten JSONL-Speicher nach einem fehlgeschlagenen Marker-Flush.
- Den Gegenfall aus pi-durable 1.4.0: `{ fsync: true }` alleine flusht einen reinen Marker-Commit nicht.

Die [Probe-Selbsttests](../../agent/test/power-loss-probe.test.ts) beenden ihren eigenen Writer mit SIGKILL.
Das prueft Writer, extern beobachtete Bestaetigungen und Verifier, aber **keinen Stromverlust**.

## Ergebnis vom 30.10.2026

Zwei Serien im Gast `linux2020`, Rohdaten und Umgebung in [test/evidence](../../test/evidence/power-loss-2026-10-30/README.en.md).

**Replay** ([power-loss-replay.mjs](../../agent/test/power-loss-replay.mjs)): `dm-log-writes` protokolliert die geflushten
Schreibvorgaenge in Reihenfolge, nach jeder Bestaetigung kommt eine Marke ins Protokoll. Die Platte wird an zufaelligen Marken
neu aufgebaut und enthaelt dann nur, was bis dahin geflusht war. Das bildet den Verlust des Laufwerkscaches nach.

| Zelle | Schnitte | bestanden | Verlust |
|---|---|---|---|
| SQLite stark | 38 | 38 | 0 |
| JSONL stark | 37 | 37 | 0 |
| SQLite schwach | 115 | 38 | 77, bis zu 249 Commits |
| JSONL schwach | 115 | 0 | 115, davon 35 mit ganz fehlendem `main.jsonl` |

**Hartes Aus** ([power-loss-hard-off.mjs](../../agent/test/power-loss-hard-off.mjs)): `virsh destroy` waehrend des Schreibens,
Bestaetigungen ausserhalb der VM gespeichert, Pruefung nach dem Neustart.

| Zelle | Laeufe | bestanden | Verlust |
|---|---|---|---|
| SQLite stark | 3 | 3 | 0 |
| JSONL stark | 3 | 3 | 0 |
| SQLite schwach | 9 | 9 | 0 |
| SQLite schwach mit `strace` | 9 | 5 | 4, bis zu 233 Commits |
| JSONL schwach | 9 | 0 | 9 |

Das starke Profil hielt in diesen Versuchen jede Bestaetigung, und die schwachen Laeufe zeigen, dass der Aufbau Verluste erkennt.
Dass SQLite schwach ohne `strace` beim harten Aus bestand, belegt keine Haltbarkeit. Der Writer schreibt rund 250 Commits ohne fsync und
wartet dann auf den Checkpoint, der die WAL flusht. Der aus der VM gestreamte Mitschnitt zeigt das: In allen 5 Laeufen ohne Verlust war der letzte
Aufruf ein offener `fsync`, in allen 4 mit Verlust ein `pwrite`. Das harte Aus ist fuer SQLite daher die schwaechere Probe.

Das starke Profil kostet viel, die Raten stehen in [Abschnitt 5.3 des Vergleichs](../vergleich-pi-durable.en.md#53-durable-depends-on-the-backend-and-the-failure-model). Das gilt fuer diesen Host, nicht allgemein.

Derselbe Versuch lief zum Vergleich gegen den eigenen Store des Space, mit [gleich aufgebauter Probe](../../agent/test/power-loss-own-probe.ts).
Die Ergebnisse stehen ebenfalls dort.

Grenzen:

- Der Replay setzt ein Laufwerk voraus, das Flushes einhaelt. Fuer die Software ist das derselbe Fehlerfall wie ein Stromausfall;
  Laufwerke, die Flushes nicht einhalten, und zerrissene Sektoren deckt er nicht ab.
- Geschnitten wird nur an Marken, nicht an jeder Stelle des Protokolls. Die Schnitte einer Zelle stammen aus drei Schreiblaeufen und sind keine unabhaengigen Ausfaelle.
- Geprueft wird ein kleiner Zaehler oder eine Reihe einzelner Entries, nicht Conversations, Tasks oder Dokument-Deltas, und nicht gezielt kritische Schreib- und Ersetzungsschritte.
- Das stammt aus einem Host und einem Dateisystem. Im starken Profil gab es wegen der geringen Rate nur 91 bis 341 Commits je Zelle.
- Die Workflow-Wiederaufnahme mit Agent und Space ist damit nicht abgedeckt, siehe unten.

## Warum `agent/src/storage.ts` notwendig ist

Die veroeffentlichte Node-SQLite-Anbindung setzt `NORMAL` und bietet keinen Sync-Parameter.
`openDurableSqliteDatabase` stellt die Verbindung vor der Schemaoeffnung auf `FULL`, prueft den Wert und bricht bei
einem Fehler ab. Er waehlt niemals stillschweigend das schwaechere Profil.

JSONL `{ fsync: true }` synchronisiert in Version 1.4.0 die Sidecars. `main.jsonl` wird beim normalen
Commit aber nicht zwingend synchronisiert, sondern erst bei bestimmten Bereinigungen. `durableJsonlFileSystem`
sichert Sidecar-Namen vor dem Marker und flusht den Marker vor der Bestaetigung.
Atomare Sidecar-Umbenennungen erhalten ebenfalls eine Verzeichnisbarriere. Manifest und atomare
Rechercheexporte werden mit File-Flush und Verzeichnis-Flush geschrieben.

Mehr Flushes koennen die Schreibzeit erhoehen. Eine belastbare Messung muss auf dem jeweiligen
Produktivdateisystem erfolgen; aus den kleinen Temporaerdatei-Tests folgt kein Leistungsversprechen.

## Wegwerf-VM: vorbereiteter Ablauf

Die [Probe](../../agent/test/power-loss-probe.ts) braucht nur Node und die bereits vorhandenen
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

Fuer einen kontrollierten Geraete-Cache-Verlust braucht es zusaetzlich einen Simulator, der bestaetigte, aber nicht
geflushte Writes verwirft und FLUSH/FUA korrekt behandelt (der Replay oben), oder einen gesonderten physischen Teststand. `cache=unsafe` ignoriert Flushes und eignet sich nur als
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
