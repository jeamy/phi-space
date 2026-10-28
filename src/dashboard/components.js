// Web Components without framework or build step (decision for the dashboard plan: zero dependencies).
// Light DOM on purpose: one global stylesheet carries the palette tokens; components receive data via
// properties and re-render scheduled on one animation frame.
import { bytes, esc, hbars, num, sparkline, stackbar } from "./charts.js";

const FOREVER = 9007199254740991; // core.FOREVER = Number.MAX_SAFE_INTEGER
const TOP_TYPES = 12;
const relTime = (ms, now) => {
	if (!Number.isFinite(ms) || ms >= FOREVER) return "für immer";
	const d = ms - now;
	if (d <= 0) return "abgelaufen";
	const s = Math.round(d / 1000);
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
const defer = (el) => { if (!el._pending) { el._pending = true; requestAnimationFrame(() => { el._pending = false; el.render(); }); } };
const table = (head, rows) => (rows ? `<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows}</table>` : "");
const busy = (st) => (st?.txns ?? 0) > 0 || (st?.waiters ?? 0) > 0;

// ---- sections shared by the app and the space detail

const kpis = (st) => `<div class="kpis">${[
	["Entries", num(st.entries)], ["Typen", num(Object.keys(st.byType ?? {}).length)], ["Txn", num(st.txns)],
	["Wartend", num(st.waiters)], ["Outbox", num(st.outbox)], ["Speicher", bytes(st.bytes?.total)],
].map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`).join("")}</div>`;

/** Where the entries stand: visible, held by a transaction, not yet committed, lapsed (status colors, each named). */
const standing = (st) => stackbar([
	{ label: "sichtbar", value: st.entries ?? 0, color: "var(--success)" },
	{ label: "gesperrt", value: st.locked ?? 0, color: "var(--warning)" },
	{ label: "uncommitted", value: st.uncommitted ?? 0, color: "var(--bar-2)" },
	{ label: "abgelaufen", value: st.expired ?? 0, color: "var(--danger)" },
]);

/** Entries per type, largest first; past TOP_TYPES the rest folds into one row. */
const typeRows = (st) => {
	const all = Object.entries(st.byType ?? {}).sort((a, b) => b[1] - a[1]);
	const rows = all.slice(0, TOP_TYPES).map(([t, n]) => ({ key: t, label: t, value: n }));
	const rest = all.slice(TOP_TYPES);
	if (rest.length) rows.push({ key: null, label: `übrige (${rest.length} Typen)`, value: rest.reduce((s, [, n]) => s + n, 0) });
	return rows;
};

const BYTE_PARTS = [["entries", "Entries"], ["claims", "Claims"], ["outbox", "Outbox"], ["waiters", "Waiter"], ["registrations", "Registrierungen"], ["txns", "Transaktionen"]];
// an empty part still encodes as "[]" or "{}" (2 bytes): it is left out, not drawn as a sliver
const byteRows = (st) => BYTE_PARTS.map(([k, label]) => ({ label, value: st.bytes?.[k] ?? 0 })).filter((r) => r.value > 2).sort((a, b) => b.value - a.value);

const charts = (st, activeType) => `
<div class="grid2">
	<div class="card"><h3>Entries nach Typ <span class="muted">· Klick filtert</span></h3>${hbars(typeRows(st), { active: activeType, clickable: true }) || '<div class="empty">keine sichtbaren Entries</div>'}</div>
	<div class="card"><h3>Stand der Entries</h3>${standing(st)}
		<h3>Speicher nach Teil</h3>${hbars(byteRows(st), { color: "var(--bar-2)", format: bytes }) || '<div class="empty">leer</div>'}</div>
</div>`;

const fieldsCell = (fields) => {
	const text = JSON.stringify(fields);
	return text.length <= 160 ? `<td class="fields">${esc(text)}</td>`
		: `<td class="fields"><details><summary>${esc(text.slice(0, 140))}…</summary><pre>${esc(JSON.stringify(fields, null, 2))}</pre></details></td>`;
};

/** Left panel, top: the spaces of the projects (other processes); a click selects one. */
class AppsPanel extends HTMLElement {
	selected = null;
	set apps(v) { this._apps = v ?? []; defer(this); }
	get apps() { return this._apps; }
	connectedCallback() { this._apps = []; this.render(); }
	render() {
		const items = (this._apps ?? []).map((a) => `
<li class="item${a.id === this.selected ? " selected" : ""}${a.online ? "" : " is-offline"}" data-id="${esc(a.id)}" role="button" tabindex="0">
	<i class="state ${a.online ? (busy(a.stats) ? "busy" : "on") : "off"}" title="${a.online ? (busy(a.stats) ? "offene Transaktionen oder Waiter" : "online") : esc(`offline: ${a.error ?? "nicht erreichbar"}`)}"></i>
	<div class="item__body"><div class="name">${esc(a.label)}</div>
	<div class="meta">${a.online ? `${num(a.stats?.entries)} Entries · ${num(Object.keys(a.stats?.byType ?? {}).length)} Typen · ${bytes(a.stats?.bytes?.total)}` : `offline · ${esc((a.addresses ?? [a.address]).join(" · "))}`}</div>
	${a.online ? sparkline(a.history, 200, 22, "var(--bar)", "Entries im Verlauf") : ""}</div>
</li>`).join("");
		this.innerHTML = `<div class="panel"><h2>Apps</h2><ul class="list">${items || '<div class="empty">keine App-Quellen konfiguriert</div>'}</ul></div>`;
		this.querySelectorAll(".item").forEach((li) => {
			li.onclick = () => this.dispatchEvent(new CustomEvent("select-app", { bubbles: true, detail: li.dataset.id }));
			li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") li.click(); };
		});
	}
}
customElements.define("apps-panel", AppsPanel);

/** Left panel, below: the spaces of the dashboard's own store. */
class SpacesPanel extends HTMLElement {
	selected = null;
	set spaces(v) { this._spaces = v ?? []; defer(this); }
	get spaces() { return this._spaces; }
	connectedCallback() { this._spaces = []; this.render(); }
	render() {
		const items = (this._spaces ?? []).map((s) => `
<li class="item${s.spaceId === this.selected ? " selected" : ""}" data-id="${esc(s.spaceId)}" role="button" tabindex="0">
	<i class="state ${busy(s.stats) ? "busy" : "on"}" title="${busy(s.stats) ? "offene Transaktionen oder Waiter" : "ruhig"}"></i>
	<div class="item__body"><div class="name">${esc(s.alias)}</div>
	<div class="meta">${num(s.stats?.entries)} Entries · ${num(s.stats?.txns)} Txn · ${num(s.stats?.waiters)} wartend</div></div>
</li>`).join("");
		this.innerHTML = `<div class="panel"><h2>Spaces <span class="muted">· eigener Store</span></h2><ul class="list">${items || '<div class="empty">noch keine Spaces</div>'}</ul></div>`;
		this.querySelectorAll(".item").forEach((li) => {
			li.onclick = () => this.dispatchEvent(new CustomEvent("select", { bubbles: true, detail: li.dataset.id }));
			li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") li.click(); };
		});
	}
}
customElements.define("spaces-panel", SpacesPanel);

/** Middle panel for an app: charts from its stats, then its entries page by page (oldest first, the space's cursor). */
class AppDetail extends HTMLElement {
	connectedCallback() { this._app = null; this._page = null; this._type = null; this._cursors = [null]; this.render(); }
	set app(a) {
		const first = !this._app || this._app.id !== a?.id;
		this._app = a;
		if (first) { this._type = null; this._cursors = [null]; this._page = null; this.load(); }
		else if (this._cursors.length === 1) this.load(); // on the first page a change refreshes the rows too
		defer(this);
	}
	get app() { return this._app; }
	async load() {
		const a = this._app;
		if (!a?.online) { this._page = null; defer(this); return; }
		const after = this._cursors[this._cursors.length - 1];
		const q = new URLSearchParams({ limit: "50", ...(after ? { after: String(after) } : {}), ...(this._type ? { type: this._type } : {}) });
		try {
			const r = await fetch(`/api/apps/${encodeURIComponent(a.id)}/entries?${q}`);
			this._page = r.ok ? await r.json() : null;
		} catch { this._page = null; }
		defer(this);
	}
	render() {
		const a = this._app;
		if (!a) { this.innerHTML = ""; return; }
		const head = `<h2>${esc(a.label)} <span class="muted">· ${esc(a.alias ?? "–")} · ${esc(a.address)}</span>
<span class="chip ${a.online ? "chip--ok" : "chip--bad"}">${a.online ? "online" : "offline"}</span></h2>`;
		if (!a.online || !a.stats) {
			this.innerHTML = `<div class="panel">${head}<div class="empty">Der Space dieser App ist nicht erreichbar${a.error ? `: ${esc(a.error)}` : ""}.<br>Läuft ihr Space-Prozess? Versucht: ${(a.addresses ?? [a.address]).map((x) => `<code>${esc(x)}</code>`).join(", ")}</div></div>`;
			return;
		}
		const st = a.stats, p = this._page;
		const rows = (p?.entries ?? []).map((x) => `<tr><td title="Entry-ID">${esc(x.id)}</td><td><span class="badge">${esc(x.type)}</span></td>${fieldsCell(x.fields)}</tr>`).join("");
		this.innerHTML = `<div class="panel">${head}
${kpis(st)}
<div class="card trend"><h3>Entries im Verlauf <span class="muted">· ${num(a.history?.length ?? 0)} Messungen</span></h3>${sparkline(a.history, 600, 54, "var(--bar)", "sichtbare Entries je Messung")}</div>
${charts(st, this._type)}
<h3>Entries <span class="muted">(älteste zuerst · Seite ${this._cursors.length})</span>
	${this._type ? `<button class="chip chip--filter" type="button" data-clear>${esc(this._type)} ✕</button>` : ""}</h3>
<div class="toolbar">
	<button class="btn first" ${this._cursors.length === 1 ? "disabled" : ""}>Anfang</button>
	<button class="btn next" ${p?.next == null ? "disabled" : ""}>Weiter</button>
</div>
${table(["ID", "Typ", "Felder"], rows) || `<div class="empty">${p ? "keine Entries" : "lade…"}</div>`}
</div>`;
		this.querySelectorAll(".hbar[data-key]").forEach((b) => { b.onclick = () => { this._type = this._type === b.dataset.key ? null : b.dataset.key; this._cursors = [null]; this.load(); defer(this); }; });
		this.querySelector("[data-clear]")?.addEventListener("click", () => { this._type = null; this._cursors = [null]; this.load(); });
		this.querySelector("button.first").onclick = () => { this._cursors = [null]; this.load(); };
		this.querySelector("button.next").onclick = () => { if (p?.next != null) { this._cursors.push(p.next); this.load(); } };
	}
}
customElements.define("app-detail", AppDetail);

/** Middle panel for a space of the own store: gauges, charts and live tables; refetches when `rev` changes. */
class SpaceDetail extends HTMLElement {
	rev = 0;
	connectedCallback() { this._id = null; this._detail = null; this._entries = null; this._after = 0; this._filter = ""; this.render(); }
	set spaceId(v) { this._id = v; this._after = 0; this._detail = null; this.load(); }
	get spaceId() { return this._id; }
	set rev(v) { if (this._id && v !== this._rev) { this._rev = v; this.load(); } }
	get rev() { return this._rev; }
	async load() {
		if (!this._id) return;
		const id = encodeURIComponent(this._id);
		try {
			const [d, e] = await Promise.all([
				fetch(`/api/spaces/${id}`).then((r) => (r.ok ? r.json() : null)),
				fetch(`/api/spaces/${id}/entries?after=${this._after}&limit=100`).then((r) => (r.ok ? r.json() : null)),
			]);
			this._detail = d; this._entries = e; defer(this);
		} catch { this._detail = null; this._entries = null; defer(this); }
	}
	render() {
		if (!this._id) { this.innerHTML = '<div class="panel"><div class="empty">Space auswählen</div></div>'; return; }
		const d = this._detail;
		if (!d) { this.innerHTML = `<div class="panel"><div class="empty">${this._entries === null ? "lade…" : "Space nicht erreichbar"}</div></div>`; return; }
		const st = d.stats ?? {}, e = this._entries, now = Date.now();
		const txns = table(["ID", "Owner", "Lease", "Reserviert"], (d.txns ?? []).map((t) =>
			`<tr><td>${esc(t.id)}</td><td>${t.owner === null ? "Host" : esc(t.owner)}</td><td>${relTime(t.expires, now)}</td><td>${t.reserved ? `${num(t.reserved)} reserviert` : "–"}</td></tr>`).join(""));
		const waiters = table(["Art", "Vorlage", "Ziel", "Frist"], (d.waiters ?? []).map((w) =>
			`<tr><td>${w.take ? "Take" : "Read"}</td><td class="fields">${esc(JSON.stringify(w.template))}</td><td>${w.target === null ? "Host" : esc(w.target)}</td><td>${relTime(w.deadline, now)}</td></tr>`).join(""));
		const rows = (e?.entries ?? []).filter((x) => !this._filter || x.type.includes(this._filter) || JSON.stringify(x.fields).includes(this._filter))
			.map((x) => `<tr><td title="Entry-ID">${esc(x.id)}</td><td><span class="badge">${esc(x.type)}</span></td>${fieldsCell(x.fields)}<td>${relTime(x.expires, now)}</td></tr>`).join("");
		this.innerHTML = `<div class="panel">
<h2>${esc(d.info.alias)} <span class="muted">· ${esc(d.info.spaceId)} · Inkarnation ${esc(d.info.incarnation)}</span></h2>
${kpis(st)}
${charts(st, this._filter || null)}
<h3>Transaktionen</h3>${txns || '<div class="empty">keine offenen Transaktionen</div>'}
<h3>Wartende Operationen</h3>${waiters || '<div class="empty">keine Waiter</div>'}
<h3>Entries <span class="muted">(neueste zuerst · ${num(e?.total ?? 0)})</span></h3>
<div class="toolbar">
	<input type="search" placeholder="nach Typ oder Feld filtern" value="${esc(this._filter)}">
	<button class="btn newer" ${this._after === 0 ? "disabled" : ""}>Neuere</button>
	<button class="btn older" ${e?.next == null ? "disabled" : ""}>Ältere</button>
</div>
${table(["ID", "Typ", "Felder", "Lease"], rows) || '<div class="empty">keine (passenden) Entries</div>'}
</div>`;
		this.querySelectorAll(".hbar[data-key]").forEach((b) => { b.onclick = () => { this._filter = this._filter === b.dataset.key ? "" : b.dataset.key; this.render(); }; });
		this.querySelector("input").oninput = (ev) => { this._filter = ev.target.value; this.render(); };
		this.querySelector("button.newer").onclick = () => { this._after = Math.max(0, this._after - 100); this.load(); };
		this.querySelector("button.older").onclick = () => { if (this._entries?.next != null) { this._after = this._entries.next; this.load(); } };
	}
}
customElements.define("space-detail", SpaceDetail);

/** Right panel, top: the apps side by side (entries and storage, one bar each). */
class AppsCompare extends HTMLElement {
	set apps(v) { this._apps = v ?? []; defer(this); }
	connectedCallback() { this._apps = []; this.render(); }
	render() {
		const on = (this._apps ?? []).filter((a) => a.online && a.stats);
		if (!(this._apps ?? []).length) { this.innerHTML = ""; return; }
		this.innerHTML = `<div class="panel"><h2>Apps im Vergleich</h2>
${on.length ? `<h3>Entries</h3>${hbars(on.map((a) => ({ label: a.label, value: a.stats.entries })))}
<h3>Speicher</h3>${hbars(on.map((a) => ({ label: a.label, value: a.stats.bytes?.total ?? 0 })), { color: "var(--bar-2)", format: bytes })}`
	: '<div class="empty">keine App erreichbar</div>'}</div>`;
	}
}
customElements.define("apps-compare", AppsCompare);

/** Right panel: process meter with sparklines from the pushed history. */
class LiveMetrics extends HTMLElement {
	set metrics(m) { this._m = m; defer(this); }
	get metrics() { return this._m; }
	set history(h) { this._h = h; defer(this); }
	get history() { return this._h; }
	connectedCallback() { this._m = null; this._h = {}; this.render(); }
	render() {
		const m = this._m;
		if (!m) { this.innerHTML = '<div class="panel"><h2>Metriken</h2><div class="empty">warte auf erste Messung…</div></div>'; return; }
		const up = Math.round((m.uptimeMs ?? 0) / 1000);
		const uptime = up < 90 ? `${up}s` : up < 5400 ? `${Math.floor(up / 60)}m` : `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
		const line = (name, label) => {
			const values = this._h?.[name] ?? [];
			return `<div class="spark"><div class="label">${label} · ${Number((m.rates?.[name] ?? 0)).toFixed(1).replace(".", ",")}/s · gesamt ${num(m.totals?.[name] ?? 0)}</div>${sparkline(values, 272, 30, "var(--bar)", `${label} pro Sekunde`)}</div>`;
		};
		this.innerHTML = `<div class="panel"><h2>Metriken <span class="muted">· dieser Prozess</span></h2>
<div class="kv">
<span>Uptime</span><span>${uptime}</span>
<span>Socket-Verbindungen</span><span>${num(m.connections ?? 0)}</span>
<span>Fehlzugriffe (misses)</span><span>${num(m.totals?.misses ?? 0)}</span>
<span>Zustellungen (events)</span><span>${num(m.totals?.events ?? 0)}</span>
<span>Fehlgeschlagen</span><span>${num(m.totals?.failures ?? 0)}</span>
<span>Wiederholungen</span><span>${num(m.totals?.retries ?? 0)}</span>
</div>
${line("writes", "Writes")}${line("reads", "Reads")}${line("takes", "Takes")}
</div>`;
	}
}
customElements.define("live-metrics", LiveMetrics);

/** A panel that says plainly that this data source does not exist yet (plan decision: no invented data). */
class EmptyPanel extends HTMLElement {
	connectedCallback() { this.render(); }
	render() {
		this.innerHTML = `<div class="panel"><h2>${esc(this.getAttribute("heading") ?? "")}</h2><div class="empty">${esc(this.getAttribute("note") ?? "")}</div></div>`;
	}
}
customElements.define("empty-panel", EmptyPanel);
