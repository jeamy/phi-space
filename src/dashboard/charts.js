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
