---
standard: help_topic
id: help.topic.topology_and_readiness
title: "Topologien, API-Grenzen und Abnahmestand"
short: "Ein lauffähiger Runner zeigt einen Ablauf, nicht automatisch reale Verteilung oder vollständige Ausfallsicherheit. Die Stufen v1–v6 sind lokale Demonstrationen unterschiedlicher Komponenten, kein automatischer Ausbau eines Produktivclusters."
tags: [topology, v1, v2, v3, v4, v5, v6, primary, sync, fencing, SpaceLike]
owner: federation
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Topologien, API-Grenzen und Abnahmestand

## Demo, Implementierung und Abnahme trennen {#overview}

Ein lauffähiger Runner zeigt einen Ablauf, nicht automatisch reale Verteilung oder vollständige Ausfallsicherheit. Die Stufen v1–v6 sind lokale Demonstrationen unterschiedlicher Komponenten, kein automatischer Ausbau eines Produktivclusters.

## Topologiematrix {#matrix}

| Stufe | Prozesse/Hosts und Storage | Geprüfte Grenze | Nicht dadurch belegt |
|---|---|---|---|
| v1 | Ein Prozess, ein Memory-Harness, benannter Chat-Space | Lokale Tasks, Threads, Ergebnisse | Persistenz oder Netz |
| v2 | Ein Prozess, SQLite-Harness, Close/Reopen | Persistente Alarme/Suche und Wiederanlauf | SIGKILL, Strom- oder Hostverlust |
| v3 | Ein Prozess mit getrennten Remote-Clients und echtem Unix-Socket | RPC, Identität und Mailbox | Unabhängige physische Hosts |
| v4 | Zwei persistente Harnesses und TCP-Gates lokal | Schlüsselbeweis, Enrollment, Grants, Rotation | Reales NetBird-Provisioning |
| v5 | Vier Memory-Harnesses im selben Prozess | Router, HRW, föderierte Suche, LWW-Komponente | Produktivcluster/Fencing |
| v6 | Ein Memory-Harness mit mehreren Spaces | Lokale Betriebsbausteine und Beispiel-Enrollment | Automatisches Phone-Pairing oder vollständige Remote-Betriebsabnahme |

## Welche API ist austauschbar? {#api}

PhiSpaces und RemoteSpace implementieren den SpaceLike-Basisvertrag; Mailbox-Zugriff ist ausdrücklich clientspezifisch. FederatedSpace hat einen eigenen FederationRequest mit Principal, stabiler Operations-ID und optionaler Member-Transaktionsbindung. write(entry, request, leaseMs), read(template, request) und finishTransaction sind kein direkter Ersatz für lokale Methoden. Gemeinsame Fachkonzepte bleiben nutzbar; Routing, vollständige/partielle Ergebnisse und Request-Bindungen müssen adaptiert werden. Keine allgemeinen atomaren Transaktionen über beliebige Hosts versprechen.

## Replikationsarten und Freigabe {#replication}

Merge-Replikation nutzt HLC, versionierte Tombstones und je nach Policy LWW/Add-Wins-Sets für geeignete Daten; sie ist keine Exklusiv-Queue. primary/sync bestätigt erst nach dem vorgesehenen synchronen Storage-/Standby-Pfad. Promotion/degrade benötigen autorisierte Übergänge und wirksame Fencing-/Sperrnachweise; eine höhere Epoche allein stoppt keinen isolierten alten Primary. Die maßgebliche Abnahmematrix docs/abnahme/ap3-abnahme.md trennt lokale Komponenten, echte Netz-/Fencing-Läufe und offene Kriterien. Ein Metadaten- oder LWW-Beispiel ist keine Freigabe aller Phase-3-Pfade.

## Testsystem: Hardware und Datenbegrenzung {#testsystem}

Das verteilte Testsystem läuft auf zwei Hosts. **big** (KVM-Server, 8 vCPU auf AMD EPYC 9634, 15 GiB RAM) trägt Frontend, WebSocket-Hub, Router und Shard a. **nano** (netcup-KVM, 4 vCPU, 7,8 GiB RAM) hält Shard b in einer eigenen Datenbank; beide teilen keine Platte. Lokal läuft alles auf einem Rechner mit einer Datenbank. Jeder Commit kostet O(Anzahl Einträge) je Space, deshalb hält jede Datenbank höchstens 20 000 Einträge (`SWARM_MAX_ENTRIES`, 0 schaltet die Grenze ab). Darüber werden in Schüben die ältesten Posts samt Likes und History-Knoten gelöscht, bis etwa 19 000 erreicht sind; Kanalzähler bleiben Lebenszeitzähler. Beim Löschen erscheint im Feed ein gelber Hinweis. Das ist eine Eigenschaft des Testsystems, kein Produktlimit. Die schmale Leiste unter dem Chatfenster zeigt die tatsächlichen Werte der Hosts (CPU, Kerne, Speicher, Einträge je Datenbank); die Zahlen hier sind Richtwerte.
