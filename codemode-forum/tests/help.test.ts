// The help articles: both languages, links and anchors resolve, the markdown is escaped; the words of "Words used
// here" are linked where they first appear; the diagrams exist in both languages; every tip is used and links to a
// section that exists (docs/forum-seite-plan-2026-11-26.en.md, section 11).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { ARTICLES, DEFAULT_ARTICLE, SECTIONS, WORDS, articleById, tocOf } from "../client/help/articles.ts";
import { TIPS } from "../client/lib/tips.ts";
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

const client = new URL("../client/", import.meta.url), pub = new URL("../public/", import.meta.url);

test("every word of \"Words used here\" has its entry, and a plain article links it where it first appears", () => {
	const words = articleById("help.topic.words")!;
	for (const l of langs) for (const w of Object.keys(WORDS)) assert.match(words.body[l], new RegExp(`^### [^\\n]+ \\{#${w}\\}$`, "m"), `${l}: no entry for ${w}`);
	const plain = ARTICLES.filter((a) => a.plain && a.id !== words.id);
	assert.ok(plain.length >= 1);
	for (const a of plain) for (const l of langs) {
		// headings and image captions are not read for this: a heading carries no link, a caption repeats the text
		const text = a.body[l].split("\n").map((line) => (/^(#|!\[)/.test(line) ? " ".repeat(line.length) : line)).join("\n");
		const links = [...text.matchAll(/\[([^\]]*)\]\(help\.topic\.words#([a-z]+)\)/g)].map((m) => ({ from: m.index!, to: m.index! + m[0].length, word: m[2]! }));
		for (const [w, forms] of Object.entries(WORDS)) {
			const first = new RegExp(`(?<!\\p{L})(${forms[l].join("|")})(?!\\p{L})`, "u").exec(text);
			if (!first) continue;
			assert.ok(links.some((k) => k.word === w && k.from <= first.index && first.index < k.to), `${a.id} ${l}: "${first[1]}" first appears unlinked (help.topic.words#${w})`);
		}
	}
});

test("a diagram of an article exists in the page's files, in the article's language", () => {
	let seen = 0;
	for (const a of ARTICLES) for (const l of langs) for (const m of a.body[l].matchAll(/^!\[[^\]]+\]\((\/help\/img\/[a-z0-9-]+)\.svg\)$/gm)) {
		seen++;
		assert.ok(existsSync(new URL("." + m[1] + ".svg", pub)), `${a.id} ${l}: ${m[1]}.svg is missing`);
		assert.equal(m[1]!.endsWith("-de"), l === "de", `${a.id} ${l}: ${m[1]}.svg is the other language's diagram`);
	}
	assert.ok(seen >= 2);
});

test("every tip has both languages, links to a section that exists, and is used in the page", () => {
	const sources = readdirSync(client, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx")).map((f) => readFileSync(new URL(f, client), "utf8")).join("\n");
	for (const [id, tip] of Object.entries(TIPS)) {
		const target = articleById(tip.article);
		assert.ok(target, `tip ${id}: unknown article ${tip.article}`);
		for (const l of langs) {
			assert.ok(tip.text[l].trim(), `tip ${id} ${l}`);
			assert.ok(anchorsOf(target!.body[l]).has(tip.anchor), `tip ${id} ${l}: unknown anchor ${tip.article}#${tip.anchor}`);
		}
		assert.match(sources, new RegExp(`<HelpTip id="${id}"`), `tip ${id} is not used`);
	}
});
