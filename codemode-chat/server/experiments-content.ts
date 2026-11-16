// The repository documents remain the source of truth. Only these authored files and their figures are public.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { renderMarkdownToHtml } from "../client/lib/markdown.ts";
import type { Publication, PublicationBody, PublicationId } from "../client/experiments/types.ts";

const docs = [resolve(process.cwd(), "docs"), resolve(process.cwd(), "../docs")].find((path) => existsSync(join(path, "codemode-planning-summary.en.md")));
if (!docs) throw new Error("Experiment documents are missing from this checkout or image");
export const EXPERIMENT_DOCS = docs;
const files = {
	planning: { en: "codemode-planning-summary.en.md" },
	jev: { en: "codemode-jev-player.en.md" },
	article: { en: "codemode-planning-article.en.md", de: "de-docs/codemode-planning-article.md" },
	plan: { en: "codemode-planung.en.md" },
} as const;
const extraMedia = ["experiment-design.svg", "planning-approaches.svg", "jev-workflow.svg"];
const media = new Set(extraMedia);
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function experimentSource(id: string, lang = "en"): { name: string; markdown: string } | null {
	if (!Object.hasOwn(files, id)) return null;
	const choices = files[id as keyof typeof files] as { en: string; de?: string };
	const name = lang === "de" && choices.de ? choices.de : choices.en;
	return { name: basename(name), markdown: readFileSync(join(EXPERIMENT_DOCS, name), "utf8") };
}

function localLink(target: string): string | null {
	if (/^https?:\/\//.test(target) || target.startsWith("#")) return target;
	const name = target.replace(/^\.\.\//, "");
	for (const [id, choices] of Object.entries(files)) {
		if (Object.values(choices).some((path) => path === name)) return id === "plan" ? "/experiments/source/plan" : `/experiments/${id}${id === "article" ? `?lang=${name.startsWith("de-docs/") ? "de" : "en"}` : ""}`;
	}
	return null;
}

/** Reuse the shared renderer, adding publication figures and navigable headings without changing the help copies. */
export function renderExperimentDocument(markdown: string): PublicationBody {
	const lines = markdown.split("\n");
	const title = lines.find((line) => line.startsWith("# "))?.slice(2) ?? "Experiments";
	const toc: PublicationBody["toc"] = [], figures: string[] = [];
	const body: string[] = [];
	let fence = false;
	for (let index = 0; index < lines.length; index++) {
		let line = lines[index]!;
		if (line.startsWith("```")) fence = !fence;
		if (fence || line.startsWith("```")) { body.push(line); continue; }
		if (line.startsWith("# ")) continue;
		const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line.trim());
		if (image) {
			const name = basename(image[2]!);
			if (!/^[a-zA-Z0-9.-]+\.(svg|jpg|png)$/.test(name) || !existsSync(join(EXPERIMENT_DOCS, "img/codemode-planung", name))) throw new Error(`Unknown experiment figure ${name}`);
			media.add(name);
			let caption = "";
			if (!lines[index + 1]?.trim() && /^\*(?:Figure|Abbildung)(?:\s|\.)/.test(lines[index + 2] ?? "")) {
				index += 2;
				while (index < lines.length && lines[index]!.trim()) { caption += lines[index] + "\n"; index++; }
			}
			const captionHtml = caption ? renderMarkdownToHtml(caption) : escape(image[1]!);
			const href = `/experiments/media/${name}`;
			const enlarge = title.startsWith("Planungsbots") ? "Abbildung in voller Größe öffnen" : "Open full-size figure";
			figures.push(`<figure><a href="${href}"><img src="${href}" alt="${escape(image[1]!)}" loading="lazy" decoding="async"/></a><figcaption>${captionHtml}<p><a href="${href}">${enlarge} ↗</a></p></figcaption></figure>`);
			body.push("", `EXPERIMENTFIGURE${figures.length - 1}`, "");
			continue;
		}
		line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, target: string) => {
			const href = localLink(target);
			return href ? `[${label}](${href})` : `\`${label.replace(/`/g, "")}\``;
		});
		const heading = /^(#{2,3})\s+(.+)$/.exec(line);
		if (heading) {
			const id = `section-${toc.length + 1}`;
			toc.push({ id, title: heading[2]!.replace(/[*`]/g, ""), level: heading[1]!.length });
			line += ` {#${id}}`;
		}
		body.push(line);
	}
	let html = renderMarkdownToHtml(body.join("\n"));
	for (const [index, figure] of figures.entries()) html = html.replace(`<p>EXPERIMENTFIGURE${index}</p>`, figure);
	return { title, html, toc };
}

export function experimentPublication(id: string): Publication | null {
	if (id !== "planning" && id !== "jev" && id !== "article") return null;
	const en = experimentSource(id)!;
	const de = id === "article" ? experimentSource(id, "de") : null;
	return { id: id as PublicationId, bodies: { en: renderExperimentDocument(en.markdown), ...(de ? { de: renderExperimentDocument(de.markdown) } : {}) } };
}

// Build the image allowlist from all published documents before answering a media request.
for (const id of ["planning", "jev", "article"]) experimentPublication(id);
export const EXPERIMENT_MEDIA = [...media];
