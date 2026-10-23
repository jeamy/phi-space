// Canonical bilingual topic and workflow articles for PHI-SPACES / HELP.
// Every H2/H3 uses explicit locale-independent {#anchor} identifiers as required by the Help Topic Standard.

export interface ArticleSeed {
	id: string;
	type: "topic" | "workflow" | "api";
	provider: "core" | "client" | "tools" | "remote" | "security" | "federation" | "ops";
	tags: string[];
	related: string[];
	since: string;
	de: {
		title: string;
		short: string;
		body: string;
	};
	en: {
		title: string;
		short: string;
		body: string;
	};
	resources?: Array<{
		id: string;
		title: { de: string; en: string };
		summary: { de: string; en: string };
		stage: string;
		entryTypes: number;
		profiles: number;
		command: string;
	}>;
}

export const TOPIC_AND_WORKFLOW_ARTICLES: ArticleSeed[] = [
	{
		id: "help.topic.overview",
		type: "topic",
		provider: "core",
		tags: ["phi-spaces", "overview", "tuple-space", "architecture", "phispaces", "remotespace", "federatedspace"],
		related: ["help.topic.architecture_layers", "help.topic.guarantees_and_boundaries", "help.workflow.overview_v1_to_v6"],
		since: "0.0.1",
		de: {
			title: "phi-spaces Systemüberblick: Was es ist und was es kann",
			short: "Verständlicher, ausführlicher Einblick: Was phi-spaces ist, wie das transaktionale Tuple-Space-Modell funktioniert, welche Probleme es löst und was es von v1 (In-Memory) bis v6 (Federated Cluster + Mobile/Web Admin) leisten kann.",
			body: `## Überblick {#overview}

\`phi-spaces\` ist ein transaktionaler, persistenter **Koordinationsraum** (eine moderne Weiterentwicklung des klassischen Linda-/JavaSpaces-Paradigmas) mit eigenem Speicher (SQLite, ein Prozess besitzt ihn); für \`@earendil-works/pi-durable\`-Agenten gibt es ein optionales Agent-Paket. Anstatt Clients, Hintergrund-Worker, KI-Agenten und Administrationswerkzeuge über fehleranfällige Punkt-zu-Punkt-Aufrufe direkt miteinander zu verkoppeln, tauschen alle Teilnehmer unveränderliche, typisierte JSON-Objekte (**Entries**) über gemeinsam nutzbare, versionierte Datenräume (**Spaces**) aus.

## Herkunft: Linda und JavaSpaces {#history}

Die Idee stammt aus den 1980er Jahren: David Gelernter und Nicholas Carriero entwickelten an der Yale University **Linda**, ein Koordinationsmodell, in dem Prozesse nicht miteinander sprechen, sondern Daten (**Tupel**) in einen gemeinsamen **Tuple Space** legen und nach ihrem Inhalt wieder herausholen (\`out\`, \`rd\`, \`in\`). Gelernter nannte das *generative Kommunikation*: Daten überdauern den Prozess, der sie erzeugt hat, und verbinden Teilnehmer über Prozess- und Zeitgrenzen hinweg. Ende der 1990er übertrug Sun Microsystems das Konzept mit **JavaSpaces** auf typisierte Java-Objekte (**Entries**) mit Template-Suche, **Leases** und **Transaktionen**.

phi-spaces übernimmt dieses Modell in TypeScript und JSON und ergänzt Persistenz, Revisionen, Änderungsströme, Föderation und Administration. Es ist kein JavaSpaces-kompatibler Java-/RMI-Ersatz.

Das Modell ist nicht auf Agentenkommunikation zugeschnitten. Ein Space transportiert beliebige Daten: Aufträge, Nachrichten, Messwerte, Ergebnisse, Zustände oder Ereignisse. Agenten (Conversations) sind nur eine typische Art von Teilnehmer; Programme, Dienste, Geräte und Menschen nutzen denselben Space auf dieselbe Weise.

### Was phi-spaces besonders kann {#highlights}

- **Beliebige Kommunikate**: Jede JSON-Struktur mit \`type\` kann Entry sein – es gibt kein festes Nachrichtenformat.
- **Kommunikation ohne Adressen**: Absender wählen keinen Empfänger; Teilnehmer finden Daten über Templates.
- **Entkopplung in Raum und Zeit**: Produzenten und Konsumenten kennen einander nicht und müssen nicht gleichzeitig online sein.
- **Verlässliche Arbeitsverteilung**: exklusives \`take\` mit Lease und Transaktion; Abstürze geben Arbeit wieder frei.
- **Dauerhaft und nachvollziehbar**: persistenter Zustand, Revisionen, Snapshots und Änderungsströme.
- **Vom Einzelprozess zum Cluster**: lokal, per Socket/RPC und als föderierter Verbund mit Identität, Enrollment und Admin-Oberflächen.

## Was ist phi-spaces und warum wurde es gebaut? {#what-is-phi-spaces}

\`phi-spaces\` löst vier fundamentale Probleme bei der Entwicklung robuster, langlaufender Systeme und autonomer KI-Agenten-Flotten:

1. **Fehlertolerante Aufgabenübergabe (mit geleaster Reservierung)**: Ein Server, UI-Client oder Agent übergibt Arbeit nicht direkt an einen Worker, sondern schreibt einen Aufgaben-Entry (\`type: "ChatTask"\` o.Ä.) in den Space. Jeder Worker kann sich diesen Task exklusiv **reservieren** (\`take\`). Stürzt der Worker vor der Fertigstellung ab, gibt die abgelaufene Lease den Task automatisch wieder frei – sofern die eigene Task-Lease noch gilt und der Store verfügbar ist.
2. **Zeitliche Entkopplung**: Produzenten und Konsumenten müssen nicht gleichzeitig online sein. Ein Client kann mitten in der Nacht einen \`ScheduledJob\` einstellen und offline gehen; mit persistentem Backend und ausreichender Task-Lease bleibt der Auftrag erhalten; die Anwendung prüft nach Ablauf des TimerLock die Fälligkeit.
3. **Einheitlicher Zustand mit Live-Ereignissen**: Statt fragmentierter Caches bietet jeder Space atomare Transaktionen (\`createTransaction\`, \`commit\`, \`abort\`), konsistente Snapshots (\`readPage\` mit \`rev\`), inkrementelle Update-Streams (\`changes(afterRev)\`) und langlebige Ereignis-Mailboxes (\`events\` + Präfix-\`ack\`).
4. **Schrittweise Verteilung**: Lokale und Remote-Clients teilen den SpaceLike-Basisvertrag. Federation ergänzt Routing und eigene Request-Bindungen; reale Verschlüsselung, Provisionierung und Ausfallsicherheit benötigen gesonderte Konfiguration und Abnahme.

## Begriffs- und Systemmodell {#concept-model}

### Entkopplung in Raum und Zeit {#decoupling}

In \`phi-spaces\` müssen Produzent und Konsument einander nicht kennen und nicht gleichzeitig aktiv sein:

- **Schreiben (\`space.write\`)**: Ein Teilnehmer legt einen Entry \`{ type: string, types?: string[], fields: Record<string, Json> }\` mit einer definierten Ablaufzeit (**Lease**) im Space ab.
- **Lesen (\`space.read\` / \`readIfExists\` / \`readAll\` / \`readPage\`)**: Ein Teilnehmer sucht mit einem **Template** \`{ type?, fields?, id? }\` nach einem passenden sichtbaren Entry, ohne ihn zu entfernen. Fehlende oder \`null\`-Felder im Template wirken als **Wildcards**.
- **Exklusives Entnehmen (\`space.take\`)**: Ein Worker entnimmt einen passenden Entry exklusiv. Erfolgt der \`take\` unter einer **Transaktion (\`txn\`)**, bleibt der Entry reserviert, bis der Worker seine Ergebnisse geschrieben und \`commit(txn)\` aufgerufen hat. Stürzt der Worker ab oder läuft die Transaktions-Lease ab, kehrt der Entry zurück, sofern seine eigene Entry-Lease noch gilt.
- **Warten auf zukünftige Daten (\`space.wait\`)**: Statt blind zu pollen, registriert ein Teilnehmer einen langlebigen \`Waiter\` auf ein Template. Sobald ein passender Entry committet wird, weckt \`phi-spaces\` den Waiter oder sendet ein Ereignis.

### Was kann phi-spaces? (Kernfähigkeiten) {#capabilities}

- **Unveränderliche Entries & Wildcard-Templates**: Typisierte JSON-Objekte mit Subtypen-Registrierung (\`types\`) und exaktem \`type\`/Feld-Matching.
- **Atomare Space-Transaktionen**: \`take\` + mehrere \`write\` + optionale Request-Claims mit einem fachlichen \`commit(txn)\` (vorherige PhiSpaces-Aufrufe sind separate Storage-Commits). Bei \`abort\` oder Timeout wird alles atomar zurückgerollt.
- **Serverseitige Ergebnisgarantien (\`CompletionProfiles\`)**: Der Space-Kern erzwingt beim Commit, dass ein genommener Task des Typs \`ChatTask\` nur zusammen mit genau einem passenden Ergebnis-Entry \`Msg\` erfolgreich commitet werden kann.
- **Idempotente Request-Claims (\`RequestRef\`)**: Jede Mutation kann mit \`{ request: { principal, generation, requestId } }\` ausgeführt werden; Wiederholungen und Timeouts erzeugen keine doppelte Wirkung.
- **Leases & automatischer Reaper (\`startService\`)**: Entries, Presence-Zustände und \`TimerLock\`-Schlösser laufen nach definierter Zeit automatisch ab.
- **Snapshot- und Inkrement-Sync (\`readPage\` + \`changes\`)**: Punkt-in-Zeit-Snapshots plus reihenfolgetreue, revisionierte Update-Streams (\`rev\`) und präfix-bestätigte langlebige Mailboxes.
- **Space Lifecycle, Worker, Läufe & Deployments**: Idempotentes Space-Management (\`archive\`/\`reactivate\`/\`delete\`), Worker-Skalierung (\`WorkerSupervisor\`), Multi-Host-Laufsteuerung (\`RunGate\`) und deklaratives Bootstrap (\`DeploymentController\`) vom Einzel-Host bis zum Cluster.
- **Overlay-Gate, Enrollment & Federated Routing**: NetBird-/WireGuard-Peer-Identität + Ed25519-Challenge, QR-/Token-Enrollment, 60-s-Grants, eigene Key-Rotation und deterministisches HRW-Sharding von Einträgen auf mehrere Hosts.

### Einheitlicher Basisvertrag SpaceLike {#spacelike-contract}

PhiSpaces und RemoteSpace implementieren den SpaceLike-Basisvertrag. FederatedSpace besitzt eine eigene API mit FederationRequest und Member-Transaktionsbindung; Fachkonzepte sind übertragbar, Aufrufsignaturen nicht unverändert austauschbar. Siehe [Topologien und API-Grenzen](help.topic.topology_and_readiness#api).

## Begriffe und Identitäten {#terms-and-identities}

- **Entry**: Ein unveränderliches JSON-Dokument \`{ type: string, types?: string[], fields: Record<string, Json> }\`. Es gibt kein In-Place-Update; Zustandsübergänge erfolgen durch \`take\` + \`write\` in einer gemeinsamen Transaktion.
- **Global ID (\`gid\`)**: Jeder Entry trägt \`gid = <spaceId>/<localId>\`. Die \`localId\` besteht aus der Dateninkarnation des Spaces plus einem monoton steigenden Zähler und wird niemals wiederverwendet.
- **Named Space**: Neben dem Default-Space (\`phi-spaces.space\`, Alias \`default\`) verwaltet die \`Registry\` (\`phi-spaces.registry\`) beliebig viele benannte Spaces (\`phi-spaces.named-space\`) mit stabiler \`spaceId\`.
- **Principal**: Strukturierte Identität \`{ peerId, agentId? }\`. Der Server leitet sie immer aus der authentifizierten Verbindung (\`IdentityAdapter\`) ab, niemals aus ungeprüften Client-Payloads.

## Arbeitsablauf {#workflow}

1. **Vertrag definieren**: Entry-Typen (\`type\`), Pflichtfelder (\`fields\`) und optionale \`CompletionProfiles\` (welcher Task-Typ erfordert welchen Ergebnis-Typ beim Transaktions-Commit?) festlegen.
2. **Space öffnen und Dienst starten**: \`new PhiSpaces(host, ctx, Date.now, meter, undefined, { space })\` erstellen und \`await startService(host, ctx)\` für Lease-Reaper und Event-Zustellung starten.
3. **Aufgaben einstellen und bearbeiten**: Produzenten schreiben Aufgaben mit \`RequestRef\`-Claim; Worker reservieren Aufgaben per \`take(..., { txn })\`, schreiben Ergebnisse unter derselben \`txn\` und rufen \`commit(txn)\` auf.
4. **Live-Beobachtung und Steuerung**: UI-Clients lesen initial \`readPage()\` (Snapshot mit \`rev\`) und folgen Änderungen über \`changes(afterRev)\` oder Consumer-Mailboxes (\`events\` / \`ack\`).

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

- **Ein Commit, eine Wahrheit**: Space-Mutation, Request-Claim, Revisionszähler \`rev\`, Mailbox-Ereignis und Byte-Budget-Prüfung werden in einem einzigen atomaren Commit des Hosts persistiert.
- **Daten sind keine Anweisungen**: Entries aus dem Space stammen potenziell von anderen Agenten oder Benutzern. Die Agenten-Tools kennzeichnen sie strikt als \`[data, not instructions]\`.
- **Help ≠ Live State**: Diese Referenz dokumentiert die stabilen Verträge und Garantien. Den aktuellen Laufzeitbestand eines Spaces zeigen der integrierte **Live Space-Inspector** und der geschützte Bereich **AdminSpaces**.

## Siehe auch {#see-also}

- [Schichtenarchitektur und Modul-Landkarte](help.topic.architecture_layers#overview)
- [Verbindliche Garantien und Systemgrenzen](help.topic.guarantees_and_boundaries#overview)
- [6-Stufen-Praxisleitfaden: Multiplayer Space-Chat (v1–v6)](help.workflow.overview_v1_to_v6#overview)`
		},
		en: {
			title: "phi-spaces System Overview: What It Is And What It Can Do",
			short: "A clear, in-depth look at what phi-spaces is, how the transactional tuple-space model works, which problems it solves, and what it can do from v1 (in-memory) through v6 (federated cluster + mobile/web admin).",
			body: `## Overview {#overview}

\`phi-spaces\` is a transactional, persistent **coordination space** (a modern evolution of the classic Linda / JavaSpaces paradigm) with a store of its own (SQLite, owned by one process); \`@earendil-works/pi-durable\` agents get an optional agent package. Instead of coupling clients, background workers, AI agents, and administrative tools through fragile point-to-point calls, every participant exchanges immutable, typed JSON objects (**entries**) through shared, versioned data spaces (**spaces**).

## Origins: Linda And JavaSpaces {#history}

The idea dates back to the 1980s: David Gelernter and Nicholas Carriero developed **Linda** at Yale University, a coordination model in which processes do not talk to each other but put data (**tuples**) into a shared **tuple space** and retrieve it by content (\`out\`, \`rd\`, \`in\`). Gelernter called this *generative communication*: data outlives the process that created it and connects participants across process and time boundaries. In the late 1990s Sun Microsystems carried the concept over to typed Java objects (**entries**) with template lookup, **leases** and **transactions** as **JavaSpaces**.

phi-spaces adopts this model in TypeScript and JSON and adds persistence, revisions, change streams, federation and administration. It is not a JavaSpaces-compatible Java/RMI runtime.

**Important:** the model is not specific to agent communication. A space carries any kind of data: jobs, messages, sensor readings, results, state or events. Agents (conversations) are just one typical kind of participant; programs, services, devices and people use the same space in the same way.

### What Makes phi-spaces Stand Out {#highlights}

- **Any kind of communicate**: any JSON structure with a \`type\` can be an entry; there is no fixed message format.
- **Communication without addresses**: senders do not pick a recipient; participants find data through templates.
- **Decoupling in space and time**: producers and consumers do not know each other and need not be online at the same time.
- **Reliable work distribution**: exclusive \`take\` with lease and transaction; crashes release the work again.
- **Durable and traceable**: persistent state, revisions, snapshots and change streams.
- **From a single process to a cluster**: local, over socket/RPC, and as a federated cluster with identity, enrollment and admin surfaces.

## What Is phi-spaces And Why Was It Built? {#what-is-phi-spaces}

\`phi-spaces\` solves four fundamental problems in building robust, long-running systems and autonomous AI agent fleets:

1. **Fault-Tolerant Work Handoff (Leased Reservations)**: A server, UI client, or agent does not call a worker directly; it writes a task entry (\`type: "ChatTask"\` or similar) into the space. Any worker can then **reserve** that task exclusively (\`take\`). If the worker crashes before finishing, the expired lease automatically returns the task — provided the task's own lease remains valid and its store is available.
2. **Temporal Decoupling**: Producers and consumers do not need to be online at the same time. A client can schedule a \`ScheduledJob\` in the middle of the night and go offline; with a persistent backend and sufficient task lease, the job survives; the application checks when it is due after TimerLock expiry.
3. **Unified State With Live Events**: Rather than fragmented caches, every space provides atomic transactions (\`createTransaction\`, \`commit\`, \`abort\`), consistent point-in-time snapshots (\`readPage\` with \`rev\`), incremental update streams (\`changes(afterRev)\`), and durable event mailboxes (\`events\` + prefix \`ack\`).
4. **Incremental Distribution**: Local and remote clients share SpaceLike. Federation adds routing and its own request bindings; real encryption, provisioning and failure safety need separate configuration and acceptance.

## Concept And System Model {#concept-model}

### Decoupling In Space And Time {#decoupling}

In \`phi-spaces\`, producers and consumers do not need to know each other or be active at the same time:

- **Write (\`space.write\`)**: A participant places an entry \`{ type: string, types?: string[], fields: Record<string, Json> }\` with a bounded lifetime (**lease**) into the space.
- **Read (\`space.read\` / \`readIfExists\` / \`readAll\` / \`readPage\`)**: A participant queries a matching visible entry using a **template** \`{ type?, fields?, id? }\` without removing it. Missing or \`null\` fields in the template act as **wildcards**.
- **Exclusive Take (\`space.take\`)**: A worker removes a matching entry exclusively. When executed under a **transaction (\`txn\`)**, the entry remains reserved until the worker writes its results and calls \`commit(txn)\`. If the worker crashes or the transaction lease expires, the entry returns if its own Entry lease remains valid.
- **Wait For Future Data (\`space.wait\`)**: Instead of polling blindly, a participant registers a durable \`Waiter\` against a template. As soon as a matching entry is committed, \`phi-spaces\` wakes the waiter or delivers an event.

### What Can phi-spaces Do? (Core Capabilities) {#capabilities}

- **Immutable Entries & Wildcard Templates**: Typed JSON objects with subtype registration (\`types\`) and exact \`type\`/field matching.
- **Atomic Space Transactions**: \`take\` + multiple \`write\` calls + optional request claims finalized by one business \`commit(txn)\` (earlier PhiSpaces calls are separate storage commits). On \`abort\` or timeout everything rolls back atomically.
- **Server-Side Result Guarantees (\`CompletionProfiles\`)**: The space core enforces at commit time that a taken task of type \`ChatTask\` can only commit together with exactly one matching result entry \`Msg\`.
- **Idempotent Request Claims (\`RequestRef\`)**: Every mutation can carry \`{ request: { principal, generation, requestId } }\`; retries and timeouts never produce duplicate effects.
- **Leases & Automatic Reaper (\`startService\`)**: Entries, presence records, and \`TimerLock\` locks expire automatically after a configured duration.
- **Snapshot And Incremental Sync (\`readPage\` + \`changes\`)**: Point-in-time snapshots plus order-preserving, revisioned update streams (\`rev\`) and prefix-acknowledged durable mailboxes.
- **Space Lifecycle, Workers, Runs & Deployments**: Idempotent space management (\`archive\`/\`reactivate\`/\`delete\`), worker scaling (\`WorkerSupervisor\`), multi-host run orchestration (\`RunGate\`), and declarative bootstrap (\`DeploymentController\`) — from a single host up to a cluster.
- **Overlay Gate, Enrollment & Federated Routing**: NetBird/WireGuard peer identity + Ed25519 challenge, QR/token enrollment, 60-second grants, own-key rotation, and deterministic HRW sharding of entries across multiple hosts.

### Unified SpaceLike Contract {#spacelike-contract}

PhiSpaces and RemoteSpace implement the SpaceLike base contract. FederatedSpace has a separate API with FederationRequest and Member transaction binding; business concepts transfer but call signatures are not drop-in replacements. See [topologies and API boundaries](help.topic.topology_and_readiness#api).

## Terms And Identities {#terms-and-identities}

- **Entry**: An immutable JSON record \`{ type: string, types?: string[], fields: Record<string, Json> }\`. There is no in-place update; state transitions happen via \`take\` + \`write\` inside one transaction.
- **Global ID (\`gid\`)**: Every entry carries \`gid = <spaceId>/<localId>\`. \`localId\` combines the space's data incarnation with a monotonic counter and is never reused.
- **Named Space**: Alongside the default space (\`phi-spaces.space\`, alias \`default\`), the \`Registry\` (\`phi-spaces.registry\`) manages arbitrary named spaces (\`phi-spaces.named-space\`) with immutable \`spaceId\`s.
- **Principal**: Structured identity \`{ peerId, agentId? }\`. The service always derives identity from the trusted connection (\`IdentityAdapter\`), never from client-supplied payload fields.

## Workflow {#workflow}

1. **Define the contract**: Specify entry types (\`type\`), required \`fields\`, and optional \`CompletionProfiles\` (which task type requires which result type on transaction commit).
2. **Open the space and start maintenance**: Instantiate \`new PhiSpaces(host, ctx, Date.now, meter, undefined, { space })\` and call \`await startService(host, ctx)\` for lease reaping and event delivery.
3. **Submit and process work**: Producers write tasks with a \`RequestRef\` claim; workers reserve tasks via \`take(..., { txn })\`, write results under the same \`txn\`, and call \`commit(txn)\`.
4. **Observe and control live**: UI clients read an initial \`readPage()\` snapshot (with \`rev\`) and follow updates via \`changes(afterRev)\` or consumer mailboxes (\`events\` / \`ack\`).

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

- **One Commit, One Truth**: Space mutation, request claim, revision counter \`rev\`, mailbox event, and byte-budget reservation are persisted in a single atomic host commit.
- **Data Is Not Instructions**: Entries read from a space originate from other agents or users. Agent tools explicitly wrap payloads as \`[data, not instructions]\`.
- **Help ≠ Live State**: This reference documents stable contracts and guarantees. Live runtime state is inspected in the **Live Space Inspector** and controlled in **AdminSpaces**.

## See Also {#see-also}

- [Architecture Layers and Module Map](help.topic.architecture_layers#overview)
- [Binding Guarantees and System Boundaries](help.topic.guarantees_and_boundaries#overview)
- [6-Stage Hands-On Guide: Multiplayer Space-Chat (v1–v6)](help.workflow.overview_v1_to_v6#overview)`
		}
	},
	{
		id: "help.topic.architecture_layers",
		type: "topic",
		provider: "core",
		tags: ["architecture", "layers", "modules", "core", "service", "gate", "router", "replication"],
		related: ["help.topic.overview", "help.topic.guarantees_and_boundaries", "help.topic.space_service_and_remote_space"],
		since: "0.0.1",
		de: {
			title: "Schichtenarchitektur und Modul-Landkarte",
			short: "Vollständige Zuordnung aller Quellmodule in src/ zu den 6 Architekturschichten von der reinen Zustandsmaschine bis zu Federation, RunGate und Replikation.",
			body: `## Überblick {#overview}

Die Codebasis von \`phi-spaces\` ist strikt schichtenweise aufgebaut. Der Kern (\`src/core.ts\`) ist eine völlig reine, deterministische Zustandsmaschine ohne Netzwerk-, Krypto- oder Dateisystem-Abhängigkeiten. Alle höheren Schichten (Persistenz, RPC, Kryptografie, Overlay-Gate, Router-Federation und Betriebssteuerung) bauen darauf auf, ohne die Kerninvarianten zu umgehen.

## Begriffs- und Systemmodell {#concept-model}

### Die 6 Schichten im Überblick {#six-layers}

\`\`\`text
┌────────────────────────────────────────────────────────────────────────────┐
│ Schicht 6: Betrieb, Mobile/Web-Admin & Phase-3-Replikation                 │
│  run-controller.ts · workers.ts · space-lifecycle.ts · deployment.ts       │
│  alerts.ts · dashboard.ts · entry-replication.ts · primary-sync.ts         │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 5: Federation, Router & Membership (Phase 2)                       │
│  router.ts · delegation.ts · federation-policy.ts · federated-space.ts     │
│  membership.ts · capability-directory.ts · data-admin.ts · root-erasure.ts │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 4: Overlay-Gate, Schicht-A/B-Auth, Grants & Recovery (Phase 1b)    │
│  gate.ts · auth.ts · enroll.ts · grants.ts · rotation.ts · supervisor.ts   │
│  runtime.ts · boot.ts · restore.ts · recovery-register.ts                  │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 3: Lokaler Client, LLM-Agent-Tools & Netzwerkdienst                │
│  client.ts (PhiSpaces) · index.ts (Tools & Reaper) · service.ts             │
│  remote.ts (RemoteSpace) · socket.ts · pi-server.ts · meter.ts             │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 2: Dauerhafte Claims, Streams, Snapshots & Mailboxes (Phase 1)     │
│  claims.ts · stream.ts · snapshot.ts · paging.ts · mailbox.ts              │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 1: Reiner Kern & Dokumentmodell v5                                 │
│  core.ts · doc.ts · spaces.ts · canonical.ts (RFC 8785)                    │
└────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Abhängigkeitsrichtung {#dependency-direction}

- \`src/core.ts\` akzeptiert den aktuellen Dokumentzustand \`SpaceState\` und einen expliziten Zeitstempel \`now: number\`. Dadurch lassen sich Lease-Ablauf, Transaktions-Rollbacks und Uhrsprünge deterministisch ohne echte Wartezeiten testen.
- \`src/client.ts\` und \`src/service.ts\` rufen innerhalb eines \`host.commit(tx => ...)\` die reinen Funktionen aus \`core.ts\`, \`claims.ts\`, \`stream.ts\` und \`mailbox.ts\` auf.
- \`src/gate.ts\`, \`src/auth.ts\` und \`src/grants.ts\` liegen vor \`SpaceService\` und liefern den geprüften \`Connection\`-Kontext.

## Technische Referenz {#technical-reference}

| Schicht | Zentrale Dateien | Öffentliche Haupttypen & Exporte |
|---|---|---|
| **1. Core & Docs** | \`src/core.ts\`, \`src/doc.ts\`, \`src/spaces.ts\` | \`core\`, \`Space\`, \`NamedSpace\`, \`Registry\`, \`createSpace\`, \`listSpaces\`, \`DEFAULT_LIMITS\` |
| **2. Claims & Streams** | \`src/claims.ts\`, \`src/stream.ts\`, \`src/mailbox.ts\` | \`RequestRef\`, \`ClaimView\`, \`argHash\`, \`MailboxPage\`, \`principalId\` |
| **3. Client & RPC** | \`src/client.ts\`, \`src/index.ts\`, \`src/service.ts\`, \`src/remote.ts\`, \`src/socket.ts\` | \`PhiSpaces\`, \`spaces\`, \`startService\`, \`SpaceService\`, \`RemoteSpace\`, \`serveSpace\`, \`socketTransport\` |
| **4. Gate & Recovery** | \`src/gate.ts\`, \`src/auth.ts\`, \`src/enroll.ts\`, \`src/grants.ts\`, \`src/runtime.ts\`, \`src/boot.ts\`, \`src/restore.ts\` | \`startGate\`, \`ProvingService\`, \`EnrollmentService\`, \`GrantAuthority\`, \`GrantVerifier\`, \`startFederationHost\`, \`installBootGuard\`, \`RecoveryController\` |
| **5. Federation** | \`src/router.ts\`, \`src/delegation.ts\`, \`src/federation-policy.ts\`, \`src/federated-space.ts\`, \`src/membership.ts\` | \`RouterController\`, \`createFederationController\`, \`FederatedSpace\`, \`MembershipController\`, \`DistributedPrincipalErasure\` |
| **6. Operations & Sync** | \`src/run-controller.ts\`, \`src/workers.ts\`, \`src/space-lifecycle.ts\`, \`src/deployment.ts\`, \`src/alerts.ts\`, \`src/entry-replication.ts\` | \`RunController\`, \`WorkerSupervisor\`, \`SpaceLifecycle\`, \`DeploymentController\`, \`collectAlerts\`, \`EntryReplicationController\` |

## Siehe auch {#see-also}

- [phi-spaces Systemüberblick](help.topic.overview#overview)
- [Verbindliche Garantien und Systemgrenzen](help.topic.guarantees_and_boundaries#overview)`
		},
		en: {
			title: "Architecture Layers and Module Map",
			short: "Complete mapping of all source modules in src/ across the 6 architecture layers, from the pure state machine to federation, RunGate, and replication.",
			body: `## Overview {#overview}

The \`phi-spaces\` codebase is strictly layered. Its core (\`src/core.ts\`) is a pure, deterministic state machine with no network, cryptography, or filesystem dependencies. All higher layers (persistence, RPC, cryptography, overlay gate, router federation, and operations control) build on top of it without bypassing core invariants.

## Concept And System Model {#concept-model}

### The 6 Layers At A Glance {#six-layers}

\`\`\`text
┌────────────────────────────────────────────────────────────────────────────┐
│ Layer 6: Operations, Mobile/Web Admin & Phase 3 Replication                │
│  run-controller.ts · workers.ts · space-lifecycle.ts · deployment.ts       │
│  alerts.ts · dashboard.ts · entry-replication.ts · primary-sync.ts         │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 5: Federation, Router & Membership (Phase 2)                         │
│  router.ts · delegation.ts · federation-policy.ts · federated-space.ts     │
│  membership.ts · capability-directory.ts · data-admin.ts · root-erasure.ts │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 4: Overlay Gate, Layer A/B Auth, Grants & Recovery (Phase 1b)        │
│  gate.ts · auth.ts · enroll.ts · grants.ts · rotation.ts · supervisor.ts   │
│  runtime.ts · boot.ts · restore.ts · recovery-register.ts                  │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Local Client, LLM Agent Tools & Network Service                   │
│  client.ts (PhiSpaces) · index.ts (Tools & Reaper) · service.ts             │
│  remote.ts (RemoteSpace) · socket.ts · pi-server.ts · meter.ts             │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Durable Claims, Streams, Snapshots & Mailboxes (Phase 1)          │
│  claims.ts · stream.ts · snapshot.ts · paging.ts · mailbox.ts              │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Pure Core & Document Model v5                                     │
│  core.ts · doc.ts · spaces.ts · canonical.ts (RFC 8785)                    │
└────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Dependency Direction {#dependency-direction}

- \`src/core.ts\` accepts the mutable document draft \`SpaceState\` and an explicit timestamp \`now: number\`. Lease expiration, transaction rollbacks, and clock jumps can therefore be tested deterministically without real wall-clock waits.
- \`src/client.ts\` and \`src/service.ts\` invoke pure functions from \`core.ts\`, \`claims.ts\`, \`stream.ts\`, and \`mailbox.ts\` inside a single \`host.commit(tx => ...)\`.
- \`src/gate.ts\`, \`src/auth.ts\`, and \`src/grants.ts\` sit in front of \`SpaceService\` and supply the verified \`Connection\` context.

## Technical Reference {#technical-reference}

| Layer | Key Files | Public Types & Exports |
|---|---|---|
| **1. Core & Docs** | \`src/core.ts\`, \`src/doc.ts\`, \`src/spaces.ts\` | \`core\`, \`Space\`, \`NamedSpace\`, \`Registry\`, \`createSpace\`, \`listSpaces\`, \`DEFAULT_LIMITS\` |
| **2. Claims & Streams** | \`src/claims.ts\`, \`src/stream.ts\`, \`src/mailbox.ts\` | \`RequestRef\`, \`ClaimView\`, \`argHash\`, \`MailboxPage\`, \`principalId\` |
| **3. Client & RPC** | \`src/client.ts\`, \`src/index.ts\`, \`src/service.ts\`, \`src/remote.ts\`, \`src/socket.ts\` | \`PhiSpaces\`, \`spaces\`, \`startService\`, \`SpaceService\`, \`RemoteSpace\`, \`serveSpace\`, \`socketTransport\` |
| **4. Gate & Recovery** | \`src/gate.ts\`, \`src/auth.ts\`, \`src/enroll.ts\`, \`src/grants.ts\`, \`src/runtime.ts\`, \`src/boot.ts\`, \`src/restore.ts\` | \`startGate\`, \`ProvingService\`, \`EnrollmentService\`, \`GrantAuthority\`, \`GrantVerifier\`, \`startFederationHost\`, \`installBootGuard\`, \`RecoveryController\` |
| **5. Federation** | \`src/router.ts\`, \`src/delegation.ts\`, \`src/federation-policy.ts\`, \`src/federated-space.ts\`, \`src/membership.ts\` | \`RouterController\`, \`createFederationController\`, \`FederatedSpace\`, \`MembershipController\`, \`DistributedPrincipalErasure\` |
| **6. Operations & Sync** | \`src/run-controller.ts\`, \`src/workers.ts\`, \`src/space-lifecycle.ts\`, \`src/deployment.ts\`, \`src/alerts.ts\`, \`src/entry-replication.ts\` | \`RunController\`, \`WorkerSupervisor\`, \`SpaceLifecycle\`, \`DeploymentController\`, \`collectAlerts\`, \`EntryReplicationController\` |

## See Also {#see-also}

- [phi-spaces System Overview](help.topic.overview#overview)
- [Binding Guarantees and System Boundaries](help.topic.guarantees_and_boundaries#overview)`
		}
	},
	{
		id: "help.topic.guarantees_and_boundaries",
		type: "topic",
		provider: "core",
		tags: ["guarantees", "boundaries", "idempotency", "consistency", "limits", "restore", "epochs"],
		related: ["help.topic.overview", "help.topic.request_claims_and_generations", "help.topic.gate_auth_grants_and_recovery"],
		since: "0.0.1",
		de: {
			title: "Verbindliche Garantien und Systemgrenzen",
			short: "Was phi-spaces bei lokalen Commits, Retries, Transaktionen, Restores und in der Federation verbindlich garantiert – und was bewusst ausgeschlossen ist.",
			body: `## Überblick {#overview}

Ein verlässliches verteiltes System zeichnet sich dadurch aus, dass seine Garantien und seine Grenzen explizit benannt und durch Tests auf persistentem Speicher (JSONL und SQLite) nachgewiesen sind. Dieser Artikel fasst den aktuellen Ist-Stand (\`docs/implementierungsstand.md\`) und den Vertragsrahmen (\`docs/federation-plan-v3.md\`) zusammen.

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

### Garantienmatrix {#guarantee-matrix}

| Ebene | Verbindlicher Vertrag in \`phi-spaces\` | Was ausdrücklich NICHT daraus folgt |
|---|---|---|
| **Lokaler Commit** | Space-Mutation, RPC-Claim, Revisionsnummer \`rev\` und Mailbox-Event werden unteilbar zusammen gespeichert. | Keine externe Exactly-once-Wirkung für HTTP-Calls, E-Mails oder LLM-Tokenkosten außerhalb des Spaces. |
| **Idempotenter Retry** | Gleiches \`{ principal, generation, requestId }\` mit identischem RFC-8785-Argument-Hash liefert auch nach Prozessneustart dasselbe gespeicherte Ergebnis ohne zweite Mutation. | Nach Ablauf der Aufbewahrungsfrist (Standard 24 h) liefert ein Retry \`ResultExpired\` ohne erneute Ausführung. |
| **Take unter Txn** | Höchstens eine aktive Reservierung je Entry; \`abort\` oder Lease-Ablauf gibt den Entry wieder frei. | Keine globale FIFO-Auswahlreihenfolge über wartende Konsumenten hinweg. |
| **CompletionProfile** | Ein Take-Txn-Commit wird serverseitig mit \`CompletionViolation\` abgewiesen, wenn Ergebnistyp, korrelierende Felder oder Anzahl nicht stimmen. | Keine inhaltliche Qualitätsprüfung der berechneten Nutzdaten durch den Space-Kern. |
| **Data-Restore (5.2.2)** | Erhöht die Dateninkarnation; alte Generationen scheitern mit \`IncarnationChanged\`; restaurierte exklusive Tasks sind als \`restoredUnverified\` bis \`releaseRestored\` gegen \`take\` gesperrt. | Ein Restore aus einem asynchronen Backup ist **keine** verlustfreie Promotion. |
| **Operating Limits (Gate 4)** | Frame max. 256 KiB, Commit-Batch max. 192 KiB, Entry max. 64 KiB, max. 32 Verbindungen je Peer / 64 je Listener, Peer-Erkennung 5 s, Grant max. 60 s. | Keine unbegrenzten Batch-Transaktionen; große Vorbereitungen werden in Teilcommits aufgeteilt. |

### Die drei getrennten Epochenzähler {#three-epochs}

In \`phi-spaces\` ist der Begriff „Epoche“ ohne Präfix unzulässig. Es existieren zwei numerische Zähler und eine strikt getrennte opake Mailbox-Identität:

1. **\`primaryEpoch\`**: Gilt für einen logischen Space bei Replikation oder Data-Restore (+1 bei Data-Restore, Promotion oder Single-Umschaltung; beginnt nach Control-Restore unter neuer \`authorityId\` bei 1).
2. **\`routerEpoch\`**: Gilt für \`RouterLease\`-Ausstellungen einer Federation (+1 bei Router-Neustart/-Wechsel).
3. **\`mailboxEpoch\`**: Opake String-Identität einer Consumer-Mailbox. Bei Reset ändert sich der Token; auf Gleichheit prüfen, nicht numerisch inkrementieren oder ordnen.

## Fehler und Diagnose {#failures-and-diagnostics}

- **\`OutcomeUnknown\`**: Tritt auf, wenn die Client-Wartezeit (\`maxClientWaitMs\`) abläuft oder die Verbindung vor Empfang der Antwort abreißt. **Wichtig:** \`OutcomeUnknown\` ist kein Fehlerbeweis! Der Client muss mit derselben \`requestId\` über \`pollOperation\` nachfragen.
- **\`RequestConflict\`**: Dieselbe \`requestId\` wurde mit veränderten fachlichen Argumenten erneut gesendet.
- **\`ResourceExhausted\`**: Eine Transaktionserweiterung würde das Commit-/Abort-Bytebudget (\`192 KiB\`) oder die Dokumentgrenze überschreiten; die bisherige Transaktion bleibt abbrechbar bzw. abschließbar.

## Siehe auch {#see-also}

- [Request-Claims, Generationen und Idempotenz](help.topic.request_claims_and_generations#overview)
- [Overlay-Gate, Authentisierung, Grants und Recovery](help.topic.gate_auth_grants_and_recovery#overview)`
		},
		en: {
			title: "Binding Guarantees and System Boundaries",
			short: "What phi-spaces strictly guarantees for local commits, retries, transactions, restores, and federation—and what is intentionally out of scope.",
			body: `## Overview {#overview}

A reliable distributed system defines both its guarantees and its boundaries explicitly and proves them on persistent storage (JSONL and SQLite). This article summarizes the current implementation state (\`docs/implementierungsstand.md\`) and contract (\`docs/federation-plan-v3.md\`).

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

### Guarantee Matrix {#guarantee-matrix}

| Layer | Binding Contract in \`phi-spaces\` | What Does Explicitly NOT Follow |
|---|---|---|
| **Local Commit** | Space mutation, RPC claim, revision \`rev\`, and mailbox event are persisted atomically together. | No external exactly-once guarantee for HTTP calls, emails, or LLM token costs outside the space. |
| **Idempotent Retry** | Identical \`{ principal, generation, requestId }\` with matching RFC-8785 argument hash returns the stored result across process restarts without repeating the mutation. | After retention expiry (default 24 h), a retry returns \`ResultExpired\` without re-executing. |
| **Take under Txn** | At most one active reservation per entry; \`abort\` or lease expiry returns the entry to the space. | No global FIFO ordering across competing consumers. |
| **CompletionProfile** | A take-transaction commit is rejected server-side with \`CompletionViolation\` unless result type, matching fields, and count match. | No semantic validation of payload quality by the space core. |
| **Data Restore (5.2.2)** | Increments data incarnation; old generations fail with \`IncarnationChanged\`; restored exclusive tasks are quarantined as \`restoredUnverified\` until \`releaseRestored\`. | Restoring from an asynchronous backup is **not** a lossless promotion. |
| **Operating Limits (Gate 4)** | Frame max 256 KiB, commit batch max 192 KiB, entry max 64 KiB, max 32 connections per peer / 64 per listener, peer identification 5 s, grant max 60 s. | No unbounded batch transactions; large preparations split into idempotent sub-commits. |

### The Three Distinct Epoch Counters {#three-epochs}

Using the word "epoch" without a qualifier is invalid in \`phi-spaces\`. Three independent monotonic counters exist:

1. **\`primaryEpoch\`**: Scoped to a logical space for replication or data restore (+1 on data restore, promotion, or single-mode switch; resets to 1 under a new \`authorityId\` after control restore).
2. **\`routerEpoch\`**: Scoped to \`RouterLease\` issuance in a federation (+1 on router restart or failover).
3. **\`mailboxEpoch\`**: An opaque consumer-mailbox string identity. Reset changes the token; compare equality, never increment or order it numerically.

## Failures And Diagnostics {#failures-and-diagnostics}

- **\`OutcomeUnknown\`**: Raised when \`maxClientWaitMs\` elapses or the transport drops before a reply arrives. **Critical:** \`OutcomeUnknown\` does not mean the operation failed! The client must poll with the same \`requestId\` via \`pollOperation\`.
- **\`RequestConflict\`**: The same \`requestId\` was reused with different arguments.
- **\`ResourceExhausted\`**: Extending a transaction would exceed the commit/abort byte budget (\`192 KiB\`) or document quota; prior transaction work remains committable or abortable.

## See Also {#see-also}

- [Request Claims, Generations, and Idempotency](help.topic.request_claims_and_generations#overview)
- [Overlay Gate, Authentication, Grants, and Recovery](help.topic.gate_auth_grants_and_recovery#overview)`
		}
	},
	{
		id: "help.topic.entries_and_templates",
		type: "topic",
		provider: "core",
		tags: ["entries", "templates", "wildcards", "subtypes", "gid", "matching"],
		related: ["help.topic.leases_and_transactions", "help.api.phispaces_write", "help.api.phispaces_read"],
		since: "0.0.1",
		de: {
			title: "Entries, Subtypen und Template-Matching",
			short: "Aufbau von Entries ({type, types?, fields}), globale Identitäten (gid), hierarchische Subtypen und exakte Wildcard-Regeln beim Template-Matching.",
			body: `## Überblick {#overview}

Alle Nutz- und Koordinationsdaten in \`phi-spaces\` werden als **Entries** abgelegt und über **Templates** abgefragt. Das Matching arbeitet über strukturelle Typprüfung und tiefe JSON-Gleichheit auf oberster Feldebene.

## Begriffs- und Systemmodell {#concept-model}

### Entry-Aufbau und Supertypen {#entry-structure}

\`\`\`ts
type EntryDraft = {
  type: string;
  types?: string[];
  fields: Record<string, Json>;
};
\`\`\`

- \`type\` ist der primäre Typname (z.B. \`"ChatTask"\`).
- \`types\` ist eine optionale Liste mit dem Haupttyp und seinen Supertypen (z.B. \`["ChatTask", "Task", "Auditable"]\`). Ein Template mit \`type: "Task"\` findet auch jeden Entry, dessen \`types\`-Array \`"Task"\` enthält.
- Ein gespeicherter \`EntryView\` enthält zusätzlich \`id\` (lokale ID \`e<incarnation>-<n>\`), \`gid\` (\`<spaceId>/<localId>\`), \`owner\`; \`expires\` steht auf der zurückgegebenen \`Lease\`.

### Template-Matching und Wildcards {#template-matching}

\`\`\`ts
type Template = {
  type?: string | null;
  fields?: Record<string, Json>;
  id?: string | null;
} | null;
\`\`\`

- \`null\` oder \`{}\` als Template matcht **jeden** sichtbaren Entry.
- Ist \`template.type\` gesetzt, muss \`entry.types\` diesen Typ enthalten.
- Ist \`template.id\` gesetzt, muss \`entry.id\` exakt übereinstimmen.
- Für jedes Feld \`k\` in \`template.fields\`:
  - Ist \`template.fields[k] === null\` oder \`undefined\`, wirkt das Feld als **Wildcard** (jeder Wert oder auch ein fehlendes Feld im Entry matcht).
  - Andernfalls muss \`entry.fields[k]\` per tiefer kanonischer JSON-Gleichheit mit \`template.fields[k]\` übereinstimmen.
  - **Konsequenz**: Da \`null\` im Template als Wildcard reserviert ist, kann nicht gezielt nach einem gespeicherten JSON-\`null\`-Feldwert gefiltert werden; verwende stattdessen explizite Statusstrings wie \`"none"\` oder \`"root"\`.

## Beispiele {#examples}

\`\`\`ts
// Schreibt eine Chat-Nachricht im Thread "main"
await space.write({
  type: "Msg",
  types: ["Msg", "TimelineItem"],
  fields: { threadId: "main", seq: 1, author: "alice", text: "Hallo Space!" }
});

// Findet alle Nachrichten im Thread "main", unabhängig von seq oder author
const msg = await space.read({
  type: "Msg",
  fields: { threadId: "main", author: null } // author: null ist ein Wildcard
}, 0);
\`\`\`

## Siehe auch {#see-also}

- [Leases, Transaktionen und Sichtbarkeit](help.topic.leases_and_transactions#overview)
- [write – Entry schreiben](help.api.phispaces_write)`
		},
		en: {
			title: "Entries, Subtypes, and Template Matching",
			short: "Structure of entries ({type, types?, fields}), global identities (gid), hierarchical subtypes, and exact wildcard rules during template matching.",
			body: `## Overview {#overview}

All application and coordination state in \`phi-spaces\` is stored as **entries** and queried using **templates**. Matching combines structural type checks with deep JSON equality across top-level fields.

## Concept And System Model {#concept-model}

### Entry Shape And Supertypes {#entry-structure}

\`\`\`ts
type EntryDraft = {
  type: string;
  types?: string[];
  fields: Record<string, Json>;
};
\`\`\`

- \`type\` is the primary type name (e.g. \`"ChatTask"\`).
- \`types\` is an optional array containing the primary type and any supertypes (e.g. \`["ChatTask", "Task", "Auditable"]\`). A template asking for \`type: "Task"\` matches any entry whose \`types\` array includes \`"Task"\`.
- A returned \`EntryView\` adds \`id\` (local ID \`e<incarnation>-<n>\`), \`gid\` (\`<spaceId>/<localId>\`), \`owner\`; \`expires\` is returned on the \`Lease\`.

### Template Matching And Wildcards {#template-matching}

\`\`\`ts
type Template = {
  type?: string | null;
  fields?: Record<string, Json>;
  id?: string | null;
} | null;
\`\`\`

- Passing \`null\` or \`{}\` matches **every** visible entry.
- If \`template.type\` is specified, \`entry.types\` must include that type.
- If \`template.id\` is specified, \`entry.id\` must match exactly.
- For each key \`k\` in \`template.fields\`:
  - If \`template.fields[k] === null\` or \`undefined\`, it acts as a **wildcard** (matches any value or even a missing key).
  - Otherwise \`entry.fields[k]\` must equal \`template.fields[k]\` under deep canonical JSON equality.
  - **Consequence**: Because \`null\` in a template is a wildcard, you cannot filter specifically for a stored JSON \`null\`; use explicit string states such as \`"none"\` or \`"root"\` instead.

## Examples {#examples}

\`\`\`ts
// Write a chat message in thread "main"
await space.write({
  type: "Msg",
  types: ["Msg", "TimelineItem"],
  fields: { threadId: "main", seq: 1, author: "alice", text: "Hello Space!" }
});

// Match any message in thread "main" regardless of seq or author
const msg = await space.read({
  type: "Msg",
  fields: { threadId: "main", author: null } // author: null is a wildcard
}, 0);
\`\`\`

## See Also {#see-also}

- [Leases, Transactions, and Visibility](help.topic.leases_and_transactions#overview)
- [write – Write an Entry](help.api.phispaces_write)`
		}
	},
	{
		id: "help.topic.leases_and_transactions",
		type: "topic",
		provider: "core",
		tags: ["leases", "transactions", "txn", "visibility", "locks", "ifexists", "renew", "cancel"],
		related: ["help.topic.entries_and_templates", "help.topic.completion_profiles_and_limits", "help.api.phispaces_txn"],
		since: "0.0.1",
		de: {
			title: "Leases, Transaktionen und Sichtbarkeit",
			short: "Wie Leases selbstheilende Zustände ermöglichen und wie Transaktionen (createTransaction, commit, abort) Writes und Takes atomar isolieren.",
			body: `## Überblick {#overview}

In verteilten Systemen stürzen Prozesse ab und Netzwerkverbindungen brechen ab. \`phi-spaces\` löst dieses Problem durch zwei komplementäre Mechanismen: **Leases** (zeitlich begrenzte Lebensdauer für Entries, Transaktionen, Waiter und Abos) und **Space-Transaktionen** (atomare Gruppierung von \`take\`-Reservierungen und \`write\`-Entwürfen).

## Begriffs- und Systemmodell {#concept-model}

### Leases und Selbstheilung {#leases-self-healing}

Jede Ressource im Space besitzt eine Ablaufzeit \`expires\` (in Millisekunden seit Epoch oder \`FOREVER\`):

- \`ANY\` (\`-1\`): Überlässt die Standarddauer dem Space (Standard: 1 Stunde).
- \`FOREVER\`: Unbefristeter Entry (z.B. kommittierte Chat-Nachrichten \`Msg\` oder \`Thread\`).
- Endliche Dauer (z.B. \`30_000\` ms): Ideal für Teilnehmer-Präsenz (\`Presence\`) oder verzögerte Sperren (\`TimerLock\`).
- Mit \`space.renew(leaseId, ms)\` verlängert der Besitzer die Lease; mit \`space.cancel(leaseId)\` beendet er sie sofort.

### Transaktions-Isolation und Sichtbarkeit {#transaction-visibility}

Eine Space-Transaktion wird mit \`const txn = await space.createTransaction(leaseMs)\` geöffnet:

1. **\`write(entry, txn.id)\`**: Der neue Entry ist bis zum \`commit(txn.id)\` **nur innerhalb derselben Transaktion \`txn.id\` sichtbar**. Für alle anderen Teilnehmer existiert er noch nicht. Bei \`abort(txn.id)\` wird er verworfen.
2. **\`take(template, timeout, { txn: txn.id })\`**: Der entnommene Entry wird **reserviert** (für alle anderen unsichtbar gesperrt). Erst \`commit(txn.id)\` entfernt ihn endgültig. Bei \`abort(txn.id)\` oder wenn die Transaktions-Lease abläuft, wird die Reservierung aufgehoben und der Entry ist sofort wieder für andere Worker verfügbar!
3. **\`read\` vs. \`readIfExists\` / \`take\` vs. \`takeIfExists\`**:
   - \`read\` und \`take\` warten bis \`timeout\`, falls noch kein passender Entry existiert.
   - \`readIfExists\` und \`takeIfExists\` kehren sofort mit \`null\` zurück, wenn kein passender Entry im Space liegt – sie warten **nur** dann bis \`timeout\`, wenn ein passender Entry zwar existiert, aber gerade durch eine fremde Transaktion gesperrt ist!

## Beispiele {#examples}

\`\`\`ts
// Transaktionale Bearbeitung eines ChatTasks im Multiplayer Space-Chat:
const txn = await space.createTransaction(30_000);
try {
  const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
  if (!task) {
    await space.abort(txn.id);
    return;
  }
  await space.write({
    type: "Msg",
    fields: {
      msgId: "msg-2",
      threadId: "main",
      seq: 2,
      author: "pi-agent",
      role: "assistant",
      text: "Antwort auf: " + task.fields.prompt,
      taskId: task.fields.taskId,
      createdAt: Date.now()
    }
  }, txn.id, FOREVER);
  await space.commit(txn.id); // Atomar: ChatTask verschwindet, Msg wird sichtbar!
} catch (err) {
  await space.abort(txn.id); // ChatTask kehrt sofort in den Space zurück
  throw err;
}
\`\`\`

## Siehe auch {#see-also}

- [CompletionProfiles und Ressourcen-Limits](help.topic.completion_profiles_and_limits#overview)
- [Transaktionen – createTransaction, commit & abort](help.api.phispaces_txn)`
		},
		en: {
			title: "Leases, Transactions, and Visibility",
			short: "How leases enable self-healing state and how transactions (createTransaction, commit, abort) isolate writes and takes atomically.",
			body: `## Overview {#overview}

In distributed systems, processes crash and network links drop. \`phi-spaces\` addresses this with two complementary mechanisms: **leases** (bounded lifetimes for entries, transactions, waiters, and subscriptions) and **space transactions** (atomic grouping of \`take\` reservations and \`write\` drafts).

## Concept And System Model {#concept-model}

### Leases And Self-Healing {#leases-self-healing}

Every resource in a space carries an expiration timestamp \`expires\` (milliseconds since epoch, or \`FOREVER\`):

- \`ANY\` (\`-1\`): Uses the space's default duration (default: 1 hour).
- \`FOREVER\`: Non-expiring entry (e.g. committed chat messages \`Msg\` or \`Thread\`).
- Finite duration (e.g. \`30_000\` ms): Ideal for participant presence (\`Presence\`) or delayed locks (\`TimerLock\`).
- \`space.renew(leaseId, ms)\` extends the lease; \`space.cancel(leaseId)\` terminates it immediately.

### Transaction Isolation And Visibility {#transaction-visibility}

A space transaction is opened with \`const txn = await space.createTransaction(leaseMs)\`:

1. **\`write(entry, txn.id)\`**: The new entry is **visible only inside \`txn.id\`** until \`commit(txn.id)\`. To all other participants it does not exist yet. On \`abort(txn.id)\` it is discarded.
2. **\`take(template, timeout, { txn: txn.id })\`**: The matching entry is **reserved** (locked and invisible to others). Only \`commit(txn.id)\` deletes it permanently. On \`abort(txn.id)\` or transaction lease expiry, the reservation is released and the entry becomes available to other workers again!
3. **\`read\` vs. \`readIfExists\` / \`take\` vs. \`takeIfExists\`**:
   - \`read\` and \`take\` wait up to \`timeout\` if no matching entry exists yet.
   - \`readIfExists\` and \`takeIfExists\` return \`null\` immediately if no matching entry is present—they wait up to \`timeout\` **only** while matching entries are locked by another transaction!

## Examples {#examples}

\`\`\`ts
// Transactional processing of a ChatTask in the Multiplayer Space-Chat:
const txn = await space.createTransaction(30_000);
try {
  const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
  if (!task) {
    await space.abort(txn.id);
    return;
  }
  await space.write({
    type: "Msg",
    fields: {
      msgId: "msg-2",
      threadId: "main",
      seq: 2,
      author: "pi-agent",
      role: "assistant",
      text: "Reply to: " + task.fields.prompt,
      taskId: task.fields.taskId,
      createdAt: Date.now()
    }
  }, txn.id, FOREVER);
  await space.commit(txn.id); // Atomic: ChatTask is removed, Msg becomes visible!
} catch (err) {
  await space.abort(txn.id); // ChatTask immediately returns to the space
  throw err;
}
\`\`\`

## See Also {#see-also}

- [CompletionProfiles and Resource Limits](help.topic.completion_profiles_and_limits#overview)
- [Transactions – createTransaction, commit & abort](help.api.phispaces_txn)`
		}
	},
	{
		id: "help.topic.completion_profiles_and_limits",
		type: "topic",
		provider: "core",
		tags: ["completionprofile", "completionviolation", "limits", "quotas", "bytes", "budget"],
		related: ["help.topic.leases_and_transactions", "help.api.phispaces_completion_profiles"],
		since: "0.0.1",
		de: {
			title: "CompletionProfiles und Ressourcen-Limits",
			short: "Serverseitige Ergebnisprüfung beim Commit von Take-Transaktionen (CompletionProfile) sowie die festen Byte- und Owner-Quoten (DEFAULT_LIMITS).",
			body: `## Überblick {#overview}

Damit ein fehlerhafter Worker oder ein halluzinierender KI-Agent niemals eine Aufgabe aus dem Space entnehmen und die Transaktion ohne gültiges Ergebnis committen kann, erzwingt \`phi-spaces\` serverseitige **\`CompletionProfiles\`** sowie strikte **Byte- und Objekt-Budgets (\`DEFAULT_LIMITS\`)**.

## Begriffs- und Systemmodell {#concept-model}

### Serverseitige Ergebnisverträge (CompletionProfile) {#completion-profiles}

Ein \`CompletionProfile\` legt fest, welche Ergebnis-Entries beim \`commit(txn)\` für jeden in dieser Transaktion genommenen Task-Entry geschrieben worden sein müssen:

\`\`\`ts
await space.setCompletionProfiles([
  {
    taskType: "ChatTask",
    resultTypes: ["Msg"],
    equalFields: ["taskId", "threadId"],
    maxResultCount: 1
  },
  {
    taskType: "SearchTask",
    resultTypes: ["SearchResult"],
    equalFields: ["searchId", "parentThreadId"],
    maxResultCount: 1
  }
]);
\`\`\`

Versucht ein Worker \`commit(txn)\` aufzurufen, ohne dass für den genommenen \`ChatTask\` genau eine \`Msg\` mit identischer \`taskId\` und \`threadId\` in derselben Transaktion geschrieben wurde, wirft der Space-Kern \`CompletionViolation\`. Die Transaktion bleibt offen und kann korrigiert oder mit \`abort(txn)\` zurückgerollt werden.

### Byte-Budgets und Owner-Quoten (DEFAULT_LIMITS) {#default-limits}

Die Entry-Anzahl ist standardmäßig weder pro Space noch pro Owner begrenzt:
\`maxEntries\` und \`maxEntriesPerOwner\` verwenden \`FOREVER\` (JSON-sicherer unbegrenzter Wert).
Explizite Anzahlquoten sind mit \`setLimits\` weiterhin möglich. Die folgenden Byte-Budgets und
die Quoten für Registrierungen, Waiter und Transaktionen bleiben wirksam; unbegrenzte Anzahl
bedeutet nicht unbegrenzten Arbeitsspeicher oder unbegrenzte Dokumentgröße.

| Limit | Standardwert | Bedeutung |
|---|---|---|
| \`maxEntryBytes\` | \`64 KiB\` | Maximale Größe eines einzelnen Entry oder Handbacks |
| \`maxCommitBytes\` | \`192 KiB\` | Maximale Summe aller Delta-Bytes eines Commits (inkl. Claims & Folgearbeit) |
| \`maxFrameBytes\` | \`256 KiB\` | Maximale RPC-Framegröße am Gate/Socket |
| \`maxEventBytes\` | \`160 KiB\` | Maximale Größe eines zugestellten Events |
| \`maxSpaceBytes\` | \`64 MiB\` | Summe aller Entry-Felder in einem Space |
| \`maxClaimBytes\` | \`32 MiB\` | Speicherbudget für Request-Claims |
| \`maxOutboxBytes\` | \`8 MiB\` | Speicherbudget für Outbox / Mailboxes (max. 7 Tage TTL) |
| \`maxDocBytes\` | \`128 MiB\` | Gesamtdokumentgröße eines Spaces |

Vor **jeder** Erweiterung einer Transaktion reserviert \`core.ts\` die konservativen Kosten für **Commit und Abort**. Überschreitet ein Schritt das Budget, scheitert dieser Schritt sofort mit \`ResourceExhausted\`, sodass die bisherige Transaktion niemals beim abschließenden \`commit\` oder \`abort\` am Byte-Limit hängenbleibt.

## Siehe auch {#see-also}

- [Leases, Transaktionen und Sichtbarkeit](help.topic.leases_and_transactions#overview)
- [setCompletionProfiles & setLimits](help.api.phispaces_completion_profiles)`
		},
		en: {
			title: "CompletionProfiles and Resource Limits",
			short: "Server-side result verification when committing take transactions (CompletionProfile) and fixed byte and owner quotas (DEFAULT_LIMITS).",
			body: `## Overview {#overview}

To ensure a buggy worker or hallucinating AI agent can never take a task from the space and commit the transaction without producing a valid result, \`phi-spaces\` enforces server-side **\`CompletionProfiles\`** and strict **byte and object budgets (\`DEFAULT_LIMITS\`)**.

## Concept And System Model {#concept-model}

### Server-Side Result Contracts (CompletionProfile) {#completion-profiles}

A \`CompletionProfile\` declares which result entries must be written inside the same transaction for every taken task entry before \`commit(txn)\` succeeds:

\`\`\`ts
await space.setCompletionProfiles([
  {
    taskType: "ChatTask",
    resultTypes: ["Msg"],
    equalFields: ["taskId", "threadId"],
    maxResultCount: 1
  },
  {
    taskType: "SearchTask",
    resultTypes: ["SearchResult"],
    equalFields: ["searchId", "parentThreadId"],
    maxResultCount: 1
  }
]);
\`\`\`

If a worker calls \`commit(txn)\` without having written exactly one \`Msg\` with matching \`taskId\` and \`threadId\` for the taken \`ChatTask\`, the core throws \`CompletionViolation\`. The transaction remains open so the caller can either write the missing result or roll back via \`abort(txn)\`.

### Byte Budgets And Owner Quotas (DEFAULT_LIMITS) {#default-limits}

Entry counts have no default cap, either per space or per owner:
\`maxEntries\` and \`maxEntriesPerOwner\` use \`FOREVER\` (a JSON-safe unlimited value).
Explicit count quotas can still be set with \`setLimits\`. The byte budgets below and quotas
for subscriptions, waiters and transactions still apply; unlimited counts do not mean
unlimited memory or document size.

| Limit | Default | Meaning |
|---|---|---|
| \`maxEntryBytes\` | \`64 KiB\` | Maximum size of a single entry or handback |
| \`maxCommitBytes\` | \`192 KiB\` | Maximum encoded delta bytes of one commit (including claims & follow-up work) |
| \`maxFrameBytes\` | \`256 KiB\` | Maximum RPC wire frame size at the gate/socket |
| \`maxEventBytes\` | \`160 KiB\` | Maximum size of a delivered event |
| \`maxSpaceBytes\` | \`64 MiB\` | Total entry field bytes in a space |
| \`maxClaimBytes\` | \`32 MiB\` | Budget for stored request claims |
| \`maxOutboxBytes\` | \`8 MiB\` | Budget for outbox / mailboxes (max 7 days TTL) |
| \`maxDocBytes\` | \`128 MiB\` | Total document size of a space |

Before **every** transaction extension, \`core.ts\` reserves conservative byte budgets for **both commit and abort**. If an operation would exceed the budget, it fails immediately with \`ResourceExhausted\`, ensuring an open transaction never becomes uncommittable or unabortable due to byte limits.

## See Also {#see-also}

- [Leases, Transactions, and Visibility](help.topic.leases_and_transactions#overview)
- [setCompletionProfiles & setLimits](help.api.phispaces_completion_profiles)`
		}
	},
	{
		id: "help.topic.request_claims_and_generations",
		type: "topic",
		provider: "client",
		tags: ["claims", "requestref", "generation", "idempotency", "rfc8785", "polloperation", "resolveoperation"],
		related: ["help.topic.guarantees_and_boundaries", "help.api.phispaces_claims", "help.workflow.stage_v2_local_durable"],
		since: "0.0.1",
		de: {
			title: "Request-Claims, Generationen und Idempotenz",
			short: "Wie phi-spaces über {principal, generation, requestId} und kanonische RFC-8785-Hashes doppelte Mutationen nach Verbindungsabbruch oder Neustart verhindert.",
			body: `## Überblick {#overview}

Im Cloudflare-Blogpost zu \`pi-durable\` musste für \`conversation.create\` ein eigenes \`ConversationCommandReceipts\`-Dokument programmiert werden, damit ein WebSocket-Reconnect keine doppelten Konversationen erzeugt. In \`phi-spaces\` ist dieser Mechanismus bereits als universelle Kernfunktion **Request-Claims (\`src/claims.ts\`)** für **alle** Mutationen (\`write\`, \`take\`, \`createTransaction\`, \`commit\`, \`abort\`, \`renew\`, \`cancel\`, \`notify\`, \`wait\`) eingebaut.

## Begriffs- und Systemmodell {#concept-model}

### Aufbau einer RequestRef {#requestref-shape}

\`\`\`ts
type Principal = { peerId: string; agentId?: string };
type RequestRef = {
  principal: Principal;
  generation: string;
  requestId: string;
};
\`\`\`

1. **Generation eröffnen (\`issueGeneration\`)**: Vor der ersten Mutation ruft der Client \`const { generation } = await space.issueGeneration(principal)\` auf. Die Generation ist kryptografisch (HMAC/Signatur) an Principal, \`spaceId\`, Dateninkarnation und \`authorityId\` gebunden (Standardlaufzeit: 1 Stunde).
2. **Kanonischer Argument-Hash (\`argHash\`)**: Für jeden Aufruf berechnet \`phi-spaces\` über \`canonicalJson\` (RFC 8785) den SHA-256-Hash ausschließlich über die **fachlichen Argumente** (ohne erneuerbare Rahmenfelder wie einen frischen 60-s-Grant).
3. **Atomare Speicherung**: Der Claim \`(principal, spaceId, generation, requestId)\` und das Operationsergebnis werden im selben Commit wie die Space-Mutation gespeichert.

### Verhalten bei Wiederholung (Retry) {#retry-behavior}

- **Gleiche \`requestId\` + gleiche Argumente**: Liefert sofort das gespeicherte Ergebnis zurück, ohne die Mutation ein zweites Mal auszuführen.
- **Gleiche \`requestId\` + andere Argumente**: Wirft \`RequestConflict\`.
- **Operation noch wartend (\`pending\`)**: Ein Retry oder \`pollOperation(request)\` hängt sich an denselben laufenden Waiter an, auch wenn der ursprüngliche Client-Prozess zwischendurch neu gestartet wurde!
- **Vor-Versand-Klärung (\`resolveOperation\`)**: Der Router in Phase 2 prüft mit \`resolveOperation(request, method, argumentHash, primaryEpoch)\`, ob ein Child-Request am Member bereits ankam oder in derselben Epoche sicher wiederholt werden darf.

## Beispiele {#examples}

\`\`\`ts
const principal = { peerId: "web-user-alice" };
const { generation } = await space.issueGeneration(principal);
const request = { principal, generation, requestId: "create-thread-42" };

// Erster Aufruf (z.B. vor WebSocket-Abbruch):
const lease1 = await space.write(
  { type: "Thread", fields: { threadId: "t-42", title: "Architektur" } },
  null,
  FOREVER,
  { request }
);

// Zweiter Aufruf nach Reconnect mit derselben requestId:
const lease2 = await space.write(
  { type: "Thread", fields: { threadId: "t-42", title: "Architektur" } },
  null,
  FOREVER,
  { request }
);
// lease1.id === lease2.id -> Es wurde exakt EIN Thread-Entry erzeugt!
\`\`\`

## Siehe auch {#see-also}

- [Stufe 2 (v2-local-durable): Persistenz, RequestRef-Claims, Alarme & Subagent](help.workflow.stage_v2_local_durable#overview)
- [Request-Claims & Generationen API](help.api.phispaces_claims)`
		},
		en: {
			title: "Request Claims, Generations, and Idempotency",
			short: "How phi-spaces prevents duplicate mutations across connection drops or restarts using {principal, generation, requestId} and canonical RFC-8785 hashes.",
			body: `## Overview {#overview}

In the Cloudflare \`pi-durable\` post, preventing duplicate conversations after a WebSocket reconnect required writing a custom \`ConversationCommandReceipts\` document. In \`phi-spaces\`, this mechanism is built directly into the core as **Request Claims (\`src/claims.ts\`)** for **every** mutation (\`write\`, \`take\`, \`createTransaction\`, \`commit\`, \`abort\`, \`renew\`, \`cancel\`, \`notify\`, \`wait\`).

## Concept And System Model {#concept-model}

### RequestRef Structure {#requestref-shape}

\`\`\`ts
type Principal = { peerId: string; agentId?: string };
type RequestRef = {
  principal: Principal;
  generation: string;
  requestId: string;
};
\`\`\`

1. **Open a Generation (\`issueGeneration\`)**: Before mutating, the client calls \`const { generation } = await space.issueGeneration(principal)\`. The generation is cryptographically bound to the principal, \`spaceId\`, data incarnation, and \`authorityId\` (default lifetime: 1 hour).
2. **Canonical Argument Hash (\`argHash\`)**: For every call, \`phi-spaces\` computes an RFC-8785 canonical JSON hash over the **semantic arguments only** (excluding renewable envelope fields like a refreshed 60s grant).
3. **Atomic Persistence**: The claim \`(principal, spaceId, generation, requestId)\` and its result are committed atomically alongside the space mutation.

### Retry Semantics {#retry-behavior}

- **Same \`requestId\` + identical arguments**: Immediately returns the stored result without repeating the mutation.
- **Same \`requestId\` + different arguments**: Throws \`RequestConflict\`.
- **Operation still \`pending\`**: A retry or \`pollOperation(request)\` reattaches to the persistent waiter, even if the original caller process restarted in the meantime!
- **Admission Resolution (\`resolveOperation\`)**: In Phase 2 federation, the router uses \`resolveOperation(request, method, argumentHash, primaryEpoch)\` to verify whether a child request was admitted or can be safely retried in the same primary epoch.

## Examples {#examples}

\`\`\`ts
const principal = { peerId: "web-user-alice" };
const { generation } = await space.issueGeneration(principal);
const request = { principal, generation, requestId: "create-thread-42" };

// First call (e.g. before WebSocket drop):
const lease1 = await space.write(
  { type: "Thread", fields: { threadId: "t-42", title: "Architecture" } },
  null,
  FOREVER,
  { request }
);

// Second call after reconnect with the same requestId:
const lease2 = await space.write(
  { type: "Thread", fields: { threadId: "t-42", title: "Architecture" } },
  null,
  FOREVER,
  { request }
);
// lease1.id === lease2.id -> Exactly ONE Thread entry was created!
\`\`\`

## See Also {#see-also}

- [Stage 2 (v2-local-durable): Persistence, RequestRef Claims, Alarms & Subagent](help.workflow.stage_v2_local_durable#overview)
- [Request Claims & Generations API](help.api.phispaces_claims)`
		}
	},
	{
		id: "help.topic.snapshots_and_change_streams",
		type: "topic",
		provider: "client",
		tags: ["readpage", "changes", "snapshot", "stream", "revision", "rev", "pagination"],
		related: ["help.topic.durable_mailboxes_and_ack", "help.api.phispaces_read_page_changes"],
		since: "0.0.1",
		de: {
			title: "Snapshot-Seiten (readPage) und Revisionsströme (changes)",
			short: "Wie Clients mit readPage konsistente, bytebegrenzte Snapshots lesen und über changes(afterRev) lückenlos nachfolgende Commits streamen.",
			body: `## Überblick {#overview}

Um eine Live-Oberfläche – wie unseren Multiplayer Space-Chat oder das Space-Dashboard – synchron zu halten, kombiniert \`phi-spaces\` **unveränderliche Punkt-in-Zeit-Snapshots (\`readPage\`)** mit einem **monotonen Revisionsstrom (\`changes\`)**.

## Begriffs- und Systemmodell {#concept-model}

### Konsistente Seiten mit readPage {#read-page}

\`\`\`ts
const page = await space.readPage(template, { maxBytes: 65536 });
// page = { items: EntryView[], next: string | null, token?: string, rev: number, streamId: string }
\`\`\`

- Die erste Seite erzeugt im Space-Cache einen Snapshot zur Revision \`page.rev\` (TTL: 60 s, max. 16 aktive Tokens / 64 MiB je Space).
- Folgeaufrufe mit \`space.readPage(template, { after: page.next, token: page.token })\` lesen garantiert **denselben unveränderlichen Snapshot**, selbst wenn parallel neue Entries geschrieben werden oder Leases ablaufen.
- Nach Host-Neustart oder Ablauf der 60-s-TTL wirft der nächste Seitenabruf \`SnapshotExpired\`; der Client liest dann einfach eine neue erste Seite.

### Inkrementelles Aufholen mit changes(afterRev) {#changes-stream}

\`\`\`ts
const delta = await space.changes(page.rev, { maxBytes: 65536 });
// delta = { streamId: string, batches: ChangeBatch[], next: number, rev: number, more: boolean }
\`\`\`

- Jeder Commit im Space erhöht die Revision \`rev\` um 1.
- \`changes(afterRev)\` liefert alle seit \`afterRev\` sichtbar gewordenen Entry-Batches in Commit-Reihenfolge.
- Ist das Revisionslog (4 MiB Ringpuffer) bereits über \`afterRev\` hinaus rotiert, liest der Client einen frischen \`readPage\`-Snapshot als neue Baseline.

## Siehe auch {#see-also}

- [Dauerhafte Mailboxes (events / ack), wait und notify](help.topic.durable_mailboxes_and_ack#overview)
- [readPage & changes API](help.api.phispaces_read_page_changes)`
		},
		en: {
			title: "Snapshot Pages (readPage) and Revision Streams (changes)",
			short: "How clients read consistent, byte-bounded snapshots via readPage and stream subsequent commits seamlessly via changes(afterRev).",
			body: `## Overview {#overview}

To keep a live UI—such as our Multiplayer Space-Chat or the Space Dashboard—in sync, \`phi-spaces\` combines **immutable point-in-time snapshots (\`readPage\`)** with a **monotonic revision stream (\`changes\`)**.

## Concept And System Model {#concept-model}

### Consistent Pagination With readPage {#read-page}

\`\`\`ts
const page = await space.readPage(template, { maxBytes: 65536 });
// page = { items: EntryView[], next: string | null, token?: string, rev: number, streamId: string }
\`\`\`

- The first page pins a snapshot at revision \`page.rev\` in the space cache (TTL: 60 s, max 16 tokens / 64 MiB per space).
- Subsequent calls with \`space.readPage(template, { after: page.next, token: page.token })\` read **the exact same immutable snapshot**, even while concurrent writes or lease expirations occur.
- After a host restart or 60 s TTL expiry, continuing throws \`SnapshotExpired\`, signaling the client to re-baseline from page 1.

### Incremental Catch-Up With changes(afterRev) {#changes-stream}

\`\`\`ts
const delta = await space.changes(page.rev, { maxBytes: 65536 });
// delta = { streamId: string, batches: ChangeBatch[], next: number, rev: number, more: boolean }
\`\`\`

- Every space commit increments \`rev\` by 1.
- \`changes(afterRev)\` returns all committed entry batches after \`afterRev\` in commit order.
- If the revision log (4 MiB ring buffer) has rotated past \`afterRev\`, the client re-baselines with a fresh \`readPage\` snapshot.

## See Also {#see-also}

- [Durable Mailboxes (events / ack), wait, and notify](help.topic.durable_mailboxes_and_ack#overview)
- [readPage & changes API](help.api.phispaces_read_page_changes)`
		}
	},
	{
		id: "help.topic.durable_mailboxes_and_ack",
		type: "topic",
		provider: "client",
		tags: ["mailbox", "events", "ack", "wait", "notify", "mailboxepoch"],
		related: ["help.topic.snapshots_and_change_streams", "help.api.phispaces_wait_notify_mailbox", "help.workflow.stage_v3_remote_socket"],
		since: "0.0.1",
		de: {
			title: "Dauerhafte Mailboxes (events / ack), wait und notify",
			short: "Wie nichtblockierendes wait und notify Ereignisse in persistente Consumer-Mailboxes zustellen und was Präfix-ACK von einem Transaktions-Commit unterscheidet.",
			body: `## Überblick {#overview}

Während \`read(template, timeout)\` und \`take(template, timeout)\` den aktuellen Aufruf blockieren (max. 60 s in Agent-Tools), erlauben \`wait\` und \`notify\` das **langlebige, nichtblockierende Parken** von Such- und Benachrichtigungsaufträgen über Stunden, Tage oder \`FOREVER\`.

## Begriffs- und Systemmodell {#concept-model}

### wait vs. notify {#wait-vs-notify}

- **\`space.notify(template, { target, txn?, lease?, handback? })\`**: Jedes Mal, wenn ein passender Entry sichtbar wird, legt der Space ein Event in die Mailbox von \`target\`.
- **\`space.wait(template, { take?, target, timeout, txnLeaseMs?, handback? })\`**: Einmaliger Auftrag. Bei \`take: true\` reserviert der Space den gefundenen Entry sofort in einer **frischen Transaktion** für \`target\` und legt Entry samt \`txnId\` in die Mailbox!

### Consumer-Mailbox und Präfix-ACK {#mailbox-and-ack}

Entfernte Clients (\`RemoteSpace\`) rufen ihre Mailbox über \`events\` ab und bestätigen verarbeitete Nachrichten per \`ack\`:

\`\`\`ts
const page = await remote.events({ after: cursor, waitMs: 5_000 });
if (page.gap) throw new Error("Mailbox reset: reload state before processing");
for (const item of page.events) {
  await handleEvent(item.event); // Must persist result and commit event.txn before returning.
}
if (page.events.length > 0) {
  await remote.ack(page.mailboxEpoch, page.next);
}
\`\`\`

- **Wichtige Grenze**: \`ack(epoch, upTo)\` bestätigt ausschließlich, dass der Consumer die Mailbox-Nachrichten bis Sequenz \`upTo\` erhalten hat – es ist **kein** Transaktions-Commit! Die übergebene Take-Transaktion muss separat mit \`commit(ev.event.txn)\` abgeschlossen werden.
- Bei TTL-Ablauf wechselt mailboxEpoch; gap meldet den Verlustbereich und betroffene Take-Reservierungen werden freigegeben. Bei vollem Bytebudget werden neue Wirkungen mit ResourceExhausted abgewiesen, nicht still Events verworfen.

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): SpaceService, RemoteSpace & Mailboxes](help.workflow.stage_v3_remote_socket#overview)
- [wait, notify, events & ack API](help.api.phispaces_wait_notify_mailbox)`
		},
		en: {
			title: "Durable Mailboxes (events / ack), wait, and notify",
			short: "How non-blocking wait and notify deliver events into persistent consumer mailboxes, and how prefix ACK differs from a transaction commit.",
			body: `## Overview {#overview}

While \`read(template, timeout)\` and \`take(template, timeout)\` block the active call (capped at 60 s in agent tools), \`wait\` and \`notify\` allow **long-lived, non-blocking registration** of read/take waiters and subscriptions for hours, days, or \`FOREVER\`.

## Concept And System Model {#concept-model}

### wait vs. notify {#wait-vs-notify}

- **\`space.notify(template, { target, txn?, lease?, handback? })\`**: Whenever a matching entry becomes visible, the space appends an event to \`target\`'s mailbox.
- **\`space.wait(template, { take?, target, timeout, txnLeaseMs?, handback? })\`**: One-shot waiter. With \`take: true\`, the space reserves the matched entry inside a **fresh transaction** owned by \`target\` and delivers both the entry and \`txnId\` to the mailbox!

### Consumer Mailbox And Prefix ACK {#mailbox-and-ack}

Remote clients (\`RemoteSpace\`) poll their mailbox via \`events\` and acknowledge processed prefixes via \`ack\`:

\`\`\`ts
const page = await remote.events({ after: cursor, waitMs: 5_000 });
if (page.gap) throw new Error("Mailbox reset: reload state before processing");
for (const item of page.events) {
  await handleEvent(item.event); // Must persist result and commit event.txn before returning.
}
if (page.events.length > 0) {
  await remote.ack(page.mailboxEpoch, page.next);
}
\`\`\`

- **Critical Boundary**: \`ack(epoch, upTo)\` only acknowledges receipt of mailbox events up to sequence \`upTo\`—it is **not** a transaction commit! A delivered take transaction must still be committed explicitly via \`commit(ev.event.txn)\`.
- TTL expiry changes mailboxEpoch, reports gap and releases affected take reservations. Byte exhaustion rejects new effects with ResourceExhausted instead of silently dropping events.

## See Also {#see-also}

- [Stage 3 (v3-remote-socket): SpaceService, RemoteSpace & Mailboxes](help.workflow.stage_v3_remote_socket#overview)
- [wait, notify, events & ack API](help.api.phispaces_wait_notify_mailbox)`
		}
	},
	{
		id: "help.topic.local_client_and_named_spaces",
		type: "topic",
		provider: "client",
		tags: ["phispaces", "namedspace", "registry", "createspace", "listspaces", "startservice"],
		related: ["help.topic.agent_tools_and_replay", "help.api.phispaces_write"],
		since: "0.0.1",
		de: {
			title: "Lokaler Client PhiSpaces, benannte Spaces und startService",
			short: "Wie PhiSpaces auf dem Default-Space oder benannten Spaces (NamedSpace) arbeitet und wie startService Reaper und Event-Delivery betreibt.",
			body: `## Überblick {#overview}

Ein Host (der eigene Speicher) verwaltet standardmäßig den Default-Space (\`phi-spaces.space\`, Alias \`"default"\`) sowie über die \`Registry\` (\`phi-spaces.registry\`) mehrere durch Ressourcenlimits begrenzte isolierte **benannte Spaces** (\`phi-spaces.named-space\`).

## Begriffs- und Systemmodell {#concept-model}

### Benannte Spaces anlegen und öffnen {#named-spaces}

\`\`\`ts
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";

// 1. Benannten Space für eine Chat-Session im Commit des Hosts anlegen:
await host.commit(async (tx) => {
  await createSpace(tx, "chat-session-alpha", Date.now());
}, ctx);

// 2. Client auf diesen benannten Space richten:
const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, {
  space: "chat-session-alpha"
});

// 3. Hintergrunddienst (Reaper + lokale Zustellung) für alle Spaces starten:
const stopService = await startService(host, ctx);
\`\`\`

- Wird im \`PhiSpaces\`-Konstruktor \`conversationId\` übergeben, prüft der Client strikt die Ownership (eine Conversation darf nur ihre eigenen Transaktionen committen/abbrechen und nur ihre eigenen Leases verlängern/kündigen).
- Lässt Host-Code \`conversationId\` weg (\`undefined\`), agiert der Client administrativ und darf \`setCompletionProfiles\` sowie \`setLimits\` aufrufen.

## Siehe auch {#see-also}

- [Die 8 LLM-Agent-Tools und Replay-Sicherheit](help.topic.agent_tools_and_replay#overview)`
		},
		en: {
			title: "Local Client PhiSpaces, Named Spaces, and startService",
			short: "How PhiSpaces operates on the default space or named spaces (NamedSpace) and how startService drives the reaper and event delivery.",
			body: `## Overview {#overview}

A host (the own store) holds the default space (\`phi-spaces.space\`, alias \`"default"\`) plus resource-bounded isolated **named spaces** (\`phi-spaces.named-space\`) tracked in the \`Registry\` (\`phi-spaces.registry\`).

## Concept And System Model {#concept-model}

### Creating And Opening Named Spaces {#named-spaces}

\`\`\`ts
import { createSpace, listSpaces, PhiSpaces, startService } from "phi-spaces";

// 1. Create a named space for a chat session inside a host commit:
await host.commit(async (tx) => {
  await createSpace(tx, "chat-session-alpha", Date.now());
}, ctx);

// 2. Point a PhiSpaces client at the named space:
const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, {
  space: "chat-session-alpha"
});

// 3. Start background reaper and local event delivery across all spaces:
const stopService = await startService(host, ctx);
\`\`\`

- Passing \`conversationId\` to \`PhiSpaces\` enables strict ownership enforcement (a conversation can only commit/abort its own transactions and renew/cancel its own leases).
- Omitting \`conversationId\` (\`undefined\`) runs in host/administrative mode, unlocking \`setCompletionProfiles\` and \`setLimits\`.

## See Also {#see-also}

- [The 8 LLM Agent Tools and Replay Safety](help.topic.agent_tools_and_replay#overview)`
		}
	},
	{
		id: "help.topic.agent_tools_and_replay",
		type: "topic",
		provider: "tools",
		tags: ["tools", "agent", "replay", "space_write", "space_take", "space_txn", "space_wait", "space_notify"],
		related: ["help.topic.local_client_and_named_spaces", "help.api.agent_tools"],
		since: "0.0.1",
		de: {
			title: "Die 8 LLM-Agent-Tools und Replay-Sicherheit",
			short: "Wie KI-Agenten über space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify und space_lease sicher koordinieren.",
			body: `## Überblick {#overview}

Die Erweiterung \`spaces\` (\`createSpaces(localSpaces(host))\` im Agent-Paket) stattet \`pi-durable\`-Conversations mit 8 Werkzeugen aus, die sämtlich mit \`replay: "safe"\` laufen. Jeder Aufruf hat eine feste Request-Identität im Space, ein wiederholter Aufruf liefert das erste Ergebnis.

## Technische Referenz {#technical-reference}

| Tool | Parameter | Semantik & Schutz |
|---|---|---|
| \`space_write\` | \`{ type, fields, types?, ttlMs?, txn? }\` | Schreibt einen Entry im selben Commit wie den Task-Claim; ein Tool-Replay erzeugt keinen zweiten Entry. |
| \`space_list\` | \`{ id?, type?, fields?, limit?, txn? }\` | Liest bis zu \`limit\` (Standard 100, max. 1000) passende Entries ohne Sperre. |
| \`space_read\` | \`{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }\` | Blockierendes Lesen bis \`timeoutMs\` (gedeckelt auf 60 s); Deadline wird per \`api.memo\` über Replays bewahrt. |
| \`space_take\` | \`{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }\` | Exklusives Entnehmen (oder Reservieren unter \`txn\`); Task-Claim bewahrt den genommenen Entry bei Replay. |
| \`space_txn\` | \`{ action: "begin" \\| "commit" \\| "abort", txn?, leaseMs? }\` | Öffnet, committet oder verwirft eine Conversation-eigene Space-Transaktion. |
| \`space_wait\` | \`{ type?, fields?, mode?: "take" \\| "read", timeoutMs?, txnLeaseMs?, handback? }\` | Nichtblockierendes Warten (auch \`"forever"\`); weckt die Conversation per Nachricht, sobald ein Treffer erscheint. |
| \`space_notify\` | \`{ type?, fields?, ttlMs?, handback?, txn? }\` | Abonniert zukünftige passende Entries als \`[space event]\`-Nachricht an die Conversation. |
| \`space_lease\` | \`{ action: "renew" \\| "cancel", id, ttlMs? }\` | Verlängert oder beendet eine eigene Lease (Entry, Txn, Wait oder Notify). |

## Siehe auch {#see-also}

- [Agent-Tools (spaces) & startService API](help.api.agent_tools)`
		},
		en: {
			title: "The 8 LLM Agent Tools and Replay Safety",
			short: "How AI agents coordinate safely through space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify, and space_lease.",
			body: `## Overview {#overview}

The \`spaces\` extension (\`createSpaces(localSpaces(host))\` in the agent package) equips \`pi-durable\` conversations with 8 tools, all marked \`replay: "safe"\`. Every call has a fixed request identity in the space, so a repeated call returns the first result.

## Technical Reference {#technical-reference}

| Tool | Parameters | Semantics & Protection |
|---|---|---|
| \`space_write\` | \`{ type, fields, types?, ttlMs?, txn? }\` | Writes an entry in the same commit as the task claim; replaying the tool never creates a duplicate entry. |
| \`space_list\` | \`{ id?, type?, fields?, limit?, txn? }\` | Lists up to \`limit\` (default 100, max 1000) matching entries without locking. |
| \`space_read\` | \`{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }\` | Blocking read up to \`timeoutMs\` (capped at 60 s); deadline is memoized via \`api.memo\` across replays. |
| \`space_take\` | \`{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }\` | Exclusive removal (or reservation under \`txn\`); task claim preserves the taken entry across replays. |
| \`space_txn\` | \`{ action: "begin" \\| "commit" \\| "abort", txn?, leaseMs? }\` | Begins, commits, or aborts a conversation-owned space transaction. |
| \`space_wait\` | \`{ type?, fields?, mode?: "take" \\| "read", timeoutMs?, txnLeaseMs?, handback? }\` | Non-blocking wait (including \`"forever"\`); wakes the conversation with a message when a match arrives. |
| \`space_notify\` | \`{ type?, fields?, ttlMs?, handback?, txn? }\` | Subscribes to future matching entries delivered as \`[space event]\` messages. |
| \`space_lease\` | \`{ action: "renew" \\| "cancel", id, ttlMs? }\` | Renews or cancels an owned lease (entry, txn, wait, or notify). |

## See Also {#see-also}

- [Agent Tools (spaces) & startService API](help.api.agent_tools)`
		}
	},
	{
		id: "help.topic.space_service_and_remote_space",
		type: "topic",
		provider: "remote",
		tags: ["spaceservice", "remotespace", "socket", "tcp", "policy", "identityadapter", "outcomeunknown"],
		related: ["help.workflow.stage_v3_remote_socket", "help.api.space_service_and_remote"],
		since: "0.0.1",
		de: {
			title: "SpaceService, RemoteSpace und Netzwerk-Transporte",
			short: "Wie SpaceService Rollen-Policies erzwingt und wie RemoteSpace über In-Process, Unix-Socket, TCP oder pi-serverd mit stabilen Retries kommuniziert.",
			body: `## Überblick {#overview}

Sobald Web-Server, Worker und Subagenten in getrennten Prozessen oder auf verschiedenen Maschinen laufen, übernimmt \`SpaceService\` (\`src/service.ts\`) die serverseitige Abwicklung und \`RemoteSpace\` (\`src/remote.ts\`) die Client-Seite.

## Begriffs- und Systemmodell {#concept-model}

### Authentisierung über IdentityAdapter und Policy {#identity-and-policy}

\`SpaceService\` vertraut niemals einer vom Client im JSON-Body mitgesendeten Identität. Stattdessen bestimmt der \`IdentityAdapter\` (\`StaticIdentity\` lokal oder \`GateIdentity\` über NetBird/Schicht B) aus dem \`Connection\`-Kontext den \`Principal\` und seine Rollen (\`admin\`, \`host\`, \`member\`, \`observer\`). Die \`Policy\` prüft vor jeder Operation sowohl die erlaubte Methode als auch die erlaubten Entry-Typen. Ein Typ-Grant gilt auch für Subtypen: Ein Write ist erlaubt, sobald der Typ oder einer der deklarierten Supertypen freigegeben ist. Weil der Schreibende die Supertypen selbst angibt, kann eine Rolle mit Grant auf \`Job\` auch \`{ type: "X", types: ["Job"] }\` schreiben; Typ-Grants sind daher keine Integritätsgrenze für Subtypen. Federation-Members erzwingen dagegen die in der Typ-Policy deklarierten Supertypen.

### Stabile Retries und OutcomeUnknown in RemoteSpace {#remote-retries}

Vor der ersten Mutation ruft \`RemoteSpace\` automatisch \`hello\` und \`generation\` auf und vergibt für jeden schreibenden Aufruf eine stabile \`requestId\`. Geht auf dem Socket/TCP-Transport eine Antwort verloren, wiederholt \`RemoteSpace\` denselben Aufruf mit **unveränderter \`requestId\`**. Läuft \`maxClientWaitMs\` ab, wirft der Client \`OutcomeUnknown\`, während die Operation am Host weiterläuft und über \`pollOperation\` aufgelöst werden kann. Nicht klassifizierte Hostfehler kommen als Code \`Internal\` mit der festen Meldung \`internal error\` an; den eigentlichen Fehler protokolliert nur der Host.

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace in der Praxis](help.workflow.stage_v3_remote_socket#overview)
- [SpaceService, serveSpace & RemoteSpace API](help.api.space_service_and_remote)`
		},
		en: {
			title: "SpaceService, RemoteSpace, and Network Transports",
			short: "How SpaceService enforces role policies and how RemoteSpace communicates over in-process, Unix socket, TCP, or pi-serverd transports with stable retries.",
			body: `## Overview {#overview}

When web servers, workers, and subagents run in separate processes or on different machines, \`SpaceService\` (\`src/service.ts\`) handles server-side dispatch while \`RemoteSpace\` (\`src/remote.ts\`) provides the client implementation.

## Concept And System Model {#concept-model}

### Authentication Via IdentityAdapter And Policy {#identity-and-policy}

\`SpaceService\` never trusts a principal sent inside a client JSON payload. Instead, its \`IdentityAdapter\` (\`StaticIdentity\` locally or \`GateIdentity\` over NetBird/Layer B) derives the \`Principal\` and roles (\`admin\`, \`host\`, \`member\`, \`observer\`) from the trusted \`Connection\` context. \`Policy\` checks allowed methods and entry types before executing any call. A type grant covers subtypes: a write is allowed as soon as its type or one of its declared supertypes is granted. Because the writer declares the supertypes, a role granted \`Job\` can also write \`{ type: "X", types: ["Job"] }\`; type grants are therefore no integrity boundary for subtypes. Federation members, in contrast, enforce the supertypes declared in their type policy.

### Stable Retries And OutcomeUnknown In RemoteSpace {#remote-retries}

Before its first mutation, \`RemoteSpace\` automatically calls \`hello\` and \`generation\` and assigns a stable \`requestId\` to every mutating call. If a reply is lost on the socket/TCP transport, \`RemoteSpace\` retries with the **exact same \`requestId\`**. If \`maxClientWaitMs\` expires, it throws \`OutcomeUnknown\` while the host operation continues and can be resolved via \`pollOperation\`. Unclassified host errors arrive as code \`Internal\` with the fixed message \`internal error\`; only the host logs the actual error.

## See Also {#see-also}

- [Stage 3 (v3-remote-socket): SpaceService & RemoteSpace in Practice](help.workflow.stage_v3_remote_socket#overview)
- [SpaceService, serveSpace & RemoteSpace API](help.api.space_service_and_remote)`
		}
	},
	{
		id: "help.topic.gate_auth_grants_and_recovery",
		type: "topic",
		provider: "security",
		tags: ["gate", "netbird", "challenge", "ed25519", "enroll", "grants", "rotation", "boot", "restore"],
		related: ["help.workflow.stage_v4_gated_auth", "help.api.gate_auth_grants"],
		since: "0.0.1",
		de: {
			title: "Overlay-Gate, Schicht-A/B-Auth, 60s-Grants und Recovery",
			short: "Zwei-Schichten-Authentisierung (NetBird-Peer + Ed25519/P-256 Challenge), Token/QR-Enrollment, kurzlebige 60-Sekunden-Grants, Schlüsselrotation, Boot-Guard und Restore.",
			body: `## Überblick {#overview}

In einer Mehr-Host-Umgebung reicht eine IP-Adresse nicht als Identitätsnachweis, da mehrere Prozesse auf demselben Host dieselbe Netzwerk-IP teilen können. Phase 1b (\`src/gate.ts\`, \`src/auth.ts\`, \`src/enroll.ts\`, \`src/grants.ts\`, \`src/runtime.ts\`) kombiniert daher zwei Sicherheitsschichten mit kurzlebigen, signierten **60-Sekunden-Grants** und einem externen **CAS-Boot-Register**.

## Begriffs- und Systemmodell {#concept-model}

### Schicht A (Overlay-Peer) + Schicht B (App-Key-Challenge) {#layer-a-and-b}

1. **Schicht A (\`startGate\` / \`NetbirdDirectory\`)**: Bestimmt sofort bei TCP-Annahme (\`identifyOnConnect: true\`, Timeout 5 s) aus der WireGuard-/Overlay-Quelladresse die \`peerId\` und die Gruppen (\`space-hosts\`, \`space-admin\`, \`space-observer\`) und begrenzt Verbindungen auf max. 32 je Peer / 64 je Listener.
2. **Schicht B (\`ProvingService\`)**: Sendet eine verbindungsgebundene 30-s-Challenge \`{ gateHostId, observedPeerId, connNonce }\`. Der Client signiert diese mit seinem privaten \`Ed25519\`- oder \`P-256\`-Schlüssel (im Android Keystore auf dem Smartphone bzw. \`0600\`-Schlüsseldatei auf dem Host).

### Enrollment, 60s-Grants und Schlüsselrotation {#enrollment-and-grants}

- **Enrollment (\`createEnroll\` / \`enrollQr\`)**: Ein Admin erzeugt über den Supervisor ein Einmal-Token (nur der SHA-256-Hash liegt im \`CONTROL_SPACE\`). Das neue Gerät koppelt seinen Public Key per \`remote.enroll(token)\`.
- **Kurzlebige Grants (\`GrantAuthority\` / \`GrantVerifier\`)**: Vor jedem fachlichen Aufruf auf einem Data-Space holt \`RemoteSpace\` über \`grantProvider\` einen vom Control-Host signierten Grant (\`purpose: "effect" | "resolution"\`, max. 60 s gültig). Der Data-Member prüft Signatur, \`authorityId\`, \`peerId\`, \`keyId\`, Scope und Ablaufzeit noch einmal direkt vor dem Commit!
- **Eigene Schlüsselrotation (\`rotateKey\`)**: Erfordert die Signatur des alten **und** des neuen Schlüssels über eine persistierte Challenge und tauscht den Schlüssel im \`CONTROL_SPACE\` atomar ohne Rechteverlust aus.

### Boot-Guard und Restore-Quarantäne {#boot-and-restore}

- **Boot-Guard (\`SqliteRecoveryRegister\` + \`installBootGuard\`)**: Ein Host darf nur starten und Commits ausführen, solange seine lokale Installation und das externe CAS-Register für jeden Space dieselbe \`authorityId\`, \`dataIncarnation\` und Rolle ausweisen.
- **Data-Restore (\`RecoveryController\`)**: Importiert Snapshots in 192-KiB-konformen Batches, erhöht die Dateninkarnation und markiert restaurierte exklusive Aufgaben als \`restoredUnverified\`, bis ein Admin sie per \`releaseRestored\` explizit freigibt.

## Siehe auch {#see-also}

- [Stufe 4 (v4-gated-auth): Gate, Enrollment & 60s-Grants im Multiplayer-Chat](help.workflow.stage_v4_gated_auth#overview)
- [Gate, Schicht A/B, Enrollment & Grants API](help.api.gate_auth_grants)`
		},
		en: {
			title: "Overlay Gate, Layer A/B Auth, 60s Grants, and Recovery",
			short: "Two-layer authentication (NetBird peer + Ed25519/P-256 challenge), token/QR enrollment, short-lived 60-second grants, key rotation, boot guard, and restore.",
			body: `## Overview {#overview}

In a multi-host environment, an IP address alone is insufficient identity proof because multiple processes on the same host share the overlay IP. Phase 1b (\`src/gate.ts\`, \`src/auth.ts\`, \`src/enroll.ts\`, \`src/grants.ts\`, \`src/runtime.ts\`) therefore combines two authentication layers with short-lived signed **60-second grants** and an external **CAS boot register**.

## Concept And System Model {#concept-model}

### Layer A (Overlay Peer) + Layer B (App-Key Challenge) {#layer-a-and-b}

1. **Layer A (\`startGate\` / \`NetbirdDirectory\`)**: Resolves \`peerId\` and groups (\`space-hosts\`, \`space-admin\`, \`space-observer\`) immediately upon TCP accept (\`identifyOnConnect: true\`, 5 s timeout) and enforces per-peer (32) and per-listener (64) connection quotas.
2. **Layer B (\`ProvingService\`)**: Issues a connection-bound 30 s challenge \`{ gateHostId, observedPeerId, connNonce }\`. The client signs it using its private \`Ed25519\` or \`P-256\` key (stored in Android Keystore on mobile or a \`0600\` key file on servers).

### Enrollment, 60s Grants, And Key Rotation {#enrollment-and-grants}

- **Enrollment (\`createEnroll\` / \`enrollQr\`)**: An admin creates a one-time token via the supervisor (only the SHA-256 hash is stored in \`CONTROL_SPACE\`). The new device registers its public key via \`remote.enroll(token)\`.
- **Short-Lived Grants (\`GrantAuthority\` / \`GrantVerifier\`)**: Before mutating a data space, \`RemoteSpace\` obtains a control-signed grant (\`purpose: "effect" | "resolution"\`, max 60 s TTL) via \`grantProvider\`. The data member re-verifies signature, \`authorityId\`, \`peerId\`, \`keyId\`, scope, and expiry right before commit!
- **Own-Key Rotation (\`rotateKey\`)**: Requires signatures from both the old and replacement keys over a persisted challenge, swapping the key atomically in \`CONTROL_SPACE\`.

### Boot Guard And Restore Quarantine {#boot-and-restore}

- **Boot Guard (\`SqliteRecoveryRegister\` + \`installBootGuard\`)**: A host may only boot and commit while its local state and the external CAS register match on \`authorityId\`, \`dataIncarnation\`, and role for every space.
- **Data Restore (\`RecoveryController\`)**: Imports snapshots in 192 KiB-bounded batches, increments data incarnation, and quarantines restored exclusive tasks as \`restoredUnverified\` until an admin explicitly calls \`releaseRestored\`.

## See Also {#see-also}

- [Stage 4 (v4-gated-auth): Gate, Enrollment & 60s Grants in the Multiplayer Chat](help.workflow.stage_v4_gated_auth#overview)
- [Gate, Layer A/B, Enrollment & Grants API](help.api.gate_auth_grants)`
		}
	},
	{
		id: "help.topic.federation_router_and_membership",
		type: "topic",
		provider: "federation",
		tags: ["federation", "router", "routerlease", "delegation", "hrw", "federatedspace", "takewaiting", "membership", "erasure"],
		related: ["help.workflow.stage_v5_federated_cluster", "help.api.federation_controller"],
		since: "0.0.1",
		de: {
			title: "Federation, Router, HRW-Sharding und Membership",
			short: "Wie createFederationController mehrere Member-Spaces über HRW-Routing, signierte Delegationen und journalisierte Waiter-Wettläufe zu einem Cluster verbindet.",
			body: `## Überblick {#overview}

Phase 2 (\`src/router.ts\`, \`src/delegation.ts\`, \`src/federation-policy.ts\`, \`src/federated-space.ts\`, \`src/membership.ts\`) verbindet mehrere physische Member-Spaces unter einem Koordinator-Router zu einem logischen \`FederatedSpace\`.

## Begriffs- und Systemmodell {#concept-model}

### RouterController und Journal-Partitionen {#router-and-journals}

Jede föderierte Operation durchläuft im \`RouterController\` die persistente Zustandsmaschine \`accepted → applying → completed | failed | needsReview\`. Vor dem ersten RPC-Versand an einen Member stehen Ziel-\`spaceId\`, \`primaryEpoch\`, \`requestId\` und Argument-Hash fest im Journal (1 bis 1024 Partitionen). Nach einem Router-Neustart löst \`recover()\` offene Unterrequests über \`pollOperation\` / \`resolveOperation\` auf, ohne jemals blind eine zweite Wirkung auszulösen.

### HRW-Routing (Highest Random Weight) und Transaktionsbindung {#hrw-routing}

Die \`FederationPolicy\` ordnet jedem Entry-Typ eine Platzierungsregel zu:

- **\`local\`**: Fester einzelner Member-Space.
- **\`expand\` nach Typ oder Schlüsselfeld (HRW)**: Bei \`by: { field: "threadId" }\` berechnet der Router deterministisch über den kanonischen Feldwert und die Member-IDs den zuständigen Member.
- **Vorteil für unseren Multiplayer Space-Chat**: Da \`Thread\`, \`Msg\` und \`ChatTask\` alle über \`field: "threadId"\` auf dieselbe Member-Menge geroutet werden, landen alle Operationen eines Threads garantiert auf demselben Member-Space! Damit funktionieren lokale Space-Transaktionen und \`CompletionProfiles\` ohne verteiltes Two-Phase-Locking.

### Journalisierter Waiter-Wettlauf bei takeWaiting {#waiter-race}

Ruft ein globaler Worker \`federatedSpace.takeWaiting(template, timeoutMs, txnLeaseMs, request)\` ohne festes Schlüsselfeld auf, registriert der Router begrenzte Take-Waiter auf allen in Frage kommenden Members. Sobald ein Member einen Treffer in seiner Mailbox liefert, wird das Event **vor** dem Mailbox-ACK im Router-Journal erfasst: Die erste aktive Reservierung wird dauerhaft zum Gewinner gekürt; etwaige parallele Reservierungen auf anderen Members werden automatisch per \`abort\` zurückgegeben.

## Siehe auch {#see-also}

- [Stufe 5 (v5-federated-cluster): Föderierter Multiplayer Space-Chat](help.workflow.stage_v5_federated_cluster#overview)
- [createFederationController & FederatedSpace API](help.api.federation_controller)`
		},
		en: {
			title: "Federation, Router, HRW Sharding, and Membership",
			short: "How createFederationController unites multiple member spaces into a cluster using HRW routing, signed delegations, and journaled waiter races.",
			body: `## Overview {#overview}

Phase 2 (\`src/router.ts\`, \`src/delegation.ts\`, \`src/federation-policy.ts\`, \`src/federated-space.ts\`, \`src/membership.ts\`) unites multiple physical member spaces under a coordinator router into a logical \`FederatedSpace\`.

## Concept And System Model {#concept-model}

### RouterController And Journal Partitions {#router-and-journals}

Every federated operation transitions through the persistent state machine \`accepted → applying → completed | failed | needsReview\` in \`RouterController\`. Before the first RPC is sent to a member, target \`spaceId\`, \`primaryEpoch\`, child \`requestId\`, and argument hash are persisted in the journal (1 to 1024 partitions). After a router restart, \`recover()\` resolves in-flight child requests via \`pollOperation\` / \`resolveOperation\` without blindly triggering a second effect.

### HRW Routing (Highest Random Weight) And Transaction Binding {#hrw-routing}

\`FederationPolicy\` assigns a placement rule to each entry type:

- **\`local\`**: Pinned to a single member space.
- **\`expand\` by type or key field (HRW)**: With \`by: { field: "threadId" }\`, the router deterministically hashes the canonical field value and member IDs to pick the owning member.
- **Benefit for our Multiplayer Space-Chat**: Because \`Thread\`, \`Msg\`, and \`ChatTask\` all route by \`field: "threadId"\` across the same member set, every operation for a given thread lands on the exact same member space! Local space transactions and \`CompletionProfiles\` therefore work at full speed without cross-node two-phase locking.

### Journaled Waiter Race In takeWaiting {#waiter-race}

When a global worker calls \`federatedSpace.takeWaiting(template, timeoutMs, txnLeaseMs, request)\` with a wildcard key, the router registers bounded take waiters across all candidate members. When mailbox events arrive, they are ingested into the router journal **before** mailbox ACK: the first active reservation is durably elected as the winner, and any competing reservations on other members are automatically aborted and returned.

## See Also {#see-also}

- [Stage 5 (v5-federated-cluster): Federated Multiplayer Space-Chat](help.workflow.stage_v5_federated_cluster#overview)
- [createFederationController & FederatedSpace API](help.api.federation_controller)`
		}
	},
	{
		id: "help.topic.operations_mobile_and_replication",
		type: "topic",
		provider: "ops",
		tags: ["rungate", "runcontroller", "workersupervisor", "mobile", "adminspaces", "alerts", "audit", "replication", "lww", "hlc"],
		related: ["help.workflow.stage_v6_mobile_control", "help.api.operations_runs_workers"],
		since: "0.0.1",
		de: {
			title: "Betriebserweiterung (RunGate, Worker, Mobile/Web-Admin) & Phase-3-Replikation",
			short: "Wie Läufe über RunGate-Barrieren, Worker über signierte Zuweisungen und Spaces über die Mobile App (pi-termux-mobile) sowie den Web-Admin-Bereich (AdminSpaces) gesteuert werden.",
			body: `## Überblick {#overview}

Die Betriebserweiterung (Schritte B1–B10 in \`docs/betrieb-und-mobile-steuerung.md\`) ergänzt über dem Federation-Kern die operative Steuerung für **Rechenläufe (\`RunGate\` / \`RunController\`)**, **Host-Worker (\`WorkerSupervisor\`)**, **Space-Lebenszyklen (\`SpaceLifecycle\`)**, **Deployment-Bootstrap (\`DeploymentController\`)** und **Alarmierung/Audit (\`collectAlerts\` / \`auditLog\`)**. Alle Funktionen sind sowohl über die Android-App (\`pi-termux-mobile\`) als auch über den login-geschützten Web-Bereich **\`AdminSpaces\`** auf \`https://spaces.eibrain.org\` bedienbar.

## Begriffs- und Systemmodell {#concept-model}

### RunGate und bestätigte Pause-/Resume-Barriere {#rungate-barrier}

Ein \`RunGate { runId, controlRevision, state: "preparing" | "running" | "paused" | "stopped" }\` ist ein geschützter Steuerzustand im Space-Dokument:

- Der Space-Kern prüft bei **jedem** \`take\` (auch bei wartenden Takes und Host-Code), ob der \`RunGate\` des Laufs auf \`running\` steht.
- Bei \`pauseRun\` installiert jeder beteiligte Member zuerst einen **Fence** (keine neuen Run-Transaktionen, keine Lease-Verlängerung laufender Run-Transaktionen), lässt bereits reservierte Tasks innerhalb ihrer Lease abschließen und meldet erst danach sein signiertes ACK an den \`RunController\`. Erst wenn alle Member-ACKs vorliegen, wechselt der Lauf global auf \`paused\`.

### Signierte Worker-Steuerung (WorkerSupervisor) {#worker-supervisor}

Statt ungeschützter Entries im Control-Space speichert der Koordinator den gewünschten Worker-Sollzustand im geschützten Journal \`WorkerAssignments\` (\`setWorkers\`). Jeder Host ruft über die Gate-Methode \`workerAssignments\` nur seinen eigenen, vom Control-Host signierten Anteil ab. Der lokale \`WorkerSupervisor\` startet registrierte Worker-Schleifen (z.B. \`chat-worker\`, \`search-subagent\`, \`sieve\`) oder fährt sie bei \`count: 0\` nach dem aktuellen Task sauber herunter.

### Steuerung über Mobile App (pi-termux-mobile) & Web-Admin (AdminSpaces) {#mobile-and-web-admin}

Sowohl \`MobileSpaces\` (\`pi-termux-mobile/runtime/spaces-mobile.mjs\`) als auch unser Web-Admin-Controller (\`help-site/server/admin/\`) folgen demselben Sicherheitsvertrag:

1. **Vorab persistierte \`commandId\`**: Vor jedem Senden wird \`commandId = m-<kind>-<hex>\` bzw. \`w-<kind>-<hex>\` lokal gespeichert. Bei Timeout oder Doppeltippen wird exakt dieselbe \`commandId\` erneut gesendet („Ausgang wird geprüft“ statt doppelter Ausführung).
2. **Schlüsselbeweis & 60s-Grants**: Jede Verbindung beweist ihren \`Ed25519\`/\`P-256\`-Schlüssel am Gate und nutzt kurzlebige Grants.
3. **Phase-3-Replikationsbausteine**: Für verzögerungstolerante Metadaten und Präsenz steht \`EntryReplicationController\` (persistenter HLC, Last-Writer-Wins mit versionierten Tombstones und Add-Wins-Sets) bereit.

## Siehe auch {#see-also}

- [Stufe 6 (v6-mobile-control): Mobile App & Web-Admin Steuerung](help.workflow.stage_v6_mobile_control#overview)
- [RunController, WorkerSupervisor, SpaceLifecycle & Alerts API](help.api.operations_runs_workers)`
		},
		en: {
			title: "Operations Extension (RunGate, Workers, Mobile/Web Admin) & Phase 3 Replication",
			short: "How runs are controlled via RunGate barriers, workers via signed assignments, and spaces via the mobile app (pi-termux-mobile) and web admin area (AdminSpaces).",
			body: `## Overview {#overview}

The operations extension (steps B1–B10 in \`docs/betrieb-und-mobile-steuerung.md\`) adds operational control on top of the federation core for **runs (\`RunGate\` / \`RunController\`)**, **host workers (\`WorkerSupervisor\`)**, **space lifecycles (\`SpaceLifecycle\`)**, **deployment bootstrap (\`DeploymentController\`)**, and **alerting/audit (\`collectAlerts\` / \`auditLog\`)**. All capabilities are accessible both from the Android app (\`pi-termux-mobile\`) and from the login-protected **\`AdminSpaces\`** web area on \`https://spaces.eibrain.org\`.

## Concept And System Model {#concept-model}

### RunGate And Confirmed Pause/Resume Barrier {#rungate-barrier}

A \`RunGate { runId, controlRevision, state: "preparing" | "running" | "paused" | "stopped" }\` is a protected control record inside the space document:

- The space core checks on **every** \`take\` (including waiting takes and host code) whether the run's \`RunGate\` is \`running\`.
- On \`pauseRun\`, each participating member first installs a **fence** (blocking new run transactions and lease renewals on existing ones), allows in-flight reserved tasks to finish within their remaining lease, and only then returns its signed ACK to \`RunController\`. The run becomes globally \`paused\` only after all member ACKs arrive.

### Signed Worker Control (WorkerSupervisor) {#worker-supervisor}

Rather than storing mutable worker entries in the control space, the coordinator persists desired worker counts in the protected \`WorkerAssignments\` journal (\`setWorkers\`). Each host fetches only its own control-signed assignment via the \`workerAssignments\` gate method. The local \`WorkerSupervisor\` starts registered worker loops (e.g. \`chat-worker\`, \`search-subagent\`, \`sieve\`) or stops them cleanly after the active task when \`count: 0\`.

### Control Via Mobile App (pi-termux-mobile) & Web Admin (AdminSpaces) {#mobile-and-web-admin}

Both \`MobileSpaces\` (\`pi-termux-mobile/runtime/spaces-mobile.mjs\`) and our web admin controller (\`help-site/server/admin/\`) enforce the exact same safety contract:

1. **Pre-persisted \`commandId\`**: Before sending any admin command, \`commandId = m-<kind>-<hex>\` or \`w-<kind>-<hex>\` is saved locally. On timeout or double-click, the exact same \`commandId\` is reused ("checking outcome" rather than duplicate execution).
2. **Key Proof & 60s Grants**: Every connection proves its \`Ed25519\`/\`P-256\` key at the gate and uses short-lived grants.
3. **Phase 3 Replication Building Blocks**: For delay-tolerant metadata and presence, \`EntryReplicationController\` provides persistent HLC ordering, Last-Writer-Wins with versioned tombstones, and Add-Wins sets.

## See Also {#see-also}

- [Stage 6 (v6-mobile-control): Mobile App & Web Admin Control](help.workflow.stage_v6_mobile_control#overview)
- [RunController, WorkerSupervisor, SpaceLifecycle & Alerts API](help.api.operations_runs_workers)`
		}
	},
	{
		id: "help.topic.comparison_earendil_vs_phi_spaces",
		type: "topic",
		provider: "core",
		tags: ["comparison", "earendil", "cloudflare", "durable-objects", "pros-cons", "v1", "v2", "v3", "v4", "v5", "v6", "federated"],
		related: ["help.topic.overview", "help.workflow.overview_v1_to_v6", "help.topic.federation_router_and_membership"],
		since: "0.0.1",
		de: {
			title: "Konzeptvergleich: Earendil Multiplayer Chat vs. phi-spaces (v1 bis v6)",
			short: "Systematischer Vergleich des Cloudflare-Durable-Object-Ansatzes mit dem Tuple-Space-Modell von phi-spaces samt Vor- und Nachteilen von In-Memory (v1) bis Federated Space (v5/v6).",
			body: `## Überblick {#overview}

Sowohl die Vorlage [Pi Durable on Cloudflare](help.workflow.overview_v1_to_v6#overview) als auch unser \`phi-spaces\`-Referenzprojekt nutzen \`@earendil-works/pi-durable\` als transaktionalen Speicherunterbau, verfolgen aber zwei grundlegend unterschiedliche Architekturparadigmen:

- **Earendil-Vorlage (Actor / Session-Hülle)**: Jede Session ist ein einzelnes Cloudflare Durable Object, das WebSockets, SQLite-Datenbank, den einzigen DO-Alarm und den \`pi-durable\`-Harness direkt in einer Objektinstanz kapselt.
- **\`phi-spaces\` (Entkoppelter Koordinationsraum / Tuple Space)**: Der gesamte Anwendungs- und Koordinationszustand liegt als Menge typisierter JSON-Entries (\`Thread\`, \`Msg\`, \`ChatTask\`, \`Presence\`, \`ScheduledJob\`, \`SearchTask\`) in einem Space. Web-Gateway, KI-Worker, Subagenten und Administratoren sind lose gekoppelte Teilnehmer über den einheitlichen Vertrag \`SpaceLike\`.

## Begriffs- und Systemmodell {#concept-model}

### Gegenüberstellung der 6 Kernmechanismen {#mechanism-comparison}

| Mechanismus | Earendil Cloudflare DO | \`phi-spaces\` (\`v1\` bis \`v6\`) |
|---|---|---|
| **1. Session-Isolation** | 1 Durable Object Instanz pro \`sessionId\` (harte Silo-Grenze). | 1 benannter Space (\`NamedSpace\`) bzw. in \`v5\` HRW-Sharding nach \`threadId\` über mehrere Member-Spaces. |
| **2. Reconnect-Idempotenz** | Manuell programmiertes \`ConversationCommandReceipts\`-Dokument je Befehl. | **Eingebaute \`RequestRef\`-Claims (\`src/claims.ts\`)** mit kanonischem RFC-8785-Argument-Hash für alle Space-Mutationen. |
| **3. Geordnete Abarbeitung & Korrektheit** | \`conversation.submit({ whenBusy: "followUp" })\` ohne formale Ergebnisprüfung. | Exklusives \`take\` unter Space-Transaktion (\`txn\`) + serverseitig erzwungenes **\`CompletionProfile\`** (\`ChatTask → Msg\`). |
| **4. Live-Stream & Presence** | \`watchEvents\` + Cloudflare WebSocket-Attachments (nicht außerhalb abfragbar). | \`readPage\`-Snapshot + \`changes(afterRev)\` + Consumer-Mailboxes (\`events\`/\`ack\`) + **\`Presence\`-Entries mit 30-s-Space-Lease**. |
| **5. Geplante Aufgaben (Alarme)** | Nur 1 Hardware-Alarm je DO; manuelles \`#refreshAlarm()\` über alle Tasks nötig. | Beliebig viele parallele \`ScheduledJob\`- + \`TimerLock\`-Leases; automatischer Ablauf durch den \`phi-spaces\`-Reaper. |
| **6. Subagent-Suche (\`search_history\`)** | Child-Conversation in derselben lokalen DO-SQLite-DB. | Entkoppelter Subagent-Worker über \`SearchTask\` / \`SubagentStep\` / \`SearchResult\` – in \`v5\` **clusterweit über mehrere Hosts**! |

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

### Vor- und Nachteile der Stufen v1 (In-Memory) bis v5/v6 (Federated Space) {#stages-pros-cons}

| Ausbaustufe | Zentrale Vorteile | Bewusste Grenzen / Nachteile |
|---|---|---|
| **\`v1\` In-Memory Space** (\`openOwnMemoryHost()\` + \`PhiSpaces\`) | **0 ms Setup**, volle Space-Einsicht, \`SpaceLifecycle\`, \`WorkerSupervisor\` und \`DeploymentController\` direkt im RAM; ideal für Tests & Prototyping. | Zustand ist flüchtig (verloren bei Prozessende); auf einen einzelnen Node.js-Prozess beschränkt; kein \`RunGate\` im Chat aktiv. |
| **\`v2\` Local Durable Space** (\`SQLite\`/\`JSONL\` + \`PhiSpaces\`) | **Volle ACID-Dauerhaftigkeit** in einer Datei; $O(1)$ Pointer-basiertes Thread-Forking; steuer- und einsehbar über \`AdminSpaces\`, Live-Dashboard (\`npm run dashboard\`), TUI (\`npm run tui\`) und \`npm run bootstrap\`. | Single-Owner-Prinzip (nur 1 schreibender Host-Prozess auf der SQLite-Datei); kein Serverless-Scale-to-Zero. |
| **\`v3\` Remote Socket Space** (\`SpaceService\` + \`RemoteSpace\`) | **Prozess-Entkopplung**: Web-Gateway, Chat-Worker, Subagent und Inspector verbinden über Unix-Socket/TCP; ereignisgesteuerte Mailboxes (\`events\` + \`ack\`). | Zusätzlicher Serialisierungs- und Socket-I/O-Hop; Aufrufer müssen bei Verbindungsabbruch \`OutcomeUnknown\` via \`pollOperation\` auflösen. |
| **\`v4\` Gated Auth Space** (\`startGate\` Schicht A/B + 60s-Grants) | **Zero-Trust-Steuerung von außen**: Smartphone (\`pi-termux-mobile\`), CLI und Web-Admin koppeln sich per QR/Token (\`enrollQr\`) und steuern/inspizieren Spaces mit 60-s-Grants. | Höherer Einrichtungsaufwand (Key-Management, Enrollment, Boot-Register); neue Remote-Grants benötigen erreichbaren Control-Host. |
| **\`v5\`/\`v6\` Federated Space & Cluster-Admin** (\`FederatedSpace\` + HRW + \`RunGate\` in v6 + AP3-Replikation im Core) | **Horizontale Skalierung & Hochverfügbarkeit**: Orchestriert mehrere Member-Hosts; AP3 Primary/Sync Replikation im Core; \`RunGate\` in v6 für bestätigte Barrieren. | Keine member-übergreifenden Transaktionen (\`RoutingConflict\`); HRW-Member-Menge in v3 fest (\`MigrationRequired\` bei Entfernung); Test in v5 läuft in-process mit Hosts im Arbeitsspeicher. |

### Wann ist welches Modell überlegen? {#decision-guide}

- **Wähle das Cloudflare-DO-Modell**, wenn du tausende kleine, voneinander komplett isolierte Chat-Sessions in einer Serverless-Cloud mit *Scale-to-Zero* betreiben willst und keine externen Worker-Flotten oder On-Premise-Hoheit benötigst.
- **Wähle \`phi-spaces\` (\`v1\`–\`v6\`)**, wenn du **volle Infrastruktur-Unabhängigkeit** (Docker, Linux-VPS, lokal, Mobile), **serverseitig erzwungene Ergebnisverträge (\`CompletionProfiles\`)**, **entkoppelte heterogene Worker/Subagenten**, **horizontales HRW-Sharding über mehrere Hosts**, **selbstgehostete Primary/Sync-Replikation mit Fencing (AP3)** oder eine **integrierte Betriebs- und Laufsteuerung (\`RunGate\` ab v6, \`WorkerSupervisor\`, Mobile/Web-Admin)** benötigst.

## Siehe auch {#see-also}

- [Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)](help.workflow.overview_v1_to_v6#overview)
- [Federation, Router, HRW-Sharding und Membership](help.topic.federation_router_and_membership#overview)`
		},
		en: {
			title: "Concept Comparison: Earendil Multiplayer Chat vs. phi-spaces (v1 to v6)",
			short: "Systematic comparison of the Cloudflare Durable Object approach with the phi-spaces tuple-space model, including pros and cons from In-Memory (v1) to Federated Space (v5/v6).",
			body: `## Overview {#overview}

Both the [Pi Durable on Cloudflare](help.workflow.overview_v1_to_v6#overview) reference and our \`phi-spaces\` implementation build on \`@earendil-works/pi-durable\` for transactional storage, yet they follow two fundamentally different architectural paradigms:

- **Earendil Reference (Stateful Actor / Session Wrapper)**: Each session is a single Cloudflare Durable Object encapsulating WebSockets, an embedded SQLite database, the single DO alarm, and the \`pi-durable\` harness inside one object instance.
- **\`phi-spaces\` (Decoupled Coordination Space / Tuple Space)**: All application and coordination state lives as typed JSON entries (\`Thread\`, \`Msg\`, \`ChatTask\`, \`Presence\`, \`ScheduledJob\`, \`SearchTask\`) inside a space. Web gateways, AI workers, subagents, and administrators interact as loosely coupled participants through the unified \`SpaceLike\` contract.

## Concept And System Model {#concept-model}

### Side-By-Side Comparison Of The 6 Core Mechanisms {#mechanism-comparison}

| Mechanism | Earendil Cloudflare DO | \`phi-spaces\` (\`v1\` to \`v6\`) |
|---|---|---|
| **1. Session Isolation** | 1 Durable Object instance per \`sessionId\` (strict silo boundary). | 1 named space (\`NamedSpace\`) or, in \`v5\`, HRW sharding by \`threadId\` across multiple member spaces. |
| **2. Reconnect Idempotency** | Custom per-command \`ConversationCommandReceipts\` document written by hand. | **Built-in \`RequestRef\` claims (\`src/claims.ts\`)** with canonical RFC-8785 argument hashing across all space mutations. |
| **3. Ordered Processing & Correctness** | \`conversation.submit({ whenBusy: "followUp" })\` without formal result verification. | Exclusive \`take\` under a space transaction (\`txn\`) + server-enforced **\`CompletionProfile\`** (\`ChatTask → Msg\`). |
| **4. Live Stream & Presence** | \`watchEvents\` + Cloudflare WebSocket attachments (not queryable outside the socket). | \`readPage\` snapshot + \`changes(afterRev)\` + consumer mailboxes (\`events\`/\`ack\`) + **\`Presence\` entries with 30s space leases**. |
| **5. Scheduled Tasks (Alarms)** | Only 1 hardware alarm per DO; requires manual \`#refreshAlarm()\` projection across all tasks. | Arbitrary concurrent \`ScheduledJob\` + \`TimerLock\` leases; expired locks are automatically reaped by \`phi-spaces\`. |
| **6. Subagent Search (\`search_history\`)** | Child conversation inside the same local DO SQLite database. | Decoupled subagent worker via \`SearchTask\` / \`SubagentStep\` / \`SearchResult\`—searching **cluster-wide across hosts** in \`v5\`! |

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

### Pros And Cons Across Stages v1 (In-Memory) To v5/v6 (Federated Space) {#stages-pros-cons}

| Stage | Key Advantages | Trade-Offs / Boundaries |
|---|---|---|
| **\`v1\` In-Memory Space** (\`openOwnMemoryHost()\` + \`PhiSpaces\`) | **0 ms setup**, full space inspection, \`SpaceLifecycle\`, \`WorkerSupervisor\`, and \`DeploymentController\` directly in RAM; ideal for tests & prototyping. | Volatile state (lost when process exits); limited to a single Node.js process; no \`RunGate\` active in chat. |
| **\`v2\` Local Durable Space** (\`SQLite\`/\`JSONL\` + \`PhiSpaces\`) | **Full ACID durability** in a single file; $O(1)$ pointer-based thread forking; inspectable and controllable via \`AdminSpaces\`, live Dashboard (\`npm run dashboard\`), TUI (\`npm run tui\`), and \`npm run bootstrap\`. | Single-owner file lock (only 1 writing host process on the SQLite store); no serverless scale-to-zero. |
| **\`v3\` Remote Socket Space** (\`SpaceService\` + \`RemoteSpace\`) | **Process decoupling**: web gateway, chat workers, subagents, and inspectors connect via Unix socket/TCP; event-driven mailboxes (\`events\` + \`ack\`). | Additional serialization and socket I/O hop; callers must handle \`OutcomeUnknown\` via \`pollOperation\` on transport drop. |
| **\`v4\` Gated Auth Space** (\`startGate\` Layer A/B + 60s Grants) | **External zero-trust control**: smartphone (\`pi-termux-mobile\`), CLI, and web admin pair via QR/token (\`enrollQr\`) and inspect/control spaces with 60s grants. | Higher setup complexity (key provisioning, enrollment, boot register); issuing new remote grants requires a reachable control host. |
| **\`v5\`/\`v6\` Federated Space & Cluster Admin** (\`FederatedSpace\` + HRW + \`RunGate\` in v6 + AP3 Replication in Core) | **Horizontal scale & High Availability**: orchestrates multiple member hosts; AP3 Primary/Sync replication in core; \`RunGate\` in v6 for confirmed barriers. | No cross-member transactions (\`RoutingConflict\`); fixed HRW member set in v3 (\`MigrationRequired\` on removal); Stage v5 test runs in-process with in-memory hosts. |

### When To Choose Which Model {#decision-guide}

- **Choose the Cloudflare DO model** when you want to host thousands of small, completely isolated chat sessions on serverless edge infrastructure with *scale-to-zero* and no external worker fleets.
- **Choose \`phi-spaces\` (\`v1\`–\`v6\`)** when you need **full infrastructure sovereignty** (Docker, Linux VPS, on-premise, mobile), **server-enforced result contracts (\`CompletionProfiles\`)**, **decoupled heterogeneous worker/subagent fleets**, **horizontal HRW sharding across hosts**, **self-hosted Primary/Sync replication with fencing (AP3)**, or **integrated operational control (\`RunGate\` from v6, \`WorkerSupervisor\`, Mobile/Web Admin)**.

## See Also {#see-also}

- [Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)](help.workflow.overview_v1_to_v6#overview)
- [Federation, Router, HRW Sharding, and Membership](help.topic.federation_router_and_membership#overview)`
		}
	}
];
