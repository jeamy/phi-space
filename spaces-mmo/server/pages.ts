// The page as static files (docs/rust-portierung.en.md, R8.0 item 4): `next build` exports the one page of app/ into out/
// (next.config.mjs `output: "export"`), with out/BUILD_ID beside it (package.json `build`). The web process serves that
// folder itself, so no Next server runs in production and any web server (the Rust web process of R8.5) can deliver the
// page. `next dev` stays for development (server/index.ts --dev).
//
// What is served: `/` as index.html, `/x` as x, x.html or x/index.html; GET and HEAD only; a path that leaves the folder,
// a hidden file and BUILD_ID itself are not. What Next names by content (`/_next/static/…`) is cached for a year, all
// else revalidated. A miss is the export's 404.html with status 404.
import type http from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

export const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
	".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
	".ttf": "font/ttf", ".wasm": "application/wasm", ".map": "application/json; charset=utf-8",
};

/** The build id the export wrote (out/BUILD_ID), or null. */
export function exportedBuild(dir: string): string | null {
	try { return readFileSync(join(dir, "BUILD_ID"), "utf8").trim() || null; } catch { return null; }
}

/** The file for a request path inside `dir`, or null. */
export function pageFile(dir: string, path: string): string | null {
	let p: string;
	try { p = decodeURIComponent(path); } catch { return null; }
	if (p.includes("\0")) return null;
	const rel = normalize(p).replace(/^[/\\]+/, "");
	if (rel.split(/[/\\]/).some((s) => s === ".." || (s.startsWith(".") && s !== "")) || rel === "BUILD_ID") return null;
	const base = join(dir, rel);
	if (base !== dir && !base.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return null;
	for (const f of rel === "" ? [join(dir, "index.html")] : [base, `${base}.html`, join(base, "index.html")]) {
		try { if (statSync(f).isFile()) return f; } catch { /* the next candidate */ }
	}
	return null;
}

/** Serves the exported page from `dir`; false when the request is not for it (another method). */
export function servePage(dir: string, req: http.IncomingMessage, res: http.ServerResponse, path: string): boolean {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	const file = pageFile(dir, path);
	const send = (status: number, f: string) => {
		const body = readFileSync(f);
		const immutable = status === 200 && path.startsWith("/_next/static/");
		res.writeHead(status, { "content-type": TYPES[extname(f).toLowerCase()] ?? "application/octet-stream", "content-length": String(body.length), "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
		res.end(req.method === "HEAD" ? undefined : body);
	};
	if (file) { send(200, file); return true; }
	const missing = join(dir, "404.html");
	try { if (statSync(missing).isFile()) { send(404, missing); return true; } } catch { /* plain text */ }
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end("Not found");
	return true;
}
