import { createHash } from "node:crypto";
import type { ArticleSeed } from "./corpus-articles-data.ts";
import { splitTableRow } from "../client/lib/markdown.ts";

export function corpusHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Validate all inputs before writing any generated output. */
export function validateCorpus(seeds: ArticleSeed[], catalog: { areas: Array<{ id: string; articleIds: string[] }> }, facts: Array<{ id: string }>): void {
	const articles = new Map<string, ArticleSeed>();
	for (const seed of seeds) {
		if (articles.has(seed.id)) throw new Error(`Duplicate article ID ${seed.id}`);
		articles.set(seed.id, seed);
	}
	const factIDs = new Set<string>();
	for (const fact of facts) {
		if (factIDs.has(fact.id) || articles.get(fact.id)?.type !== "api") throw new Error(`Duplicate or unknown API fact ${fact.id}`);
		factIDs.add(fact.id);
	}
	for (const seed of seeds) if (seed.type === "api" && !factIDs.has(seed.id)) throw new Error(`Missing API fact ${seed.id}`);
	const areaIDs = new Set<string>();
	for (const area of catalog.areas) {
		if (areaIDs.has(area.id)) throw new Error(`Duplicate area ${area.id}`);
		areaIDs.add(area.id);
		for (const id of area.articleIds) if (!articles.has(id)) throw new Error(`Unknown catalog article ${id}`);
	}
	const anchors = new Map<string, string[]>();
	for (const seed of seeds) for (const locale of ["de", "en"] as const) {
		const body = seed[locale].body, lines = body.split("\n"), ids: string[] = [];
		let fence = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (line.trimStart().startsWith("```")) { fence = !fence; continue; }
			if (fence) continue;
			if (/^#{2,3}\s/.test(line)) {
				const m = /\{#([a-z0-9._-]+)\}\s*$/.exec(line);
				if (!m || ids.includes(m[1]!)) throw new Error(`Missing/duplicate anchor in ${seed.id}/${locale}: ${line}`);
				ids.push(m[1]!);
			}
			if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
				const n = splitTableRow(line).length; i += 2;
				for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
					if (splitTableRow(lines[i]!).length !== n) throw new Error(`Table column mismatch in ${seed.id}/${locale}`);
				}
				i--;
			}
		}
		if (fence) throw new Error(`Unclosed code fence in ${seed.id}/${locale}`);
		anchors.set(`${seed.id}/${locale}`, ids);
	}
	for (const seed of seeds) {
		if (JSON.stringify(anchors.get(`${seed.id}/de`)) !== JSON.stringify(anchors.get(`${seed.id}/en`))) throw new Error(`Anchor parity mismatch in ${seed.id}`);
		for (const id of seed.related) if (!articles.has(id)) throw new Error(`Unknown related article ${id}`);
		for (const locale of ["de", "en"] as const) {
			const prose = seed[locale].body.replace(/```[\s\S]*?```/g, "");
			for (const match of prose.matchAll(/\]\((help\.[^)]+)\)/g)) {
				const [id, anchor] = match[1]!.split("#");
				if (!articles.has(id!) || anchor && !anchors.get(`${id}/${locale}`)?.includes(anchor)) throw new Error(`Broken link ${match[1]} in ${seed.id}/${locale}`);
			}
		}
	}
}
