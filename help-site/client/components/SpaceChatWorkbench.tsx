"use client";
import { useEffect, useState } from "react";
import { LlmModelPicker } from "./LlmModelPicker.tsx";
import { startChatConnection, type ChatSocket } from "../lib/chat-connection.ts";

interface WorkbenchProps {
	locale: "de" | "en";
	sessionId: string;
	initialStage?: string;
	onOpenArticle: (id: string) => void;
}

const STAGES = [
	{
		id: "v1",
		articleId: "help.workflow.stage_v1_local_memory",
		title: { de: "v1 · In-Memory", en: "v1 · In-Memory" },
		sub: { de: "Zero-Setup PiSpaces", en: "Zero-Setup PiSpaces" },
	},
	{
		id: "v2",
		articleId: "help.workflow.stage_v2_local_durable",
		title: { de: "v2 · SQLite Durable", en: "v2 · SQLite Durable" },
		sub: { de: "Claims, Alarme & Subagent", en: "Claims, Alarms & Subagent" },
	},
	{
		id: "v3",
		articleId: "help.workflow.stage_v3_remote_socket",
		title: { de: "v3 · Remote Socket", en: "v3 · Remote Socket" },
		sub: { de: "SpaceService & Mailboxes", en: "SpaceService & Mailboxes" },
	},
	{
		id: "v4",
		articleId: "help.workflow.stage_v4_gated_auth",
		title: { de: "v4 · Gated Auth", en: "v4 · Gated Auth" },
		sub: { de: "Schicht A/B & 60s Grants", en: "Layer A/B & 60s Grants" },
	},
	{
		id: "v5",
		articleId: "help.workflow.stage_v5_federated_cluster",
		title: { de: "v5 · Federated HRW", en: "v5 · Federated HRW" },
		sub: { de: "3 Members & LWW Presence", en: "3 Members & LWW Presence" },
	},
	{
		id: "v6",
		articleId: "help.workflow.stage_v6_mobile_control",
		title: { de: "v6 · Mobile & Admin", en: "v6 · Mobile & Admin" },
		sub: { de: "QR, Worker & RunGate", en: "QR, Workers & RunGate" },
	},
] as const;

export function SpaceChatWorkbench(props: WorkbenchProps) {
	const { locale, sessionId, onOpenArticle } = props;
	const [activeStage, setActiveStage] = useState<string>(props.initialStage ?? "v2");
	useEffect(() => { if (props.initialStage) setActiveStage(props.initialStage); }, [props.initialStage]);
	const [stageReport, setStageReport] = useState<any>(null);
	const [runningStage, setRunningStage] = useState<boolean>(false);

	const [snapshot, setSnapshot] = useState<any>(null);
	const [spaceId, setSpaceId] = useState<string>("");
	const [selectedThread, setSelectedThread] = useState<string>("thread-main");
	const [participant, setParticipant] = useState<string>("alice");
	const [messageInput, setMessageInput] = useState<string>("");
	const [newThreadTitle, setNewThreadTitle] = useState<string>("");
	const [alarmText, setAlarmText] = useState<string>("Backup- und Wetterstatus prüfen");
	const [alarmDelayMs, setAlarmDelayMs] = useState<string>("2000");

	const loadSession = async () => {
		const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
		if (res.ok) {
			const data = await res.json();
			setSpaceId(data.spaceId ?? "");
			setSnapshot(data.snapshot ?? null);
		}
	};

	useEffect(() => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return startChatConnection({
   participant, threadId: selectedThread,
   connect: () => new WebSocket(proto + "//" + window.location.host + "/ws/chat/" + encodeURIComponent(sessionId)) as unknown as ChatSocket,
   snapshot: data => { if (data.snapshot) { setSpaceId(data.spaceId ?? ""); setSnapshot(data.snapshot); } },
   poll: loadSession,
   presenceFallback: data => fetch("/api/chat/sessions/" + encodeURIComponent(sessionId) + "/action", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
   }),
  });
 }, [sessionId, participant, selectedThread]);

	const sendAction = async (body: Record<string, unknown>) => {
		const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				...body,
				requestId: `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
			}),
		});
		if (res.ok) {
			const data = await res.json();
			if (data.snapshot) setSnapshot(data.snapshot);
		}
	};

	const executeStageDemo = async (stage: string) => {
		setActiveStage(stage);
		setRunningStage(true);
		try {
			const res = await fetch(`/api/chat/stages/${stage}/run`, { method: "POST" });
			if (res.ok) {
				const data = await res.json();
				setStageReport(data.report);
			}
		} finally {
			setRunningStage(false);
		}
	};

	const threads = snapshot?.threads ?? [];
	const threadMsgs = (snapshot?.messages ?? []).filter((m: any) => m.threadId === selectedThread);
	const currentStageMeta = STAGES.find((s) => s.id === activeStage) ?? STAGES[1]!;

	return (
		<div className="workbench-view">
			<div className="listing-heading">
				<div>
					<span className="eyebrow-copy">
						{locale === "de"
							? "INTERAKTIVE PI-SPACES WORKBENCH (STUFEN V1 BIS V6)"
							: "INTERACTIVE PI-SPACES WORKBENCH (STAGES V1 TO V6)"}
					</span>
					<h1>Multiplayer Space-Chat</h1>
					<p>
						{locale === "de"
							? "Das Earendil Multiplayer-Chat-Szenario vollständig umgesetzt mit nativen pi-spaces-Mitteln: NamedSpace, RequestRef-Claims, CompletionProfiles, Presence-Leases, TimerLock-Alarme und SearchTask-Subagent."
							: "The Earendil Multiplayer Chat scenario implemented purely with native pi-spaces primitives: NamedSpace, RequestRef claims, CompletionProfiles, Presence leases, TimerLock alarms, and SearchTask subagent."}
					</p>
				</div>
				<span className="meta-pill meta-pill--accent">
					{spaceId ? `SPACE: ${spaceId.slice(0, 18)}` : `SESSION: ${sessionId}`}
				</span>
			</div>

			{/* 6-Stage Selector */}
			<div className="stage-bar">
				{STAGES.map((st) => (
					<button
						key={st.id}
						type="button"
						className={activeStage === st.id ? "stage-tab is-active" : "stage-tab"}
						onClick={() => setActiveStage(st.id)}
					>
						<strong>{st.title[locale]}</strong>
						<span>{st.sub[locale]}</span>
						<small>{locale === "de" ? "Stufe auswählen" : "Select stage"}</small>
					</button>
				))}
			</div>

			<div className="wb-panel" style={{ marginBottom: "22px" }}>
				<div className="wb-panel__hdr">
					<span>
						{locale === "de"
							? `AKTIVE AUSBAUSTUFE: ${currentStageMeta.title.de.toUpperCase()} — ${currentStageMeta.sub.de}`
							: `ACTIVE STAGE: ${currentStageMeta.title.en.toUpperCase()} — ${currentStageMeta.sub.en}`}
					</span>
					<div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
						<LlmModelPicker locale={locale} />
						<button
							type="button"
							className="wb-btn wb-btn--secondary"
							onClick={() => onOpenArticle(currentStageMeta.articleId)}
						>
							{locale === "de" ? "Schritt-für-Schritt-Anleitung öffnen" : "Open Step-by-Step Guide"}
						</button>
						<button
							type="button"
							className="wb-btn"
							onClick={() => void executeStageDemo(activeStage)}
						>
							{runningStage
								? locale === "de"
									? "Stufe läuft …"
									: "Running stage …"
								: locale === "de"
									? `Stufe ${activeStage.toUpperCase()} jetzt live ausführen & prüfen`
									: `Run & verify stage ${activeStage.toUpperCase()} live`}
						</button>
					</div>
				</div>
				{stageReport ? (
					<div className="wb-panel__body">
						<div style={{ fontSize: "12px", color: "var(--accent-readable)", marginBottom: "8px", fontFamily: "var(--font-geist-mono)" }}>
							{locale === "de"
								? `✓ Live-Ausführung von ${stageReport.stage} erfolgreich abgeschlossen:`
								: `✓ Live execution of ${stageReport.stage} completed:`}
						</div>
						<pre style={{ margin: 0, maxHeight: "200px", overflow: "auto", fontSize: "11.5px", background: "var(--code-bg)", padding: "12px", borderRadius: "4px" }}>
							{JSON.stringify(stageReport, null, 2)}
						</pre>
					</div>
				) : null}
			</div>

			<div className="workbench-grid">
				{/* Left Column: Multiplayer Chat UI */}
				<div className="wb-panel">
					<div className="wb-panel__hdr">
						<span>MULTIPLAYER TERMINAL · SESSION &quot;{sessionId}&quot;</span>
					<span>REV #{snapshot?.rev ?? 0}</span>
					{snapshot?.integrityIssues?.length ? <span role="alert">{snapshot.integrityIssues.join("; ")}</span> : null}
					</div>
					<div className="wb-panel__body">
						{/* Participant Switcher & Quick Demo Steps */}
						<div className="wb-form-row" style={{ marginTop: 0, marginBottom: "12px", alignItems: "center" }}>
							<span style={{ fontSize: "11px", fontFamily: "var(--font-geist-mono)", color: "var(--muted)" }}>
								{locale === "de" ? "TEILNEHMER:" : "PARTICIPANT:"}
							</span>
							{["alice", "bob", "carol"].map((p) => (
								<button
									key={p}
									type="button"
									className={participant === p ? "wb-btn" : "wb-btn wb-btn--secondary"}
									onClick={() => {
										setParticipant(p);
										void sendAction({
											kind: "presence.join",
											participantId: p,
											username: p.toUpperCase(),
											activeThreadId: selectedThread,
										});
									}}
								>
									@{p}
								</button>
							))}
						</div>

						{/* Thread Tabs + Fork */}
						<div className="wb-form-row" style={{ marginBottom: "12px" }}>
							{threads.map((t: any) => (
								<button
									key={t.threadId}
									type="button"
									className={selectedThread === t.threadId ? "wb-btn" : "wb-btn wb-btn--secondary"}
									onClick={() => setSelectedThread(t.threadId)}
								>
									{t.title} ({t.threadId})
								</button>
							))}
						</div>

						{/* Quick Earendil Demo Walkthrough Buttons */}
						<div style={{ border: "1px solid var(--line)", padding: "10px", borderRadius: "5px", marginBottom: "12px", background: "var(--surface)" }}>
							<div style={{ fontSize: "10px", fontFamily: "var(--font-geist-mono)", color: "var(--accent-readable)", marginBottom: "6px" }}>
								{locale === "de"
									? "SCHNELLTEST DER EARENDIL-SEQUENZ MIT PI-SPACES-MITTELN:"
									: "QUICK-RUN EARENDIL SEQUENCE WITH PI-SPACES PRIMITIVES:"}
							</div>
							<div className="wb-form-row" style={{ marginTop: 0 }}>
								<button
									type="button"
									className="wb-btn wb-btn--secondary"
									onClick={() => {
										setSelectedThread("thread-ops");
										void sendAction({
											kind: "message.submit",
											threadId: "thread-ops",
											author: "bob",
											text: "Was haben wir bezüglich des Event-Stores entschieden?",
										});
									}}
								>
									{locale === "de"
										? "1. In Thread 2 fragen: „Was haben wir über den Event-Store entschieden?“ (Subagent)"
										: "1. Ask in Thread 2: 'What did we decide about the event store?' (Subagent)"}
								</button>
								<button
									type="button"
									className="wb-btn wb-btn--secondary"
									onClick={() => {
										const forkId = `fork-${Date.now().toString(36).slice(-3)}`;
										void sendAction({
											kind: "thread.fork",
											newThreadId: forkId,
											parentThreadId: selectedThread,
											forkUpToSeq: Math.max(1, threadMsgs.length),
											title: `Fork ab #${Math.max(1, threadMsgs.length)}`,
											author: participant,
										}).then(() => setSelectedThread(forkId));
									}}
								>
									{locale === "de"
										? `2. Aktuellen Thread forken (bis #${Math.max(1, threadMsgs.length)})`
										: `2. Fork active thread (up to #${Math.max(1, threadMsgs.length)})`}
								</button>
							</div>
						</div>

						{/* Messages List */}
						<div className="chat-messages">
							{threadMsgs.length === 0 ? (
								<div style={{ color: "var(--muted)", fontSize: "13px" }}>
									{locale === "de" ? "Noch keine Nachrichten in diesem Thread." : "No messages in this thread yet."}
								</div>
							) : (
								threadMsgs.map((m: any) => (
									<div
										key={m.msgId}
										className={`chat-msg ${m.role === "assistant" ? "chat-msg--assistant" : m.role === "alarm" ? "chat-msg--alarm" : ""}`}
									>
										<div className="chat-msg__meta">
											<b>
												#{m.seq} @{m.author} ({m.role})
											</b>
											{m.llmModel ? <span>🤖 {m.llmModel}{m.llmTokens ? ` · ${m.llmTokens} tok` : ""}</span> : <span>{m.taskId}</span>}
										</div>
										<div>{m.text}</div>
									</div>
								))
							)}
						</div>

						{/* Send Message Form */}
						<form
							className="wb-form-row"
							onSubmit={(e) => {
								e.preventDefault();
								if (!messageInput.trim()) return;
								const txt = messageInput.trim();
								setMessageInput("");
								void sendAction({
									kind: "message.submit",
									threadId: selectedThread,
									author: participant,
									text: txt,
								});
							}}
						>
							<input
								id="chat-msg-input"
								className="wb-input"
								value={messageInput}
								onChange={(e: any) => setMessageInput(e.target.value)}
								placeholder={
									locale === "de"
										? `Nachricht als @${participant} senden (oder „Was haben wir … entschieden?“) …`
										: `Send message as @${participant} (or 'What did we decide …?') …`
								}
							/>
							<button type="submit" className="wb-btn">
								{locale === "de" ? "Senden (write + ChatTask)" : "Send (write + ChatTask)"}
							</button>
						</form>

						{/* Create Thread & Schedule Alarm */}
						<div className="wb-form-row" style={{ marginTop: "14px" }}>
							<input
								id="new-thread-title"
								className="wb-input"
								value={newThreadTitle}
								onChange={(e: any) => setNewThreadTitle(e.target.value)}
								placeholder={locale === "de" ? "Titel für neuen Thread …" : "New thread title …"}
							/>
							<button
								type="button"
								className="wb-btn wb-btn--secondary"
								onClick={() => {
									if (!newThreadTitle.trim()) return;
									const tid = `thread-${Date.now().toString(36).slice(-4)}`;
									const title = newThreadTitle.trim();
									setNewThreadTitle("");
									void sendAction({
										kind: "thread.create",
										threadId: tid,
										title,
										author: participant,
									}).then(() => setSelectedThread(tid));
								}}
							>
								{locale === "de" ? "+ Thread (RequestRef)" : "+ Thread (RequestRef)"}
							</button>
						</div>

						<div className="wb-form-row" style={{ marginTop: "10px" }}>
							<input
								id="alarm-instruction-input"
								className="wb-input"
								value={alarmText}
								onChange={(e: any) => setAlarmText(e.target.value)}
								placeholder={locale === "de" ? "Geplante Aufgabe (ScheduledJob) …" : "Scheduled instruction …"}
							/>
							<input
								id="alarm-delay-input"
								className="wb-input"
								style={{ maxWidth: "100px" }}
								value={alarmDelayMs}
								onChange={(e: any) => setAlarmDelayMs(e.target.value)}
								placeholder="ms"
							/>
							<button
								type="button"
								className="wb-btn wb-btn--secondary"
								onClick={() => {
									void sendAction({
										kind: "alarm.schedule",
										threadId: selectedThread,
										instruction: alarmText,
										delayMs: Number(alarmDelayMs) || 2000,
										author: participant,
									});
								}}
							>
								{locale === "de" ? "⏰ TimerLock-Alarm planen" : "⏰ Schedule TimerLock Alarm"}
							</button>
						</div>
					</div>
				</div>

				{/* Right Column: Live pi-spaces Inspector */}
				<div className="wb-panel">
					<div className="wb-panel__hdr">
						<span>LIVE PI-SPACES INSPECTOR (READPAGE + CHANGES)</span>
						<span>{snapshot?.rawEntryCount ?? 0} ENTRIES</span>
					</div>
					<div className="wb-panel__body">
						<div className="kv-list" style={{ marginBottom: "16px" }}>
							<div className="kv-item">
								<span>SPACE REVISION</span>
								<strong>rev {snapshot?.rev ?? 0}</strong>
							</div>
							<div className="kv-item">
								<span>COMPLETION PROFILES</span>
								<strong>ChatTask→Msg, SearchTask→SearchResult</strong>
							</div>
							<div className="kv-item">
								<span>PRESENCE LEASES (30S TTL)</span>
								<strong>{(snapshot?.presence ?? []).length} active</strong>
							</div>
							<div className="kv-item">
								<span>SCHEDULED ALARMS</span>
								<strong>{(snapshot?.scheduledJobs ?? []).length} jobs</strong>
							</div>
						</div>

						{/* Subagent Trace Inspector */}
						<div style={{ marginBottom: "16px" }}>
							<div style={{ font: "650 10px/1 var(--font-geist-mono)", color: "var(--accent-readable)", marginBottom: "8px" }}>
								{locale === "de"
									? "SEARCH_HISTORY SUBAGENT RUNS (SearchTask → SubagentStep → SearchResult):"
									: "SEARCH_HISTORY SUBAGENT RUNS (SearchTask → SubagentStep → SearchResult):"}
							</div>
							{(snapshot?.subagentRuns ?? []).length === 0 ? (
								<div style={{ fontSize: "12px", color: "var(--muted)" }}>
									{locale === "de"
										? "Noch kein Subagent-Lauf. Klicke links auf Schnelltest #1!"
										: "No subagent run yet. Click Quick-Run #1 on the left!"}
								</div>
							) : (
								(snapshot?.subagentRuns ?? []).map((run: any) => (
									<div
										key={run.searchId}
										style={{ border: "1px solid var(--line)", background: "var(--surface)", padding: "10px", borderRadius: "4px", marginBottom: "8px", fontSize: "12px" }}
									>
										<div style={{ fontFamily: "var(--font-geist-mono)", color: "var(--text-strong)" }}>
											<strong>{run.searchId}</strong> ({run.status}) — Cited: [{(run.citedThreadIds ?? []).join(", ")}]
										</div>
										<div style={{ color: "var(--muted-strong)", marginTop: "4px" }}>{run.answer}</div>
										<div style={{ marginTop: "6px", fontFamily: "var(--font-geist-mono)", fontSize: "11px", color: "var(--muted)" }}>
											Steps:{" "}
											{(run.steps ?? [])
												.map((s: any) => `"${s.queryTerm}" (${s.matchCount} hits)`)
												.join(" · ")}
										</div>
									</div>
								))
							)}
						</div>

						{/* Scheduled Alarms & TimerLock Leases */}
						<div>
							<div style={{ font: "650 10px/1 var(--font-geist-mono)", color: "var(--accent-readable)", marginBottom: "8px" }}>
								{locale === "de"
									? "GEPLANTE ALARME (ScheduledJob + TimerLock Lease):"
									: "SCHEDULED ALARMS (ScheduledJob + TimerLock Lease):"}
							</div>
							{(snapshot?.scheduledJobs ?? []).length === 0 ? (
								<div style={{ fontSize: "12px", color: "var(--muted)" }}>
									{locale === "de" ? "Keine geplanten Alarme." : "No scheduled alarms."}
								</div>
							) : (
								(snapshot?.scheduledJobs ?? []).map((j: any) => (
									<div
										key={j.jobId}
										style={{ border: "1px solid var(--line)", background: "var(--surface)", padding: "8px 10px", borderRadius: "4px", marginBottom: "6px", fontSize: "12px" }}
									>
										<strong>{j.jobId}</strong> [{j.status}] — {j.instruction}
									</div>
								))
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
