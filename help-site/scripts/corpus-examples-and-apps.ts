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

Wer nur einen Eindruck will, startet \`npm run example:pipeline\` für die Zusammenarbeit ohne Agenten und \`npm run example:chat\` für drei Agenten im Gespräch. Alle Befehle gelten im Wurzelverzeichnis des Repositorys. Die Dateien des Pakets (\`examples/\`, \`agent/\`) liegen dort in \`spaces/\`.

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

- Ausführliche Nachweise und Grenzen je Beispiel stehen im Repository in \`docs/examples.en.md\` und \`docs/examples/\`.
- Eine eigene erste Anwendung baut [Ein vollständiger erster Space](help.topic.first_running_space#overview) Schritt für Schritt auf.
- Fertige Anwendungen stehen unter [Apps auf phi-spaces](help.topic.apps#overview).`,
		},
		en: {
			title: "Examples: what exists and how to run it",
			short: "Every runnable example at a glance: what it shows, how to start it, and which ones need a real model and cost tokens.",
			body: `## Overview {#overview}

The examples are small programs that show phi-spaces at work. Most run straight away, without a model or network, and finish within seconds. Some let agents work together, with a scripted model giving the answers. Only the examples under [With a real model](#live) cost tokens.

For a first impression, start \`npm run example:pipeline\` for cooperation without agents and \`npm run example:chat\` for three agents in conversation. All commands apply in the repository root. The package's files (\`examples/\`, \`agent/\`) are in \`spaces/\` there.

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

- Detailed evidence and limits per example are in the repository in \`docs/examples.en.md\` and \`docs/examples/\`.
- [A complete first space](help.topic.first_running_space#overview) builds your own first application step by step.
- Finished applications are under [Apps on phi-spaces](help.topic.apps#overview).`,
		},
	},
	{
		id: "help.topic.apps",
		type: "topic",
		provider: "ops",
		tags: ["apps", "swarm", "codemode", "space-chat", "spaces-mmo", "spaces-files", "dashboard", "stats"],
		related: ["help.topic.overview", "help.topic.examples", "help.topic.social_swarm_pipeline", "help.topic.spaces_files", "help.topic.operations_mobile_and_replication"],
		since: "0.0.1",
		de: {
			title: "Apps auf phi-spaces",
			short: "Die sechs Anwendungen im Überblick: Agenten-Schwarm, Codemode-Chat, Multiplayer Space-Chat, das Rollenspiel spaces-mmo, das Dateisystem spaces-files und die Space-Statistik.",
			body: `## Überblick {#overview}

Auf phi-spaces laufen sechs Anwendungen. Sie sehen sehr verschieden aus, vom sozialen Feed über das Rollenspiel bis zum Dateisystem, und benutzen doch dasselbe Prinzip: Die Beteiligten sprechen nicht direkt miteinander, sondern legen Daten in einen gemeinsamen Space und holen sie dort ab. Jede App hat eine eigene Kurzeinführung mit Link zur laufenden Anwendung.

| App | Worum es geht | Öffnen |
|---|---|---|
| Space Chat | Sozialer Feed mit simulierten Agenten | [Einführung](/?view=intro&app=swarm) |
| Codemode-Chat | Agenten und Menschen schreiben Code, eine Sandbox prüft ihn | [Einführung](/?view=intro&app=codemode) |
| Multiplayer Space-Chat | Chat, der phi-spaces in sechs Stufen vorführt | [Einführung](/?view=intro&app=space-chat) |
| spaces-mmo | Online-Rollenspiel in einem Archipel im Nebel | [Einführung](/?view=intro&app=mmo) |
| spaces-files | Dateisystem für Menschen und Agenten mit Rechten im Zanzibar-Stil | [Einführung](/?view=intro&app=files) |
| Space-Statistik | Dashboard über die Spaces aller Apps | [Einführung](/?view=intro&app=stats) |

### Technische Einordnung {#technical}

Alle Apps importieren das Paket \`phi-spaces\` und halten ihre Daten im eigenen SQLite-Speicher. Die Prozesse einer App sprechen über den [Space-Dienst](help.topic.space_service_and_remote_space#overview) per Unix-Socket oder TCP. Die Server \`big\` und \`nano\` sind über SSH-Tunnel verbunden. Das ist eine Verteilung von Rollen, keine Replikation. Seit 2026-11-12 ist jeder Space-Prozess auf big und nano der Rust-Server \`phi-space-server\` ([Rust-Portierung](help.topic.architecture_layers#rust-port)).

## Space Chat: Agenten-Schwarm {#swarm}

Ein sozialer Feed, in dem simulierte Agenten posten, antworten und liken, und in dem man selbst mitschreiben kann. Ein kleiner Teil der Beiträge kann von einem echten Modell kommen.

Posts, Likes und Aufgaben sind Entries im Space \`social-swarm\`. Ein Worker nimmt Aufgaben mit \`take\`, sodass jede genau einmal erledigt wird. Ab 20.000 Entries je Shard räumt die Aufbewahrung die ältesten Posts ab. Der Swarm-Space ist ein eigener Prozess (\`phi-space-server\`, Container \`swarm-space\` auf big, \`swarm-space-nano\` auf nano); der Hub der Hilfeseite und die Shard-Engine sind seine Clients. Shard A liegt auf big, Shard B auf nano. Details: [Social-Swarm-Pipeline](help.topic.social_swarm_pipeline#overview). Lokal startet er mit \`npm run help\` unter \`/?view=feed\` (Port 3500).

## Codemode-Chat {#codemode}

Agenten und Menschen lösen gemeinsam Programmieraufgaben. Eine Aufgabe ist eine Funktion mit Testfällen; ein Lauf lässt mehrere Agenten über Generationen daran arbeiten. Alle sehen die besten Versuche und bauen darauf auf.

Jede Rolle ist ein eigener Prozess: Space, Judge, Agenten, Modell und Web. Judges nehmen Vorschläge mit \`take\`, also wird jeder genau einmal geprüft, auch mit Judges auf zwei Rechnern. Der Space (der Rust-Server) und ein Judge laufen auf nano, alles Übrige auf big. Lokal startet er mit \`npm --prefix codemode-chat run dev\` (Port 3700). Die App hat eine eigene ausführliche Hilfe unter \`/help\`.

## Multiplayer Space-Chat {#space-chat}

Ein Chat für mehrere Personen mit Threads und Abzweigen, der in sechs Stufen zeigt, was phi-spaces kann: im Speicher, dauerhaft, über Sockets, mit Authentisierung, föderiert und mit mobiler Steuerung.

Jede Session ist ein eigener benannter Space \`chat-session-<id>\`. Ein Abzweig ist nur ein Zeiger auf den alten Thread. Die Stufen stehen im [Stufenplan](help.workflow.overview_v1_to_v6#overview). Lokal: \`npm run help\`, dann \`/?view=space-chat&session=lobby\`.

## spaces-mmo: Leuchtfeuer {#mmo}

Ein Online-Rollenspiel. Die erste Welt ist ein Archipel im Nebel: Nur wo Leuchtfeuer brennen, kann man sicher fahren, handeln und bauen. Spieler und NPCs sammeln, fischen, bestellen Felder, halten Tiere und stellen Dinge her, handeln auf Märkten und in Läden, bauen Hütten und Wege und besiedeln gemeinsam die Inseln. Die Karte gibt es in 2D und 3D.

Die Welt besteht aus Entries. Jeder Befehl ist ein Intent-Entry, den ein Welt-Prozess nimmt und in einer Transaktion ausführt; auch NPCs schreiben nur Intents. Die Welt läuft in vier Regionen auf big, jede mit eigenem Space, eigenem Welt-, NPC- und Modell-Prozess. Seit 2026-11-11 sind Space-, Welt-, NPC- und Web-Prozess Rust-Programme (\`phi-space-server\`, \`mmo-world\`, \`mmo-npc\`, \`mmo-web\`); nur der Modell-Prozess, der mit dem Sprachmodell spricht, bleibt TypeScript. Zugangsdaten und Sitzungen liegen getrennt im Konten-Space auf nano. Lokal: \`npm --prefix spaces-mmo run build\`, dann \`npm --prefix spaces-mmo start\` (Port 3900). Modellaufrufe laufen nur mit \`SPACES_MMO_LLM=1\`.

## spaces-files: Dateien für Menschen und Agenten {#files}

Ein Dateisystem, in dem Menschen und einzelne Agenten-Instanzen an denselben Dateien arbeiten, jeder mit eigener Identität. Rechte (owner, editor, viewer) gibt man direkt oder über Gruppen; sie werden nach unten vererbt und bei jeder Operation neu geprüft, ein Entzug gilt sofort.

Jeder Tenant hat einen privaten Space mit Akteuren, Verzeichnissen, Relationen, Quittungen und Audit; die Dateiinhalte liegen verschlüsselt als Blobs daneben. Die Tenant-Spaces sieht nur der Dateidienst, deshalb fehlt die App in der Space-Statistik. Auf big läuft sie in einem Container (Dienst und Rust-Space-Prozess \`files-space\`) unter spaces-files.eibrain.org, mit täglicher Sicherung nach nano. Lokal: \`npm run spaces-files\` (\`FILES_MEM=1\` im Speicher). Ausführlich: [spaces-files](help.topic.spaces_files#overview).

## Space-Statistik {#stats}

Ein Dashboard, das die Spaces aller Apps live zeigt: Entries nach Typ, Speicher, Commits pro Minute und Verläufe. Es schreibt nichts und braucht keinen Login.

Es fragt jeden Space wie ein gewöhnlicher Client über seinen Socket ab. Die Spaces des Hubs der Hilfeseite zeigt es nur als Kennzahlen, weil sie Schlüssel und Chat-Nachrichten enthalten; der Konten-Store von spaces-mmo fehlt ganz. Lokal: \`npm run dashboard -- --dir <store>\`.`,
		},
		en: {
			title: "Apps on phi-spaces",
			short: "The six applications at a glance: the agent swarm, codemode chat, Multiplayer Space-Chat, the role-playing game spaces-mmo, the filesystem spaces-files and the space stats.",
			body: `## Overview {#overview}

Six applications run on phi-spaces. They look very different, from a social feed and a role-playing game to a filesystem, yet use the same principle: the participants do not talk to each other directly, they put data into a shared space and pick it up there. Each app has a short introduction with a link to the running application.

| App | What it is | Open |
|---|---|---|
| Space Chat | A social feed with simulated agents | [Introduction](/?view=intro&app=swarm) |
| Codemode chat | Agents and people write code, a sandbox checks it | [Introduction](/?view=intro&app=codemode) |
| Multiplayer Space-Chat | A chat that walks through phi-spaces in six stages | [Introduction](/?view=intro&app=space-chat) |
| spaces-mmo | An online role-playing game in an archipelago in fog | [Introduction](/?view=intro&app=mmo) |
| spaces-files | A filesystem for people and agents with Zanzibar-style rights | [Introduction](/?view=intro&app=files) |
| Space stats | A dashboard over the spaces of every app | [Introduction](/?view=intro&app=stats) |

### Technical context {#technical}

All apps import the \`phi-spaces\` package and keep their data in the own SQLite store. An app's processes talk over the [space service](help.topic.space_service_and_remote_space#overview), by unix socket or TCP. The servers \`big\` and \`nano\` are connected through SSH tunnels. This distributes roles; it is not replication. Since 2026-11-12 every Space process on big and nano is the Rust server \`phi-space-server\` ([Rust port](help.topic.architecture_layers#rust-port)).

## Space Chat: agent swarm {#swarm}

A social feed where simulated agents post, reply and like, and where you can join in. A small share of the posts can come from a real model.

Posts, likes and tasks are entries in the space \`social-swarm\`. A worker takes tasks with \`take\`, so each is done exactly once. Above 20,000 entries per shard, retention purges the oldest posts. The swarm Space is a process of its own (\`phi-space-server\`, container \`swarm-space\` on big, \`swarm-space-nano\` on nano); the help site's hub and the shard engine are its clients. Shard A is on big, shard B on nano. Details: [Social Swarm pipeline](help.topic.social_swarm_pipeline#overview). Locally it starts with \`npm run help\` at \`/?view=feed\` (port 3500).

## Codemode chat {#codemode}

Agents and people solve programming tasks together. A task is a function with test cases; a run lets several agents work on it over generations. Everyone sees the best attempts and builds on them.

Every role is its own process: space, judge, agents, model and web. Judges take proposals with \`take\`, so each is judged exactly once, even with judges on two machines. The space (the Rust server) and one judge run on nano, everything else on big. Locally it starts with \`npm --prefix codemode-chat run dev\` (port 3700). The app has its own detailed help at \`/help\`.

## Multiplayer Space-Chat {#space-chat}

A chat for several people with threads and forks that shows in six stages what phi-spaces can do: in memory, durable, over sockets, with authentication, federated and with mobile control.

Every session is its own named space \`chat-session-<id>\`. A fork is only a pointer to the old thread. The stages are in the [stage plan](help.workflow.overview_v1_to_v6#overview). Locally: \`npm run help\`, then \`/?view=space-chat&session=lobby\`.

## spaces-mmo: Leuchtfeuer {#mmo}

An online role-playing game. The first world is an archipelago in fog: only where beacons burn can you sail, trade and build safely. Players and NPCs gather, fish, farm, keep animals and craft, trade at markets and stores, build huts and roads and settle the islands together. The map can be shown in 2D or 3D.

The world is made of entries. Every command is an intent entry that a world process takes and applies in one transaction; NPCs too only write intents. The world runs in four regions on big, each with its own space and its own world, NPC and model process. Since 2026-11-11 space, world, NPC and web processes are Rust programs (\`phi-space-server\`, \`mmo-world\`, \`mmo-npc\`, \`mmo-web\`); only the model process, which talks to the language model, stays TypeScript. Credentials and sessions live apart in the accounts space on nano. Locally: \`npm --prefix spaces-mmo run build\`, then \`npm --prefix spaces-mmo start\` (port 3900). Model calls run only with \`SPACES_MMO_LLM=1\`.

## spaces-files: files for people and agents {#files}

A filesystem in which people and individual agent instances work on the same files, each with an identity of its own. Rights (owner, editor, viewer) are given directly or through groups; they are inherited downwards and checked afresh on every operation, and a revocation holds at once.

Every tenant has a private space with actors, directories, relations, receipts and audit; the file contents lie beside it as encrypted blobs. Only the file service sees the tenant spaces, which is why the app is missing from the space stats. On big it runs in one container (the service and the Rust space process \`files-space\`) at spaces-files.eibrain.org, with a daily backup to nano. Locally: \`npm run spaces-files\` (\`FILES_MEM=1\` in memory). In detail: [spaces-files](help.topic.spaces_files#overview).

## Space stats {#stats}

A dashboard that shows the spaces of every app live: entries by type, storage, commits per minute and history. It writes nothing and needs no login.

It asks every space over its socket like an ordinary client. The spaces of the help site's hub appear as figures only, because they hold keys and chat messages; the spaces-mmo accounts store is left out. Locally: \`npm run dashboard -- --dir <store>\`.`,
		},
	},
	{
		id: "help.topic.spaces_files",
		type: "topic",
		provider: "ops",
		tags: ["apps", "spaces-files", "files", "zanzibar", "permissions", "agents", "groups", "receipts"],
		related: ["help.topic.apps", "help.topic.leases_and_transactions", "help.topic.gate_auth_grants_and_recovery", "help.topic.agent_tools_and_replay"],
		since: "0.0.1",
		de: {
			title: "spaces-files: Dateien für Menschen und Agenten",
			short: "Ein Dateisystem mit Rechten im Zanzibar-Stil: was es ist, warum Agenten eigene Identitäten brauchen, wozu man es nutzt und wie es auf phi-spaces gebaut ist.",
			body: `## Überblick {#overview}

spaces-files ist ein Dateisystem auf phi-spaces für **Menschen und einzelne Agenten-Instanzen**. Beide arbeiten an denselben Dateien, jeder unter seiner eigenen Identität und mit eigenen Rechten. Die Rechte folgen dem Modell von Googles Zanzibar: Sie sind Beziehungen („Gruppe Nord ist editor von dispatch“), werden bei jeder Operation neu ausgewertet, und ein Entzug gilt für jede spätere Prüfung. Was von Zanzibar übernommen ist und was anders gelöst ist, steht unter [Zanzibar: Ausgangspunkt und Umsetzung](help.topic.spaces_files#zanzibar).

| Frage | Kurz |
|---|---|
| Was | Dateien und Verzeichnisse in Workspaces, mit Rollen owner, editor, viewer, Gruppen und Vererbung |
| Warum | Agenten brauchen eine eigene, entziehbare Identität statt des Kontos eines Menschen |
| Wozu | Menschen und Agenten teilen Arbeitsstände, ohne einander zu überschreiben oder zu viel zu sehen |
| Wie | Ein privater Space je Tenant für Metadaten und Rechte, verschlüsselte Blobs für die Inhalte |
| Wo | Auf big unter spaces-files.eibrain.org; lokal mit \`npm run spaces-files\` |

## Was es ist {#what}

Die Begriffe:

- **Tenant:** ein abgeschlossener Kunde oder ein Team mit einem eigenen, privaten Space. Tenants sehen einander nicht.
- **Akteur:** ein Mensch (user) oder eine Agenten-Instanz (agent). Jeder Akteur hat eine stabile ID und ein **Home**, einen eigenen Workspace, der mit ihm in derselben Transaktion entsteht.
- **Workspace:** ein benanntes Verzeichnis auf oberster Ebene, z. B. \`dispatch\`. Darunter liegen Verzeichnisse und Dateien, Text oder binär.
- **Rollen:** owner darf Rechte vergeben und bearbeiten, editor darf bearbeiten und lesen, viewer darf lesen. Eine Rolle kommt aus einem direkten Grant, aus einem Grant an eine Gruppe (auch verschachtelte Gruppen) oder ist von einem Verzeichnis darüber geerbt.
- **Tenant-Administrator:** verwaltet Akteure, Gruppen und Workspaces seines Tenants; Dateirechte hat er dadurch nicht.
- **Host-Operator:** betreibt den Dienst: Tenants, Schlüssel, Sicherungen, Grenzen. Er arbeitet über eine eigene lokale Schnittstelle ohne Dateioperationen.

Eine Datei hat Versionen. Gespeichert wird immer „über Version n“: Hat inzwischen jemand anderes Version n+1 gespeichert, kommt ein Versionskonflikt zurück, und der Text der anderen geht nicht verloren.

## Warum {#why}

Sobald Agenten mitarbeiten, reichen die üblichen Lösungen nicht:

- **Ein Agent mit dem Konto eines Menschen** kann alles, was dieser Mensch kann, und im Nachhinein weiß niemand, wer was getan hat. In spaces-files ist jede Agenten-Instanz ein eigener Akteur: gebunden an den Agenten-Host, der sie betreibt, und ihre Agent-ID. Ihre Rechte sind sichtbar und einzeln entziehbar.
- **Ein Entzug muss sofort gelten.** Wird Lea aus der Gruppe Nord entfernt, darf ihr schon offener Editor nicht mehr speichern, und wenn Nord ihr einziger Zugang war, verschwindet \`dispatch\` aus ihrer Liste: Jeder Pfad darin antwortet dann genau wie ein Pfad, den es nicht gibt. Deshalb prüft jede Operation die Beziehungen neu, statt sich auf eine Sitzung zu verlassen.
- **Gleichzeitige Arbeit** von Menschen und Agenten erzeugt Konflikte. Versionen machen sie sichtbar, statt eine Seite still zu überschreiben.
- **Netze verlieren Antworten.** Jede ändernde Operation trägt eine signierte Operation-ID; eine Wiederholung nach verlorener Antwort liefert die gespeicherte Quittung statt die Änderung zweimal auszuführen.

## Wozu {#purpose}

- Ein Team und sein Planungs-Agent arbeiten am selben Briefing; der Agent sieht die Änderungen der Menschen, bevor er weiterschreibt.
- Jeder Agent bekommt ein eigenes Home für Notizen und Zwischenstände, das niemand sonst sieht, bis er es teilt.
- Ein Prüf-Agent bekommt viewer auf einen Workspace und kann lesen, aber nichts ändern.
- Eine Gruppe vergibt Rechte an viele auf einmal; wer die Gruppe verlässt, verliert genau den Zugang, der über sie kam.
- Read-only-Mounts (\`@name\`) zeigen Dateien eines anderen Systems mit dessen Rechten, ohne sie zu kopieren.

## Wie es funktioniert {#how}

### Rechte als Beziehungen {#rights}

Rechte sind Tupel im Space des Tenants, zum Beispiel:

\`\`\`text
group:north#member@user:lea
directory:dispatch#editor@group:north#member
directory:dispatch#owner@agent:planner-17
\`\`\`

Lea ist Mitglied von Nord, Nord ist editor von \`dispatch\`, der Agent planner-17 ist owner. Die Rechte gelten nach unten für alles in \`dispatch\`. Die effektiven Rechte sind die Vereinigung aller Wege; ein Entzug nimmt nur diesen einen Weg weg. Sichtbar ist ein Workspace genau dann, wenn man viewer auf seiner Wurzel hat.

### Speicher und Inhalte {#store}

Der Space des Tenants hält Akteure, Knoten (Verzeichnisse, Dateien), Relationen, Quittungen und das Audit, alles im eigenen SQLite-Speicher von phi-spaces. Eine Operation läuft in der Warteschlange ihres Tenants und in **einer** Transaktion: Rechte prüfen, ändern, Quittung und Audit schreiben. Die Dateiinhalte liegen nicht im Space, sondern als Blobs daneben, je Version eine Datei, versiegelt mit AES-256-GCM. Der Space hält nur den Verweis auf die aktuelle Version. Die Tenant-Spaces werden nie nach außen gegeben: Ein generisches Space-Werkzeug würde die Rechteprüfung umgehen.

### Zugänge {#access}

- **Browser:** über HTTPS. Anmeldung mit einem OpenID-Anbieter oder, wo keiner eingerichtet ist (derzeit auf big), mit Benutzername und Passwort. Das Passwort setzt der Host-Operator; gespeichert wird nur ein scrypt-Hash. Die Sitzung ist ein \`__Host-\`-Cookie (Secure, HttpOnly, SameSite=Strict), jede Änderung prüft Herkunft und CSRF-Token.
- **Agenten:** Ein Agenten-Host verbindet sich über einen eigenen Unix-Socket je Host und Tenant oder von einem anderen Rechner über TLS mit dem Schlüsselbeweis von phi-spaces. Der Host nennt für jedes Gespräch die Agent-ID; zusammen mit dem Host ergibt das die Identität des Akteurs. \`client/agent-client.ts\` liefert die Werkzeuge mit relativen Pfaden.
- **Administration:** Der Tenant-Administrator arbeitet im Browser; der Host-Operator über einen Socket im Zustandsverzeichnis (\`operator create-tenant\`, \`set-password\`, \`backup\`, …).

### Betrieb und Wiederherstellung {#operations}

Der Dienst und sein Space-Prozess sind getrennte Prozesse; den Space-Prozess gibt es in TypeScript und in Rust (\`files-space\`). Sicherungen sind verschlüsselte Archive, je eines für die Daten und für den Bereitstellungs-Zustand (Sitzungen, Schlüssel, Passwörter). Eine Wiederherstellung schaltet die Sitzungs-Epoche weiter, sodass keine alte Sitzung überlebt. Für einen zweiten Standort gibt es einen Standby mit Fencing und Promotion; er ist getestet, aber auf big nicht eingeschaltet.

## Zanzibar: Ausgangspunkt und Umsetzung {#zanzibar}

### Ausgangspunkt {#zanzibar-origin}

**Zanzibar** ist Googles System für Berechtigungen, beschrieben 2019 im Paper *Zanzibar: Google's Consistent, Global Authorization System* (USENIX ATC). Es entscheidet für Dienste wie Drive, Calendar, Photos und YouTube, wer was darf. Seine Kernideen:

- **Rechte sind Relationstupel** der Form \`objekt#relation@subjekt\`, z. B. \`doc:brief#editor@user:lea\`. Das Subjekt kann selbst eine Menge sein (\`group:nord#member\`), so entstehen Gruppen und verschachtelte Gruppen.
- **Regeln leiten Rechte ab** („Userset Rewrites“): Wer editor ist, ist auch viewer; wer Rechte auf einem Ordner hat, hat sie auf dessen Inhalt.
- **Jede Anfrage wird neu geprüft** (Check), statt Rechte in Sitzungen oder Tokens zu kopieren.
- **Konsistenz gegen das „New Enemy Problem“:** Wird jemandem ein Recht entzogen und danach neuer Inhalt hinzugefügt, darf er den neuen Inhalt nie sehen. Zanzibar ordnet dazu Änderungen und Prüfungen über Spanner-Zeitstempel und gibt Clients „Zookies“ mit, die eine Mindestaktualität für spätere Prüfungen festhalten.

Der zweite Ausgangspunkt ist **Zontallys Agenten-Dateisystem** (Blogbeitrag „Why we built a Zanzibar agent filesystem“): Jede angemeldete Sitzung bekommt ein eigenes Home, jede Operation wertet die Beziehungen neu aus, Verzeichnisrechte werden vererbt. Von dort stammen das automatisch angelegte Home je Akteur, die vererbten Verzeichnisrechte und die eigene Identität jeder Agenten-Instanz.

### Was übernommen ist {#zanzibar-adopted}

| Zanzibar | spaces-files |
|---|---|
| Relationstupel \`objekt#relation@subjekt\` | Dieselbe Form, gespeichert als Entries im Space des Tenants: Objekte tenant, group, directory, file; Relationen admin, member, owner, editor, viewer |
| Usersets als Subjekte | \`group:nord#member\` als Subjekt eines Grants und als Mitglied einer anderen Gruppe |
| Rewrite-Regeln | Fest im Code: owner umfasst editor, editor umfasst viewer; Rechte erben über den Eltern-Verweis jedes Knotens bis zur Wurzel des Workspaces |
| Check bei jeder Anfrage | Jede Operation prüft in der Warteschlange ihres Tenants, in derselben Transaktion wie die Änderung; kein Entscheidungs-Cache |
| Entzug gilt für jede spätere Prüfung | Ein Entzug ist mit seinem Commit wirksam; die nächste Operation, auch aus einem schon offenen Editor, sieht ihn |

### Was anders ist {#zanzibar-different}

- **Reihenfolge ohne Zookies.** Zanzibar ist global verteilt und braucht deshalb Zeitstempel und Zookies. spaces-files hat je Tenant genau eine Instanz, die Operationen annimmt, und eine Warteschlange: Jede Prüfung kommt nach jedem früheren Commit, das New Enemy Problem kann so nicht entstehen. Für Replikate sind kausale Revisions-Token festgelegt („nicht älter als Revision n lesen“); sie würden erst nötig, wenn Replikate Lesezugriffe bedienten, und das tun sie nicht.
- **Kein frei konfigurierbares Schema.** Zanzibar lässt jeden Dienst seine Namespaces und Regeln selbst definieren. Hier sind die Relationen und ihre Ableitung fest; unbekannte Relationen und falsche Subjekt-Objekt-Paare werden schon beim Schreiben abgelehnt.
- **Begrenzte Auswertung statt Leopard-Index.** Zanzibar beschleunigt tief verschachtelte Gruppen mit einem eigenen Index (Leopard). Hier ist die Verschachtelung begrenzt (\`maxGroupDepth\`, Standard 4), Zyklen werden beim Eintragen abgelehnt, und jede Entscheidung hat ein Arbeitsbudget (sonst \`capacityExceeded\`). Gemessen kostet eine Verzeichnisebene etwa 3,5 Lookups.
- **Sichtbarkeit je Workspace.** Wer viewer auf der Wurzel eines Workspaces hat, sieht ihn; wer nicht, bekommt für jeden Pfad darin dieselbe Antwort wie für einen Pfad, den es nicht gibt (\`notFound\`). So verrät eine Ablehnung nicht, dass etwas existiert.
- **Zusätzliche Regeln für einen Dateidienst:** Jede Workspace-Wurzel behält mindestens einen direkten owner, jeder Tenant mindestens einen Administrator (\`lastOwner\`, \`lastAdmin\`); die Rolle Tenant-Administrator gibt keine Dateirechte; ein Agent ist an seinen Agenten-Host und seine Agent-ID gebunden.
- **Maßstab.** Zanzibar verwaltet Billionen Tupel für viele Dienste; spaces-files hält die Tupel jedes Tenants in dessen eigenem Space auf einem Host. Mehrere Hosts mit je eigenen Tenants sind als mögliche Erweiterung notiert.

## Wo es läuft {#where}

- **big:** ein Container (Dienst und Rust-Space-Prozess) hinter nginx unter https://spaces-files.eibrain.org. Täglich gehen die verschlüsselten Sicherungen nach nano, in ein Konto, das nur hinzufügen, nicht löschen darf.
- **Lokal:** \`npm run spaces-files\` (\`FILES_MEM=1\` hält alles im Speicher), Tests mit \`npm run test:spaces-files\`.

## Grenzen {#limits}

- Ein Tenant hat genau eine Instanz, die ihn verwaltet; das ist die Grundlage der Reihenfolge-Garantie. Mehrere Hosts für viele Tenants sind als mögliche Erweiterung notiert.
- Die Space-Statistik zeigt die App bewusst nicht, weil sie die Tenant-Spaces offenlegen würde.
- Auf big gibt es derzeit Passwort-Anmeldung und keine Agenten-Hosts auf anderen Rechnern; beides ist gebaut und lässt sich einschalten.

## Weiterlesen {#further}

- Quellen: [Zanzibar-Paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/), [Zontallys Begründung](https://www.zontally.com/blogs/technical/why-we-built-a-zanzibar-agent-filesystem).
- Im Repository: \`spaces-files/README.md\` (Stand und Nachweise), \`docs/zanzibar-agent-filesystem-plan.en.md\` (Plan und Entscheidungen), \`spaces-files/docs/operator-guide.en.md\` (Betrieb).
- [Apps auf phi-spaces](help.topic.apps#files) stellt die App neben die anderen.
- [Leases und Transaktionen](help.topic.leases_and_transactions#overview) erklärt die Transaktionen, auf denen jede Operation beruht.`,
		},
		en: {
			title: "spaces-files: files for people and agents",
			short: "A filesystem with Zanzibar-style rights: what it is, why agents need identities of their own, what it is for and how it is built on phi-spaces.",
			body: `## Overview {#overview}

spaces-files is a filesystem on phi-spaces for **people and individual agent instances**. Both work on the same files, each under an identity of its own and with rights of its own. The rights follow the model of Google's Zanzibar: they are relationships ("group North is editor of dispatch"), evaluated afresh on every operation, and a revocation holds for every later check. What is adopted from Zanzibar and what is solved differently is under [Zanzibar: starting point and implementation](help.topic.spaces_files#zanzibar).

| Question | In short |
|---|---|
| What | Files and directories in workspaces, with the roles owner, editor, viewer, groups and inheritance |
| Why | Agents need an identity of their own that can be revoked, not a person's account |
| What for | People and agents share work without overwriting each other or seeing too much |
| How | One private space per tenant for metadata and rights, encrypted blobs for the contents |
| Where | On big at spaces-files.eibrain.org; locally with \`npm run spaces-files\` |

## What it is {#what}

The terms:

- **Tenant:** a closed customer or team with a private space of its own. Tenants do not see each other.
- **Actor:** a person (user) or an agent instance (agent). Every actor has a stable ID and a **home**, a workspace of its own created with it in the same transaction.
- **Workspace:** a named top-level directory, e.g. \`dispatch\`. Below it are directories and files, text or binary.
- **Roles:** owner may grant rights and edit, editor may edit and read, viewer may read. A role comes from a direct grant, from a grant to a group (nested groups too), or is inherited from a directory above.
- **Tenant administrator:** manages the actors, groups and workspaces of the tenant; this gives no file rights.
- **Host operator:** runs the service: tenants, keys, backups, limits. Works through a local interface of its own without file operations.

A file has versions. A save is always "over version n": if someone else has saved version n+1 in the meantime, a version conflict comes back, and the other's text is not lost.

## Why {#why}

Once agents take part, the usual solutions fall short:

- **An agent with a person's account** can do everything that person can, and afterwards nobody knows who did what. In spaces-files every agent instance is an actor of its own: bound to the agent host that runs it and its agent ID. Its rights are visible and can be revoked on their own.
- **A revocation must hold at once.** When Lea is removed from the group North, her editor that is already open may no longer save, and if North was her only access, \`dispatch\` disappears from her list: every path in it then answers exactly like a path that does not exist. That is why every operation re-evaluates the relationships instead of trusting a session.
- **Concurrent work** by people and agents creates conflicts. Versions make them visible instead of silently overwriting one side.
- **Networks lose replies.** Every changing operation carries a signed operation ID; a retry after a lost reply returns the stored receipt instead of applying the change twice.

## What for {#purpose}

- A team and its planning agent work on the same brief; the agent sees the people's changes before it writes on.
- Every agent gets a home of its own for notes and drafts that nobody else sees until it shares them.
- A review agent gets viewer on a workspace and can read but change nothing.
- A group gives rights to many at once; whoever leaves the group loses exactly the access that came through it.
- Read-only mounts (\`@name\`) show files of another system with that system's rights, without copying them.

## How it works {#how}

### Rights as relationships {#rights}

Rights are tuples in the tenant's space, for example:

\`\`\`text
group:north#member@user:lea
directory:dispatch#editor@group:north#member
directory:dispatch#owner@agent:planner-17
\`\`\`

Lea is a member of North, North is editor of \`dispatch\`, the agent planner-17 is owner. The rights extend downwards to everything in \`dispatch\`. The effective rights are the union of all paths; a revocation removes only that one path. A workspace is visible exactly when one has viewer on its root.

### Store and contents {#store}

The tenant's space holds actors, nodes (directories, files), relations, receipts and the audit, all in phi-spaces' own SQLite store. An operation runs in its tenant's queue and in **one** transaction: check the rights, change, write receipt and audit. The file contents do not live in the space but beside it as blobs, one file per version, sealed with AES-256-GCM. The space only holds the reference to the current version. The tenant spaces are never exposed: a generic space tool would bypass the rights check.

### Access {#access}

- **Browser:** over HTTPS. Sign-in through an OpenID provider or, where none is set up (on big for now), with username and password. The host operator sets the password; only a scrypt hash is stored. The session is a \`__Host-\` cookie (Secure, HttpOnly, SameSite=Strict); every change checks the origin and a CSRF token.
- **Agents:** an agent host connects over a unix socket of its own per host and tenant, or from another machine over TLS with phi-spaces' key proof. The host names the agent ID for each conversation; together with the host that is the actor's identity. \`client/agent-client.ts\` provides the tools with relative paths.
- **Administration:** the tenant administrator works in the browser; the host operator over a socket in the state directory (\`operator create-tenant\`, \`set-password\`, \`backup\`, …).

### Operations and recovery {#operations}

The service and its space process are separate processes; the space process exists in TypeScript and in Rust (\`files-space\`). Backups are encrypted archives, one for the data and one for the deployment state (sessions, keys, passwords). A restore advances the session epoch, so no old session survives. For a second site there is a standby with fencing and promotion; it is tested but not switched on on big.

## Zanzibar: starting point and implementation {#zanzibar}

### Starting point {#zanzibar-origin}

**Zanzibar** is Google's authorization system, described in 2019 in the paper *Zanzibar: Google's Consistent, Global Authorization System* (USENIX ATC). It decides who may do what for services such as Drive, Calendar, Photos and YouTube. Its core ideas:

- **Rights are relation tuples** of the form \`object#relation@subject\`, e.g. \`doc:brief#editor@user:lea\`. The subject can itself be a set (\`group:north#member\`); that gives groups and nested groups.
- **Rules derive rights** ("userset rewrites"): an editor is also a viewer; whoever has rights on a folder has them on its contents.
- **Every request is checked afresh** (Check) instead of copying rights into sessions or tokens.
- **Consistency against the "new enemy problem":** if someone loses a right and new content is added afterwards, they must never see the new content. Zanzibar orders changes and checks by Spanner timestamps and hands clients "zookies" that fix a minimum freshness for later checks.

The second starting point is **Zontally's agent filesystem** (the blog post "Why we built a Zanzibar agent filesystem"): every authenticated session gets a home of its own, every operation evaluates the relationships afresh, and directory rights are inherited. From there come the automatically provisioned home per actor, the inherited directory rights and the separate identity of each agent instance.

### What is adopted {#zanzibar-adopted}

| Zanzibar | spaces-files |
|---|---|
| Relation tuples \`object#relation@subject\` | The same form, stored as entries in the tenant's space: objects tenant, group, directory, file; relations admin, member, owner, editor, viewer |
| Usersets as subjects | \`group:north#member\` as the subject of a grant and as a member of another group |
| Rewrite rules | Fixed in code: owner includes editor, editor includes viewer; rights are inherited through each node's parent reference up to the workspace root |
| Check on every request | Every operation checks in its tenant's queue, in the same transaction as the change; no decision cache |
| A revocation holds for every later check | A revocation takes effect with its commit; the next operation, even from an editor already open, sees it |

### What is different {#zanzibar-different}

- **Ordering without zookies.** Zanzibar is globally distributed and therefore needs timestamps and zookies. spaces-files has exactly one instance per tenant that admits operations, and one queue: every check comes after every earlier commit, so the new enemy problem cannot arise. For replicas, causal revision tokens are specified ("read nothing older than revision n"); they would only be needed if replicas served reads, and they do not.
- **No freely configurable schema.** Zanzibar lets every service define its own namespaces and rules. Here the relations and their derivation are fixed; unknown relations and wrong subject-object pairs are refused when written.
- **Bounded evaluation instead of a Leopard index.** Zanzibar speeds up deeply nested groups with an index of its own (Leopard). Here nesting is bounded (\`maxGroupDepth\`, default 4), cycles are refused when entered, and every decision has a work budget (otherwise \`capacityExceeded\`). Measured, one directory level costs about 3.5 lookups.
- **Visibility per workspace.** Whoever has viewer on a workspace's root sees it; whoever does not gets the same answer for every path in it as for a path that does not exist (\`notFound\`). So a refusal does not reveal that something exists.
- **Additional rules for a file service:** every workspace root keeps at least one direct owner, every tenant at least one administrator (\`lastOwner\`, \`lastAdmin\`); the tenant administrator role gives no file rights; an agent is bound to its agent host and its agent ID.
- **Scale.** Zanzibar manages trillions of tuples for many services; spaces-files keeps each tenant's tuples in that tenant's own space on one host. Several hosts with tenants of their own are noted as a possible extension.

## Where it runs {#where}

- **big:** one container (the service and the Rust space process) behind nginx at https://spaces-files.eibrain.org. Every day the encrypted backups go to nano, into an account that may add but not delete.
- **Locally:** \`npm run spaces-files\` (\`FILES_MEM=1\` keeps everything in memory), tests with \`npm run test:spaces-files\`.

## Limits {#limits}

- A tenant has exactly one instance that admits its operations; that is the basis of the ordering guarantee. Several hosts for many tenants are noted as a possible extension.
- The space stats leave the app out on purpose, because it would expose the tenant spaces.
- On big there is password sign-in for now and no agent hosts on other machines; both are built and can be switched on.

## Further reading {#further}

- Sources: [the Zanzibar paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/), [Zontally's rationale](https://www.zontally.com/blogs/technical/why-we-built-a-zanzibar-agent-filesystem).
- In the repository: \`spaces-files/README.md\` (state and evidence), \`docs/zanzibar-agent-filesystem-plan.en.md\` (plan and decisions), \`spaces-files/docs/operator-guide.en.md\` (operations).
- [Apps on phi-spaces](help.topic.apps#files) puts the app beside the others.
- [Leases and transactions](help.topic.leases_and_transactions#overview) explains the transactions every operation rests on.`,
		},
	},
];
