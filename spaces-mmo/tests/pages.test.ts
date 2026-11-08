// The page as static files (docs/rust-portierung.en.md, R8.0 item 4; server/pages.ts): the web process serves the export
// of the Next app (out/), its build id from out/BUILD_ID, nothing outside the folder, a miss as the export's 404 page.
// The same contract holds for the Rust web process (R8.5).
import "./test-env.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageFile } from "../server/pages.ts";
import { Player, startServer } from "./stack.ts";

function exported(): string {
	const dir = mkdtempSync(join(tmpdir(), "mmo-pages-"));
	mkdirSync(join(dir, "_next", "static", "chunks"), { recursive: true });
	mkdirSync(join(dir, "_not-found"));
	writeFileSync(join(dir, "index.html"), "<!doctype html><title>Leuchtfeuer</title>");
	writeFileSync(join(dir, "404.html"), "<!doctype html><title>404</title>");
	writeFileSync(join(dir, "_not-found.html"), "nf");
	writeFileSync(join(dir, "manifest.webmanifest"), "{}");
	writeFileSync(join(dir, "_next", "static", "chunks", "a1.js"), "console.log(1)");
	writeFileSync(join(dir, "BUILD_ID"), "build-7\n");
	writeFileSync(join(dir, ".hidden"), "no");
	return dir;
}

test("which file a path names: index, the file, its .html; never outside the folder, a hidden file or BUILD_ID", () => {
	const dir = exported();
	try {
		assert.equal(pageFile(dir, "/"), join(dir, "index.html"));
		assert.equal(pageFile(dir, "/manifest.webmanifest"), join(dir, "manifest.webmanifest"));
		assert.equal(pageFile(dir, "/_not-found"), join(dir, "_not-found.html"));
		assert.equal(pageFile(dir, "/_next/static/chunks/a1.js"), join(dir, "_next", "static", "chunks", "a1.js"));
		for (const bad of ["/../package.json", "/%2e%2e/package.json", "/_next/../../x", "/.hidden", "/BUILD_ID", "/%00", "/%E0%A4%A", "/nothing"]) assert.equal(pageFile(dir, bad), null, bad);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the web process serves the exported page: types, caching, HEAD, 404 page, its build id for the game socket", { timeout: 120_000 }, async () => {
	const dir = exported();
	const srv = await startServer({ pages: dir });
	try {
		const index = await fetch(`${srv.url}/`);
		assert.equal(index.status, 200);
		assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
		assert.equal(index.headers.get("cache-control"), "no-cache");
		assert.match(await index.text(), /Leuchtfeuer/);
		const chunk = await fetch(`${srv.url}/_next/static/chunks/a1.js`);
		assert.match(chunk.headers.get("content-type") ?? "", /^text\/javascript/);
		assert.match(chunk.headers.get("cache-control") ?? "", /immutable/);
		const head = await fetch(`${srv.url}/manifest.webmanifest`, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.match(head.headers.get("content-type") ?? "", /manifest\+json/);
		const miss = await fetch(`${srv.url}/nirgends`);
		assert.equal(miss.status, 404);
		assert.match(await miss.text(), /404/);
		assert.equal((await fetch(`${srv.url}/BUILD_ID`)).status, 404);
		assert.equal((await fetch(`${srv.url}/healthz`)).status, 200, "the API stays the web process's own");
		// the page's build reaches the game: a page of another build is told to reload
		const p = new Player(srv.url);
		await p.post("/api/guest");
		const hello = await p.play();
		assert.equal((hello as { build?: string | null }).build, "build-7");
		await p.leave();
	} finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
