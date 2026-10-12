// Tiny SVG charts, no library: a filled sparkline with a thin line and the newest point highlighted.
const NS = 'http://www.w3.org/2000/svg';

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

/** An SVG string: filled area under the rate curve; `color` is a CSS variable name. */
export function sparkline(values, w = 260, h = 34, color = "var(--accent)") {
	const pts = points(values, w, h);
	const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
	const last = pts[pts.length - 1];
	return `<svg class="spark-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
<polygon points="0,${h} ${line} ${w},${h}" fill="${color}" opacity="0.12"></polygon>
<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.5"></polyline>
<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.2" fill="${color}"></circle>
</svg>`;
}
