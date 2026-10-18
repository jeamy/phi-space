// Validates and builds the canonical bilingual Help corpus for PHI-SPACES / HELP.
// Produces:
//   - help-site/corpus/{de,en}/{topics,workflows,api}/*.md (generated from the canonical TypeScript seeds)
//   - help-site/dist/public/help/index.json (validated index consumed by the React HelpApp)
//   - help-site/dist/public/help/articles/{de,en}/... (localized Markdown snapshots)

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArticleSeed } from "./corpus-articles-data.ts";
import { ALL_ARTICLES } from "./corpus.ts";
import { corpusHash, validateCorpus } from "./corpus-validation.ts";
import { apiSignatures } from "./api-signatures.ts";
import { previousArticlePaths, retireGeneratedArticles } from "./generated-articles.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = join(ROOT, "corpus");
const DIST_PUBLIC = join(ROOT, "dist", "public");
const NEXT_PUBLIC = join(ROOT, "public");

export interface TocItem {
	level: 2 | 3;
	title: string;
	anchor: string;
}

export interface ApiMeta {
	symbol: string;
	provider: string;
	family: string;
	category: string;
	execution: string;
	idempotency: string;
	scope: string;
	role: string;
	signature: string;
}

export interface IndexedArticle {
	id: string;
	locale: "de" | "en";
	type: "topic" | "workflow" | "api";
	provider: string;
	standard: string;
	title: string;
	short: string;
	tags: string[];
	related: string[];
	since: string;
	path: string;
	wordCount: number;
	toc: TocItem[];
	searchText: string;
	api?: ApiMeta;
	resources: Array<{
		id: string;
		title: string;
		summary: string;
		stage: string;
		entryTypes: number;
		profiles: number;
		command: string;
	}>;
	source: {
		repository: string;
		commit: string;
		dirty: boolean;
	};
}

function slugOf(id: string): string {
	return id.replace(/^help\.(topic|workflow|api)\./, "");
}

function folderOf(type: "topic" | "workflow" | "api"): string {
	return type === "topic" ? "topics" : type === "workflow" ? "workflows" : "api";
}

function renderMarkdownWithFrontmatter(seed: ArticleSeed, locale: "de" | "en"): string {
	const loc = seed[locale];
	const standard = seed.type === "api" ? "help_api" : seed.type === "workflow" ? "help_workflow" : "help_topic";
	return [
		"---",
		`standard: ${standard}`,
		`id: ${seed.id}`,
		`title: ${JSON.stringify(loc.title)}`,
		`short: ${JSON.stringify(loc.short)}`,
		`tags: [${seed.tags.join(", ")}]`,
		`owner: ${seed.provider}`,
		`related: [${seed.related.join(", ")}]`,
		`since: ${seed.since}`,
		"---",
		"",
		`# ${loc.title}`,
		"",
		loc.body.trim(),
		"",
	].join("\n");
}

export function extractTocAndValidateAnchors(markdown: string, articleId: string, locale: string): { toc: TocItem[]; cleanBody: string } {
	const lines = markdown.split("\n");
	const toc: TocItem[] = [];
	const seen = new Set<string>();
	let inFence = false;
	const cleaned: string[] = [];

	for (const line of lines) {
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			cleaned.push(line);
			continue;
		}
		if (!inFence) {
			const m = /^(#{2,3})\s+(.+?)\s+\{#([a-z0-9._-]+)\}\s*$/.exec(line);
			if (m) {
				const level = m[1]!.length as 2 | 3;
				const title = m[2]!.trim();
				const anchor = m[3]!.trim();
				if (seen.has(anchor)) {
					throw new Error(`Duplicate anchor {#${anchor}} in ${articleId} (${locale})`);
				}
				seen.add(anchor);
				toc.push({ level, title, anchor });
				cleaned.push(`${m[1]} ${title} {#${anchor}}`);
				continue;
			}
		}
		cleaned.push(line);
	}
	return { toc, cleanBody: cleaned.join("\n") };
}

function stripFrontmatter(md: string): string {
	if (!md.startsWith("---\n")) return md;
	const end = md.indexOf("\n---\n", 4);
	return end === -1 ? md : md.slice(end + 5).trimStart();
}

function countWords(text: string): number {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[#*`|>\-\[\]()]/g, " ")
		.split(/\s+/)
		.filter(Boolean).length;
}

export async function buildCorpus(): Promise<{
	uniqueArticles: number;
	localizedRecords: number;
	indexPath: string;
}> {
	const catalogRaw = await readFile(join(CORPUS_DIR, "help_product_catalog.json"), "utf8");
	const catalog = JSON.parse(catalogRaw);
	const apiFactsRaw = await readFile(join(CORPUS_DIR, "api_facts.json"), "utf8");
	const signatures = apiSignatures();
	const apiFacts = (JSON.parse(apiFactsRaw) as Array<any>).map(fact => {
		const signature = signatures.get(fact.id);
		if (!signature) throw new Error(`No compiler-derived signature for ${fact.id}`);
		return { ...fact, signature };
	});
	const apiMap = new Map<string, any>(apiFacts.map((a) => [a.id, a]));

	const allSeeds = ALL_ARTICLES;
	validateCorpus(allSeeds, catalog, apiFacts);
	const publicRoots = [DIST_PUBLIC, NEXT_PUBLIC];
	const previous = await Promise.all(publicRoots.map(previousArticlePaths));
	let commit = "unversioned", dirty = true;
	try {
		commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		dirty = !!execFileSync("git", ["status", "--porcelain", "--untracked-files=normal", "--", "scripts", "examples", "client", "corpus/api_facts.json", "corpus/help_product_catalog.json", "../src"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch { /* Archive/container builds may have no .git: report that honestly. */ }
	const allIds = new Set(allSeeds.map((s) => s.id));

	// Validate catalog article references
	for (const area of catalog.areas) {
		for (const id of area.articleIds) {
			if (!allIds.has(id)) {
				throw new Error(`Catalog area ${area.id} references unknown article ID ${id}`);
			}
		}
	}

	const articles: IndexedArticle[] = [];
	let totalAnchors = 0;
	let totalLinks = 0;

	for (const seed of allSeeds) {
		for (const rel of seed.related) {
			if (!allIds.has(rel)) {
				throw new Error(`Article ${seed.id} references unknown related ID ${rel}`);
			}
			totalLinks += 1;
		}

		const tocByLocale: Record<"de" | "en", TocItem[]> = { de: [], en: [] };

		for (const locale of ["de", "en"] as const) {
			const folder = folderOf(seed.type);
			const slug = slugOf(seed.id);
			const fullMd = renderMarkdownWithFrontmatter(seed, locale);
			const sourcePath = join(CORPUS_DIR, locale, folder, `${slug}.md`);
			await mkdir(dirname(sourcePath), { recursive: true });
			await writeFile(sourcePath, fullMd, "utf8");

			const bodyOnly = stripFrontmatter(fullMd);
			const { toc } = extractTocAndValidateAnchors(bodyOnly, seed.id, locale);
			tocByLocale[locale] = toc;
			totalAnchors += toc.length;

			const webRelPath = `/help/articles/${locale}/${folder}/${slug}.md`;
			for (const pubRoot of [DIST_PUBLIC, NEXT_PUBLIC]) {
				const distArticlePath = join(pubRoot, "help", "articles", locale, folder, `${slug}.md`);
				await mkdir(dirname(distArticlePath), { recursive: true });
				await writeFile(distArticlePath, bodyOnly, "utf8");
			}

			const apiFact = apiMap.get(seed.id);
			const apiMeta: ApiMeta | undefined = apiFact
				? {
						symbol: apiFact.symbol,
						provider: apiFact.provider,
						family: apiFact.family,
						category: apiFact.category,
						execution: apiFact.execution,
						idempotency: apiFact.idempotency,
						scope: apiFact.scope,
						role: apiFact.role,
						signature: apiFact.signature,
					}
				: undefined;

			const plainSearch = bodyOnly
				.replace(/\{#[a-z0-9._-]+\}/g, " ")
				.replace(/[`#*|>]/g, " ")
				.replace(/\s+/g, " ")
				.trim();

			articles.push({
				id: seed.id,
				locale,
				type: seed.type,
				provider: seed.provider,
				standard: seed.type === "api" ? "help_api" : seed.type === "workflow" ? "help_workflow" : "help_topic",
				title: seed[locale].title,
				short: seed[locale].short,
				tags: seed.tags,
				related: seed.related,
				since: seed.since,
				path: webRelPath,
				wordCount: countWords(bodyOnly),
				toc,
				searchText: `${seed[locale].title} ${seed[locale].short} ${seed.tags.join(" ")} ${apiMeta?.symbol ?? ""} ${apiMeta?.signature ?? ""} ${plainSearch}`,
				...(apiMeta ? { api: apiMeta } : {}),
				resources: (seed.resources ?? []).map((r) => ({
					id: r.id,
					title: r.title[locale],
					summary: r.summary[locale],
					stage: r.stage,
					entryTypes: r.entryTypes,
					profiles: r.profiles,
					command: r.command,
				})),
				source: {
					repository: "phi-spaces",
					commit,
					dirty,
				},
			});
		}

		// Verify strict DE/EN anchor parity (Help Topic Standard)
		const deAnchors = tocByLocale.de.map((t) => `${t.level}:${t.anchor}`).join("|");
		const enAnchors = tocByLocale.en.map((t) => `${t.level}:${t.anchor}`).join("|");
		if (deAnchors !== enAnchors) {
			throw new Error(`Anchor parity mismatch between DE and EN in ${seed.id}: DE=[${deAnchors}] vs EN=[${enAnchors}]`);
		}
	}

	const hash = corpusHash({ articles: allSeeds, catalog, apiFacts });

	const siteIndex = {
		schema: "phi-spaces-help-site-index-v1",
		corpus: {
			schema: "phi-spaces-help-web-corpus-v1",
			theme: "PHI_SPACES_HIGHEND_PRODUCT_REFERENCE",
			domain: "https://spaces.eibrain.org",
			status: "canonical-main-snapshot",
			frozenOn: catalog.reviewed,
			builtAt: new Date().toISOString(),
			hash,
		},
		locales: ["de", "en"],
		stats: {
			uniqueArticles: allSeeds.length,
			apiArticles: allSeeds.filter((s) => s.type === "api").length,
			topicArticles: allSeeds.filter((s) => s.type === "topic").length,
			workflowArticles: allSeeds.filter((s) => s.type === "workflow").length,
			localizedRecords: articles.length,
			stageExamples: 6,
			validatedLinks: totalLinks,
			renderedAnchors: totalAnchors,
		},
		areas: catalog.areas,
		modulePackages: catalog.modulePackages,
		articles,
	};

	const indexPath = join(DIST_PUBLIC, "help", "index.json");
	const current = new Set(articles.map(article => article.path));
	for (let i = 0; i < publicRoots.length; i++) await retireGeneratedArticles(publicRoots[i]!, previous[i]!, current);
	for (const pubRoot of [DIST_PUBLIC, NEXT_PUBLIC]) {
		const p = join(pubRoot, "help", "index.json");
		await mkdir(dirname(p), { recursive: true });
		await writeFile(p, JSON.stringify(siteIndex, null, 2) + "\n", "utf8");
	}

	return {
		uniqueArticles: allSeeds.length,
		localizedRecords: articles.length,
		indexPath,
	};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const res = await buildCorpus();
	console.log(`Built PHI-SPACES / HELP corpus: ${res.uniqueArticles} unique articles (${res.localizedRecords} localized records) -> ${res.indexPath}`);
}
