// Canonical bilingual workflow (v1-v6) and API articles for PI-SPACES / HELP.
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
			short: "Wie das Earendil Multiplayer-Chat-Szenario vollständig mit nativen pi-spaces-Mitteln umgesetzt wird – vom Zero-Setup In-Memory-Space (v1) bis zum Cluster mit Mobile- & Web-Admin (v6).",
			body: `## Überblick {#overview}

Dieses Referenzprojekt setzt alle Fähigkeiten des bekannten [Pi Durable on Cloudflare Multiplayer-Chats](help.topic.overview#overview) **ausschließlich mit den Mitteln von \`pi-spaces\`** um – ohne Cloudflare-spezifische APIs und ohne manuelle Sonder-Tabellen außerhalb des Spaces.

Damit man sowohl in wenigen Sekunden lokal starten als auch den Weg bis zur verteilten Produktion nachvollziehen kann, ist das Beispiel in **6 aufeinander aufbauende, einzeln ausführbare Versionen (\`v1\` bis \`v6\`)** gegliedert.

## Begriffs- und Systemmodell {#concept-model}

### Wie pi-spaces die 6 Kernanforderungen löst {#mapping-table}

| Funktion des Multiplayer-Chats | Lösung mit reinen \`pi-spaces\`-Mitteln |
|---|---|
| **1. Teilbare Session-Räume** | Jeder Chat-Raum ist ein isolierter **benannter Space (\`NamedSpace\`)** mit eigener \`spaceId\` und Revision \`rev\`. |
| **2. Mehrere Threads & Forking ohne Duplikate** | Threads sind \`Thread\`-Entries (\`{ threadId, parentThreadId, forkUpToSeq }\`); Reconnect-Retries werden nativ über **Request-Claims (\`RequestRef\` + \`issueGeneration\`)** dedupliziert. |
| **3. Multiplayer-Inbox & geordnete Antworten** | Jede Nachricht erzeugt in einer Transaktion \`Msg\` + \`ChatTask\`. Der Worker nimmt \`ChatTask\` exklusiv unter \`txn\` und muss laut **\`CompletionProfile\`** genau eine Antwort-\`Msg\` committen. |
| **4. Live-Streaming & Teilnehmer-Präsenz** | Initialer Snapshot über \`readPage()\`, Live-Deltas über \`changes(afterRev)\`; Anwesenheit über \`Presence\`-Entries mit **30-s-Space-Lease** und \`renew()\`. |
| **5. Geplante Aufgaben (\`schedule\` / Alarme)** | \`ScheduledJob\`-Entry (\`FOREVER\`) + \`TimerLock\`-Entry mit \`leaseMs = delayMs\`. Nach Ablauf der Lease räumt der \`pi-spaces\`-Reaper den Lock ab und löst idempotent den Wakeup-\`ChatTask\` aus. |
| **6. Konversationssuche per Subagent (\`search_history\`)** | \`SearchTask\`-Entry wird von einem Subagent-Worker unter \`txn\` genommen; er durchsucht alle Threads per \`readAll({ type: "Msg" })\`, protokolliert \`SubagentStep\`-Entries und committet \`SearchResult\` unter einem zweiten \`CompletionProfile\`. |

### Die 6 Stufen im Überblick {#six-stages}

1. **[Stufe 1 (\`v1-local-memory\`)](help.workflow.stage_v1_local_memory#overview)**: Zero-Setup im Arbeitsspeicher (\`MemoryStorage\` + \`PiSpaces\`). Sofort ausführbar ohne Dateien oder Netzwerk.
2. **[Stufe 2 (\`v2-local-durable\`)](help.workflow.stage_v2_local_durable#overview)**: Lokale SQLite-Persistenz, \`RequestRef\`-Idempotenz, \`readPage\`/\`changes\`, \`TimerLock\`-Alarme und \`search_history\`-Subagent.
3. **[Stufe 3 (\`v3-remote-socket\`)](help.workflow.stage_v3_remote_socket#overview)**: Trennung in Server und Remote-Worker über \`SpaceService\`, \`RemoteSpace\` (Unix-Socket/TCP) und Consumer-Mailboxes (\`events\` + \`ack\`).
4. **[Stufe 4 (\`v4-gated-auth\`)](help.workflow.stage_v4_gated_auth#overview)**: Zwei-Schichten-Sicherheit (\`startGate\`, Ed25519-Challenge, Token-Enrollment, 60-s-Grants, Schlüsselrotation und Boot-Guard).
5. **[Stufe 5 (\`v5-federated-cluster\`)](help.workflow.stage_v5_federated_cluster#overview)**: Föderierter Cluster (\`createFederationController\`) mit 3 Member-Spaces, HRW-Routing nach \`threadId\` und \`takeWaiting\`-Waiter-Wettlauf — in der Demo als 4 Harnesses in einem Prozess simuliert.

Jede Stufen-Beschreibung enthält einen Abschnitt **Topologie: Space-Verteilung**, der zeigt, wie viele Harnesses/Spaces beteiligt sind und wie Entries verteilt werden.
6. **[Stufe 6 (\`v6-mobile-control\`)](help.workflow.stage_v6_mobile_control#overview)**: Vollständige Betriebssteuerung & Überwachung über die Mobile App (\`pi-termux-mobile\`) und den login-geschützten Web-Bereich **\`AdminSpaces\`** auf \`https://spaces.eibrain.org\`.

## Siehe auch {#see-also}

- [Stufe 1 (v1-local-memory): Sofortstart ohne Setup](help.workflow.stage_v1_local_memory#overview)`
		},
		en: {
			title: "Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)",
			short: "How the Earendil Multiplayer Chat scenario is implemented purely with native pi-spaces primitives—from a zero-setup in-memory space (v1) to a federated cluster with mobile & web admin (v6).",
			body: `## Overview {#overview}

This reference project implements every capability of the [Pi Durable on Cloudflare Multiplayer Chat](help.topic.overview#overview) **purely using \`pi-spaces\` primitives**—with no Cloudflare-specific APIs and no ad-hoc state tables outside the space.

To let you start locally in seconds and progressively scale to a distributed production cluster, the project is structured into **6 cumulative, individually runnable stages (\`v1\` through \`v6\`)**.

## Concept And System Model {#concept-model}

### How pi-spaces Solves The 6 Core Requirements {#mapping-table}

| Multiplayer Chat Capability | Pure \`pi-spaces\` Solution |
|---|---|
| **1. Shareable Session Rooms** | Each chat session is an isolated **named space (\`NamedSpace\`)** with its own \`spaceId\` and revision counter \`rev\`. |
| **2. Multiple Threads & Forking Without Duplicates** | Threads are \`Thread\` entries (\`{ threadId, parentThreadId, forkUpToSeq }\`); reconnect retries are deduplicated natively via **Request Claims (\`RequestRef\` + \`issueGeneration\`)**. |
| **3. Multiplayer Inbox & Ordered Replies** | Submitting a message atomically writes \`Msg\` + \`ChatTask\`. The worker reserves \`ChatTask\` under \`txn\` and must commit a matching reply \`Msg\` enforced by **\`CompletionProfile\`**. |
| **4. Live Streaming & Participant Presence** | Initial snapshot via \`readPage()\`, live deltas via \`changes(afterRev)\`; presence via \`Presence\` entries with a **30 s space lease** and \`renew()\`. |
| **5. Scheduled Tasks (\`schedule\` / Alarms)** | \`ScheduledJob\` entry (\`FOREVER\`) + \`TimerLock\` entry with \`leaseMs = delayMs\`. When the lease expires, the \`pi-spaces\` reaper removes the lock and idempotently triggers the wakeup \`ChatTask\`. |
| **6. Cross-Thread Search Subagent (\`search_history\`)** | A subagent worker takes \`SearchTask\` under \`txn\`, scans top-level threads via \`readAll({ type: "Msg" })\`, records \`SubagentStep\` trace entries, and commits \`SearchResult\` under a second \`CompletionProfile\`. |

### The 6 Stages At A Glance {#six-stages}

1. **[Stage 1 (\`v1-local-memory\`)](help.workflow.stage_v1_local_memory#overview)**: Zero-setup in memory (\`MemoryStorage\` + \`PiSpaces\`). Runs immediately without files or network ports.
2. **[Stage 2 (\`v2-local-durable\`)](help.workflow.stage_v2_local_durable#overview)**: Local SQLite persistence, \`RequestRef\` idempotency, \`readPage\`/\`changes\`, \`TimerLock\` alarms, and \`search_history\` subagent.
3. **[Stage 3 (\`v3-remote-socket\`)](help.workflow.stage_v3_remote_socket#overview)**: Process decoupling via \`SpaceService\`, \`RemoteSpace\` (Unix socket/TCP), and consumer mailboxes (\`events\` + \`ack\`).
4. **[Stage 4 (\`v4-gated-auth\`)](help.workflow.stage_v4_gated_auth#overview)**: Two-layer security (\`startGate\`, Ed25519 challenge, token enrollment, 60s grants, key rotation, and boot guard).
5. **[Stage 5 (\`v5-federated-cluster\`)](help.workflow.stage_v5_federated_cluster#overview)**: Federated cluster (\`createFederationController\`) across 3 member spaces with HRW routing by \`threadId\` and \`takeWaiting\` waiter races — simulated as 4 harnesses in one process in the demo.
6. **[Stage 6 (\`v6-mobile-control\`)](help.workflow.stage_v6_mobile_control#overview)**: Full operations control & monitoring via the mobile app (\`pi-termux-mobile\`) and the login-protected **\`AdminSpaces\`** web portal on \`https://spaces.eibrain.org\`.

Each stage description includes a **Topology: Space Distribution** section showing how many harnesses/spaces are involved and how entries are distributed.

## See Also {#see-also}

- [Stage 1 (v1-local-memory): Zero-Setup Local Quickstart](help.workflow.stage_v1_local_memory#overview)`
		}
	},
	{
		id: "help.workflow.stage_v1_local_memory",
		type: "workflow",
		provider: "client",
		tags: ["v1", "memory", "quickstart", "pispaces", "thread", "fork", "presence", "completionprofile"],
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
			short: "Die einfachste lauffähige Version des Multiplayer Space-Chats im Arbeitsspeicher: Threads, Forking, Presence-Leases und transaktionale Antwortverarbeitung.",
			body: `## Überblick {#overview}

Stufe 1 (\`help-site/examples/v1-local-memory/run.ts\`) benötigt keinerlei Einrichtung, Datenbankdateien oder offene Ports. Sie öffnet einen \`MemoryStorage\`-Harness, legt einen benannten Space an und demonstriert das komplette Grundmodell des Multiplayer Space-Chats in unter einer Sekunde.

## Topologie: Space-Verteilung {#topology}

- **1 Prozess**, **1 Harness** auf \`MemoryStorage\` (flüchtig, kein Restart-Szenario).
- **1 benannter Space** (\`chat-v1\`): alle Entries (\`Presence\`, \`Thread\`, \`Msg\`, \`ChatTask\`) liegen in genau diesem Space.
- Clients (alice/bob) und Worker greifen in-process über dasselbe \`PiSpaces\`-Objekt zu — kein Socket, keine Datei, kein Netz.

## Arbeitsablauf {#workflow}

### Schritt 1: Space und CompletionProfile initialisieren {#step-1-init}

\`\`\`ts
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
await harness.commit((tx) => createSpace(tx, "chat-v1", Date.now()), ctx);
const space = new PiSpaces(harness, ctx, Date.now, meter, undefined, { space: "chat-v1" });
const stopService = await startService(harness, ctx);

await space.setCompletionProfiles([
  { taskType: "ChatTask", resultType: "Msg", matchFields: ["taskId", "threadId"], minResults: 1, maxResults: 1 }
]);
\`\`\`

### Schritt 2: Teilnehmer-Präsenz mit Space-Lease anlegen {#step-2-presence}

Wenn \`alice\` und \`bob\` den Chat betreten, schreibt jeder Client einen \`Presence\`-Entry mit 30 Sekunden Lease (\`30_000\` ms) und verlängert ihn per \`space.renew(lease.id, 30_000)\`.

### Schritt 3: Nachricht schreiben, transaktional beantworten und Thread forken {#step-3-chat-and-fork}

1. \`alice\` schreibt in einer Transaktion ihre \`Msg\` (\`seq: 1\`) und den zugehörigen \`ChatTask\`.
2. Der Chat-Worker nimmt \`ChatTask\` unter einer Transaktion (\`space.take(..., { txn })\`), erzeugt die Antwort-\`Msg\` (\`seq: 2\`) mit derselben \`taskId\` und ruft \`space.commit(txn)\` auf.
3. \`bob\` forkt den Thread ab \`seq: 2\` (\`forkThread\` kopiert die sichtbaren Nachrichten bis \`seq <= 2\` in einer Transaktion in den neuen Fork-Thread).

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Stufe 2 (v2-local-durable): SQLite, RequestRef-Claims, Alarme & Subagent](help.workflow.stage_v2_local_durable#overview)`
		},
		en: {
			title: "Stage 1 (v1-local-memory): Zero-Setup Local Quickstart",
			short: "The simplest runnable version of the Multiplayer Space-Chat in memory: threads, forking, presence leases, and transactional reply processing.",
			body: `## Overview {#overview}

Stage 1 (\`help-site/examples/v1-local-memory/run.ts\`) requires zero setup, database files, or open network ports. It opens a \`MemoryStorage\` harness, creates a named space, and demonstrates the complete core model of the Multiplayer Space-Chat in under a second.

## Topology: Space Distribution {#topology}

- **1 process**, **1 harness** on \`MemoryStorage\` (volatile, no restart scenario).
- **1 named space** (\`chat-v1\`): every entry (\`Presence\`, \`Thread\`, \`Msg\`, \`ChatTask\`) lives in that single space.
- Clients (alice/bob) and workers share the same in-process \`PiSpaces\` object — no socket, no file, no network.

## Workflow {#workflow}

### Step 1: Initialize Space And CompletionProfile {#step-1-init}

\`\`\`ts
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
await harness.commit((tx) => createSpace(tx, "chat-v1", Date.now()), ctx);
const space = new PiSpaces(harness, ctx, Date.now, meter, undefined, { space: "chat-v1" });
const stopService = await startService(harness, ctx);

await space.setCompletionProfiles([
  { taskType: "ChatTask", resultType: "Msg", matchFields: ["taskId", "threadId"], minResults: 1, maxResults: 1 }
]);
\`\`\`

### Step 2: Register Participant Presence With Space Leases {#step-2-presence}

When \`alice\` and \`bob\` join the session, each client writes a \`Presence\` entry with a 30-second lease (\`30_000\` ms) and refreshes it via \`space.renew(lease.id, 30_000)\`.

### Step 3: Submit Message, Reply Transactionally, And Fork Thread {#step-3-chat-and-fork}

1. \`alice\` atomically writes her user \`Msg\` (\`seq: 1\`) and a matching \`ChatTask\`.
2. The chat worker reserves \`ChatTask\` under a transaction (\`space.take(..., { txn })\`), writes the assistant reply \`Msg\` (\`seq: 2\`) carrying the same \`taskId\`, and calls \`space.commit(txn)\`.
3. \`bob\` forks the thread at \`seq: 2\` (\`forkThread\` atomically copies committed messages up to \`seq <= 2\` into the new forked thread).

### Run From Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
\`\`\`

## See Also {#see-also}

- [Stage 2 (v2-local-durable): SQLite, RequestRef Claims, Alarms & Subagent](help.workflow.stage_v2_local_durable#overview)`
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
					de: "Demonstriert SQLite-Persistenz über Neustarts, RequestRef-Deduplizierung, TimerLock-Lease-Alarme und den search_history-Subagenten.",
					en: "Demonstrates SQLite persistence across restarts, RequestRef deduplication, TimerLock lease alarms, and the search_history subagent."
				},
				stage: "v2",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v2-local-durable/run.ts"
			}
		],
		de: {
			title: "Stufe 2 (v2-local-durable): SQLite-Persistenz, Alarme & Subagent",
			short: "Erweitert Stufe 1 um SQLite-Speicherung, neustartfeste RequestRef-Claims, TimerLock-Leases für geplante Alarme und den search_history-Subagenten.",
			body: `## Überblick {#overview}

Stufe 2 (\`help-site/examples/v2-local-durable/run.ts\`) macht den Multiplayer Space-Chat dauerhaft über Prozessneustarts hinweg und fügt genau die zwei fortgeschrittenen Funktionen aus dem Earendil-Artikel hinzu: **geplante Aufgaben (\`schedule\`-Alarme)** und die **konversationsübergreifende Suche per Subagent (\`search_history\`)** – beides rein mit \`pi-spaces\`-Mitteln.

## Topologie: Space-Verteilung {#topology}

- **1 Prozess**, **1 Harness** auf einer **SQLite-Datei** (\`chat-v2.sqlite\`).
- **1 benannter Space** (\`chat-v2\`): Threads, \`Msg\`, \`ChatTask\`, \`ScheduledJob\`, \`TimerLock\`, Subagent-Entries – alles persistent in einem Space.
- Für die Crash-Demo wird der Harness geschlossen und **auf derselben SQLite-Datei neu geöffnet**: der Space überlebt den simulierten Neustart, offene Leases werden gereapt.

## Arbeitsablauf {#workflow}

### Schritt 1: SQLite-Storage und RequestRef-Claims {#step-1-sqlite-claims}

Statt \`MemoryStorage\` öffnet der Host \`await openNodeSqliteStorage(dbPath)\`. Für jeden Teilnehmer wird \`const { generation } = await space.issueGeneration(principal)\` ausgestellt. Wird \`createThread\` oder \`submitMessage\` nach einem Verbindungsabbruch mit derselben \`requestId\` wiederholt, gibt \`pi-spaces\` exakt das erste Ergebnis zurück.

### Schritt 2: Geplante Alarme über ScheduledJob + TimerLock-Lease {#step-2-alarms}

1. Wenn ein Teilnehmer oder Agent eine Erinnerung plant (z.B. \`scheduleReminder(threadId, "Backup-Fenster prüfen", 200)\`), schreibt er:
   - einen \`ScheduledJob\`-Entry mit \`status: "pending"\` und \`FOREVER\`-Lease,
   - einen \`TimerLock\`-Entry \`{ jobId, threadId, executeAt }\` mit **\`lease = delayMs\`**.
2. Solange \`TimerLock\` im Space existiert, ist der Auftrag noch nicht fällig.
3. Sobald \`delayMs\` verstrichen ist – selbst wenn der Prozess zwischendurch geschlossen und auf derselben SQLite-Datei neu geöffnet wurde! –, entfernt der \`pi-spaces\`-Reaper den abgelaufenen \`TimerLock\`.
4. \`tickAlarms()\` nimmt den nun ungesperrten \`ScheduledJob\` unter einer Transaktion, schreibt ihn mit \`status: "triggered"\` zurück und legt gleichzeitig den fälligen Wakeup-\`ChatTask\` an.

### Schritt 3: Konversationsübergreifende Suche per Search-Subagent {#step-3-subagent}

1. In Thread 1 schreibt \`alice\`: *„Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.“*
2. In Thread 2 fragt \`bob\`: *„Was haben wir bezüglich des Event-Stores entschieden?“*
3. Der Haupt-Worker legt einen \`SearchTask\` (\`{ searchId, parentThreadId, question }\`) im Space ab.
4. Der **Search-Subagent-Worker** nimmt \`SearchTask\` unter einer Transaktion, durchsucht mit \`space.readAll({ type: "Msg" })\` alle Threads (ignoriert eigene Subagent-Daten), schreibt für jeden Suchbegriff einen \`SubagentStep\`-Entry (für die Sidebar-Ansicht) und committet das \`SearchResult\` unter dem zweiten \`CompletionProfile\`.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): Prozess-Entkopplung über SpaceService & RemoteSpace](help.workflow.stage_v3_remote_socket#overview)`
		},
		en: {
			title: "Stage 2 (v2-local-durable): SQLite Persistence, Alarms & Subagent",
			short: "Extends Stage 1 with SQLite storage, restart-safe RequestRef claims, TimerLock leases for scheduled alarms, and the search_history subagent.",
			body: `## Overview {#overview}

Stage 2 (\`help-site/examples/v2-local-durable/run.ts\`) makes the Multiplayer Space-Chat durable across process restarts and adds the two advanced capabilities from the Earendil post: **scheduled tasks (\`schedule\` alarms)** and **cross-conversation search via subagent (\`search_history\`)**—both built purely on \`pi-spaces\` primitives.

## Topology: Space Distribution {#topology}

- **1 process**, **1 harness** on a **SQLite file** (\`chat-v2.sqlite\`).
- **1 named space** (\`chat-v2\`): threads, \`Msg\`, \`ChatTask\`, \`ScheduledJob\`, \`TimerLock\`, subagent entries — all durable in one space.
- For the crash demo the harness is closed and **reopened on the same SQLite file**: the space survives the simulated restart and expired leases are reaped.

## Workflow {#workflow}

### Step 1: SQLite Storage And RequestRef Claims {#step-1-sqlite-claims}

Instead of \`MemoryStorage\`, the host opens \`await openNodeSqliteStorage(dbPath)\`. Each participant obtains a generation via \`const { generation } = await space.issueGeneration(principal)\`. Re-sending \`createThread\` or \`submitMessage\` with the same \`requestId\` after a connection drop returns the original result without duplicating entries.

### Step 2: Scheduled Alarms Via ScheduledJob + TimerLock Lease {#step-2-alarms}

1. Scheduling a reminder (\`scheduleReminder(threadId, "Check backup window", 200)\`) writes:
   - a \`ScheduledJob\` entry with \`status: "pending"\` and \`FOREVER\` lease,
   - a \`TimerLock\` entry \`{ jobId, threadId, executeAt }\` with **\`lease = delayMs\`**.
2. While \`TimerLock\` exists in the space, the job is not yet due.
3. Once \`delayMs\` elapses—even if the server process was stopped and reopened on the same SQLite file!—the \`pi-spaces\` reaper expires \`TimerLock\`.
4. \`tickAlarms()\` takes the unlocked \`ScheduledJob\` inside a transaction, rewrites it with \`status: "triggered"\`, and atomically enqueues the wakeup \`ChatTask\`.

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
					de: "Startet SpaceService auf einem Unix-Socket und verbindet Chat-Gateway, Chat-Worker und Search-Subagent als getrennte RemoteSpace-Clients.",
					en: "Starts SpaceService on a Unix socket and connects the chat gateway, chat worker, and search subagent as separate RemoteSpace clients."
				},
				stage: "v3",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts"
			}
		],
		de: {
			title: "Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace über Socket/TCP",
			short: "Trennt Space-Host, Web-Gateway, Chat-Worker und Search-Subagent in separate RemoteSpace-Verbindungen über Unix-Socket oder TCP inklusive Consumer-Mailboxes.",
			body: `## Überblick {#overview}

In Stufe 3 (\`help-site/examples/v3-remote-socket/run.ts\`) greifen Chat-Gateway, Chat-Worker und Search-Subagent nicht mehr direkt auf das \`Harness\`-Objekt zu. Stattdessen veröffentlicht der Host den Space über \`SpaceService\` und \`serveSpace\` auf einem Unix-Domain-Socket (bzw. TCP-Port), und alle Teilnehmer arbeiten über \`RemoteSpace\`.

## Topologie: Space-Verteilung {#topology}

- **1 Host** (Harness + SQLite + \`serveSpace\`) exponiert den Space \`chat-v3\` über einen **Unix-Socket** (\`space.sock\`).
- **3 getrennte \`RemoteSpace\`-Clients** greifen auf denselben Space zu: Gateway (UI), Chat-Worker, Search-Subagent – jeder mit eigenem Transport und eigener Consumer-Mailbox.
- Verteilung: **1 Space, 1 Server, 3 Remote-Consumer** — echte Socket-Grenze statt geteiltem In-Memory-Objekt; dieselbe Engine läuft unverändert gegen \`RemoteSpace\`.

## Arbeitsablauf {#workflow}

### Schritt 1: SpaceService auf Unix-Socket starten {#step-1-serve}

\`\`\`ts
const service = new SpaceService({
  host: harness,
  ctx,
  identity: new GateIdentity(),
  policy: DEFAULT_POLICY
});
const server = await serveSpace(service, {
  listen: { path: socketPath },
  connection: () => ({ peerId: "local-worker", credentials: { roles: ["admin", "member"] } })
});
\`\`\`

### Schritt 2: RemoteSpace-Clients verbinden {#step-2-remote-clients}

\`\`\`ts
const gatewaySpace = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const workerSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const searchSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
\`\`\`

Da \`RemoteSpace\` denselben \`SpaceLike\`-Vertrag wie \`PiSpaces\` implementiert, läuft \`SpaceChatEngine\` aus \`help-site/examples/shared/chat-core.ts\` ohne jede Codeänderung über das Netzwerkprotokoll! Zusätzlich registriert der Worker ein \`notify\`/\`wait\`-Abo und liest seine Consumer-Mailbox über \`events()\` + \`ack()\`.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Stufe 4 (v4-gated-auth): Overlay-Gate, Schicht A/B & 60s-Grants](help.workflow.stage_v4_gated_auth#overview)`
		},
		en: {
			title: "Stage 3 (v3-remote-socket): SpaceService & RemoteSpace over Socket/TCP",
			short: "Decouples space host, web gateway, chat worker, and search subagent into separate RemoteSpace connections over Unix socket or TCP with consumer mailboxes.",
			body: `## Overview {#overview}

In Stage 3 (\`help-site/examples/v3-remote-socket/run.ts\`), the chat gateway, chat worker, and search subagent no longer touch the \`Harness\` directly. Instead, the host exposes the space via \`SpaceService\` and \`serveSpace\` on a Unix domain socket (or TCP port), and all participants operate through \`RemoteSpace\`.

## Topology: Space Distribution {#topology}

- **1 host** (harness + SQLite + \`serveSpace\`) exposes the \`chat-v3\` space over a **Unix socket** (\`space.sock\`).
- **3 separate \`RemoteSpace\` clients** access the same space: gateway (UI), chat worker, search subagent — each with its own transport and consumer mailbox.
- Distribution: **1 space, 1 server, 3 remote consumers** — a real socket boundary instead of a shared in-memory object; the same engine runs unchanged against \`RemoteSpace\`.

## Workflow {#workflow}

### Step 1: Serve SpaceService On A Unix Socket {#step-1-serve}

\`\`\`ts
const service = new SpaceService({
  host: harness,
  ctx,
  identity: new GateIdentity(),
  policy: DEFAULT_POLICY
});
const server = await serveSpace(service, {
  listen: { path: socketPath },
  connection: () => ({ peerId: "local-worker", credentials: { roles: ["admin", "member"] } })
});
\`\`\`

### Step 2: Connect RemoteSpace Clients {#step-2-remote-clients}

\`\`\`ts
const gatewaySpace = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const workerSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const searchSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
\`\`\`

Because \`RemoteSpace\` implements the exact same \`SpaceLike\` interface as \`PiSpaces\`, \`SpaceChatEngine\` from \`help-site/examples/shared/chat-core.ts\` runs unmodified over the wire protocol! Additionally, the worker registers a \`notify\`/\`wait\` subscription and drains its consumer mailbox via \`events()\` + \`ack()\`.

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
					de: "Startet einen Federation-Host mit Boot-Register, Schicht-A/B-Gate, Token-Enrollment, 60-s-Grants und Live-Schlüsselrotation für den Space-Chat.",
					en: "Starts a federation host with boot register, Layer A/B gate, token enrollment, 60s grants, and live key rotation for the Space-Chat."
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

Stufe 4 (\`help-site/examples/v4-gated-auth/run.ts\`) hebt den Space-Chat auf das Sicherheitsniveau von Phase 1b: Kein Client oder Worker darf den Space lesen oder beschreiben, ohne (1) im Overlay-Verzeichnis als Peer bekannt zu sein (**Schicht A**), (2) seinen eingeschriebenen \`Ed25519\`/\`P-256\`-Schlüssel per Verbindungs-Challenge zu beweisen (**Schicht B**) und (3) für jede Operation einen frischen, vom Control-Host signierten **60-Sekunden-Grant** vorzulegen.

## Topologie: Space-Verteilung {#topology}

- **2 unabhängige, persistente Harnesses**, jeweils hinter einem eigenen TCP-Gate:
  - **Control Host** mit dem \`CONTROL_SPACE\` (PeerDirectory, Enroll-Tokens, Grants, Key-Rotation, BootGuard).
  - **Data Host** mit dem Chat-Space (Threads, \`Msg\`, \`Presence\`).
- Zugriff auf den Data-Space nur über **Gate Layer A (Overlay-Peer) + Layer B (Ed25519-Challenge)** und pro Operation einen 60-s-Grant aus dem Control-Space.

## Arbeitsablauf {#workflow}

### Schritt 1: Boot-Register und startFederationHost starten {#step-1-host}

Der Host initialisiert ein \`SqliteRecoveryRegister\` und \`installBootGuard\`, erzeugt die Host- und Authority-Schlüssel (\`generateKey("ed25519")\`) und startet \`startFederationHost(harness, ctx, ...)\` auf einem TCP-Loopback-/Overlay-Port.

### Schritt 2: Admin-Bootstrap & Worker-Enrollment {#step-2-enroll}

1. Der Admin koppelt seinen Schlüssel einmalig über \`bootstrapEnroll\`.
2. Anschließend sendet der Admin ein \`createEnroll\`-Command an den Supervisor, um ein Einmal-Token für den Chat-Worker (\`peerId: "peer-chat-worker"\`) zu erzeugen.
3. Der Chat-Worker ruft \`await workerControl.enroll(token)\` auf und ist damit kryptografisch im \`CONTROL_SPACE\` registriert.

### Schritt 3: Space-Chat mit 60s-Grant-Provider & Live-Key-Rotation {#step-3-grants-rotation}

Der \`RemoteSpace\` des Chat-Workers erhält \`grantProvider: () => workerControl.requestGrant("effect")\`. Vor jedem \`write\`, \`take\` und \`commit\` im Chat-Space wird automatisch ein signierter 60-s-Grant beigefügt. Zum Abschluss demonstriert das Skript eine **unterbrechungsfreie Schlüsselrotation (\`rotateKey\`)** des Workers im laufenden Chat-Betrieb.

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

Stage 4 (\`help-site/examples/v4-gated-auth/run.ts\`) upgrades the Space-Chat to Phase 1b security: no client or worker can read or mutate the space without (1) being recognized in the overlay peer directory (**Layer A**), (2) proving possession of its enrolled \`Ed25519\`/\`P-256\` private key via connection challenge (**Layer B**), and (3) presenting a fresh control-signed **60-second grant** on every operation.

## Topology: Space Distribution {#topology}

- **2 independent, persistent harnesses**, each behind its own TCP gate:
  - **Control host** owning \`CONTROL_SPACE\` (peer directory, enroll tokens, grants, key rotation, boot guard).
  - **Data host** owning the chat space (threads, \`Msg\`, \`Presence\`).
- Access to the data space only through **Gate Layer A (overlay peer) + Layer B (Ed25519 challenge)** plus a 60s grant from the control space per operation.

## Workflow {#workflow}

### Step 1: Initialize Boot Register And startFederationHost {#step-1-host}

The host sets up a \`SqliteRecoveryRegister\` and \`installBootGuard\`, generates host and authority keys (\`generateKey("ed25519")\`), and starts \`startFederationHost(harness, ctx, ...)\` on a TCP port.

### Step 2: Admin Bootstrap & Worker Enrollment {#step-2-enroll}

1. The admin pairs its key once using \`bootstrapEnroll\`.
2. Next, the admin submits a \`createEnroll\` command to the supervisor to issue a one-time token for the chat worker (\`peerId: "peer-chat-worker"\`).
3. The chat worker calls \`await workerControl.enroll(token)\`, registering its public key in \`CONTROL_SPACE\`.

### Step 3: Space-Chat With 60s Grant Provider & Live Key Rotation {#step-3-grants-rotation}

The chat worker's \`RemoteSpace\` is configured with \`grantProvider: () => workerControl.requestGrant("effect")\`. Every \`write\`, \`take\`, and \`commit\` automatically carries a verified 60s grant. Finally, the script performs a **zero-downtime own-key rotation (\`rotateKey\`)** while the chat continues running.

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
					de: "Verteilt Chat-Threads per HRW über 3 Member-Spaces, führt föderierte Subagent-Suchen über alle Members aus und demonstriert takeWaiting sowie LWW-Presence.",
					en: "Distributes chat threads via HRW across 3 member spaces, runs federated subagent searches across all members, and demonstrates takeWaiting plus LWW presence."
				},
				stage: "v5",
				entryTypes: 9,
				profiles: 2,
				command: "node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts"
			}
		],
		de: {
			title: "Stufe 5 (v5-federated-cluster): Föderierte Spaces, HRW-Sharding & Router",
			short: "Verbindet 3 Member-Spaces unter createFederationController: HRW-Platzierung je threadId, föderierte Subagent-Suche, Waiter-Wettlauf (takeWaiting) und Phase-3-LWW-Presence.",
			body: `## Überblick {#overview}

Stufe 5 (\`help-site/examples/v5-federated-cluster/run.ts\`) skaliert den Multiplayer Space-Chat horizontal über **drei Member-Spaces (\`member-1\`, \`member-2\`, \`member-3\`)**, die durch \`createFederationController\` (\`RouterController\` + \`FederatedSpace\` + \`FederationPolicy\`) koordiniert werden.

## Topologie: Space-Verteilung {#topology}

Der Cluster läuft **simuliert in einem einzigen Prozess**: **4 Harnesses** (alle \`MemoryStorage\`), die echte Member-Hosts mit echten Federation-Komponenten spielen — kein Netzwerk, aber exakt dieselbe Routing- und Journal-Logik wie in echter Verteilung.

- **1 Koordinator-Host**: \`RouterController\` (\`router-root\` + 2 Partition-Router für die Routing-Journals) und \`FederatedSpace\` (id \`fed-v5\`). Der Koordinator besitzt selbst keinen Chat-Daten-Space — er führt nur die Policy aus.
- **3 Member-Hosts** (\`member-1\`, \`member-2\`, \`member-3\`): jeder hat einen eigenen, unabhängigen Space mit eigenem Space-Doc.
- **HRW-Sharding**: die Federation-Policy routet \`Thread\`, \`Msg\` und \`ChatTask\` per Rendezvous-Hashing über \`fields.threadId\` deterministisch auf genau einen Member. Das Runner-Report-Feld \`memberDistribution\` zeigt die tatsächliche Verteilung, z.B. \`{ member-1: [alpha, gamma], member-2: [beta], member-3: [delta] }\`.
- **\`FederationIO\`** ist in der Demo ein in-process Adapter auf die lokalen \`PiSpaces\`-Objekte; in einer echten Bereitstellung wären das \`RemoteSpace\`-/RPC-Aufrufe auf entfernte Hosts — die Semantik (\`step\`, \`snapshot\`, \`events\`, \`ack\`, \`txnActive\`) bleibt identisch.
- **Replikation**: 2 \`EntryReplicationController\` (\`rep-1\` auf member-1, \`rep-2\` auf member-2) replizieren \`Presence\` via HLC + Last-Writer-Wins in den gemeinsamen Space \`presence-global\`.

## Arbeitsablauf {#workflow}

### Schritt 1: FederationPolicy mit HRW nach threadId {#step-1-policy}

Alle thread-gebundenen Typen (\`Thread\`, \`Msg\`, \`ChatTask\`) erhalten die Routing-Regel \`mode: "expand"\`, \`by: { field: "threadId" }\` über \`["member-1", "member-2", "member-3"]\`:

- Dadurch landen alle Nachrichten und Aufgaben desselben Threads deterministisch auf demselben Member-Space.
- Verschiedene Threads einer großen Session verteilen sich gleichmäßig auf die 3 Member-Spaces.
- Eine Transaktion wird per \`federatedSpace.createTransaction(member, leaseMs, request)\` auf dem zuständigen Member geöffnet und mit \`finishTransaction(originId, "commit", request)\` abgeschlossen.

### Schritt 2: Föderierte Subagent-Suche über alle 3 Members {#step-2-federated-search}

Wenn \`bob\` in einem Thread (der z.B. auf \`member-2\` liegt) nach der \`"PostgreSQL"\`-Entscheidung aus einem anderen Thread (der auf \`member-1\` liegt) fragt, ruft der Search-Subagent \`federatedSpace.readAll({ type: "Msg" }, request)\` auf. Der Router fragt alle 3 Member-Spaces ab, führt die Treffer zusammen und liefert die Antwort samt Member- und Thread-Referenz zurück!

### Schritt 3: Waiter-Wettlauf (takeWaiting) & LWW-Presence {#step-3-waiter-and-lww}

Globale Worker nutzen \`federatedSpace.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)\`, um Aufgaben von jedem beliebigen Member entgegenzunehmen. Ergänzend zeigt Stufe 5, wie \`EntryReplicationController\` (Phase 3) \`Presence\`-Daten per HLC und Last-Writer-Wins zwischen Replikaten abgleicht.

### Ausführung im Terminal {#run-cli}

\`\`\`bash
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
\`\`\`

## Siehe auch {#see-also}

- [Stufe 6 (v6-mobile-control): Mobile App & Web-Admin Steuerung](help.workflow.stage_v6_mobile_control#overview)`
		},
		en: {
			title: "Stage 5 (v5-federated-cluster): Federated Spaces, HRW Sharding & Router",
			short: "Unites 3 member spaces under createFederationController: HRW placement per threadId, federated subagent search, waiter race (takeWaiting), and Phase 3 LWW presence.",
			body: `## Overview {#overview}

Stage 5 (\`help-site/examples/v5-federated-cluster/run.ts\`) scales the Multiplayer Space-Chat horizontally across **three member spaces (\`member-1\`, \`member-2\`, \`member-3\`)** coordinated by \`createFederationController\` (\`RouterController\` + \`FederatedSpace\` + \`FederationPolicy\`).

## Topology: Space Distribution {#topology}

The cluster is **simulated inside a single process**: **4 harnesses** (all \`MemoryStorage\`) playing real member hosts with real federation components — no network, but the exact same routing and journal logic as a truly distributed deployment.

- **1 coordinator host**: \`RouterController\` (\`router-root\` + 2 partition routers for the routing journals) and \`FederatedSpace\` (id \`fed-v5\`). The coordinator owns no chat-data space itself — it only executes the policy.
- **3 member hosts** (\`member-1\`, \`member-2\`, \`member-3\`): each owns its own independent space with its own space doc.
- **HRW sharding**: the federation policy routes \`Thread\`, \`Msg\`, and \`ChatTask\` by rendezvous hashing over \`fields.threadId\` deterministically onto exactly one member. The runner report field \`memberDistribution\` shows the actual placement, e.g. \`{ member-1: [alpha, gamma], member-2: [beta], member-3: [delta] }\`.
- **\`FederationIO\`** is an in-process adapter onto the local \`PiSpaces\` objects in this demo; in a real deployment these would be \`RemoteSpace\`/RPC calls to remote hosts — the semantics (\`step\`, \`snapshot\`, \`events\`, \`ack\`, \`txnActive\`) stay identical.
- **Replication**: 2 \`EntryReplicationController\` instances (\`rep-1\` on member-1, \`rep-2\` on member-2) replicate \`Presence\` via HLC + Last-Writer-Wins into the shared \`presence-global\` space.

## Workflow {#workflow}

### Step 1: FederationPolicy With HRW By threadId {#step-1-policy}

All thread-scoped types (\`Thread\`, \`Msg\`, \`ChatTask\`) use \`mode: "expand"\`, \`by: { field: "threadId" }\` across \`["member-1", "member-2", "member-3"]\`:

- Every message and task belonging to the same thread deterministically lands on the same member space.
- Different threads distribute evenly across the 3 member spaces.
- Transactions open on the target member via \`federatedSpace.createTransaction(member, leaseMs, request)\` and complete via \`finishTransaction(originId, "commit", request)\`.

### Step 2: Federated Subagent Search Across All 3 Members {#step-2-federated-search}

When \`bob\` asks in a thread hosted on \`member-2\` about the \`"PostgreSQL"\` decision made in a thread hosted on \`member-1\`, the search subagent executes \`federatedSpace.readAll({ type: "Msg" }, request)\`. The router queries all 3 member spaces, merges the results, and returns the cited answer!

### Step 3: Waiter Race (takeWaiting) & LWW Presence {#step-3-waiter-and-lww}

Global workers call \`federatedSpace.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)\` to claim tasks from whichever member receives work first. Stage 5 also previews \`EntryReplicationController\` (Phase 3) replicating \`Presence\` state across replicas via HLC and Last-Writer-Wins.

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

Stufe 6 (\`help-site/examples/v6-mobile-control/run.ts\` sowie der Web-Bereich **\`AdminSpaces\`** unter \`https://spaces.eibrain.org/?view=admin\`) verbindet den Space-Cluster mit der administrativen Steuerung aus \`docs/betrieb-und-mobile-steuerung.md\`. Sowohl die mobile App (\`spaces.html\` + \`steuerung.html\` in \`pi-termux-mobile\`) als auch die Webseite nutzen dieselben Admin-Commands im \`CONTROL_SPACE\`.

## Topologie: Space-Verteilung {#topology}

- **1 Harness** (\`MemoryStorage\` im Runner) trägt **mehrere benannte Spaces**: den \`CONTROL_SPACE\` (Operations-Ebene: Enroll, Worker-Assignments, RunGate, Audit), \`sieve-ops\`, plus dynamisch per \`SpaceLifecycle\` erzeugte Chat-Spaces.
- Verteilung: ein Host, mehrere isolierte Spaces — Steuerbefehle landen im Control-Space, Chat-Daten bleiben in eigenen Daten-Spaces. In der Live-Bereitstellung entspricht der Harness dem Prod-Host hinter \`spaces.eibrain.org\`.

## Arbeitsablauf {#workflow}

### Schritt 1: Login in AdminSpaces & QR-Pairing für das Smartphone {#step-1-login-and-qr}

1. Auf \`https://spaces.eibrain.org\` klickt der Administrator oben rechts auf **\`ADMIN\`** und meldet sich per Admin-Passwort oder Enrollment-Token an.
2. Im Bereich **Identität & Geräte-Pairing** kann mit einem Klick ein neues Enrollment-Token samt \`enrollQr\`-Payload generiert werden, das direkt in \`spaces.html\` der Android-App eingefügt oder gescannt wird.

### Schritt 2: Worker-Skalierung, RunGate-Steuerung und Space-Lebenszyklus {#step-2-control}

Über die identischen Aktionen in \`AdminSpaces\` (Web) und \`steuerung.html\` (Mobile) werden folgende Vorgänge mit vorab gespeicherter, wiederholsicherer \`commandId\` ausgeführt:

- **Worker steuern (\`listWorkers\` / \`setWorkers\`)**: Anzahl der \`chat-worker\`-, \`search-subagent\`- oder \`sieve\`-Worker pro Host und Ziel-Space setzen (\`0\` stoppt sauber nach dem laufenden Task).
- **Läufe & Wartungsfenster (\`startRun\` / \`pauseRun\` / \`resumeRun\` / \`stopRun\` / \`scheduleRun\` / \`exportRun\`)**: Pausiert und setzt Verarbeitungsläufe über die \`RunGate\`-ACK-Barriere auf allen Members fort.
- **Spaces verwalten (\`createSpace\` / \`archiveSpace\` / \`reactivateSpace\` / \`deleteSpace\`)**: Legt neue Session-Spaces an oder schaltet abgeschlossene Spaces per \`archiveSpace\` in den schreibgeschützten Archivmodus.
- **Hinweise & Audit (\`listAlerts\` / \`auditLog\`)**: Zeigt Warnungen (\`collectAlerts\`) und die lückenlose Historie aller Admin-Aufträge.

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

Stage 6 (\`help-site/examples/v6-mobile-control/run.ts\` and the **\`AdminSpaces\`** web portal at \`https://spaces.eibrain.org/?view=admin\`) connects the space cluster to the operational control layer defined in \`docs/betrieb-und-mobile-steuerung.md\`. Both the mobile app (\`spaces.html\` + \`steuerung.html\` in \`pi-termux-mobile\`) and the web interface issue the same admin commands to \`CONTROL_SPACE\`.

## Topology: Space Distribution {#topology}

- **1 harness** (\`MemoryStorage\` in the runner) carries **several named spaces**: the \`CONTROL_SPACE\` (operations layer: enroll, worker assignments, run gate, audit), \`sieve-ops\`, plus chat spaces created dynamically via \`SpaceLifecycle\`.
- Distribution: one host, several isolated spaces — control commands land in the control space while chat data stays in dedicated data spaces. In the live deployment this harness is the prod host behind \`spaces.eibrain.org\`.

## Workflow {#workflow}

### Step 1: Login To AdminSpaces & QR Pairing For Mobile {#step-1-login-and-qr}

1. On \`https://spaces.eibrain.org\`, the administrator clicks **\`ADMIN\`** in the topbar and logs in with the admin password or an enrollment token.
2. Under **Identity & Device Pairing**, a one-click action generates a fresh enrollment token and \`enrollQr\` payload ready to paste or scan in \`spaces.html\` on Android.

### Step 2: Worker Scaling, RunGate Control, And Space Lifecycle {#step-2-control}

Using identical actions in \`AdminSpaces\` (web) and \`steuerung.html\` (mobile), all operations persist their \`commandId\` before transmission for retry safety:

- **Scale Workers (\`listWorkers\` / \`setWorkers\`)**: Set the desired count of \`chat-worker\`, \`search-subagent\`, or \`sieve\` workers per host and target space (\`0\` stops cleanly after the active task).
- **Control Runs & Maintenance Windows (\`startRun\` / \`pauseRun\` / \`resumeRun\` / \`stopRun\` / \`scheduleRun\` / \`exportRun\`)**: Pause and resume runs across all members via the confirmed \`RunGate\` ACK barrier.
- **Manage Spaces (\`createSpace\` / \`archiveSpace\` / \`reactivateSpace\` / \`deleteSpace\`)**: Create new session spaces idempotently or switch completed spaces into read-only \`archiveSpace\` mode.
- **Alerts & Audit (\`listAlerts\` / \`auditLog\`)**: Monitor active warnings (\`collectAlerts\`) and the complete audit log of admin commands.

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
		id: "help.api.pispaces_write",
		type: "api",
		provider: "client",
		tags: ["write", "entry", "lease", "txn", "requestref", "mutation"],
		related: ["help.topic.entries_and_templates", "help.api.pispaces_take"],
		since: "0.0.1",
		de: {
			title: "write – Entry schreiben",
			short: "Erzeugt immer einen neuen typisierten Entry mit Lease; unter einer Transaktion bis zum Commit für andere unsichtbar.",
			body: `## Überblick {#overview}

\`space.write(entry, txn?, lease?, options?)\` schreibt einen neuen Entry \`{ type, types?, fields }\` in den Space und gibt dessen \`Lease { id, expires }\` zurück. Es gibt kein Überschreiben bestehender Entries.

## Technische Referenz {#technical-reference}

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

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| \`entry\` | \`EntryDraft\` | Unveränderlicher Entwurf: Pflicht-\`type\`, optionale Subtypenliste \`types\` und freie JSON-\`fields\`. |
| \`txn\` | \`string \| null\` | ID einer offenen Transaktion; \`null\` = sofortiger eigenständiger Commit. |
| \`lease\` | \`number\` | Lebensdauer in Millisekunden oder \`FOREVER\` für unbegrenzt. |
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
			short: "Always creates a new typed entry with a lease; under a transaction it remains invisible to others until commit.",
			body: `## Overview {#overview}

\`space.write(entry, txn?, lease?, options?)\` writes a new entry \`{ type, types?, fields }\` into the space and returns its \`Lease { id, expires }\`. It never overwrites existing entries in place.

## Technical Reference {#technical-reference}

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

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| \`entry\` | \`EntryDraft\` | Immutable draft: mandatory \`type\`, optional subtype list \`types\`, and free-form JSON \`fields\`. |
| \`txn\` | \`string \| null\` | ID of an open transaction; \`null\` = immediate standalone commit. |
| \`lease\` | \`number\` | Lifetime in milliseconds or \`FOREVER\` for unbounded. |
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
		id: "help.api.pispaces_read",
		type: "api",
		provider: "client",
		tags: ["read", "readifexists", "template", "wildcard", "timeout"],
		related: ["help.topic.entries_and_templates", "help.api.pispaces_take"],
		since: "0.0.1",
		de: {
			title: "read & readIfExists – Entry zerstörungsfrei lesen",
			short: "Sucht einen passenden sichtbaren Entry anhand eines Templates (fehlende/null-Felder sind Wildcards) und wartet bis zum Timeout.",
			body: `## Überblick {#overview}

\`read(template, timeout, options?)\` gibt einen passenden \`EntryView\` zurück, ohne ihn aus dem Space zu entfernen. Ist noch kein Treffer sichtbar, wartet der Aufruf bis zu \`timeout\` Millisekunden (\`NO_WAIT = 0\` kehrt sofort zurück).

## Technische Referenz {#technical-reference}

\`\`\`ts
const view = await space.read({ type: "SearchResult", fields: { searchId: "s-1" } }, 5_000);
const immediate = await space.readIfExists({ type: "Thread", fields: { threadId: "main" } }, 1_000);
\`\`\`

- \`readIfExists\` wartet **nur**, solange passende Entries durch fremde offene Transaktionen gesperrt sind; gibt es überhaupt keinen Treffer, kehrt es sofort mit \`null\` zurück.

## Parameter und Rückgabewert {#parameters}

| Parameter | Typ | Bedeutung |
| --- | --- | --- |
| \`template\` | \`Template\` | Suchmuster \`{ type?, fields?, id? }\`; fehlende oder \`null\`-Felder wirken als Wildcards, \`types\`-Subtypen werden mitgematcht. |
| \`timeout\` | \`number\` | Maximale Wartezeit in ms; \`NO_WAIT = 0\` kehrt sofort zurück, \`FOREVER\` wartet unbegrenzt. |
| \`options.txn\` | \`string\` | Optional: Liest auch eigene, noch nicht committete Entwürfe derselben Transaktion. |
| **Rückgabe** | \`Promise<EntryView \| null>\` | Der passende Entry inklusive \`gid\`, \`type\`, \`fields\` und Metadaten – oder \`null\` bei Timeout. |

## Typische Anwendungsfälle {#use-cases}

- **Thread-Prüfung**: \`readIfExists({ type: "Thread", fields: { threadId } })\` prüft, ob ein Gesprächskontext bereits existiert, bevor ein Client ihn anlegt.
- **Ergebnis-Warte**: Der Subagent-Consumer wartet per \`read({ type: "SearchResult", fields: { searchId } }, 60_000)\` blockierend auf das Suchergebnis, statt zu pollen.
- **Zustandsabfragen**: \`RunGate\`-, \`Worker\`- und \`Alert\`-Entries werden von \`AdminSpaces\` genau so abgefragt.`
		},
		en: {
			title: "read & readIfExists – Non-Destructive Entry Read",
			short: "Finds a matching visible entry using a template (missing/null fields are wildcards) and waits up to the timeout.",
			body: `## Overview {#overview}

\`read(template, timeout, options?)\` returns a matching \`EntryView\` without removing it from the space. If no match is visible yet, it waits up to \`timeout\` milliseconds (\`NO_WAIT = 0\` returns immediately).

## Technical Reference {#technical-reference}

\`\`\`ts
const view = await space.read({ type: "SearchResult", fields: { searchId: "s-1" } }, 5_000);
const immediate = await space.readIfExists({ type: "Thread", fields: { threadId: "main" } }, 1_000);
\`\`\`

- \`readIfExists\` waits **only** while matching entries are locked by another transaction; if no candidate exists at all, it returns \`null\` immediately.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| \`template\` | \`Template\` | Query pattern \`{ type?, fields?, id? }\`; missing or \`null\` fields act as wildcards, \`types\` subtypes match as well. |
| \`timeout\` | \`number\` | Maximum wait in ms; \`NO_WAIT = 0\` returns immediately, \`FOREVER\` waits indefinitely. |
| \`options.txn\` | \`string\` | Optional: also reads your own uncommitted drafts inside the same transaction. |
| **Return** | \`Promise<EntryView \| null>\` | The matching entry including \`gid\`, \`type\`, \`fields\`, and metadata – or \`null\` on timeout. |

## Typical Use Cases {#use-cases}

- **Thread check**: \`readIfExists({ type: "Thread", fields: { threadId } })\` verifies that a conversation context exists before a client creates it.
- **Result waiting**: The subagent consumer blocks via \`read({ type: "SearchResult", fields: { searchId } }, 60_000)\` instead of polling.
- **State queries**: \`RunGate\`, \`Worker\`, and \`Alert\` entries are queried by \`AdminSpaces\` in exactly the same way.`
		}
	},
	{
		id: "help.api.pispaces_take",
		type: "api",
		provider: "client",
		tags: ["take", "takeifexists", "exclusive", "reservation", "txn"],
		related: ["help.topic.leases_and_transactions", "help.api.pispaces_txn"],
		since: "0.0.1",
		de: {
			title: "take & takeIfExists – Entry exklusiv entnehmen oder reservieren",
			short: "Entfernt einen passenden Entry sofort destruktiv oder reserviert ihn exklusiv unter einer Transaktion (Rückkehr bei Abort/Lease-Ablauf).",
			body: `## Überblick {#overview}

\`take(template, timeout, options?)\` entnimmt einen passenden Entry exklusiv. Ohne \`txn\` ist die Entnahme sofort endgültig; mit \`{ txn }\` wird der Entry für diese Transaktion reserviert und kehrt bei \`abort(txn)\` oder Ablauf der Transaktions-Lease automatisch in den Space zurück.

## Technische Referenz {#technical-reference}

\`\`\`ts
const txn = await space.createTransaction(30_000);
const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
\`\`\`

- Steht der Entry-Typ unter einem \`RunGate\`, sind Entries nur nehmbar, solange der \`RunGate\` des Laufs auf \`running\` steht.

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
- **Timer-Abrüstung**: Der Reaper entnimmt abgelaufene \`TimerLock\`-Entries und löst damit fällige \`ScheduledJob\`-Alarme aus.`
		},
		en: {
			title: "take & takeIfExists – Exclusively Remove or Reserve an Entry",
			short: "Removes a matching entry immediately or reserves it exclusively under a transaction (returning it on abort or lease expiry).",
			body: `## Overview {#overview}

\`take(template, timeout, options?)\` removes a matching entry exclusively. Without \`txn\`, removal is immediate; with \`{ txn }\`, the entry is reserved under that transaction and automatically returns to the space on \`abort(txn)\` or transaction lease expiry.

## Technical Reference {#technical-reference}

\`\`\`ts
const txn = await space.createTransaction(30_000);
const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
\`\`\`

- If the entry type is governed by a \`RunGate\`, entries are takeable only while the run's \`RunGate\` is in state \`running\`.

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
- **Timer disarming**: The reaper takes expired \`TimerLock\` entries, which triggers due \`ScheduledJob\` alarms.`
		}
	},
	{
		id: "help.api.pispaces_txn",
		type: "api",
		provider: "client",
		tags: ["createtransaction", "commit", "abort", "txn", "atomic"],
		related: ["help.topic.leases_and_transactions", "help.topic.completion_profiles_and_limits"],
		since: "0.0.1",
		de: {
			title: "Transaktionen – createTransaction, commit & abort",
			short: "Bündelt Takes (Reservierungen) und Writes (unsichtbare Entwürfe) atomar; prüft beim Commit alle CompletionProfiles und Byte-Budgets.",
			body: `## Überblick {#overview}

\`createTransaction(lease?, options?)\` erzeugt eine neue Space-Transaktion. \`commit(txnId, options?)\` macht alle unter \`txnId\` geschriebenen Entries sichtbar und entfernt alle unter \`txnId\` genommenen Entries endgültig. \`abort(txnId, options?)\` verwirft alle Writes und gibt alle reservierten Takes frei.

## Technische Referenz {#technical-reference}

\`\`\`ts
const txn = await space.createTransaction(60_000, { request: reqBegin });
// ... space.take(..., { txn: txn.id }) & space.write(..., txn.id) ...
await space.commit(txn.id, { request: reqCommit });
\`\`\`

## Verhalten und Garantien {#parameters}

- **Isolation**: Unter \`txn\` geschriebene Entries sind nur für Operationen mit derselben \`txnId\` sichtbar; reservierte Takes sind für andere Consumer gesperrt.
- **Atomarität**: \`commit\` wendet alle Writes und Takes gemeinsam an, erhöht \`rev\` genau einmal und stößt die zugehörigen Mailbox-Ereignisse an. \`abort\` verwirft alles und gibt reservierte Entries frei.
- **Lease**: Die Transaktion besitzt eine eigene Lease (Argument \`lease\`); bei Ablauf ohne Commit erfolgt implizit ein \`abort\`.
- **Vertragsprüfung**: Vor dem Commit prüft der Kern alle \`CompletionProfiles\` (\`CompletionViolation\` bei fehlenden Ergebnissen) und die konfigurierten Byte-Budgets (\`LimitsExceeded\`).

## Typische Anwendungsfälle {#use-cases}

- **Task-Verarbeitung**: \`take(ChatTask, { txn })\` + \`write(Msg, txn)\` + \`commit(txn)\` – die Antwort existiert nie ohne den konsumierten Task und umgekehrt.
- **Mehrschritt-Zustandswechsel**: \`take(Thread) + write(Thread')\` in einer \`txn\` ersetzt In-Place-Updates sicher.
- **Abbruch bei Fehlern**: Wirft die Verarbeitung (z.B. Modellaufruf), ruft der Worker \`abort(txn)\`, wird nichts halbfertig sichtbar.`
		},
		en: {
			title: "Transactions – createTransaction, commit & abort",
			short: "Groups takes (reservations) and writes (invisible drafts) atomically; verifies all CompletionProfiles and byte budgets on commit.",
			body: `## Overview {#overview}

\`createTransaction(lease?, options?)\` starts a space transaction. \`commit(txnId, options?)\` publishes all entries written under \`txnId\` and permanently deletes all entries taken under \`txnId\`. \`abort(txnId, options?)\` discards all writes and releases all reserved takes.

## Technical Reference {#technical-reference}

\`\`\`ts
const txn = await space.createTransaction(60_000, { request: reqBegin });
// ... space.take(..., { txn: txn.id }) & space.write(..., txn.id) ...
await space.commit(txn.id, { request: reqCommit });
\`\`\`

## Behavior And Guarantees {#parameters}

- **Isolation**: Entries written under \`txn\` are visible only to operations carrying the same \`txnId\`; reserved takes are locked for other consumers.
- **Atomicity**: \`commit\` applies all writes and takes together, bumps \`rev\` exactly once, and emits the corresponding mailbox events. \`abort\` discards everything and releases reserved entries.
- **Lease**: The transaction owns a lease (the \`lease\` argument); expiry without commit implies an implicit \`abort\`.
- **Contract enforcement**: Before committing, the core checks all \`CompletionProfiles\` (\`CompletionViolation\` on missing results) and configured byte budgets (\`LimitsExceeded\`).

## Typical Use Cases {#use-cases}

- **Task processing**: \`take(ChatTask, { txn })\` + \`write(Msg, txn)\` + \`commit(txn)\` – the reply never exists without the consumed task and vice versa.
- **Multi-step state transitions**: \`take(Thread) + write(Thread')\` inside one \`txn\` replaces in-place updates safely.
- **Abort on failure**: If processing (e.g. a model call) throws, the worker calls \`abort(txn)\` and nothing half-finished becomes visible.`
		}
	},
	{
		id: "help.api.pispaces_lease",
		type: "api",
		provider: "client",
		tags: ["renew", "cancel", "lease", "ttl", "presence", "heartbeat"],
		related: ["help.topic.leases_and_transactions", "help.workflow.stage_v1_local_memory"],
		since: "0.0.1",
		de: {
			title: "Leases – renew & cancel",
			short: "Verlängert oder beendet die Lebensdauer eigener Entries, Transaktionen, Notify-Abos und Waiter (Grundlage für Presence & Heartbeats).",
			body: `## Überblick {#overview}

\`renew(leaseId, ms, options?)\` setzt die neue Ablaufzeit einer eigenen Ressource auf \`now + ms\` (oder \`FOREVER\`) und gibt den neuen Ablauf-Zeitstempel zurück. \`cancel(leaseId, options?)\` beendet die Ressource sofort (entfernt den Entry, bricht die Transaktion ab oder kündigt das Abo/den Waiter).

## Technische Referenz {#technical-reference}

\`\`\`ts
const presence = await space.write({ type: "Presence", fields: { username: "alice" } }, null, 30_000);
const newExpires = await space.renew(presence.id, 30_000);
await space.cancel(presence.id);
\`\`\`

## Verhalten {#parameters}

- **Ownership**: Nur der Besitzer der Lease (Principal bzw. Besitz-Claim) darf \`renew\` und \`cancel\` aufrufen; fremde Aufrufe werden abgewiesen.
- **\`renew\`**: Setzt \`expires = now + ms\` (oder \`FOREVER\`); funktioniert für Entry-Leases, Transaktions-Leases, Notify-Abos und geparkte Waiter.
- **\`cancel\`**: Beendet die Ressource sofort – bei einem Entry entspricht das dem Entfernen, bei einer Transaktion einem \`abort\`.

## Typische Anwendungsfälle {#use-cases}

- **Presence-Heartbeat**: Der Browser-Client erneuert seine \`Presence\`-Lease alle ~15 s; bei Verbindungsabbruch läuft sie aus und der Teilnehmer verschwindet automatisch aus der Online-Liste.
- **Lange Tasks**: Ein Worker mit aufwendiger Verarbeitung verlängert seine Transaktions-Lease periodisch, damit die Reservierung nicht vorzeitig abläuft.
- **Sauberes Abmelden**: \`cancel(presence.id)\` beim geordneten Disconnect entfernt den Eintrag sofort statt auf den Reaper zu warten.`
		},
		en: {
			title: "Leases – renew & cancel",
			short: "Extends or cancels the lifetime of owned entries, transactions, notify subscriptions, and waiters (basis for presence & heartbeats).",
			body: `## Overview {#overview}

\`renew(leaseId, ms, options?)\` updates the expiration of an owned resource to \`now + ms\` (or \`FOREVER\`) and returns the new expiration timestamp. \`cancel(leaseId, options?)\` terminates the resource immediately (removes the entry, aborts the transaction, or cancels the subscription/waiter).

## Technical Reference {#technical-reference}

\`\`\`ts
const presence = await space.write({ type: "Presence", fields: { username: "alice" } }, null, 30_000);
const newExpires = await space.renew(presence.id, 30_000);
await space.cancel(presence.id);
\`\`\`

## Behavior {#parameters}

- **Ownership**: Only the lease owner (principal or ownership claim) may call \`renew\` and \`cancel\`; foreign calls are rejected.
- **\`renew\`**: Sets \`expires = now + ms\` (or \`FOREVER\`); works for entry leases, transaction leases, notify subscriptions, and parked waiters.
- **\`cancel\`**: Terminates the resource immediately – for an entry this equals removal, for a transaction an \`abort\`.

## Typical Use Cases {#use-cases}

- **Presence heartbeat**: The browser client renews its \`Presence\` lease every ~15 s; on disconnect the lease expires and the participant automatically leaves the online list.
- **Long-running tasks**: A worker performing expensive processing renews its transaction lease periodically so the reservation does not expire early.
- **Clean sign-out**: \`cancel(presence.id)\` on an orderly disconnect removes the record immediately instead of waiting for the reaper.`
		}
	},
	{
		id: "help.api.pispaces_read_page_changes",
		type: "api",
		provider: "client",
		tags: ["readpage", "changes", "readall", "count", "stats", "snapshot"],
		related: ["help.topic.snapshots_and_change_streams"],
		since: "0.0.1",
		de: {
			title: "readPage & changes – Konsistente Snapshots und Revisionsströme",
			short: "Liest bytebegrenzte Seiten eines unveränderlichen Snapshots (mit token und rev) und holt nachfolgende Commit-Batches über changes(afterRev) auf.",
			body: `## Überblick {#overview}

\`readPage(template?, options?)\` und \`changes(afterRev, options?)\` ermöglichen konsistentes Initial-Laden und anschlussfähiges Live-Streaming ohne verlorene oder doppelte Ereignisse. Daneben stehen \`readAll(template?, { limit?, txn? })\`, \`count(template?, txn?)\` und \`stats()\` zur Verfügung.

## Technische Referenz {#technical-reference}

\`\`\`ts
const firstPage = await space.readPage({ type: "Msg", fields: { threadId: "main" } });
const deltas = await space.changes(firstPage.rev);
const gauges = await space.stats();
\`\`\`

## Wichtige Methoden {#parameters}

| Methode | Rückgabe | Zweck |
| --- | --- | --- |
| \`readPage(template?, opts?)\` | \`Page { entries, rev, token? }\` | Unveränderlicher Punkt-in-Zeit-Snapshot, bytebegrenzt seitenweise über \`token\` fortsetzbar. |
| \`changes(afterRev, opts?)\` | \`Changes { rev, batches, gaps? }\` | Alle seit \`afterRev\` committeten Deltas in Reihenfolge; \`gaps\` markiert verdichtete Bereiche. |
| \`readAll(template?, { limit?, txn? })\` | \`EntryView[]\` | Bequemer Komplettabruf ohne Paging (für kleine Ergebnismengen). |
| \`count(template?, txn?)\` / \`stats()\` | \`number\` / Gauges | Schnelle Größen- und Füllstandsabfragen für Dashboards. |

## Typische Anwendungsfälle {#use-cases}

- **UI-Bootstrap + Live-Sync**: Der Chat-Client lädt die Thread-Historie per \`readPage\` und hängt sich anschließend mit \`changes(page.rev)\` an den Echtzeitstrom – lückenlos und ohne Duplikate.
- **Live Space-Inspector**: Der Inspektor der Workbench und \`AdminSpaces\` nutzen \`readPage\`/\`readAll\`/\`stats\`, um den aktuellen Bestand jedes Spaces (v1–v6) anzuzeigen.
- **Backfill nach Reconnect**: Nach einer Unterbrechung holt der Client alle verpassten Revisions-Batches über \`changes\` nach, statt den gesamten Space neu zu laden.`
		},
		en: {
			title: "readPage & changes – Consistent Snapshots and Revision Streams",
			short: "Reads byte-bounded pages of an immutable snapshot (with token and rev) and catches up on subsequent commit batches via changes(afterRev).",
			body: `## Overview {#overview}

\`readPage(template?, options?)\` and \`changes(afterRev, options?)\` enable consistent initial loading followed by gapless live streaming. For quick queries, \`readAll(template?, { limit?, txn? })\`, \`count(template?, txn?)\`, and \`stats()\` are also available.

## Technical Reference {#technical-reference}

\`\`\`ts
const firstPage = await space.readPage({ type: "Msg", fields: { threadId: "main" } });
const deltas = await space.changes(firstPage.rev);
const gauges = await space.stats();
\`\`\`

## Key Methods {#parameters}

| Method | Return | Purpose |
| --- | --- | --- |
| \`readPage(template?, opts?)\` | \`Page { entries, rev, token? }\` | Immutable point-in-time snapshot, continued page-by-page via \`token\` under a byte budget. |
| \`changes(afterRev, opts?)\` | \`Changes { rev, batches, gaps? }\` | All commit deltas since \`afterRev\` in order; \`gaps\` marks compacted ranges. |
| \`readAll(template?, { limit?, txn? })\` | \`EntryView[]\` | Convenience full read without paging (for small result sets). |
| \`count(template?, txn?)\` / \`stats()\` | \`number\` / gauges | Fast size and fill-level queries for dashboards. |

## Typical Use Cases {#use-cases}

- **UI bootstrap + live sync**: The chat client loads the thread history via \`readPage\` and then attaches to the realtime stream with \`changes(page.rev)\` – gapless and without duplicates.
- **Live Space Inspector**: The workbench inspector and \`AdminSpaces\` use \`readPage\`/\`readAll\`/\`stats\` to display the current contents of every space (v1–v6).
- **Backfill after reconnect**: After an interruption, the client fetches all missed revision batches via \`changes\` instead of reloading the entire space.`
		}
	},
	{
		id: "help.api.pispaces_wait_notify_mailbox",
		type: "api",
		provider: "client",
		tags: ["wait", "notify", "events", "ack", "mailbox"],
		related: ["help.topic.durable_mailboxes_and_ack"],
		since: "0.0.1",
		de: {
			title: "wait, notify, events & ack – Reaktive Zustellung und Consumer-Mailboxes",
			short: "Parkt langlebige Read/Take-Wünsche oder Event-Abos ohne Turn-Blockade; liefert Ergebnisse über dauerhafte Mailboxes mit Präfix-ACK.",
			body: `## Überblick {#overview}

\`wait\` und \`notify\` registrieren dauerhafte Aufträge im Space-Dokument. Über \`events(principal, { mailboxEpoch?, after?, maxBytes? })\` und \`ack(principal, epoch, upTo)\` verarbeiten Consumer die ausgelieferten Ereignisse zuverlässig über Neustarts hinweg.

## Technische Referenz {#technical-reference}

\`\`\`ts
const waitId = await space.wait(
  { type: "ChatTask" },
  { take: true, target: principal, timeout: FOREVER, txnLeaseMs: 60_000, handback: { worker: "w1" } }
);
const mailboxPage = await space.events(principal, { after: lastSeq });
if (mailboxPage.next !== null) {
  await space.ack(principal, mailboxPage.mailboxEpoch, mailboxPage.next);
}
\`\`\`

## Wichtige Methoden {#parameters}

| Methode | Zweck |
| --- | --- |
| \`wait(template, opts)\` | Parkt einen langlebigen Read-/Take-Wunsch (\`take: true\` reserviert automatisch unter einer impliziten Transaktion mit \`txnLeaseMs\`); liefert die Treffer an die Mailbox von \`target\`. |
| \`notify(template, opts)\` | Abonniert Änderungen auf ein Template und liefert Events in die eigene Principal-Mailbox. |
| \`events(principal, { mailboxEpoch?, after?, maxBytes? })\` | Bytebegrenzte Seite ausgelieferter Ereignisse ab Sequenz \`after\`; \`mailboxEpoch\`-Mismatch meldet eine \`gap\` statt stiller Verluste. |
| \`ack(principal, epoch, upTo)\` | Bestätigt ein verarbeitetes Sequenz-Präfix; erst ge-ack-te Ereignisse werden dauerhaft verworfen. |

## Typische Anwendungsfälle {#use-cases}

- **Ereignisgesteuerter Worker**: Statt \`take(..., FOREVER)\` zu blockieren, parkt der Worker einen dauerhaften Take-Wunsch mit \`wait\`; \`pi-spaces\` legt gewonnene Tasks samt \`handback\`-Kontext in seine Mailbox.
- **Robuster Consumer**: Der Worker verarbeitet \`events\`-Seiten und ackt erst nach erfolgreichem \`commit\` – bei Neustart werden unbestätigte Ereignisse erneut geliefert (At-least-once).
- **Notify-Streams**: UI- oder Audit-Consumer abonnieren \`notify({ type: "Msg" })\` und bleiben über \`events\`/\`ack\` über alle Raum-Änderungen informiert, auch über Prozessneustarts hinweg.`
		},
		en: {
			title: "wait, notify, events & ack – Reactive Delivery and Consumer Mailboxes",
			short: "Parks long-lived read/take requests or event subscriptions without blocking a turn; delivers results via durable mailboxes with prefix ACK.",
			body: `## Overview {#overview}

\`wait\` and \`notify\` register durable subscriptions in the space document. Consumers poll delivered events via \`events(principal, { mailboxEpoch?, after?, maxBytes? })\` and confirm processed prefixes via \`ack(principal, epoch, upTo)\` across restarts.

## Technical Reference {#technical-reference}

\`\`\`ts
const waitId = await space.wait(
  { type: "ChatTask" },
  { take: true, target: principal, timeout: FOREVER, txnLeaseMs: 60_000, handback: { worker: "w1" } }
);
const mailboxPage = await space.events(principal, { after: lastSeq });
if (mailboxPage.next !== null) {
  await space.ack(principal, mailboxPage.mailboxEpoch, mailboxPage.next);
}
\`\`\`

## Key Methods {#parameters}

| Method | Purpose |
| --- | --- |
| \`wait(template, opts)\` | Parks a long-lived read/take wish (\`take: true\` reserves automatically under an implicit transaction with \`txnLeaseMs\`); delivers matches to the \`target\` mailbox. |
| \`notify(template, opts)\` | Subscribes to changes matching a template and delivers events into the caller's principal mailbox. |
| \`events(principal, { mailboxEpoch?, after?, maxBytes? })\` | Byte-bounded page of delivered events after sequence \`after\`; a \`mailboxEpoch\` mismatch reports a \`gap\` instead of silent loss. |
| \`ack(principal, epoch, upTo)\` | Acknowledges a processed sequence prefix; only acked events are discarded permanently. |

## Typical Use Cases {#use-cases}

- **Event-driven worker**: Instead of blocking in \`take(..., FOREVER)\`, the worker parks a durable take wish with \`wait\`; \`pi-spaces\` places won tasks including the \`handback\` context into its mailbox.
- **Robust consumer**: The worker processes \`events\` pages and acks only after a successful \`commit\` – on restart, unacknowledged events are delivered again (at-least-once).
- **Notify streams**: UI or audit consumers subscribe via \`notify({ type: "Msg" })\` and stay informed about all space changes through \`events\`/\`ack\`, even across process restarts.`
		}
	},
	{
		id: "help.api.pispaces_claims",
		type: "api",
		provider: "client",
		tags: ["issuegeneration", "polloperation", "resolveoperation", "canceloperation", "requestref"],
		related: ["help.topic.request_claims_and_generations"],
		since: "0.0.1",
		de: {
			title: "Request-Claims & Generationen – Neustartfeste Idempotenz",
			short: "Bindet Mutationen und blockierende Operationen atomar an {principal, generation, requestId} und einen kanonischen RFC-8785-Argument-Hash.",
			body: `## Überblick {#overview}

\`issueGeneration(principal)\` erzeugt eine signierte Generation. \`pollOperation(request)\` fragt den Status eines bekannten Claims ab (\`pending\`, \`done\`, \`cancelled\`), \`cancelOperation(request)\` bricht eine noch wartende Operation gezielt ab und \`resolveOperation\` klärt vor dem Router-Retry die Admission-Bindung.

## Technische Referenz {#technical-reference}

\`\`\`ts
const { generation } = await space.issueGeneration({ peerId: "alice" });
const status = await space.pollOperation({ principal: { peerId: "alice" }, generation, requestId: "req-1" });
\`\`\`

## Wichtige Methoden {#parameters}

| Methode | Zweck |
| --- | --- |
| \`issueGeneration(principal)\` | Vergibt eine neue Generation (inkarnationsfest); alle Requests dieser Sitzung tragen \`{ principal, generation, requestId }\`. |
| \`pollOperation(request)\` | Fragt den Status eines Claims ab: \`pending\`, \`done\` (mit Ergebnis) oder \`cancelled\`. |
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

\`issueGeneration(principal)\` issues a signed generation. \`pollOperation(request)\` inspects the status of a known claim (\`pending\`, \`done\`, \`cancelled\`), \`cancelOperation(request)\` cancels a pending operation, and \`resolveOperation\` resolves admission bindings before router retries.

## Technical Reference {#technical-reference}

\`\`\`ts
const { generation } = await space.issueGeneration({ peerId: "alice" });
const status = await space.pollOperation({ principal: { peerId: "alice" }, generation, requestId: "req-1" });
\`\`\`

## Key Methods {#parameters}

| Method | Purpose |
| --- | --- |
| \`issueGeneration(principal)\` | Issues a new incarnation-safe generation; all requests of this session carry \`{ principal, generation, requestId }\`. |
| \`pollOperation(request)\` | Queries the status of a claim: \`pending\`, \`done\` (with result), or \`cancelled\`. |
| \`cancelOperation(request)\` | Deliberately cancels a still-pending blocking operation. |
| \`resolveOperation(req, method, argHash, epoch)\` | Resolves before a router/client retry whether an admission is already bound to the same argument hash. |

## Typical Use Cases {#use-cases}

- **Reconnect without duplicates**: If the WebSocket/TCP connection drops during \`write(msg)\`, the client resends the same \`RequestRef\` – the space returns the already-recorded result instead of a second message.
- **Resolving unclear outcomes**: After \`OutcomeUnknown\` (timeout during commit), the client uses \`pollOperation\` to check whether the mutation actually succeeded.
- **Generation mixup protection**: On restart a client receives a fresh generation; claims from older generations cannot collide with new ones.`
		}
	},
	{
		id: "help.api.pispaces_completion_profiles",
		type: "api",
		provider: "core",
		tags: ["setcompletionprofiles", "setlimits", "completionprofile", "completionviolation"],
		related: ["help.topic.completion_profiles_and_limits"],
		since: "0.0.1",
		de: {
			title: "setCompletionProfiles & setLimits – Serverseitige Ergebnis- und Budgetverträge",
			short: "Erzwingt vor dem Commit einer Take-Transaktion den erwarteten Ergebnistyp, korrelierende Felder (matchFields) und Anzahl; verwaltet Byte-Limits.",
			body: `## Überblick {#overview}

Nur administrativer Host-Code (ohne gesetztes \`conversationId\`) darf \`setCompletionProfiles(profiles)\` und \`setLimits(partialLimits)\` aufrufen. Eine Absenkung von Limits unter bereits bestehende Abschlussverpflichtungen wird vom Space-Kern abgewiesen.

## Technische Referenz {#technical-reference}

\`\`\`ts
await space.setCompletionProfiles([
  { taskType: "ChatTask", resultType: "Msg", matchFields: ["taskId", "threadId"], minResults: 1, maxResults: 1 }
]);
\`\`\`

## Profil-Felder und Fehler {#parameters}

| Feld | Bedeutung |
| --- | --- |
| \`taskType\` | Entry-Typ, der unter der Transaktion genommen wurde und eine Ergebnispflicht auslöst. |
| \`resultType\` | Entry-Typ, der in derselben Transaktion geschrieben werden muss. |
| \`matchFields\` | Felder, deren Werte zwischen Task und Ergebnis übereinstimmen müssen (Korrelation). |
| \`minResults\` / \`maxResults\` | Erwartete Anzahl korrelierender Ergebnis-Entries. |
| \`maxResultBytes\` | Byte-Obergrenze pro Ergebnis (föderierte Profile verlangen dieses Pflichtfeld). |

Verletzt ein Commit das Profil, schlägt \`commit\` mit \`CompletionViolation\` fehl und nichts wird sichtbar. \`setLimits\` verwaltet Byte-/Größenbudgets des Spaces (z.B. \`maxFrameBytes\`, \`maxEventBytes\`, \`mailboxTtlMs\`).

## Typische Anwendungsfälle {#use-cases}

- **Antwortgarantie im Chat**: Der Commit scheitert serverseitig, wenn der Worker den \`ChatTask\` entnimmt, aber keine passende \`Msg\` mit gleicher \`taskId\`/\`threadId\` schreibt – der Task geht nie verloren.
- **Subagent-Vertrag**: \`SearchTask → SearchResult\` garantiert, dass jede föderierte Suche mit einem korrelierten Ergebnis endet.`
		},
		en: {
			title: "setCompletionProfiles & setLimits – Server-Side Result and Budget Contracts",
			short: "Enforces expected result type, correlating fields (matchFields), and count before committing a take transaction; manages byte limits.",
			body: `## Overview {#overview}

Only administrative host code (without \`conversationId\`) may invoke \`setCompletionProfiles(profiles)\` and \`setLimits(partialLimits)\`. Lowering limits below existing completion obligations is rejected by the space core.

## Technical Reference {#technical-reference}

\`\`\`ts
await space.setCompletionProfiles([
  { taskType: "ChatTask", resultType: "Msg", matchFields: ["taskId", "threadId"], minResults: 1, maxResults: 1 }
]);
\`\`\`

## Profile Fields And Errors {#parameters}

| Field | Meaning |
| --- | --- |
| \`taskType\` | Entry type taken under the transaction that triggers a result obligation. |
| \`resultType\` | Entry type that must be written within the same transaction. |
| \`matchFields\` | Fields whose values must match between task and result (correlation). |
| \`minResults\` / \`maxResults\` | Expected number of correlating result entries. |
| \`maxResultBytes\` | Byte cap per result (federated profiles require this field). |

If a commit violates the profile, \`commit\` fails with \`CompletionViolation\` and nothing becomes visible. \`setLimits\` manages the space's byte/size budgets (e.g. \`maxFrameBytes\`, \`maxEventBytes\`, \`mailboxTtlMs\`).

## Typical Use Cases {#use-cases}

- **Reply guarantee in chat**: The commit fails server-side if the worker takes a \`ChatTask\` but writes no matching \`Msg\` with the same \`taskId\`/\`threadId\` – the task is never lost.
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
			short: "Stellt KI-Agenten 8 replay-sichere Tools mit automatischem Task-Claim und Ownership-Schutz bereit; startService betreibt Reaper und Zustellung.",
			body: `## Überblick {#overview}

\`registry.install(spaces)\` registriert die Erweiterung \`spaces\` im \`pi-durable\`-Harness. \`startService(harness, ctx, { space? })\` startet die Hintergrundschleife für Lease-Ablauf (\`core.reap\`) und Zustellung an wartende Conversations.

## Technische Referenz {#technical-reference}

\`\`\`ts
const registry = createRegistry();
registry.install(spaces);
const stopService = await startService(harness, ctx);
\`\`\`

## Die 8 Werkzeuge und ihre Sicherheit {#parameters}

| Tool | Zweck |
| --- | --- |
| \`space_write\`, \`space_read\`, \`space_take\` | Grundlegende Entry-Operationen mit automatischem Task-Claim pro Tool-Aufruf. |
| \`space_list\` | Auflisten sichtbarer Entries eines Spaces/Templates (read-only). |
| \`space_txn\` | Beginnen, committen oder abbrechen von Transaktionen aus dem Agenten heraus. |
| \`space_wait\`, \`space_notify\` | Langlebige Wünsche und Abos ohne den Agenten-Turn zu blockieren. |
| \`space_lease\` | \`renew\`/\`cancel\` für eigene Ressourcen. |

Alle Entry-Inhalte werden dem Agenten strikt als \`[data, not instructions]\` ausgezeichnet; Ownership-Checks verhindern, dass ein Agent fremde Leases oder Claims manipuliert. \`startService\` betreibt den Lease-Reaper, die Waiter-Wecklogik und die Mailbox-Zustellung – ohne ihn bleiben abgelaufene Leases stehen und Waiter schlafen.

## Typische Anwendungsfälle {#use-cases}

- **KI-Chat-Agent**: Ein LLM beantwortet \`ChatTask\`s über \`space_take\`/\`space_write\`, bleibt dank Tool-Claims bei Replays duplikatfrei.
- **Subagent-Suche**: Der \`search_history\`-Subagent bearbeitet \`SearchTask\`s mit denselben Werkzeugen in einem eigenen Prozess.`
		},
		en: {
			title: "Agent Tools (spaces) & startService – Replay-Safe LLM Tools",
			short: "Provides AI agents with 8 replay-safe tools with automatic task claims and ownership protection; startService runs the reaper and delivery.",
			body: `## Overview {#overview}

\`registry.install(spaces)\` registers the \`spaces\` extension in a \`pi-durable\` harness. \`startService(harness, ctx, { space? })\` starts the background loop for lease expiration (\`core.reap\`) and event delivery to waiting conversations.

## Technical Reference {#technical-reference}

\`\`\`ts
const registry = createRegistry();
registry.install(spaces);
const stopService = await startService(harness, ctx);
\`\`\`

## The 8 Tools And Their Safety {#parameters}

| Tool | Purpose |
| --- | --- |
| \`space_write\`, \`space_read\`, \`space_take\` | Fundamental entry operations with an automatic task claim per tool call. |
| \`space_list\` | Lists visible entries of a space/template (read-only). |
| \`space_txn\` | Starts, commits, or aborts transactions from within the agent. |
| \`space_wait\`, \`space_notify\` | Long-lived wishes and subscriptions without blocking the agent's turn. |
| \`space_lease\` | \`renew\`/\`cancel\` for owned resources. |

All entry payloads are presented to the agent strictly as \`[data, not instructions]\`; ownership checks prevent an agent from manipulating foreign leases or claims. \`startService\` runs the lease reaper, waiter wakeup logic, and mailbox delivery – without it, expired leases linger and waiters sleep forever.

## Typical Use Cases {#use-cases}

- **AI chat agent**: An LLM answers \`ChatTask\`s via \`space_take\`/\`space_write\`, staying duplicate-free under replays thanks to tool claims.
- **Subagent search**: The \`search_history\` subagent processes \`SearchTask\`s with the same tools in a dedicated process.`
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
			short: "Veröffentlicht Spaces über Unix-Socket, TCP oder pi-serverd mit Rollen-Policy und bedient RemoteSpace-Clients mit stabiler Retry-Identität.",
			body: `## Überblick {#overview}

\`serveSpace(service, { listen, connection })\` bindet \`SpaceService\` an einen Unix-Socket oder TCP-Port. \`new RemoteSpace(socketTransport(target), options)\` verbindet sich als Client und implementiert \`SpaceLike\`.

## Technische Referenz {#technical-reference}

\`\`\`ts
const server = await serveSpace(service, { listen: { path: "/tmp/space.sock" }, connection });
const remote = new RemoteSpace(socketTransport({ path: "/tmp/space.sock" }), { space: "chat-v3" });
\`\`\`

## Rollen und Fehlerbild {#parameters}

- **\`SpaceService\`**: Transportunabhängige Fassade vor \`SpaceHost\`; ordnet jeder Verbindung über \`IdentityAdapter\` einen vertrauenswürdigen \`Principal\` zu und erzwingt Rollen-Policies.
- **\`serveSpace\`**: Bindet den Service an Unix-Socket (\`{ path }\`) oder TCP (\`{ host, port }\`); alternativ als \`pi-serverd\`-Plugin.
- **\`RemoteSpace\`**: Vollständiger \`SpaceLike\`-Client mit Retry-Identität; blockierende Calls kehren bei Transportabbruch als \`OutcomeUnknown\` zurück und werden per \`pollOperation\` aufgelöst.
- **\`inProcessTransport\`**: Dieselbe Client-Fassade ohne Netzwerk – ideal für Tests der Remote-Grenze.

## Typische Anwendungsfälle {#use-cases}

- **Prozess-Trennung (v3)**: Web-Server, Chat-Worker und Subagent laufen als eigene Prozesse und greifen per \`RemoteSpace\` über Unix-Socket auf denselben Chat-Space zu.
- **Geteilte Mailboxen**: Jeder Remote-Consumer besitzt eine eigene dauerhafte Mailbox; \`events\`/\`ack\` funktionieren über den Socket genauso wie lokal.
- **Pi-Server-Hosting**: \`pi-serverd\` stellt Spaces als persistenten Dienst für mehrere Maschinen im Netzwerk bereit.`
		},
		en: {
			title: "SpaceService, serveSpace & RemoteSpace – Network RPC over Socket & TCP",
			short: "Exposes spaces over Unix socket, TCP, or pi-serverd with role policies and serves RemoteSpace clients with stable retry identity.",
			body: `## Overview {#overview}

\`serveSpace(service, { listen, connection })\` binds \`SpaceService\` to a Unix socket or TCP port. \`new RemoteSpace(socketTransport(target), options)\` connects as a client implementing \`SpaceLike\`.

## Technical Reference {#technical-reference}

\`\`\`ts
const server = await serveSpace(service, { listen: { path: "/tmp/space.sock" }, connection });
const remote = new RemoteSpace(socketTransport({ path: "/tmp/space.sock" }), { space: "chat-v3" });
\`\`\`

## Roles And Failure Modes {#parameters}

- **\`SpaceService\`**: Transport-independent facade over \`SpaceHost\`; assigns each connection a trusted \`Principal\` via \`IdentityAdapter\` and enforces role policies.
- **\`serveSpace\`**: Binds the service to a Unix socket (\`{ path }\`) or TCP (\`{ host, port }\`); alternatively as a \`pi-serverd\` plugin.
- **\`RemoteSpace\`**: Full \`SpaceLike\` client with stable retry identity; blocking calls return \`OutcomeUnknown\` on transport failure and are resolved via \`pollOperation\`.
- **\`inProcessTransport\`**: The same client facade without networking – ideal for testing the remote boundary.

## Typical Use Cases {#use-cases}

- **Process separation (v3)**: Web server, chat worker, and subagent run as dedicated processes accessing the same chat space via \`RemoteSpace\` over a Unix socket.
- **Shared mailboxes**: Each remote consumer owns a durable mailbox; \`events\`/\`ack\` behave over the socket exactly as they do locally.
- **pi-server hosting**: \`pi-serverd\` exposes spaces as a persistent service to multiple machines on the network.`
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

\`startFederationHost(harness, ctx, options)\` komponiert Gate, Schicht-A/B-Authentisierung, Enrollment, Grant-Ausstellung/-Prüfung, Supervisor, Schlüsselrotation und Boot-Guard zu einem einzigen persistenten Host-Dienst.

## Technische Referenz {#technical-reference}

\`\`\`ts
const host = await startFederationHost(harness, ctx, {
  hostId,
  authorityId,
  keys: hostSigner,
  verifier: authorityPublicKey,
  gate: { listen: { host: "127.0.0.1", port: 0 }, directory },
  boot: { external: register, installed: bootState },
  control: { host: harness, authority: authoritySigner }
});
\`\`\`

## Komponenten im Überblick {#parameters}

| Komponente | Aufgabe |
| --- | --- |
| \`startGate\` | Schicht A: Übersetzt NetBird-Peer-Identität in \`peerId\` + Rolle und lehnt unbekannte Peers ab. |
| \`authenticate\` (Schicht B) | Ed25519-/P-256-Challenge-Beweis des Client-Schlüssels unabhängig vom Overlay. |
| \`EnrollmentService\` / \`enrollQr\` | Einmal-Tokens und QR-Payloads zum Pairing von Smartphone, Host oder Browser. |
| \`GrantAuthority\` / \`GrantVerifier\` | Stellt ~60-s-Grants für einzelne Operationen aus und prüft sie auf Data-Hosts. |
| \`RotationService\` / \`rotateKey\` | Atomare Schlüsselrotation im laufenden Betrieb ohne Gate-Neustart. |
| \`HostBootState\` | CAS-geschützter Boot-Guard gegen doppelte Host-Inkarnationen und Restore-Konflikte. |

## Typische Anwendungsfälle {#use-cases}

- **Handy-Pairing (v4/v6)**: \`enrollQr\` am Koordinator erzeugt einen QR-Code; \`pi-termux-mobile\` scannt ihn, führt \`enroll\` im \`CONTROL_SPACE\` aus und erhält \`admin\`-Rechte.
- **Kurzlebige Befehle**: \`AdminSpaces\` und die mobile App rufen jede Steueraktion mit einem frischen 60-s-Grant auf – gestohlene Tokens verfallen sofort.
- **Notfall-Keywechsel**: \`rotateKey\` rotiert den Admin-Schlüssel bei kompromittiertem Gerät ohne Downtime.`
		},
		en: {
			title: "Gate, Layer A/B, Enrollment, 60s Grants & Rotation",
			short: "Combines NetBird peer resolution (Layer A), Ed25519/P-256 challenge (Layer B), QR/token enrollment, 60s grants, and atomic key rotation.",
			body: `## Overview {#overview}

\`startFederationHost(harness, ctx, options)\` composes gate, Layer A/B authentication, enrollment, grant issuance/verification, supervisor, key rotation, and boot guard into a single persistent host runtime.

## Technical Reference {#technical-reference}

\`\`\`ts
const host = await startFederationHost(harness, ctx, {
  hostId,
  authorityId,
  keys: hostSigner,
  verifier: authorityPublicKey,
  gate: { listen: { host: "127.0.0.1", port: 0 }, directory },
  boot: { external: register, installed: bootState },
  control: { host: harness, authority: authoritySigner }
});
\`\`\`

## Components At A Glance {#parameters}

| Component | Task |
| --- | --- |
| \`startGate\` | Layer A: Translates NetBird peer identity into \`peerId\` + role and rejects unknown peers. |
| \`authenticate\` (Layer B) | Ed25519/P-256 challenge proof of the client key, independent of the overlay. |
| \`EnrollmentService\` / \`enrollQr\` | One-time tokens and QR payloads for pairing smartphones, hosts, or browsers. |
| \`GrantAuthority\` / \`GrantVerifier\` | Issues ~60-second grants for individual operations and verifies them on data hosts. |
| \`RotationService\` / \`rotateKey\` | Atomic key rotation at runtime without restarting the gate. |
| \`HostBootState\` | CAS-protected boot guard against duplicate host incarnations and restore conflicts. |

## Typical Use Cases {#use-cases}

- **Phone pairing (v4/v6)**: \`enrollQr\` on the coordinator produces a QR code; \`pi-termux-mobile\` scans it, runs \`enroll\` in the \`CONTROL_SPACE\`, and receives \`admin\` rights.
- **Short-lived commands**: \`AdminSpaces\` and the mobile app execute every control action with a fresh 60-second grant – stolen tokens expire immediately.
- **Emergency key change**: \`rotateKey\` rotates the admin key on a compromised device without downtime.`
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

\`createFederationController(options)\` initialisiert und rekonstruiert den föderierten Router (mit bis zu 1024 Journal-Partitionen), \`FederatedSpace\`, \`FederationPolicyAuthority\` und \`MembershipController\`.

## Technische Referenz {#technical-reference}

\`\`\`ts
const fed = await createFederationController({
  host: coordinatorHarness,
  ctx,
  routerId: "router-main",
  authorityId,
  journalPartitions: 4,
  lease: renewableRouterLease(controlRemote),
  rpcTarget,
  assertAuthority
});
\`\`\`

## Komponenten im Überblick {#parameters}

| Komponente | Aufgabe |
| --- | --- |
| \`RouterController\` | Journalisiert Routing-Entscheidungen partitioniert (bis 1024) und signiert \`RouterLease\`s für autorisierte Member. |
| \`FederatedSpace\` | \`SpaceLike\`-Fassade, die \`write\`/\`read\`/\`take\` per HRW-Hash des Korrelationsfelds (z.B. \`threadId\`) auf den zuständigen Member-Space leitet. |
| \`FederationPolicyAuthority\` | Verwaltet die verbindliche Member-Menge und Shard-Abbildung. |
| \`MembershipController\` | Kontrolliertes Beitreten/Drainen/Entfernen von Membern (\`join\`, \`drain\`, \`leave\`) als journalisierte Kommandos. |
| \`takeWaiting\` | Journalisierter Waiter-Wettlauf: genau ein Member gewinnt einen clusterweit geparkten Take-Wunsch. |

## Typische Anwendungsfälle {#use-cases}

- **Chat-Sharding (v5)**: Threads werden per HRW über \`threadId\` auf drei Member verteilt – jede Transaktion bleibt lokal atomar, memberübergreifende \`txn\` werden mit \`RoutingConflict\` abgelehnt.
- **Clusterweite Suche**: Der \`search_history\`-Subagent schreibt \`SearchTask\`s, die jeder Member lokal beantwortet; der Koordinator fusioniert die \`SearchResult\`s.
- **Wartung ohne Stillstand**: \`membership.execute(cmdId, "drain", member)\` leert einen Host kontrolliert, bevor er gewartet wird.`
		},
		en: {
			title: "createFederationController & FederatedSpace – Router, HRW Sharding & Membership",
			short: "Connects router journal partitions, signed RouterLease, original-principal delegation, HRW policy, waiter race, and membership lifecycle.",
			body: `## Overview {#overview}

\`createFederationController(options)\` initializes and recovers the federated router (supporting up to 1024 journal partitions), \`FederatedSpace\`, \`FederationPolicyAuthority\`, and \`MembershipController\`.

## Technical Reference {#technical-reference}

\`\`\`ts
const fed = await createFederationController({
  host: coordinatorHarness,
  ctx,
  routerId: "router-main",
  authorityId,
  journalPartitions: 4,
  lease: renewableRouterLease(controlRemote),
  rpcTarget,
  assertAuthority
});
\`\`\`

## Components At A Glance {#parameters}

| Component | Task |
| --- | --- |
| \`RouterController\` | Journals routing decisions partitioned (up to 1024) and signs \`RouterLease\`s for authorized members. |
| \`FederatedSpace\` | \`SpaceLike\` facade that routes \`write\`/\`read\`/\`take\` to the responsible member space via HRW hash of the correlation field (e.g. \`threadId\`). |
| \`FederationPolicyAuthority\` | Manages the authoritative member set and shard mapping. |
| \`MembershipController\` | Controlled join/drain/remove of members (\`join\`, \`drain\`, \`leave\`) as journaled commands. |
| \`takeWaiting\` | Journaled waiter race: exactly one member wins a cluster-wide parked take wish. |

## Typical Use Cases {#use-cases}

- **Chat sharding (v5)**: Threads are distributed across three members via HRW over \`threadId\` – every transaction stays locally atomic; cross-member \`txn\`s are rejected with \`RoutingConflict\`.
- **Cluster-wide search**: The \`search_history\` subagent writes \`SearchTask\`s that each member answers locally; the coordinator merges the \`SearchResult\`s.
- **Maintenance without downtime**: \`membership.execute(cmdId, "drain", member)\` empties a host in a controlled fashion before servicing it.`
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
			short: "Steuert Läufe über RunGate-ACK-Barrieren, weist Hosts signierte Worker-Listen zu, verwaltet Space-Lebenszyklen und speist MobileSpaces & AdminSpaces.",
			body: `## Überblick {#overview}

Diese Controller bilden das Backend für die mobile Steuerung (\`pi-termux-mobile\`) sowie für den login-geschützten Web-Admin-Bereich **\`AdminSpaces\`** auf \`https://spaces.eibrain.org\`.

## Technische Referenz {#technical-reference}

\`\`\`ts
await runController.start(spec);
await runController.pause(runId, "cmd-pause-1");
await runController.resume(runId, "cmd-resume-1");
const alerts = collectAlerts({ runs, workers, capabilities, now: Date.now() });
\`\`\`

## Controller im Überblick {#parameters}

| Controller | Aufgabe |
| --- | --- |
| \`SpaceLifecycle\` | \`createSpace\`, \`archiveSpace\`, \`reactivateSpace\`, \`deleteSpace\` – idempotent je Space. |
| \`WorkerSupervisor\` | Weist Hosts signierte Worker-Listen zu; \`setWorkers\` startet/stoppt Worker-Schleifen sauber nach dem laufenden Task. |
| \`RunController\` / \`RunGate\` | \`start\`, \`dryRun\`, \`pause\`, \`resume\`, \`stop\`, \`schedule\`, \`export\`, \`reconcile\` mit bestätigter ACK-Barriere über alle beteiligten Hosts. |
| \`DeploymentController\` | Deklaratives Bootstrap: \`planDeployment\`, \`applyDeployment\`, \`startWorkers\`, \`exportDeployment\` (Schema v1: Hosts, Spaces, Routing, Worker, Mobile-Access). |
| \`collectAlerts\` / \`auditLog\` | Aggregiert Hinweise (stale Heartbeats, blockierte Hosts) und das nachvollziehbare Befehls-Audit. |

## Typische Anwendungsfälle {#use-cases}

- **Ab Stufe v1 verfügbar**: Alle Controller arbeiten bereits auf dem lokalen \`SpaceHost\` – die Stufen v3–v5 erweitern nur den Transportweg (Socket → Gate → Cluster).
- **Wartungsfenster**: \`pauseRun\` friert alle \`RunGate\`-gebundenen Worker clusterweit ein, \`resumeRun\` lässt sie bestätigt weiterlaufen.
- **Bootstrap per Klick**: \`AdminSpaces\`-Panel 7 plant und aktiviert ein komplettes Deployment (Hosts + Spaces + Worker) aus einer JSON-Konfiguration.`
		},
		en: {
			title: "RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Operations Extension (B2–B10)",
			short: "Controls runs via RunGate ACK barriers, assigns signed worker lists to hosts, manages space lifecycles, and powers MobileSpaces & AdminSpaces.",
			body: `## Overview {#overview}

These controllers power both the mobile control pages (\`pi-termux-mobile\`) and the login-protected **\`AdminSpaces\`** web portal at \`https://spaces.eibrain.org\`.

## Technical Reference {#technical-reference}

\`\`\`ts
await runController.start(spec);
await runController.pause(runId, "cmd-pause-1");
await runController.resume(runId, "cmd-resume-1");
const alerts = collectAlerts({ runs, workers, capabilities, now: Date.now() });
\`\`\`

## Controllers At A Glance {#parameters}

| Controller | Task |
| --- | --- |
| \`SpaceLifecycle\` | \`createSpace\`, \`archiveSpace\`, \`reactivateSpace\`, \`deleteSpace\` – idempotent per space. |
| \`WorkerSupervisor\` | Assigns signed worker lists to hosts; \`setWorkers\` starts/stops worker loops cleanly after the current task. |
| \`RunController\` / \`RunGate\` | \`start\`, \`dryRun\`, \`pause\`, \`resume\`, \`stop\`, \`schedule\`, \`export\`, \`reconcile\` with a confirmed ACK barrier across all involved hosts. |
| \`DeploymentController\` | Declarative bootstrap: \`planDeployment\`, \`applyDeployment\`, \`startWorkers\`, \`exportDeployment\` (schema v1: hosts, spaces, routing, workers, mobile access). |
| \`collectAlerts\` / \`auditLog\` | Aggregates alerts (stale heartbeats, blocked hosts) and the auditable command log. |

## Typical Use Cases {#use-cases}

- **Available from stage v1**: All controllers already operate on the local \`SpaceHost\` – stages v3–v5 only extend the transport path (socket → gate → cluster).
- **Maintenance windows**: \`pauseRun\` freezes all \`RunGate\`-bound workers cluster-wide; \`resumeRun\` lets them continue after confirmation.
- **One-click bootstrap**: \`AdminSpaces\` panel 7 plans and activates a complete deployment (hosts + spaces + workers) from a single JSON configuration.`
		}
	}
];
