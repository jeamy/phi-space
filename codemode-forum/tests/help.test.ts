// The help articles: both languages, links and anchors resolve, the markdown is escaped.
import test from "node:test";
import assert from "node:assert/strict";
import { ARTICLES, DEFAULT_ARTICLE, SECTIONS, articleById, tocOf } from "../client/help/articles.ts";
import { renderMarkdownToHtml } from "../client/lib/markdown.ts";

const langs = ["de", "en"] as const;
const anchorsOf = (md: string) => new Set([...md.matchAll(/\{#([a-z0-9._-]+)\}/g)].map((m) => m[1]!));

test("every article has both languages, a section and a unique id", () => {
	assert.ok(articleById(DEFAULT_ARTICLE));
	assert.equal(new Set(ARTICLES.map((a) => a.id)).size, ARTICLES.length);
	for (const a of ARTICLES) {
		assert.ok(a.id.startsWith("help.topic."), a.id);
		assert.ok(SECTIONS[a.section], a.id);
		for (const l of langs) {
			assert.ok(a.title[l].trim() && a.short[l].trim() && a.body[l].trim(), `${a.id} ${l}`);
			assert.ok(a.body[l].includes("{#overview}"), `${a.id} ${l}: overview anchor`);
		}
		// both languages share the same anchors, so a link works in either
		assert.deepEqual([...anchorsOf(a.body.de)].sort(), [...anchorsOf(a.body.en)].sort(), `${a.id}: anchors differ between languages`);
	}
});

test("every help.* link points to an existing article and anchor", () => {
	for (const a of ARTICLES) for (const l of langs) {
		for (const m of a.body[l].matchAll(/\]\((help\.[a-z0-9._]+)(?:#([a-z0-9._-]+))?\)/g)) {
			const target = articleById(m[1]!);
			assert.ok(target, `${a.id} ${l}: unknown article ${m[1]}`);
			if (m[2]) assert.ok(anchorsOf(target!.body[l]).has(m[2]), `${a.id} ${l}: unknown anchor ${m[1]}#${m[2]}`);
		}
	}
});

test("the table of contents lists the H2 headings and every article is reachable from the overview", () => {
	for (const a of ARTICLES) for (const l of langs) assert.ok(tocOf(a.body[l]).length >= 2, `${a.id} ${l}`);
	const linked = new Set(ARTICLES.flatMap((a) => [...a.body.en.matchAll(/\]\((help\.[a-z0-9._]+)/g)].map((m) => m[1]!)));
	for (const a of ARTICLES) if (a.id !== DEFAULT_ARTICLE) assert.ok(linked.has(a.id), `${a.id} is not linked from any article`);
});

test("markdown: headings get ids, help links are intercepted, html is escaped", () => {
	const html = renderMarkdownToHtml("## Title {#abc}\n\nSee [x](help.topic.api#rest) and <script>alert(1)</script> and `a<b`.\n\n| Key | Value |\n|---|---|\n| `k` | v |");
	assert.match(html, /<h2 id="abc">Title<\/h2>/);
	assert.match(html, /data-help-link="help\.topic\.api#rest"/);
	assert.ok(!html.includes("<script>"));
	assert.match(html, /<code>a&lt;b<\/code>/);
	assert.match(html, /<table>/);
});
