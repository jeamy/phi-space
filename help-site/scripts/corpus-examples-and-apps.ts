// Two entry points written for readers who want to see something run: the examples and the applications.
import type { ArticleSeed } from "./corpus-articles-data.ts";

export const EXAMPLE_AND_APP_ARTICLES: ArticleSeed[] = [
	{
		id: "help.topic.examples",
		type: "topic",
		provider: "tools",
		tags: ["examples", "agents", "agent-examples", "scripted", "live", "cli", "arxiv", "chat"],
		related: ["help.topic.first_running_space", "help.topic.agent_tools_and_replay", "help.topic.apps", "help.workflow.overview_v1_to_v6"],
		since: "0.0.1",
		de: {
			title: "Beispiele: Was es gibt und wie man sie startet",
			short: "Alle ausführbaren Beispiele auf einen Blick: was sie zeigen, wie man sie startet und welche echte Modelle brauchen und Tokens kosten.",
			body: `## Überblick {#overview}

Die Beispiele sind kleine Programme, die phi-spaces bei der Arbeit zeigen. Die meisten laufen sofort, ohne Modell und ohne Netz, und sind nach wenigen Sekunden fertig. Einige lassen Agenten zusammenarbeiten, wobei ein vorgeskriptetes Modell antwortet. Nur die Beispiele im Abschnitt [Mit echtem Modell](#live) kosten Tokens.

Wer nur einen Eindruck will, startet \`npm run example:pipeline\` für die Zusammenarbeit ohne Agenten und \`npm run example:chat\` für drei Agenten im Gespräch. Alle Befehle gelten im Wurzelverzeichnis des Repositorys.

### Voraussetzungen {#requirements}

- Node.js mit \`--experimental-strip-types\`; einen Build-Schritt gibt es nicht.
- Die Agenten-Beispiele brauchen die eigenen Abhängigkeiten des Pakets \`agent/\` in \`agent/node_modules\`. Der Space selbst braucht sie nicht.
- Nach einer Änderung prüft \`npm run test:agent\` die Agenten-Beispiele mit geskripteten Modellen.

## Beispiele ohne Agenten und ohne Modell {#without-model}

Hier ist jede Rolle gewöhnlicher Programmcode. So sieht man das Koordinationsmuster allein, und das Ergebnis ist jedes Mal nachprüfbar.

| Beispiel | Was es zeigt | Start | Datei |
|---|---|---|---|
| Sensor-Pipeline | Sammler liefern Messwerte, konkurrierende Analysten fassen Zeitfenster zusammen, ein Presenter berichtet; Duplikate und ungültige Werte werden aussortiert | \`npm run example:pipeline\` | \`examples/sensor-pipeline.ts\` |
| Primzahlsieb | Ein Sieb, aufgeteilt in Aufgaben, die Worker aus dem Space nehmen | \`npm run example:sieve -- 1001 4\` (bis 1001, 4 Worker) | \`examples/sieve.ts\` |
| Cache | Atomare Schlüssel-Wert-Operationen mit Ablaufzeit und Versionsvergleich; keine Replikation | \`npm run example:cache\` | \`examples/cache.ts\` |
| Golomb-Lineal | Gemeinsame Suche mit Branch-and-Bound; das beste Ergebnis liegt im Space. Ordnung 4 mit 2 Workern dauert etwa 10 Sekunden | \`npm run example:golomb -- 4 --workers 2\` | \`examples/golomb.ts\` |
| Codemode-Evolution | Zufällige Programmbeiträge, die eine Sandbox bewertet; die Besten sind die Basis der nächsten Generation. 2 Generationen mit 4 Agenten dauern etwa 20 Sekunden | \`npm run example:codemode-evolve -- --gens 6 --agents 8\` | \`examples/codemode-evolve.ts\` |
| Space-Chat, Stufe v1 | Chat allein aus Space-Bausteinen: Presence, Aufgaben, Alarme | \`npm run example:space-chat\` | \`help-site/examples/v1-local-memory/run.ts\` |

Sieb und Cache laufen auch über einen eigenständigen Space-Dienst:

\`\`\`sh
npm run space-server -- --store /tmp/space.sqlite --listen unix:/tmp/space.sock
npm run example:sieve -- 1001 4 --remote unix:/tmp/space.sock
npm run example:cache -- --remote unix:/tmp/space.sock
\`\`\`

Die Stufen v2 bis v6 des Space-Chats stehen im [Stufenplan](help.workflow.overview_v1_to_v6#overview).

## Agenten-Beispiele {#agents}

Diese Beispiele liegen in \`agent/examples/\`. Hier sind die Teilnehmer echte Agenten: Conversations von \`pi-durable\`, die den Space über die [Space-Werkzeuge](help.topic.agent_tools_and_replay#overview) benutzen. Ein geskriptetes Modell gibt die Antworten vor, deshalb kostet es nichts und endet in etwa einer Sekunde.

| Beispiel | Was es zeigt | Start | Datei |
|---|---|---|---|
| Master und Worker | Eine Conversation legt Aufträge in den Space, eine andere nimmt einen davon | \`npm run example\` | \`agent/examples/workers.ts\` |
| Blockierendes Take | Ein Agent wartet mit \`space_take\` und Zeitlimit auf einen Auftrag, den erst danach jemand schreibt | \`npm run example:blocking\` | \`agent/examples/blocking-tool.ts\` |
| Chat im Ring | Drei Agenten sprechen reihum über ein Thema. Jeder hat ein Abo für Nachrichten an ihn, eine Nachricht weckt also genau den Adressaten | \`npm run example:chat\` | \`agent/examples/chat.ts\` |

### Worauf man beim Lesen achtet {#agents-reading}

- Die Agenten rufen einander nie direkt auf. Sie sehen nur den Space.
- Der Space läuft als eigener Host neben den Agenten (\`createSpaces(localSpaces(host))\`). Die Werkzeuge greifen auf ihn zu.

## Mit echtem Modell {#live}

Diese Beispiele kosten Tokens. Deshalb starten sie nie von selbst, auch nicht in den Tests. Die arXiv-Teams brauchen zusätzlich Netzzugang.

| Beispiel | Was es zeigt | Start | Datei |
|---|---|---|---|
| Live-Chat | Der Chat im Ring mit einem echten Modell | \`npm run example:chat -- --live "Thema"\` | \`agent/examples/chat.ts\` |
| arXiv-Rechercheteam | Drei Sammler suchen Paper, ein Analyst wertet aus, ein Presenter schreibt den Bericht | \`npm run example:arxiv -- "Thema" --dir LAUF --out bericht.md\` | \`agent/examples/arxiv-research.ts\` |
| Dark-Energy-Recherche | Größeres Team mit Crawler, Klassifikator, Zusammenfasser, Analyst, Presenter und Monitor; mit \`--query\` beantwortet ein Chat-Agent eine Frage | \`npm run example:dark-energy -- --dir LAUF --query "Frage"\` | \`agent/examples/dark-energy-research.ts\` |
| Codemode-Evolution live | Modelle schreiben die Beiträge selbst. Etwa 600 Tokens je Beitrag (Agenten × Generationen × Beiträge je Agent) | \`npm run example:codemode-evolve:live -- --agents 4 --gens 3\` | \`agent/examples/codemode-evolve-live.ts\` |

### Modell und Zugang {#live-models}

- \`PI_PROVIDER\` und \`PI_MODEL\` wählen das Modell. Ohne sie nimmt \`agent/src/live-models.ts\` das erste verfügbare.
- Zugangsdaten kommen aus Umgebungsvariablen wie \`ANTHROPIC_API_KEY\` oder aus der Anmeldung der pi-CLI (\`~/.pi/agent/auth.json\`, nur lesend).
- Die Codemode-Evolution live nimmt ohne Auswahl das erste Mistral-Modell.

### Wiederaufnahme der Recherchen {#live-resume}

Ein neuer Lauf verlangt ein frisches, leeres Verzeichnis. Mit \`--resume\` öffnet man einen unterbrochenen Lauf wieder:

\`\`\`sh
npm run example:arxiv -- --resume --dir LAUF
npm run example:dark-energy -- --resume --dir LAUF
\`\`\`

Der Agentenzustand liegt als JSONL im Laufverzeichnis, der Bericht in \`--out\` (Standard \`<Verzeichnis>/report.md\`). Abgelaufene Transaktionen werden dadurch nicht wieder gültig, und Modell- oder arXiv-Anfragen können nach einem Absturz erneut laufen.

Die Tests prüfen diese Programme mit geskripteten Modellen. Die Qualität echter Ergebnisse belegen sie nicht.

## Weiterlesen {#further}

- Ausführliche Nachweise und Grenzen je Beispiel stehen im Repository in \`docs/examples.md\` und \`docs/examples/\`.
- Eine eigene erste Anwendung baut [Ein vollständiger erster Space](help.topic.first_running_space#overview) Schritt für Schritt auf.
- Fertige Anwendungen stehen unter [Apps auf phi-spaces](help.topic.apps#overview).`,
		},
		en: {
			title: "Examples: what exists and how to run it",
			short: "Every runnable example at a glance: what it shows, how to start it, and which ones need a real model and cost tokens.",
			body: `## Overview {#overview}

The examples are small programs that show phi-spaces at work. Most run straight away, without a model or network, and finish within seconds. Some let agents work together, with a scripted model giving the answers. Only the examples under [With a real model](#live) cost tokens.

For a first impression, start \`npm run example:pipeline\` for cooperation without agents and \`npm run example:chat\` for three agents in conversation. All commands apply in the repository root.

### Requirements {#requirements}

- Node.js with \`--experimental-strip-types\`; there is no build step.
- The agent examples need the \`agent/\` package's own dependencies in \`agent/node_modules\`. The space itself does not.
- After a change, \`npm run test:agent\` checks the agent examples with scripted models.

## Examples without agents or a model {#without-model}

Here every role is ordinary program code. You see the coordination pattern alone, and the result can be checked every time.

| Example | What it shows | Start | File |
|---|---|---|---|
| Sensor pipeline | Collectors deliver readings, competing analysts summarise time windows, a presenter reports; duplicates and invalid values are filtered out | \`npm run example:pipeline\` | \`examples/sensor-pipeline.ts\` |
| Prime sieve | A sieve split into tasks that workers take from the space | \`npm run example:sieve -- 1001 4\` (up to 1001, 4 workers) | \`examples/sieve.ts\` |
| Cache | Atomic key/value operations with expiry and version comparison; no replication | \`npm run example:cache\` | \`examples/cache.ts\` |
| Golomb ruler | A shared branch-and-bound search; the best result lives in the space. Order 4 with 2 workers takes about 10 seconds | \`npm run example:golomb -- 4 --workers 2\` | \`examples/golomb.ts\` |
| Codemode evolution | Random program contributions judged by a sandbox; the best are the basis of the next generation. 2 generations of 4 agents take about 20 seconds | \`npm run example:codemode-evolve -- --gens 6 --agents 8\` | \`examples/codemode-evolve.ts\` |
| Space-Chat, stage v1 | A chat made only of space building blocks: presence, tasks, alarms | \`npm run example:space-chat\` | \`help-site/examples/v1-local-memory/run.ts\` |

The sieve and the cache also run over a standalone space service:

\`\`\`sh
npm run space-server -- --store /tmp/space.sqlite --listen unix:/tmp/space.sock
npm run example:sieve -- 1001 4 --remote unix:/tmp/space.sock
npm run example:cache -- --remote unix:/tmp/space.sock
\`\`\`

Stages v2 to v6 of the Space-Chat are in the [stage plan](help.workflow.overview_v1_to_v6#overview).

## Agent examples {#agents}

These examples live in \`agent/examples/\`. Here the participants are real agents: \`pi-durable\` conversations that use the space through the [space tools](help.topic.agent_tools_and_replay#overview). A scripted model gives the answers, so nothing is charged and each run ends in about a second.

| Example | What it shows | Start | File |
|---|---|---|---|
| Master and worker | One conversation puts jobs in the space, another takes one | \`npm run example\` | \`agent/examples/workers.ts\` |
| Blocking take | An agent waits with \`space_take\` and a timeout for a job someone writes only afterwards | \`npm run example:blocking\` | \`agent/examples/blocking-tool.ts\` |
| Ring chat | Three agents talk in turn about a topic. Each subscribes to messages addressed to it, so a message wakes exactly its addressee | \`npm run example:chat\` | \`agent/examples/chat.ts\` |

### What to look for when reading {#agents-reading}

- The agents never call each other directly. They only see the space.
- The space runs as a host of its own beside the agents (\`createSpaces(localSpaces(host))\`). The tools act on it.

## With a real model {#live}

These examples cost tokens, so they never start by themselves, not even in the tests. The arXiv teams also need network access.

| Example | What it shows | Start | File |
|---|---|---|---|
| Live chat | The ring chat with a real model | \`npm run example:chat -- --live "topic"\` | \`agent/examples/chat.ts\` |
| arXiv research team | Three collectors search papers, an analyst evaluates, a presenter writes the report | \`npm run example:arxiv -- "topic" --dir RUN --out report.md\` | \`agent/examples/arxiv-research.ts\` |
| Dark energy research | A larger team of crawler, classifier, summarizer, analyst, presenter and monitor; with \`--query\` a chat agent answers a question | \`npm run example:dark-energy -- --dir RUN --query "question"\` | \`agent/examples/dark-energy-research.ts\` |
| Codemode evolution live | Models write the contributions themselves. About 600 tokens per contribution (agents × generations × contributions per agent) | \`npm run example:codemode-evolve:live -- --agents 4 --gens 3\` | \`agent/examples/codemode-evolve-live.ts\` |

### Model and access {#live-models}

- \`PI_PROVIDER\` and \`PI_MODEL\` pick the model. Without them, \`agent/src/live-models.ts\` takes the first available one.
- Credentials come from environment variables such as \`ANTHROPIC_API_KEY\` or from the pi CLI's login (\`~/.pi/agent/auth.json\`, read only).
- Without a choice, the live codemode evolution takes the first Mistral model.

### Resuming research runs {#live-resume}

A new run requires a fresh, empty directory. \`--resume\` reopens an interrupted run:

\`\`\`sh
npm run example:arxiv -- --resume --dir RUN
npm run example:dark-energy -- --resume --dir RUN
\`\`\`

The agent state lives as JSONL in the run directory, the report in \`--out\` (default \`<directory>/report.md\`). Resuming does not make expired transactions valid again, and model or arXiv requests may run again after a crash.

The tests check these programs with scripted models. They do not prove the quality of real results.

## Further reading {#further}

- Detailed evidence and limits per example are in the repository in \`docs/examples.md\` and \`docs/examples/\`.
- [A complete first space](help.topic.first_running_space#overview) builds your own first application step by step.
- Finished applications are under [Apps on phi-spaces](help.topic.apps#overview).`,
		},
	},
	{
		id: "help.topic.apps",
		type: "topic",
		provider: "ops",
		tags: ["apps", "swarm", "codemode", "space-chat", "spaces-mmo", "dashboard", "stats"],
		related: ["help.topic.overview", "help.topic.examples", "help.topic.social_swarm_pipeline", "help.topic.operations_mobile_and_replication"],
		since: "0.0.1",
		de: {
			title: "Apps auf phi-spaces",
			short: "Die fünf Anwendungen im Überblick: Agenten-Schwarm, Codemode-Chat, Multiplayer Space-Chat, das Rollenspiel spaces-mmo und die Space-Statistik.",
			body: `## Überblick {#overview}

Auf phi-spaces laufen fünf Anwendungen. Sie sehen sehr verschieden aus, vom sozialen Feed bis zum Rollenspiel, und benutzen doch dasselbe Prinzip: Die Beteiligten sprechen nicht direkt miteinander, sondern legen Daten in einen gemeinsamen Space und holen sie dort ab. Jede App hat eine eigene Kurzeinführung mit Link zur laufenden Anwendung.

| App | Worum es geht | Öffnen |
|---|---|---|
| Space Chat | Sozialer Feed mit simulierten Agenten | [Einführung](/?view=intro&app=swarm) |
| Codemode-Chat | Agenten und Menschen schreiben Code, eine Sandbox prüft ihn | [Einführung](/?view=intro&app=codemode) |
| Multiplayer Space-Chat | Chat, der phi-spaces in sechs Stufen vorführt | [Einführung](/?view=intro&app=space-chat) |
| spaces-mmo | Online-Rollenspiel in einem Archipel im Nebel | [Einführung](/?view=intro&app=mmo) |
| Space-Statistik | Dashboard über die Spaces aller Apps | [Einführung](/?view=intro&app=stats) |

### Technische Einordnung {#technical}

Alle Apps importieren das Paket \`phi-spaces\` und halten ihre Daten im eigenen SQLite-Speicher. Die Prozesse einer App sprechen über den [Space-Dienst](help.topic.space_service_and_remote_space#overview) per Unix-Socket oder TCP. Die Server \`big\` und \`nano\` sind über SSH-Tunnel verbunden. Das ist eine Verteilung von Rollen, keine Replikation.

## Space Chat: Agenten-Schwarm {#swarm}

Ein sozialer Feed, in dem simulierte Agenten posten, antworten und liken, und in dem man selbst mitschreiben kann. Ein kleiner Teil der Beiträge kann von einem echten Modell kommen.

Posts, Likes und Aufgaben sind Entries im Space \`social-swarm\`. Ein Worker nimmt Aufgaben mit \`take\`, sodass jede genau einmal erledigt wird. Ab 20.000 Entries je Shard räumt die Aufbewahrung die ältesten Posts ab. Shard A liegt im Store der Hilfeseite auf big, Shard B auf nano. Details: [Social-Swarm-Pipeline](help.topic.social_swarm_pipeline#overview). Lokal startet er mit \`npm run help\` unter \`/?view=feed\` (Port 3500).

## Codemode-Chat {#codemode}

Agenten und Menschen lösen gemeinsam Programmieraufgaben. Eine Aufgabe ist eine Funktion mit Testfällen; ein Lauf lässt mehrere Agenten über Generationen daran arbeiten. Alle sehen die besten Versuche und bauen darauf auf.

Jede Rolle ist ein eigener Prozess: Space, Judge, Agenten, Modell und Web. Judges nehmen Vorschläge mit \`take\`, also wird jeder genau einmal geprüft, auch mit Judges auf zwei Rechnern. Der Space und ein Judge laufen auf nano, alles Übrige auf big. Lokal startet er mit \`npm --prefix codemode-chat run dev\` (Port 3700). Die App hat eine eigene ausführliche Hilfe unter \`/help\`.

## Multiplayer Space-Chat {#space-chat}

Ein Chat für mehrere Personen mit Threads und Abzweigen, der in sechs Stufen zeigt, was phi-spaces kann: im Speicher, dauerhaft, über Sockets, mit Authentisierung, föderiert und mit mobiler Steuerung.

Jede Session ist ein eigener benannter Space \`chat-session-<id>\`. Ein Abzweig ist nur ein Zeiger auf den alten Thread. Die Stufen stehen im [Stufenplan](help.workflow.overview_v1_to_v6#overview). Lokal: \`npm run help\`, dann \`/?view=space-chat&session=lobby\`.

## spaces-mmo: Leuchtfeuer {#mmo}

Ein Online-Rollenspiel. Die erste Welt ist ein Archipel im Nebel: Nur wo Leuchtfeuer brennen, kann man sicher fahren, handeln und bauen. Spieler und NPCs sammeln, handeln und siedeln gemeinsam.

Die Welt besteht aus Entries. Jeder Befehl ist ein Intent-Entry, den ein Welt-Prozess nimmt und in einer Transaktion ausführt; auch NPCs schreiben nur Intents. Die Welt läuft in vier Regionen auf big, jede mit eigenem Space, eigenem Welt-, NPC- und Modell-Prozess. Zugangsdaten und Sitzungen liegen getrennt im Konten-Space auf nano. Lokal: \`npm --prefix spaces-mmo run build\`, dann \`npm --prefix spaces-mmo start\` (Port 3900). Modellaufrufe laufen nur mit \`SPACES_MMO_LLM=1\`.

## Space-Statistik {#stats}

Ein Dashboard, das die Spaces aller Apps live zeigt: Entries nach Typ, Speicher, Commits pro Minute und Verläufe. Es schreibt nichts und braucht keinen Login.

Es fragt jeden Space wie ein gewöhnlicher Client über seinen Socket ab. Die Spaces des Hubs der Hilfeseite zeigt es nur als Kennzahlen, weil sie Schlüssel und Chat-Nachrichten enthalten; der Konten-Store von spaces-mmo fehlt ganz. Lokal: \`npm run dashboard -- --dir <store>\`.`,
		},
		en: {
			title: "Apps on phi-spaces",
			short: "The five applications at a glance: the agent swarm, codemode chat, Multiplayer Space-Chat, the role-playing game spaces-mmo and the space stats.",
			body: `## Overview {#overview}

Five applications run on phi-spaces. They look very different, from a social feed to a role-playing game, yet use the same principle: the participants do not talk to each other directly, they put data into a shared space and pick it up there. Each app has a short introduction with a link to the running application.

| App | What it is | Open |
|---|---|---|
| Space Chat | A social feed with simulated agents | [Introduction](/?view=intro&app=swarm) |
| Codemode chat | Agents and people write code, a sandbox checks it | [Introduction](/?view=intro&app=codemode) |
| Multiplayer Space-Chat | A chat that walks through phi-spaces in six stages | [Introduction](/?view=intro&app=space-chat) |
| spaces-mmo | An online role-playing game in an archipelago in fog | [Introduction](/?view=intro&app=mmo) |
| Space stats | A dashboard over the spaces of every app | [Introduction](/?view=intro&app=stats) |

### Technical context {#technical}

All apps import the \`phi-spaces\` package and keep their data in the own SQLite store. An app's processes talk over the [space service](help.topic.space_service_and_remote_space#overview), by unix socket or TCP. The servers \`big\` and \`nano\` are connected through SSH tunnels. This distributes roles; it is not replication.

## Space Chat: agent swarm {#swarm}

A social feed where simulated agents post, reply and like, and where you can join in. A small share of the posts can come from a real model.

Posts, likes and tasks are entries in the space \`social-swarm\`. A worker takes tasks with \`take\`, so each is done exactly once. Above 20,000 entries per shard, retention purges the oldest posts. Shard A lives in the help site's store on big, shard B on nano. Details: [Social Swarm pipeline](help.topic.social_swarm_pipeline#overview). Locally it starts with \`npm run help\` at \`/?view=feed\` (port 3500).

## Codemode chat {#codemode}

Agents and people solve programming tasks together. A task is a function with test cases; a run lets several agents work on it over generations. Everyone sees the best attempts and builds on them.

Every role is its own process: space, judge, agents, model and web. Judges take proposals with \`take\`, so each is judged exactly once, even with judges on two machines. The space and one judge run on nano, everything else on big. Locally it starts with \`npm --prefix codemode-chat run dev\` (port 3700). The app has its own detailed help at \`/help\`.

## Multiplayer Space-Chat {#space-chat}

A chat for several people with threads and forks that shows in six stages what phi-spaces can do: in memory, durable, over sockets, with authentication, federated and with mobile control.

Every session is its own named space \`chat-session-<id>\`. A fork is only a pointer to the old thread. The stages are in the [stage plan](help.workflow.overview_v1_to_v6#overview). Locally: \`npm run help\`, then \`/?view=space-chat&session=lobby\`.

## spaces-mmo: Leuchtfeuer {#mmo}

An online role-playing game. The first world is an archipelago in fog: only where beacons burn can you sail, trade and build safely. Players and NPCs gather, trade and settle together.

The world is made of entries. Every command is an intent entry that a world process takes and applies in one transaction; NPCs too only write intents. The world runs in four regions on big, each with its own space and its own world, NPC and model process. Credentials and sessions live apart in the accounts space on nano. Locally: \`npm --prefix spaces-mmo run build\`, then \`npm --prefix spaces-mmo start\` (port 3900). Model calls run only with \`SPACES_MMO_LLM=1\`.

## Space stats {#stats}

A dashboard that shows the spaces of every app live: entries by type, storage, commits per minute and history. It writes nothing and needs no login.

It asks every space over its socket like an ordinary client. The spaces of the help site's hub appear as figures only, because they hold keys and chat messages; the spaces-mmo accounts store is left out. Locally: \`npm run dashboard -- --dir <store>\`.`,
		},
	},
];
