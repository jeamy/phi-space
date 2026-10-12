// Web Components without framework or build step (decision for the dashboard plan: zero dependencies).
// Light DOM on purpose: one global stylesheet carries the mockup palette; components receive data via
// properties and re-render scheduled on one animation frame.
import { sparkline } from "./charts.js";

const ESC = { "&": "&#38;", "<": "&#60;", ">": "&#62;", '"': "&#34;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const num = (n) => (typeof n === "number" ? (n >= 1e4 ? n.toLocaleString("de-DE") : String(n)) : "–");
const FOREVER = 9007199254740991; // core.FOREVER = Number.MAX_SAFE_INTEGER
const relTime = (ms, now) => {
	if (!Number.isFinite(ms) || ms >= FOREVER) return "für immer";
	const d = ms - now;
	if (d <= 0) return "abgelaufen";
	const s = Math.round(d / 1000);
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};
const defer = (el) => { if (!el._pending) { el._pending = true; requestAnimationFrame(() => { el._pending = false; el.render(); }); } };
const table = (head, rows) => (rows ? `<table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows}</table>` : "");

/** Left panel: one row per space; a click selects it. */
class SpacesPanel extends HTMLElement {
	selected = null;
	set spaces(v) { this._spaces = v ?? []; defer(this); }
	get spaces() { return this._spaces; }
	connectedCallback() { this._spaces = []; this.render(); }
	render() {
		const items = (this._spaces ?? []).map((s) => `
<li class="space-item${s.spaceId === this.selected ? " selected" : ""}" data-id="${esc(s.spaceId)}" role="button" tabindex="0">
	<i class="stripe${(s.stats?.txns ?? 0) > 0 || (s.stats?.waiters ?? 0) > 0 ? " idle" : ""}" title="${(s.stats?.txns ?? 0) > 0 || (s.stats?.waiters ?? 0) > 0 ? "offene Transaktionen oder Waiter" : "ruhig"}"></i>
	<div><div class="name">${esc(s.alias)}</div>
	<div class="meta">${num(s.stats?.entries)} Entries · ${num(s.stats?.txns)} Txn · ${num(s.stats?.waiters)} wartend</div></div>
</li>`).join("");
		this.innerHTML = `<div class="panel"><h2>Spaces</h2><ul style="list-style:none;margin:0;padding:0">${items || '<div class="empty">noch keine Spaces</div>'}</ul></div>`;
		this.querySelectorAll(".space-item").forEach((li) => {
			li.onclick = () => this.dispatchEvent(new CustomEvent("select", { bubbles: true, detail: li.dataset.id }));
			li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") li.click(); };
		});
	}
}
customElements.define("spaces-panel", SpacesPanel);

/** Middle panel: gauges and live tables of one space; owns its fetches, refetches when `rev` changes. */
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
		const chips = [["Entries", st.entries], ["Txn", st.txns], ["Wartend", st.waiters], ["Outbox", st.outbox], ["Gesperrt", st.locked], ["Uncommitted", st.uncommitted], ["Abgelaufen", st.expired]]
			.map(([k, v]) => `<span class="chip">${k} <b>${num(v)}</b></span>`).join("");
		const txns = table(["ID", "Owner", "Lease", "Reserviert"], (d.txns ?? []).map((t) =>
			`<tr><td>${esc(t.id)}</td><td>${t.owner === null ? "Host" : esc(t.owner)}</td><td>${relTime(t.expires, now)}</td><td>${t.reserved ? `${num(t.reserved)} reserviert` : "–"}</td></tr>`).join(""));
		const waiters = table(["Art", "Vorlage", "Ziel", "Frist"], (d.waiters ?? []).map((w) =>
			`<tr><td>${w.take ? "Take" : "Read"}</td><td class="fields">${esc(JSON.stringify(w.template))}</td><td>${w.target === null ? "Host" : esc(w.target)}</td><td>${relTime(w.deadline, now)}</td></tr>`).join(""));
		const rows = (e?.entries ?? []).filter((x) => !this._filter || x.type.includes(this._filter) || JSON.stringify(x.fields).includes(this._filter))
			.map((x) => `<tr><td title="Entry-ID">${esc(x.id)}</td><td><span class="badge">${esc(x.type)}</span></td><td class="fields">${esc(JSON.stringify(x.fields))}</td><td>${relTime(x.expires, now)}</td></tr>`).join("");
		this.innerHTML = `<div class="panel">
<h2>${esc(d.info.alias)} <span class="muted">· ${esc(d.info.spaceId)} · Inkarnation ${esc(d.info.incarnation)}</span></h2>
<div class="chips">${chips}</div>
<h3>Transaktionen</h3>${txns || '<div class="empty">keine offenen Transaktionen</div>'}
<h3>Wartende Operationen</h3>${waiters || '<div class="empty">keine Waiter</div>'}
<h3>Entries <span class="muted">(neueste zuerst · ${num(e?.total ?? 0)})</span></h3>
<div class="toolbar">
	<input type="search" placeholder="nach Typ oder Feld filtern" value="${esc(this._filter)}">
	<button class="newer" ${this._after === 0 ? "disabled" : ""}> Neuere </button>
	<button class="older" ${e?.next == null ? "disabled" : ""}> Ältere </button>
</div>
${table(["ID", "Typ", "Felder", "Lease"], rows) || '<div class="empty">keine (passenden) Entries</div>'}
</div>`;
		this.querySelector("input").oninput = (ev) => { this._filter = ev.target.value; this.render(); };
		this.querySelector("button.newer").onclick = () => { this._after = Math.max(0, this._after - 100); this.load(); };
		this.querySelector("button.older").onclick = () => { if (this._entries?.next != null) { this._after = this._entries.next; this.load(); } };
	}
}
customElements.define("space-detail", SpaceDetail);

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
		const line = (name, color) => {
			const values = this._h?.[name] ?? [];
			return `<div class="spark"><div class="label">${name} · ${Number((m.rates?.[name] ?? 0)).toFixed(1)}/s · total ${num(m.totals?.[name] ?? 0)}</div>${sparkline(values, 272, 30, color)}</div>`;
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
${line("writes", "var(--success)")}${line("reads", "var(--accent)")}${line("takes", "var(--warning)")}
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
