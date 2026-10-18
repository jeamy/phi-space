// Builds the canonical PI-SPACES / HELP corpus (for both Next.js public/help/ and dist/public/help/)
// and also produces a standalone React 19 browser bundle for fast test assertions.

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { buildCorpus } from "./build-corpus.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_DIR = join(ROOT, "client");
const DIST_PUBLIC = join(ROOT, "dist", "public");

export async function buildHelpSite(): Promise<void> {
	await buildCorpus();

	const assetsDir = join(DIST_PUBLIC, "assets");
	await mkdir(assetsDir, { recursive: true });

	await copyFile(join(CLIENT_DIR, "index.html"), join(DIST_PUBLIC, "index.html"));
	await copyFile(join(CLIENT_DIR, "styles", "layout.css"), join(assetsDir, "layout.css"));

	await esbuild.build({
		entryPoints: [join(CLIENT_DIR, "main.tsx")],
		outfile: join(assetsDir, "app.js"),
		bundle: true,
		format: "esm",
		platform: "browser",
		target: ["es2022"],
		jsx: "automatic",
		nodePaths: [join(ROOT, "node_modules")],
		minify: false,
		sourcemap: false,
	});
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	await buildHelpSite();
	console.log(`Built PI-SPACES / HELP corpus & React 19 assets -> ${DIST_PUBLIC}`);
}
