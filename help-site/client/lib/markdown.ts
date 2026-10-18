// Clean, presentation-neutral GFM Markdown renderer with explicit {#anchor} support.
// Strips `{#anchor}` from visible H2/H3 text, sets `id="anchor"` on the heading element,
// marks key-column tables with `data-help-column="key"`, and intercepts `help.*` links.

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function renderInline(raw: string): string {
	const codeSpans: string[] = [];
	const withPlaceholders = raw.replace(/`([^`]+)`/g, (_m, code) => {
		const idx = codeSpans.length;
		codeSpans.push(`<code>${escapeHtml(code)}</code>`);
		return `\u0000CODE${idx}\u0000`;
	});

	let html = escapeHtml(withPlaceholders);
	// Links: [label](target)
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
		const cleanHref = href.trim();
		if (cleanHref.startsWith("help.")) {
			return `<a href="#${cleanHref}" data-help-link="${cleanHref}">${label}</a>`;
		}
		// In-page anchors and root-relative links stay in this tab.
		if (cleanHref.startsWith("#") || cleanHref.startsWith("/")) {
			return `<a href="${cleanHref}">${label}</a>`;
		}
		return `<a href="${cleanHref}" target="_blank" rel="noreferrer">${label}</a>`;
	});
	// Bold & Italic
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

	// Restore inline code spans
	html = html.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeSpans[Number(idx)] ?? "");
	return html;
}

export function renderMarkdownToHtml(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;

		if (!line.trim()) {
			i++;
			continue;
		}

		// Fenced code block
		if (line.trimStart().startsWith("```")) {
			const lang = line.trimStart().slice(3).trim() || "text";
			i++;
			const codeLines: string[] = [];
			while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
				codeLines.push(lines[i]!);
				i++;
			}
			if (i < lines.length) i++;
			out.push(
				`<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`,
			);
			continue;
		}

		// Headings (H1, H2, H3) with optional {#anchor}
		const headingMatch = /^\s*(#{1,6})\s+(.+?)(?:\s+\{#([a-z0-9._-]+)\})?\s*$/.exec(line);
		if (headingMatch) {
			const level = headingMatch[1]!.length;
			const titleHtml = renderInline(headingMatch[2]!.trim());
			const anchor = headingMatch[3]?.trim();
			const idAttr = anchor ? ` id="${escapeHtml(anchor)}"` : "";
			out.push(`<h${level}${idAttr}>${titleHtml}</h${level}>`);
			i++;
			continue;
		}

		// GFM Table
		if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
			const parseRow = (rowLine: string) =>
				rowLine
					.trim()
					.replace(/^\|/, "")
					.replace(/\|$/, "")
					.split(/(?<!\\)\|/)
					.map((c) => c.replace(/\\\|/g, "|").trim());

			const headers = parseRow(line);
			i += 2; // skip header and separator
			const rows: string[][] = [];
			while (i < lines.length && lines[i]!.trim().startsWith("|")) {
				rows.push(parseRow(lines[i]!));
				i++;
			}
			const firstHeaderLower = (headers[0] ?? "").toLowerCase();
			const isKeyCol =
				firstHeaderLower === "key" ||
				firstHeaderLower === "keys" ||
				firstHeaderLower === "tool" ||
				firstHeaderLower === "limit" ||
				firstHeaderLower === "ebene" ||
				firstHeaderLower === "layer" ||
				firstHeaderLower === "version";

			const thHtml = headers
				.map(
					(h, idx) =>
						`<th${idx === 0 && isKeyCol ? ' data-help-column="key"' : ""}>${renderInline(h)}</th>`,
				)
				.join("");
			const tbodyHtml = rows
				.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
				.join("");
			out.push(`<table><thead><tr>${thHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table>`);
			continue;
		}

		// Unordered list
		if (/^\s*[-*]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
				items.push(`<li>${renderInline(lines[i]!.replace(/^\s*[-*]\s+/, "").trim())}</li>`);
				i++;
			}
			out.push(`<ul>${items.join("")}</ul>`);
			continue;
		}

		// Ordered list
		if (/^\s*\d+\.\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
				items.push(`<li>${renderInline(lines[i]!.replace(/^\s*\d+\.\s+/, "").trim())}</li>`);
				i++;
			}
			out.push(`<ol>${items.join("")}</ol>`);
			continue;
		}

		// Blockquote
		if (line.trimStart().startsWith(">")) {
			const qLines: string[] = [];
			while (i < lines.length && lines[i]!.trimStart().startsWith(">")) {
				qLines.push(lines[i]!.replace(/^\s*>\s?/, ""));
				i++;
			}
			out.push(`<blockquote><p>${renderInline(qLines.join(" "))}</p></blockquote>`);
			continue;
		}

		// Paragraph (Presentation-neutral soft line breaks!)
		const paraLines: string[] = [];
		while (
			i < lines.length &&
			lines[i]!.trim() !== "" &&
			!lines[i]!.trimStart().startsWith("```") &&
			!lines[i]!.trimStart().startsWith("#") &&
			!lines[i]!.trim().startsWith("|") &&
			!/^\s*[-*]\s+/.test(lines[i]!) &&
			!/^\s*\d+\.\s+/.test(lines[i]!) &&
			!lines[i]!.trimStart().startsWith(">")
		) {
			paraLines.push(lines[i]!.trim());
			i++;
		}
		// Unknown block-looking lines must still consume input.
		if (!paraLines.length) paraLines.push(lines[i++]!.trim());
		out.push(`<p>${renderInline(paraLines.join(" "))}</p>`);
	}

	return out.join("\n");
}
