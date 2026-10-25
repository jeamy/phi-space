// Copy of codemode-chat/client/lib/markdown.ts (every phi-spaces project keeps its own copy of the small helpers).
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

/** Pipes inside code spans belong to the type, not the table structure. */
export function splitTableRow(line: string): string[] {
	const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	const cells: string[] = []; let cell = "", code = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "\\" && text[i + 1] === "|") { cell += "|"; i++; continue; }
		if (ch === "`") {
			let n = 1; while (text[i + n] === "`") n++;
			code = code === n ? 0 : code === 0 ? n : code;
			cell += "`".repeat(n); i += n - 1; continue;
		}
		if (ch === "|" && code === 0) { cells.push(cell.trim()); cell = ""; }
		else cell += ch;
	}
	cells.push(cell.trim()); return cells;
}

const listItem = (line: string) => /^( *)(?:(\d+)\.\s+|([-*])\s+)(.*)$/.exec(line);

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
		if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cleanHref) && !/^https?:\/\//i.test(cleanHref)) return label;
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
			const parseRow = splitTableRow;

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

		// Preserve starting numbers and nested lists instead of flattening hierarchy.
		const first = listItem(line);
		if (first) {
			const indent = first[1]!.length, ordered = first[2] !== undefined;
			const tag = ordered ? "ol" : "ul", items: string[] = [];
			while (i < lines.length) {
				const item = listItem(lines[i]!);
				if (!item || item[1]!.length !== indent || (item[2] !== undefined) !== ordered) break;
				const width = item[0].length - item[4]!.length;
				i++; const children: string[] = [];
				while (i < lines.length) {
					if (!lines[i]!.trim()) {
						let next = i + 1; while (next < lines.length && !lines[next]!.trim()) next++;
						const following = lines[next];
						if (following && following.search(/\S/) > indent) { children.push(""); i++; continue; }
						if (following && listItem(following)?.[1]!.length === indent) i = next;
						break;
					}
					const leading = lines[i]!.search(/\S/);
					if (leading <= indent) break;
					children.push(lines[i]!.slice(Math.min(width, leading))); i++;
				}
				items.push(`<li>${renderInline(item[4]!)}${children.length ? renderMarkdownToHtml(children.join("\n")) : ""}</li>`);
			}
			const start = ordered && Number(first[2]) !== 1 ? ` start="${Number(first[2])}"` : "";
			out.push(`<${tag}${start}>${items.join("")}</${tag}>`);
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
