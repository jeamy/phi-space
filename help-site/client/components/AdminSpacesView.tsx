"use client";
// Login-protected AdminSpaces Portal on https://spaces.eibrain.org/?view=admin
// Provides 1:1 parity with `pi-termux-mobile` (`spaces.html` + `steuerung.html` / `spaces-mobile.mjs`).

import { useEffect, useState } from "react";

interface AdminSpacesViewProps {
	locale: "de" | "en";
}

export function AdminSpacesView(props: AdminSpacesViewProps) {
	const { locale } = props;
	const [session, setSession] = useState<any>(null);
	const [overview, setOverview] = useState<any>(null);
	const [loginUser, setLoginUser] = useState<string>("admin@spaces.eibrain.org");
	const [loginPassword, setLoginPassword] = useState<string>("");
	const [statusMsg, setStatusMsg] = useState<string>("");

	// Form states matching steuerung.html & spaces.html
	const [enrollPeerId, setEnrollPeerId] = useState<string>("mobile-admin-xiaomi");
	const [enrollEndpoint, setEnrollEndpoint] = useState<string>("tcp://100.64.0.10:9440");
	const [lastQrPayload, setLastQrPayload] = useState<string>("");

	const [newSpaceAlias, setNewSpaceAlias] = useState<string>("chat-event-2026");
	const [inspectedObjects, setInspectedObjects] = useState<any>(null);

	const [workerAssignId, setWorkerAssignId] = useState<string>("assign-chat-main");
	const [workerKind, setWorkerKind] = useState<string>("chat-worker");
	const [workerTargetSpace, setWorkerTargetSpace] = useState<string>("default");
	const [workerCount, setWorkerCount] = useState<string>("2");
	const [workerRunId, setWorkerRunId] = useState<string>("");

	const [sieveRunId, setSieveRunId] = useState<string>("sieve-run-1");
	const sieveStart = "1";
	const [sieveEnd, setSieveEnd] = useState<string>("1001");
	const sieveBlock = "128";

	const [deploymentJson, setDeploymentJson] = useState<string>(() =>
		JSON.stringify(
			{
				schemaVersion: 1,
				deployment: "chat-cluster-demo",
				configRevision: 1,
				coordinator: "host-a",
				hosts: [{ alias: "host-a", role: "coordinator" }],
				spaces: [
					{ alias: "control", host: "host-a", purpose: "control" },
					{ alias: "chat-prod-room", host: "host-a", purpose: "data", maxSpaceBytes: 67108864 },
				],
				workers: [
					{
						alias: "chat-worker-main",
						host: "host-a",
						kind: "chat-worker",
						targetSpace: "chat-prod-room",
						count: 2,
					},
				],
			},
			null,
			2,
		),
	);
	const [deploymentResult, setDeploymentResult] = useState<any>(null);

	const checkSessionAndLoad = async () => {
		const res = await fetch("/api/admin/session");
		if (!res.ok) return;
		const data = await res.json();
		if (data.authenticated && data.session) {
			setSession(data.session);
			const ov = await fetch("/api/admin/overview");
			if (ov.ok) setOverview(await ov.json());
		} else {
			setSession(null);
		}
	};

	useEffect(() => {
		void checkSessionAndLoad();
	}, []);

	// Live values: spaces/runs/workers/alerts only refreshed on login or after a command
	// before – poll the overview every 5s while a session is open.
	useEffect(() => {
		if (!session) return;
		const t = setInterval(async () => {
			try {
				const ov = await fetch("/api/admin/overview");
				if (ov.ok) setOverview(await ov.json());
			} catch {
				// transient
			}
		}, 5000);
		return () => clearInterval(t);
	}, [session]);

	const handleLogin = async (e: any) => {
		e.preventDefault();
		setStatusMsg("");
		const res = await fetch("/api/admin/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				username: loginUser,
				password: loginPassword,
			}),
		});
		const data = await res.json();
		if (!res.ok) {
			setStatusMsg(data.error ?? (locale === "de" ? "Login fehlgeschlagen" : "Login failed"));
			return;
		}
		setSession(data.session);
		setStatusMsg(locale === "de" ? "Erfolgreich in AdminSpaces angemeldet." : "Logged in to AdminSpaces.");
		const ov = await fetch("/api/admin/overview");
		if (ov.ok) setOverview(await ov.json());
	};

	const handleLogout = async () => {
		await fetch("/api/admin/logout", {
			method: "POST",
			headers: session ? { "x-csrf-token": session.csrfToken } : {},
		});
		setSession(null);
		setOverview(null);
	};

	const sendAdminCommand = async (kind: string, args: Record<string, unknown>, customCommandId?: string) => {
		if (!session) return;
		const commandId =
			customCommandId ?? `w-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		setStatusMsg(`${locale === "de" ? "Sende Auftrag" : "Sending command"} ${commandId} …`);
		const res = await fetch("/api/admin/command", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-csrf-token": session.csrfToken,
			},
			body: JSON.stringify({ commandId, kind, args }),
		});
		const data = await res.json();
		if (!res.ok) {
			setStatusMsg(
				`${locale === "de" ? "Fehler" : "Error"} (${commandId}): ${data.error ?? (locale === "de" ? "Unbekannt" : "Unknown")}`,
			);
			return;
		}
		if (data.overview) setOverview(data.overview);
		if (kind === "createEnroll" && data.result?.qrPayload) {
			setLastQrPayload(data.result.qrPayload);
		}
		if (
			kind === "planDeployment" ||
			kind === "applyDeployment" ||
			kind === "startWorkers" ||
			kind === "exportDeployment"
		) {
			setDeploymentResult(data.result);
		}
		setStatusMsg(
			`${locale === "de" ? "Auftrag bestätigt" : "Command confirmed"}: ${commandId} (${data.operation?.state ?? "completed"})`,
		);
	};

	const inspectSpace = async (spaceIdOrAlias: string) => {
		const res = await fetch(`/api/admin/objects?space=${encodeURIComponent(spaceIdOrAlias)}&limit=50`);
		if (res.ok) {
			setInspectedObjects(await res.json());
		}
	};

	if (!session) {
		return (
			<div className="workbench-view">
				<div className="listing-heading">
					<div>
						<span className="eyebrow-copy">
							{locale === "de"
								? "GESCHÜTZTER ADMINISTRATIONSBEREICH · SPACES.EIBRAIN.ORG"
								: "PROTECTED ADMINISTRATION AREA · SPACES.EIBRAIN.ORG"}
						</span>
						<h1>AdminSpaces Login</h1>
						<p>
							{locale === "de"
								? "Steuerung und Überwachung aller Spaces, Läufe (RunGate), Worker, Alarme und Smartphone-Kopplungen (analog zu spaces.html & steuerung.html in pi-termux-mobile)."
								: "Control and monitoring of all spaces, runs (RunGate), workers, alerts, and smartphone pairings (matching spaces.html & steuerung.html in pi-termux-mobile)."}
						</p>
					</div>
					<span className="meta-pill meta-pill--accent">LAYER B + CSRF PROTECTED</span>
				</div>

				<div className="wb-panel" style={{ maxWidth: "540px" }}>
					<div className="wb-panel__hdr">
						<span>ADMIN AUTHENTICATION</span>
						<span>CONTROL SPACE</span>
					</div>
					<form className="wb-panel__body" onSubmit={handleLogin}>
						{statusMsg ? (
							<div style={{ color: "var(--warning)", marginBottom: "12px", fontSize: "13px" }}>{statusMsg}</div>
						) : null}
						<div style={{ display: "grid", gap: "12px" }}>
							<label style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
								<span>{locale === "de" ? "Admin Principal / E-Mail" : "Admin Principal / Email"}</span>
								<input
									id="admin-login-user"
									className="wb-input"
									value={loginUser}
									onChange={(e: any) => setLoginUser(e.target.value)}
								/>
							</label>
							<label style={{ display: "grid", gap: "4px", fontSize: "12px" }}>
								<span>
									{locale === "de"
										? "Konfiguriertes Admin-Passwort"
										: "Configured admin password"}
								</span>
								<input
									id="admin-login-pwd"
									type="password"
									className="wb-input"
									value={loginPassword}
									onChange={(e: any) => setLoginPassword(e.target.value)}
								/>
							</label>
							<button type="submit" className="wb-btn" style={{ height: "40px" }}>
								{locale === "de" ? "In AdminSpaces anmelden" : "Sign in to AdminSpaces"}
							</button>
						</div>
					</form>
				</div>
			</div>
		);
	}

	const spacesList = overview?.spaces ?? [];
	const runsList = overview?.runs ?? [];
	const desiredWorkers = overview?.workers?.desired ?? [];
	const alertsList = overview?.alerts ?? [];
	const operationsList = overview?.operations ?? [];
	const auditList = overview?.audit ?? [];

	return (
		<div className="workbench-view">
			<div className="listing-heading">
				<div>
					<span className="eyebrow-copy">
						{locale === "de"
							? "ADMINSPACES STEUERZENTRALE (WEB & MOBILE PARITÄT)"
							: "ADMINSPACES CONTROL CENTER (WEB & MOBILE PARITY)"}
					</span>
					<h1>
						{locale === "de"
							? "Spaces, Läufe & Worker steuern"
							: "Control Spaces, Runs & Workers"}
					</h1>
					<p>
						{locale === "de"
							? "Jeder Auftrag erhält vor dem Senden eine stabile commandId. Bei Zeitüberschreitung oder Doppeltippen wird dieselbe ID ohne Zweitwirkung wiederverwendet."
							: "Every command receives a stable commandId before sending. On timeout or double-click, the same ID is reused without duplicate execution."}
					</p>
				</div>
				<div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
					<span className="meta-pill meta-pill--accent">KEY: {overview?.profile?.keyId}</span>
					<button type="button" className="wb-btn wb-btn--secondary" onClick={() => void handleLogout()}>
						{locale === "de" ? "Abmelden" : "Logout"}
					</button>
				</div>
			</div>

			{statusMsg ? (
				<div
					style={{
						border: "1px solid var(--accent)",
						background: "var(--surface-raised)",
						padding: "12px 16px",
						borderRadius: "6px",
						marginBottom: "20px",
						fontFamily: "var(--font-geist-mono)",
						fontSize: "12px",
					}}
				>
					{statusMsg}
				</div>
			) : null}

			<div className="admin-grid">
				{/* 1. Gerät koppeln & Schlüsselverwaltung (wie spaces.html) */}
				<div className="wb-panel">
					<div className="wb-panel__hdr">
						<span>
							{locale === "de"
								? "1. GERÄTE-PAIRING (MOBILE QR) & SCHLÜSSEL (SPACES.HTML)"
								: "1. DEVICE PAIRING (MOBILE QR) & KEYS (SPACES.HTML)"}
						</span>
						<span>ED25519</span>
					</div>
					<div className="wb-panel__body">
						<div className="kv-list" style={{ marginBottom: "12px" }}>
							<div className="kv-item">
								<span>PEER-ID</span>
								<strong>{overview?.profile?.peerId}</strong>
							</div>
							<div className="kv-item">
								<span>CONTROL HOST</span>
								<strong>{overview?.profile?.controlHostId}</strong>
							</div>
						</div>
						<div className="wb-form-row">
							<input
								id="enroll-peer-input"
								className="wb-input"
								value={enrollPeerId}
								onChange={(e: any) => setEnrollPeerId(e.target.value)}
								placeholder={locale === "de" ? "Smartphone Peer-ID" : "Phone Peer ID"}
							/>
							<input
								id="enroll-ep-input"
								className="wb-input"
								value={enrollEndpoint}
								onChange={(e: any) => setEnrollEndpoint(e.target.value)}
								placeholder="tcp://100.x.x.x:9440"
							/>
						</div>
						<div className="wb-form-row">
							<button
								type="button"
								className="wb-btn"
								onClick={() =>
									void sendAdminCommand("createEnroll", {
										peerId: enrollPeerId,
										endpoint: enrollEndpoint,
										role: "admin",
									})
								}
							>
								{locale === "de"
									? "Enrollment-QR für Smartphone erzeugen (createEnroll)"
									: "Generate Enrollment QR for Phone (createEnroll)"}
							</button>
							<button
								type="button"
								className="wb-btn wb-btn--secondary"
								onClick={() => void sendAdminCommand("rotateKey", {})}
							>
								{locale === "de" ? "Eigenen Schlüssel rotieren (rotate)" : "Rotate Own Key (rotate)"}
							</button>
						</div>
						{lastQrPayload ? (
							<pre style={{ marginTop: "12px", fontSize: "11px", background: "var(--code-bg)", padding: "10px", borderRadius: "4px", overflowX: "auto" }}>
								{lastQrPayload}
							</pre>
						) : null}
					</div>
				</div>

				{/* 2. Spaces Lebenszyklus & Objekt-Inspektor */}
				<div className="wb-panel">
					<div className="wb-panel__hdr">
						<span>
							{locale === "de"
								? "2. SPACES VERWALTEN & OBJEKTE INSPIZIEREN"
								: "2. MANAGE SPACES & INSPECT OBJECTS"}
						</span>
						<span>{spacesList.length} SPACES</span>
					</div>
					<div className="wb-panel__body">
						<div className="wb-form-row" style={{ marginTop: 0, marginBottom: "12px" }}>
							<input
								id="create-space-alias"
								className="wb-input"
								value={newSpaceAlias}
								onChange={(e: any) => setNewSpaceAlias(e.target.value)}
								placeholder={
									locale === "de" ? "Space Alias (z.B. chat-room-2)" : "Space alias (e.g. chat-room-2)"
								}
							/>
							<button
								type="button"
								className="wb-btn"
								onClick={() => void sendAdminCommand("createSpace", { alias: newSpaceAlias })}
							>
								{locale === "de" ? "Space anlegen / wiederverwenden" : "Create / Reuse Space"}
							</button>
						</div>
						<div style={{ maxHeight: "200px", overflowY: "auto", display: "grid", gap: "6px" }}>
							{spacesList.map((sp: any) => (
								<div
									key={sp.spaceId}
									style={{
										border: "1px solid var(--line)",
										background: "var(--surface)",
										padding: "8px 10px",
										borderRadius: "4px",
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										fontSize: "12px",
									}}
								>
									<div>
										<strong>{sp.alias}</strong> <code>({sp.spaceId.slice(0, 12)})</code>
										{sp.archived ? <span style={{ color: "var(--warning)", marginLeft: "6px" }}>[ARCHIVED]</span> : null}
										<div style={{ color: "var(--muted)", fontSize: "11px" }}>
											Entries: {sp.stats?.entries ?? 0} · Txns: {sp.stats?.txns ?? 0} · Waiters: {sp.stats?.waiters ?? 0}
										</div>
									</div>
									<div style={{ display: "flex", gap: "6px" }}>
										<button
											type="button"
											className="wb-btn wb-btn--secondary"
											onClick={() => void inspectSpace(sp.spaceId)}
										>
											{locale === "de" ? "Objekte" : "Objects"}
										</button>
										{sp.alias !== "default" && sp.alias !== "control" ? (
											<>
												{sp.archived ? (
													<button
														type="button"
														className="wb-btn wb-btn--secondary"
														onClick={() => void sendAdminCommand("reactivateSpace", { spaceId: sp.spaceId })}
													>
														{locale === "de" ? "Reaktivieren" : "Reactivate"}
													</button>
												) : (
													<button
														type="button"
														className="wb-btn wb-btn--secondary"
														onClick={() => void sendAdminCommand("archiveSpace", { spaceId: sp.spaceId })}
													>
														{locale === "de" ? "Archivieren" : "Archive"}
													</button>
												)}
												<button
													type="button"
													className="wb-btn wb-btn--danger"
													onClick={() => {
														if (confirm(locale === "de" ? `Space "${sp.alias}" endgültig löschen?` : `Permanently delete space "${sp.alias}"?`)) {
															void sendAdminCommand("deleteSpace", { spaceId: sp.spaceId });
														}
													}}
												>
													{locale === "de" ? "Löschen" : "Delete"}
												</button>
											</>
										) : null}
									</div>
								</div>
							))}
						</div>
						{inspectedObjects ? (
							<pre style={{ marginTop: "10px", maxHeight: "150px", overflow: "auto", fontSize: "11px", background: "var(--code-bg)", padding: "10px" }}>
								{JSON.stringify(inspectedObjects, null, 2)}
							</pre>
						) : null}
					</div>
				</div>

				{/* 3. Worker-Steuerung (WorkerAssignments & WorkerSupervisor) */}
				<div className="wb-panel">
					<div className="wb-panel__hdr">
						<span>
							{locale === "de"
								? "3. WORKER SKALIEREN (SETWORKERS / WORKERSUPERVISOR)"
								: "3. SCALE WORKERS (SETWORKERS / WORKERSUPERVISOR)"}
						</span>
						<span>GEN #{overview?.workers?.generation ?? 0}</span>
					</div>
					<div className="wb-panel__body">
						<div className="wb-form-row" style={{ marginTop: 0 }}>
							<input
								id="worker-assign-id"
								className="wb-input"
								value={workerAssignId}
								onChange={(e: any) => setWorkerAssignId(e.target.value)}
								placeholder={locale === "de" ? "Zuweisungs-ID" : "Assignment ID"}
							/>
							<select
								className="wb-input"
								value={workerKind}
								onChange={(e: any) => setWorkerKind(e.target.value)}
							>
								<option value="chat-worker">chat-worker</option>
								<option value="search-subagent">search-subagent</option>
								<option value="sieve">sieve</option>
							</select>
						</div>
						<div className="wb-form-row">
							<input
								id="worker-target-space"
								className="wb-input"
								value={workerTargetSpace}
								onChange={(e: any) => setWorkerTargetSpace(e.target.value)}
								placeholder={
									locale === "de" ? "Ziel-Space-ID oder Alias" : "Target space ID or alias"
								}
							/>
							<input
								id="worker-run-id"
								className="wb-input"
								style={{ maxWidth: "160px" }}
								value={workerRunId}
								onChange={(e: any) => setWorkerRunId(e.target.value)}
								placeholder={locale === "de" ? "runId (sieve)" : "runId (sieve)"}
							/>
							<input
								id="worker-count"
								type="number"
								min="0"
								max="64"
								className="wb-input"
								style={{ maxWidth: "90px" }}
								value={workerCount}
								onChange={(e: any) => setWorkerCount(e.target.value)}
							/>
							<button
								type="button"
								className="wb-btn"
								onClick={() =>
									void sendAdminCommand("setWorkers", {
										assignmentId: workerAssignId,
										kind: workerKind,
										targetSpace: workerTargetSpace,
										count: Number(workerCount),
										...(workerRunId.trim() ? { runId: workerRunId.trim() } : {}),
									})
								}
							>
								{locale === "de" ? "Anzahl setzen" : "Set Count"}
							</button>
						</div>
						<div style={{ marginTop: "12px", fontSize: "12px" }}>
							{desiredWorkers.length === 0 ? (
								<span style={{ color: "var(--muted)" }}>
									{locale === "de"
										? "Noch keine aktiven Worker-Zuweisungen."
										: "No active worker assignments yet."}
								</span>
							) : (
								desiredWorkers.map((w: any) => {
									const live = overview?.workers?.supervisor?.assignments?.[w.assignmentId];
									return (
										<div key={w.assignmentId} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
											<strong>{w.assignmentId}</strong>: {w.kind} → <code>{w.targetSpace}</code>
											{w.runId ? <span> · run <code>{w.runId}</code></span> : null} (
											{locale === "de" ? "Soll" : "Desired"}: <b>{w.count}</b>)
											{live ? (
												<div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
													active <b style={{ color: live.active > 0 ? "#34d399" : "var(--muted)" }}>{live.active}</b>
													{" · tasks "}{live.tasks}{" · errors "}{live.errors}
													{live.rejected ? <span style={{ color: "#f87171" }}> · ✗ {live.rejected}</span> : null}
													{live.lastError ? <span style={{ color: "#f87171" }}> · {live.lastError}</span> : null}
												</div>
											) : null}
										</div>
									);
								})
							)}
						</div>
					</div>
				</div>

				{/* 4. Läufe & RunGate-Barriere (startRun, pauseRun, resumeRun, stopRun) */}
				<div className="wb-panel">
					<div className="wb-panel__hdr">
						<span>
							{locale === "de"
								? "4. LÄUFE & RUNGATE-BARRIERE (RUNCONTROLLER)"
								: "4. RUNS & RUNGATE BARRIER (RUNCONTROLLER)"}
						</span>
						<span>{runsList.length} RUNS</span>
					</div>
					<div className="wb-panel__body">
						<div className="wb-form-row" style={{ marginTop: 0 }}>
							<input
								id="sieve-run-id"
								className="wb-input"
								value={sieveRunId}
								onChange={(e: any) => setSieveRunId(e.target.value)}
								placeholder="runId"
							/>
							<input
								id="sieve-end"
								className="wb-input"
								style={{ maxWidth: "95px" }}
								value={sieveEnd}
								onChange={(e: any) => setSieveEnd(e.target.value)}
								placeholder={locale === "de" ? "Ende (1001)" : "End (1001)"}
							/>
							<button
								type="button"
								className="wb-btn"
								onClick={() =>
									void sendAdminCommand("startRun", {
										runId: sieveRunId,
										start: Number(sieveStart),
										end: Number(sieveEnd),
										blockSize: Number(sieveBlock),
										members: overview?.profile?.defaultSieveSpaceId,
									})
								}
							>
								{locale === "de" ? "Sieblauf starten" : "Start Sieve Run"}
							</button>
						</div>
						<div style={{ marginTop: "12px", display: "grid", gap: "8px" }}>
							{runsList.map((r: any) => (
								<div
									key={r.runId}
									style={{
										border: "1px solid var(--line)",
										background: "var(--surface)",
										padding: "8px 10px",
										borderRadius: "4px",
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										fontSize: "12px",
									}}
								>
									<div style={{ minWidth: 0 }}>
										<strong>{r.runId}</strong> ({r.kind}) — Status: <b>{r.state}</b> (rev {r.revision})
										{r.progress ? (
											<div style={{ marginTop: 6 }}>
												<div style={{ height: 5, borderRadius: 3, background: "var(--line)", overflow: "hidden", maxWidth: 220 }}>
													<div
														style={{
															height: "100%",
															width: `${Math.min(100, Math.round((100 * r.progress.found) / Math.max(1, r.progress.expected)))}%`,
															background: r.progress.complete ? "#34d399" : "var(--accent-readable, #818cf8)",
														}}
													/>
												</div>
												<div style={{ color: "var(--muted)", fontSize: 11, marginTop: 3 }}>
													{r.progress.found}/{r.progress.expected} {locale === "de" ? "Ergebnisse" : "results"}
													{(r.progress.summary?.primes ?? r.progress.summary?.primeCount) != null
														? ` · ${r.progress.summary?.primes ?? r.progress.summary?.primeCount} ${locale === "de" ? "Primzahlen" : "primes"}${r.progress.complete ? "" : ` (${locale === "de" ? "läuft" : "running"})`}`
														: ""}
												</div>
												{r.progress.complete && r.progress.summary?.first != null && r.progress.summary?.last != null ? (
													<div style={{ color: "var(--muted)", fontSize: 10, fontFamily: "var(--font-geist-mono)", marginTop: 2, wordBreak: "break-all" }}>
														[{r.progress.summary.first} … {r.progress.summary.last}] · hash {String(r.progress.resultHash ?? "").slice(0, 12)}
													</div>
												) : null}
											</div>
										) : null}
									</div>
									<div style={{ display: "flex", gap: "6px" }}>
										{r.state === "running" ? (
											<button
												type="button"
												className="wb-btn wb-btn--secondary"
												onClick={() => void sendAdminCommand("pauseRun", { runId: r.runId })}
											>
												{locale === "de" ? "Pause" : "Pause"}
											</button>
										) : null}
										{r.state === "paused" ? (
											<button
												type="button"
												className="wb-btn wb-btn--secondary"
												onClick={() => void sendAdminCommand("resumeRun", { runId: r.runId })}
											>
												{locale === "de" ? "Fortsetzen" : "Resume"}
											</button>
										) : null}
										{r.state !== "stopped" ? (
											<button
												type="button"
												className="wb-btn wb-btn--secondary"
												onClick={() => void sendAdminCommand("stopRun", { runId: r.runId })}
											>
												{locale === "de" ? "Stopp" : "Stop"}
											</button>
										) : null}
									</div>
								</div>
							))}
						</div>
					</div>
				</div>

				{/* 5. Hinweise (Alerts) & Vorgänge (Operations mit stabiler commandId) */}
				<div className="wb-panel">
					<div className="wb-panel__hdr">
						<span>
							{locale === "de"
								? "5. HINWEISE (ALERTS) & VORGÄNGE (OPERATIONS)"
								: "5. ALERTS & OPERATIONS (COMMAND IDS)"}
						</span>
						<span>{alertsList.length} ALERTS</span>
					</div>
					<div className="wb-panel__body">
						<div style={{ marginBottom: "10px", fontSize: "12px" }}>
							{alertsList.length === 0 ? (
								<span style={{ color: "var(--success)" }}>
									{locale === "de"
										? "✓ Keine offenen Warnungen (collectAlerts grün)."
										: "✓ No active warnings (collectAlerts green)."}
								</span>
							) : (
								alertsList.map((a: any) => (
									<div key={a.key} style={{ color: "var(--warning)", marginBottom: "4px" }}>
										[{a.severity.toUpperCase()}] {a.subject}: {a.message}
									</div>
								))
							)}
						</div>
						<div style={{ maxHeight: "160px", overflowY: "auto", fontSize: "11.5px", fontFamily: "var(--font-geist-mono)" }}>
							{operationsList.map((op: any) => (
								<div key={op.commandId} style={{ padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
									<b>{op.commandId}</b> · {op.kind} → <span style={{ color: "var(--accent-readable)" }}>{op.state}</span>
								</div>
							))}
						</div>
					</div>
				</div>

				{/* 6. Audit-Log (Results im Control-Space ohne geheime Token-Payloads) */}
				<div className="wb-panel">
					<div className="wb-panel__hdr">
						<span>
							{locale === "de"
								? "6. AUDIT-LOG (CONTROL SPACE RESULTS)"
								: "6. AUDIT LOG (CONTROL SPACE RESULTS)"}
						</span>
						<span>{auditList.length} ENTRIES</span>
					</div>
					<div className="wb-panel__body">
						<div style={{ maxHeight: "200px", overflowY: "auto", fontSize: "11.5px", fontFamily: "var(--font-geist-mono)" }}>
							{auditList.map((entry: any) => (
								<div key={entry.commandId} style={{ padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
									[{new Date(entry.at).toLocaleTimeString()}] <b>{entry.kind}</b> ({entry.commandId}) by {entry.requestedBy} →{" "}
									<span>{entry.state}</span>
								</div>
							))}
						</div>
					</div>
				</div>

				{/* 7. Deklaratives Bootstrap & Deployment-Config (planDeployment, applyDeployment, startWorkers, exportDeployment) */}
				<div className="wb-panel" style={{ gridColumn: "1 / -1" }}>
					<div className="wb-panel__hdr">
						<span>
							{locale === "de"
								? "7. DEKLARATIVES BOOTSTRAP & DEPLOYMENT-CONFIG (V1 BIS V6 · DEPLOYMENTCONTROLLER)"
								: "7. DECLARATIVE BOOTSTRAP & DEPLOYMENT CONFIG (V1 TO V6 · DEPLOYMENTCONTROLLER)"}
						</span>
						<span>SCHEMA V1</span>
					</div>
					<div className="wb-panel__body">
						<p style={{ fontSize: "12.5px", color: "var(--muted-strong)", marginTop: 0 }}>
							{locale === "de"
								? "Deklarative Konfiguration für Hosts, Spaces und Worker (funktioniert vom lokalen Einzel-Host bis zum Multi-Host-Cluster; entspricht npm run bootstrap und dem Abschnitt Deployment in steuerung.html)."
								: "Declarative configuration for hosts, spaces, and workers (works from a local single-host setup to a multi-host cluster; matches npm run bootstrap and the Deployment section in steuerung.html)."}
						</p>
						<textarea
							id="deployment-config-textarea"
							className="wb-input"
							rows={10}
							style={{ width: "100%", fontFamily: "var(--font-geist-mono)", fontSize: "11.5px" }}
							value={deploymentJson}
							onChange={(e: any) => setDeploymentJson(e.target.value)}
						/>
						<div className="wb-form-row">
							<button
								type="button"
								className="wb-btn wb-btn--secondary"
								onClick={() => void sendAdminCommand("planDeployment", { config: deploymentJson })}
							>
								{locale === "de" ? "1. Plan prüfen (planDeployment)" : "1. Check Plan (planDeployment)"}
							</button>
							<button
								type="button"
								className="wb-btn"
								onClick={() => void sendAdminCommand("applyDeployment", { config: deploymentJson })}
							>
								{locale === "de" ? "2. Config anwenden (applyDeployment)" : "2. Apply Config (applyDeployment)"}
							</button>
							<button
								type="button"
								className="wb-btn wb-btn--secondary"
								onClick={() =>
									void sendAdminCommand("startWorkers", {
										deployment: (() => {
											try {
												return JSON.parse(deploymentJson).deployment || "chat-cluster-demo";
											} catch {
												return "chat-cluster-demo";
											}
										})(),
									})
								}
							>
								{locale === "de" ? "3. Worker starten (startWorkers)" : "3. Start Workers (startWorkers)"}
							</button>
							<button
								type="button"
								className="wb-btn wb-btn--secondary"
								onClick={() =>
									void sendAdminCommand("exportDeployment", {
										deployment: (() => {
											try {
												return JSON.parse(deploymentJson).deployment || "chat-cluster-demo";
											} catch {
												return "chat-cluster-demo";
											}
										})(),
									})
								}
							>
								{locale === "de" ? "4. Angewendeten Stand exportieren (exportDeployment)" : "4. Export Applied State (exportDeployment)"}
							</button>
						</div>
						{deploymentResult ? (
							<pre style={{ marginTop: "12px", maxHeight: "220px", overflow: "auto", fontSize: "11.5px", background: "var(--code-bg)", padding: "12px", borderRadius: "4px" }}>
								{JSON.stringify(deploymentResult, null, 2)}
							</pre>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
