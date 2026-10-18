// Token- and alias-aware search engine for PHI-SPACES / HELP.
// Short tokens (<= 3 chars, such as "tx", "gid", "rev", "ack", "hrw", "lww", "v1".."v6")
// match only exact word tokens rather than arbitrary substrings, preventing false positives.

export function tokenizeSearch(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		// ß is no combining mark – it survives NFKD and would split words like "schlüssel".
		.replaceAll("ß", "ss")
		.split(/[^a-z0-9_]+/)
		.filter(Boolean);
}

function tokenMatches(candidate: string, queryToken: string): boolean {
	return queryToken.length <= 3
		? candidate === queryToken
		: candidate === queryToken || candidate.startsWith(queryToken);
}

export function matchesAllTokens(haystack: string, queryTokens: string[]): boolean {
	const tokens = tokenizeSearch(haystack);
	return queryTokens.every((qt) => tokens.some((ct) => tokenMatches(ct, qt)));
}

export function scoreArticle(article: any, rawQuery: string): number {
	const qTokens = tokenizeSearch(rawQuery.trim());
	if (!qTokens.length) return 0;
	const combined = `${article.searchText ?? ""} ${article.title} ${article.id} ${(article.tags ?? []).join(" ")} ${article.short}`;
	if (!matchesAllTokens(combined, qTokens)) return -1000;

	return qTokens.reduce((score, qt) => {
		let s = score + 1;
		if (tokenizeSearch(article.title).join(" ") === qt) s += 40;
		else if (matchesAllTokens(article.title, [qt])) s += 22;
		if (matchesAllTokens(article.id, [qt])) s += 18;
		if (matchesAllTokens((article.tags ?? []).join(" "), [qt])) s += 12;
		if (matchesAllTokens(article.short ?? "", [qt])) s += 8;
		return s;
	}, 0);
}

export function searchArticles(articles: any[], rawQuery: string): any[] {
	if (!rawQuery.trim()) return [];
	return articles
		.map((article) => ({ article, score: scoreArticle(article, rawQuery) }))
		.filter((item) => item.score >= 0)
		.sort(
			(a, b) =>
				b.score - a.score ||
				String(a.article.type).localeCompare(String(b.article.type)) ||
				String(a.article.title).localeCompare(String(b.article.title)),
		)
		.slice(0, 64)
		.map((item) => item.article);
}

export function searchAreas(areas: any[], rawQuery: string, locale: "de" | "en"): any[] {
	const qTokens = tokenizeSearch(rawQuery.trim());
	if (!qTokens.length) return [];
	return areas.filter((area) =>
		matchesAllTokens(
			`${area.title?.[locale] ?? ""} ${area.short?.[locale] ?? ""} ${(area.searchAliases?.[locale] ?? []).join(" ")}`,
			qTokens,
		),
	);
}
