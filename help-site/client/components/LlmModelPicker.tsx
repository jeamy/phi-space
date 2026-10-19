"use client";
// Live LLM model picker + on/off switch – shared by SpaceChatWorkbench and SocialFeedView.
// Reads GET /api/llm/models, switches via POST /api/llm/model ({model} and/or {on}).
import { useEffect, useMemo, useState } from "react";

interface LlmModelInfo { id: string; provider: string; label: string }

export function LlmModelPicker({ locale }: { locale: "de" | "en" }) {
	const [enabled, setEnabled] = useState(false);
	const [on, setOn] = useState(true);
	const [current, setCurrent] = useState<string | null>(null);
	const [models, setModels] = useState<LlmModelInfo[]>([]);
	const [busy, setBusy] = useState(false);
	const [canManage, setCanManage] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let dead = false;
		const checkSession = () => void fetch("/api/admin/session").then(r => r.json()).then(d => { if (!dead) setCanManage(Boolean(d.authenticated)); }).catch(() => {});
		checkSession();
		// An AdminSpaces login in another tab or after load must enable the picker without a page reload.
		const timer = setInterval(checkSession, 15_000);
		window.addEventListener("focus", checkSession);
		void fetch("/api/llm/models")
			.then((r) => r.json())
			.then((d) => {
				if (dead) return;
				setEnabled(Boolean(d.enabled));
				setOn(d.on !== false);
				setCurrent(d.current ?? null);
				setModels(d.models ?? []);
			})
			.catch(() => {});
		return () => { dead = true; clearInterval(timer); window.removeEventListener("focus", checkSession); };
	}, []);

	const groups = useMemo(() => {
		const g = new Map<string, LlmModelInfo[]>();
		for (const m of models) {
			if (!g.has(m.provider)) g.set(m.provider, []);
			g.get(m.provider)!.push(m);
		}
		return [...g.entries()];
	}, [models]);

	const post = async (body: Record<string, unknown>) => {
		if (busy) return;
		setBusy(true);
		try {
			const session = await fetch("/api/admin/session").then(r => r.json());
			if (!session.authenticated) throw new Error(locale === "de" ? "Admin-Anmeldung erforderlich" : "Admin sign-in required");
			const r = await fetch("/api/llm/model", {
				method: "POST",
				headers: { "content-type": "application/json", "x-csrf-token": session.session.csrfToken },
				body: JSON.stringify(body),
			});
			const d = await r.json();
			if (!r.ok) throw new Error(d.error ?? "Model change failed");
			setError("");
			if (d.current) setCurrent(d.current);
			if (typeof d.on === "boolean") setOn(d.on);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};

	if (!enabled) {
		return (
			<span className="sf-llm-off" title={locale === "de" ? "Keine Credentials konfiguriert (API-Key oder pi-CLI) – deterministischer Fallback aktiv" : "No credentials configured (API key or pi CLI) – deterministic fallback active"}>
				🤖 {locale === "de" ? "LLM: aus" : "LLM: off"}
			</span>
		);
	}

	return (
		<span className="sf-llm-picker">
			{error ? <span role="alert">{error}</span> : null}
			<button
				type="button"
				className={on ? "sf-llm-toggle sf-llm-toggle--on" : "sf-llm-toggle"}
				disabled={busy || !canManage}
				onClick={() => void post({ on: !on })}
				title={
					!canManage
						? (locale === "de" ? "AdminSpaces-Login erforderlich (Reiter ADMINSPACES)" : "AdminSpaces login required (ADMINSPACES tab)")
					: on
						? (locale === "de" ? "KI-Antworten ausschalten (Fallback: Templates)" : "Turn AI replies off (fallback: templates)")
						: (locale === "de" ? "KI-Antworten einschalten" : "Turn AI replies on")
				}
			>
				🤖 {on ? "ON" : "OFF"}
			</button>
			<select
				value={current ?? ""}
				disabled={busy || !on || !canManage}
				onChange={(e) => e.target.value && void post({ model: e.target.value })}
				title={!canManage ? (locale === "de" ? "AdminSpaces-Login erforderlich (Reiter ADMINSPACES)" : "AdminSpaces login required (ADMINSPACES tab)") : locale === "de" ? "Modell für Live-Antworten" : "Model for live replies"}
			>
				{groups.map(([provider, list]) => (
					<optgroup key={provider} label={provider}>
						{list.map((m) => (
							<option key={m.label} value={m.label}>{m.id}</option>
						))}
					</optgroup>
				))}
			</select>
		</span>
	);
}
