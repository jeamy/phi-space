// Bootstrap: one EventSource for /api/live, the server-push handlers, the selection (an app or a space of the own
// store) and the theme. Reconnect is EventSource's own; after a reconnect the server sends `hello` again, which
// re-baselines everything — no replay needed.
import "./components.js";
import { applyThemeToDocument, PALETTES } from "./palettes.js";

const $ = (s) => document.querySelector(s);
const appsEl = $("#apps"), spaces = $("#spaces"), appDetail = $("#app-detail"), detail = $("#detail"), compare = $("#compare"), activity = $("#activity"),
	metricsEl = $("#metrics"), conn = $("#conn"), connLabel = $("#conn-label");

// ---- theme: mode and palette like the projects (same palettes, same controls), remembered in this browser
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };
let mode = read("dashboard.mode") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
if (mode !== "dark" && mode !== "light") mode = "dark";
let palette = read("dashboard.palette");
if (!PALETTES.some((p) => p.id === palette)) palette = PALETTES[0].id;
const paletteSelect = $("#palette");
paletteSelect.innerHTML = PALETTES.map((p) => `<option value="${p.id}">${p.label.de}</option>`).join("");
const applyTheme = () => {
	applyThemeToDocument(mode, palette);
	paletteSelect.value = palette;
	document.querySelectorAll(".mode-switch button").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === mode));
};
document.querySelectorAll(".mode-switch button").forEach((b) => { b.onclick = () => { mode = b.dataset.mode; write("dashboard.mode", mode); applyTheme(); }; });
paletteSelect.onchange = () => { palette = paletteSelect.value; write("dashboard.palette", palette); applyTheme(); };
applyTheme();

// ---- live data
const HISTORY_MAX = 60;
const SERIES_MAX = 450; // as many as the server keeps (src/dashboard.ts, APP_SERIES)
const history = {};
let rev = 0;
let apps = [];
let selection = null; // { kind: "app" | "space", id }

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

const select = (kind, id) => {
	selection = id ? { kind, id } : null;
	appsEl.selected = kind === "app" ? id : null;
	spaces.selected = kind === "space" ? id : null;
	appsEl.render(); spaces.render();
	appDetail.hidden = kind !== "app";
	detail.hidden = kind !== "space";
	if (kind === "app") appDetail.app = apps.find((a) => a.id === id) ?? null;
	else detail.spaceId = id;
};

const showApps = () => {
	appsEl.apps = apps;
	compare.apps = apps;
	activity.apps = apps;
	if (selection?.kind === "app") appDetail.app = apps.find((a) => a.id === selection.id) ?? null;
};

const onMessage = (msg) => {
	if (msg.type === "hello" || msg.type === "spaces") {
		spaces.spaces = msg.spaces ?? [];
		if (msg.apps) { apps = msg.apps; showApps(); }
		if (!selection) {
			// first view: the first app that is online, else the first space of the own store
			const app = apps.find((a) => a.online);
			if (app) select("app", app.id); else select("space", msg.spaces?.[0]?.spaceId ?? null);
		} else if (selection.kind === "space" && !msg.spaces?.some((s) => s.spaceId === selection.id)) select("space", msg.spaces?.[0]?.spaceId ?? null);
	} else if (msg.type === "space") {
		spaces.spaces = (spaces.spaces ?? []).map((s) => (s.spaceId === msg.spaceId ? { ...s, stats: msg.stats } : s));
		if (selection?.kind === "space" && msg.spaceId === selection.id) { rev++; detail.rev = rev; }
	} else if (msg.type === "apps") {
		// a poll sends its one new point; the curves themselves came with the app list
		const changed = new Map(msg.apps.map((a) => [a.id, a]));
		apps = apps.map((a) => {
			const c = changed.get(a.id);
			if (!c) return a;
			const { point, ...rest } = c;
			return { ...rest, series: point ? [...(a.series ?? []), point].slice(-SERIES_MAX) : a.series ?? [] };
		});
		showApps();
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

appsEl.addEventListener("select-app", (e) => select("app", e.detail));
spaces.addEventListener("select", (e) => select("space", e.detail));
