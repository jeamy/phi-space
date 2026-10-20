// The research agents' web search: parsing DuckDuckGo's HTML result page, the redirect links, the guards.
import test from "node:test";
import assert from "node:assert/strict";
import { parseResults, plainText, resultUrl, webSearch } from "../server/search.ts";
import { parseQueries } from "../server/llm.ts";

const result = (href: string, title: string, snippet: string, extra = "") => `
<div class="result results_links results_links_deep web-result ${extra}">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${title}</a></h2>
  <a class="result__snippet" href="${href}">${snippet}</a>
</div>`;
const page = (...rs: string[]) => `<html><body><div class="results">${rs.join("")}</div></body></html>`;

test("the result page gives title, target URL and snippet; ads and non-web links are left out", () => {
	const html = page(
		result("https://duckduckgo.com/y.js?ad_provider=x", "Ad", "buy", "result--ad"),
		result("https://de.wikipedia.org/wiki/Rayleigh-Streuung", "<b>Rayleigh</b>-Streuung - Wikipedia", "Die <b>Rayleigh</b>-Streuung verursacht den blauen Farbton &amp; mehr"),
		result("//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.leifiphysik.de%2Foptik&amp;rut=abc", "LEIFI", "Himmelsblau"),
		result("javascript:alert(1)", "bad", "x"),
	);
	assert.deepEqual(parseResults(html), [
		{ title: "Rayleigh-Streuung - Wikipedia", url: "https://de.wikipedia.org/wiki/Rayleigh-Streuung", snippet: "Die Rayleigh-Streuung verursacht den blauen Farbton & mehr" },
		{ title: "LEIFI", url: "https://www.leifiphysik.de/optik", snippet: "Himmelsblau" },
	]);
	assert.equal(parseResults(page(...Array.from({ length: 9 }, (_, i) => result(`https://e.org/${i}`, `t${i}`, "s")))).length, 5);
	assert.equal(resultUrl("file:///etc/passwd"), null);
	assert.equal(plainText("a&#39;b &#x41; <i>c</i>"), "a'b A c");
});

test("a search goes to DuckDuckGo only through the guards: a bot check is an error, the day's allowance ends searching", async () => {
	const bodies: string[] = [];
	const ok = async (body: string) => { bodies.push(body); return { status: 200, text: page(result("https://e.org/a", "A", "a")) }; };
	assert.deepEqual(await webSearch("  Himmel   blau  ", { post: ok }), [{ title: "A", url: "https://e.org/a", snippet: "a" }]);
	assert.equal(new URLSearchParams(bodies[0]).get("q"), "Himmel blau");
	await assert.rejects(webSearch("x", { post: async () => ({ status: 202, text: "<script src=\"/anomaly.js?x\">" }) }), /bot check/);
	process.env.CODEMODE_SEARCH_PER_DAY = "1";
	try { await assert.rejects(webSearch("y", { post: ok }), /used up/); } finally { delete process.env.CODEMODE_SEARCH_PER_DAY; }
});

test("a research agent's queries: one per line, numbering and quotes off, at most three", () => {
	assert.deepEqual(parseQueries("1. \"Rayleigh Streuung\"\n- Himmel blau Wellenlänge\n\nab\n3) Abendrot Erklärung\n4. zu viel"), ["Rayleigh Streuung", "Himmel blau Wellenlänge", "Abendrot Erklärung"]);
});
