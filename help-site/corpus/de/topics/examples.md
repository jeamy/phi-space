---
standard: help_topic
id: help.topic.examples
title: "Beispiele: Was es gibt und wie man sie startet"
short: "Alle ausführbaren Beispiele auf einen Blick: was sie zeigen, wie man sie startet und welche echte Modelle brauchen und Tokens kosten."
tags: [examples, agents, agent-examples, scripted, live, cli, arxiv, chat]
owner: tools
related: [help.topic.first_running_space, help.topic.agent_tools_and_replay, help.topic.apps, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Beispiele: Was es gibt und wie man sie startet

## Überblick {#overview}

Die Beispiele sind kleine Programme, die phi-spaces bei der Arbeit zeigen. Die meisten laufen sofort, ohne Modell und ohne Netz, und sind nach wenigen Sekunden fertig. Einige lassen Agenten zusammenarbeiten, wobei ein vorgeskriptetes Modell antwortet. Nur die Beispiele im Abschnitt [Mit echtem Modell](#live) kosten Tokens.

Wer nur einen Eindruck will, startet `npm run example:pipeline` für die Zusammenarbeit ohne Agenten und `npm run example:chat` für drei Agenten im Gespräch. Alle Befehle gelten im Wurzelverzeichnis des Repositorys.

### Voraussetzungen {#requirements}

- Node.js mit `--experimental-strip-types`; einen Build-Schritt gibt es nicht.
- Die Agenten-Beispiele brauchen die eigenen Abhängigkeiten des Pakets `agent/` in `agent/node_modules`. Der Space selbst braucht sie nicht.
- Nach einer Änderung prüft `npm run test:agent` die Agenten-Beispiele mit geskripteten Modellen.

## Beispiele ohne Agenten und ohne Modell {#without-model}

Hier ist jede Rolle gewöhnlicher Programmcode. So sieht man das Koordinationsmuster allein, und das Ergebnis ist jedes Mal nachprüfbar.

| Beispiel | Was es zeigt | Start | Datei |
|---|---|---|---|
| Sensor-Pipeline | Sammler liefern Messwerte, konkurrierende Analysten fassen Zeitfenster zusammen, ein Presenter berichtet; Duplikate und ungültige Werte werden aussortiert | `npm run example:pipeline` | `examples/sensor-pipeline.ts` |
| Primzahlsieb | Ein Sieb, aufgeteilt in Aufgaben, die Worker aus dem Space nehmen | `npm run example:sieve -- 1001 4` (bis 1001, 4 Worker) | `examples/sieve.ts` |
| Cache | Atomare Schlüssel-Wert-Operationen mit Ablaufzeit und Versionsvergleich; keine Replikation | `npm run example:cache` | `examples/cache.ts` |
| Golomb-Lineal | Gemeinsame Suche mit Branch-and-Bound; das beste Ergebnis liegt im Space. Ordnung 4 mit 2 Workern dauert etwa 10 Sekunden | `npm run example:golomb -- 4 --workers 2` | `examples/golomb.ts` |
| Codemode-Evolution | Zufällige Programmbeiträge, die eine Sandbox bewertet; die Besten sind die Basis der nächsten Generation. 2 Generationen mit 4 Agenten dauern etwa 20 Sekunden | `npm run example:codemode-evolve -- --gens 6 --agents 8` | `examples/codemode-evolve.ts` |
| Space-Chat, Stufe v1 | Chat allein aus Space-Bausteinen: Presence, Aufgaben, Alarme | `npm run example:space-chat` | `help-site/examples/v1-local-memory/run.ts` |

Sieb und Cache laufen auch über einen eigenständigen Space-Dienst:

```sh
npm run space-server -- --store /tmp/space.sqlite --listen unix:/tmp/space.sock
npm run example:sieve -- 1001 4 --remote unix:/tmp/space.sock
npm run example:cache -- --remote unix:/tmp/space.sock
```

Die Stufen v2 bis v6 des Space-Chats stehen im [Stufenplan](help.workflow.overview_v1_to_v6#overview).

## Agenten-Beispiele {#agents}

Diese Beispiele liegen in `agent/examples/`. Hier sind die Teilnehmer echte Agenten: Conversations von `pi-durable`, die den Space über die [Space-Werkzeuge](help.topic.agent_tools_and_replay#overview) benutzen. Ein geskriptetes Modell gibt die Antworten vor, deshalb kostet es nichts und endet in etwa einer Sekunde.

| Beispiel | Was es zeigt | Start | Datei |
|---|---|---|---|
| Master und Worker | Eine Conversation legt Aufträge in den Space, eine andere nimmt einen davon | `npm run example` | `agent/examples/workers.ts` |
| Blockierendes Take | Ein Agent wartet mit `space_take` und Zeitlimit auf einen Auftrag, den erst danach jemand schreibt | `npm run example:blocking` | `agent/examples/blocking-tool.ts` |
| Chat im Ring | Drei Agenten sprechen reihum über ein Thema. Jeder hat ein Abo für Nachrichten an ihn, eine Nachricht weckt also genau den Adressaten | `npm run example:chat` | `agent/examples/chat.ts` |

### Worauf man beim Lesen achtet {#agents-reading}

- Die Agenten rufen einander nie direkt auf. Sie sehen nur den Space.
- Der Space läuft als eigener Host neben den Agenten (`createSpaces(localSpaces(host))`). Die Werkzeuge greifen auf ihn zu.

## Mit echtem Modell {#live}

Diese Beispiele kosten Tokens. Deshalb starten sie nie von selbst, auch nicht in den Tests. Die arXiv-Teams brauchen zusätzlich Netzzugang.

| Beispiel | Was es zeigt | Start | Datei |
|---|---|---|---|
| Live-Chat | Der Chat im Ring mit einem echten Modell | `npm run example:chat -- --live "Thema"` | `agent/examples/chat.ts` |
| arXiv-Rechercheteam | Drei Sammler suchen Paper, ein Analyst wertet aus, ein Presenter schreibt den Bericht | `npm run example:arxiv -- "Thema" --dir LAUF --out bericht.md` | `agent/examples/arxiv-research.ts` |
| Dark-Energy-Recherche | Größeres Team mit Crawler, Klassifikator, Zusammenfasser, Analyst, Presenter und Monitor; mit `--query` beantwortet ein Chat-Agent eine Frage | `npm run example:dark-energy -- --dir LAUF --query "Frage"` | `agent/examples/dark-energy-research.ts` |
| Codemode-Evolution live | Modelle schreiben die Beiträge selbst. Etwa 600 Tokens je Beitrag (Agenten × Generationen × Beiträge je Agent) | `npm run example:codemode-evolve:live -- --agents 4 --gens 3` | `agent/examples/codemode-evolve-live.ts` |

### Modell und Zugang {#live-models}

- `PI_PROVIDER` und `PI_MODEL` wählen das Modell. Ohne sie nimmt `agent/src/live-models.ts` das erste verfügbare.
- Zugangsdaten kommen aus Umgebungsvariablen wie `ANTHROPIC_API_KEY` oder aus der Anmeldung der pi-CLI (`~/.pi/agent/auth.json`, nur lesend).
- Die Codemode-Evolution live nimmt ohne Auswahl das erste Mistral-Modell.

### Wiederaufnahme der Recherchen {#live-resume}

Ein neuer Lauf verlangt ein frisches, leeres Verzeichnis. Mit `--resume` öffnet man einen unterbrochenen Lauf wieder:

```sh
npm run example:arxiv -- --resume --dir LAUF
npm run example:dark-energy -- --resume --dir LAUF
```

Der Agentenzustand liegt als JSONL im Laufverzeichnis, der Bericht in `--out` (Standard `<Verzeichnis>/report.md`). Abgelaufene Transaktionen werden dadurch nicht wieder gültig, und Modell- oder arXiv-Anfragen können nach einem Absturz erneut laufen.

Die Tests prüfen diese Programme mit geskripteten Modellen. Die Qualität echter Ergebnisse belegen sie nicht.

## Weiterlesen {#further}

- Ausführliche Nachweise und Grenzen je Beispiel stehen im Repository in `docs/examples.md` und `docs/examples/`.
- Eine eigene erste Anwendung baut [Ein vollständiger erster Space](help.topic.first_running_space#overview) Schritt für Schritt auf.
- Fertige Anwendungen stehen unter [Apps auf phi-spaces](help.topic.apps#overview).
