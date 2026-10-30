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
		related: ["help.topic.examples", "help.topic.apps", "help.topic.architecture_layers", "help.topic.guarantees_and_boundaries", "help.workflow.overview_v1_to_v6"],
		since: "0.0.1",
		de: {
			title: "phi-spaces Systemüberblick: Was es ist und was es kann",
			short: "Einstieg in phi-spaces: was es ist, wie das transaktionale Tuple-Space-Modell funktioniert, welche Probleme es löst und was es vom Einzelprozess bis zum föderierten Verbund mit Mobile- und Web-Administration kann.",
			body: `## Überblick {#overview}

phi-spaces ist ein gemeinsamer Ablageort für Programme, ähnlich einer Pinnwand. Ein Programm hängt dort einen Auftrag oder eine Nachricht auf, ein anderes holt sie ab, sobald es Zeit hat. Beide müssen sich nicht kennen und nicht gleichzeitig laufen. Stürzt ein Programm mitten in der Arbeit ab, geht der Auftrag nicht verloren, sondern wird wieder frei. Das hilft überall dort, wo mehrere Programme, Geräte oder KI-Agenten zusammenarbeiten.

## Wo es weitergeht {#where-next}

- **In Aktion sehen:** Die [Beispiele](help.topic.examples#overview) zeigen kleine Programme zum Ausprobieren.
- **Fertige Anwendungen ansehen:** Die [Anwendungen auf phi-spaces](help.topic.apps#overview) zeigen, was damit gebaut wurde.
- **Weiterlesen:** Der Rest dieses Artikels erklärt das Modell, die Begriffe und die Grenzen.

## Herkunft: Linda und JavaSpaces {#history}

Die Idee stammt aus den 1980er Jahren: David Gelernter und Nicholas Carriero entwickelten an der Yale University **Linda**, ein Koordinationsmodell, in dem Prozesse nicht miteinander sprechen, sondern Daten (**Tupel**) in einen gemeinsamen **Tuple Space** legen und nach ihrem Inhalt wieder herausholen (\`out\`, \`rd\`, \`in\`). Gelernter nannte das *generative Kommunikation*: Daten überdauern den Prozess, der sie erzeugt hat, und verbinden Teilnehmer über Prozess- und Zeitgrenzen hinweg. Ende der 1990er übertrug Sun Microsystems das Konzept mit **JavaSpaces** auf typisierte Java-Objekte (**Entries**) mit Template-Suche, **Leases** und **Transaktionen**.

phi-spaces übernimmt dieses Modell in TypeScript und JSON und ergänzt Persistenz, Revisionen, Änderungsströme, Föderation und Administration. Es ist kein JavaSpaces-kompatibler Java-/RMI-Ersatz.

Das Modell ist nicht auf Agentenkommunikation zugeschnitten. Ein Space transportiert beliebige Daten: Aufträge, Nachrichten, Messwerte, Ergebnisse, Zustände oder Ereignisse. Agenten (Conversations) sind nur eine typische Art von Teilnehmer; Programme, Dienste, Geräte und Menschen nutzen denselben Space auf dieselbe Weise.

### Was phi-spaces besonders kann {#highlights}

- **Beliebige Kommunikate**: Jede JSON-Struktur mit \`type\` kann Entry sein; es gibt kein festes Nachrichtenformat.
- **Kommunikation ohne Adressen**: Absender wählen keinen Empfänger; Teilnehmer finden Daten über Templates.
- **Entkopplung in Raum und Zeit**: Produzenten und Konsumenten kennen einander nicht und müssen nicht gleichzeitig online sein.
- **Verlässliche Arbeitsverteilung**: exklusives \`take\` mit Lease und Transaktion; Abstürze geben Arbeit wieder frei.
- **Dauerhaft und nachvollziehbar**: persistenter Zustand, Revisionen, Snapshots und Änderungsströme.
- **Vom Einzelprozess zum Cluster**: lokal, per Socket/RPC und als föderierter Verbund mit Identität, Enrollment und Admin-Oberflächen.

## Was ist phi-spaces und warum wurde es gebaut? {#what-is-phi-spaces}

\`phi-spaces\` ist ein transaktionaler, persistenter **Koordinationsraum** in TypeScript nach dem Linda-/JavaSpaces-Modell. Er hat einen eigenen Speicher: eine SQLite-Datei, die genau ein Prozess besitzt, oder nur den Arbeitsspeicher. Die Bibliothek braucht kein Agenten-Framework. Das optionale Paket \`agent/\` gibt \`@earendil-works/pi-durable\`-Agenten Werkzeuge für den Space; als Speicher des Space dient pi-durable nicht mehr, alte pi-durable-Stores werden nicht übernommen. Anstatt Clients, Hintergrund-Worker, KI-Agenten und Administrationswerkzeuge über Punkt-zu-Punkt-Aufrufe direkt zu verkoppeln, tauschen alle Teilnehmer unveränderliche, typisierte JSON-Objekte (**Entries**) über gemeinsame, versionierte Datenräume (**Spaces**) aus.

Die Bibliothek löst vier Probleme beim Bau langlaufender Systeme und von KI-Agenten-Gruppen:

1. **Fehlertolerante Aufgabenübergabe (mit geleaster Reservierung)**: Ein Server, UI-Client oder Agent übergibt Arbeit nicht direkt an einen Worker, sondern schreibt einen Aufgaben-Entry (\`type: "ChatTask"\` o.Ä.) in den Space. Jeder Worker kann sich diesen Task exklusiv **reservieren** (\`take\`). Stürzt der Worker vor der Fertigstellung ab, gibt die abgelaufene Lease den Task automatisch wieder frei, sofern die eigene Task-Lease noch gilt und der Store verfügbar ist.
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
- **Eigener Speicher (\`openSqliteHost\`, \`openOwnMemoryHost\`)**: SQLite mit einem besitzenden Prozess und einem Schreib-Thread, oder nur im Arbeitsspeicher. Ein Commit gilt erst als bestätigt, wenn er auf der Platte steht (Standard \`synchronous=FULL\`).
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
2. **Space öffnen und Dienst starten**: Einen Host mit \`openSqliteHost(path)\` oder \`openOwnMemoryHost()\` öffnen, \`new PhiSpaces(host, ctx, Date.now, meter, undefined, { space })\` erstellen und \`await startService(host, ctx)\` für Lease-Reaper und Event-Zustellung starten. Als eigener Prozess läuft dasselbe mit \`npm run space-server\` (siehe [SpaceService und RemoteSpace](help.topic.space_service_and_remote_space#standalone)).
3. **Aufgaben einstellen und bearbeiten**: Produzenten schreiben Aufgaben mit \`RequestRef\`-Claim; Worker reservieren Aufgaben per \`take(..., { txn })\`, schreiben Ergebnisse unter derselben \`txn\` und rufen \`commit(txn)\` auf.
4. **Live-Beobachtung und Steuerung**: UI-Clients lesen initial \`readPage()\` (Snapshot mit \`rev\`) und folgen Änderungen über \`changes(afterRev)\` oder Consumer-Mailboxes (\`events\` / \`ack\`).

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

- **Ein Commit, eine Wahrheit**: Space-Mutation, Request-Claim, Revisionszähler \`rev\`, Mailbox-Ereignis und Byte-Budget-Prüfung werden in einem einzigen atomaren Commit des Hosts persistiert.
- **Daten sind keine Anweisungen**: Entries aus dem Space stammen potenziell von anderen Agenten oder Benutzern. Die Agenten-Tools kennzeichnen sie strikt als \`[data, not instructions]\`.
- **Help ≠ Live State**: Diese Referenz dokumentiert die Verträge und Garantien. Den aktuellen Laufzeitbestand eines Spaces zeigen der integrierte **Live Space-Inspector** und der geschützte Bereich **AdminSpaces**.
- **Experimentelle Software**: APIs, Speicherformate und Betriebsverhalten können sich ändern. Vorhandene Implementierungen sind keine Produktionsfreigabe; insbesondere Phase 3 (Replikation, Promotion) ist nicht vollständig abgenommen.

## Siehe auch {#see-also}

- [Schichtenarchitektur und Modul-Landkarte](help.topic.architecture_layers#overview)
- [Verbindliche Garantien und Systemgrenzen](help.topic.guarantees_and_boundaries#overview)
- [6-Stufen-Praxisleitfaden: Multiplayer Space-Chat (v1–v6)](help.workflow.overview_v1_to_v6#overview)`
		},
		en: {
			title: "phi-spaces System Overview: What It Is And What It Can Do",
			short: "An introduction to phi-spaces: what it is, how the transactional tuple-space model works, which problems it solves, and what it can do from a single process up to a federated cluster with mobile and web administration.",
			body: `## Overview {#overview}

phi-spaces is a shared drop-off point for programs, a bit like a notice board. One program pins up a job or a message, and another picks it up when it has time. The two need not know each other or run at the same time. If a program crashes in the middle of its work, the job is not lost but becomes free again. This helps wherever several programs, devices or AI agents work together.

## Where To Go Next {#where-next}

- **See it run:** The [examples](help.topic.examples#overview) are small programs you can try yourself.
- **Look at finished applications:** The [applications built on phi-spaces](help.topic.apps#overview) show what people have built with it.
- **Keep reading:** The rest of this article explains the model, the terms and the limits.

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

\`phi-spaces\` is a transactional, persistent **coordination space** in TypeScript, built on the Linda / JavaSpaces model. It has a store of its own: one SQLite file owned by exactly one process, or memory only. The library needs no agent framework. The optional \`agent/\` package gives \`@earendil-works/pi-durable\` agents tools for the space; pi-durable is no longer the space's storage, and old pi-durable stores are not taken over. Instead of coupling clients, background workers, AI agents, and administrative tools through point-to-point calls, every participant exchanges immutable, typed JSON objects (**entries**) through shared, versioned data spaces (**spaces**).

The library solves four problems in building long-running systems and groups of AI agents:

1. **Fault-Tolerant Work Handoff (Leased Reservations)**: A server, UI client, or agent does not call a worker directly; it writes a task entry (\`type: "ChatTask"\` or similar) into the space. Any worker can then **reserve** that task exclusively (\`take\`). If the worker crashes before finishing, the expired lease automatically returns the task, provided the task's own lease remains valid and its store is available.
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
- **A Store Of Its Own (\`openSqliteHost\`, \`openOwnMemoryHost\`)**: SQLite with one owning process and one writer thread, or memory only. A commit counts as acknowledged only once it is on disk (default \`synchronous=FULL\`).
- **Leases & Automatic Reaper (\`startService\`)**: Entries, presence records, and \`TimerLock\` locks expire automatically after a configured duration.
- **Snapshot And Incremental Sync (\`readPage\` + \`changes\`)**: Point-in-time snapshots plus order-preserving, revisioned update streams (\`rev\`) and prefix-acknowledged durable mailboxes.
- **Space Lifecycle, Workers, Runs & Deployments**: Idempotent space management (\`archive\`/\`reactivate\`/\`delete\`), worker scaling (\`WorkerSupervisor\`), multi-host run orchestration (\`RunGate\`), and declarative bootstrap (\`DeploymentController\`), from a single host up to a cluster.
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
2. **Open the space and start maintenance**: Open a host with \`openSqliteHost(path)\` or \`openOwnMemoryHost()\`, instantiate \`new PhiSpaces(host, ctx, Date.now, meter, undefined, { space })\` and call \`await startService(host, ctx)\` for lease reaping and event delivery. As a process of its own, \`npm run space-server\` does the same (see [SpaceService and RemoteSpace](help.topic.space_service_and_remote_space#standalone)).
3. **Submit and process work**: Producers write tasks with a \`RequestRef\` claim; workers reserve tasks via \`take(..., { txn })\`, write results under the same \`txn\`, and call \`commit(txn)\`.
4. **Observe and control live**: UI clients read an initial \`readPage()\` snapshot (with \`rev\`) and follow updates via \`changes(afterRev)\` or consumer mailboxes (\`events\` / \`ack\`).

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

- **One Commit, One Truth**: Space mutation, request claim, revision counter \`rev\`, mailbox event, and byte-budget reservation are persisted in a single atomic host commit.
- **Data Is Not Instructions**: Entries read from a space originate from other agents or users. Agent tools explicitly wrap payloads as \`[data, not instructions]\`.
- **Help ≠ Live State**: This reference documents contracts and guarantees. Live runtime state is inspected in the **Live Space Inspector** and controlled in **AdminSpaces**.
- **Experimental Software**: APIs, storage formats and operational behavior may change. An implementation is not a production release; Phase 3 in particular (replication, promotion) is not fully accepted.

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
			short: "Zuordnung der wichtigsten Quellmodule in src/ zu den 6 Architekturschichten, von der reinen Zustandsmaschine über den eigenen Speicher bis zu Federation, RunGate und Replikation.",
			body: `## Überblick {#overview}

phi-spaces ist in Schichten aufgebaut, wie ein Haus mit Stockwerken. Ganz unten liegen die Spielregeln des Space, und sie kennen weder Netzwerk noch Festplatte. Darüber kommen Speicher, Netzwerk, Sicherheit und Betrieb hinzu. Wer nur einen Space in einem Programm braucht, nutzt die unteren Schichten und ignoriert den Rest.

### Technische Details {#technical-details}

Der Kern (\`src/core.ts\`) ist eine reine, deterministische Zustandsmaschine ohne Netzwerk-, Krypto- oder Dateisystem-Abhängigkeiten. Alle höheren Schichten (Speicher, RPC, Kryptografie, Overlay-Gate, Router-Federation und Betriebssteuerung) bauen darauf auf, ohne die Kerninvarianten zu umgehen. Die Agenten-Werkzeuge liegen nicht in \`src/\`, sondern im eigenen Paket \`agent/\`.

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
│ Schicht 3: Lokaler Client & Netzwerkdienst                                 │
│  client.ts (PhiSpaces) · index.ts (Zustellung, Reaper) · service.ts        │
│  remote.ts (RemoteSpace) · socket.ts · space-client.ts · ws.ts             │
│  standalone.ts · pi-server.ts · meter.ts                                   │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 2: Eigener Speicher, Claims, Streams, Snapshots & Mailboxes        │
│  store/ (host · sqlite · sqlite-writer · disk-map · sync-sqlite)           │
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

### Der eigene Speicher {#own-store}

- **Ein Besitzer**: \`openSqliteHost(path)\` nimmt eine Sperre in \`path.owner\`. Ein zweiter Prozess erhält \`StoreUnavailable\`, ebenso jede Datei, die kein phi-spaces-Speicher ist.
- **Ein Schreib-Thread**: Commits laufen geordnet und werden in SQLite-Transaktionen gebündelt. Antworten warten auf das dauerhafte Schreiben (WAL, Standard \`synchronous=FULL\`, \`NORMAL\` ist wählbar). Scheitert das Schreiben, sperrt sich der Host.
- **Große Sammlungen getrennt**: Entries und andere große Teile liegen in eigenen Zeilen. Request-Claims bleiben auf der Platte und werden gezielt gelesen (\`disk-map.ts\`).
- **Speicherbudget**: Über \`memoryBudget\` (Standard 40 000 Datensätze) verdrängt der Host die am längsten unberührten Dokumente und liest sie bei Bedarf neu. Dokumente, die innerhalb von \`hotMs\` (Standard 250 ms) benutzt wurden, bleiben.
- **Datei verdichten**: \`OwnStoreHost.compact()\` gibt freie Seiten der Datei zurück. Der erste Aufruf schreibt sie einmal mit \`VACUUM\` um, danach werden nur freie Seiten abgeschnitten. Ein Store im Speicher antwortet \`null\`.
- **Optionen für Dauerlast**: \`OwnStoreHost.skipUnchangedRecords\` überspringt unveränderte Datensätze großer Sammlungen. Die Option ist standardmäßig aus.
- **Nur im Arbeitsspeicher**: \`openOwnMemoryHost()\` für Tests und Wegwerf-Spaces.

JSONL ist kein Speicher des Space mehr. pi-durable-Stores werden nicht importiert (Entscheidung D6). Nur das Agenten-Paket nutzt pi-durable und dessen eigene Speicher; siehe [Agent-Werkzeuge](help.topic.agent_tools_and_replay#two-stores).

### Rust-Portierung {#rust-port}

Das laufende System ist TypeScript. Im Ordner \`rust/\` entstehen \`phi-json\`, \`phi-core\` und \`phi-store\` (\`docs/rust-portierung.md\`). R0 (Verträge festschreiben) ist umgesetzt, die Scheiben von R1 (Kern) und die Scheiben 0–4 von R2 (Speicher) sind erledigt. Speicherbudget und mehrere Spaces sind auf R3 verschoben. Einen Rust-Server gibt es noch nicht: Er ist R3.

## Technische Referenz {#technical-reference}

| Schicht | Zentrale Dateien | Öffentliche Haupttypen & Exporte |
|---|---|---|
| **1. Core & Docs** | \`src/core.ts\`, \`src/doc.ts\`, \`src/spaces.ts\` | \`core\`, \`Space\`, \`NamedSpace\`, \`Registry\`, \`createSpace\`, \`listSpaces\`, \`DEFAULT_LIMITS\` |
| **2. Speicher, Claims & Streams** | \`src/store/\`, \`src/claims.ts\`, \`src/stream.ts\`, \`src/mailbox.ts\` | \`openSqliteHost\`, \`openOwnMemoryHost\`, \`OwnStoreHost\`, \`RequestRef\`, \`ClaimView\`, \`argHash\`, \`MailboxPage\`, \`principalId\` |
| **3. Client & RPC** | \`src/client.ts\`, \`src/index.ts\`, \`src/service.ts\`, \`src/remote.ts\`, \`src/socket.ts\`, \`src/space-client.ts\`, \`src/ws.ts\` | \`PhiSpaces\`, \`startService\`, \`SpaceService\`, \`RemoteSpace\`, \`serveSpace\`, \`socketTransport\`, \`connectSpace\`, \`upgradeWebSocket\` (\`phi-spaces/ws\`) |
| **4. Gate & Recovery** | \`src/gate.ts\`, \`src/auth.ts\`, \`src/enroll.ts\`, \`src/grants.ts\`, \`src/runtime.ts\`, \`src/boot.ts\`, \`src/restore.ts\` | \`startGate\`, \`ProvingService\`, \`EnrollmentService\`, \`GrantAuthority\`, \`GrantVerifier\`, \`startFederationHost\`, \`installBootGuard\`, \`RecoveryController\` |
| **5. Federation** | \`src/router.ts\`, \`src/delegation.ts\`, \`src/federation-policy.ts\`, \`src/federated-space.ts\`, \`src/membership.ts\` | \`RouterController\`, \`createFederationController\`, \`FederatedSpace\`, \`MembershipController\`, \`DistributedPrincipalErasure\` |
| **6. Operations & Sync** | \`src/run-controller.ts\`, \`src/workers.ts\`, \`src/space-lifecycle.ts\`, \`src/deployment.ts\`, \`src/alerts.ts\`, \`src/entry-replication.ts\` | \`RunController\`, \`WorkerSupervisor\`, \`SpaceLifecycle\`, \`DeploymentController\`, \`collectAlerts\`, \`EntryReplicationController\` |

## Siehe auch {#see-also}

- [phi-spaces Systemüberblick](help.topic.overview#overview)
- [Verbindliche Garantien und Systemgrenzen](help.topic.guarantees_and_boundaries#overview)`
		},
		en: {
			title: "Architecture Layers and Module Map",
			short: "Mapping of the main source modules in src/ across the 6 architecture layers, from the pure state machine and the own store to federation, RunGate, and replication.",
			body: `## Overview {#overview}

phi-spaces is built in layers, like a house with several floors. At the bottom sit the rules of the space, which know nothing about networks or disks. Storage, networking, security and operations are added on top. If you only need a space inside one program, you use the lower layers and ignore the rest.

### Technical Details {#technical-details}

The core (\`src/core.ts\`) is a pure, deterministic state machine with no network, cryptography, or filesystem dependencies. All higher layers (storage, RPC, cryptography, overlay gate, router federation, and operations control) build on top of it without bypassing core invariants. The agent tools are not in \`src/\` but in the separate \`agent/\` package.

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
│ Layer 3: Local Client & Network Service                                    │
│  client.ts (PhiSpaces) · index.ts (delivery, reaper) · service.ts          │
│  remote.ts (RemoteSpace) · socket.ts · space-client.ts · ws.ts             │
│  standalone.ts · pi-server.ts · meter.ts                                   │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Own Store, Claims, Streams, Snapshots & Mailboxes                 │
│  store/ (host · sqlite · sqlite-writer · disk-map · sync-sqlite)           │
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

### The Own Store {#own-store}

- **One owner**: \`openSqliteHost(path)\` takes a lock in \`path.owner\`. A second process gets \`StoreUnavailable\`, and so does any file that is not a phi-spaces store.
- **One writer thread**: Commits run in order and are bundled into SQLite transactions. Replies wait for the durable write (WAL, default \`synchronous=FULL\`, \`NORMAL\` can be chosen). If a write fails, the host locks itself.
- **Large collections kept apart**: Entries and other large parts live in rows of their own. Request claims stay on disk and are read by key (\`disk-map.ts\`).
- **Memory budget**: With \`memoryBudget\` (default 40 000 records) the host drops the documents untouched for longest and reads them back when needed. Documents used within \`hotMs\` (default 250 ms) stay.
- **Compacting the file**: \`OwnStoreHost.compact()\` gives free pages of the file back. The first call rewrites it once with \`VACUUM\`; later calls cut off only the free pages. A store in memory answers \`null\`.
- **Options for sustained load**: \`OwnStoreHost.skipUnchangedRecords\` skips unchanged records of large collections. It is off by default.
- **Memory only**: \`openOwnMemoryHost()\` for tests and throwaway spaces.

JSONL is no longer a store of the space. pi-durable stores are not imported (decision D6). Only the agent package uses pi-durable and its own stores; see [agent tools](help.topic.agent_tools_and_replay#two-stores).

### Rust Port {#rust-port}

The running system is TypeScript. The \`rust/\` folder is growing \`phi-json\`, \`phi-core\` and \`phi-store\` (\`docs/rust-portierung.md\`). R0 (fixing the contracts) is done, and the slices of R1 (core) and slices 0–4 of R2 (store) are finished. The memory budget and several spaces are deferred to R3. There is no Rust server yet: that is R3.

## Technical Reference {#technical-reference}

| Layer | Key Files | Public Types & Exports |
|---|---|---|
| **1. Core & Docs** | \`src/core.ts\`, \`src/doc.ts\`, \`src/spaces.ts\` | \`core\`, \`Space\`, \`NamedSpace\`, \`Registry\`, \`createSpace\`, \`listSpaces\`, \`DEFAULT_LIMITS\` |
| **2. Store, Claims & Streams** | \`src/store/\`, \`src/claims.ts\`, \`src/stream.ts\`, \`src/mailbox.ts\` | \`openSqliteHost\`, \`openOwnMemoryHost\`, \`OwnStoreHost\`, \`RequestRef\`, \`ClaimView\`, \`argHash\`, \`MailboxPage\`, \`principalId\` |
| **3. Client & RPC** | \`src/client.ts\`, \`src/index.ts\`, \`src/service.ts\`, \`src/remote.ts\`, \`src/socket.ts\`, \`src/space-client.ts\`, \`src/ws.ts\` | \`PhiSpaces\`, \`startService\`, \`SpaceService\`, \`RemoteSpace\`, \`serveSpace\`, \`socketTransport\`, \`connectSpace\`, \`upgradeWebSocket\` (\`phi-spaces/ws\`) |
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

Dieser Artikel sagt, worauf du dich verlassen kannst und worauf nicht. Ein einmal bestätigter Eintrag übersteht zum Beispiel einen Neustart. Eine E-Mail, die dein Programm verschickt, schützt phi-spaces dagegen nicht vor doppeltem Versand. Wer diese Grenze kennt, baut die eigene Anwendung passend dazu.

### Technische Details {#technical-details}

Die Garantien und Grenzen sind ausdrücklich benannt und durch Tests auf dem eigenen Speicher belegt (SQLite und im Arbeitsspeicher). Tests decken bestimmte Szenarien ab, nicht jede Art von Ausfall. Maßgeblich sind die öffentliche API (\`docs/api.md\`) und der Vertragsrahmen (\`docs/federation-plan-v3.md\`).

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

### Garantienmatrix {#guarantee-matrix}

| Ebene | Verbindlicher Vertrag in \`phi-spaces\` | Was ausdrücklich NICHT daraus folgt |
|---|---|---|
| **Lokaler Commit** | Space-Mutation, RPC-Claim, Revisionsnummer \`rev\` und Mailbox-Event werden unteilbar zusammen gespeichert. | Keine externe Exactly-once-Wirkung für HTTP-Calls, E-Mails oder LLM-Tokenkosten außerhalb des Spaces. |
| **Dauerhaftigkeit** | Eine Erfolgsantwort folgt dem dauerhaften Commit, im Standard mit \`synchronous=FULL\`. Scheitert das Schreiben, sperrt sich der Host, statt weiter zu bestätigen. | Kein Schutz gegen defekte Datenträger oder Controller mit falschen Flush-Zusagen. Prozessabsturz-Tests belegen keinen echten Stromausfall. Sicherung und Replikation sind eigene Fragen. |
| **Wohlgeformter Text** | \`SpaceService\` ersetzt ein unpaariges Surrogat in jedem String und Schlüssel durch U+FFFD, bevor etwas den Aufruf sieht, auch der Argument-Hash. | Gilt für Aufrufe über den Dienst. Direkte Aufrufe von \`PhiSpaces\` laufen nicht durch diesen Schritt; Text deshalb mit \`cutText\` kürzen statt mit \`slice\`. |
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

- **\`OutcomeUnknown\`**: Tritt auf, wenn die Client-Wartezeit (\`maxClientWaitMs\`) abläuft oder die Verbindung vor Empfang der Antwort abreißt. **Wichtig:** \`OutcomeUnknown\` ist kein Fehlerbeweis. Der Client muss mit derselben \`requestId\` über \`pollOperation\` nachfragen.
- **\`RequestConflict\`**: Dieselbe \`requestId\` wurde mit veränderten fachlichen Argumenten erneut gesendet.
- **\`ResourceExhausted\`**: Eine Transaktionserweiterung würde das Commit-/Abort-Bytebudget (\`192 KiB\`) oder die Dokumentgrenze überschreiten; die bisherige Transaktion bleibt abbrechbar bzw. abschließbar.
- **\`RequestExpired\`**: Die Generation nimmt keine neuen Anfragen mehr an und die Anfrage wurde noch nicht aufgenommen.
- **\`StoreUnavailable\`**: Ein anderer Prozess besitzt den Speicher, oder die Datei ist kein phi-spaces-Speicher. Alte pi-durable-Stores gehören dazu.

## Siehe auch {#see-also}

- [Request-Claims, Generationen und Idempotenz](help.topic.request_claims_and_generations#overview)
- [Overlay-Gate, Authentisierung, Grants und Recovery](help.topic.gate_auth_grants_and_recovery#overview)`
		},
		en: {
			title: "Binding Guarantees and System Boundaries",
			short: "What phi-spaces strictly guarantees for local commits, retries, transactions, restores, and federation, and what is intentionally out of scope.",
			body: `## Overview {#overview}

This article says what you can rely on and what you cannot. An entry that was acknowledged survives a restart, for example. An email your program sends, on the other hand, is not protected from being sent twice. Knowing this boundary lets you design your own application around it.

### Technical Details {#technical-details}

The guarantees and boundaries are named explicitly and backed by tests on the own store (SQLite and memory). Tests cover specific scenarios, not every kind of failure. The public API (\`docs/api.md\`) and the contract (\`docs/federation-plan-v3.md\`) are authoritative.

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

### Guarantee Matrix {#guarantee-matrix}

| Layer | Binding Contract in \`phi-spaces\` | What Does Explicitly NOT Follow |
|---|---|---|
| **Local Commit** | Space mutation, RPC claim, revision \`rev\`, and mailbox event are persisted atomically together. | No external exactly-once guarantee for HTTP calls, emails, or LLM token costs outside the space. |
| **Durability** | A success reply follows the durable commit, by default with \`synchronous=FULL\`. If a write fails, the host locks itself instead of acknowledging further. | No protection against faulty disks or controllers with false flush promises. Process-crash tests do not prove a real power loss. Backup and replication are separate questions. |
| **Well-Formed Text** | \`SpaceService\` replaces an unpaired surrogate in any string or key with U+FFFD before anything sees the call, the argument hash included. | Applies to calls through the service. Direct calls of \`PhiSpaces\` do not pass this step, so cut text with \`cutText\`, not \`slice\`. |
| **Idempotent Retry** | Identical \`{ principal, generation, requestId }\` with matching RFC-8785 argument hash returns the stored result across process restarts without repeating the mutation. | After retention expiry (default 24 h), a retry returns \`ResultExpired\` without re-executing. |
| **Take under Txn** | At most one active reservation per entry; \`abort\` or lease expiry returns the entry to the space. | No global FIFO ordering across competing consumers. |
| **CompletionProfile** | A take-transaction commit is rejected server-side with \`CompletionViolation\` unless result type, matching fields, and count match. | No semantic validation of payload quality by the space core. |
| **Data Restore (5.2.2)** | Increments data incarnation; old generations fail with \`IncarnationChanged\`; restored exclusive tasks are quarantined as \`restoredUnverified\` until \`releaseRestored\`. | Restoring from an asynchronous backup is **not** a lossless promotion. |
| **Operating Limits (Gate 4)** | Frame max 256 KiB, commit batch max 192 KiB, entry max 64 KiB, max 32 connections per peer / 64 per listener, peer identification 5 s, grant max 60 s. | No unbounded batch transactions; large preparations split into idempotent sub-commits. |

### The Three Distinct Epoch Counters {#three-epochs}

Using the word "epoch" without a qualifier is invalid in \`phi-spaces\`. There are two numeric counters and one separate opaque mailbox identity:

1. **\`primaryEpoch\`**: Scoped to a logical space for replication or data restore (+1 on data restore, promotion, or single-mode switch; resets to 1 under a new \`authorityId\` after control restore).
2. **\`routerEpoch\`**: Scoped to \`RouterLease\` issuance in a federation (+1 on router restart or failover).
3. **\`mailboxEpoch\`**: An opaque consumer-mailbox string identity. Reset changes the token; compare equality, never increment or order it numerically.

## Failures And Diagnostics {#failures-and-diagnostics}

- **\`OutcomeUnknown\`**: Raised when \`maxClientWaitMs\` elapses or the transport drops before a reply arrives. **Critical:** \`OutcomeUnknown\` does not mean the operation failed. The client must poll with the same \`requestId\` via \`pollOperation\`.
- **\`RequestConflict\`**: The same \`requestId\` was reused with different arguments.
- **\`ResourceExhausted\`**: Extending a transaction would exceed the commit/abort byte budget (\`192 KiB\`) or document quota; prior transaction work remains committable or abortable.
- **\`RequestExpired\`**: The generation no longer admits new requests and this request was not admitted yet.
- **\`StoreUnavailable\`**: Another process owns the store, or the file is not a phi-spaces store. Old pi-durable stores are among those.

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

Ein Entry ist wie ein Zettel mit einer Überschrift und ein paar Angaben darauf. Ein Template beschreibt, was du suchst, zum Beispiel alle Zettel mit der Überschrift „Auftrag“ für ein bestimmtes Projekt. Angaben, die du offen lässt, passen auf alles. So finden Programme Daten über ihren Inhalt statt über eine Adresse.

### Technische Details {#technical-details}

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
- Text in einem Entry ist wohlgeformt: Über den Dienst wird ein unpaariges Surrogat zu U+FFFD. Wer Text selbst kürzt, nimmt \`cutText(text, max)\`, das kein halbes Emoji stehen lässt.

### Schreiboptionen {#write-options}

- **\`unique: ["feld"]\`**: \`write\` prüft atomar, ob schon ein Entry desselben konkreten Typs dieselben Schlüsselfelder trägt, auch reserviert oder noch uncommitted. Sonst folgt \`UniqueConflict\`. Das ist eine Prüfung dieses einen Writes, kein dauerhafter Index, und sie gilt je Space.
- **\`transient: true\`**: Es entsteht kein Entry. Der Änderungsstrom trägt den Wert als \`put\` mit \`transient: true\`, aber kein \`read\`, \`take\`, \`wait\`, \`count\` oder Abo sieht ihn. Gedacht für Ausgaben, die nur Leser des Stroms brauchen. Nicht zusammen mit \`unique\`.

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

// Findet eine Nachricht im Thread "main", unabhängig von seq oder author
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

An entry is like a note with a heading and a few details on it. A template describes what you are looking for, for example every note headed "job" for a certain project. Details you leave open match anything. This way programs find data by its content rather than by an address.

### Technical Details {#technical-details}

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
- Text in an entry is well-formed: through the service, an unpaired surrogate becomes U+FFFD. If you cut text yourself, use \`cutText(text, max)\`, which never leaves half an emoji.

### Write Options {#write-options}

- **\`unique: ["field"]\`**: \`write\` checks atomically whether an entry of the same concrete type already carries the same key fields, even if reserved or still uncommitted. If so, it fails with \`UniqueConflict\`. This is a check of this one write, not a lasting index, and it holds per space.
- **\`transient: true\`**: No entry is created. The change stream carries the value as a \`put\` with \`transient: true\`, but no \`read\`, \`take\`, \`wait\`, \`count\` or subscription ever sees it. It is meant for output only stream readers need. It cannot be combined with \`unique\`.

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

// Find one message in thread "main" regardless of seq or author
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

Programme stürzen ab und Verbindungen reißen. Deshalb bekommt man im Space alles nur auf Zeit: Wer sich nicht mehr meldet, verliert es automatisch wieder. Mehrere Schritte lassen sich außerdem bündeln, sodass entweder alle gelten oder keiner. So bleibt nichts halb fertig liegen.

### Technische Details {#technical-details}

Dafür gibt es zwei Mechanismen: **Leases** (zeitlich begrenzte Lebensdauer für Entries, Transaktionen, Waiter und Abos) und **Space-Transaktionen** (atomare Gruppierung von \`take\`-Reservierungen und \`write\`-Entwürfen).

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
2. **\`take(template, timeout, { txn: txn.id })\`**: Der entnommene Entry wird **reserviert** (für alle anderen unsichtbar gesperrt). Erst \`commit(txn.id)\` entfernt ihn endgültig. Bei \`abort(txn.id)\` oder wenn die Transaktions-Lease abläuft, wird die Reservierung aufgehoben und der Entry ist wieder für andere Worker verfügbar. Ohne \`txn\` entfernt \`take\` den Entry sofort.
3. **\`read\` vs. \`readIfExists\` / \`take\` vs. \`takeIfExists\`**:
   - \`read\` und \`take\` warten bis \`timeout\`, falls noch kein passender Entry existiert.
   - \`readIfExists\` und \`takeIfExists\` kehren sofort mit \`null\` zurück, wenn kein passender Entry im Space liegt. Sie warten **nur** dann bis \`timeout\`, wenn ein passender Entry zwar existiert, aber gerade durch eine fremde Transaktion gesperrt ist.

### Fehlt der Entry oder ist er nur gesperrt? {#typed-misses}

Ein \`null\` sagt nicht, warum nichts kam. \`probe(template, timeout, { take? })\` liefert deshalb \`{ entry, locked }\`: \`locked\` ist gesetzt, wenn Treffer existieren, aber jeder von einer anderen Transaktion gehalten wird. \`probe\` ist eine optionale Fähigkeit von \`SpaceLike\`; \`PhiSpaces\` und \`RemoteSpace\` bieten sie an.

Bequemer sind \`readExisting\` und \`takeExisting\` aus den Client-Helfern: \`null\` heißt weg, ein Fehlschlag nur wegen gehaltener Treffer wirft \`StillHeld\`. Ohne \`probe\` gilt \`null\` als weg.

### Lange Arbeit und mehrere Schritte {#long-work-and-batches}

- **\`keepAlive(space, lease, leaseMs)\`** erneuert eine Lease alle \`leaseMs / 3\`, solange lange Arbeit darin läuft, und liefert die Stopp-Funktion.
- **\`batch(ops, { request? })\`** führt bis zu 64 Schritte (\`begin\`, \`write\`, \`take\`, \`read\`, \`commit\`, \`abort\`) in einem Commit aus, alle oder keiner. \`txn: "$"\` meint die Transaktion, die ein \`begin\` weiter vorn im selben Batch geöffnet hat. Das kostet eine Runde statt einer je Schritt. \`take\` und \`read\` warten im Batch nie.

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
  await space.commit(txn.id); // Atomar: ChatTask verschwindet, Msg wird sichtbar
} catch (err) {
  await space.abort(txn.id); // ChatTask kehrt in den Space zurück
  throw err;
}
\`\`\`

\`\`\`ts
import { readExisting, StillHeld } from "phi-spaces";

// Unterscheidet "weg" von "gerade von jemand anderem gehalten":
try {
  const job = await readExisting(space, { type: "Job" }, 1_000);
  if (job === null) console.log("Kein Job mehr da");
} catch (err) {
  if (!(err instanceof StillHeld)) throw err;
  console.log("Job wird gerade bearbeitet");
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

Programs crash and connections drop. So everything in a space is only held for a limited time: whoever stops checking in loses it automatically. Several steps can also be grouped, so that either all of them count or none does. This way nothing stays half finished.

### Technical Details {#technical-details}

Two mechanisms provide this: **leases** (bounded lifetimes for entries, transactions, waiters, and subscriptions) and **space transactions** (atomic grouping of \`take\` reservations and \`write\` drafts).

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
2. **\`take(template, timeout, { txn: txn.id })\`**: The matching entry is **reserved** (locked and invisible to others). Only \`commit(txn.id)\` deletes it permanently. On \`abort(txn.id)\` or transaction lease expiry, the reservation is released and the entry becomes available to other workers again. Without \`txn\`, \`take\` removes the entry at once.
3. **\`read\` vs. \`readIfExists\` / \`take\` vs. \`takeIfExists\`**:
   - \`read\` and \`take\` wait up to \`timeout\` if no matching entry exists yet.
   - \`readIfExists\` and \`takeIfExists\` return \`null\` immediately if no matching entry is present. They wait up to \`timeout\` **only** while matching entries are locked by another transaction.

### Is The Entry Gone Or Only Locked? {#typed-misses}

A \`null\` does not say why nothing came. \`probe(template, timeout, { take? })\` therefore returns \`{ entry, locked }\`: \`locked\` is set when matches exist but every one is held by another transaction. \`probe\` is an optional capability of \`SpaceLike\`; \`PhiSpaces\` and \`RemoteSpace\` offer it.

\`readExisting\` and \`takeExisting\` from the client helpers are easier to use: \`null\` means gone, and a miss caused only by held matches throws \`StillHeld\`. Without \`probe\`, \`null\` counts as gone.

### Long Work And Several Steps {#long-work-and-batches}

- **\`keepAlive(space, lease, leaseMs)\`** renews a lease every \`leaseMs / 3\` while long work runs inside it, and returns the stop function.
- **\`batch(ops, { request? })\`** runs up to 64 steps (\`begin\`, \`write\`, \`take\`, \`read\`, \`commit\`, \`abort\`) in one commit, all or none. \`txn: "$"\` names the transaction a \`begin\` earlier in the same batch opened. This costs one round instead of one per step. \`take\` and \`read\` never wait inside a batch.

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
  await space.commit(txn.id); // Atomic: ChatTask is removed, Msg becomes visible
} catch (err) {
  await space.abort(txn.id); // ChatTask returns to the space
  throw err;
}
\`\`\`

\`\`\`ts
import { readExisting, StillHeld } from "phi-spaces";

// Tells "gone" from "held by someone else right now":
try {
  const job = await readExisting(space, { type: "Job" }, 1_000);
  if (job === null) console.log("No job left");
} catch (err) {
  if (!(err instanceof StillHeld)) throw err;
  console.log("The job is being worked on");
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

Ein Worker nimmt sich einen Auftrag und soll ein Ergebnis abliefern. Hier legst du fest, dass er den Auftrag nur abschließen kann, wenn das Ergebnis wirklich da ist. Ein fehlerhaftes Programm oder ein KI-Agent kann eine Aufgabe so nicht einfach verschwinden lassen. Dazu kommen Größengrenzen, damit kein Teilnehmer den Space volllaufen lässt.

### Technische Details {#technical-details}

Der Space erzwingt das serverseitig mit **\`CompletionProfiles\`** und strikten **Byte- und Objekt-Budgets (\`DEFAULT_LIMITS\`)**. Beides gilt auch dann, wenn ein Worker sich nicht an die Absprachen hält.

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

Versucht ein Worker \`commit(txn)\` aufzurufen, ohne dass für den genommenen \`ChatTask\` in derselben Transaktion mindestens ein und höchstens \`maxResultCount\` passende Ergebnisse mit identischer \`taskId\` und \`threadId\` geschrieben wurden, wirft der Space-Kern \`CompletionViolation\`. Mit \`maxResultCount: 1\` heißt das: genau eine \`Msg\`. Die Transaktion bleibt offen und kann korrigiert oder mit \`abort(txn)\` zurückgerollt werden.

Weitere Regeln eines Profils:

- Ein Task mit Profil lässt sich nur unter einer Transaktion nehmen; ohne \`txn\` folgt ebenfalls \`CompletionViolation\`.
- Ein Ergebnis-Entry in der Transaktion, das zu keinem genommenen Task passt, verhindert den Commit (\`unmatched completion result\`).
- \`maxResultBytes\` begrenzt die Summe der Ergebnisse eines Tasks.
- \`maxLeaseMs\` begrenzt, wie weit die Transaktions-Lease reichen darf.
- \`gateField\` bindet Tasks an den RunGate ihres Laufs. Das Feld muss in \`equalFields\` stehen, und \`maxLeaseMs\` ist dann Pflicht.

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
| \`maxOutboxBytes\` | \`8 MiB\` | Budget für noch nicht zugestellte Events; darüber werden neue Abos und Waits abgewiesen, kein Event geht verloren |
| \`maxMailboxBytes\` | \`8 MiB\` | Budget der Consumer-Mailboxes (\`mailboxTtlMs\` standardmäßig und höchstens 7 Tage) |
| \`maxLogBytes\` | \`4 MiB\` | Revisionslog für \`changes\` |
| \`maxSnapshotBytes\` | \`64 MiB\` | Snapshot-Cache für \`readPage\` (höchstens \`maxSnapshots\` = 16, \`snapshotTtlMs\` = 60 s) |
| \`maxJobBytes\` | \`16 MiB\` | Budget für ausstehende Fanout-Jobs und Abschlussreservierungen |
| \`maxDocBytes\` | \`128 MiB\` | Gesamtdokumentgröße eines Spaces |

Dazu kommen Zeitvorgaben: \`claimResultMs\` hält Ergebnisse von Request-Claims 24 Stunden, \`generationAdmitMs\` lässt eine Generation 1 Stunde neue Anfragen zu, und \`notifyIntervalMs\` bündelt Abo-Benachrichtigungen auf höchstens eine pro Sekunde. Je Owner gelten standardmäßig höchstens 20 Registrierungen, 20 Waiter und 20 Transaktionen.

Vor **jeder** Erweiterung einer Transaktion reserviert \`core.ts\` die konservativen Kosten für **Commit und Abort**. Überschreitet ein Schritt das Budget, scheitert dieser Schritt sofort mit \`ResourceExhausted\`, sodass die bisherige Transaktion niemals beim abschließenden \`commit\` oder \`abort\` am Byte-Limit hängenbleibt.

## Siehe auch {#see-also}

- [Leases, Transaktionen und Sichtbarkeit](help.topic.leases_and_transactions#overview)
- [setCompletionProfiles & setLimits](help.api.phispaces_completion_profiles)`
		},
		en: {
			title: "CompletionProfiles and Resource Limits",
			short: "Server-side result verification when committing take transactions (CompletionProfile) and fixed byte and owner quotas (DEFAULT_LIMITS).",
			body: `## Overview {#overview}

A worker takes a job and is meant to deliver a result. Here you decide that it can only finish the job if the result is really there. A faulty program or an AI agent therefore cannot simply make a task disappear. Size limits are added so that no participant can fill up the space.

### Technical Details {#technical-details}

The space enforces this on the server side with **\`CompletionProfiles\`** and strict **byte and object budgets (\`DEFAULT_LIMITS\`)**. Both apply even if a worker does not stick to the agreement.

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

If a worker calls \`commit(txn)\` without having written at least one and at most \`maxResultCount\` matching results with the same \`taskId\` and \`threadId\` for the taken \`ChatTask\`, the core throws \`CompletionViolation\`. With \`maxResultCount: 1\` that means exactly one \`Msg\`. The transaction remains open so the caller can either write the missing result or roll back via \`abort(txn)\`.

Further rules of a profile:

- A task with a profile can only be taken under a transaction; without \`txn\` the result is \`CompletionViolation\` as well.
- A result entry in the transaction that matches no taken task prevents the commit (\`unmatched completion result\`).
- \`maxResultBytes\` limits the total size of a task's results.
- \`maxLeaseMs\` limits how far the transaction lease may reach.
- \`gateField\` binds tasks to the RunGate of their run. The field must be listed in \`equalFields\`, and \`maxLeaseMs\` is then required.

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
| \`maxOutboxBytes\` | \`8 MiB\` | Budget for undelivered events; above it new subscriptions and waits are refused, no event is dropped |
| \`maxMailboxBytes\` | \`8 MiB\` | Budget of the consumer mailboxes (\`mailboxTtlMs\` is 7 days by default and at most) |
| \`maxLogBytes\` | \`4 MiB\` | Revision log for \`changes\` |
| \`maxSnapshotBytes\` | \`64 MiB\` | Snapshot cache for \`readPage\` (at most \`maxSnapshots\` = 16, \`snapshotTtlMs\` = 60 s) |
| \`maxJobBytes\` | \`16 MiB\` | Budget for pending fanout jobs and completion reservations |
| \`maxDocBytes\` | \`128 MiB\` | Total document size of a space |

Time settings come on top: \`claimResultMs\` keeps request-claim results for 24 hours, \`generationAdmitMs\` lets a generation admit new requests for 1 hour, and \`notifyIntervalMs\` bundles subscription notices to at most one per second. Per owner the defaults allow at most 20 subscriptions, 20 waiters and 20 transactions.

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

Stell dir vor, du schickst ein Formular ab, und die Verbindung reißt, bevor die Antwort kommt. Schickst du es noch einmal, soll es nicht doppelt ankommen. Genau das regelt diese Funktion: Jeder Aufruf trägt eine feste Kennung, und der Space merkt sich das Ergebnis. Eine Wiederholung liefert das alte Ergebnis, statt die Arbeit noch einmal zu tun.

### Technische Details {#technical-details}

Der Mechanismus heißt **Request-Claims (\`src/claims.ts\`)** und gilt für **alle** Mutationen (\`write\`, \`take\`, \`createTransaction\`, \`commit\`, \`abort\`, \`renew\`, \`cancel\`, \`notify\`, \`wait\`, \`batch\`). Eine Anwendung muss dafür kein eigenes Quittungsdokument schreiben. Die Cloudflare-Vorlage zu \`pi-durable\` brauchte für \`conversation.create\` genau das: ein eigenes \`ConversationCommandReceipts\`-Dokument.

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

1. **Generation eröffnen (\`issueGeneration\`)**: Vor der ersten Mutation ruft der Client \`const { generation, admitUntil } = await space.issueGeneration(principal)\` auf. Die Generation ist per HMAC an Principal, \`spaceId\`, Dateninkarnation und \`authorityId\` gebunden und lässt standardmäßig 1 Stunde lang neue Anfragen zu.
2. **Kanonischer Argument-Hash (\`argHash\`)**: Für jeden Aufruf berechnet \`phi-spaces\` über \`canonicalJson\` (RFC 8785) den SHA-256-Hash ausschließlich über die **fachlichen Argumente** (ohne erneuerbare Rahmenfelder wie einen frischen 60-s-Grant).
3. **Atomare Speicherung**: Der Claim \`(principal, spaceId, generation, requestId)\` und das Operationsergebnis werden im selben Commit wie die Space-Mutation gespeichert.

### Verhalten bei Wiederholung (Retry) {#retry-behavior}

- **Gleiche \`requestId\` + gleiche Argumente**: Liefert sofort das gespeicherte Ergebnis zurück, ohne die Mutation ein zweites Mal auszuführen.
- **Gleiche \`requestId\` + andere Argumente**: Wirft \`RequestConflict\`.
- **Operation noch wartend (\`pending\`)**: Ein Retry oder \`pollOperation(request)\` hängt sich an denselben laufenden Waiter an, auch wenn der ursprüngliche Client-Prozess zwischendurch neu gestartet wurde. \`cancelOperation(request)\` beendet die Operation gezielt.
- **Generation nimmt nichts Neues mehr an**: Eine noch nicht aufgenommene Anfrage scheitert mit \`RequestExpired\`. Eine bekannte Anfrage liefert weiter ihr Ergebnis.
- **Aufbewahrung abgelaufen**: Nach \`claimResultMs\` (Standard 24 Stunden) liefert ein Retry \`ResultExpired\`, ohne erneut auszuführen.
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
// lease1.id === lease2.id: Es wurde genau EIN Thread-Entry erzeugt.
\`\`\`

## Siehe auch {#see-also}

- [Stufe 2 (v2-local-durable): Persistenz, RequestRef-Claims, Alarme & Subagent](help.workflow.stage_v2_local_durable#overview)
- [Request-Claims & Generationen API](help.api.phispaces_claims)`
		},
		en: {
			title: "Request Claims, Generations, and Idempotency",
			short: "How phi-spaces prevents duplicate mutations across connection drops or restarts using {principal, generation, requestId} and canonical RFC-8785 hashes.",
			body: `## Overview {#overview}

Imagine you submit a form and the connection drops before the answer arrives. If you submit it again, it should not arrive twice. This feature takes care of that: every call carries a fixed identifier, and the space remembers the result. A repeat returns the earlier result instead of doing the work again.

### Technical Details {#technical-details}

The mechanism is called **Request Claims (\`src/claims.ts\`)** and covers **every** mutation (\`write\`, \`take\`, \`createTransaction\`, \`commit\`, \`abort\`, \`renew\`, \`cancel\`, \`notify\`, \`wait\`, \`batch\`). An application does not need a receipt document of its own. The Cloudflare \`pi-durable\` reference needed exactly that for \`conversation.create\`: a custom \`ConversationCommandReceipts\` document.

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

1. **Open a Generation (\`issueGeneration\`)**: Before mutating, the client calls \`const { generation, admitUntil } = await space.issueGeneration(principal)\`. The generation is bound by HMAC to the principal, \`spaceId\`, data incarnation, and \`authorityId\`, and admits new requests for 1 hour by default.
2. **Canonical Argument Hash (\`argHash\`)**: For every call, \`phi-spaces\` computes an RFC-8785 canonical JSON hash over the **semantic arguments only** (excluding renewable envelope fields like a refreshed 60s grant).
3. **Atomic Persistence**: The claim \`(principal, spaceId, generation, requestId)\` and its result are committed atomically alongside the space mutation.

### Retry Semantics {#retry-behavior}

- **Same \`requestId\` + identical arguments**: Immediately returns the stored result without repeating the mutation.
- **Same \`requestId\` + different arguments**: Throws \`RequestConflict\`.
- **Operation still \`pending\`**: A retry or \`pollOperation(request)\` reattaches to the persistent waiter, even if the original caller process restarted in the meantime. \`cancelOperation(request)\` ends the operation on purpose.
- **Generation no longer admitting**: A request not admitted yet fails with \`RequestExpired\`. A known request still returns its result.
- **Retention expired**: After \`claimResultMs\` (default 24 hours), a retry returns \`ResultExpired\` without executing again.
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
// lease1.id === lease2.id: Exactly ONE Thread entry was created.
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

Eine Live-Ansicht, etwa ein Chat, muss zweierlei können: den aktuellen Stand laden und danach jede Änderung mitbekommen. Dafür gibt es zwei Werkzeuge. Das eine liefert ein Foto des Space, bei Bedarf in mehreren Seiten. Das andere liefert alles, was seit diesem Foto passiert ist. Zusammen geht nichts verloren.

### Technische Details {#technical-details}

\`phi-spaces\` kombiniert **unveränderliche Punkt-in-Zeit-Snapshots (\`readPage\`)** mit einem **monotonen Revisionsstrom (\`changes\`)**. So bleiben Oberflächen wie der Multiplayer Space-Chat oder das Space-Dashboard synchron.

## Begriffs- und Systemmodell {#concept-model}

### Konsistente Seiten mit readPage {#read-page}

\`\`\`ts
const page = await space.readPage(template, { maxBytes: 65536 });
// page = { items: EntryView[], next: string | null, token?: string, rev: number, streamId: string }
\`\`\`

- Passt die ganze Antwort auf eine Seite, entsteht **kein Snapshot** und kein \`token\`; \`next\` ist dann \`null\`, und die meisten Lesevorgänge sind damit erledigt.
- Passt sie nicht, legt die erste Seite im Space-Cache einen Snapshot zur Revision \`page.rev\` an (TTL: 60 s, max. 16 aktive Tokens / 64 MiB je Space).
- Folgeaufrufe mit \`space.readPage(template, { after: page.next, token: page.token })\` lesen garantiert **denselben unveränderlichen Snapshot**, selbst wenn parallel neue Entries geschrieben werden oder Leases ablaufen.
- Nach Host-Neustart oder Ablauf der 60-s-TTL wirft der nächste Seitenabruf \`SnapshotExpired\`; der Client liest dann einfach eine neue erste Seite.
- \`ResponseBudgetTooSmall\` meldet mit \`requiredBytes\`, dass das nächste Element nicht ins Budget passt. Der Cursor bleibt unverändert.
- \`readAll(template, { limit })\` listet nur so viele Treffer. Ohne Limit liefert es alle, älteste zuerst.

### Inkrementelles Aufholen mit changes(afterRev) {#changes-stream}

\`\`\`ts
const delta = await space.changes(page.rev, { maxBytes: 65536 });
// delta = { streamId: string, batches: ChangeBatch[], next: number, rev: number, more: boolean }
\`\`\`

- Jeder Commit im Space erhöht die Revision \`rev\` um 1.
- \`changes(afterRev)\` liefert alle seit \`afterRev\` sichtbar gewordenen Entry-Batches in Commit-Reihenfolge. Eine Seite enthält nur vollständige Batches.
- Mit \`waitMs\` wird daraus ein Long Poll: Die Antwort kommt beim ersten Batch oder nach Ablauf der Wartezeit.
- Ist das Revisionslog (\`maxLogBytes\`, Standard 4 MiB) bereits über \`afterRev\` hinaus rotiert, wirft der Aufruf \`SnapshotExpired\`, und der Client liest einen frischen \`readPage\`-Snapshot als neue Baseline. \`RevisionAhead\` meldet einen Cursor jenseits der aktuellen Revision.
- Ein \`write\` mit \`transient: true\` erscheint nur hier: als \`put\` mit \`transient: true\`, ohne Entry und ohne späteres \`del\`.

## Siehe auch {#see-also}

- [Dauerhafte Mailboxes (events / ack), wait und notify](help.topic.durable_mailboxes_and_ack#overview)
- [readPage & changes API](help.api.phispaces_read_page_changes)`
		},
		en: {
			title: "Snapshot Pages (readPage) and Revision Streams (changes)",
			short: "How clients read consistent, byte-bounded snapshots via readPage and stream subsequent commits seamlessly via changes(afterRev).",
			body: `## Overview {#overview}

A live view, such as a chat, has to do two things: load the current state and then notice every change. Two tools provide this. One gives you a photo of the space, in several pages if needed. The other gives you everything that has happened since that photo. Together, nothing gets lost.

### Technical Details {#technical-details}

\`phi-spaces\` combines **immutable point-in-time snapshots (\`readPage\`)** with a **monotonic revision stream (\`changes\`)**. This keeps views such as the Multiplayer Space-Chat or the Space Dashboard in sync.

## Concept And System Model {#concept-model}

### Consistent Pagination With readPage {#read-page}

\`\`\`ts
const page = await space.readPage(template, { maxBytes: 65536 });
// page = { items: EntryView[], next: string | null, token?: string, rev: number, streamId: string }
\`\`\`

- If the whole answer fits on one page, **no snapshot** is made and there is no \`token\`; \`next\` is then \`null\`, and most reads end here.
- If it does not fit, the first page pins a snapshot at revision \`page.rev\` in the space cache (TTL: 60 s, max 16 tokens / 64 MiB per space).
- Subsequent calls with \`space.readPage(template, { after: page.next, token: page.token })\` read **the exact same immutable snapshot**, even while concurrent writes or lease expirations occur.
- After a host restart or 60 s TTL expiry, continuing throws \`SnapshotExpired\`, signaling the client to re-baseline from page 1.
- \`ResponseBudgetTooSmall\` reports through \`requiredBytes\` that the next element does not fit the budget. The cursor stays as it was.
- \`readAll(template, { limit })\` lists only that many matches. Without a limit it returns all of them, oldest first.

### Incremental Catch-Up With changes(afterRev) {#changes-stream}

\`\`\`ts
const delta = await space.changes(page.rev, { maxBytes: 65536 });
// delta = { streamId: string, batches: ChangeBatch[], next: number, rev: number, more: boolean }
\`\`\`

- Every space commit increments \`rev\` by 1.
- \`changes(afterRev)\` returns all committed entry batches after \`afterRev\` in commit order. A page holds only complete batches.
- With \`waitMs\` it becomes a long poll: the answer comes at the first batch or when the wait ends.
- If the revision log (\`maxLogBytes\`, default 4 MiB) has rotated past \`afterRev\`, the call throws \`SnapshotExpired\` and the client re-baselines with a fresh \`readPage\` snapshot. \`RevisionAhead\` reports a cursor beyond the current revision.
- A \`write\` with \`transient: true\` appears only here: as a \`put\` with \`transient: true\`, with no entry and no later \`del\`.

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

Manchmal wartet man nicht Sekunden, sondern Tage auf etwas. Dann soll kein Programm die ganze Zeit blockiert sein. Stattdessen hinterlegst du einen Wunsch: „Sag mir Bescheid, wenn so etwas auftaucht.“ Die Nachricht landet in einem Briefkasten und bleibt dort, bis du sie abholst und bestätigst.

### Technische Details {#technical-details}

Während \`read(template, timeout)\` und \`take(template, timeout)\` den aktuellen Aufruf blockieren (max. 60 s in Agent-Tools), erlauben \`wait\` und \`notify\` das **langlebige, nichtblockierende Parken** von Such- und Benachrichtigungsaufträgen über Stunden, Tage oder \`FOREVER\`. Beide brauchen \`startService\`, damit Zustellung und Reaper im Leerlauf laufen.

## Begriffs- und Systemmodell {#concept-model}

### wait vs. notify {#wait-vs-notify}

- **\`space.notify(template, { target, txn?, lease?, handback? })\`**: Jedes Mal, wenn ein passender Entry sichtbar wird, legt der Space ein Event in die Mailbox von \`target\`. \`notifyIntervalMs\` (Standard 1 s) bündelt schnelle Folgen.
- **\`space.wait(template, { take?, target, timeout, txnLeaseMs?, handback? })\`**: Einmaliger Auftrag. Bei \`take: true\` reserviert der Space den gefundenen Entry sofort in einer **frischen Transaktion** für \`target\` und legt Entry samt \`txnId\` in die Mailbox.

### Consumer-Mailbox und Präfix-ACK {#mailbox-and-ack}

Entfernte Clients (\`RemoteSpace\`) rufen ihre Mailbox über \`events\` ab und bestätigen verarbeitete Nachrichten per \`ack\`:

\`\`\`ts
const page = await remote.events({ after: cursor, waitMs: 5_000 });
if (page.gap) throw new Error("Mailbox reset: reload state before processing");
for (const item of page.events) {
  await handleEvent(item.event); // Ergebnis speichern und event.txn committen, bevor es weitergeht.
}
if (page.events.length > 0) {
  await remote.ack(page.mailboxEpoch, page.next);
}
\`\`\`

- **Wichtige Grenze**: \`ack(epoch, upTo)\` bestätigt ausschließlich, dass der Consumer die Mailbox-Nachrichten bis Sequenz \`upTo\` erhalten hat. Es ist **kein** Transaktions-Commit. Die übergebene Take-Transaktion muss separat mit \`commit(ev.event.txn)\` abgeschlossen werden.
- Bei TTL-Ablauf wechselt \`mailboxEpoch\`; \`gap\` meldet den Verlustbereich, und betroffene Take-Reservierungen werden freigegeben. Bei vollem Bytebudget werden neue Wirkungen mit \`ResourceExhausted\` abgewiesen, nicht still Events verworfen.
- Eine Rolle \`observer\` darf \`notify\`, \`events\` und \`ack\` für ihre eigene Mailbox benutzen. Wie oft der Dienst bei einem Long Poll nachsieht, steht unter [Wann wartende Aufrufe nachsehen](help.topic.space_service_and_remote_space#polling).

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): SpaceService, RemoteSpace & Mailboxes](help.workflow.stage_v3_remote_socket#overview)
- [wait, notify, events & ack API](help.api.phispaces_wait_notify_mailbox)`
		},
		en: {
			title: "Durable Mailboxes (events / ack), wait, and notify",
			short: "How non-blocking wait and notify deliver events into persistent consumer mailboxes, and how prefix ACK differs from a transaction commit.",
			body: `## Overview {#overview}

Sometimes you wait for something for days, not seconds. No program should sit blocked all that time. Instead you leave a request behind: "Tell me when something like this turns up." The notice lands in a mailbox and stays there until you pick it up and confirm it.

### Technical Details {#technical-details}

While \`read(template, timeout)\` and \`take(template, timeout)\` block the active call (capped at 60 s in agent tools), \`wait\` and \`notify\` allow **long-lived, non-blocking registration** of read/take waiters and subscriptions for hours, days, or \`FOREVER\`. Both need \`startService\`, so that delivery and the reaper run while idle.

## Concept And System Model {#concept-model}

### wait vs. notify {#wait-vs-notify}

- **\`space.notify(template, { target, txn?, lease?, handback? })\`**: Whenever a matching entry becomes visible, the space appends an event to \`target\`'s mailbox. \`notifyIntervalMs\` (default 1 s) bundles rapid sequences.
- **\`space.wait(template, { take?, target, timeout, txnLeaseMs?, handback? })\`**: One-shot waiter. With \`take: true\`, the space reserves the matched entry inside a **fresh transaction** owned by \`target\` and delivers both the entry and \`txnId\` to the mailbox.

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

- **Critical Boundary**: \`ack(epoch, upTo)\` only acknowledges receipt of mailbox events up to sequence \`upTo\`. It is **not** a transaction commit. A delivered take transaction must still be committed explicitly via \`commit(ev.event.txn)\`.
- TTL expiry changes \`mailboxEpoch\`, reports \`gap\` and releases affected take reservations. Byte exhaustion rejects new effects with \`ResourceExhausted\` instead of silently dropping events.
- The \`observer\` role may use \`notify\`, \`events\` and \`ack\` for its own mailbox. How often the service looks again during a long poll is explained under [when waiting calls look again](help.topic.space_service_and_remote_space#polling).

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

Der lokale Client ist der einfachste Weg zu phi-spaces: Dein Programm öffnet einen Space direkt im eigenen Prozess, ganz ohne Netzwerk. Für getrennte Themen legst du mehrere benannte Spaces an, wie Ordner in einem Schrank. Ein kleiner Hintergrunddienst räumt Abgelaufenes auf und stellt Nachrichten zu.

### Technische Details {#technical-details}

Ein Host (der eigene Speicher) verwaltet standardmäßig den Default-Space (\`phi-spaces.space\`, Alias \`"default"\`) sowie über die \`Registry\` (\`phi-spaces.registry\`) mehrere durch Ressourcenlimits begrenzte isolierte **benannte Spaces** (\`phi-spaces.named-space\`).

## Begriffs- und Systemmodell {#concept-model}

### Einen Host öffnen {#open-host}

\`\`\`ts
import { openOwnMemoryHost, openSqliteHost } from "phi-spaces";

const fileHost = await openSqliteHost("./spaces.db"); // SQLite, ein Prozess besitzt die Datei
const memoryHost = openOwnMemoryHost();               // nur im Arbeitsspeicher
await fileHost.close(ctx);
await memoryHost.close(ctx);
\`\`\`

- Ein zweiter Prozess auf derselben Datei erhält \`StoreUnavailable\`. Mehrere Prozesse teilen einen Space über den [Dienst](help.topic.space_service_and_remote_space#standalone).
- Details zum Speicher stehen unter [Der eigene Speicher](help.topic.architecture_layers#own-store).

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
- Ohne \`space\`-Option überwacht \`startService\` auch später erzeugte benannte Spaces.

### Paket und Importe {#package-imports}

Projekte binden die Bibliothek mit \`"phi-spaces": "file:.."\` ein und importieren über den Paketnamen. Einen Build-Schritt gibt es nicht; \`exports\` zeigt auf die TypeScript-Quellen. Nur diese Unterpfade sind Vertrag:

| Import | Inhalt |
|---|---|
| \`phi-spaces\` | Öffentliche API (\`PhiSpaces\`, \`RemoteSpace\`, \`serveSpace\`, \`SpaceService\`, Fehler) |
| \`phi-spaces/context\` | \`Context\`, \`BACKGROUND_CONTEXT\` |
| \`phi-spaces/core\` | Reine Semantik: \`matches\`, Fehlerklassen, Typen |
| \`phi-spaces/store/host\` | Eigener Store im Speicher (\`openOwnMemoryHost\`) |
| \`phi-spaces/store/sqlite\` | Eigener SQLite-Store (\`openSqliteHost\`) |
| \`phi-spaces/store/documents\` | Dokument-Helfer des Stores |
| \`phi-spaces/ws\` | WebSocket-Gateway der Web-Prozesse (\`upgradeWebSocket\`) |

## Siehe auch {#see-also}

- [Die 8 LLM-Agent-Tools und Replay-Sicherheit](help.topic.agent_tools_and_replay#overview)`
		},
		en: {
			title: "Local Client PhiSpaces, Named Spaces, and startService",
			short: "How PhiSpaces operates on the default space or named spaces (NamedSpace) and how startService drives the reaper and event delivery.",
			body: `## Overview {#overview}

The local client is the simplest way into phi-spaces: your program opens a space right inside its own process, with no network at all. For separate topics you create several named spaces, like folders in a cabinet. A small background service clears out what has expired and delivers notices.

### Technical Details {#technical-details}

A host (the own store) holds the default space (\`phi-spaces.space\`, alias \`"default"\`) plus resource-bounded isolated **named spaces** (\`phi-spaces.named-space\`) tracked in the \`Registry\` (\`phi-spaces.registry\`).

## Concept And System Model {#concept-model}

### Opening A Host {#open-host}

\`\`\`ts
import { openOwnMemoryHost, openSqliteHost } from "phi-spaces";

const fileHost = await openSqliteHost("./spaces.db"); // SQLite, one process owns the file
const memoryHost = openOwnMemoryHost();               // memory only
await fileHost.close(ctx);
await memoryHost.close(ctx);
\`\`\`

- A second process on the same file gets \`StoreUnavailable\`. Several processes share a space through the [service](help.topic.space_service_and_remote_space#standalone).
- The store is described under [the own store](help.topic.architecture_layers#own-store).

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
- Without a \`space\` option, \`startService\` also watches named spaces created later.

### Package And Imports {#package-imports}

Projects depend on the library with \`"phi-spaces": "file:.."\` and import through the package name. There is no build step; \`exports\` points at the TypeScript sources. Only these subpaths are contract:

| Import | Content |
|---|---|
| \`phi-spaces\` | Public API (\`PhiSpaces\`, \`RemoteSpace\`, \`serveSpace\`, \`SpaceService\`, errors) |
| \`phi-spaces/context\` | \`Context\`, \`BACKGROUND_CONTEXT\` |
| \`phi-spaces/core\` | Pure semantics: \`matches\`, error classes, types |
| \`phi-spaces/store/host\` | The own store in memory (\`openOwnMemoryHost\`) |
| \`phi-spaces/store/sqlite\` | The own SQLite store (\`openSqliteHost\`) |
| \`phi-spaces/store/documents\` | Document helpers of the store |
| \`phi-spaces/ws\` | WebSocket gateway of the web processes (\`upgradeWebSocket\`) |

## See Also {#see-also}

- [The 8 LLM Agent Tools and Replay Safety](help.topic.agent_tools_and_replay#overview)`
		}
	},
	{
		id: "help.topic.agent_tools_and_replay",
		type: "topic",
		provider: "tools",
		tags: ["tools", "agent", "replay", "space_write", "space_take", "space_txn", "space_wait", "space_notify", "pi-durable"],
		related: ["help.topic.local_client_and_named_spaces", "help.topic.examples", "help.api.agent_tools"],
		since: "0.0.1",
		de: {
			title: "Die 8 LLM-Agent-Tools und Replay-Sicherheit",
			short: "Wie KI-Agenten über space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify und space_lease sicher koordinieren.",
			body: `## Überblick {#overview}

KI-Agenten benutzen einen Space über acht Werkzeuge, etwa zum Schreiben, Lesen und Übernehmen von Arbeit. Ein Agent kann mitten in einem Aufruf neu starten. Darum ist jedes Werkzeug so gebaut, dass eine Wiederholung nichts doppelt tut. Das Paket dafür ist optional: Der Space selbst läuft auch ganz ohne Agenten.

Zum Ausprobieren gibt es [Beispiele mit Agenten](help.topic.examples#agents).

### Technische Details {#technical-details}

Die Erweiterung \`spaces\` (\`createSpaces(localSpaces(host))\` im Paket \`agent/\`, npm-Name \`phi-spaces-agent\`) stattet \`pi-durable\`-Conversations mit 8 Werkzeugen aus, die sämtlich mit \`replay: "safe"\` laufen. Die Werkzeuge wirken auf einen getrennten Space-Host. Das Paket nutzt pi-durable, pi-ai und Chord in Version 1.4.0; Werkzeugergebnisse stehen in \`output\`, nicht mehr in \`content\`.

## Technische Referenz {#technical-reference}

| Tool | Parameter | Semantik & Schutz |
|---|---|---|
| \`space_write\` | \`{ type, fields, types?, ttlMs?, txn? }\` | Schreibt einen Entry unter der Request-Identität des Aufrufs; ein Tool-Replay erzeugt keinen zweiten Entry. |
| \`space_list\` | \`{ id?, type?, fields?, limit?, txn? }\` | Liest bis zu \`limit\` (Standard 100, max. 1000) passende Entries ohne Sperre, älteste zuerst. Ein reiner Lesevorgang ohne Request-Identität. |
| \`space_read\` | \`{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }\` | Blockierendes Lesen bis \`timeoutMs\` (gedeckelt auf 60 s); die erste Frist hält der Claim im Space über Replays hinweg. |
| \`space_take\` | \`{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }\` | Exklusives Entnehmen (oder Reservieren unter \`txn\`); der Claim im Space bewahrt den genommenen Entry bei Replay. |
| \`space_txn\` | \`{ action: "begin" \\| "commit" \\| "abort", txn?, leaseMs? }\` | Öffnet, committet oder verwirft eine Conversation-eigene Space-Transaktion. |
| \`space_wait\` | \`{ type?, fields?, mode?: "take" \\| "read", timeoutMs?, txnLeaseMs?, handback? }\` | Nichtblockierendes Warten (auch \`"forever"\`); weckt die Conversation per Nachricht, sobald ein Treffer erscheint. |
| \`space_notify\` | \`{ type?, fields?, ttlMs?, handback? }\` | Abonniert zukünftige passende Entries als Nachricht an die Conversation, höchstens eine pro Sekunde; dazwischen liegende Writes kommen gebündelt mit Anzahl. Braucht einen Typ oder mindestens ein Feld. |
| \`space_lease\` | \`{ action: "renew" \\| "cancel", id, ms? }\` | Verlängert oder beendet eine eigene Lease (Entry, Txn, Wait oder Notify). |

### Wie ein Aufruf wiederholbar bleibt {#replay}

Space und Agent teilen sich keinen Commit. Die Zusage „einmal“ entsteht deshalb in Schritten:

1. Vor dem ersten fachlichen Space-Aufruf legt das Werkzeug seine Request-Identität als Task-Memo im Agentenspeicher ab. Nur die Generation wird davor beim Space geholt.
2. Der Space speichert Wirkung und Ergebnis atomar unter dieser Identität.
3. Ein Replay findet das Memo und ruft dieselbe Operation wieder auf. Es bekommt das erste Ergebnis.
4. Die Generation je Conversation liegt im Agentenspeicher und wird 10 Minuten vor Ablauf ihrer Zulassung erneuert. Nimmt sie keine neuen Anfragen mehr an, wird ein noch nicht aufgenommener Aufruf mit \`RequestExpired\` abgelehnt, nie unter neuer Identität ausgeführt.

### Zwei getrennte Speicher {#two-stores}

Der Space liegt im eigenen Speicher, der Agent im Speicher von pi-durable. Beide dürfen im selben Prozess laufen, haben aber getrennte Commit-Grenzen. So überlebt der Space einen Neustart des Agenten und umgekehrt.

- **Agentenspeicher**: Der Worker und die mobile Laufzeit nutzen SQLite mit \`synchronous=FULL\`. Nur die Rechercheläufe der Beispiele nutzen JSONL mit \`{ fsync: true }\` und zusätzlichem Flush von Commit-Marker und Verzeichniseinträgen (\`agent/src/storage.ts\`). JSONL ist kein Speicher des Space.
- **Grenze**: Die Zusage setzt voraus, dass das Memo den Ausfall überlebt. Stabile Identitäten ersetzen keinen gemeinsamen Commit. Prozessabstürze sind getestet, ein echter Stromausfall nicht (\`docs/agenten-stromausfalltest.md\`).
- **Externe Dienste**: Ein nach einem Absturz wiederholter Modellaufruf kann erneut ausgeführt und berechnet werden.

### Getrennter Agentenprozess {#agent-process}

\`DurableAgentClient\` (\`agent/src/durable-client.ts\`) startet \`durable-worker.ts\` als Kindprozess und spricht über Node-IPC mit ihm (Protokoll in \`durable-protocol.ts\`). So gelangen keine pi-durable-Importe in die Anwendung, und das Harness dort kennt den Space nicht. Der Worker sichert seinen Speicher mit einer eigenen \`.owner\`-Datei gegen einen zweiten Prozess. Codemode-Chat und spaces-mmo nutzen diesen Weg; \`CODEMODE_DURABLE_AGENT=0\` und \`SPACES_MMO_DURABLE_NPCS=0\` schalten ihn ab.

### Upgrade auf pi 1.4.0 {#pi-140}

- Werkzeugergebnisse stehen in \`output\` statt \`content\`. Nachrichten an das Modell behalten ihre \`content\`-Struktur.
- pi-durable 1.4.0 migriert seine SQLite-Datenbank automatisch auf Schema 2. Danach lässt sie sich mit 1.3.0 oder älter nicht mehr öffnen. **Agentendatenbanken vorher sichern**, einschließlich WAL-Zustand.
- Das betrifft nur den Agentenspeicher. Format 2 des eigenen phi-spaces-Speichers ist davon unabhängig.

Details stehen in \`docs/upgrade-pi-1.4.0.md\`.

## Siehe auch {#see-also}

- [Beispiele zum Ausprobieren](help.topic.examples#overview)
- [Agent-Tools (spaces) & startService API](help.api.agent_tools)`
		},
		en: {
			title: "The 8 LLM Agent Tools and Replay Safety",
			short: "How AI agents coordinate safely through space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify, and space_lease.",
			body: `## Overview {#overview}

AI agents use a space through eight tools, for example to write, read and take over work. An agent can restart in the middle of a call. So each tool is built in a way that a repeat does nothing twice. The package for this is optional: the space itself also runs without any agents.

To try it out, there are [examples with agents](help.topic.examples#agents).

### Technical Details {#technical-details}

The \`spaces\` extension (\`createSpaces(localSpaces(host))\` in the \`agent/\` package, npm name \`phi-spaces-agent\`) equips \`pi-durable\` conversations with 8 tools, all marked \`replay: "safe"\`. The tools act on a separate space host. The package uses pi-durable, pi-ai and Chord at version 1.4.0; tool results go in \`output\`, no longer in \`content\`.

## Technical Reference {#technical-reference}

| Tool | Parameters | Semantics & Protection |
|---|---|---|
| \`space_write\` | \`{ type, fields, types?, ttlMs?, txn? }\` | Writes an entry under the call's request identity; replaying the tool never creates a duplicate entry. |
| \`space_list\` | \`{ id?, type?, fields?, limit?, txn? }\` | Lists up to \`limit\` (default 100, max 1000) matching entries without locking, oldest first. A plain read without a request identity. |
| \`space_read\` | \`{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }\` | Blocking read up to \`timeoutMs\` (capped at 60 s); the space's claim keeps the first deadline across replays. |
| \`space_take\` | \`{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }\` | Exclusive removal (or reservation under \`txn\`); the space's claim preserves the taken entry across replays. |
| \`space_txn\` | \`{ action: "begin" \\| "commit" \\| "abort", txn?, leaseMs? }\` | Begins, commits, or aborts a conversation-owned space transaction. |
| \`space_wait\` | \`{ type?, fields?, mode?: "take" \\| "read", timeoutMs?, txnLeaseMs?, handback? }\` | Non-blocking wait (including \`"forever"\`); wakes the conversation with a message when a match arrives. |
| \`space_notify\` | \`{ type?, fields?, ttlMs?, handback? }\` | Subscribes to future matching entries as messages to the conversation, at most one per second; writes in between arrive bundled with a count. Needs a type or at least one field. |
| \`space_lease\` | \`{ action: "renew" \\| "cancel", id, ms? }\` | Renews or cancels an owned lease (entry, txn, wait, or notify). |

### How A Call Stays Repeatable {#replay}

The space and the agent share no commit. The promise of "once" therefore comes from several steps:

1. Before its first business space call, the tool records its request identity as a task memo in the agent's store. Only the generation is fetched from the space before that.
2. The space stores effect and result atomically under this identity.
3. A replay finds the memo and calls the same operation again. It gets the first result.
4. The generation of each conversation lives in the agent's store and is renewed 10 minutes before it stops admitting. Once it admits no new requests, a call not admitted yet is refused with \`RequestExpired\`, never run under a new identity.

### Two Separate Stores {#two-stores}

The space lives in the own store, the agent in pi-durable's store. Both may run in one process, but their commit boundaries are separate. So the space survives an agent restart and the other way round.

- **Agent store**: The worker and the mobile runtime use SQLite with \`synchronous=FULL\`. Only the research runs of the examples use JSONL with \`{ fsync: true }\` plus an extra flush of commit marker and directory entries (\`agent/src/storage.ts\`). JSONL is not a store of the space.
- **Boundary**: The promise assumes the memo survives the failure. Stable identities do not replace a shared commit. Process crashes are tested; a real power loss is not (\`docs/agenten-stromausfalltest.md\`).
- **External services**: A model call repeated after a crash can run and be billed again.

### Separate Agent Process {#agent-process}

\`DurableAgentClient\` (\`agent/src/durable-client.ts\`) starts \`durable-worker.ts\` as a child process and talks to it over Node IPC (protocol in \`durable-protocol.ts\`). This keeps pi-durable imports out of the application, and the harness over there does not know the space. The worker guards its store against a second process with an \`.owner\` file of its own. Codemode-Chat and spaces-mmo use this path; \`CODEMODE_DURABLE_AGENT=0\` and \`SPACES_MMO_DURABLE_NPCS=0\` turn it off.

### Upgrade To pi 1.4.0 {#pi-140}

- Tool results go in \`output\` instead of \`content\`. Messages to the model keep their \`content\` structure.
- pi-durable 1.4.0 migrates its SQLite database to schema 2 automatically. After that, 1.3.0 or older can no longer open it. **Back up agent databases first**, including their WAL state.
- This concerns the agent store only. Format 2 of the own phi-spaces store has nothing to do with it.

Details are in \`docs/upgrade-pi-1.4.0.md\`.

## See Also {#see-also}

- [Examples to try](help.topic.examples#overview)
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
			short: "Wie SpaceService Rollen-Policies erzwingt, wie der eigenständige Dienst läuft und wie RemoteSpace über In-Process, Unix-Socket, TCP oder pi-serverd mit stabilen Retries kommuniziert.",
			body: `## Überblick {#overview}

Sobald mehrere Prozesse oder Rechner denselben Space nutzen, braucht es einen Dienst in der Mitte. Der Space läuft dann in einem Prozess, und die anderen verbinden sich über einen Socket. Geht dabei eine Antwort verloren, wiederholt der Client den Aufruf gefahrlos. Für dein Programm sieht das fast so aus wie ein lokaler Space.

### Technische Details {#technical-details}

Sobald Web-Server, Worker und Subagenten in getrennten Prozessen oder auf verschiedenen Maschinen laufen, übernimmt \`SpaceService\` (\`src/service.ts\`) die serverseitige Abwicklung und \`RemoteSpace\` (\`src/remote.ts\`) die Client-Seite.

## Begriffs- und Systemmodell {#concept-model}

### Eigenständiger Dienst {#standalone}

\`\`\`sh
npm run space-server -- --store ./space.db --listen unix:/tmp/space.sock
npm run space-server -- --store memory --listen tcp:127.0.0.1:7777
\`\`\`

\`src/standalone.ts\` serviert den eigenen Speicher ohne pi-durable, ohne Modell und ohne Agent und startet die Hintergrundwartung mit. Sobald der Dienst bereit ist, schreibt er \`[phi-spaces] ready on …\`.

**Sicherheitsgrenze:** Jede Verbindung ist derselbe Peer (\`--peer\`, Standard \`local\`) mit der Rolle \`member\`. Wer den Socket erreicht, benutzt den Space. Lass ihn deshalb auf einem Unix-Socket oder einer internen Adresse laufen, oder setze das [Overlay-Gate](help.topic.gate_auth_grants_and_recovery#overview) davor. Ein offener TCP-Port ist nicht abgesichert.

### Client-Helfer {#client-helpers}

\`src/space-client.ts\` enthält, was jeder Prozess braucht, der einen Space woanders nutzt:

| Funktion | Inhalt |
|---|---|
| \`parseTarget(spec)\` | \`unix:/pfad\`, \`tcp:host:port\` oder ein bloßer Pfad wird zum Listen-Ziel |
| \`connectSpace(spec, options?)\` | Liefert \`{ space, transport, close }\`; Standard: Aufruf 30 s, Verbindungsaufbau 5 s, 3 Versuche |
| \`readExisting\` / \`takeExisting\` | Wie \`readIfExists\`/\`takeIfExists\`, unterscheiden aber „weg“ (\`null\`) von „gehalten“ (\`StillHeld\`) |
| \`peek(space, template)\` | Erster Treffer als Schnappschuss, ohne Claim |
| \`takeAll(space, template)\` | Nimmt jeden jetzt freien Treffer und liefert die Anzahl |
| \`awaitWork(space, template, waitMs, halt?)\` | Blockierendes \`read\` ohne Transaktion: \`true\`, sobald Arbeit da ist |
| \`keepAlive(space, lease, leaseMs)\` | Erneuert eine Lease alle \`leaseMs / 3\`; liefert die Stopp-Funktion |
| \`cutText(text, max)\` | Kürzt Text, ohne ein halbes Emoji zu hinterlassen |

\`\`\`ts
import { connectSpace } from "phi-spaces";

const { space: client, close } = connectSpace("unix:/tmp/space.sock");
await client.write({ type: "Job", fields: { id: 1 } });
close();
\`\`\`

Web-Prozesse nehmen für ihre Browser-Verbindungen das WebSocket-Gateway \`upgradeWebSocket(req, socket, head, { maxMessagesPerMin })\` aus \`phi-spaces/ws\` (RFC 6455, nur Text, Rahmen bis 1 MiB).

### Authentisierung über IdentityAdapter und Policy {#identity-and-policy}

\`SpaceService\` vertraut niemals einer vom Client im JSON-Body mitgesendeten Identität. Stattdessen bestimmt der \`IdentityAdapter\` (\`StaticIdentity\` lokal oder \`GateIdentity\` über NetBird/Schicht B) aus dem \`Connection\`-Kontext den \`Principal\` und seine Rollen (\`DEFAULT_POLICY\`: \`admin\`, \`host\`, \`member\`, \`observer\`, \`resolution\`, \`unpaired\`). Die \`Policy\` prüft vor jeder Operation sowohl die erlaubte Methode als auch die erlaubten Entry-Typen. Ein Typ-Grant gilt auch für Subtypen: Ein Write ist erlaubt, sobald der Typ oder einer der deklarierten Supertypen freigegeben ist. Weil der Schreibende die Supertypen selbst angibt, kann eine Rolle mit Grant auf \`Job\` auch \`{ type: "X", types: ["Job"] }\` schreiben; Typ-Grants sind daher keine Integritätsgrenze für Subtypen. Federation-Members erzwingen dagegen die in der Typ-Policy deklarierten Supertypen.

### Stabile Retries und OutcomeUnknown in RemoteSpace {#remote-retries}

Vor der ersten Mutation ruft \`RemoteSpace\` automatisch \`hello\` und \`generation\` auf und vergibt für jeden schreibenden Aufruf eine stabile \`requestId\`. Geht auf dem Socket/TCP-Transport eine Antwort verloren, wiederholt \`RemoteSpace\` denselben Aufruf mit **unveränderter \`requestId\`**. Läuft \`maxClientWaitMs\` ab, wirft der Client \`OutcomeUnknown\`, während die Operation am Host weiterläuft und über \`pollOperation\` aufgelöst werden kann. Nicht klassifizierte Hostfehler kommen als Code \`Internal\` mit der festen Meldung \`internal error\` an; den eigentlichen Fehler protokolliert nur der Host.

### Wann wartende Aufrufe nachsehen {#polling}

Lange Wartezeiten (\`read\`/\`take\` im Zustand \`pending\`, \`events\`, \`changes\`) laufen im Dienst in Runden, höchstens 25 s je Long Poll.

- **Standard**: Der Dienst sieht alle 50 ms nach.
- **Mit \`wakeOnCommit: true\`** (\`SpaceServiceOptions\`, Opt-in): Er sieht beim ersten Commit nach, danach bei \`read\`, \`take\` und \`events\` höchstens alle 25 ms. Ohne Commit sieht er spätestens nach 1 s nach. spaces-mmo schaltet das ein.
- **Lokal**: Ein wartender \`PhiSpaces\`-Aufruf wird durch die Änderung geweckt und wartet danach 20 ms plus bis zu 20 ms Zufall. So kostet eine Folge von Writes nur eine Runde, und viele Wartende schauen nicht im selben Moment nach.

### Text, Statistik und Space-Liste {#service-details}

- **Wohlgeformter Text**: Der Dienst ersetzt ein unpaariges Surrogat in jedem String und Schlüssel durch U+FFFD, bevor etwas den Aufruf sieht, auch der Argument-Hash (\`wellFormed\`).
- **Typisierte Fehlschläge**: \`read\` und \`take\` tragen über den Dienst \`locked\`; \`hello\` meldet das Feature \`read.locked\`.
- **\`spaces\` / \`RemoteSpace.spaces()\`**: Listet die Spaces des Hosts (\`spaceId\`, \`alias\`, \`createdAt\`), auch die zur Laufzeit angelegten. Die Rolle \`observer\` darf das.
- **\`RemoteSpace.statsWithRevision()\`**: Liefert die Kennzahlen mit der Revision und \`streamId\`, zu der sie gelesen wurden, dazu \`process\` (CPU-Zeit und Speicher des bedienenden Prozesses). Zwei Abfragen ergeben so die Commits dazwischen.

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace in der Praxis](help.workflow.stage_v3_remote_socket#overview)
- [SpaceService, serveSpace & RemoteSpace API](help.api.space_service_and_remote)`
		},
		en: {
			title: "SpaceService, RemoteSpace, and Network Transports",
			short: "How SpaceService enforces role policies, how the standalone service runs, and how RemoteSpace communicates over in-process, Unix socket, TCP, or pi-serverd transports with stable retries.",
			body: `## Overview {#overview}

As soon as several processes or machines use the same space, a service is needed in the middle. The space then runs in one process, and the others connect through a socket. If an answer gets lost on the way, the client repeats the call safely. To your program this looks almost like a local space.

### Technical Details {#technical-details}

When web servers, workers, and subagents run in separate processes or on different machines, \`SpaceService\` (\`src/service.ts\`) handles server-side dispatch while \`RemoteSpace\` (\`src/remote.ts\`) provides the client implementation.

## Concept And System Model {#concept-model}

### Standalone Service {#standalone}

\`\`\`sh
npm run space-server -- --store ./space.db --listen unix:/tmp/space.sock
npm run space-server -- --store memory --listen tcp:127.0.0.1:7777
\`\`\`

\`src/standalone.ts\` serves the own store with no pi-durable, no model and no agent, and starts the background maintenance with it. Once the service is ready it prints \`[phi-spaces] ready on …\`.

**Security boundary:** Every connection is the same peer (\`--peer\`, default \`local\`) with the \`member\` role. Whoever can reach the socket uses the space. So keep it on a unix socket or an internal address, or put the [overlay gate](help.topic.gate_auth_grants_and_recovery#overview) in front. An open TCP port is not protected.

### Client Helpers {#client-helpers}

\`src/space-client.ts\` holds what every process needs that uses a space somewhere else:

| Function | Content |
|---|---|
| \`parseTarget(spec)\` | \`unix:/path\`, \`tcp:host:port\` or a bare path becomes a listen target |
| \`connectSpace(spec, options?)\` | Returns \`{ space, transport, close }\`; defaults: call 30 s, connecting 5 s, 3 attempts |
| \`readExisting\` / \`takeExisting\` | Like \`readIfExists\`/\`takeIfExists\`, but tell "gone" (\`null\`) from "held" (\`StillHeld\`) |
| \`peek(space, template)\` | First match as a snapshot, without a claim |
| \`takeAll(space, template)\` | Takes every match free right now and returns the count |
| \`awaitWork(space, template, waitMs, halt?)\` | A blocking \`read\` without a transaction: \`true\` once work is there |
| \`keepAlive(space, lease, leaseMs)\` | Renews a lease every \`leaseMs / 3\`; returns the stop function |
| \`cutText(text, max)\` | Cuts text without leaving half an emoji |

\`\`\`ts
import { connectSpace } from "phi-spaces";

const { space: client, close } = connectSpace("unix:/tmp/space.sock");
await client.write({ type: "Job", fields: { id: 1 } });
close();
\`\`\`

For their browser connections, web processes use the WebSocket gateway \`upgradeWebSocket(req, socket, head, { maxMessagesPerMin })\` from \`phi-spaces/ws\` (RFC 6455, text only, frames up to 1 MiB).

### Authentication Via IdentityAdapter And Policy {#identity-and-policy}

\`SpaceService\` never trusts a principal sent inside a client JSON payload. Instead, its \`IdentityAdapter\` (\`StaticIdentity\` locally or \`GateIdentity\` over NetBird/Layer B) derives the \`Principal\` and roles (\`DEFAULT_POLICY\`: \`admin\`, \`host\`, \`member\`, \`observer\`, \`resolution\`, \`unpaired\`) from the trusted \`Connection\` context. \`Policy\` checks allowed methods and entry types before executing any call. A type grant covers subtypes: a write is allowed as soon as its type or one of its declared supertypes is granted. Because the writer declares the supertypes, a role granted \`Job\` can also write \`{ type: "X", types: ["Job"] }\`; type grants are therefore no integrity boundary for subtypes. Federation members, in contrast, enforce the supertypes declared in their type policy.

### Stable Retries And OutcomeUnknown In RemoteSpace {#remote-retries}

Before its first mutation, \`RemoteSpace\` automatically calls \`hello\` and \`generation\` and assigns a stable \`requestId\` to every mutating call. If a reply is lost on the socket/TCP transport, \`RemoteSpace\` retries with the **exact same \`requestId\`**. If \`maxClientWaitMs\` expires, it throws \`OutcomeUnknown\` while the host operation continues and can be resolved via \`pollOperation\`. Unclassified host errors arrive as code \`Internal\` with the fixed message \`internal error\`; only the host logs the actual error.

### When Waiting Calls Look Again {#polling}

Long waits (\`read\`/\`take\` in state \`pending\`, \`events\`, \`changes\`) run in rounds inside the service, at most 25 s per long poll.

- **Default**: The service looks again every 50 ms.
- **With \`wakeOnCommit: true\`** (\`SpaceServiceOptions\`, opt-in): It looks at the first commit, then for \`read\`, \`take\` and \`events\` at most every 25 ms. Without a commit it looks after 1 s at the latest. spaces-mmo turns this on.
- **Locally**: A waiting \`PhiSpaces\` call is woken by the change and then pauses for 20 ms plus up to 20 ms of jitter. A burst of writes thus costs one round, and many waiters do not all look in the same instant.

### Text, Statistics And The Space List {#service-details}

- **Well-formed text**: The service replaces an unpaired surrogate in any string or key with U+FFFD before anything sees the call, the argument hash included (\`wellFormed\`).
- **Typed misses**: \`read\` and \`take\` carry \`locked\` through the service; \`hello\` advertises the feature \`read.locked\`.
- **\`spaces\` / \`RemoteSpace.spaces()\`**: Lists the host's spaces (\`spaceId\`, \`alias\`, \`createdAt\`), including those created at runtime. The \`observer\` role may call it.
- **\`RemoteSpace.statsWithRevision()\`**: Returns the figures with the revision and \`streamId\` they were read at, plus \`process\` (CPU time and memory of the serving process). Two calls thus give the commits in between.

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

Sobald ein Space von außen erreichbar ist, muss klar sein, wer anklopft. Eine Netzwerkadresse allein reicht dafür nicht. Darum weist sich jedes Gerät zweimal aus: über das private Netz und mit einem eigenen Schlüssel. Neue Geräte werden mit einem Einmal-Code gekoppelt, und Erlaubnisse gelten nur kurze Zeit.

### Technische Details {#technical-details}

In einer Mehr-Host-Umgebung reicht eine IP-Adresse nicht als Identitätsnachweis, da mehrere Prozesse auf demselben Host dieselbe Netzwerk-IP teilen können. Phase 1b (\`src/gate.ts\`, \`src/auth.ts\`, \`src/enroll.ts\`, \`src/grants.ts\`, \`src/runtime.ts\`) kombiniert daher zwei Sicherheitsschichten mit kurzlebigen, signierten **60-Sekunden-Grants** und einem externen **CAS-Boot-Register**.

## Begriffs- und Systemmodell {#concept-model}

### Schicht A (Overlay-Peer) + Schicht B (App-Key-Challenge) {#layer-a-and-b}

1. **Schicht A (\`startGate\` / \`NetbirdDirectory\`)**: Bestimmt sofort bei TCP-Annahme (\`identifyOnConnect: true\`, Timeout 5 s) aus der WireGuard-/Overlay-Quelladresse die \`peerId\` und die Gruppen (\`space-hosts\`, \`space-admin\`, \`space-observer\`) und begrenzt Verbindungen auf max. 32 je Peer / 64 je Listener.
2. **Schicht B (\`ProvingService\`)**: Sendet eine verbindungsgebundene 30-s-Challenge \`{ gateHostId, observedPeerId, connNonce }\`. Der Client signiert diese mit seinem privaten \`Ed25519\`- oder \`P-256\`-Schlüssel (im Android Keystore auf dem Smartphone bzw. \`0600\`-Schlüsseldatei auf dem Host).

### Enrollment, 60s-Grants und Schlüsselrotation {#enrollment-and-grants}

- **Enrollment (\`createEnroll\` / \`enrollQr\`)**: Ein Admin erzeugt über den Supervisor ein Einmal-Token (nur der SHA-256-Hash liegt im \`CONTROL_SPACE\`). Das neue Gerät koppelt seinen Public Key per \`remote.enroll(token)\`.
- **Kurzlebige Grants (\`GrantAuthority\` / \`GrantVerifier\`)**: Vor jedem fachlichen Aufruf auf einem Data-Space holt \`RemoteSpace\` über \`grantProvider\` einen vom Control-Host signierten Grant (\`purpose: "effect" | "resolution"\`, max. 60 s gültig). Der Data-Member prüft Signatur, \`authorityId\`, \`peerId\`, \`keyId\`, Scope und Ablaufzeit noch einmal direkt vor dem Commit.
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

As soon as a space can be reached from outside, it has to be clear who is knocking. A network address alone is not enough for that. So every device identifies itself twice: through the private network and with a key of its own. New devices are paired with a one-time code, and permissions last only a short time.

### Technical Details {#technical-details}

In a multi-host environment, an IP address alone is insufficient identity proof because multiple processes on the same host share the overlay IP. Phase 1b (\`src/gate.ts\`, \`src/auth.ts\`, \`src/enroll.ts\`, \`src/grants.ts\`, \`src/runtime.ts\`) therefore combines two authentication layers with short-lived signed **60-second grants** and an external **CAS boot register**.

## Concept And System Model {#concept-model}

### Layer A (Overlay Peer) + Layer B (App-Key Challenge) {#layer-a-and-b}

1. **Layer A (\`startGate\` / \`NetbirdDirectory\`)**: Resolves \`peerId\` and groups (\`space-hosts\`, \`space-admin\`, \`space-observer\`) immediately upon TCP accept (\`identifyOnConnect: true\`, 5 s timeout) and enforces per-peer (32) and per-listener (64) connection quotas.
2. **Layer B (\`ProvingService\`)**: Issues a connection-bound 30 s challenge \`{ gateHostId, observedPeerId, connNonce }\`. The client signs it using its private \`Ed25519\` or \`P-256\` key (stored in Android Keystore on mobile or a \`0600\` key file on servers).

### Enrollment, 60s Grants, And Key Rotation {#enrollment-and-grants}

- **Enrollment (\`createEnroll\` / \`enrollQr\`)**: An admin creates a one-time token via the supervisor (only the SHA-256 hash is stored in \`CONTROL_SPACE\`). The new device registers its public key via \`remote.enroll(token)\`.
- **Short-Lived Grants (\`GrantAuthority\` / \`GrantVerifier\`)**: Before mutating a data space, \`RemoteSpace\` obtains a control-signed grant (\`purpose: "effect" | "resolution"\`, max 60 s TTL) via \`grantProvider\`. The data member re-verifies signature, \`authorityId\`, \`peerId\`, \`keyId\`, scope, and expiry right before commit.
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

Ein einzelner Rechner hat Grenzen. Mit der Föderation verteilst du einen Space auf mehrere Rechner, und für Programme bleibt es ein gemeinsamer Space. Eine feste Regel entscheidet, welche Daten wo liegen, damit Zusammengehöriges beisammen bleibt. Ein Koordinator merkt sich jeden Schritt, damit nach einem Ausfall nichts doppelt geschieht.

### Technische Details {#technical-details}

Phase 2 (\`src/router.ts\`, \`src/delegation.ts\`, \`src/federation-policy.ts\`, \`src/federated-space.ts\`, \`src/membership.ts\`) verbindet mehrere physische Member-Spaces unter einem Koordinator-Router zu einem logischen \`FederatedSpace\`. Dessen API unterscheidet sich vom \`SpaceLike\`-Basisvertrag. Der Standalone-Dienst ist kein Föderations-Member; dafür braucht es den Federation-Host.

## Begriffs- und Systemmodell {#concept-model}

### RouterController und Journal-Partitionen {#router-and-journals}

Jede föderierte Operation durchläuft im \`RouterController\` die persistente Zustandsmaschine \`accepted → applying → completed | failed | needsReview\`. Vor dem ersten RPC-Versand an einen Member stehen Ziel-\`spaceId\`, \`primaryEpoch\`, \`requestId\` und Argument-Hash fest im Journal (1 bis 1024 Partitionen). Nach einem Router-Neustart löst \`recover()\` offene Unterrequests über \`pollOperation\` / \`resolveOperation\` auf, ohne jemals blind eine zweite Wirkung auszulösen.

### HRW-Routing (Highest Random Weight) und Transaktionsbindung {#hrw-routing}

Die \`FederationPolicy\` ordnet jedem Entry-Typ eine Platzierungsregel zu:

- **\`local\`**: Fester einzelner Member-Space.
- **\`expand\`**: Verteilt nach \`by\`: \`"type"\`, \`{ field }\`, \`"capacity"\` oder \`"capability"\`. Bei \`by: { field: "threadId" }\` berechnet der Router per HRW deterministisch über den kanonischen Feldwert und die Member-IDs den zuständigen Member.
- **\`sync\`**: Fester Member mit Primary/Sync-Replikat-Konfiguration.
- **Beispiel Multiplayer Space-Chat**: Da \`Thread\`, \`Msg\` und \`ChatTask\` alle über \`field: "threadId"\` auf dieselbe Member-Menge geroutet werden, landen alle Operationen eines Threads auf demselben Member-Space. Damit funktionieren lokale Space-Transaktionen und \`CompletionProfiles\` ohne verteiltes Two-Phase-Locking.

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

A single machine has limits. With federation you spread a space across several machines, and to programs it stays one shared space. A fixed rule decides which data lives where, so that what belongs together stays together. A coordinator records every step, so that nothing happens twice after a failure.

### Technical Details {#technical-details}

Phase 2 (\`src/router.ts\`, \`src/delegation.ts\`, \`src/federation-policy.ts\`, \`src/federated-space.ts\`, \`src/membership.ts\`) unites multiple physical member spaces under a coordinator router into a logical \`FederatedSpace\`. Its API differs from the \`SpaceLike\` base contract. The standalone service is not a federation member; that takes the federation host.

## Concept And System Model {#concept-model}

### RouterController And Journal Partitions {#router-and-journals}

Every federated operation transitions through the persistent state machine \`accepted → applying → completed | failed | needsReview\` in \`RouterController\`. Before the first RPC is sent to a member, target \`spaceId\`, \`primaryEpoch\`, child \`requestId\`, and argument hash are persisted in the journal (1 to 1024 partitions). After a router restart, \`recover()\` resolves in-flight child requests via \`pollOperation\` / \`resolveOperation\` without blindly triggering a second effect.

### HRW Routing (Highest Random Weight) And Transaction Binding {#hrw-routing}

\`FederationPolicy\` assigns a placement rule to each entry type:

- **\`local\`**: Pinned to a single member space.
- **\`expand\`**: Spreads by \`by\`: \`"type"\`, \`{ field }\`, \`"capacity"\` or \`"capability"\`. With \`by: { field: "threadId" }\`, the router deterministically hashes (HRW) the canonical field value and member IDs to pick the owning member.
- **\`sync\`**: A fixed member with a primary/sync replica configuration.
- **Example Multiplayer Space-Chat**: Because \`Thread\`, \`Msg\`, and \`ChatTask\` all route by \`field: "threadId"\` across the same member set, every operation for a given thread lands on the same member space. Local space transactions and \`CompletionProfiles\` therefore work without cross-node two-phase locking.

### Journaled Waiter Race In takeWaiting {#waiter-race}

When a global worker calls \`federatedSpace.takeWaiting(template, timeoutMs, txnLeaseMs, request)\` without a fixed key field, the router registers bounded take waiters across all candidate members. When mailbox events arrive, they are ingested into the router journal **before** mailbox ACK: the first active reservation is durably elected as the winner, and any competing reservations on other members are automatically aborted and returned.

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

Wenn viele Rechner an einer großen Aufgabe arbeiten, will man sie anhalten, fortsetzen und überwachen können. Dieser Bereich bringt die Werkzeuge dafür: Läufe steuern, Helfer hoch- und herunterfahren, Spaces anlegen und löschen. Das geht vom Handy aus oder über eine Weboberfläche. Jeder Befehl ist so gebaut, dass doppeltes Tippen nichts doppelt auslöst.

### Technische Details {#technical-details}

Die Betriebserweiterung (Schritte B1–B10 in \`docs/betrieb-und-mobile-steuerung.md\`) ergänzt über dem Federation-Kern die operative Steuerung für **Rechenläufe (\`RunGate\` / \`RunController\`)**, **Host-Worker (\`WorkerSupervisor\`)**, **Space-Lebenszyklen (\`SpaceLifecycle\`)**, **Deployment-Bootstrap (\`DeploymentController\`)** und **Alarmierung/Audit (\`collectAlerts\` / \`auditLog\`)**. Alle Funktionen sind sowohl über die Android-App (\`pi-termux-mobile\`) als auch über den login-geschützten Web-Bereich **\`AdminSpaces\`** auf \`https://spaces.eibrain.org\` bedienbar.

## Begriffs- und Systemmodell {#concept-model}

### RunGate und bestätigte Pause-/Resume-Barriere {#rungate-barrier}

Ein \`RunGate { runId, controlRevision, state: "preparing" | "running" | "paused" | "stopped" }\` ist ein geschützter Steuerzustand im Space-Dokument:

- Tasks werden über \`CompletionProfile.gateField\` an den \`RunGate\` ihres Laufs gebunden. Für solche Tasks prüft der Space-Kern bei **jedem** \`take\` (auch bei wartenden Takes und Host-Code), ob der \`RunGate\` auf \`running\` steht.
- Bei \`pauseRun\` installiert jeder beteiligte Member zuerst einen **Fence** (keine neuen Run-Transaktionen, keine Lease-Verlängerung laufender Run-Transaktionen), lässt bereits reservierte Tasks innerhalb ihrer Lease abschließen und meldet erst danach sein signiertes ACK an den \`RunController\`. Erst wenn alle Member-ACKs vorliegen, wechselt der Lauf global auf \`paused\`.
- Der Laufzustand \`RunView.state\` im \`RunController\` kennt mehr Stufen als das Gate im Space, etwa \`pausing\`, \`pauseIncomplete\`, \`reconciling\` und \`needsReview\`.

### Signierte Worker-Steuerung (WorkerSupervisor) {#worker-supervisor}

Statt ungeschützter Entries im Control-Space speichert der Koordinator den gewünschten Worker-Sollzustand im geschützten Journal \`WorkerAssignments\` (\`setWorkers\`). Jeder Host ruft über die Gate-Methode \`workerAssignments\` nur seinen eigenen, vom Control-Host signierten Anteil ab. Der lokale \`WorkerSupervisor\` startet registrierte Worker-Schleifen (z.B. \`chat-worker\`, \`search-subagent\`, \`sieve\`) oder fährt sie bei \`count: 0\` nach dem aktuellen Task sauber herunter.

### Steuerung über Mobile App (pi-termux-mobile) & Web-Admin (AdminSpaces) {#mobile-and-web-admin}

Sowohl \`MobileSpaces\` (\`pi-termux-mobile/runtime/spaces-mobile.mjs\`) als auch unser Web-Admin-Controller (\`help-site/server/admin/\`) folgen demselben Sicherheitsvertrag:

1. **Vorab persistierte \`commandId\`**: Vor jedem Senden wird \`commandId = m-<kind>-<hex>\` bzw. \`w-<kind>-<hex>\` lokal gespeichert. Bei Timeout oder Doppeltippen wird exakt dieselbe \`commandId\` erneut gesendet („Ausgang wird geprüft“ statt doppelter Ausführung).
2. **Schlüsselbeweis & 60s-Grants**: Jede Verbindung beweist ihren \`Ed25519\`/\`P-256\`-Schlüssel am Gate und nutzt kurzlebige Grants.
3. **Phase-3-Replikationsbausteine**: Für verzögerungstolerante Metadaten und Präsenz steht \`EntryReplicationController\` (persistenter HLC, Last-Writer-Wins mit versionierten Tombstones und Add-Wins-Sets) bereit. Er nutzt ein eigenes Dokument und repliziert bestehende \`PhiSpaces\`-Entries nicht automatisch. Primary/Sync, Fencing und Promotion sind implementiert, Phase 3 ist aber nicht vollständig abgenommen (\`docs/abnahme/ap3-abnahme.md\`).

## Siehe auch {#see-also}

- [Stufe 6 (v6-mobile-control): Mobile App & Web-Admin Steuerung](help.workflow.stage_v6_mobile_control#overview)
- [RunController, WorkerSupervisor, SpaceLifecycle & Alerts API](help.api.operations_runs_workers)`
		},
		en: {
			title: "Operations Extension (RunGate, Workers, Mobile/Web Admin) & Phase 3 Replication",
			short: "How runs are controlled via RunGate barriers, workers via signed assignments, and spaces via the mobile app (pi-termux-mobile) and web admin area (AdminSpaces).",
			body: `## Overview {#overview}

When many machines work on one big task, you want to pause it, resume it and keep an eye on it. This area brings the tools for that: controlling runs, scaling helpers up and down, creating and deleting spaces. You can do this from a phone or through a web interface. Every command is built so that tapping twice does not trigger anything twice.

### Technical Details {#technical-details}

The operations extension (steps B1–B10 in \`docs/betrieb-und-mobile-steuerung.md\`) adds operational control on top of the federation core for **runs (\`RunGate\` / \`RunController\`)**, **host workers (\`WorkerSupervisor\`)**, **space lifecycles (\`SpaceLifecycle\`)**, **deployment bootstrap (\`DeploymentController\`)**, and **alerting/audit (\`collectAlerts\` / \`auditLog\`)**. All capabilities are accessible both from the Android app (\`pi-termux-mobile\`) and from the login-protected **\`AdminSpaces\`** web area on \`https://spaces.eibrain.org\`.

## Concept And System Model {#concept-model}

### RunGate And Confirmed Pause/Resume Barrier {#rungate-barrier}

A \`RunGate { runId, controlRevision, state: "preparing" | "running" | "paused" | "stopped" }\` is a protected control record inside the space document:

- Tasks are bound to the \`RunGate\` of their run through \`CompletionProfile.gateField\`. For such tasks the space core checks on **every** \`take\` (including waiting takes and host code) whether the \`RunGate\` is \`running\`.
- On \`pauseRun\`, each participating member first installs a **fence** (blocking new run transactions and lease renewals on existing ones), allows in-flight reserved tasks to finish within their remaining lease, and only then returns its signed ACK to \`RunController\`. The run becomes globally \`paused\` only after all member ACKs arrive.
- The run state \`RunView.state\` in \`RunController\` has more stages than the gate in the space, such as \`pausing\`, \`pauseIncomplete\`, \`reconciling\` and \`needsReview\`.

### Signed Worker Control (WorkerSupervisor) {#worker-supervisor}

Rather than storing mutable worker entries in the control space, the coordinator persists desired worker counts in the protected \`WorkerAssignments\` journal (\`setWorkers\`). Each host fetches only its own control-signed assignment via the \`workerAssignments\` gate method. The local \`WorkerSupervisor\` starts registered worker loops (e.g. \`chat-worker\`, \`search-subagent\`, \`sieve\`) or stops them cleanly after the active task when \`count: 0\`.

### Control Via Mobile App (pi-termux-mobile) & Web Admin (AdminSpaces) {#mobile-and-web-admin}

Both \`MobileSpaces\` (\`pi-termux-mobile/runtime/spaces-mobile.mjs\`) and our web admin controller (\`help-site/server/admin/\`) enforce the exact same safety contract:

1. **Pre-persisted \`commandId\`**: Before sending any admin command, \`commandId = m-<kind>-<hex>\` or \`w-<kind>-<hex>\` is saved locally. On timeout or double-click, the exact same \`commandId\` is reused ("checking outcome" rather than duplicate execution).
2. **Key Proof & 60s Grants**: Every connection proves its \`Ed25519\`/\`P-256\` key at the gate and uses short-lived grants.
3. **Phase 3 Replication Building Blocks**: For delay-tolerant metadata and presence, \`EntryReplicationController\` provides persistent HLC ordering, Last-Writer-Wins with versioned tombstones, and Add-Wins sets. It uses a document of its own and does not replicate existing \`PhiSpaces\` entries automatically. Primary/sync, fencing and promotion are implemented, but Phase 3 is not fully accepted (\`docs/abnahme/ap3-abnahme.md\`).

## See Also {#see-also}

- [Stage 6 (v6-mobile-control): Mobile App & Web Admin Control](help.workflow.stage_v6_mobile_control#overview)
- [RunController, WorkerSupervisor, SpaceLifecycle & Alerts API](help.api.operations_runs_workers)`
		}
	},
	{
		id: "help.topic.comparison_earendil_vs_phi_spaces",
		type: "topic",
		provider: "core",
		tags: ["comparison", "earendil", "cloudflare", "durable-objects", "pi-durable", "pros-cons", "v1", "v2", "v3", "v4", "v5", "v6", "federated"],
		related: ["help.topic.overview", "help.workflow.overview_v1_to_v6", "help.topic.federation_router_and_membership"],
		since: "0.0.1",
		de: {
			title: "Konzeptvergleich: Earendil Multiplayer Chat vs. phi-spaces (v1 bis v6)",
			short: "Vergleich des Cloudflare-Durable-Object-Ansatzes und von pi-durable 1.4.0 mit dem Tuple-Space-Modell von phi-spaces, samt Vor- und Nachteilen von In-Memory (v1) bis Federated Space (v5/v6).",
			body: `## Überblick {#overview}

Earendil baut mit pi-durable eine Laufzeit für KI-Agenten und zeigt damit einen Mehrbenutzer-Chat auf Cloudflare. Dieser Artikel stellt diese Bauweise neben phi-spaces. Kurz gesagt: pi-durable führt einen Agenten aus, phi-spaces koordiniert die Zusammenarbeit mehrerer Teilnehmer. Die beiden ersetzen einander nicht, und zusammen passen sie gut.

### Technische Details {#technical-details}

Zwei Dinge sind zu trennen: die Vorlage [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) als Architektur und pi-durable als Paket. \`phi-spaces\` baut nicht auf pi-durable auf: Der Space hat einen eigenen Speicher und braucht weder pi-durable noch Chord oder pi-ai. Nur das optionale Paket \`agent/\` verbindet beide (siehe [Zwei getrennte Speicher](help.topic.agent_tools_and_replay#two-stores)). Die Architekturen unterscheiden sich so:

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
| **6. Subagent-Suche (\`search_history\`)** | Child-Conversation in derselben lokalen DO-SQLite-DB. | Entkoppelter Subagent-Worker über \`SearchTask\` / \`SubagentStep\` / \`SearchResult\`, in \`v5\` **clusterweit über mehrere Hosts**. |

### phi-spaces und pi-durable 1.4.0 {#pi-durable-today}

Stand 30.10.2026, verglichen mit dem veröffentlichten Release 1.4.0 (\`docs/vergleich-pi-durable.md\`):

| Bereich | \`phi-spaces\` | pi-durable 1.4.0 |
|---|---|---|
| **Hauptzweck** | Gemeinsame Daten und Arbeit zwischen Teilnehmern koordinieren | Persistente Agenten und ihre Ausführung betreiben |
| **Zentrale Abstraktion** | Space mit per Template auffindbaren Entries | Conversation mit Transkript, Submissions und Tasks |
| **Arbeitsverteilung** | Konkurrierende Verbraucher übernehmen Arbeit mit \`take\` | Scheduler führt besitzgebundene Tasks aus; kein entsprechendes \`take\` |
| **Modellintegration** | Nicht im Space-Kern; Anwendungen oder \`agent/\` | Eingebaut über pi-ai |
| **Commit-Verarbeitung** | Ein Schreib-Thread bündelt Commits; der nächste Commit darf schon auf dem vorbereiteten Zustand aufsetzen; Antworten warten aufs dauerhafte Schreiben | Eine Mutationslinie bleibt während des Storage-Aufrufs belegt |
| **Standard-Sync** | WAL mit \`synchronous=FULL\` | Node-SQLite: WAL mit \`synchronous=NORMAL\` |
| **Speicherplattformen** | Eigener Memory- und Node-SQLite-Store | Memory, SQLite, JSONL, IndexedDB und Cloudflare-Durable-Object-SQLite |
| **Netzwerkdienst** | In-Process, Unix-Socket, TCP, Adapter für pi-server | Harness-/Storage-Bibliothek; Netzwerkhosting ist eine zusätzliche Integration |

Die Tabelle vergleicht Standards, keine Leistung: Einen kontrollierten Benchmark gegen 1.4.0 gibt es nicht. Die Speicherdateien sind nicht austauschbar. Seit 1.4.0 ist „pi-durable schreibt immer das ganze Dokument“ ebenfalls falsch: Jede Dokumentdefinition legt mit \`checkpointWhen\` fest, wann eine vollständige Basis entsteht.

### Neuerer Earendil-Stand {#earendil-main}

Der unveröffentlichte Earendil-\`main\` (geprüft: Commit \`50af8c1\` vom 30.10.2026) ist neuer als der Release und nicht mit 1.4.0 gleichzusetzen. Er bringt Group Commit, einen \`StoreStorage\` auf Chord v2 und „deferred commits“: Fortschritt wird sichtbar, bevor er gespeichert ist, standardmäßig bis zu 1 s früher. „Nur phi-spaces hat Group Commit“ gilt also nicht allgemein. phi-spaces bestätigt seine Commits weiterhin erst nach dem Schreiben. Dieser Stand wurde gelesen, aber weder installiert noch ausgeführt.

## Regeln, Garantien und Grenzen {#rules-and-boundaries}

### Vor- und Nachteile der Stufen v1 (In-Memory) bis v5/v6 (Federated Space) {#stages-pros-cons}

| Ausbaustufe | Zentrale Vorteile | Bewusste Grenzen / Nachteile |
|---|---|---|
| **\`v1\` In-Memory Space** (\`openOwnMemoryHost()\` + \`PhiSpaces\`) | **0 ms Setup**, volle Space-Einsicht, \`SpaceLifecycle\`, \`WorkerSupervisor\` und \`DeploymentController\` direkt im RAM; ideal für Tests & Prototyping. | Zustand ist flüchtig (verloren bei Prozessende); auf einen einzelnen Node.js-Prozess beschränkt; kein \`RunGate\` im Chat aktiv. |
| **\`v2\` Local Durable Space** (\`openSqliteHost()\` + \`PhiSpaces\`) | **ACID-Commits** in einer SQLite-Datei (Standard \`synchronous=FULL\`); Thread-Fork über einen Verweis auf den Eltern-Thread; steuer- und einsehbar über \`AdminSpaces\`, Live-Dashboard (\`npm run dashboard\`), TUI (\`npm run tui\`) und \`npm run bootstrap\`. | Ein Besitzer (nur 1 Host-Prozess auf der Datei, \`.owner\`-Sperre); kein Serverless-Scale-to-Zero. |
| **\`v3\` Remote Socket Space** (\`SpaceService\` + \`RemoteSpace\`) | **Prozess-Entkopplung**: Web-Gateway, Chat-Worker, Subagent und Inspector verbinden über Unix-Socket/TCP; ereignisgesteuerte Mailboxes (\`events\` + \`ack\`). | Zusätzlicher Serialisierungs- und Socket-I/O-Hop; Aufrufer müssen bei Verbindungsabbruch \`OutcomeUnknown\` via \`pollOperation\` auflösen. |
| **\`v4\` Gated Auth Space** (\`startGate\` Schicht A/B + 60s-Grants) | **Steuerung von außen mit Schlüsselbeweis**: Smartphone (\`pi-termux-mobile\`), CLI und Web-Admin koppeln sich per QR/Token (\`enrollQr\`) und steuern/inspizieren Spaces mit 60-s-Grants. | Höherer Einrichtungsaufwand (Key-Management, Enrollment, Boot-Register); neue Remote-Grants benötigen erreichbaren Control-Host. |
| **\`v5\`/\`v6\` Federated Space & Cluster-Admin** (\`FederatedSpace\` + HRW + \`RunGate\` in v6 + AP3-Replikationsbausteine) | **Verteilung auf mehrere Hosts**: Orchestriert mehrere Member-Hosts; \`RunGate\` in v6 für bestätigte Barrieren; Primary/Sync-Replikation und Promotion sind implementiert. | Phase 3 ist nicht vollständig abgenommen, daraus folgt keine Hochverfügbarkeits-Zusage. Keine member-übergreifenden Transaktionen (\`RoutingConflict\`); HRW-Member-Menge nach Federation-Plan v3 fest (\`MigrationRequired\` bei Entfernung); Test in v5 läuft in-process mit Hosts im Arbeitsspeicher. |

### Wann ist welches Modell überlegen? {#decision-guide}

- **Wähle das Cloudflare-DO-Modell**, wenn du tausende kleine, voneinander komplett isolierte Chat-Sessions in einer Serverless-Cloud mit *Scale-to-Zero* betreiben willst und keine externen Worker-Flotten oder On-Premise-Hoheit benötigst.
- **Wähle pi-durable**, wenn ein Agent Modell- und Werkzeugarbeit nach Neustarts fortsetzen soll oder du Conversation-Forks, Promptaufbau und Modellkontext brauchst. Für etwas atomar mitgespeicherten Zustand reichen pi-durable-Dokumente.
- **Wähle \`phi-spaces\` (\`v1\`–\`v6\`)**, wenn du **Infrastruktur-Unabhängigkeit** (Docker, Linux-VPS, lokal, Mobile), **serverseitig erzwungene Ergebnisverträge (\`CompletionProfiles\`)**, **entkoppelte heterogene Worker/Subagenten**, **HRW-Sharding über mehrere Hosts**, **selbstgehostete Primary/Sync-Replikation mit Fencing (AP3, nicht vollständig abgenommen)** oder eine **integrierte Betriebs- und Laufsteuerung (\`RunGate\` ab v6, \`WorkerSupervisor\`, Mobile/Web-Admin)** benötigst. Auch ein Dienst ganz ohne Agenten passt hierher.
- **Nimm beide**, wenn mehrere persistente Agenten zusammenarbeiten sollen: agentenintern pi-durable, agentenübergreifend phi-spaces.

## Siehe auch {#see-also}

- [Übersicht: Multiplayer Space-Chat in 6 Stufen (v1 bis v6)](help.workflow.overview_v1_to_v6#overview)
- [Federation, Router, HRW-Sharding und Membership](help.topic.federation_router_and_membership#overview)`
		},
		en: {
			title: "Concept Comparison: Earendil Multiplayer Chat vs. phi-spaces (v1 to v6)",
			short: "Comparison of the Cloudflare Durable Object approach and pi-durable 1.4.0 with the phi-spaces tuple-space model, including pros and cons from In-Memory (v1) to Federated Space (v5/v6).",
			body: `## Overview {#overview}

Earendil builds pi-durable, a runtime for AI agents, and uses it to show a multi-user chat on Cloudflare. This article puts that design next to phi-spaces. In short: pi-durable runs an agent, and phi-spaces coordinates the work of several participants. Neither replaces the other, and together they fit well.

### Technical Details {#technical-details}

Two things have to be kept apart: the [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) reference as an architecture, and pi-durable as a package. \`phi-spaces\` does not build on pi-durable: the space has a store of its own and needs neither pi-durable nor Chord nor pi-ai. Only the optional \`agent/\` package connects the two (see [two separate stores](help.topic.agent_tools_and_replay#two-stores)). The architectures differ like this:

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
| **6. Subagent Search (\`search_history\`)** | Child conversation inside the same local DO SQLite database. | Decoupled subagent worker via \`SearchTask\` / \`SubagentStep\` / \`SearchResult\`, searching **cluster-wide across hosts** in \`v5\`. |

### phi-spaces And pi-durable 1.4.0 {#pi-durable-today}

As of 2026-10-30, compared with the published release 1.4.0 (\`docs/vergleich-pi-durable.md\`):

| Area | \`phi-spaces\` | pi-durable 1.4.0 |
|---|---|---|
| **Main purpose** | Coordinate shared data and work between participants | Run persistent agents and their execution |
| **Central abstraction** | Space with entries found by template | Conversation with transcript, submissions and tasks |
| **Work distribution** | Competing consumers take work with \`take\` | A scheduler runs owner-bound tasks; no equivalent \`take\` |
| **Model integration** | Not in the space core; applications or \`agent/\` | Built in through pi-ai |
| **Commit handling** | A writer thread bundles commits; the next commit may build on the prepared state; replies wait for the durable write | One mutation line stays occupied during the storage call |
| **Default sync** | WAL with \`synchronous=FULL\` | Node SQLite: WAL with \`synchronous=NORMAL\` |
| **Storage platforms** | Own memory and Node SQLite store | Memory, SQLite, JSONL, IndexedDB and Cloudflare Durable Object SQLite |
| **Network service** | In-process, Unix socket, TCP, adapter for pi-server | Harness/storage library; network hosting is an additional integration |

The table compares defaults, not performance: there is no controlled benchmark against 1.4.0. The store files are not interchangeable. Since 1.4.0, "pi-durable always writes the whole document" is false too: each document definition sets through \`checkpointWhen\` when a full base is written.

### Newer Earendil Code {#earendil-main}

The unreleased Earendil \`main\` (checked: commit \`50af8c1\` of 2026-10-30) is newer than the release and must not be equated with 1.4.0. It brings group commit, a \`StoreStorage\` on Chord v2, and "deferred commits": progress becomes visible before it is stored, by default up to 1 s earlier. "Only phi-spaces has group commit" is therefore not true in general. phi-spaces still acknowledges its commits only after the write. This code was read, but neither installed nor run.

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

### Pros And Cons Across Stages v1 (In-Memory) To v5/v6 (Federated Space) {#stages-pros-cons}

| Stage | Key Advantages | Trade-Offs / Boundaries |
|---|---|---|
| **\`v1\` In-Memory Space** (\`openOwnMemoryHost()\` + \`PhiSpaces\`) | **0 ms setup**, full space inspection, \`SpaceLifecycle\`, \`WorkerSupervisor\`, and \`DeploymentController\` directly in RAM; ideal for tests & prototyping. | Volatile state (lost when process exits); limited to a single Node.js process; no \`RunGate\` active in chat. |
| **\`v2\` Local Durable Space** (\`openSqliteHost()\` + \`PhiSpaces\`) | **ACID commits** in one SQLite file (default \`synchronous=FULL\`); thread forks through a reference to the parent thread; inspectable and controllable via \`AdminSpaces\`, live Dashboard (\`npm run dashboard\`), TUI (\`npm run tui\`), and \`npm run bootstrap\`. | One owner (only 1 host process on the file, \`.owner\` lock); no serverless scale-to-zero. |
| **\`v3\` Remote Socket Space** (\`SpaceService\` + \`RemoteSpace\`) | **Process decoupling**: web gateway, chat workers, subagents, and inspectors connect via Unix socket/TCP; event-driven mailboxes (\`events\` + \`ack\`). | Additional serialization and socket I/O hop; callers must handle \`OutcomeUnknown\` via \`pollOperation\` on transport drop. |
| **\`v4\` Gated Auth Space** (\`startGate\` Layer A/B + 60s Grants) | **External control with key proof**: smartphone (\`pi-termux-mobile\`), CLI, and web admin pair via QR/token (\`enrollQr\`) and inspect/control spaces with 60s grants. | Higher setup complexity (key provisioning, enrollment, boot register); issuing new remote grants requires a reachable control host. |
| **\`v5\`/\`v6\` Federated Space & Cluster Admin** (\`FederatedSpace\` + HRW + \`RunGate\` in v6 + AP3 replication building blocks) | **Spread across several hosts**: orchestrates multiple member hosts; \`RunGate\` in v6 for confirmed barriers; primary/sync replication and promotion are implemented. | Phase 3 is not fully accepted, so no high-availability promise follows. No cross-member transactions (\`RoutingConflict\`); HRW member set fixed by federation plan v3 (\`MigrationRequired\` on removal); Stage v5 test runs in-process with in-memory hosts. |

### When To Choose Which Model {#decision-guide}

- **Choose the Cloudflare DO model** when you want to host thousands of small, completely isolated chat sessions on serverless edge infrastructure with *scale-to-zero* and no external worker fleets.
- **Choose pi-durable** when an agent should continue model and tool work after restarts, or when you need conversation forks, prompt building and model context. For a little state stored atomically with it, pi-durable documents are enough.
- **Choose \`phi-spaces\` (\`v1\`–\`v6\`)** when you need **infrastructure independence** (Docker, Linux VPS, on-premise, mobile), **server-enforced result contracts (\`CompletionProfiles\`)**, **decoupled heterogeneous worker/subagent fleets**, **HRW sharding across hosts**, **self-hosted Primary/Sync replication with fencing (AP3, not fully accepted)**, or **integrated operational control (\`RunGate\` from v6, \`WorkerSupervisor\`, Mobile/Web Admin)**. A service with no agents at all fits here too.
- **Use both** when several persistent agents should work together: pi-durable inside each agent, phi-spaces between them.

## See Also {#see-also}

- [Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)](help.workflow.overview_v1_to_v6#overview)
- [Federation, Router, HRW Sharding, and Membership](help.topic.federation_router_and_membership#overview)`
		}
	}
];
