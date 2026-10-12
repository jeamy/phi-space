// Bootstrap: a tiny store (plain object + property pushes into the components), one EventSource for
// /api/live, and the server-push handlers. Reconnect is EventSource's own; after a reconnect the server
// sends `hello` again, which re-baselines everything — no replay needed.
import "./components.js";

const $ = (s) => document.querySelector(s);
const spaces = $("#spaces"), detail = $("#detail"), metricsEl = $("#metrics"), conn = $("#conn"), connLabel = $("#conn-label");

const HISTORY_MAX = 60;
const history = {};
let rev = 0;

const setConn = (state, label) => { conn.className = `conn ${state}`; if (label) connLabel.textContent = label; };

const active = () => {
	const rates = metricsEl.metrics?.rates ?? {};
	const busy = (rates.writes ?? 0) + (rates.reads ?? 0) + (rates.takes ?? 0) + (rates.events ?? 0);
	conn.classList.toggle("pulse", busy > 0);
};

const remember = (m) => {
	for (const key of ["writes", "reads", "takes", "events", "failures"]) {
		const list = history[key] ?? (history[key] = []);
		list.push(m.rates?.[key] ?? 0);
		if (list.length > HISTORY_MAX) list.shift();
	}
	metricsEl.history = history;
};

const select = (id) => {
	spaces.selected = id;
	detail.spaceId = id;
};

const onMessage = (msg) => {
	if (msg.type === "hello" || msg.type === "spaces") {
		spaces.spaces = msg.spaces ?? [];
		if (!spaces.selected || !msg.spaces?.some((s) => s.spaceId === spaces.selected)) select(msg.spaces?.[0]?.spaceId ?? null);
		else spaces.render();
	} else if (msg.type === "space") {
		spaces.spaces = (spaces.spaces ?? []).map((s) => (s.spaceId === msg.spaceId ? { ...s, stats: msg.stats } : s));
		if (msg.spaceId === spaces.selected) { rev++; detail.rev = rev; }
	} else if (msg.type === "metrics") {
		metricsEl.metrics = msg;
		remember(msg);
		active();
	}
};

const es = new EventSource("/api/live");
es.onopen = () => setConn("live", "live");
es.onerror = () => setConn("offline", "verbinde…");
es.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore a partial line */ } };

// initial metrics (SSE pushes the next ones every few seconds)
fetch("/api/metrics").then((r) => r.json()).then((m) => { metricsEl.metrics = m; remember(m); active(); }).catch(() => {});

spaces.addEventListener("select", (e) => select(e.detail));

// theme: stored choice wins, else the system preference
const root = document.documentElement;
root.dataset.theme = localStorage.getItem("dashboard-theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
$("#theme").onclick = () => {
	root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
	localStorage.setItem("dashboard-theme", root.dataset.theme);
};
