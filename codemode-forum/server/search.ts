// The web search of the research agents: the HTML result page of DuckDuckGo, no API key. Only the search results come
// back (title, URL, snippet); no page is ever fetched, so the hub cannot be pointed at an internal address (SSRF).
// Only agents search, from queries they write themselves for a task; there is no search for visitors.
// The results are untrusted data: the prompts that carry them say so.
import { request } from "node:https";

/** One search result: what DuckDuckGo shows for it, nothing fetched from the page itself. */
export type SearchResult = { title: string; url: string; snippet: string };

const ENDPOINT = "https://html.duckduckgo.com/html/";
const MAX_BYTES = 1_000_000, TIMEOUT_MS = 10_000, MAX_RESULTS = 5;

/** Searches a day may run: CODEMODE_SEARCH_PER_DAY (default 100); the model process counts them for every process
 *  through the space (quota.ts), searchAllowed counts them in this process only. */
export const searchesPerDay = () => Math.max(0, Number(process.env.CODEMODE_SEARCH_PER_DAY ?? "") || 100);
let day = "", used = 0;

/** Takes one search from the day's allowance; false when it is used up. */
export function searchAllowed(): boolean {
	const today = new Date().toISOString().slice(0, 10);
	if (today !== day) { day = today; used = 0; }
	if (used >= searchesPerDay()) return false;
	used++;
	return true;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };
/** Plain text of an HTML fragment: tags out, entities decoded, spacing collapsed. */
export const plainText = (html: string) => html.replace(/<[^>]*>/g, "")
	.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : m))
	.replace(/\s+/g, " ").trim();

/** The target of a result link: DuckDuckGo wraps it in a redirect (`//duckduckgo.com/l/?uddg=…`); only http(s) URLs pass. */
export function resultUrl(href: string): string | null {
	let url = href.replace(/&amp;/g, "&");
	try {
		const u = new URL(url, "https://duckduckgo.com");
		if (u.hostname.endsWith("duckduckgo.com") && u.pathname === "/l/") url = u.searchParams.get("uddg") ?? "";
		else url = u.href;
		const t = new URL(url);
		return t.protocol === "http:" || t.protocol === "https:" ? t.href : null;
	} catch { return null; }
}

/** The results on a DuckDuckGo HTML page (ads left out), at most `max`. */
export function parseResults(html: string, max = MAX_RESULTS): SearchResult[] {
	const out: SearchResult[] = [];
	for (const block of html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1)) {
		if (/result--ad\b/.test(block.slice(0, 200))) continue;
		const a = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block) ?? /<a[^>]+href="([^"]+)"[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (!a) continue;
		const url = resultUrl(a[1]!);
		if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
		const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block);
		out.push({ title: plainText(a[2]!).slice(0, 200), url: url.slice(0, 500), snippet: snippet ? plainText(snippet[1]!).slice(0, 400) : "" });
		if (out.length >= max) break;
	}
	return out;
}

/** POSTs a form to DuckDuckGo with node:https (fetch adds browser headers that DuckDuckGo answers with a bot check):
 *  fixed host, no redirects followed, at most MAX_BYTES read, a time limit. */
function post(body: string, signal?: AbortSignal): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const req = request(ENDPOINT, {
			method: "POST", timeout: TIMEOUT_MS, ...(signal ? { signal } : {}),
			headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) phi-spaces codemode research", "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), accept: "text/html" },
		}, (res) => {
			const chunks: Buffer[] = [];
			let size = 0;
			res.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BYTES) { res.destroy(); return; } chunks.push(c); });
			res.on("close", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
			res.on("error", reject);
		});
		req.on("timeout", () => req.destroy(new Error("Web search timed out")));
		req.on("error", reject);
		req.end(body);
	});
}

/** One web search; throws when the day's allowance is used up or DuckDuckGo does not answer with results. `allowed`
 *  takes one search from the allowance (default: this process's own count). */
export async function webSearch(query: string, o: { signal?: AbortSignal; post?: typeof post; allowed?: () => Promise<boolean> } = {}): Promise<SearchResult[]> {
	const q = query.replace(/\s+/g, " ").trim().slice(0, 200);
	if (!q) return [];
	if (!(await (o.allowed ?? (async () => searchAllowed()))())) throw new Error("The web searches of the day are used up (CODEMODE_SEARCH_PER_DAY)");
	const res = await (o.post ?? post)(new URLSearchParams({ q, kl: "wt-wt" }).toString(), o.signal);
	if (res.status !== 200 || /anomaly\.js/.test(res.text)) throw new Error(`Web search refused (HTTP ${res.status}${res.status === 202 ? ", bot check" : ""})`);
	return parseResults(res.text);
}
