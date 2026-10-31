# phi-spaces Dokumentation

| Dokument | Inhalt | Status |
|---|---|---|
| [implementierungsstand.md](../implementierungsstand.en.md) | implementierter Umfang, Nachweise und Grenzen | **aktuell** |
| [api.md](../api.en.md) | TypeScript-, Dienst- und Remote-API | **aktuell** |
| [vergleich-pi-durable.md](../vergleich-pi-durable.en.md) | Gemeinsamkeiten und Unterschiede zu Earendils pi-durable; Release 1.4.0 und neuerer main-Stand getrennt | Vergleich vom 2026-10-30, mit Quellen und Upgrade-Grenzen |
| [upgrade-pi-1.4.0.md](../upgrade-pi-1.4.0.en.md) | Earendil-Upgrade, Kontextbrücke, Transport-Ausnahme und Datenbank-/Rollback-Grenzen | Paketstand 1.4.0; Server/Client separat 1.1.0 |
| [agenten-stromausfalltest.md](../agenten-stromausfalltest.en.md) | FULL/fsync, JSONL-Markerbarriere, Regressionen und vorbereiteter Wegwerf-VM-Test | Sync-Policy implementiert; VM-Versuche vom 30./31.10.2026 ohne Verlust im starken Profil; Laufwerke und andere Dateisysteme offen |
| [Vollständige Namensumstellung](../namensumstellung-2026-10-18.en.md) | einheitliche Namen, Speicher-/Bundle-Formatbruch, Prüfnachweise und Betriebsgrenzen | lokal umgesetzt; bestehende Stores/externes Deployment separat |
| [umstellung-ohne-pi-durable.md](../umstellung-ohne-pi-durable.en.md) | eigenständiger Space-Host, Haltbarkeit, Datenmigration und Abnahme ohne pi-durable | detaillierter Ziel- und Arbeitsplan; U0 bis U4, U6, U8 und Teile von U7 umgesetzt, U5 entfällt (D6) |
| [umstellung-u0-bestand.md](../umstellung-u0-bestand.en.md) | U0: Importgraph, Dokumentkatalog, Ausgangstests, Lastprofil, Grenzwerte | Bestand vom 2026-10-22; D1–D4 und D6 entschieden |
| [UI-Mockups](../_attic/ui-mockups/UI-MOCKUPS.en.md) | Galerie der Dashboard-Entwürfe | UI-Konzept |
| [spaces-v1.md](../_attic/spaces-v1.en.md) | lokaler Stand vom 2026-10-07 | historisch |
| [federation-plan-v3.md](../federation-plan-v3.en.md) | Plan für föderierte Spaces, Gates, offene Fragen | **aktuell** |
| [implementierungsplan-v3.md](../_attic/implementierungsplan-v3.en.md) | Reife, Vorab-Entscheidungen, Arbeitspakete und Fortschritt für v3 | archiviert |
| [ap1b-abnahme.md](../_attic/abnahme/ap1b-abnahme.en.md) | Phase 1b: Laufzeit, Grants, Rotation und Recovery-Bausteine | im F15-Modell abgenommen |
| [ap2-abnahme.md](../_attic/abnahme/ap2-abnahme.en.md) | Phase 2: Router, Delegation, Membership, Last- und Ausfallabnahmen | abgeschlossen (Ausnahme Block 4) |
| [ap2-gate4.md](../_attic/abnahme/ap2-gate4.en.md) | Gate 4: finale Betriebswerte | festgelegt |
| [ap3-replikation.md](../_attic/abnahme/ap3-replikation.en.md) | Phase 3: Replikationsbausteine, Stand und offene Schritte | begonnen, nicht abgenommen |
| [ap3-replica-control.md](../_attic/abnahme/ap3-replica-control.en.md) | Phase 3: Promotion, degradeToSingle, setStandby, Fencing-Schnittstelle | umgesetzt, netcup-Fencing-Adapter real; Phase 3 nicht abgenommen |
| [dashboard.md](../dashboard.en.md) | lesendes Live-Dashboard | umgesetzt |
| [datenhaltung.md](../datenhaltung.en.md) | welche Daten in welchem Store und Space liegen, lokal und auf big/nano | Stand 2026-10-28 |
| [wire-protokoll.md](../wire-protokoll.en.md) | Leitungsprotokoll des Space-Dienstes, Grundlage eines zweiten Servers | Stand 2026-10-29 |
| [rust-portierung.md](../rust-portierung.en.md) | Portierung des Space-Servers nach Rust | laufend |
| [codemode-space-architektur.md](../codemode-space-architektur.en.md) | Codemode-Chat: jede Rolle ein eigener Prozess um einen Space | aktuell |
| [codemode-kooperation.md](../codemode-kooperation.en.md) | Codemode-Chat: Kooperation der Agenten | Konzept vom 2026-10-20 |
| [ap1-abnahme.md](../_attic/abnahme/ap1-abnahme.en.md) | AP 1.1–1.9: Implementierung, Regressionen und native pi-serverd-Abnahme | lokal geprüft |
| [testumgebung-big.md](../testumgebung-big.en.md) | Docker-Testumgebung auf dem Server big: Skript, Container, Fehlerinjektion, Grenzen | umgesetzt, `test/testbed/` |
| [tui.md](../tui.en.md) | Terminaloberfläche: Spaces/Objekte, Serveraktionen, Tests und Berichte | umgesetzt; geplante Backends gesperrt |
| [betrieb-und-mobile-steuerung.md](../betrieb-und-mobile-steuerung.en.md) | Betriebserweiterung: Läufe, Worker, Spaces, Bootstrap, mobile Steuerung, Abnahmefälle | **aktuell**: B1–B10 umgesetzt, Stand je Fall in §7.6 |
| [projektstart-autoprovisionierung.md](../_attic/projektstart-autoprovisionierung.en.md) | automatische Remote-Bereitstellung von Runtime, Spaces, Monitoring und Federation bei Projektstart | archiviert |
| [examples.md](../examples.en.md) | Beispiele (Pipeline, Chat, arXiv-Team) im Detail — was wirklich läuft | aktuell |
| [VALIDIERUNG.md](../_attic/VALIDIERUNG.en.md) | lokaler Prüfnachweis und seine Grenzen | historisch (Stand 2026-10-07); aktuelle Nachweise im Implementierungsstand |
| [TESTBESPIELE.md](../_attic/TESTBESPIELE.en.md) | Spezifikation von Ziel-Beispielen inkl. Federation-Modi | Entwurf, Zielbild |
| [examples/README.en.md](../examples/README.en.md) | Index, Lernpfad, Schnellstart für alle Beispiele | aktuell |
| [../help-site/](../../help-site/) | Interaktives Hilfesystem + Demos: Social Swarm Feed, Space-Chat Workbench (v1–v6), AdminSpaces-Portal | aktuell; Start `npm run help` |
| [Hilfesystem-/Demo-Analyse vom 18.10.2026](../_attic/analyse-hilfesystem-demo-apps-2026-10-18.en.md) | Logikfehler, ungenutzter und doppelter Code, funktionale Lücken; Codebelege, Reproduktionen und Testnachweise | F01–F23 lokal behoben und als erledigt dokumentiert; Betriebsabnahmen getrennt |
| [Help-Corpus: Konsistenz und Abschluss](../_attic/analyse-hilfecorpus-konsistenz-2026-10-18.en.md) | API-Abgleich, acht neue Praxisleitfäden, UI-Korrekturen, Prüfungen und offene Gates | lokale Umsetzung abgeschlossen; keine Deployment-/Großstore-Abnahme |
| [examples/](../examples/) | geprüfte Beispielverträge und klar getrennte Entwürfe | Sieb und lokaler Cache implementiert; Federation geplant |
| _attic/federation-plan-v1.en.md, _attic/federation-plan-v2.en.md, _attic/federation-plan-v2-summary.en.md | frühere Fassungen | ersetzt durch v3, nur Verlauf |

Lesereihenfolge: Implementierungsstand → API → federation-plan-v3 (Abschnitt 11 Stufenplan, 13 Gates, 14 Fragen).

Die Beispieldokumente wurden am 2026-10-07 konsolidiert: fachlich falsche Codekopien, widersprüchliche Status-
und unbelegte Leistungstabellen wurden durch aktuelle Verträge ersetzt. Nachweise unterscheiden Code,
lokale geskriptete Tests, noch offene Live-Modellprüfung und zukünftige Federation.
Die v1/v2-Archive dokumentieren frühere Entscheidungen und enthalten verworfene Entwürfe.

- [Phase-1b-Betrieb und Recovery-Schnittstellen](../_attic/abnahme/ap1b-betrieb.en.md) – implementierte Konfiguration und verbleibende Betriebsintegration.

- [AP 2.1/2.8: Router und Simulator](../_attic/abnahme/ap2-router-und-simulator.en.md): implementierter Umfang, Recovery und Nachweise.

- [AP 2.2–2.5: Delegation, Routing und Membership](../_attic/abnahme/ap2-delegation-routing-membership.en.md): APIs, Core-Sperren und persistente/TCP-Nachweise.
