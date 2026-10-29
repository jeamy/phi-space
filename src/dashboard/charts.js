// Small charts without a library. Colors are CSS variables of the palette, so mode and palette changes need no redraw.
// Bars are HTML (their widths animate on update); the sparkline is SVG. Every mark carries a title as its hover text.
const ESC = { "&": "&#38;", "<": "&#60;", ">": "&#62;", '"': "&#34;" };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
export const num = (n) => (typeof n === "number" ? n.toLocaleString("de-DE") : "–");
export const bytes = (n) => {
	if (typeof n !== "number") return "–";
	if (n < 1024) return `${n} B`;
	const units = ["KiB", "MiB", "GiB"];
	let v = n / 1024, i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v.toFixed(v < 10 ? 1 : 0).replace(".", ",")} ${units[i]}`;
};

/** Map values into the box; empty values fall back to a flat line. */
function points(values, w, h, pad = 3) {
	if (!values || values.length === 0) return [{ x: 0, y: h / 2 }, { x: w, y: h / 2 }];
	const max = Math.max(...values, 0.000001);
	const min = Math.min(...values, 0);
	const span = max - min || 1;
	return values.map((v, i) => ({
		x: (values.length === 1 ? 0.5 : i / (values.length - 1)) * w,
		y: pad + (1 - (v - min) / span) * (h - 2 * pad),
	}));
}

/** An SVG string: filled area under the curve, a 2px line and the newest point; it stretches to its box. */
export function sparkline(values, w = 260, h = 34, color = "var(--accent)", title = "") {
	const pts = points(values, w, h);
	const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
	const last = pts[pts.length - 1];
	return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"${title ? ` aria-label="${esc(title)}"` : ""}>${title ? `<title>${esc(title)}</title>` : ""}
<polygon points="0,${h} ${line} ${w},${h}" fill="${color}" opacity="0.16"></polygon>
<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>
<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.6" fill="${color}"></circle>
</svg>`;
}

/** Horizontal bars, one row per item ({ key, label, value, hint? }), sorted by the caller; one hue, the length is the value.
 *  Rows with `key` are buttons (data-key) so the caller can filter by them; `active` marks the chosen one. */
export function hbars(rows, { color = "var(--bar)", format = num, active = null, clickable = false } = {}) {
	if (!rows.length) return "";
	const max = Math.max(...rows.map((r) => r.value), 1);
	return `<div class="hbars">${rows.map((r) => {
		const pct = r.value > 0 ? Math.max(1.5, (r.value / max) * 100) : 0;
		const tag = clickable && r.key != null ? "button" : "div";
		return `<${tag} class="hbar${r.key != null && r.key === active ? " is-active" : ""}"${tag === "button" ? ` type="button" data-key="${esc(r.key)}"` : ""} title="${esc(r.hint ?? `${r.label}: ${format(r.value)}`)}">
<span class="hbar__label">${esc(r.label)}</span>
<span class="hbar__track"><i style="width:${pct.toFixed(2)}%;background:${color}"></i></span>
<span class="hbar__value">${format(r.value)}</span>
</${tag}>`;
	}).join("")}</div>`;
}

/** One stacked bar of parts ({ label, value, color }) with a legend that names every part (identity never by color alone). */
export function stackbar(parts, { format = num } = {}) {
	const total = parts.reduce((s, p) => s + p.value, 0);
	const segs = parts.filter((p) => p.value > 0).map((p) =>
		`<i style="flex-grow:${p.value};background:${p.color}" title="${esc(`${p.label}: ${format(p.value)} (${((p.value / (total || 1)) * 100).toFixed(1).replace(".", ",")} %)`)}"></i>`).join("");
	const legend = parts.map((p) => `<span class="legend__item"><i style="background:${p.color}"></i>${esc(p.label)} <b>${format(p.value)}</b></span>`).join("");
	return `<div class="stackbar">${segs || '<i class="stackbar__empty"></i>'}</div><div class="legend">${legend}</div>`;
}

/** How long ago, short: "42 s", "12 min", "3 h", "2 d". */
export const ago = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 120) return `${s} s`;
	if (s < 7200) return `${Math.round(s / 60)} min`;
	if (s < 2 * 86400) return `${Math.round(s / 3600)} h`;
	return `${(s / 86400).toFixed(1).replace(".", ",")} d`;
};
// steps of the time axis, in minutes: the first that leaves at most about `w / 90` labels
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880];
const tickLabel = (m) => (m === 0 ? "jetzt" : m < 60 ? `−${m} min` : m < 1440 ? `−${m / 60} h` : `−${m / 1440} d`);

/** A line chart over time with axes: `points` ({ at, ...values }), `series` ([{ key, label, color }]), `fmt` for the
 *  value axis and the hover text. Times read as minutes, hours or days before now; a missing value leaves a gap. */
export function timeChart(points, series, { fmt = num, w = 520, h = 170, now = Date.now() } = {}) {
	const pts = points ?? [];
	const vals = pts.flatMap((p) => series.map((s) => p[s.key])).filter((v) => typeof v === "number");
	if (pts.length < 2 || vals.length === 0) return "";
	const max = Math.max(...vals, 0) * 1.1 || 1;
	const left = 8 + Math.max(...[0, max / 2, max].map((v) => String(fmt(v)).length)) * 6.2, right = 8, top = 8, bottom = 20;
	const t0 = pts[0].at, t1 = Math.max(pts[pts.length - 1].at, t0 + 1);
	const x = (t) => left + ((t - t0) / (t1 - t0)) * (w - left - right), y = (v) => top + (1 - v / max) * (h - top - bottom);
	const grid = [0, max / 2, max].map((v) => `<line x1="${left}" x2="${w - right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)"></line><text x="${left - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`).join("");
	const span = (now - t0) / 60000, step = TICK_STEPS.find((m) => span / m <= Math.max(3, w / 90)) ?? TICK_STEPS.at(-1);
	let ticks = "";
	for (let m = 0; m <= span; m += step) { const t = now - m * 60000; if (t < t0) break; ticks += `<text x="${x(t).toFixed(1)}" y="${h - 5}" text-anchor="middle">${tickLabel(m)}</text>`; }
	const lines = series.map((s) => {
		let d = "", open = false;
		for (const p of pts) { const v = p[s.key]; if (typeof v !== "number") { open = false; continue; } d += `${open ? "L" : "M"}${x(p.at).toFixed(1)},${y(v).toFixed(1)}`; open = true; }
		return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>`;
	}).join("");
	// hover: one invisible column per point with the values at that time
	const cols = pts.map((p, i) => {
		const x0 = i === 0 ? left : (x(pts[i - 1].at) + x(p.at)) / 2, x1 = i === pts.length - 1 ? w - right : (x(p.at) + x(pts[i + 1].at)) / 2;
		const text = `vor ${ago(now - p.at)} · ${series.map((s) => `${s.label}: ${typeof p[s.key] === "number" ? fmt(p[s.key]) : "–"}`).join(" · ")}`;
		return `<rect x="${x0.toFixed(1)}" y="${top}" width="${Math.max(0.5, x1 - x0).toFixed(1)}" height="${h - top - bottom}" fill="transparent"><title>${esc(text)}</title></rect>`;
	}).join("");
	return `<svg class="time-svg" viewBox="0 0 ${w} ${h}" role="img">${grid}${ticks}${lines}${cols}</svg>`;
}
