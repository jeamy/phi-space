// Canonical bilingual workflow (v1-v6) and API articles for PHI-SPACES / HELP.
import type { ArticleSeed } from "./corpus-articles-data.ts";

export const WORKFLOW_AND_API_ARTICLES: ArticleSeed[] = [
	{
		id: "help.workflow.overview_v1_to_v6",
		type: "workflow",
		provider: "core",
		tags: ["multiplayer", "chat", "tutorial", "step-by-step", "v1", "v2", "v3", "v4", "v5", "v6", "earendil"],
		related: [
			"help.workflow.stage_v1_local_memory",
			"help.workflow.stage_v2_local_durable",
			"help.workflow.stage_v3_remote_socket",
			"help.workflow.stage_v4_gated_auth",
			"help.workflow.stage_v5_federated_cluster",
			"help.workflow.stage_v6_mobile_control"
		],
		since: "0.0.1",
		resources: [
			{
				id: "res-overview-v1-v6",
				title: { de: "Multiplayer Space-Chat Kernmodul (v1–v6)", en: "Multiplayer Space-Chat Core Module (v1–v6)" },
				summary: {
					de: "Gemeinsamer Space-Chat-Kern (Thread, Msg, ChatTask, Presence, ScheduledJob, TimerLock, SearchTask, SubagentStep, SearchResult) mit zwei CompletionProfiles.",
					en: "Shared Space-Chat core (Thread, Msg, ChatTask, Presence, ScheduledJob, TimerLock, SearchTask, SubagentStep, SearchResult) with two CompletionProfiles."
				},
				stage: "v1-v6",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v1-local-memory/run.ts"
			}
		],
		de: {
			title: "Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)",
short: "Wie ein Mehrbenutzer-Chat mit phi-spaces entsteht: sechs lauffähige Stufen vom Programm im Arbeitsspeicher bis zum Betrieb über Handy und Web.",
			body: `## Überblick {#overview}

Diese Anleitung baut einen Mehrbenutzer-Chat mit phi-spaces in sechs Stufen. Jede Stufe ist ein eigenes kleines Programm, das du direkt starten kannst. Die erste läuft ohne Einrichtung im Arbeitsspeicher, die letzte zeigt die Steuerung über Handy und Web.

Weitere Beispiele außerhalb dieser sechs Stufen stehen unter [Beispiele](help.topic.examples#overview).

## Begriffs- und Systemmodell {#concept-model}

Das Projekt setzt die Fähigkeiten des bekannten [Pi Durable on Cloudflare Multiplayer-Chats](help.topic.overview#overview) **ausschließlich mit den Mitteln von \`phi-spaces\`** um: ohne Cloudflare-spezifische APIs und ohne Sonder-Tabellen außerhalb des Spaces. Die Stufen nutzen den eigenen Speicher von phi-spaces (SQLite-Datei oder Arbeitsspeicher); pi-durable braucht keines der sechs Programme. Die gemeinsame Chat-Logik steht in \`help-site/examples/shared/chat-core.ts\` (\`SpaceChatEngine\`), jedes Programm in \`help-site/examples/v*/run.ts\`.

### Wie phi-spaces die 6 Kernanforderungen löst {#mapping-table}

| Funktion des Multiplayer-Chats | Lösung mit reinen \`phi-spaces\`-Mitteln |
|---|---|
| **1. Teilbare Session-Räume** | Jeder Chat-Raum ist ein isolierter **benannter Space (\`NamedSpace\`)** mit eigener \`spaceId\` und Revision \`rev\`. |
| **2. Mehrere Threads & Forking ohne Duplikate** | Threads sind \`Thread\`-Entries (\`{ threadId, parentThreadId, forkUpToSeq }\`). Die Chat-Engine fängt Wiederholungen selbst ab: \`Thread\` per \`write\` mit \`unique: ["threadId"]\`, \`msgId\` und \`taskId\` abgeleitet aus der \`requestId\`. Ab Stufe 3 gibt \`RemoteSpace\` jeder Mutation zusätzlich eine eigene Request-Identität für Transport-Wiederholungen. |
| **3. Multiplayer-Inbox & geordnete Antworten** | Jede Nachricht erzeugt in einer Transaktion \`Msg\` + \`ChatTask\`. Der Worker nimmt \`ChatTask\` exklusiv unter \`txn\` und muss laut **\`CompletionProfile\`** genau eine Antwort-\`Msg\` committen. |
| **4. Live-Streaming & Teilnehmer-Präsenz** | Snapshot über \`readPage()\` (\`inspectSnapshot()\` liest alle Seiten), Live-Deltas stehen über \`changes(afterRev)\` bereit; Anwesenheit über \`Presence\`-Entries mit **30-s-Lease** und \`renew()\`. |
| **5. Geplante Aufgaben (\`schedule\` / Alarme)** | \`ScheduledJob\`-Entry (\`FOREVER\`) + \`TimerLock\`-Entry mit \`leaseMs = delayMs\`. Nach Ablauf der Lease räumt der Reaper von \`startService\` den Lock ab; \`tickAlarms()\` legt danach idempotent den Wakeup-\`ChatTask\` an. |
| **6. Konversationssuche per Subagent (\`search_history\`)** | \`SearchTask\`-Entry wird von einem Subagent-Worker unter \`txn\` genommen; er durchsucht alle Threads per \`readAll({ type: "Msg" })\`, protokolliert \`SubagentStep\`-Entries und committet \`SearchResult\` unter einem zweiten \`CompletionProfile\`. |

### Die 6 Stufen im Überblick {#six-stages}

1. **[Stufe 1 (\`v1-local-memory\`)](help.workflow.stage_v1_local_memory#overview)**: Zero-Setup im Arbeitsspeicher (\`openOwnMemoryHost()\` + \`PhiSpaces\`). Sofort ausführbar ohne Dateien oder Netzwerk.
2. **[Stufe 2 (\`v2-local-durable\`)](help.workflow.stage_v2_local_durable#overview)**: Eigener SQLite-Speicher (\`openSqliteHost\`), Wiederanlauf auf derselben Datei, \`TimerLock\`-Alarme und \`search_history\`-Subagent.
3. **[Stufe 3 (\`v3-remote-socket\`)](help.workflow.stage_v3_remote_socket#overview)**: Trennung in Server und Remote-Worker über \`SpaceService\`, \`RemoteSpace\` (Unix-Socket/TCP) und Consumer-Mailboxes (\`events\` + \`ack\`).
4. **[Stufe 4 (\`v4-gated-auth\`)](help.workflow.stage_v4_gated_auth#overview)**: Zwei-Schichten-Sicherheit (\`startGate\`, Ed25519-Challenge, Token-Enrollment, 60-s-Grants, Schlüsselrotation und Boot-Guard).
5. **[Stufe 5 (\`v5-federated-cluster\`)](help.workflow.stage_v5_federated_cluster#overview)**: Föderation über 3 Member-Spaces (\`RouterController\` + \`FederatedSpace\`), HRW-Routing nach \`threadId\` und clusterweites \`readAll\`; in der Demo als 4 Hosts in einem Prozess simuliert.

6. **[Stufe 6 (\`v6-mobile-control\`)](help.workflow.stage_v6_mobile_control#overview)**: Betriebssteuerung über die Mobile App (\`pi-termux-mobile\`) und den login-geschützten Web-Bereich **\`AdminSpaces\`** auf \`https://spaces.eibrain.org\`.

Jede Stufen-Beschreibung enthält einen Abschnitt **Topologie: Space-Verteilung**, der zeigt, wie viele Hosts und Spaces beteiligt sind und wie Entries verteilt werden.

## Siehe auch {#see-also}

- [Stufe 1 (v1-local-memory): Sofortstart ohne Setup](help.workflow.stage_v1_local_memory#overview)`
		},
		en: {
			title: "Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)",
short: "How a multiplayer chat is built with phi-spaces: six runnable stages, from a program in memory to operation by phone and web.",
			body: `## Overview {#overview}

This guide builds a multiplayer chat with phi-spaces in six stages. Each stage is a small program of its own that you can run directly. The first runs in memory without any setup, the last shows control by phone and web.

Further examples outside these six stages are under [Examples](help.topic.examples#overview).

## Concept And System Model {#concept-model}

The project implements the capabilities of the [Pi Durable on Cloudflare Multiplayer Chat](help.topic.overview#overview) **purely with \`phi-spaces\` primitives**: no Cloudflare-specific APIs and no ad-hoc tables outside the space. The stages use phi-spaces' own store (a SQLite file or memory); none of the six programs needs pi-durable. The shared chat logic lives in \`help-site/examples/shared/chat-core.ts\` (\`SpaceChatEngine\`), each program in \`help-site/examples/v*/run.ts\`.

### How phi-spaces Solves The 6 Core Requirements {#mapping-table}

| Multiplayer Chat Capability | Pure \`phi-spaces\` Solution |
|---|---|
| **1. Shareable Session Rooms** | Each chat session is an isolated **named space (\`NamedSpace\`)** with its own \`spaceId\` and revision counter \`rev\`. |
| **2. Multiple Threads & Forking Without Duplicates** | Threads are \`Thread\` entries (\`{ threadId, parentThreadId, forkUpToSeq }\`). The chat engine handles repeats itself: \`Thread\` through \`write\` with \`unique: ["threadId"]\`, \`msgId\` and \`taskId\` derived from the \`requestId\`. From stage 3 on, \`RemoteSpace\` also gives every mutation a request identity of its own for transport retries. |
| **3. Multiplayer Inbox & Ordered Replies** | Submitting a message atomically writes \`Msg\` + \`ChatTask\`. The worker reserves \`ChatTask\` under \`txn\` and must commit a matching reply \`Msg\` enforced by **\`CompletionProfile\`**. |
| **4. Live Streaming & Participant Presence** | Snapshot via \`readPage()\` (\`inspectSnapshot()\` reads every page), live deltas are available via \`changes(afterRev)\`; presence via \`Presence\` entries with a **30 s lease** and \`renew()\`. |
| **5. Scheduled Tasks (\`schedule\` / Alarms)** | \`ScheduledJob\` entry (\`FOREVER\`) + \`TimerLock\` entry with \`leaseMs = delayMs\`. When the lease expires, the reaper of \`startService\` removes the lock; \`tickAlarms()\` then idempotently creates the wakeup \`ChatTask\`. |
| **6. Cross-Thread Search Subagent (\`search_history\`)** | A subagent worker takes \`SearchTask\` under \`txn\`, scans top-level threads via \`readAll({ type: "Msg" })\`, records \`SubagentStep\` trace entries, and commits \`SearchResult\` under a second \`CompletionProfile\`. |

### The 6 Stages At A Glance {#six-stages}

1. **[Stage 1 (\`v1-local-memory\`)](help.workflow.stage_v1_local_memory#overview)**: Zero-setup in memory (\`openOwnMemoryHost()\` + \`PhiSpaces\`). Runs immediately without files or network ports.
2. **[Stage 2 (\`v2-local-durable\`)](help.workflow.stage_v2_local_durable#overview)**: Own SQLite store (\`openSqliteHost\`), restart on the same file, \`TimerLock\` alarms, and \`search_history\` subagent.
3. **[Stage 3 (\`v3-remote-socket\`)](help.workflow.stage_v3_remote_socket#overview)**: Process decoupling via \`SpaceService\`, \`RemoteSpace\` (Unix socket/TCP), and consumer mailboxes (\`events\` + \`ack\`).
4. **[Stage 4 (\`v4-gated-auth\`)](help.workflow.stage_v4_gated_auth#overview)**: Two-layer security (\`startGate\`, Ed25519 challenge, token enrollment, 60s grants, key rotation, and boot guard).
5. **[Stage 5 (\`v5-federated-cluster\`)](help.workflow.stage_v5_federated_cluster#overview)**: Federation across 3 member spaces (\`RouterController\` + \`FederatedSpace\`) with HRW routing by \`threadId\` and cluster-wide \`readAll\`; simulated as 4 hosts in one process in the demo.
6. **[Stage 6 (\`v6-mobile-control\`)](help.workflow.stage_v6_mobile_control#overview)**: Operations control via the mobile app (\`pi-termux-mobile\`) and the login-protected **\`AdminSpaces\`** web portal on \`https://spaces.eibrain.org\`.

Each stage description includes a **Topology: Space Distribution** section showing how many hosts/spaces are involved and how entries are distributed.

## See Also {#see-also}

- [Stage 1 (v1-local-memory): Zero-Setup Local Quickstart](help.workflow.stage_v1_local_memory#overview)`
		}
	},
	{
		id: "help.workflow.stage_v1_local_memory",
		type: "workflow",
		provider: "client",
		tags: ["v1", "memory", "quickstart", "phispaces", "thread", "fork", "presence", "completionprofile"],
		related: ["help.workflow.overview_v1_to_v6", "help.workflow.stage_v2_local_durable"],
		since: "0.0.1",
		resources: [
			{
				id: "res-stage-v1",
				title: { de: "Stufe 1 Runner (v1-local-memory)", en: "Stage 1 Runner (v1-local-memory)" },
				summary: {
					de: "Führt Multiplayer-Presence, Thread-Erstellung, Nachrichten-Verarbeitung unter CompletionProfile und Thread-Forking komplett im RAM aus.",
					en: "Runs multiplayer presence, thread creation, message processing under CompletionProfile, and thread forking purely in RAM."
				},
				stage: "v1",
				entryTypes: 4,
				profiles: 1,
				command: "node --experimental-strip-types help-site/examples/v1-local-memory/run.ts"
			}
		],
		de: {
			title: "Stufe 1 (v1-local-memory): Lokaler Sofortstart ohne Setup",
short: "Die einfachste lauffähige Version des Chats im Arbeitsspeicher: Threads, Abzweigungen, Anwesenheit und Antworten in einer Transaktion.",
			body: `## Überblick {#overview}

Stufe 1 ist der einfachste Einstieg: ein Programm ohne Datenbank, ohne Netzwerk und ohne Konfiguration. Es zeigt, wie zwei Personen einen Chat betreten, schreiben, eine Antwort bekommen und ein Gespräch abzweigen. Alles liegt im Arbeitsspeicher und ist nach dem Programmende weg.

## Topologie: Space-Verteilung {#topology}

Das Programm \`help-site/examples/v1-local-memory/run.ts\` öffnet einen Host im Arbeitsspeicher (\`openOwnMemoryHost()\`) und legt einen benannten Space an.

- **1 Prozess**, **1 Host** im Arbeitsspeicher (\`openOwnMemoryHost()\`; flüchtig, kein Restart-Szenario).
- **1 benannter Space** (\`chat-v1\`): alle Entries (\`Presence\`, \`Thread\`, \`Msg\`, \`ChatTask\`) liegen in genau diesem Space.
- Clients (alice/bob) und Worker greifen in-process über dasselbe \`PhiSpaces\`-Objekt zu — kein Socket, keine Datei, kein Netz.

## Arbeitsablauf {#workflow}

### Schritt 1: Space und CompletionProfile initialisieren {#step-1-init}

\`\`\`ts
const host = openOwnMemoryHost();
await host.commit((tx) => createSpace(tx, "chat-v1", Date.now()), ctx);
const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: "chat-v1" });
const stopService = await startService(host, ctx);

await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
\`\`\`

### Schritt 2: Teilnehmer-Präsenz mit Space-Lease anlegen {#step-2-presence}

Wenn \`alice\` und \`bob\` den Chat betreten, schreibt \`engine.joinOrRefreshPresence(...)\` für jeden einen \`Presence\`-Entry mit 30 Sekunden Lease (\`30_000\` ms). \`engine.renewPresence(participantId, ms)\` verlängert ihn über \`space.renew(leaseId, ms)\`; das Programm verlängert \`alice\` auf 45 Sekunden.

### Schritt 3: Nachricht schreiben, transaktional beantworten und Thread forken {#step-3-chat-and-fork}

1. \`alice\` schreibt in einer Transaktion ihre \`Msg\` (\`seq: 1\`) und den zugehörigen \`ChatTask\`.
2. Der Chat-Worker nimmt \`ChatTask\` unter einer Transaktion (\`space.take(..., { txn })\`), erzeugt die Antwort-\`Msg\` (\`seq: 2\`) mit derselben \`taskId\` und ruft \`space.commit(txn)\` auf.
3. \`bob\` forkt den Thread ab \`seq: 2\` (\`forkThread\` schreibt nur Parent-Verweis und Grenze; geerbte Nachrichten bis \`seq <= 2\` werden beim Lesen aufgelöst, nicht physisch kopiert).

Das Programm ruft \`createThread\` zusätzlich zweimal mit derselben \`requestId\` auf: Die Wiederholung liefert denselben Thread und legt keinen zweiten an.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Stufe 2 (v2-local-durable): SQLite, Alarme & Subagent](help.workflow.stage_v2_local_durable#overview)`
		},
		en: {
			title: "Stage 1 (v1-local-memory): Zero-Setup Local Quickstart",
short: "The simplest runnable version of the chat in memory: threads, forks, presence, and replies inside a transaction.",
			body: `## Overview {#overview}

Stage 1 is the simplest start: a program with no database, no network, and no configuration. It shows how two people join a chat, write, get a reply, and branch off a conversation. Everything lives in memory and is gone when the program ends.

## Topology: Space Distribution {#topology}

The program \`help-site/examples/v1-local-memory/run.ts\` opens a host in memory (\`openOwnMemoryHost()\`) and creates a named space.

- **1 process**, **1 host** in memory (\`openOwnMemoryHost()\`; volatile, no restart scenario).
- **1 named space** (\`chat-v1\`): every entry (\`Presence\`, \`Thread\`, \`Msg\`, \`ChatTask\`) lives in that single space.
- Clients (alice/bob) and workers share the same in-process \`PhiSpaces\` object — no socket, no file, no network.

## Workflow {#workflow}

### Step 1: Initialize Space And CompletionProfile {#step-1-init}

\`\`\`ts
const host = openOwnMemoryHost();
await host.commit((tx) => createSpace(tx, "chat-v1", Date.now()), ctx);
const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: "chat-v1" });
const stopService = await startService(host, ctx);

await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
\`\`\`

### Step 2: Register Participant Presence With Space Leases {#step-2-presence}

When \`alice\` and \`bob\` join the session, \`engine.joinOrRefreshPresence(...)\` writes a \`Presence\` entry for each with a 30-second lease (\`30_000\` ms). \`engine.renewPresence(participantId, ms)\` extends it through \`space.renew(leaseId, ms)\`; the program extends \`alice\` to 45 seconds.

### Step 3: Submit Message, Reply Transactionally, And Fork Thread {#step-3-chat-and-fork}

1. \`alice\` atomically writes her user \`Msg\` (\`seq: 1\`) and a matching \`ChatTask\`.
2. The chat worker reserves \`ChatTask\` under a transaction (\`space.take(..., { txn })\`), writes the assistant reply \`Msg\` (\`seq: 2\`) carrying the same \`taskId\`, and calls \`space.commit(txn)\`.
3. \`bob\` forks the thread at \`seq: 2\` (\`forkThread\` stores the parent pointer and boundary; inherited messages up to \`seq <= 2\` are resolved on read, not physically copied).

The program also calls \`createThread\` twice with the same \`requestId\`: the repeat returns the same thread and creates no second one.

### Run From Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
\`\`\`

## See Also {#see-also}

- [Stage 2 (v2-local-durable): SQLite, Alarms & Subagent](help.workflow.stage_v2_local_durable#overview)`
		}
	},
	{
		id: "help.workflow.stage_v2_local_durable",
		type: "workflow",
		provider: "client",
		tags: ["v2", "sqlite", "durable", "requestref", "alarms", "timerlock", "subagent", "search_history"],
		related: ["help.workflow.stage_v1_local_memory", "help.workflow.stage_v3_remote_socket"],
		since: "0.0.1",
		resources: [
			{
				id: "res-stage-v2",
				title: { de: "Stufe 2 Runner (v2-local-durable)", en: "Stage 2 Runner (v2-local-durable)" },
				summary: {
de: "Demonstriert den eigenen SQLite-Speicher über einen Neustart, wiederholsichere Aufrufe, TimerLock-Lease-Alarme und den search_history-Subagenten.",
en: "Demonstrates the own SQLite store across a restart, safely repeatable calls, TimerLock lease alarms, and the search_history subagent."
				},
				stage: "v2",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v2-local-durable/run.ts"
			}
		],
		de: {
			title: "Stufe 2 (v2-local-durable): SQLite-Persistenz, Alarme & Subagent",
short: "Erweitert Stufe 1 um Speicherung in einer SQLite-Datei, wiederholsichere Aufrufe, geplante Alarme und eine Suche über alle Threads.",
			body: `## Überblick {#overview}

Stufe 2 macht den Chat dauerhaft: Die Daten liegen in einer Datei und überstehen einen Neustart des Programms. Dazu kommen zwei Funktionen, die erst damit sinnvoll sind. Das sind geplante Erinnerungen und eine Suche, die frühere Gespräche durchsucht.

## Topologie: Space-Verteilung {#topology}

Das Programm \`help-site/examples/v2-local-durable/run.ts\` ergänzt die zwei Funktionen aus dem Earendil-Artikel, **geplante Aufgaben (\`schedule\`-Alarme)** und die **konversationsübergreifende Suche per Subagent (\`search_history\`)**, rein mit \`phi-spaces\`-Mitteln.

- **1 Prozess**, **1 Host** auf einer **SQLite-Datei** (\`chat-v2.sqlite\`, eigener Speicher von phi-spaces).
- **1 benannter Space** (\`chat-v2\`): Threads, \`Msg\`, \`ChatTask\`, \`ScheduledJob\`, \`TimerLock\`, Subagent-Entries – alles persistent in einem Space.
- Für die Crash-Demo wird der Host geschlossen und **auf derselben SQLite-Datei neu geöffnet**: der Space überlebt den simulierten Neustart, offene Leases werden gereapt.

## Arbeitsablauf {#workflow}

### Schritt 1: SQLite-Speicher und wiederholsichere Aufrufe {#step-1-sqlite-claims}

Statt des Speichers im Arbeitsspeicher öffnet das Programm \`await openSqliteHost(dbPath)\`, den eigenen SQLite-Speicher: WAL-Modus, ein Schreib-Thread, standardmäßig \`synchronous=FULL\`. Genau ein Prozess besitzt die Datei über die Sperre \`<pfad>.owner\`; ein zweiter erhält \`StoreUnavailable\`. Das ist weder ein pi-durable-Speicher noch eine JSONL-Datei.

Wiederholungen fängt die Chat-Engine selbst ab. \`createThread\` schreibt mit \`unique: ["threadId"]\` und legt die \`requestId\` im \`Thread\`-Entry ab; \`submitMessage\` leitet \`msgId\` und \`taskId\` aus der \`requestId\` ab und prüft zuerst, ob die Nachricht schon existiert. Dieselbe \`requestId\` liefert also das erste Ergebnis, dieselbe \`requestId\` mit anderen Argumenten einen Fehler. Die Request-Claims des Spaces (\`RequestRef\`, \`issueGeneration\`) nutzt die Engine nicht; sie stehen in der [Claims-API](help.api.phispaces_claims#overview).

### Schritt 2: Geplante Alarme über ScheduledJob + TimerLock-Lease {#step-2-alarms}

1. Eine Erinnerung plant \`engine.scheduleReminder({ jobId, threadId, instruction, requestedBy, delayMs, requestId })\`; das Programm nutzt \`delayMs: 60\`. Dabei entstehen:
   - einen \`ScheduledJob\`-Entry mit \`status: "pending"\` und \`FOREVER\`-Lease,
   - einen \`TimerLock\`-Entry \`{ jobId, threadId, executeAt }\` mit **\`lease = delayMs\`**.
2. Solange \`TimerLock\` im Space existiert, ist der Auftrag noch nicht fällig.
3. Das Programm schließt den Host und wartet 90 ms. Nach dem Neuöffnen derselben SQLite-Datei entfernt der Reaper von \`startService\` den abgelaufenen \`TimerLock\`.
4. \`tickAlarms()\` nimmt den fälligen \`ScheduledJob\` unter einer Transaktion, entfernt einen noch vorhandenen Lock, schreibt den Job mit \`status: "triggered"\` zurück und legt gleichzeitig den Wakeup-\`ChatTask\` an.

### Schritt 3: Konversationsübergreifende Suche per Search-Subagent {#step-3-subagent}

1. In Thread 1 schreibt \`alice\`: *„Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.“*
2. In Thread 2 fragt \`bob\`: *„Was haben wir bezüglich des Event-Stores entschieden?“*
3. Der Haupt-Worker legt einen \`SearchTask\` (\`{ searchId, parentThreadId, question }\`) im Space ab.
4. Der **Search-Subagent-Worker** nimmt \`SearchTask\` unter einer Transaktion, durchsucht mit \`space.readAll({ type: "Msg" })\` alle Threads (ignoriert eigene Subagent-Daten), schreibt für jeden Suchbegriff einen \`SubagentStep\`-Entry (für die Sidebar-Ansicht) und committet das \`SearchResult\` unter dem zweiten \`CompletionProfile\`.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
\`\`\`

The program creates the file in a temporary directory and deletes it at the end. The command below, run from the repository root, starts such a store as a service of its own. \`--store\` takes a file or \`memory\`, \`--listen\` an address \`unix:/path.sock\` or \`tcp:HOST:PORT\`.

\`\`\`bash
npm run space-server -- --store chat.sqlite --listen unix:/tmp/space.sock
\`\`\`

Das Programm legt die Datei in einem temporären Verzeichnis an und löscht sie am Ende. Einen solchen Speicher startet der Befehl unten im Repository-Root als eigenen Dienst. \`--store\` nimmt eine Datei oder \`memory\`, \`--listen\` eine Adresse \`unix:/pfad.sock\` oder \`tcp:HOST:PORT\`.

\`\`\`bash
npm run space-server -- --store chat.sqlite --listen unix:/tmp/space.sock
\`\`\`

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): Prozess-Entkopplung über SpaceService & RemoteSpace](help.workflow.stage_v3_remote_socket#overview)`
		},
		en: {
			title: "Stage 2 (v2-local-durable): SQLite Persistence, Alarms & Subagent",
short: "Extends Stage 1 with storage in a SQLite file, safely repeatable calls, scheduled alarms, and a search across all threads.",
			body: `## Overview {#overview}

Stage 2 makes the chat durable: the data lives in a file and survives a program restart. It also adds two features that only make sense with that. These are scheduled reminders and a search through earlier conversations.

## Topology: Space Distribution {#topology}

The program \`help-site/examples/v2-local-durable/run.ts\` adds the two capabilities from the Earendil post, **scheduled tasks (\`schedule\` alarms)** and **cross-conversation search via subagent (\`search_history\`)**, purely with \`phi-spaces\` primitives.

- **1 process**, **1 host** on a **SQLite file** (\`chat-v2.sqlite\`, phi-spaces' own store).
- **1 named space** (\`chat-v2\`): threads, \`Msg\`, \`ChatTask\`, \`ScheduledJob\`, \`TimerLock\`, subagent entries — all durable in one space.
- For the crash demo the host is closed and **reopened on the same SQLite file**: the space survives the simulated restart and expired leases are reaped.

## Workflow {#workflow}

### Step 1: SQLite Store And Safely Repeatable Calls {#step-1-sqlite-claims}

Instead of the in-memory store, the program opens \`await openSqliteHost(dbPath)\`, the own SQLite store: WAL mode, one writer thread, \`synchronous=FULL\` by default. Exactly one process owns the file through the lock \`<path>.owner\`; a second one gets \`StoreUnavailable\`. This is neither a pi-durable store nor a JSONL file.

The chat engine handles repeats itself. \`createThread\` writes with \`unique: ["threadId"]\` and keeps the \`requestId\` in the \`Thread\` entry; \`submitMessage\` derives \`msgId\` and \`taskId\` from the \`requestId\` and first checks whether the message exists. So the same \`requestId\` returns the first result, and the same \`requestId\` with other arguments is an error. The engine does not use the space's request claims (\`RequestRef\`, \`issueGeneration\`); they are in the [claims API](help.api.phispaces_claims#overview).

### Step 2: Scheduled Alarms Via ScheduledJob + TimerLock Lease {#step-2-alarms}

1. \`engine.scheduleReminder({ jobId, threadId, instruction, requestedBy, delayMs, requestId })\` schedules a reminder; the program uses \`delayMs: 60\`. It writes:
   - a \`ScheduledJob\` entry with \`status: "pending"\` and \`FOREVER\` lease,
   - a \`TimerLock\` entry \`{ jobId, threadId, executeAt }\` with **\`lease = delayMs\`**.
2. While \`TimerLock\` exists in the space, the job is not yet due.
3. The program closes the host and waits 90 ms. After the same SQLite file is reopened, the reaper of \`startService\` removes the expired \`TimerLock\`.
4. \`tickAlarms()\` takes the due \`ScheduledJob\` inside a transaction, removes a lock that is still there, rewrites the job with \`status: "triggered"\`, and atomically creates the wakeup \`ChatTask\`.

### Step 3: Cross-Thread Search Via Search Subagent {#step-3-subagent}

1. In Thread 1, \`alice\` says: *"We decided to use PostgreSQL for the event store."*
2. In Thread 2, \`bob\` asks: *"What did we decide about the event store?"*
3. The main worker writes a \`SearchTask\` (\`{ searchId, parentThreadId, question }\`) into the space.
4. The **Search Subagent Worker** takes \`SearchTask\` under a transaction, scans all threads via \`space.readAll({ type: "Msg" })\` (excluding subagent artifacts), writes \`SubagentStep\` trace entries for sidebar inspection, and commits \`SearchResult\` under the second \`CompletionProfile\`.

### Run From Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
\`\`\`

## See Also {#see-also}

- [Stage 3 (v3-remote-socket): Process Decoupling via SpaceService & RemoteSpace](help.workflow.stage_v3_remote_socket#overview)`
		}
	},
	{
		id: "help.workflow.stage_v3_remote_socket",
		type: "workflow",
		provider: "remote",
		tags: ["v3", "remotespace", "spaceservice", "servespace", "socket", "mailbox", "events", "ack"],
		related: ["help.workflow.stage_v2_local_durable", "help.workflow.stage_v4_gated_auth"],
		since: "0.0.1",
		resources: [
			{
				id: "res-stage-v3",
				title: { de: "Stufe 3 Runner (v3-remote-socket)", en: "Stage 3 Runner (v3-remote-socket)" },
				summary: {
de: "Startet SpaceService auf einem Unix-Socket und verbindet Chat-Gateway, Chat-Worker und Search-Subagent als drei RemoteSpace-Clients in einem Prozess.",
en: "Starts SpaceService on a Unix socket and connects the chat gateway, chat worker, and search subagent as three RemoteSpace clients in one process."
				},
				stage: "v3",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts"
			}
		],
		de: {
			title: "Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace über Socket/TCP",
short: "Trennt Speicher, Gateway, Chat-Worker und Search-Subagent: Ein Dienst stellt den Space über Socket oder TCP bereit, alle anderen sind Clients.",
			body: `## Überblick {#overview}

In Stufe 3 arbeiten Chat-Oberfläche, Worker und Suche nicht mehr direkt auf dem Speicher. Ein Dienst stellt den Space über einen Socket bereit, und alle Beteiligten verbinden sich als Clients. So lassen sich die Teile auf getrennte Prozesse oder Rechner verteilen.

## Topologie: Space-Verteilung {#topology}

In \`help-site/examples/v3-remote-socket/run.ts\` veröffentlicht der Host den Space über \`SpaceService\` und \`serveSpace\` auf einem Unix-Domain-Socket (\`serveSpace\` kann ebenso TCP); Gateway, Worker und Subagent arbeiten über \`RemoteSpace\`.

- **1 Prozess, 1 Host** (eigener SQLite-Speicher + \`serveSpace\`) stellt den Space \`chat-v3\` über einen **Unix-Socket** (\`space.sock\`) bereit.
- **3 getrennte \`RemoteSpace\`-Clients** mit je eigenem Transport greifen auf denselben Space zu: Gateway (UI), Chat-Worker, Search-Subagent. Alle drei verbinden sich als Peer \`remote-chat-peer\` und teilen sich daher eine Consumer-Mailbox; das Programm liest sie über den Worker.
- Verteilung: **1 Space, 1 Server, 3 Remote-Clients**. Die Socket-Grenze ist echt, die Prozessgrenze nicht; dieselbe Engine läuft unverändert gegen \`RemoteSpace\`.

## Arbeitsablauf {#workflow}

### Schritt 1: SpaceService auf Unix-Socket starten {#step-1-serve}

\`\`\`ts
const service = new SpaceService({
  host,
  ctx,
  identity: new GateIdentity(),
  policy: DEFAULT_POLICY
});
const server = await serveSpace(service, {
  listen: { path: socketPath },
  connection: () => ({ peerId: "remote-chat-peer", credentials: { roles: ["admin", "member"] } })
});
\`\`\`

### Schritt 2: RemoteSpace-Clients verbinden {#step-2-remote-clients}

\`\`\`ts
const gatewaySpace = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const workerSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const searchSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
\`\`\`

Da \`RemoteSpace\` denselben \`SpaceLike\`-Vertrag wie \`PhiSpaces\` implementiert, läuft \`SpaceChatEngine\` aus \`help-site/examples/shared/chat-core.ts\` ohne Codeänderung über das Netzwerkprotokoll. Das Programm registriert zusätzlich ein \`notify\`-Abo mit \`target: "self"\`, liest die Mailbox mit \`events({ waitMs: 50 })\` und bestätigt sie mit \`ack(mailboxEpoch, next)\`.

Ein eigenständiges Projekt braucht weniger Code: \`connectSpace("unix:/pfad.sock")\` aus \`phi-spaces\` liefert \`{ space, close }\`. Den Server dazu startet \`npm run space-server -- --store FILE|memory --listen unix:/pfad.sock\`; dort ist jede Verbindung derselbe Peer \`local\` mit Rolle \`member\`, wer den Socket erreicht, nutzt also den Space.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Stufe 4 (v4-gated-auth): Overlay-Gate, Schicht A/B & 60s-Grants](help.workflow.stage_v4_gated_auth#overview)`
		},
		en: {
			title: "Stage 3 (v3-remote-socket): SpaceService & RemoteSpace over Socket/TCP",
short: "Separates store, gateway, chat worker, and search subagent: one service exposes the space over socket or TCP, everyone else is a client.",
			body: `## Overview {#overview}

In Stage 3, the chat interface, worker, and search no longer work directly on the store. A service exposes the space over a socket, and everyone involved connects as a client. That lets you split the parts across separate processes or machines.

## Topology: Space Distribution {#topology}

In \`help-site/examples/v3-remote-socket/run.ts\`, the host exposes the space via \`SpaceService\` and \`serveSpace\` on a Unix domain socket (\`serveSpace\` can do TCP as well); gateway, worker, and subagent operate through \`RemoteSpace\`.

- **1 process, 1 host** (own SQLite store + \`serveSpace\`) exposes the \`chat-v3\` space over a **Unix socket** (\`space.sock\`).
- **3 separate \`RemoteSpace\` clients**, each with its own transport, access the same space: gateway (UI), chat worker, search subagent. All three connect as peer \`remote-chat-peer\` and therefore share one consumer mailbox; the program reads it through the worker.
- Distribution: **1 space, 1 server, 3 remote clients**. The socket boundary is real, the process boundary is not; the same engine runs unchanged against \`RemoteSpace\`.

## Workflow {#workflow}

### Step 1: Serve SpaceService On A Unix Socket {#step-1-serve}

\`\`\`ts
const service = new SpaceService({
  host,
  ctx,
  identity: new GateIdentity(),
  policy: DEFAULT_POLICY
});
const server = await serveSpace(service, {
  listen: { path: socketPath },
  connection: () => ({ peerId: "remote-chat-peer", credentials: { roles: ["admin", "member"] } })
});
\`\`\`

### Step 2: Connect RemoteSpace Clients {#step-2-remote-clients}

\`\`\`ts
const gatewaySpace = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const workerSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const searchSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
\`\`\`

Because \`RemoteSpace\` implements the same \`SpaceLike\` interface as \`PhiSpaces\`, \`SpaceChatEngine\` from \`help-site/examples/shared/chat-core.ts\` runs unmodified over the wire protocol. The program also registers a \`notify\` subscription with \`target: "self"\`, reads the mailbox with \`events({ waitMs: 50 })\`, and acknowledges it with \`ack(mailboxEpoch, next)\`.

A standalone project needs less code: \`connectSpace("unix:/path.sock")\` from \`phi-spaces\` returns \`{ space, close }\`. \`npm run space-server -- --store FILE|memory --listen unix:/path.sock\` starts the server for it; there every connection is the same peer \`local\` with role \`member\`, so whoever reaches the socket uses the space.

### Run From Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
\`\`\`

## See Also {#see-also}

- [Stage 4 (v4-gated-auth): Overlay Gate, Layer A/B & 60s Grants](help.workflow.stage_v4_gated_auth#overview)`
		}
	},
	{
		id: "help.workflow.stage_v4_gated_auth",
		type: "workflow",
		provider: "security",
		tags: ["v4", "gate", "auth", "ed25519", "enroll", "grants", "rotation", "bootguard"],
		related: ["help.workflow.stage_v3_remote_socket", "help.workflow.stage_v5_federated_cluster"],
		since: "0.0.1",
		resources: [
			{
				id: "res-stage-v4",
				title: { de: "Stufe 4 Runner (v4-gated-auth)", en: "Stage 4 Runner (v4-gated-auth)" },
				summary: {
de: "Startet Control- und Data-Host mit Boot-Registern, Schicht-A/B-Gate, Token-Enrollment, 60-s-Grants und Live-Schlüsselrotation für den Space-Chat.",
en: "Starts a control and a data host with boot registers, Layer A/B gate, token enrollment, 60s grants, and live key rotation for the Space-Chat."
				},
				stage: "v4",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts"
			}
		],
		de: {
			title: "Stufe 4 (v4-gated-auth): Overlay-Gate, Schicht A/B, Enrollment & 60s-Grants",
			short: "Sichert den Multiplayer Space-Chat mit startFederationHost, kryptografischer Verbindungs-Challenge (Ed25519), Token-Enrollment, 60-Sekunden-Grants und Boot-Guard ab.",
			body: `## Überblick {#overview}

Stufe 4 sichert den Zugang: Wer den Chat lesen oder beschreiben will, muss sich erst ausweisen. Ein Gerät wird einmal gekoppelt und beweist danach bei jeder Verbindung seinen Schlüssel. Zusätzlich braucht es für seine Aufrufe kurzlebige Berechtigungen, die nach einer Minute verfallen.

## Topologie: Space-Verteilung {#topology}

Mit \`help-site/examples/v4-gated-auth/run.ts\` darf kein Client den Space lesen oder beschreiben, ohne (1) im Overlay-Verzeichnis als Peer bekannt zu sein (**Schicht A**, in der Demo ein simuliertes Verzeichnis), (2) seinen eingeschriebenen Schlüssel per Verbindungs-Challenge zu beweisen (**Schicht B**) und (3) einen frischen, vom Control-Host signierten **60-Sekunden-Grant** vorzulegen.

- **2 unabhängige, persistente Hosts** in einem Prozess (je ein eigener SQLite-Speicher), jeweils hinter einem eigenen TCP-Gate:
  - **Control Host** mit dem \`CONTROL_SPACE\` (PeerDirectory, Enroll-Tokens, Grants, Key-Rotation, BootGuard).
  - **Data Host** mit dem Chat-Space (Threads, \`Msg\`, \`Presence\`).
- Zugriff auf den Data-Space nur über **Gate Layer A (Overlay-Peer) + Layer B (Ed25519-Challenge)** und mit einem 60-s-Grant aus dem Control-Space. \`RemoteSpace\` holt ihn über \`grantProvider\` vor jedem Aufruf und jedem Retry; ausgenommen sind nur \`challenge\`, \`prove\`, \`enroll\`, \`enrollStatus\` und \`grant\`.

## Arbeitsablauf {#workflow}

### Schritt 1: Boot-Register und startFederationHost starten {#step-1-host}

Das Programm öffnet zwei \`SqliteRecoveryRegister\` (extern und installiert) und trägt für jeden Space eine Boot-Erlaubnis ein. Es erzeugt einen Signaturschlüssel des Control-Hosts (\`generateKey("ed25519", "control-signer")\`) und startet beide Hosts mit \`startFederationHost(host, ctx, ...)\` auf einem TCP-Loopback-Port; der Boot-Guard wird dabei aus \`boot: { external, installed }\` installiert.

### Schritt 2: Admin-Bootstrap & Worker-Enrollment {#step-2-enroll}

1. \`bootstrapEnroll\` legt im Control-Speicher ein Einmal-Token für den Peer \`chat-worker\` an. Dieser Peer spielt in der Demo Admin und Worker zugleich.
2. In der Overlay-Gruppe \`space-enroll\` hat der Peer nur die Rolle \`unpaired\`. Er ruft \`controlClient.enroll(token)\` auf und ist damit im \`CONTROL_SPACE\` eingeschrieben.
3. Das Programm verschiebt ihn in die Gruppe \`space-admin\`, ruft \`controlHost.revalidate()\` auf und verbindet ihn neu; \`controlClient.authenticate()\` beweist den Schlüssel. \`createEnroll\` für weitere Geräte nutzt diese Stufe nicht; dazu siehe [Stufe 6](help.workflow.stage_v6_mobile_control#overview).

### Schritt 3: Space-Chat mit 60s-Grant-Provider & Live-Key-Rotation {#step-3-grants-rotation}

Der \`RemoteSpace\` des Chat-Workers erhält \`grantProvider: () => controlClient.requestGrant("effect")\`, dazu \`signer\`, \`expectedGateHostId\` und \`ownPeerId\`. Zum Abschluss rotiert das Skript den Schlüssel: \`rotationChallenge\`, dann \`rotateKey(challenge, replacementSigner)\` mit alter und neuer Signatur. Nach dem Ergebnis im Control-Space verbindet es sich mit dem neuen Schlüssel neu und schreibt eine weitere Nachricht, ohne dass ein Gate neu startet.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Stufe 5 (v5-federated-cluster): Föderierte Spaces mit Router & HRW-Sharding](help.workflow.stage_v5_federated_cluster#overview)`
		},
		en: {
			title: "Stage 4 (v4-gated-auth): Overlay Gate, Layer A/B, Enrollment & 60s Grants",
			short: "Secures the Multiplayer Space-Chat with startFederationHost, cryptographic connection challenge (Ed25519), token enrollment, 60-second grants, and boot guard.",
			body: `## Overview {#overview}

Stage 4 secures access: anyone who wants to read or write the chat has to identify themselves first. A device is paired once and proves its key on every connection afterwards. Its calls also need short-lived permissions that expire after a minute.

## Topology: Space Distribution {#topology}

With \`help-site/examples/v4-gated-auth/run.ts\`, no client can read or change the space without (1) being known in the overlay peer directory (**Layer A**, a simulated directory in the demo), (2) proving its enrolled key via connection challenge (**Layer B**), and (3) presenting a fresh control-signed **60-second grant**.

- **2 independent, persistent hosts** in one process (each with its own SQLite store), each behind its own TCP gate:
  - **Control host** owning \`CONTROL_SPACE\` (peer directory, enroll tokens, grants, key rotation, boot guard).
  - **Data host** owning the chat space (threads, \`Msg\`, \`Presence\`).
- Access to the data space only through **Gate Layer A (overlay peer) + Layer B (Ed25519 challenge)** and with a 60s grant from the control space. \`RemoteSpace\` fetches it through \`grantProvider\` before every call and every retry; only \`challenge\`, \`prove\`, \`enroll\`, \`enrollStatus\`, and \`grant\` are exempt.

## Workflow {#workflow}

### Step 1: Initialize Boot Register And startFederationHost {#step-1-host}

The program opens two \`SqliteRecoveryRegister\`s (external and installed) and records a boot permit for each space. It generates the control host's signing key (\`generateKey("ed25519", "control-signer")\`) and starts both hosts with \`startFederationHost(host, ctx, ...)\` on a loopback TCP port; the boot guard is installed from \`boot: { external, installed }\`.

### Step 2: Admin Bootstrap & Worker Enrollment {#step-2-enroll}

1. \`bootstrapEnroll\` creates a one-time token for the peer \`chat-worker\` in the control store. In the demo this peer acts as admin and worker at once.
2. In the overlay group \`space-enroll\` the peer only has the role \`unpaired\`. It calls \`controlClient.enroll(token)\`, which registers it in \`CONTROL_SPACE\`.
3. The program moves it to the group \`space-admin\`, calls \`controlHost.revalidate()\`, and reconnects; \`controlClient.authenticate()\` proves the key. This stage does not use \`createEnroll\` for further devices; see [Stage 6](help.workflow.stage_v6_mobile_control#overview).

### Step 3: Space-Chat With 60s Grant Provider & Live Key Rotation {#step-3-grants-rotation}

The chat worker's \`RemoteSpace\` gets \`grantProvider: () => controlClient.requestGrant("effect")\`, plus \`signer\`, \`expectedGateHostId\`, and \`ownPeerId\`. Finally, the script rotates the key: \`rotationChallenge\`, then \`rotateKey(challenge, replacementSigner)\` with old and new signature. After the result appears in the control space it reconnects with the new key and writes another message, with no gate restart.

### Run From Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
\`\`\`

## See Also {#see-also}

- [Stage 5 (v5-federated-cluster): Federated Spaces with Router & HRW Sharding](help.workflow.stage_v5_federated_cluster#overview)`
		}
	},
	{
		id: "help.workflow.stage_v5_federated_cluster",
		type: "workflow",
		provider: "federation",
		tags: ["v5", "federation", "cluster", "router", "hrw", "federatedspace", "takewaiting", "lww"],
		related: ["help.workflow.stage_v4_gated_auth", "help.workflow.stage_v6_mobile_control"],
		since: "0.0.1",
		resources: [
			{
				id: "res-stage-v5",
				title: { de: "Stufe 5 Runner (v5-federated-cluster)", en: "Stage 5 Runner (v5-federated-cluster)" },
				summary: {
de: "Verteilt Chat-Threads per HRW über 3 Member-Spaces, liest clusterweit mit readAll und repliziert Presence per LWW zwischen zwei Hosts.",
en: "Distributes chat threads via HRW across 3 member spaces, reads cluster-wide with readAll, and replicates presence by LWW between two hosts."
				},
				stage: "v5",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts"
			}
		],
		de: {
			title: "Stufe 5 (v5-federated-cluster): Föderierte Spaces, HRW-Sharding & Router",
short: "Verteilt Threads per Router auf 3 Member-Spaces: HRW-Platzierung je threadId, clusterweites Lesen und LWW-Presence, simuliert in einem Prozess.",
			body: `## Überblick {#overview}

Stufe 5 verteilt den Chat auf mehrere Spaces, damit er über einen Rechner hinaus wachsen kann. Alle Nachrichten eines Threads landen immer am selben Ort, verschiedene Threads aber an verschiedenen Orten. Eine Suche kann trotzdem alle Orte gemeinsam lesen. Die Demo simuliert das in einem einzigen Prozess.

## Topologie: Space-Verteilung {#topology}

\`help-site/examples/v5-federated-cluster/run.ts\` verteilt Threads und Nachrichten auf **drei Member-Spaces (\`member-1\`, \`member-2\`, \`member-3\`)**. Das Programm setzt \`RouterController\` und \`FederatedSpace\` direkt zusammen; für den Betrieb fasst [\`createFederationController\`](help.api.federation_controller#overview) beide samt Policy und Membership zusammen.

Der Cluster läuft **simuliert in einem einzigen Prozess**: **4 Hosts** im Arbeitsspeicher (\`openOwnMemoryHost()\`) spielen Member-Hosts mit echten Federation-Komponenten. Es gibt kein Netzwerk, aber dieselbe Routing- und Journal-Logik wie in echter Verteilung.

- **1 Koordinator-Host**: \`RouterController\` (\`router-root\` + 2 Partition-Router für die Routing-Journals) und \`FederatedSpace\` (id \`fed-v5\`). Der Koordinator besitzt selbst keinen Chat-Daten-Space — er führt nur die Policy aus.
- **3 Member-Hosts** (\`member-1\`, \`member-2\`, \`member-3\`): jeder hat einen eigenen, unabhängigen Space mit eigenem Space-Doc.
- **HRW-Sharding**: die Federation-Policy routet \`Thread\`, \`Msg\` und \`ChatTask\` per Rendezvous-Hashing über \`fields.threadId\` deterministisch auf genau einen Member. Das Runner-Report-Feld \`memberDistribution\` zeigt die tatsächliche Verteilung, z.B. \`{ member-1: [alpha, gamma], member-2: [beta], member-3: [delta] }\`.
- **\`FederationIO\`** ist in der Demo ein In-Process-Adapter auf die lokalen \`PhiSpaces\`-Objekte; das Adapter-Ziel des Routers ebenso. In echter Verteilung wären das RPC-Aufrufe auf entfernte Hosts; der Vertrag (\`step\`, \`snapshot\`, \`events\`, \`ack\`, \`txnActive\`) bleibt gleich.
- **Replikation**: 2 \`EntryReplicationController\` (\`rep-1\` auf member-1, \`rep-2\` auf member-2) replizieren \`Presence\` via HLC + Last-Writer-Wins unter der Space-ID \`presence-global\`. Das Programm überträgt die Änderungen einmal von \`rep-1\` nach \`rep-2\` (\`changes\`, \`importChanges\`).

## Arbeitsablauf {#workflow}

### Schritt 1: FederationPolicy mit HRW nach threadId {#step-1-policy}

Alle thread-gebundenen Typen (\`Thread\`, \`Msg\`, \`ChatTask\`) erhalten die Routing-Regel \`mode: "expand"\`, \`by: { field: "threadId" }\` über \`["member-1", "member-2", "member-3"]\`:

- Dadurch landen alle Nachrichten und Aufgaben desselben Threads deterministisch auf demselben Member-Space.
- Verschiedene Threads einer großen Session verteilen sich gleichmäßig auf die 3 Member-Spaces.
- Geschrieben wird mit \`federated.write(entry, { id, principal }, FOREVER)\`. Das Programm schreibt vier Threads mit je einer Nachricht. Member-Transaktionen (\`createTransaction(member, leaseMs, request)\`, \`finishTransaction(originId, "commit", request)\`) bietet \`FederatedSpace\` ebenfalls an, das Programm nutzt sie nicht.

### Schritt 2: Föderierte Subagent-Suche über alle 3 Members {#step-2-federated-search}

\`federated.readAll({ type: "Msg" }, principal)\` fragt alle Member-Spaces ab, die zum Template passen, und liefert \`{ entries, complete }\`. Über \`complete\` meldet die Antwort, ob alle Members geantwortet haben. Das Programm zählt so alle Nachrichten des Clusters. Einen Search-Subagenten führt diese Stufe nicht aus; das Lesen über alle Members ist die Grundlage dafür.

### Schritt 3: LWW-Presence, Waiter-Wettlauf nur als API {#step-3-waiter-and-lww}

Das Programm schreibt mit \`rep1.mutate(...)\` einen \`Presence\`-Eintrag, überträgt die Änderung und liest ihn auf \`rep-2\`. Der Konflikt zweier Schreiber wird per HLC und Last-Writer-Wins entschieden.

\`takeWaiting\` führt das Programm nicht aus. Die Methode nimmt eine Aufgabe von dem Member, der sie zuerst hat: \`federated.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)\`. Ohne Transaktion verlangt sie \`timeoutMs\` von 1 bis 3 600 000 und \`txnLeaseMs\` von 1 bis 60 000, sonst gibt es \`RoutingConflict\`.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Stufe 6 (v6-mobile-control): Mobile App & Web-Admin Steuerung](help.workflow.stage_v6_mobile_control#overview)`
		},
		en: {
			title: "Stage 5 (v5-federated-cluster): Federated Spaces, HRW Sharding & Router",
short: "Distributes threads across 3 member spaces through a router: HRW placement per threadId, cluster-wide reads, and LWW presence, simulated in one process.",
			body: `## Overview {#overview}

Stage 5 spreads the chat across several spaces so it can grow beyond one machine. All messages of a thread always land in the same place, while different threads land in different places. A search can still read all places together. The demo simulates this in a single process.

## Topology: Space Distribution {#topology}

\`help-site/examples/v5-federated-cluster/run.ts\` distributes threads and messages across **three member spaces (\`member-1\`, \`member-2\`, \`member-3\`)**. The program composes \`RouterController\` and \`FederatedSpace\` directly; for operation, [\`createFederationController\`](help.api.federation_controller#overview) combines both with policy and membership.

The cluster is **simulated inside a single process**: **4 hosts** in memory (\`openOwnMemoryHost()\`) play member hosts with real federation components. There is no network, but the same routing and journal logic as in a truly distributed deployment.

- **1 coordinator host**: \`RouterController\` (\`router-root\` + 2 partition routers for the routing journals) and \`FederatedSpace\` (id \`fed-v5\`). The coordinator owns no chat-data space itself — it only executes the policy.
- **3 member hosts** (\`member-1\`, \`member-2\`, \`member-3\`): each owns its own independent space with its own space doc.
- **HRW sharding**: the federation policy routes \`Thread\`, \`Msg\`, and \`ChatTask\` by rendezvous hashing over \`fields.threadId\` deterministically onto exactly one member. The runner report field \`memberDistribution\` shows the actual placement, e.g. \`{ member-1: [alpha, gamma], member-2: [beta], member-3: [delta] }\`.
- **\`FederationIO\`** is an in-process adapter onto the local \`PhiSpaces\` objects in this demo, and so is the router's target adapter. In real distribution these would be RPC calls to remote hosts; the contract (\`step\`, \`snapshot\`, \`events\`, \`ack\`, \`txnActive\`) stays the same.
- **Replication**: 2 \`EntryReplicationController\` instances (\`rep-1\` on member-1, \`rep-2\` on member-2) replicate \`Presence\` via HLC + Last-Writer-Wins under the space ID \`presence-global\`. The program carries the changes once from \`rep-1\` to \`rep-2\` (\`changes\`, \`importChanges\`).

## Workflow {#workflow}

### Step 1: FederationPolicy With HRW By threadId {#step-1-policy}

All thread-scoped types (\`Thread\`, \`Msg\`, \`ChatTask\`) use \`mode: "expand"\`, \`by: { field: "threadId" }\` across \`["member-1", "member-2", "member-3"]\`:

- Every message and task belonging to the same thread deterministically lands on the same member space.
- Different threads distribute evenly across the 3 member spaces.
- Writes use \`federated.write(entry, { id, principal }, FOREVER)\`. The program writes four threads with one message each. \`FederatedSpace\` also offers member transactions (\`createTransaction(member, leaseMs, request)\`, \`finishTransaction(originId, "commit", request)\`); the program does not use them.

### Step 2: Federated Subagent Search Across All 3 Members {#step-2-federated-search}

\`federated.readAll({ type: "Msg" }, principal)\` queries every member space the template can match and returns \`{ entries, complete }\`. \`complete\` says whether all members answered. The program counts all messages of the cluster this way. This stage runs no search subagent; reading across all members is the basis for one.

### Step 3: LWW Presence, Waiter Race As API Only {#step-3-waiter-and-lww}

The program writes a \`Presence\` entry with \`rep1.mutate(...)\`, carries the change over, and reads it on \`rep-2\`. A conflict between two writers is decided by HLC and Last-Writer-Wins.

The program does not run \`takeWaiting\`. The method takes a task from whichever member has one first: \`federated.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)\`. Without a transaction it requires \`timeoutMs\` from 1 to 3,600,000 and \`txnLeaseMs\` from 1 to 60,000, otherwise it raises \`RoutingConflict\`.

### Run From Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
\`\`\`

## See Also {#see-also}

- [Stage 6 (v6-mobile-control): Mobile App & Web Admin Control](help.workflow.stage_v6_mobile_control#overview)`
		}
	},
	{
		id: "help.workflow.stage_v6_mobile_control",
		type: "workflow",
		provider: "ops",
		tags: ["v6", "mobile", "adminspaces", "steuerung", "rungate", "workers", "alerts", "audit", "eibrain"],
		related: ["help.workflow.stage_v5_federated_cluster", "help.topic.operations_mobile_and_replication"],
		since: "0.0.1",
		resources: [
			{
				id: "res-stage-v6",
				title: { de: "Stufe 6 Runner (v6-mobile-control & AdminSpaces)", en: "Stage 6 Runner (v6-mobile-control & AdminSpaces)" },
				summary: {
					de: "Demonstriert QR-Pairing (enrollQr), Worker-Skalierung (setWorkers), RunGate-Pause/Resume mit ACK-Barriere, Space-Archivierung, Alerts und Audit-Log.",
					en: "Demonstrates QR pairing (enrollQr), worker scaling (setWorkers), RunGate pause/resume with ACK barrier, space archiving, alerts, and audit log."
				},
				stage: "v6",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts"
			}
		],
		de: {
			title: "Stufe 6 (v6-mobile-control): Steuerung über Mobile App & Web-Admin (spaces.eibrain.org)",
			short: "Komplette Administration und Überwachung des Space-Clusters über die Android-App (pi-termux-mobile) und den login-geschützten Web-Bereich AdminSpaces.",
			body: `## Überblick {#overview}

Stufe 6 zeigt, wie man laufende Spaces bedient: Geräte koppeln, Worker starten und stoppen, Läufe pausieren, Spaces anlegen und archivieren. Das Programm führt diese Schritte lokal aus. Dieselben Aktionen gibt es im Web-Bereich AdminSpaces und auf den Steuerseiten der Android-App.

## Topologie: Space-Verteilung {#topology}

\`help-site/examples/v6-mobile-control/run.ts\` sowie der Web-Bereich **\`AdminSpaces\`** unter \`https://spaces.eibrain.org/?view=admin\` setzen die administrative Steuerung aus \`docs/betrieb-und-mobile-steuerung.md\` um. Die mobile App (\`spaces.html\` + \`steuerung.html\` in \`pi-termux-mobile\`) und die Webseite kennen dieselben Admin-Commands.

- **1 Host** (\`openOwnMemoryHost()\` im Runner) trägt **mehrere benannte Spaces**: den \`CONTROL_SPACE\` (Enroll, Audit), \`sieve-ops\` und einen per \`SpaceLifecycle\` erzeugten Chat-Space.
- Verteilung: ein Host, mehrere isolierte Spaces. Steuerbefehle landen im Control-Space, Chat-Daten bleiben im eigenen Daten-Space.

## Arbeitsablauf {#workflow}

### Schritt 1: Login in AdminSpaces & QR-Pairing für das Smartphone {#step-1-login-and-qr}

1. Auf \`https://spaces.eibrain.org\` klickt der Administrator oben rechts auf **\`ADMIN\`** und meldet sich mit dem konfigurierten privaten Web-Admin-Passwort an. Enrollment-Tokens koppeln ausschließlich Peers, sie öffnen keine Web-Sitzung.
2. Im ersten Bereich **Geräte-Pairing** erzeugt \`createEnroll\` ein neues Enrollment-Token samt \`enrollQr\`-Payload, das in \`spaces.html\` der Android-App eingefügt oder gescannt wird. Das Programm zeigt denselben Schritt lokal: \`enrollQr({ token, endpoint, controlSpaceId })\` und ein \`Enroll\`-Entry im Control-Space.

### Schritt 2: Worker-Skalierung, RunGate-Steuerung und Space-Lebenszyklus {#step-2-control}

Über die Aktionen in \`AdminSpaces\` (Web) und \`steuerung.html\` (Mobile) laufen folgende Vorgänge, jeweils mit einer \`commandId\`, die eine Wiederholung erkennbar macht. Das Programm ruft dieselben Controller direkt auf und zeigt davon Worker-Skalierung, Start/Pause/Resume, Archivieren/Reaktivieren, Alerts und Audit.

- **Worker steuern (\`listWorkers\` / \`setWorkers\`)**: Anzahl der Worker je Art (im Programm \`chat-worker\`, \`sieve\`), Host und Ziel-Space setzen (\`0\` stoppt nach dem laufenden Task).
- **Läufe & Wartungsfenster (\`startRun\` / \`pauseRun\` / \`resumeRun\` / \`stopRun\` / \`scheduleRun\` / \`exportRun\` / \`listRuns\`)**: Pausiert und setzt Verarbeitungsläufe über die \`RunGate\`-ACK-Barriere auf allen Members fort.
- **Spaces verwalten (\`createSpace\` / \`archiveSpace\` / \`reactivateSpace\` / \`deleteSpace\`)**: Legt neue Session-Spaces an oder schaltet abgeschlossene Spaces per \`archiveSpace\` in den schreibgeschützten Archivmodus.
- **Hinweise & Audit (\`listAlerts\` / \`auditLog\`)**: Zeigt Warnungen (\`collectAlerts\`) und die Historie der Admin-Aufträge.
- **Deployment (\`planDeployment\` / \`applyDeployment\` / \`startWorkers\` / \`exportDeployment\`)**: Plant und aktiviert Hosts, Spaces und Worker aus einer JSON-Konfiguration. Auf der Kommandozeile heißt das \`npm run bootstrap -- --check|--plan|--apply|--bind a=id|--start-workers|--export\`.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Betriebserweiterung (RunGate, Worker, Mobile/Web-Admin) & Phase-3-Replikation](help.topic.operations_mobile_and_replication#overview)`
		},
		en: {
			title: "Stage 6 (v6-mobile-control): Control via Mobile App & Web Admin (spaces.eibrain.org)",
			short: "Complete administration and monitoring of the space cluster via the Android app (pi-termux-mobile) and the login-protected AdminSpaces web area.",
			body: `## Overview {#overview}

Stage 6 shows how to operate running spaces: pair devices, start and stop workers, pause runs, create and archive spaces. The program performs these steps locally. The same actions exist in the AdminSpaces web area and on the control pages of the Android app.

## Topology: Space Distribution {#topology}

\`help-site/examples/v6-mobile-control/run.ts\` and the **\`AdminSpaces\`** web portal at \`https://spaces.eibrain.org/?view=admin\` implement the operational control defined in \`docs/betrieb-und-mobile-steuerung.md\`. The mobile app (\`spaces.html\` + \`steuerung.html\` in \`pi-termux-mobile\`) and the website know the same admin commands.

- **1 host** (\`openOwnMemoryHost()\` in the runner) carries **several named spaces**: the \`CONTROL_SPACE\` (enroll, audit), \`sieve-ops\`, and one chat space created via \`SpaceLifecycle\`.
- Distribution: one host, several isolated spaces. Control commands land in the control space while chat data stays in its own data space.

## Workflow {#workflow}

### Step 1: Login To AdminSpaces & QR Pairing For Mobile {#step-1-login-and-qr}

1. On \`https://spaces.eibrain.org\`, the administrator clicks **\`ADMIN\`** in the topbar and logs in with the configured private web-admin password. Enrollment tokens pair peers only; they open no web session.
2. In the first section, **Device Pairing**, \`createEnroll\` generates a fresh enrollment token and \`enrollQr\` payload to paste or scan in \`spaces.html\` on Android. The program shows the same step locally: \`enrollQr({ token, endpoint, controlSpaceId })\` and an \`Enroll\` entry in the control space.

### Step 2: Worker Scaling, RunGate Control, And Space Lifecycle {#step-2-control}

The actions in \`AdminSpaces\` (web) and \`steuerung.html\` (mobile) cover the operations below, each with a \`commandId\` that makes a repeat recognizable. The program calls the same controllers directly and shows worker scaling, start/pause/resume, archive/reactivate, alerts, and audit.

- **Scale Workers (\`listWorkers\` / \`setWorkers\`)**: Set the desired count per worker kind (in the program \`chat-worker\`, \`sieve\`), host, and target space (\`0\` stops after the active task).
- **Control Runs & Maintenance Windows (\`startRun\` / \`pauseRun\` / \`resumeRun\` / \`stopRun\` / \`scheduleRun\` / \`exportRun\` / \`listRuns\`)**: Pause and resume runs across all members via the confirmed \`RunGate\` ACK barrier.
- **Manage Spaces (\`createSpace\` / \`archiveSpace\` / \`reactivateSpace\` / \`deleteSpace\`)**: Create new session spaces idempotently or switch completed spaces into read-only \`archiveSpace\` mode.
- **Alerts & Audit (\`listAlerts\` / \`auditLog\`)**: Monitor active warnings (\`collectAlerts\`) and the history of admin commands.
- **Deployment (\`planDeployment\` / \`applyDeployment\` / \`startWorkers\` / \`exportDeployment\`)**: Plan and activate hosts, spaces, and workers from a JSON configuration. On the command line this is \`npm run bootstrap -- --check|--plan|--apply|--bind a=id|--start-workers|--export\`.

### Run From Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts
\`\`\`

## See Also {#see-also}

- [Operations Extension (RunGate, Workers, Mobile/Web Admin) & Phase 3 Replication](help.topic.operations_mobile_and_replication#overview)`
		}
	},
	// ---- API Reference Articles (14 canonical API entries) ----
	{
		id: "help.api.phispaces_write",
		type: "api",
		provider: "client",
		tags: ["write", "entry", "lease", "txn", "requestref", "mutation"],
		related: ["help.topic.entries_and_templates", "help.api.phispaces_take"],
		since: "0.0.1",
		de: {
			title: "write – Entry schreiben",
short: "Legt einen neuen typisierten Entry mit Lebensdauer an; unterstützt Request-Replay, atomare Singleton-Anlage per unique und transiente Ausgaben.",
			body: `## Überblick {#overview}

\`write\` legt einen neuen Eintrag in den Space, den andere Programme dann finden können. Du nutzt es für alles, was geteilt werden soll: Nachrichten, Aufgaben, Zustände. Ein vorhandener Eintrag wird nie überschrieben. Jeder Eintrag läuft nach einer gewählten Zeit ab oder bleibt dauerhaft.

## Technische Referenz {#technical-reference}

\`space.write(entry, txn?, lease?, options?)\` schreibt einen neuen Entry \`{ type, types?, fields }\` in den Space und gibt dessen \`Lease { id, expires }\` zurück. Ohne \`lease\` gilt \`ANY\`: Der Space wählt die Dauer.

\`\`\`ts
const lease = await space.write(
  { type: "Msg", fields: { threadId: "main", seq: 1, text: "Hallo" } },
  txnId ?? null,
  FOREVER,
  { request: { principal, generation, requestId: "msg-1" } }
);
\`\`\`

- **Unter Transaktion (\`txn\`)**: Der geschriebene Entry ist bis \`commit(txn)\` nur für Lese-/Take-Aufrufe derselben Transaktion sichtbar.
- **Idempotenz**: Mit \`options.request\` liefert eine Wiederholung mit denselben Argumenten dieselbe \`Lease\` zurück, ohne einen zweiten Entry anzulegen.
- **Mehrere Schritte**: \`batch(ops)\` schreibt mehrere Entries samt Commit in einem Aufruf (siehe [Transaktionen](help.api.phispaces_txn#parameters)).
- **Text**: Über den Dienst wird ein unpaariges Surrogat in Strings und Schlüsseln zu U+FFFD, bevor etwas den Aufruf sieht. \`cutText(text, max)\` aus \`phi-spaces\` kürzt Text ohne halbes Emoji.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| \`entry\` | \`EntryDraft\` | Entwurf: Pflicht-\`type\`, optionale Subtypenliste \`types\` und freie JSON-\`fields\`. |
| \`txn\` | \`string \| null\` | ID einer offenen Transaktion; \`null\` = sofortiger eigenständiger Commit. |
| \`lease\` | \`number\` | Lebensdauer in Millisekunden, \`FOREVER\` für unbegrenzt oder \`ANY\` (Standard, der Space wählt). |
| \`options.unique\` | \`string[]\` | Optionale atomare Erstanlage über Schlüsselfelder, je Space und nicht über Shards. Ein vorhandener Treffer, auch reserviert oder uncommitted, ergibt \`UniqueConflict\`. Remote benötigt \`write.unique\`. |
| \`options.transient\` | \`boolean\` | Legt keinen Entry an: Der Änderungsstrom trägt ein \`put\` mit \`transient: true\`, kein \`read\`, \`take\`, \`wait\`, \`count\` oder Abo sieht es. Nicht zusammen mit \`unique\`. Remote benötigt \`write.transient\`. |
| \`options.request\` | \`RequestRef\` | Optionaler Claim \`{ principal, generation, requestId }\` für neustartfeste Idempotenz. |
| **Rückgabe** | \`Promise<Lease>\` | \`{ id, expires }\` – Grundlage für \`renew\`/\`cancel\` und Presence-Heartbeats. |

## Typische Anwendungsfälle {#use-cases}

- **Chat-Nachrichten**: \`Msg\`-Entries mit \`FOREVER\`-Lease bilden das dauerhafte, anhängbare Gesprächslog.
- **Aufgaben einstellen**: Ein \`ChatTask\`-Entry aktiviert den Chat-Worker – der Produzent muss den Worker weder kennen noch erreichen.
- **Präsenz**: \`Presence\`-Entries mit 30-s-Lease; verschwindet ein Client, räumt der Reaper seinen Eintrag automatisch ab.
- **Geplante Aufgaben**: \`ScheduledJob\` + \`TimerLock\`-Lease realisieren Alarme und Wartungsfenster ohne eigenen Scheduler-Prozess.`
		},
		en: {
			title: "write – Write an Entry",
short: "Creates a new typed entry with a lifetime; supports request replay, atomic singleton creation through unique, and transient output.",
			body: `## Overview {#overview}

\`write\` puts a new entry into the space, where other programs can find it. Use it for anything to be shared: messages, tasks, state. An existing entry is never overwritten. Each entry expires after a time you choose or stays for good.

## Technical Reference {#technical-reference}

\`space.write(entry, txn?, lease?, options?)\` writes a new entry \`{ type, types?, fields }\` into the space and returns its \`Lease { id, expires }\`. Without \`lease\`, \`ANY\` applies: the space picks the duration.

\`\`\`ts
const lease = await space.write(
  { type: "Msg", fields: { threadId: "main", seq: 1, text: "Hello" } },
  txnId ?? null,
  FOREVER,
  { request: { principal, generation, requestId: "msg-1" } }
);
\`\`\`

- **Under Transaction (\`txn\`)**: The written entry is visible only to reads/takes carrying the same \`txn\` until \`commit(txn)\`.
- **Idempotency**: Passing \`options.request\` guarantees that retrying with identical arguments returns the original \`Lease\` without creating a second entry.
- **Several steps**: \`batch(ops)\` writes several entries and commits in one call (see [Transactions](help.api.phispaces_txn#parameters)).
- **Text**: Over the service, an unpaired surrogate in strings and keys becomes U+FFFD before anything sees the call. \`cutText(text, max)\` from \`phi-spaces\` shortens text without half an emoji.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| \`entry\` | \`EntryDraft\` | Immutable draft: mandatory \`type\`, optional subtype list \`types\`, and free-form JSON \`fields\`. |
| \`txn\` | \`string \| null\` | ID of an open transaction; \`null\` = immediate standalone commit. |
| \`lease\` | \`number\` | Lifetime in milliseconds, \`FOREVER\` for unbounded, or \`ANY\` (default, the space picks). |
| \`options.unique\` | \`string[]\` | Optional atomic creation by key fields, per space and not across shards. An existing match, even reserved or uncommitted, gives \`UniqueConflict\`. Remote requires \`write.unique\`. |
| \`options.transient\` | \`boolean\` | Creates no entry: the change stream carries a \`put\` with \`transient: true\`, and no \`read\`, \`take\`, \`wait\`, \`count\`, or subscription sees it. Not with \`unique\`. Remote requires \`write.transient\`. |
| \`options.request\` | \`RequestRef\` | Optional claim \`{ principal, generation, requestId }\` for restart-safe idempotency. |
| **Return** | \`Promise<Lease>\` | \`{ id, expires }\` – the basis for \`renew\`/\`cancel\` and presence heartbeats. |

## Typical Use Cases {#use-cases}

- **Chat messages**: \`Msg\` entries with \`FOREVER\` leases form the durable, append-only conversation log.
- **Submitting work**: A \`ChatTask\` entry activates the chat worker — the producer neither knows nor reaches the worker directly.
- **Presence**: \`Presence\` entries with 30-second leases; when a client disappears, the reaper removes its record automatically.
- **Scheduled jobs**: \`ScheduledJob\` + \`TimerLock\` leases implement alarms and maintenance windows without a dedicated scheduler process.`
		}
	},
	{
		id: "help.api.phispaces_read",
		type: "api",
		provider: "client",
		tags: ["read", "readifexists", "template", "wildcard", "timeout"],
		related: ["help.topic.entries_and_templates", "help.api.phispaces_take"],
		since: "0.0.1",
		de: {
			title: "read & readIfExists – Entry zerstörungsfrei lesen",
			short: "Sucht einen passenden sichtbaren Entry anhand eines Templates (fehlende/null-Felder sind Wildcards) und wartet bis zum Timeout.",
			body: `## Überblick {#overview}

\`read\` sucht einen Eintrag, der zu einem Muster passt, und lässt ihn im Space. Findet es noch keinen, wartet es bis zur angegebenen Zeit. Du nutzt es, um einen Zustand zu prüfen oder auf ein Ergebnis zu warten. \`readIfExists\` wartet nicht auf neue Einträge, sondern nur auf laufende Änderungen an vorhandenen.

## Technische Referenz {#technical-reference}

\`read(template, timeout, options?)\` gibt einen passenden \`EntryView\` zurück, ohne ihn aus dem Space zu entfernen. Ist noch kein Treffer sichtbar, wartet der Aufruf bis zu \`timeout\` Millisekunden (\`NO_WAIT = 0\` kehrt sofort zurück).

\`\`\`ts
const view = await space.read({ type: "SearchResult", fields: { searchId: "s-1" } }, 5_000);
const immediate = await space.readIfExists({ type: "Thread", fields: { threadId: "main" } }, 1_000);
\`\`\`

- \`readIfExists\` wartet **nur**, solange passende Entries durch fremde offene Transaktionen gesperrt sind; gibt es überhaupt keinen Treffer, kehrt es sofort mit \`null\` zurück.
- \`probe(template, timeout, { take? })\` sagt, warum nichts kam: \`{ entry, locked }\`, wobei \`locked: true\` einen Fehlschlag allein wegen gehaltener Treffer meldet. Es ist in \`SpaceLike\` optional; remote gehört es zum Feature \`read.locked\`.
- \`readExisting(space, template, waitMs, { txn })\` aus \`phi-spaces\` baut darauf auf: \`null\` heißt weg, ein noch gehaltener Treffer wirft \`StillHeld\`. Ohne \`probe\` gilt \`null\` als weg.
- \`peek(space, template, { txn })\` liest den ersten Treffer als Schnappschuss (\`readAll\` mit \`limit: 1\`) und hinterlässt keinen Claim.
- **Warten kostet wenig**: Lokal weckt eine Änderung den Aufruf, er schaut nach 20 bis 40 ms erneut. Remote pollt der Dienst alle 50 ms; mit \`wakeOnCommit\` schaut er beim ersten Commit und dann höchstens alle 25 ms.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| \`template\` | \`Template\` | Suchmuster \`{ type?, fields?, id? }\`; fehlende oder \`null\`-Felder wirken als Wildcards, \`types\`-Subtypen werden mitgematcht. |
| \`timeout\` | \`number\` | Maximale Wartezeit in ms; \`NO_WAIT = 0\` kehrt sofort zurück, \`FOREVER\` wartet unbegrenzt. |
| \`options.txn\` | \`string\` | Optional: Liest auch eigene, noch nicht committete Entwürfe derselben Transaktion. Weitere Optionen: \`deadline\`, \`request\`, lokal \`once\`. |
| **Rückgabe** | \`Promise<EntryView \| null>\` | Der passende Entry inklusive \`gid\`, \`type\`, \`fields\` und Metadaten – oder \`null\` bei Timeout. |

## Typische Anwendungsfälle {#use-cases}

- **Thread-Prüfung**: \`readIfExists({ type: "Thread", fields: { threadId } })\` prüft, ob ein Gesprächskontext bereits existiert, bevor ein Client ihn anlegt.
- **Ergebnis-Warte**: Der Subagent-Consumer wartet per \`read({ type: "SearchResult", fields: { searchId } }, 60_000)\` blockierend auf das Suchergebnis, statt zu pollen.
- **Zustand prüfen**: Einen Konfigurations- oder Ergebnis-Entry prüfen, ohne ihn zu verbrauchen. Reicht ein Schnappschuss ohne Claim, ist \`peek\` günstiger.`
		},
		en: {
			title: "read & readIfExists – Non-Destructive Entry Read",
			short: "Finds a matching visible entry using a template (missing/null fields are wildcards) and waits up to the timeout.",
			body: `## Overview {#overview}

\`read\` looks for an entry that matches a pattern and leaves it in the space. If there is none yet, it waits up to the given time. Use it to check a state or wait for a result. \`readIfExists\` does not wait for new entries, only for ongoing changes to existing ones.

## Technical Reference {#technical-reference}

\`read(template, timeout, options?)\` returns a matching \`EntryView\` without removing it from the space. If no match is visible yet, it waits up to \`timeout\` milliseconds (\`NO_WAIT = 0\` returns immediately).

\`\`\`ts
const view = await space.read({ type: "SearchResult", fields: { searchId: "s-1" } }, 5_000);
const immediate = await space.readIfExists({ type: "Thread", fields: { threadId: "main" } }, 1_000);
\`\`\`

- \`readIfExists\` waits **only** while matching entries are locked by another transaction; if no candidate exists at all, it returns \`null\` immediately.
- \`probe(template, timeout, { take? })\` says why nothing came: \`{ entry, locked }\`, where \`locked: true\` reports a miss caused only by held matches. It is optional in \`SpaceLike\`; remotely it belongs to the feature \`read.locked\`.
- \`readExisting(space, template, waitMs, { txn })\` from \`phi-spaces\` builds on it: \`null\` means gone, a match still held throws \`StillHeld\`. Without \`probe\`, \`null\` counts as gone.
- \`peek(space, template, { txn })\` reads the first match as a snapshot (\`readAll\` with \`limit: 1\`) and leaves no claim behind.
- **Waiting is cheap**: Locally a change wakes the call, which looks again after 20 to 40 ms. Remotely the service polls every 50 ms; with \`wakeOnCommit\` it looks at the first commit and then at most every 25 ms.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| \`template\` | \`Template\` | Query pattern \`{ type?, fields?, id? }\`; missing or \`null\` fields act as wildcards, \`types\` subtypes match as well. |
| \`timeout\` | \`number\` | Maximum wait in ms; \`NO_WAIT = 0\` returns immediately, \`FOREVER\` waits indefinitely. |
| \`options.txn\` | \`string\` | Optional: also reads your own uncommitted drafts inside the same transaction. More options: \`deadline\`, \`request\`, locally \`once\`. |
| **Return** | \`Promise<EntryView \| null>\` | The matching entry including \`gid\`, \`type\`, \`fields\`, and metadata – or \`null\` on timeout. |

## Typical Use Cases {#use-cases}

- **Thread check**: \`readIfExists({ type: "Thread", fields: { threadId } })\` verifies that a conversation context exists before a client creates it.
- **Result waiting**: The subagent consumer blocks via \`read({ type: "SearchResult", fields: { searchId } }, 60_000)\` instead of polling.
- **State checks**: Check a configuration or result entry without consuming it. If a snapshot without a claim is enough, \`peek\` is cheaper.`
		}
	},
	{
		id: "help.api.phispaces_take",
		type: "api",
		provider: "client",
		tags: ["take", "takeifexists", "exclusive", "reservation", "txn"],
		related: ["help.topic.leases_and_transactions", "help.api.phispaces_txn"],
		since: "0.0.1",
		de: {
			title: "take & takeIfExists – Entry exklusiv entnehmen oder reservieren",
			short: "Entfernt einen passenden Entry sofort destruktiv oder reserviert ihn exklusiv unter einer Transaktion (Rückkehr bei Abort/Lease-Ablauf).",
			body: `## Überblick {#overview}

\`take\` holt einen passenden Eintrag aus dem Space, und nur ein Aufrufer bekommt ihn. Das ist der Grundbaustein für Aufgaben: Mehrere Worker warten, einer gewinnt. Mit einer Transaktion ist die Entnahme vorläufig, und der Eintrag kommt zurück, wenn die Arbeit scheitert.

## Technische Referenz {#technical-reference}

Ohne \`txn\` ist die Entnahme sofort endgültig. Mit \`{ txn }\` wird der Entry für diese Transaktion reserviert und kehrt bei \`abort(txn)\` oder Ablauf der Transaktions-Lease automatisch in den Space zurück.

\`\`\`ts
const txn = await space.createTransaction(30_000);
const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
\`\`\`

- Steht der Entry-Typ unter einem \`RunGate\`, sind Entries nur nehmbar, solange der \`RunGate\` des Laufs auf \`running\` steht.
- \`takeIfExists\` wartet nur, solange Treffer gehalten werden. \`takeExisting(space, template, waitMs, { txn })\` unterscheidet zusätzlich fehlend von gehalten und wirft dann \`StillHeld\`.
- \`takeAll(space, template, { txn })\` nimmt jeden jetzt freien Treffer und liefert die Anzahl; gehaltene bleiben.
- \`awaitWork(space, template, waitMs, halt?)\` wartet auf Arbeit, ohne etwas zu halten: ein blockierendes \`read\` ohne Transaktion.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| \`template\` | \`Template\` | Suchmuster wie bei \`read\`; höchstens ein Consumer gewinnt den exklusiven Zugriff. |
| \`timeout\` | \`number\` | Wartezeit in ms bis ein passender Entry verfügbar ist (\`NO_WAIT\`/\`FOREVER\` möglich). |
| \`options.txn\` | \`string\` | Optional: Reserviert den Entry unter der Transaktion statt ihn sofort zu löschen. |
| **Rückgabe** | \`Promise<EntryView \| null>\` | Der entnommene bzw. reservierte Entry – oder \`null\` bei Timeout. |

## Typische Anwendungsfälle {#use-cases}

- **Worker-Reservierung**: Der Chat-Worker führt \`take({ type: "ChatTask" }, FOREVER, { txn })\` aus, schreibt die Antwort-\`Msg\` unter derselben \`txn\` und ruft \`commit(txn)\` – Aufgabe und Ergebnis erscheinen atomar.
- **Crash-Sicherheit**: Stürzt der Worker ab, läuft die Transaktions-Lease ab und der \`ChatTask\` kehrt automatisch in den Space zurück, wo ein anderer Worker ihn übernimmt.
- **Timer-Abrüstung**: Der Reaper entfernt abgelaufene \`TimerLock\`-Entries; \`tickAlarms()\` macht fällige \`ScheduledJob\`s danach zu \`ChatTask\`s.`
		},
		en: {
			title: "take & takeIfExists – Exclusively Remove or Reserve an Entry",
			short: "Removes a matching entry immediately or reserves it exclusively under a transaction (returning it on abort or lease expiry).",
			body: `## Overview {#overview}

\`take\` fetches a matching entry from the space, and only one caller gets it. This is the basic building block for tasks: several workers wait, one wins. With a transaction the removal is provisional, and the entry comes back if the work fails.

## Technical Reference {#technical-reference}

Without \`txn\`, removal is immediate. With \`{ txn }\`, the entry is reserved under that transaction and automatically returns to the space on \`abort(txn)\` or transaction lease expiry.

\`\`\`ts
const txn = await space.createTransaction(30_000);
const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
\`\`\`

- If the entry type is governed by a \`RunGate\`, entries are takeable only while the run's \`RunGate\` is in state \`running\`.
- \`takeIfExists\` waits only while matches are held. \`takeExisting(space, template, waitMs, { txn })\` also tells missing from held and then throws \`StillHeld\`.
- \`takeAll(space, template, { txn })\` takes every match free right now and returns the count; held ones stay.
- \`awaitWork(space, template, waitMs, halt?)\` waits for work while holding nothing: one blocking \`read\` without a transaction.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| \`template\` | \`Template\` | Query pattern as in \`read\`; at most one consumer wins exclusive access. |
| \`timeout\` | \`number\` | Wait time in ms until a matching entry becomes available (\`NO_WAIT\`/\`FOREVER\` allowed). |
| \`options.txn\` | \`string\` | Optional: reserves the entry under the transaction instead of deleting it immediately. |
| **Return** | \`Promise<EntryView \| null>\` | The removed or reserved entry – or \`null\` on timeout. |

## Typical Use Cases {#use-cases}

- **Worker reservation**: The chat worker runs \`take({ type: "ChatTask" }, FOREVER, { txn })\`, writes the reply \`Msg\` under the same \`txn\`, and calls \`commit(txn)\` — task and result appear atomically.
- **Crash safety**: If the worker crashes, the transaction lease expires and the \`ChatTask\` automatically returns to the space for another worker.
- **Timer disarming**: The reaper removes expired \`TimerLock\` entries; \`tickAlarms()\` then turns due \`ScheduledJob\`s into \`ChatTask\`s.`
		}
	},
	{
		id: "help.api.phispaces_txn",
		type: "api",
		provider: "client",
		tags: ["createtransaction", "commit", "abort", "txn", "atomic"],
		related: ["help.topic.leases_and_transactions", "help.topic.completion_profiles_and_limits"],
		since: "0.0.1",
		de: {
			title: "Transaktionen – createTransaction, commit & abort",
			short: "Bündelt Takes (Reservierungen) und Writes (unsichtbare Entwürfe) atomar; prüft beim Commit alle CompletionProfiles und Byte-Budgets.",
			body: `## Überblick {#overview}

Eine Transaktion fasst mehrere Schritte zusammen: Entweder gelten alle oder keiner. \`createTransaction\` beginnt sie, \`commit\` macht alles sichtbar, \`abort\` nimmt alles zurück. Du nutzt sie, wenn etwa eine Aufgabe und ihr Ergebnis nur gemeinsam zählen dürfen.

## Technische Referenz {#technical-reference}

\`createTransaction(lease?, options?)\` erzeugt eine neue Space-Transaktion. \`commit(txnId, options?)\` macht alle unter \`txnId\` geschriebenen Entries sichtbar und entfernt alle unter \`txnId\` genommenen Entries endgültig. \`abort(txnId, options?)\` verwirft alle Writes und gibt alle reservierten Takes frei.

\`\`\`ts
const txn = await space.createTransaction(60_000, { request: reqBegin });
// ... space.take(..., { txn: txn.id }) & space.write(..., txn.id) ...
await space.commit(txn.id, { request: reqCommit });
\`\`\`

## Verhalten und Garantien {#parameters}

- **Isolation**: Unter \`txn\` geschriebene Entries sind nur für Operationen mit derselben \`txnId\` sichtbar; reservierte Takes sind für andere Consumer gesperrt.
- **Atomarität**: \`commit\` wendet alle Writes und Takes gemeinsam an, erhöht \`rev\` genau einmal und stößt die zugehörigen Mailbox-Ereignisse an. \`abort\` verwirft alles und gibt reservierte Entries frei.
- **Lease**: Die Transaktion besitzt eine eigene Lease (Argument \`lease\`); bei Ablauf ohne Commit erfolgt implizit ein \`abort\`.
- **Vertragsprüfung**: Vor dem Commit prüft der Kern alle \`CompletionProfiles\` (\`CompletionViolation\` bei fehlenden Ergebnissen) und die konfigurierten Byte-Budgets (\`ResourceExhausted\`).
- **Ein Aufruf statt vieler**: \`batch(ops, { request? })\` führt Schritte in einem Commit aus, alle oder keiner: \`begin\`, \`write\`, \`take\`, \`read\`, \`commit\`, \`abort\`. \`txn: "$"\` meint die Transaktion des \`begin\` im selben Batch. Höchstens 64 Schritte; \`take\` und \`read\` warten hier nie. Remote gehört das zum Feature \`batch\`; ein Space mit Merge-Typen bietet es nicht an.

## Typische Anwendungsfälle {#use-cases}

- **Task-Verarbeitung**: \`take(ChatTask, { txn })\` + \`write(Msg, txn)\` + \`commit(txn)\` – die Antwort existiert nie ohne den konsumierten Task und umgekehrt.
- **Mehrschritt-Zustandswechsel**: \`take(Thread) + write(Thread')\` in einer \`txn\` ersetzt In-Place-Updates sicher.
- **Abbruch bei Fehlern**: Wirft die Verarbeitung (z.B. Modellaufruf), ruft der Worker \`abort(txn)\`, wird nichts halbfertig sichtbar.`
		},
		en: {
			title: "Transactions – createTransaction, commit & abort",
			short: "Groups takes (reservations) and writes (invisible drafts) atomically; verifies all CompletionProfiles and byte budgets on commit.",
			body: `## Overview {#overview}

A transaction groups several steps: either all count or none does. \`createTransaction\` starts it, \`commit\` makes everything visible, \`abort\` takes everything back. Use one when, say, a task and its result may only count together.

## Technical Reference {#technical-reference}

\`createTransaction(lease?, options?)\` starts a space transaction. \`commit(txnId, options?)\` publishes all entries written under \`txnId\` and permanently deletes all entries taken under \`txnId\`. \`abort(txnId, options?)\` discards all writes and releases all reserved takes.

\`\`\`ts
const txn = await space.createTransaction(60_000, { request: reqBegin });
// ... space.take(..., { txn: txn.id }) & space.write(..., txn.id) ...
await space.commit(txn.id, { request: reqCommit });
\`\`\`

## Behavior And Guarantees {#parameters}

- **Isolation**: Entries written under \`txn\` are visible only to operations carrying the same \`txnId\`; reserved takes are locked for other consumers.
- **Atomicity**: \`commit\` applies all writes and takes together, bumps \`rev\` exactly once, and emits the corresponding mailbox events. \`abort\` discards everything and releases reserved entries.
- **Lease**: The transaction owns a lease (the \`lease\` argument); expiry without commit implies an implicit \`abort\`.
- **Contract enforcement**: Before committing, the core checks all \`CompletionProfiles\` (\`CompletionViolation\` on missing results) and configured byte budgets (\`ResourceExhausted\`).
- **One call instead of many**: \`batch(ops, { request? })\` runs steps in one commit, all or none: \`begin\`, \`write\`, \`take\`, \`read\`, \`commit\`, \`abort\`. \`txn: "$"\` means the transaction of the \`begin\` in the same batch. At most 64 steps; \`take\` and \`read\` never wait here. Remotely this is the feature \`batch\`; a space with merge types does not offer it.

## Typical Use Cases {#use-cases}

- **Task processing**: \`take(ChatTask, { txn })\` + \`write(Msg, txn)\` + \`commit(txn)\` – the reply never exists without the consumed task and vice versa.
- **Multi-step state transitions**: \`take(Thread) + write(Thread')\` inside one \`txn\` replaces in-place updates safely.
- **Abort on failure**: If processing (e.g. a model call) throws, the worker calls \`abort(txn)\` and nothing half-finished becomes visible.`
		}
	},
	{
		id: "help.api.phispaces_lease",
		type: "api",
		provider: "client",
		tags: ["renew", "cancel", "lease", "ttl", "presence", "heartbeat"],
		related: ["help.topic.leases_and_transactions", "help.workflow.stage_v1_local_memory"],
		since: "0.0.1",
		de: {
			title: "Leases – renew & cancel",
			short: "Verlängert oder beendet die Lebensdauer eigener Entries, Transaktionen, Notify-Abos und Waiter (Grundlage für Presence & Heartbeats).",
			body: `## Überblick {#overview}

Alles im Space hat eine Lebensdauer. \`renew\` verlängert sie, \`cancel\` beendet sie sofort. Du nutzt das zum Beispiel für Anwesenheit: Solange ein Programm verlängert, gilt es als online. Bleibt die Verlängerung aus, räumt der Space den Eintrag selbst weg.

## Technische Referenz {#technical-reference}

\`renew(leaseId, ms, options?)\` setzt die neue Ablaufzeit einer eigenen Ressource auf \`now + ms\` (oder \`FOREVER\`) und gibt den neuen Ablauf-Zeitstempel zurück. \`cancel(leaseId, options?)\` beendet die Ressource sofort (entfernt den Entry, bricht die Transaktion ab oder kündigt das Abo/den Waiter).

\`\`\`ts
const presence = await space.write({ type: "Presence", fields: { username: "alice" } }, null, 30_000);
const newExpires = await space.renew(presence.id, 30_000);
await space.cancel(presence.id);
\`\`\`

## Verhalten {#parameters}

- **Ownership**: Eine Conversation darf nur eigene Leases ändern, fremde Aufrufe werden abgewiesen. Host-Code (ohne \`conversationId\`) ist nicht beschränkt; remote gilt die Identität der Verbindung.
- **\`renew\`**: Setzt \`expires = now + ms\` (oder \`FOREVER\`); funktioniert für Entry-Leases, Transaktions-Leases, Notify-Abos und geparkte Waiter.
- **\`cancel\`**: Beendet die Ressource sofort – bei einem Entry entspricht das dem Entfernen, bei einer Transaktion einem \`abort\`.
- **\`keepAlive(space, lease, leaseMs)\`** aus \`phi-spaces\`: Erneuert eine Lease alle \`leaseMs / 3\`, solange lange Arbeit läuft, und liefert die Stopp-Funktion. Stirbt der Prozess, läuft die Lease binnen \`leaseMs\` aus.

## Typische Anwendungsfälle {#use-cases}

- **Presence-Heartbeat**: Ein Client erneuert seine \`Presence\`-Lease regelmäßig vor Ablauf; bei Verbindungsabbruch läuft sie aus, und der Teilnehmer verschwindet automatisch aus der Online-Liste.
- **Lange Tasks**: Ein Worker mit aufwendiger Verarbeitung hält seine Transaktion mit \`keepAlive\` am Leben, damit die Reservierung nicht vorzeitig abläuft.
- **Sauberes Abmelden**: \`cancel(presence.id)\` beim geordneten Disconnect entfernt den Eintrag sofort statt auf den Reaper zu warten.`
		},
		en: {
			title: "Leases – renew & cancel",
			short: "Extends or cancels the lifetime of owned entries, transactions, notify subscriptions, and waiters (basis for presence & heartbeats).",
			body: `## Overview {#overview}

Everything in the space has a lifetime. \`renew\` extends it, \`cancel\` ends it at once. Presence is a typical use: as long as a program keeps renewing, it counts as online. When the renewals stop, the space removes the entry by itself.

## Technical Reference {#technical-reference}

\`renew(leaseId, ms, options?)\` updates the expiration of an owned resource to \`now + ms\` (or \`FOREVER\`) and returns the new expiration timestamp. \`cancel(leaseId, options?)\` terminates the resource immediately (removes the entry, aborts the transaction, or cancels the subscription/waiter).

\`\`\`ts
const presence = await space.write({ type: "Presence", fields: { username: "alice" } }, null, 30_000);
const newExpires = await space.renew(presence.id, 30_000);
await space.cancel(presence.id);
\`\`\`

## Behavior {#parameters}

- **Ownership**: A conversation may only change its own leases; foreign calls are rejected. Host code (without \`conversationId\`) is unrestricted; remotely the connection's identity applies.
- **\`renew\`**: Sets \`expires = now + ms\` (or \`FOREVER\`); works for entry leases, transaction leases, notify subscriptions, and parked waiters.
- **\`cancel\`**: Terminates the resource immediately – for an entry this equals removal, for a transaction an \`abort\`.
- **\`keepAlive(space, lease, leaseMs)\`** from \`phi-spaces\`: Renews a lease every \`leaseMs / 3\` while long work runs and returns the stop function. If the process dies, the lease lapses within \`leaseMs\`.

## Typical Use Cases {#use-cases}

- **Presence heartbeat**: A client renews its \`Presence\` lease regularly before it expires; on disconnect the lease expires and the participant automatically leaves the online list.
- **Long-running tasks**: A worker performing expensive processing keeps its transaction alive with \`keepAlive\` so the reservation does not expire early.
- **Clean sign-out**: \`cancel(presence.id)\` on an orderly disconnect removes the record immediately instead of waiting for the reaper.`
		}
	},
	{
		id: "help.api.phispaces_read_page_changes",
		type: "api",
		provider: "client",
		tags: ["readpage", "changes", "readall", "count", "stats", "snapshot"],
		related: ["help.topic.snapshots_and_change_streams"],
		since: "0.0.1",
		de: {
			title: "readPage & changes – Konsistente Snapshots und Revisionsströme",
			short: "Liest bytebegrenzte Seiten eines unveränderlichen Snapshots (mit token und rev) und holt nachfolgende Commit-Batches über changes(afterRev) auf.",
			body: `## Überblick {#overview}

\`readPage\` liest den Inhalt eines Space seitenweise, und alle Seiten zeigen denselben Stand. \`changes\` liefert danach nur noch, was sich seitdem geändert hat. Zusammen laden sie eine Ansicht vollständig und halten sie dann aktuell, ohne dass etwas fehlt oder doppelt kommt.

## Technische Referenz {#technical-reference}

\`readPage(template?, options?)\` und \`changes(afterRev, options?)\` ermöglichen konsistentes Initial-Laden und anschlussfähiges Live-Streaming ohne verlorene oder doppelte Ereignisse. Daneben stehen \`readAll(template?, { limit?, txn? })\`, \`count(template?, txn?)\` und \`stats()\` zur Verfügung.

\`\`\`ts
const firstPage = await space.readPage({ type: "Msg", fields: { threadId: "main" } });
const deltas = await space.changes(firstPage.rev);
const gauges = await space.stats();
\`\`\`

## Wichtige Methoden {#parameters}

| Methode | Rückgabe | Zweck |
| --- | --- | --- |
| \`readPage(template?, opts?)\` | \`Page { items, next, rev, streamId, token? }\` | Unveränderlicher Punkt-in-Zeit-Snapshot, bytebegrenzt seitenweise über \`next\` fortsetzbar. Passt die Antwort auf eine Seite, entsteht kein Snapshot und kein Token. |
| \`changes(afterRev, opts?)\` | \`Changes { streamId, batches, next, rev, more }\` | Alle seit \`afterRev\` committeten Deltas in Reihenfolge. Mit \`waitMs\` ein Long Poll bis zum ersten Batch. Ein Cursor außerhalb der gehaltenen Historie löst \`SnapshotExpired\` oder \`RevisionAhead\` aus. |
| \`readAll(template?, { limit?, txn? })\` | \`EntryView[]\` | Snapshot-Liste ohne eigenes Paging, älteste zuerst. Mit \`limit\` listet der Space nur so viele. |
| \`readChain(template, opts?)\` | \`ChainPage\` | Optional: bis zu 512 verkettete Entries aus einem Snapshot, ohne Commit (Feature \`read.chain\`). |
| \`count(template?, txn?)\` / \`stats()\` | \`number\` / Gauges | Schnelle Größen- und Füllstandsabfragen für Dashboards. |
| \`statsWithRevision()\` | \`{ stats, rev, streamId, process? }\` | Kennzahlen samt Revision; zwei Abfragen ergeben die Commits dazwischen. Remote trägt \`process\` CPU und Speicher des bedienenden Prozesses. |

## Typische Anwendungsfälle {#use-cases}

- **UI-Bootstrap + Live-Sync**: Der Chat-Client lädt die Thread-Historie per \`readPage\` und hängt sich anschließend mit \`changes(page.rev)\` an den Echtzeitstrom – lückenlos und ohne Duplikate.
- **Live Space-Inspector**: Der Inspektor der Workbench und \`AdminSpaces\` zeigen den aktuellen Bestand der Spaces; das Dashboard liest \`statsWithRevision\` und \`spaces()\`.
- **Backfill nach Reconnect**: Nach einer Unterbrechung holt der Client alle verpassten Revisions-Batches über \`changes\` nach, statt den gesamten Space neu zu laden.`
		},
		en: {
			title: "readPage & changes – Consistent Snapshots and Revision Streams",
			short: "Reads byte-bounded pages of an immutable snapshot (with token and rev) and catches up on subsequent commit batches via changes(afterRev).",
			body: `## Overview {#overview}

\`readPage\` reads the content of a space page by page, and all pages show the same state. \`changes\` then delivers only what has changed since. Together they load a view completely and keep it current, with nothing missing or repeated.

## Technical Reference {#technical-reference}

\`readPage(template?, options?)\` and \`changes(afterRev, options?)\` enable consistent initial loading followed by gapless live streaming. For quick queries, \`readAll(template?, { limit?, txn? })\`, \`count(template?, txn?)\`, and \`stats()\` are also available.

\`\`\`ts
const firstPage = await space.readPage({ type: "Msg", fields: { threadId: "main" } });
const deltas = await space.changes(firstPage.rev);
const gauges = await space.stats();
\`\`\`

## Key Methods {#parameters}

| Method | Return | Purpose |
| --- | --- | --- |
| \`readPage(template?, opts?)\` | \`Page { items, next, rev, streamId, token? }\` | Immutable point-in-time snapshot, continued page by page via \`next\` under a byte budget. If the answer fits one page, no snapshot and no token are made. |
| \`changes(afterRev, opts?)\` | \`Changes { streamId, batches, next, rev, more }\` | All commit deltas since \`afterRev\` in order. With \`waitMs\` a long poll until the first batch. A cursor outside the held history raises \`SnapshotExpired\` or \`RevisionAhead\`. |
| \`readAll(template?, { limit?, txn? })\` | \`EntryView[]\` | Snapshot list without paging of your own, oldest first. With \`limit\` the space lists only that many. |
| \`readChain(template, opts?)\` | \`ChainPage\` | Optional: up to 512 linked entries from one snapshot, without a commit (feature \`read.chain\`). |
| \`count(template?, txn?)\` / \`stats()\` | \`number\` / gauges | Fast size and fill-level queries for dashboards. |
| \`statsWithRevision()\` | \`{ stats, rev, streamId, process? }\` | Figures with their revision; two queries give the commits in between. Remotely, \`process\` carries CPU and memory of the serving process. |

## Typical Use Cases {#use-cases}

- **UI bootstrap + live sync**: The chat client loads the thread history via \`readPage\` and then attaches to the realtime stream with \`changes(page.rev)\` – gapless and without duplicates.
- **Live Space Inspector**: The workbench inspector and \`AdminSpaces\` show the current contents of the spaces; the dashboard reads \`statsWithRevision\` and \`spaces()\`.
- **Backfill after reconnect**: After an interruption, the client fetches all missed revision batches via \`changes\` instead of reloading the entire space.`
		}
	},
	{
		id: "help.api.phispaces_wait_notify_mailbox",
		type: "api",
		provider: "client",
		tags: ["wait", "notify", "events", "ack", "mailbox"],
		related: ["help.topic.durable_mailboxes_and_ack"],
		since: "0.0.1",
		de: {
			title: "wait, notify, events & ack – Reaktive Zustellung und Consumer-Mailboxes",
			short: "Parkt langlebige Read/Take-Wünsche oder Event-Abos ohne Turn-Blockade; liefert Ergebnisse über dauerhafte Mailboxes mit Präfix-ACK.",
			body: `## Überblick {#overview}

\`wait\` und \`notify\` lassen ein Programm auf etwas warten, ohne dabei stehen zu bleiben. \`wait\` meldet einmal einen passenden Eintrag, \`notify\` meldet jeden neuen. Die Meldungen liegen in einem Postfach, das auch einen Neustart übersteht. Mit \`events\` liest du es, mit \`ack\` bestätigst du das Verarbeitete.

## Technische Referenz {#technical-reference}

\`wait\` und \`notify\` registrieren dauerhafte Aufträge im Space-Dokument. Über \`events\` und \`ack\` verarbeiten Consumer die ausgelieferten Ereignisse zuverlässig über Neustarts hinweg. Lokal lauten die Aufrufe \`events(principal, { mailboxEpoch?, after?, maxBytes? })\` und \`ack(principal, epoch, upTo)\`. Remote kommt der Consumer aus der Verbindung: \`events({ mailboxEpoch?, after?, maxBytes?, waitMs? })\` und \`ack(epoch, upTo)\`, mit \`target: "self"\` bei \`wait\` und \`notify\`. Beide brauchen \`startService\`, damit Zustellung und Reaper im Leerlauf laufen.

\`\`\`ts
const waitId = await space.wait(
  { type: "ChatTask" },
  { take: true, target: conversationId, timeout: FOREVER, txnLeaseMs: 60_000, handback: { worker: "w1" } }
);
const mailboxPage = await space.events(principal, { after: lastSeq });\nif (mailboxPage.gap) throw new Error("Mailbox reset: reload state before processing");\nfor (const item of mailboxPage.events) await handleEvent(item.event); // Commit any take reservation first.
if (mailboxPage.events.length > 0) {
  await space.ack(principal, mailboxPage.mailboxEpoch, mailboxPage.next);
}
\`\`\`

## Wichtige Methoden {#parameters}

| Methode | Zweck |
| --- | --- |
| \`wait(template, opts)\` | Parkt einen langlebigen Read-/Take-Wunsch (\`take: true\` reserviert automatisch unter einer impliziten Transaktion mit \`txnLeaseMs\`); liefert die Treffer an die Mailbox von \`target\`. |
| \`notify(template, opts)\` | Abonniert Änderungen auf ein Template und liefert Events in die eigene Principal-Mailbox. |
| \`events(principal, { mailboxEpoch?, after?, maxBytes? })\` | Bytebegrenzte Seite ausgelieferter Ereignisse ab Sequenz \`after\`; \`mailboxEpoch\`-Mismatch meldet eine \`gap\` statt stiller Verluste. |
| \`ack(principal, epoch, upTo)\` | Bestätigt ein verarbeitetes Sequenz-Präfix; bestätigte Ereignisse werden entfernt; TTL-Ablauf kann mit gap ebenfalls aufräumen. |

## Typische Anwendungsfälle {#use-cases}

- **Ereignisgesteuerter Worker**: Statt \`take(..., FOREVER)\` zu blockieren, parkt der Worker einen dauerhaften Take-Wunsch mit \`wait\`; \`phi-spaces\` legt gewonnene Tasks samt \`handback\`-Kontext in seine Mailbox.
- **Robuster Consumer**: Der Worker verarbeitet \`events\`-Seiten und ackt erst nach erfolgreichem \`commit\` – bei Neustart werden unbestätigte Ereignisse erneut geliefert (At-least-once).
- **Notify-Streams**: UI- oder Audit-Consumer abonnieren \`notify({ type: "Msg" })\` und bleiben über \`events\`/\`ack\` über passende Writes informiert (keine vollständige Änderungs-/Löschhistorie), auch über Prozessneustarts hinweg.`
		},
		en: {
			title: "wait, notify, events & ack – Reactive Delivery and Consumer Mailboxes",
			short: "Parks long-lived read/take requests or event subscriptions without blocking a turn; delivers results via durable mailboxes with prefix ACK.",
			body: `## Overview {#overview}

\`wait\` and \`notify\` let a program wait for something without standing still. \`wait\` reports one matching entry once, \`notify\` reports each new one. The reports land in a mailbox that survives a restart. \`events\` reads it, and \`ack\` confirms what was processed.

## Technical Reference {#technical-reference}

\`wait\` and \`notify\` register durable subscriptions in the space document. Consumers process delivered events through \`events\` and \`ack\` across restarts. Locally the calls are \`events(principal, { mailboxEpoch?, after?, maxBytes? })\` and \`ack(principal, epoch, upTo)\`. Remotely the consumer comes from the connection: \`events({ mailboxEpoch?, after?, maxBytes?, waitMs? })\` and \`ack(epoch, upTo)\`, with \`target: "self"\` for \`wait\` and \`notify\`. Both need \`startService\` so that delivery and the reaper run while idle.

\`\`\`ts
const waitId = await space.wait(
  { type: "ChatTask" },
  { take: true, target: conversationId, timeout: FOREVER, txnLeaseMs: 60_000, handback: { worker: "w1" } }
);
const mailboxPage = await space.events(principal, { after: lastSeq });\nif (mailboxPage.gap) throw new Error("Mailbox reset: reload state before processing");\nfor (const item of mailboxPage.events) await handleEvent(item.event); // Commit any take reservation first.
if (mailboxPage.events.length > 0) {
  await space.ack(principal, mailboxPage.mailboxEpoch, mailboxPage.next);
}
\`\`\`

## Key Methods {#parameters}

| Method | Purpose |
| --- | --- |
| \`wait(template, opts)\` | Parks a long-lived read/take wish (\`take: true\` reserves automatically under an implicit transaction with \`txnLeaseMs\`); delivers matches to the \`target\` mailbox. |
| \`notify(template, opts)\` | Subscribes to changes matching a template and delivers events into the caller's principal mailbox. |
| \`events(principal, { mailboxEpoch?, after?, maxBytes? })\` | Byte-bounded page of delivered events after sequence \`after\`; a \`mailboxEpoch\` mismatch reports a \`gap\` instead of silent loss. |
| \`ack(principal, epoch, upTo)\` | Acknowledges a processed sequence prefix; acknowledged events are removed; TTL expiry can also remove events with a gap. |

## Typical Use Cases {#use-cases}

- **Event-driven worker**: Instead of blocking in \`take(..., FOREVER)\`, the worker parks a durable take wish with \`wait\`; \`phi-spaces\` places won tasks including the \`handback\` context into its mailbox.
- **Robust consumer**: The worker processes \`events\` pages and acks only after a successful \`commit\` – on restart, unacknowledged events are delivered again (at-least-once).
- **Notify streams**: UI or audit consumers subscribe via \`notify({ type: "Msg" })\` and stay informed about matching writes (not a complete deletion/change history) through \`events\`/\`ack\`, even across process restarts.`
		}
	},
	{
		id: "help.api.phispaces_claims",
		type: "api",
		provider: "client",
		tags: ["issuegeneration", "polloperation", "resolveoperation", "canceloperation", "requestref"],
		related: ["help.topic.request_claims_and_generations"],
		since: "0.0.1",
		de: {
			title: "Request-Claims & Generationen – Neustartfeste Idempotenz",
			short: "Bindet Mutationen und blockierende Operationen atomar an {principal, generation, requestId} und einen kanonischen RFC-8785-Argument-Hash.",
			body: `## Überblick {#overview}

Geht eine Antwort im Netz verloren, weiß der Aufrufer nicht, ob sein Auftrag angekommen ist. Diese Aufrufe lösen das: Jeder Auftrag bekommt eine feste Kennung, und eine Wiederholung liefert das erste Ergebnis. \`issueGeneration\` eröffnet einen Bereich für solche Kennungen, \`pollOperation\` fragt den Stand eines Auftrags ab.

## Technische Referenz {#technical-reference}

\`issueGeneration(principal)\` erzeugt eine signierte Generation und liefert \`{ generation, admitUntil }\`. \`pollOperation(request)\` fragt den Status eines bekannten Claims ab (\`pending\`, \`done\`, \`cancelled\`), \`cancelOperation(request)\` bricht eine noch wartende Operation gezielt ab, und \`resolveOperation\` klärt vor dem Router-Retry die Admission-Bindung. \`RemoteSpace\` erledigt das selbst: Es eröffnet eine Generation und gibt jeder Mutation eine Request-ID.

\`\`\`ts
const { generation } = await space.issueGeneration({ peerId: "alice" });
const status = await space.pollOperation({ principal: { peerId: "alice" }, generation, requestId: "req-1" });
\`\`\`

## Wichtige Methoden {#parameters}

| Methode | Zweck |
| --- | --- |
| \`issueGeneration(principal)\` | Vergibt eine neue Generation (inkarnationsfest); alle Requests dieser Sitzung tragen \`{ principal, generation, requestId }\`. |
| \`pollOperation(request)\` | Fragt den Status eines Claims ab: \`pending\`, \`done\` (mit Ergebnis; \`locked\`, wenn ein \`IfExists\`-Aufruf nur gehaltene Treffer sah) oder \`cancelled\`. |
| \`cancelOperation(request)\` | Storniert eine noch wartende blockierende Operation gezielt. |
| \`resolveOperation(req, method, argHash, epoch)\` | Klärt vor einem Router-/Client-Retry, ob eine Admission bereits an denselben Argument-Hash gebunden ist. |

## Typische Anwendungsfälle {#use-cases}

- **Reconnect ohne Duplikate**: Bricht die WebSocket-/TCP-Verbindung mitten in \`write(msg)\` ab, sendet der Client denselben \`RequestRef\` erneut – der Space liefert das bereits verbuchte Ergebnis statt einer zweiten Nachricht.
- **Unklare Ausgänge auflösen**: Nach \`OutcomeUnknown\` (Timeout beim Commit) fragt der Client per \`pollOperation\` nach, ob die Mutation doch erfolgte.
- **Generation-Mixup-Schutz**: Startet ein Client neu, erhält er eine frische Generation; Claims alter Generationen können nicht mit Neuem kollidieren.`
		},
		en: {
			title: "Request Claims & Generations – Restart-Safe Idempotency",
			short: "Binds mutations and blocking operations atomically to {principal, generation, requestId} and a canonical RFC-8785 argument hash.",
			body: `## Overview {#overview}

When a reply gets lost on the network, the caller does not know whether its command arrived. These calls solve that: each command gets a fixed identity, and a repeat returns the first result. \`issueGeneration\` opens a range for such identities, \`pollOperation\` asks for a command's state.

## Technical Reference {#technical-reference}

\`issueGeneration(principal)\` issues a signed generation and returns \`{ generation, admitUntil }\`. \`pollOperation(request)\` inspects the status of a known claim (\`pending\`, \`done\`, \`cancelled\`), \`cancelOperation(request)\` cancels a pending operation, and \`resolveOperation\` resolves admission bindings before router retries. \`RemoteSpace\` does this by itself: it opens a generation and gives each mutation a request ID.

\`\`\`ts
const { generation } = await space.issueGeneration({ peerId: "alice" });
const status = await space.pollOperation({ principal: { peerId: "alice" }, generation, requestId: "req-1" });
\`\`\`

## Key Methods {#parameters}

| Method | Purpose |
| --- | --- |
| \`issueGeneration(principal)\` | Issues a new incarnation-safe generation; all requests of this session carry \`{ principal, generation, requestId }\`. |
| \`pollOperation(request)\` | Queries the status of a claim: \`pending\`, \`done\` (with result; \`locked\` when an \`IfExists\` call saw only held matches), or \`cancelled\`. |
| \`cancelOperation(request)\` | Deliberately cancels a still-pending blocking operation. |
| \`resolveOperation(req, method, argHash, epoch)\` | Resolves before a router/client retry whether an admission is already bound to the same argument hash. |

## Typical Use Cases {#use-cases}

- **Reconnect without duplicates**: If the WebSocket/TCP connection drops during \`write(msg)\`, the client resends the same \`RequestRef\` – the space returns the already-recorded result instead of a second message.
- **Resolving unclear outcomes**: After \`OutcomeUnknown\` (timeout during commit), the client uses \`pollOperation\` to check whether the mutation actually succeeded.
- **Generation mixup protection**: On restart a client receives a fresh generation; claims from older generations cannot collide with new ones.`
		}
	},
	{
		id: "help.api.phispaces_completion_profiles",
		type: "api",
		provider: "core",
		tags: ["setcompletionprofiles", "setlimits", "completionprofile", "completionviolation"],
		related: ["help.topic.completion_profiles_and_limits"],
		since: "0.0.1",
		de: {
			title: "setCompletionProfiles & setLimits – Serverseitige Ergebnis- und Budgetverträge",
			short: "Erzwingt vor dem Commit einer Take-Transaktion den erwarteten Ergebnistyp, korrelierende Felder (equalFields) und Anzahl; verwaltet Byte-Limits.",
			body: `## Überblick {#overview}

\`setCompletionProfiles\` legt fest, welches Ergebnis zu einer Aufgabe gehört. Der Space lehnt dann jeden Abschluss ab, bei dem das Ergebnis fehlt. \`setLimits\` setzt Größengrenzen für den Space. Beide Aufrufe sind dem Host vorbehalten, und du machst sie einmal beim Einrichten.

## Technische Referenz {#technical-reference}

Nur administrativer Host-Code (ohne gesetztes \`conversationId\`) darf \`setCompletionProfiles(profiles)\` und \`setLimits(partialLimits)\` aufrufen. Das erneute Setzen identischer Profile ist ein No-op. Eine Absenkung von Limits unter bereits bestehende Abschlussverpflichtungen wird vom Space-Kern abgewiesen; das gilt auch für ein kleineres \`maxEventBytes\`, solange eine bestehende Registrierung oder ein Wait damit ein zu großes Event erzeugen könnte.

\`\`\`ts
await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
\`\`\`

## Profil-Felder und Fehler {#parameters}

| Feld | Bedeutung |
| --- | --- |
| \`taskType\` | Entry-Typ, der unter der Transaktion genommen wurde und eine Ergebnispflicht auslöst. |
| \`resultTypes\` | Entry-Typen, von denen in derselben Transaktion ein Ergebnis geschrieben werden muss. |
| \`equalFields\` | Felder, deren Werte zwischen Task und Ergebnis übereinstimmen müssen (Korrelation). |
| \`maxResultCount\` | Höchstzahl korrelierender Ergebnisse; mindestens eines ist erforderlich. |
| \`maxResultBytes\` | Gesamtbytegrenze der zu einem Task gehörenden Ergebnisse. |
| \`maxLeaseMs\` | Obergrenze für die Reservierung. |
| \`gateField\` | Bindet Tasks an den \`RunGate\` ihres Laufs; muss in \`equalFields\` stehen, \`maxLeaseMs\` ist dann Pflicht. |

Verletzt ein Commit das Profil, schlägt \`commit\` mit \`CompletionViolation\` fehl und nichts wird sichtbar. \`setLimits\` verwaltet Byte-/Größenbudgets des Spaces (z.B. \`maxFrameBytes\`, \`maxEventBytes\`, \`mailboxTtlMs\`). Eine Anzahlquote gibt es standardmäßig nicht: \`maxEntries\` und \`maxEntriesPerOwner\` stehen auf \`FOREVER\`, Byte-, Commit-, Frame- und Dokumentbudgets gelten weiter.

## Typische Anwendungsfälle {#use-cases}

- **Antwortgarantie im Chat**: Der Commit scheitert serverseitig, wenn der Worker den \`ChatTask\` entnimmt, aber keine passende \`Msg\` mit gleicher \`taskId\`/\`threadId\` schreibt – die Reservierung kann bei Abort zurückgegeben werden, solange Task-Lease und Storage bestehen.
- **Subagent-Vertrag**: \`SearchTask → SearchResult\` garantiert, dass jede föderierte Suche mit einem korrelierten Ergebnis endet.`
		},
		en: {
			title: "setCompletionProfiles & setLimits – Server-Side Result and Budget Contracts",
			short: "Enforces expected result type, correlating fields (equalFields), and count before committing a take transaction; manages byte limits.",
			body: `## Overview {#overview}

\`setCompletionProfiles\` defines which result belongs to a task. The space then refuses every completion where the result is missing. \`setLimits\` sets size limits for the space. Both calls are reserved for the host, and you make them once during setup.

## Technical Reference {#technical-reference}

Only administrative host code (without \`conversationId\`) may invoke \`setCompletionProfiles(profiles)\` and \`setLimits(partialLimits)\`. Setting identical profiles again is a no-op. Lowering limits below existing completion obligations is rejected by the space core; this includes a smaller \`maxEventBytes\` while an existing registration or wait could then produce an oversized event.

\`\`\`ts
await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
\`\`\`

## Profile Fields And Errors {#parameters}

| Field | Meaning |
| --- | --- |
| \`taskType\` | Entry type taken under the transaction that triggers a result obligation. |
| \`resultTypes\` | Entry types of which a result must be written within the same transaction. |
| \`equalFields\` | Fields whose values must match between task and result (correlation). |
| \`maxResultCount\` | Maximum correlating result count; at least one is required. |
| \`maxResultBytes\` | Total result bytes assigned to one task. |
| \`maxLeaseMs\` | Upper bound for the reservation. |
| \`gateField\` | Binds tasks to their run's \`RunGate\`; must be in \`equalFields\`, and \`maxLeaseMs\` is then required. |

If a commit violates the profile, \`commit\` fails with \`CompletionViolation\` and nothing becomes visible. \`setLimits\` manages the space's byte/size budgets (e.g. \`maxFrameBytes\`, \`maxEventBytes\`, \`mailboxTtlMs\`). By default there is no count quota: \`maxEntries\` and \`maxEntriesPerOwner\` are \`FOREVER\`; byte, commit, frame, and document budgets still apply.

## Typical Use Cases {#use-cases}

- **Reply guarantee in chat**: The commit fails server-side if the worker takes a \`ChatTask\` but writes no matching \`Msg\` with the same \`taskId\`/\`threadId\` – abort can return the reservation while the task lease and storage remain available.
- **Subagent contract**: \`SearchTask → SearchResult\` guarantees that every federated search ends with a correlated result.`
		}
	},
	{
		id: "help.api.agent_tools",
		type: "api",
		provider: "tools",
		tags: ["spaces", "createspaces", "startservice", "space_write", "space_take", "space_txn"],
		related: ["help.topic.agent_tools_and_replay"],
		since: "0.0.1",
		de: {
			title: "Agent-Tools (spaces) & startService – Replay-sichere LLM-Werkzeuge",
			short: "Stellt KI-Agenten 8 replay-sichere Tools mit Request-Identität pro Aufruf und Ownership-Schutz bereit; startService betreibt Reaper und Zustellung.",
			body: `## Überblick {#overview}

Diese Werkzeuge geben einem Sprachmodell Zugriff auf einen Space: schreiben, lesen, nehmen und warten. Wird ein Aufruf nach einem Absturz wiederholt, wirkt er trotzdem nur einmal. Das Paket ist optional; für einen Space ohne Agenten brauchst du es nicht.

## Technische Referenz {#technical-reference}

Die Werkzeuge kommen aus dem optionalen Agent-Paket (\`agent/\`, eigene Abhängigkeiten: pi-durable, pi-ai und Chord in 1.4.0). \`createSpaces(localSpaces(host))\` erzeugt die Erweiterung für die Agenten-Registry von \`pi-durable\`. Der Space liegt dabei nicht im Speicher der Agenten, sondern auf einem eigenen Host (dem eigenen Speicher). Er überlebt so einen Neustart der Agenten, und umgekehrt.

\`startService(withEventSink(host, agentHost), ctx, { space? })\` startet die Hintergrundschleife für Lease-Ablauf (\`core.reap\`) und die Zustellung an die Conversations der Agenten. Ein pi-durable-Harness 1.4 wird mit \`withAgentEventSink(host, harness)\` aus \`agent/src/agent.ts\` angebunden: Es ergänzt den Kontext, den Harness und Space unterschiedlich erwarten. \`withEventSink\` aus \`phi-spaces\` nimmt jede andere \`EventSink\`.

\`\`\`ts
const spaces = createSpaces(localSpaces(host)); // the space: its own host
registry.install(spaces); // the agents' registry (pi-durable)
const stopService = await startService(withEventSink(host, agentHost), ctx);
\`\`\`

## Die 8 Werkzeuge und ihre Sicherheit {#parameters}

| Tool | Zweck |
| --- | --- |
| \`space_write\`, \`space_read\`, \`space_take\` | Grundlegende Entry-Operationen; jeder Tool-Aufruf ist eine eigene Request-Identität des Spaces. |
| \`space_list\` | Auflisten sichtbarer Entries eines Spaces/Templates (read-only). |
| \`space_txn\` | Beginnen, committen oder abbrechen von Transaktionen aus dem Agenten heraus. |
| \`space_wait\`, \`space_notify\` | Langlebige Wünsche und Abos ohne den Agenten-Turn zu blockieren. |
| \`space_lease\` | \`renew\`/\`cancel\` für eigene Ressourcen. |

Jeder Tool-Aufruf erhält eine Request-Identität (die Generation der Conversation und die Task-ID des Aufrufs). Sie wird vor dem ersten Space-Aufruf im Speicher der Agenten festgehalten. Der Space speichert Operation und Ergebnis zusammen: Ein nach einem Absturz wiederholter Aufruf erhält das erste Ergebnis. Ein Aufruf, dessen Generation nicht mehr zulässt, wird abgewiesen (\`RequestExpired\`) und nie neu ausgeführt. Ohne verbundenen Agenten-Host warten Ereignisse im Postausgang des Spaces; nur für eine nicht mehr existierende Conversation werden sie verworfen. Nur \`space_list\` läuft ohne Request-Identität.

Jedes Werkzeug liefert sein Ergebnis seit pi 1.4.0 als \`{ output: [{ type: "text", text }] }\` mit JSON-Text (vorher \`content\`). \`space_read\` und \`space_take\` halten den Turn höchstens 60 Sekunden; \`space_wait\` wartet ohne Turn-Blockade, standardmäßig ohne Ende. \`space_list\` liefert höchstens \`limit\` Entries (Standard 100, Maximum 1000).

Werkzeugbeschreibungen und Prompt-Abschnitt sagen dem Modell, dass Entry-Inhalte Daten anderer Agenten sind und nie Anweisungen. Eine Auszeichnung im Ergebnis selbst gibt es nicht: Das Ergebnis ist das JSON des Entries. Ownership-Checks verhindern, dass ein Agent fremde Leases oder Claims manipuliert. \`startService\` betreibt den Lease-Reaper, die Waiter-Wecklogik und die Mailbox-Zustellung. Auch ohne Hintergrunddienst wird Ablauf bei Zugriffen abgeglichen; ohne Zustelldienst kommen Conversation-Ereignisse nicht automatisch an.

## Typische Anwendungsfälle {#use-cases}

- **KI-Chat-Agent**: Ein LLM beantwortet \`ChatTask\`s über \`space_take\`/\`space_write\`, bleibt dank der Request-Identität jedes Aufrufs bei Replays duplikatfrei.
- **Zusammenarbeit**: Ein Agent stellt Aufgaben mit \`space_write\` ein, ein anderer wartet mit \`space_wait\` darauf, ohne seinen Turn zu blockieren.`
		},
		en: {
			title: "Agent Tools (spaces) & startService – Replay-Safe LLM Tools",
			short: "Provides AI agents with 8 replay-safe tools with a request identity per call and ownership protection; startService runs the reaper and delivery.",
			body: `## Overview {#overview}

These tools give a language model access to a space: write, read, take, and wait. If a call is repeated after a crash, it still takes effect only once. The package is optional; a space without agents does not need it.

## Technical Reference {#technical-reference}

The tools come from the optional agent package (\`agent/\`, with its own dependencies: pi-durable, pi-ai, and Chord at 1.4.0). \`createSpaces(localSpaces(host))\` makes the extension for the agents' \`pi-durable\` registry. The space does not live in the agents' store but on a host of its own (the own store), so it survives an agent restart, and the other way round.

\`startService(withEventSink(host, agentHost), ctx, { space? })\` starts the background loop for lease expiration (\`core.reap\`) and delivery to the agents' conversations. A pi-durable 1.4 harness connects through \`withAgentEventSink(host, harness)\` from \`agent/src/agent.ts\`: it adds what harness and space each expect of the context. \`withEventSink\` from \`phi-spaces\` takes any other \`EventSink\`.

\`\`\`ts
const spaces = createSpaces(localSpaces(host)); // the space: its own host
registry.install(spaces); // the agents' registry (pi-durable)
const stopService = await startService(withEventSink(host, agentHost), ctx);
\`\`\`

## The 8 Tools And Their Safety {#parameters}

| Tool | Purpose |
| --- | --- |
| \`space_write\`, \`space_read\`, \`space_take\` | Fundamental entry operations; every tool call is a request identity of its own in the space. |
| \`space_list\` | Lists visible entries of a space/template (read-only). |
| \`space_txn\` | Starts, commits, or aborts transactions from within the agent. |
| \`space_wait\`, \`space_notify\` | Long-lived wishes and subscriptions without blocking the agent's turn. |
| \`space_lease\` | \`renew\`/\`cancel\` for owned resources. |

Every tool call gets a request identity (the conversation's generation and the call's task id), recorded in the agents' store before the first space call. The space keeps the operation and its result together: a call repeated after a crash gets the first result. A call whose generation no longer admits is refused (\`RequestExpired\`) and never run anew. Without a connected agent host, events wait in the space's outbox; they are dropped only for a conversation that no longer exists. Only \`space_list\` runs without a request identity.

Since pi 1.4.0 every tool returns its result as \`{ output: [{ type: "text", text }] }\` with JSON text (formerly \`content\`). \`space_read\` and \`space_take\` hold the turn for at most 60 seconds; \`space_wait\` waits without blocking the turn, by default forever. \`space_list\` returns at most \`limit\` entries (default 100, maximum 1000).

Tool descriptions and the prompt section tell the model that entry contents are data from other agents, never instructions. There is no marking in the result itself: the result is the entry's JSON. Ownership checks prevent an agent from manipulating foreign leases or claims. \`startService\` runs the lease reaper, waiter wakeup logic, and mailbox delivery. Operations still settle expiry without background maintenance; conversation delivery needs a running delivery service.

## Typical Use Cases {#use-cases}

- **AI chat agent**: An LLM answers \`ChatTask\`s via \`space_take\`/\`space_write\`, staying duplicate-free under replays thanks to each call's request identity.
- **Collaboration**: One agent posts tasks with \`space_write\`, another waits for them with \`space_wait\` without blocking its turn.`
		}
	},
	{
		id: "help.api.space_service_and_remote",
		type: "api",
		provider: "remote",
		tags: ["spaceservice", "servespace", "remotespace", "sockettransport", "inprocesstransport"],
		related: ["help.topic.space_service_and_remote_space", "help.workflow.stage_v3_remote_socket"],
		since: "0.0.1",
		de: {
			title: "SpaceService, serveSpace & RemoteSpace – Netzwerk-RPC über Socket & TCP",
			short: "Veröffentlicht Spaces über Unix-Socket oder TCP, auch als eigenständiger Dienst oder über pi-serverd, mit Rollen-Policy, und bedient RemoteSpace-Clients mit stabiler Retry-Identität.",
			body: `## Überblick {#overview}

Damit nutzen mehrere Programme denselben Space über einen Socket oder TCP. \`serveSpace\` stellt ihn auf der Serverseite bereit, \`RemoteSpace\` ist der passende Client. Der Client verhält sich wie der lokale, du kannst also denselben Code verwenden.

## Technische Referenz {#technical-reference}

\`serveSpace(service, { listen, connection })\` bindet \`SpaceService\` an einen Unix-Socket oder TCP-Port. \`new RemoteSpace(socketTransport(target), options)\` verbindet sich als Client und implementiert \`SpaceLike\`. Den fertigen Dienst startet \`npm run space-server -- --store FILE|memory --listen unix:/pfad.sock|tcp:HOST:PORT\` (\`src/standalone.ts\`, ohne pi-durable und ohne Modell). Dort ist jede Verbindung derselbe Peer (\`--peer\`, sonst \`local\`) mit Rolle \`member\`. Der Socket gehört daher in ein geschütztes Netz oder hinter das Gate.

\`\`\`ts
const server = await serveSpace(service, { listen: { path: "/tmp/space.sock" }, connection });
const remote = new RemoteSpace(socketTransport({ path: "/tmp/space.sock" }), { space: "chat-v3" });
\`\`\`

## Rollen und Fehlerbild {#parameters}

- **\`SpaceService\`**: Transportunabhängige Fassade vor \`SpaceHost\`; ordnet jeder Verbindung über \`IdentityAdapter\` einen vertrauenswürdigen \`Principal\` zu und erzwingt Rollen-Policies.
- **\`serveSpace\`**: Bindet den Service an Unix-Socket (\`{ path }\`) oder TCP (\`{ host, port }\`). Für den vorhandenen pi-server gibt es \`withSpaceService\` und \`piServerTransport\`.
- **\`RemoteSpace\`**: Vollständiger \`SpaceLike\`-Client mit Retry-Identität; blockierende Calls kehren bei Transportabbruch als \`OutcomeUnknown\` zurück und werden per \`pollOperation\` aufgelöst. Zusätzlich bietet er \`probe\`, \`batch\`, \`readChain\`, \`spaces()\` und \`statsWithRevision()\`; ein Feature, das ein älterer Server nicht kennt, ergibt \`UnsupportedOperation\`.
- **\`inProcessTransport\`**: Dieselbe Client-Fassade ohne Netzwerk – ideal für Tests der Remote-Grenze.
- **Fehler**: Der Dienst überträgt Fehlercodes; \`RemoteSpace\` baut daraus \`RemoteError\` oder die lokale Fehlerklasse. Nicht klassifizierte Fehler kommen als \`Internal\` mit der Meldung \`internal error\` an, den Grund protokolliert nur der Host.

### Dienst-Methoden und Rollen {#methods-and-roles}

Der Dienst nimmt \`hello\`, \`generation\`, \`write\`, \`read\`, \`take\`, \`pollOperation\`, \`resolveOperation\`, \`cancelOperation\`, \`readAll\`, \`count\`, \`stats\`, \`spaces\`, \`txn\`, \`lease\`, \`changes\`, \`wait\`, \`notify\`, \`events\`, \`ack\` und \`batch\` an. \`spaces\` listet die Spaces des Hosts (\`spaceId\`, \`alias\`, \`createdAt\`), auch die zur Laufzeit angelegten. \`hello\` nennt die Features; neben den Methoden sind das \`write.unique\`, \`write.transient\`, \`read.chain\` und \`read.locked\`.

| Rolle in \`DEFAULT_POLICY\` | Rechte |
| --- | --- |
| \`admin\` | Alle Methoden, auch über die Liste hinaus. |
| \`host\`, \`member\` | Alle oben genannten Methoden. |
| \`observer\` | Lesen und Abonnieren, darunter \`spaces\`, \`stats\`, \`changes\`, \`notify\`, \`events\`, \`ack\`; kein Schreiben. |
| \`resolution\` | Klärung offener Operationen, \`txn\`, \`lease\`. |
| \`unpaired\` | Nur \`hello\` und \`generation\`, dazu das eigene Pairing. |

Text wird beim Eintritt repariert: \`wellFormed\` ersetzt ein unpaariges Surrogat in Strings und Schlüsseln durch U+FFFD, bevor etwas den Aufruf sieht, auch den Argument-Hash. \`maxPollMs\` begrenzt einen Long Poll (Standard 25 Sekunden). \`wakeOnCommit\` ist optional und standardmäßig aus: Ohne die Option schaut der Dienst alle 50 ms nach, mit ihr beim ersten Commit und dann höchstens alle 25 ms.

### Client-Helfer {#client-helpers}

\`phi-spaces\` enthält, was jeder entfernte Prozess braucht. \`parseTarget(spec)\` liest \`unix:/pfad\`, \`tcp:host:port\` oder einen bloßen Pfad. \`connectSpace(spec, { callTimeoutMs, connectTimeoutMs, attempts })\` liefert \`{ space, transport, close }\` (Standard 30 s, 5 s, 3 Versuche); eine blockierende Wartezeit muss unter \`callTimeoutMs\` bleiben. Dazu kommen \`readExisting\`, \`takeExisting\`, \`StillHeld\`, \`peek\`, \`takeAll\`, \`awaitWork\`, \`keepAlive\` und \`cutText\`. Das WebSocket-Gateway der Web-Prozesse steht in \`phi-spaces/ws\`: \`upgradeWebSocket(req, socket, head, { maxMessagesPerMin })\`, RFC 6455, nur Text, Rahmen bis 1 MiB.

### Speicher des Hosts {#store-host}

\`openSqliteHost(path, options?)\` öffnet den eigenen SQLite-Speicher: WAL-Modus, ein Schreib-Thread, standardmäßig \`synchronous=FULL\`, eine Besitzersperre in \`path.owner\`. Ein zweiter Prozess oder eine fremde Datei ergibt \`StoreUnavailable\`. \`openOwnMemoryHost()\` hält alles im Speicher. Alte pi-durable-Speicher werden nicht übernommen. \`OwnStoreHost.skipUnchangedRecords\` ist optional und standardmäßig aus.

Drei Vorgänge heißen ähnlich:

- \`host.compact()\` gibt freie Seiten der SQLite-Datei zurück: \`{ freedPages, converted, error? }\`, im Speicher \`null\`. Der erste Aufruf schreibt die Datei einmal mit \`VACUUM\` neu, Commits warten so lange.
- \`compactErasedSqlite(path, assertExclusiveFenced)\` aus \`src/erasure-sqlite.ts\` bereinigt eine gestoppte Datei nach einer Löschung, damit keine gelöschten Bytes in freien Seiten oder im WAL bleiben. Das Paket \`phi-spaces\` exportiert diese Funktion nicht; sie ist ein Werkzeug des Repositorys.
- \`EntryReplicationController.compact(id)\` verdichtet die Historie replizierter Entries; siehe [Federation](help.api.federation_controller#parameters).

## Typische Anwendungsfälle {#use-cases}

- **Prozess-Trennung (v3)**: Web-Server, Chat-Worker und Subagent laufen als eigene Prozesse und greifen per \`RemoteSpace\` über Unix-Socket auf denselben Chat-Space zu.
- **Geteilte Mailboxen**: Jeder Remote-Consumer besitzt eine eigene dauerhafte Mailbox; \`events\`/\`ack\` funktionieren über den Socket genauso wie lokal.
- **Eigener Dienst**: \`npm run space-server\` stellt einen Space ohne weiteren Code bereit; \`pi-serverd\` bietet ihn als zusätzlichen Dienst \`space\` an, wenn er dafür freigeschaltet ist.`
		},
		en: {
			title: "SpaceService, serveSpace & RemoteSpace – Network RPC over Socket & TCP",
			short: "Exposes spaces over Unix socket or TCP, also as a standalone service or through pi-serverd, with role policies, and serves RemoteSpace clients with stable retry identity.",
			body: `## Overview {#overview}

This lets several programs use the same space over a socket or TCP. \`serveSpace\` provides it on the server side, and \`RemoteSpace\` is the matching client. The client behaves like the local one, so you can use the same code.

## Technical Reference {#technical-reference}

\`serveSpace(service, { listen, connection })\` binds \`SpaceService\` to a Unix socket or TCP port. \`new RemoteSpace(socketTransport(target), options)\` connects as a client implementing \`SpaceLike\`. \`npm run space-server -- --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT\` starts the ready-made service (\`src/standalone.ts\`, no pi-durable, no model). There every connection is the same peer (\`--peer\`, otherwise \`local\`) with role \`member\`, so the socket belongs on a protected network or behind the gate.

\`\`\`ts
const server = await serveSpace(service, { listen: { path: "/tmp/space.sock" }, connection });
const remote = new RemoteSpace(socketTransport({ path: "/tmp/space.sock" }), { space: "chat-v3" });
\`\`\`

## Roles And Failure Modes {#parameters}

- **\`SpaceService\`**: Transport-independent facade over \`SpaceHost\`; assigns each connection a trusted \`Principal\` via \`IdentityAdapter\` and enforces role policies.
- **\`serveSpace\`**: Binds the service to a Unix socket (\`{ path }\`) or TCP (\`{ host, port }\`). For the existing pi-server there are \`withSpaceService\` and \`piServerTransport\`.
- **\`RemoteSpace\`**: Full \`SpaceLike\` client with stable retry identity; blocking calls return \`OutcomeUnknown\` on transport failure and are resolved via \`pollOperation\`. It also offers \`probe\`, \`batch\`, \`readChain\`, \`spaces()\`, and \`statsWithRevision()\`; a feature an older server does not know gives \`UnsupportedOperation\`.
- **\`inProcessTransport\`**: The same client facade without networking – ideal for testing the remote boundary.
- **Errors**: The service sends error codes; \`RemoteSpace\` turns them into \`RemoteError\` or the local error class. Unclassified errors arrive as \`Internal\` with the message \`internal error\`, and only the host logs the cause.

### Service Methods And Roles {#methods-and-roles}

The service accepts \`hello\`, \`generation\`, \`write\`, \`read\`, \`take\`, \`pollOperation\`, \`resolveOperation\`, \`cancelOperation\`, \`readAll\`, \`count\`, \`stats\`, \`spaces\`, \`txn\`, \`lease\`, \`changes\`, \`wait\`, \`notify\`, \`events\`, \`ack\`, and \`batch\`. \`spaces\` lists the host's spaces (\`spaceId\`, \`alias\`, \`createdAt\`), including those created at runtime. \`hello\` names the features; besides the methods these are \`write.unique\`, \`write.transient\`, \`read.chain\`, and \`read.locked\`.

| Role in \`DEFAULT_POLICY\` | Rights |
| --- | --- |
| \`admin\` | All methods, also beyond this list. |
| \`host\`, \`member\` | All methods named above. |
| \`observer\` | Reading and subscribing, including \`spaces\`, \`stats\`, \`changes\`, \`notify\`, \`events\`, \`ack\`; no writing. |
| \`resolution\` | Resolving open operations, \`txn\`, \`lease\`. |
| \`unpaired\` | Only \`hello\` and \`generation\`, plus its own pairing. |

Text is repaired on entry: \`wellFormed\` replaces an unpaired surrogate in strings and keys with U+FFFD before anything sees the call, including the argument hash. \`maxPollMs\` bounds a long poll (default 25 seconds). \`wakeOnCommit\` is optional and off by default: without it the service looks every 50 ms, with it at the first commit and then at most every 25 ms.

### Client Helpers {#client-helpers}

\`phi-spaces\` contains what every remote process needs. \`parseTarget(spec)\` reads \`unix:/path\`, \`tcp:host:port\`, or a bare path. \`connectSpace(spec, { callTimeoutMs, connectTimeoutMs, attempts })\` returns \`{ space, transport, close }\` (defaults 30 s, 5 s, 3 attempts); a blocking wait must stay below \`callTimeoutMs\`. Add \`readExisting\`, \`takeExisting\`, \`StillHeld\`, \`peek\`, \`takeAll\`, \`awaitWork\`, \`keepAlive\`, and \`cutText\`. The web processes' WebSocket gateway is in \`phi-spaces/ws\`: \`upgradeWebSocket(req, socket, head, { maxMessagesPerMin })\`, RFC 6455, text only, frames up to 1 MiB.

### The Host's Store {#store-host}

\`openSqliteHost(path, options?)\` opens the own SQLite store: WAL mode, one writer thread, \`synchronous=FULL\` by default, an owner lock in \`path.owner\`. A second process or a foreign file gives \`StoreUnavailable\`. \`openOwnMemoryHost()\` keeps everything in memory. Old pi-durable stores are not taken over. \`OwnStoreHost.skipUnchangedRecords\` is optional and off by default.

Three operations have similar names:

- \`host.compact()\` gives free pages of the SQLite file back: \`{ freedPages, converted, error? }\`, \`null\` in memory. The first call rewrites the file once with \`VACUUM\`, and commits wait meanwhile.
- \`compactErasedSqlite(path, assertExclusiveFenced)\` from \`src/erasure-sqlite.ts\` cleans a stopped file after an erasure, so no erased bytes stay in free pages or the WAL. The \`phi-spaces\` package does not export this function; it is a tool of the repository.
- \`EntryReplicationController.compact(id)\` compacts the history of replicated entries; see [Federation](help.api.federation_controller#parameters).

## Typical Use Cases {#use-cases}

- **Process separation (v3)**: Web server, chat worker, and subagent run as dedicated processes accessing the same chat space via \`RemoteSpace\` over a Unix socket.
- **Shared mailboxes**: Each remote consumer owns a durable mailbox; \`events\`/\`ack\` behave over the socket exactly as they do locally.
- **A service of its own**: \`npm run space-server\` provides a space with no further code; \`pi-serverd\` offers it as an additional service \`space\` when enabled for that.`
		}
	},
	{
		id: "help.api.gate_auth_grants",
		type: "api",
		provider: "security",
		tags: ["startgate", "startfederationhost", "grantauthority", "grantverifier", "enroll", "rotatekey"],
		related: ["help.topic.gate_auth_grants_and_recovery", "help.workflow.stage_v4_gated_auth"],
		since: "0.0.1",
		de: {
			title: "Gate, Schicht A/B, Enrollment, 60s-Grants & Rotation",
			short: "Kombiniert NetBird-Peer-Auflösung (Schicht A), Ed25519/P-256-Challenge (Schicht B), QR/Token-Enrollment, 60-s-Grants und atomare Schlüsselrotation.",
			body: `## Überblick {#overview}

Diese Bausteine regeln, wer einen Space im Netz benutzen darf. Ein Gerät wird einmal gekoppelt und beweist danach bei jeder Verbindung seinen Schlüssel. Für Aufrufe braucht es zusätzlich kurzlebige Berechtigungen. \`startFederationHost\` startet das alles zusammen.

## Technische Referenz {#technical-reference}

\`startFederationHost(host, ctx, options)\` komponiert Gate, Schicht-A/B-Authentisierung, Enrollment, Grant-Ausstellung/-Prüfung, Supervisor, Schlüsselrotation und Boot-Guard zu einem einzigen persistenten Host-Dienst.

\`\`\`ts
const federation = await startFederationHost(host, ctx, {
  hostId,
  authorityId,
  keys: keyDirectory,
  verifier: grantVerifier,
  listen: { host: "127.0.0.1", port: 0 },
  directory,
  boot: { external: register, installed: installedRegister }
});
\`\`\`

Die Beispielvariablen keyDirectory, grantVerifier, directory und die beiden unabhängigen Register sind vorab sicher zu konfigurieren; ein öffentlicher Schlüssel allein ist kein GrantVerifier. listen/directory liegen direkt auf den Host-Optionen, nicht unter gate. Der lokale v4-Runner zeigt den vollständigen Aufbau.\n\n## Komponenten im Überblick {#parameters}

| Komponente | Aufgabe |
| --- | --- |
| \`startGate\` | Schicht A: Übersetzt NetBird-Peer-Identität in \`peerId\` + Rolle und lehnt unbekannte Peers ab. |
| \`authenticate\` (Schicht B) | Ed25519-/P-256-Challenge-Beweis des Client-Schlüssels unabhängig vom Overlay. |
| \`EnrollmentService\` / \`enrollQr\` | Einmal-Tokens und QR-Payloads zum Pairing von Smartphone, Host oder Browser. |
| \`GrantAuthority\` / \`GrantVerifier\` | Stellt Grants mit höchstens 60 Sekunden Laufzeit aus (\`purpose\`: \`effect\` oder \`resolution\`) und prüft sie auf Data-Hosts. |
| \`RotationService\` / \`rotateKey\` | Atomare Schlüsselrotation im laufenden Betrieb ohne Gate-Neustart. |
| \`HostBootState\` | CAS-geschützter Boot-Guard gegen doppelte Host-Inkarnationen und Restore-Konflikte. |

## Typische Anwendungsfälle {#use-cases}

- **Handy-Pairing (v6)**: \`enrollQr\` am Koordinator erzeugt einen QR-Code; \`pi-termux-mobile\` scannt ihn, führt \`enroll\` im \`CONTROL_SPACE\` aus und erhält die Rolle, die das Token festlegt.
- **Kurzlebige Berechtigungen**: Ein Grant gilt höchstens 60 Sekunden. Ein abgefangener Grant ist also schnell wertlos.
- **Schlüsselwechsel**: \`rotateKey\` ersetzt den eigenen Schlüssel im laufenden Betrieb, mit alter und neuer Signatur. Einen fremden Peer sperrt ein Admin mit dem Command \`revokePeer\`.`
		},
		en: {
			title: "Gate, Layer A/B, Enrollment, 60s Grants & Rotation",
			short: "Combines NetBird peer resolution (Layer A), Ed25519/P-256 challenge (Layer B), QR/token enrollment, 60s grants, and atomic key rotation.",
			body: `## Overview {#overview}

These building blocks control who may use a space on the network. A device is paired once and proves its key on every connection afterwards. Calls also need short-lived permissions. \`startFederationHost\` starts all of it together.

## Technical Reference {#technical-reference}

\`startFederationHost(host, ctx, options)\` composes gate, Layer A/B authentication, enrollment, grant issuance/verification, supervisor, key rotation, and boot guard into a single persistent host runtime.

\`\`\`ts
const federation = await startFederationHost(host, ctx, {
  hostId,
  authorityId,
  keys: keyDirectory,
  verifier: grantVerifier,
  listen: { host: "127.0.0.1", port: 0 },
  directory,
  boot: { external: register, installed: installedRegister }
});
\`\`\`

Configure keyDirectory, grantVerifier, directory and both independent registers before this fragment; a public key alone is not a GrantVerifier. listen/directory are top-level host options, not a gate subobject. The local v4 runner demonstrates the complete setup.\n\n## Components At A Glance {#parameters}

| Component | Task |
| --- | --- |
| \`startGate\` | Layer A: Translates NetBird peer identity into \`peerId\` + role and rejects unknown peers. |
| \`authenticate\` (Layer B) | Ed25519/P-256 challenge proof of the client key, independent of the overlay. |
| \`EnrollmentService\` / \`enrollQr\` | One-time tokens and QR payloads for pairing smartphones, hosts, or browsers. |
| \`GrantAuthority\` / \`GrantVerifier\` | Issues grants valid for at most 60 seconds (\`purpose\`: \`effect\` or \`resolution\`) and verifies them on data hosts. |
| \`RotationService\` / \`rotateKey\` | Atomic key rotation at runtime without restarting the gate. |
| \`HostBootState\` | CAS-protected boot guard against duplicate host incarnations and restore conflicts. |

## Typical Use Cases {#use-cases}

- **Phone pairing (v6)**: \`enrollQr\` on the coordinator produces a QR code; \`pi-termux-mobile\` scans it, runs \`enroll\` in the \`CONTROL_SPACE\`, and receives the role the token sets.
- **Short-lived permissions**: A grant lasts at most 60 seconds, so an intercepted grant soon becomes worthless.
- **Key change**: \`rotateKey\` replaces your own key at runtime, with old and new signature. An admin blocks another peer with the \`revokePeer\` command.`
		}
	},
	{
		id: "help.api.federation_controller",
		type: "api",
		provider: "federation",
		tags: ["createfederationcontroller", "routercontroller", "federatedspace", "membershipcontroller", "hrw"],
		related: ["help.topic.federation_router_and_membership", "help.workflow.stage_v5_federated_cluster"],
		since: "0.0.1",
		de: {
			title: "createFederationController & FederatedSpace – Router, HRW-Sharding & Membership",
			short: "Verbindet Router-Journal-Partitionen, signierte RouterLease, Original-Principal-Delegation, HRW-Policy, Waiter-Wettlauf und Membership-Lifecycle.",
			body: `## Überblick {#overview}

\`createFederationController\` verteilt die Daten eines logischen Space auf mehrere Spaces, auch auf mehreren Rechnern. Du nutzt das, wenn ein einzelner Host nicht mehr reicht. Zusammengehörige Einträge bleiben dabei am selben Ort.

## Technische Referenz {#technical-reference}

\`createFederationController(options)\` initialisiert und rekonstruiert den föderierten Router (\`journalPartitions\` von 1 bis 1024, Standard 1, danach unveränderlich), \`FederatedSpace\`, \`FederationPolicyAuthority\` und \`MembershipController\`. Diese APIs gehören zum serverseitigen Router und ersetzen nicht die Signaturen von \`RemoteSpace\`.

\`\`\`ts
const fed = await createFederationController({
  ...federationOptions, // Configured keys, transport, grants, lease and authority/admin guards.
  host,
  ctx,
  id: "router-main",
  journalPartitions: 4
});
\`\`\`

## Komponenten im Überblick {#parameters}

| Komponente | Aufgabe |
| --- | --- |
| \`RouterController\` | Journalisiert Commands mit stabilen Unterrequest-IDs: \`recover\`, \`submit\`, \`advance\`, \`get\`, \`ingest\`, \`review\`. \`renewableRouterLease\` betreut den signierten Lease. |
| \`FederatedSpace\` | Leitet per Policy und HRW-Hash des Routing-Felds (z.B. \`threadId\`) auf den zuständigen Member. Eigene Signaturen, kein \`SpaceLike\`: \`write(entry, request, leaseMs)\`, \`read(template, request)\`, \`take(template, request)\`, \`readAll(template, principal, options?)\` mit \`{ entries, complete }\`. |
| \`FederationPolicyAuthority\` | Verwaltet die verbindliche Member-Menge und Shard-Abbildung. |
| \`MembershipController\` | Kontrolliertes Hinzufügen, Leeren und Entfernen von Membern als journalisierte Kommandos: \`execute(id, "add" \\| "drain" \\| "remove", member, ...)\`. |
| \`takeWaiting\` | Journalisierter Waiter-Wettlauf: genau ein Member gewinnt einen clusterweit geparkten Take-Wunsch. Grenzen: \`timeoutMs\` bis 3 600 000, \`txnLeaseMs\` bis 60 000. |
| \`EntryReplicationController\` | Eigenes Dokument für replizierte Entries (HLC, LWW, Add-Wins), keine Replikation normaler Entries. \`erasePrincipal\`, \`completeErasure\`, \`compactionStatus\` und \`compact(id)\` löschen und verdichten seine Historie. |

## Typische Anwendungsfälle {#use-cases}

- **Chat-Sharding (v5)**: Threads werden per HRW über \`threadId\` auf drei Member verteilt – jede Transaktion bleibt lokal atomar, memberübergreifende \`txn\` werden mit \`RoutingConflict\` abgelehnt.
- **Clusterweites Lesen**: \`readAll\` fragt alle passenden Member ab; \`complete: false\` zeigt, dass Antworten fehlen.
- **Wartung ohne Stillstand**: \`execute\` mit \`"drain"\` leert einen Member kontrolliert, bevor er gewartet wird.`
		},
		en: {
			title: "createFederationController & FederatedSpace – Router, HRW Sharding & Membership",
			short: "Connects router journal partitions, signed RouterLease, original-principal delegation, HRW policy, waiter race, and membership lifecycle.",
			body: `## Overview {#overview}

\`createFederationController\` spreads the data of one logical space across several spaces, also on several machines. Use it when a single host is no longer enough. Entries that belong together stay in the same place.

## Technical Reference {#technical-reference}

\`createFederationController(options)\` initializes and recovers the federated router (\`journalPartitions\` from 1 to 1024, default 1, fixed afterwards), \`FederatedSpace\`, \`FederationPolicyAuthority\`, and \`MembershipController\`. These APIs belong to the server-side router and do not replace the signatures of \`RemoteSpace\`.

\`\`\`ts
const fed = await createFederationController({
  ...federationOptions, // Configured keys, transport, grants, lease and authority/admin guards.
  host,
  ctx,
  id: "router-main",
  journalPartitions: 4
});
\`\`\`

## Components At A Glance {#parameters}

| Component | Task |
| --- | --- |
| \`RouterController\` | Journals commands with stable sub-request IDs: \`recover\`, \`submit\`, \`advance\`, \`get\`, \`ingest\`, \`review\`. \`renewableRouterLease\` looks after the signed lease. |
| \`FederatedSpace\` | Routes by policy and HRW hash of the routing field (e.g. \`threadId\`) to the responsible member. Own signatures, not \`SpaceLike\`: \`write(entry, request, leaseMs)\`, \`read(template, request)\`, \`take(template, request)\`, \`readAll(template, principal, options?)\` with \`{ entries, complete }\`. |
| \`FederationPolicyAuthority\` | Manages the authoritative member set and shard mapping. |
| \`MembershipController\` | Controlled adding, draining, and removing of members as journaled commands: \`execute(id, "add" \\| "drain" \\| "remove", member, ...)\`. |
| \`takeWaiting\` | Journaled waiter race: exactly one member wins a cluster-wide parked take wish. Bounds: \`timeoutMs\` up to 3,600,000, \`txnLeaseMs\` up to 60,000. |
| \`EntryReplicationController\` | Its own document for replicated entries (HLC, LWW, Add-Wins), no replication of normal entries. \`erasePrincipal\`, \`completeErasure\`, \`compactionStatus\`, and \`compact(id)\` erase from and compact its history. |

## Typical Use Cases {#use-cases}

- **Chat sharding (v5)**: Threads are distributed across three members via HRW over \`threadId\` – every transaction stays locally atomic; cross-member \`txn\`s are rejected with \`RoutingConflict\`.
- **Cluster-wide reads**: \`readAll\` queries all matching members; \`complete: false\` shows that answers are missing.
- **Maintenance without downtime**: \`execute\` with \`"drain"\` empties a member in a controlled way before servicing it.`
		}
	},
	{
		id: "help.api.operations_runs_workers",
		type: "api",
		provider: "ops",
		tags: ["runcontroller", "workersupervisor", "spacelifecycle", "deploymentcontroller", "collectalerts", "auditlog"],
		related: ["help.topic.operations_mobile_and_replication", "help.workflow.stage_v6_mobile_control"],
		since: "0.0.1",
		de: {
			title: "RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Betriebserweiterung (B2–B10)",
short: "Steuert Läufe über RunGate-ACK-Barrieren, weist Hosts signierte Worker-Listen zu, verwaltet Space-Lebenszyklen und Deployments und speist AdminSpaces und die mobile Steuerung.",
			body: `## Überblick {#overview}

Diese Bausteine bedienen laufende Spaces: Läufe starten und pausieren, Worker skalieren, Spaces anlegen und archivieren, Hinweise sammeln. Du nutzt sie über den Web-Bereich AdminSpaces, die Android-App oder direkt im Code.

## Technische Referenz {#technical-reference}

Diese Controller bilden das Backend für die mobile Steuerung (\`pi-termux-mobile\`) sowie für den login-geschützten Web-Admin-Bereich **\`AdminSpaces\`** auf \`https://spaces.eibrain.org\`. Die Namen \`createSpace\`, \`setWorkers\`, \`startRun\`, \`planDeployment\` usw. sind Admin-Commands; die Methoden der Controller heißen teils anders.

\`\`\`ts
await runController.start("cmd-start-1", spec);
await runController.pause("cmd-pause-1", runId);
await runController.resume("cmd-resume-1", runId);
const alerts = await collectAlerts({ host, ctx, controlSpaceId, runs: runController, now: Date.now });
\`\`\`

## Controller im Überblick {#parameters}

| Controller | Aufgabe |
| --- | --- |
| \`SpaceLifecycle\` | \`apply({ commandId, action: "create", alias })\` und \`apply({ commandId, action: "archive" \\| "reactivate" \\| "delete", spaceId })\`, idempotent je Command. \`spaceCommands\` liefert die Admin-Commands \`createSpace\`, \`archiveSpace\`, \`reactivateSpace\`, \`deleteSpace\`. Fehler: \`SpaceInUse\` mit Grund. |
| \`WorkerAssignments\` / \`WorkerSupervisor\` | \`WorkerAssignments.set\` hält den signierten Soll-Zustand je Host (Command \`setWorkers\`). \`WorkerSupervisor.reconcile()\` läuft auf dem Host und startet oder stoppt Worker-Schleifen; \`count: 0\` stoppt nach dem laufenden Task. |
| \`RunController\` / \`RunGate\` | \`start\`, \`pause\`, \`resume\`, \`stop\`, \`advance\`, \`reconcile\`, \`resolve\`, \`status\`, \`pending\`, \`list\`, \`preview\`, \`schedule\`, \`export\` mit bestätigter ACK-Barriere über alle beteiligten Hosts. \`dryRun: true\` an einem Admin-Command ruft \`preview\` auf. |
| \`DeploymentController\` | Deklaratives Bootstrap: \`validateDeployment\`, dann \`bindHost\`, \`plan\`, \`apply\`, \`startWorkers\`, \`export\` (Schema v1: Hosts, Spaces, Routing, Worker, Mobile-Zugang; Geheimnisse in der Datei werden abgelehnt). CLI: \`npm run bootstrap\` mit \`--check\`, \`--plan\`, \`--apply\`, \`--bind a=id\`, \`--start-workers\`, \`--export\` (Exit 0 ok, 1 ungültig, 2 abgelehnt oder blockiert, 3 noch kein Ergebnis). |
| \`collectAlerts\` / \`auditLog\` | Sammelt Hinweise zu Läufen, Workern und Hosts (z.B. veraltete Heartbeats, blockierte Hosts) und das Befehls-Audit ohne Result-Payloads. \`startAlertMonitor\` meldet Änderungen, etwa über \`webhookPublisher\`. |

## Typische Anwendungsfälle {#use-cases}

- **Lokal nutzbar**: Stufe 6 betreibt die Controller auf einem Host im Arbeitsspeicher; entfernte Hosts kommen über Socket, Gate und signierte Anweisungen dazu.
- **Wartungsfenster**: \`pauseRun\` friert alle \`RunGate\`-gebundenen Tasks eines Laufs auf seinen Members ein, \`resumeRun\` gibt sie bestätigt wieder frei.
- **Bootstrap per Klick**: \`AdminSpaces\`-Panel 7 plant und aktiviert ein komplettes Deployment (Hosts + Spaces + Worker) aus einer JSON-Konfiguration.`
		},
		en: {
			title: "RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Operations Extension (B2–B10)",
short: "Controls runs via RunGate ACK barriers, assigns signed worker lists to hosts, manages space lifecycles and deployments, and powers AdminSpaces and mobile control.",
			body: `## Overview {#overview}

These building blocks operate running spaces: start and pause runs, scale workers, create and archive spaces, collect alerts. You use them through the AdminSpaces web area, the Android app, or directly in code.

## Technical Reference {#technical-reference}

These controllers power both the mobile control pages (\`pi-termux-mobile\`) and the login-protected **\`AdminSpaces\`** web portal at \`https://spaces.eibrain.org\`. The names \`createSpace\`, \`setWorkers\`, \`startRun\`, \`planDeployment\`, and so on are admin commands; the controllers' methods are partly named differently.

\`\`\`ts
await runController.start("cmd-start-1", spec);
await runController.pause("cmd-pause-1", runId);
await runController.resume("cmd-resume-1", runId);
const alerts = await collectAlerts({ host, ctx, controlSpaceId, runs: runController, now: Date.now });
\`\`\`

## Controllers At A Glance {#parameters}

| Controller | Task |
| --- | --- |
| \`SpaceLifecycle\` | \`apply({ commandId, action: "create", alias })\` and \`apply({ commandId, action: "archive" \\| "reactivate" \\| "delete", spaceId })\`, idempotent per command. \`spaceCommands\` provides the admin commands \`createSpace\`, \`archiveSpace\`, \`reactivateSpace\`, \`deleteSpace\`. Error: \`SpaceInUse\` with a reason. |
| \`WorkerAssignments\` / \`WorkerSupervisor\` | \`WorkerAssignments.set\` keeps the signed desired state per host (command \`setWorkers\`). \`WorkerSupervisor.reconcile()\` runs on the host and starts or stops worker loops; \`count: 0\` stops after the current task. |
| \`RunController\` / \`RunGate\` | \`start\`, \`pause\`, \`resume\`, \`stop\`, \`advance\`, \`reconcile\`, \`resolve\`, \`status\`, \`pending\`, \`list\`, \`preview\`, \`schedule\`, \`export\` with a confirmed ACK barrier across all involved hosts. \`dryRun: true\` on an admin command calls \`preview\`. |
| \`DeploymentController\` | Declarative bootstrap: \`validateDeployment\`, then \`bindHost\`, \`plan\`, \`apply\`, \`startWorkers\`, \`export\` (schema v1: hosts, spaces, routing, workers, mobile access; secrets in the file are refused). CLI: \`npm run bootstrap\` with \`--check\`, \`--plan\`, \`--apply\`, \`--bind a=id\`, \`--start-workers\`, \`--export\` (exit 0 ok, 1 invalid, 2 refused or blocked, 3 no result yet). |
| \`collectAlerts\` / \`auditLog\` | Collects alerts on runs, workers, and hosts (e.g. stale heartbeats, blocked hosts) and the command audit without result payloads. \`startAlertMonitor\` reports changes, for example through \`webhookPublisher\`. |

## Typical Use Cases {#use-cases}

- **Usable locally**: Stage 6 runs the controllers on one host in memory; remote hosts join through socket, gate, and signed instructions.
- **Maintenance windows**: \`pauseRun\` freezes all \`RunGate\`-bound tasks of a run on its members; \`resumeRun\` releases them again after confirmation.
- **One-click bootstrap**: \`AdminSpaces\` panel 7 plans and activates a complete deployment (hosts + spaces + workers) from a single JSON configuration.`
		}
	}
];
