// Files the projects built on phi-spaces keep as their own copies, because Next.js bundles nothing from outside the
// project directory (client code) or a file resolves paths from its own place (env.ts): each copy must stay the same as
// the others, apart from its leading comment. A change to one is a change to all of them, made on purpose here.
// Kept apart on purpose (they differ in what they do): client/lib/theme.ts and ThemeControls.tsx (the chat chooses the
// language, the game follows prefers-color-scheme), server/launch.ts (each project has its own roles).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const across = (file: string, projects: string[]) => projects.map((p) => `${p}/${file}`);

/** Each group lists the paths (from the repository root) that must stay the same. The dashboard keeps a copy of the
 *  palettes too (src/dashboard/palettes.ts; tsconfig leaves it out, it uses the DOM). */
const COPIES: Record<string, string[]> = {
	"client/lib/palettes.ts": [...across("client/lib/palettes.ts", ["help-site", "codemode-chat", "spaces-mmo"]), "src/dashboard/palettes.ts"],
	"client/lib/markdown.ts": across("client/lib/markdown.ts", ["help-site", "codemode-chat", "spaces-mmo"]),
	"server/env.ts": across("server/env.ts", ["codemode-chat", "spaces-mmo"]),
};

/** The file without its leading `//` comment lines (each copy says where it comes from). */
const body = (path: string) => readFileSync(ROOT + path, "utf8").replace(/^(\/\/[^\n]*\n)+/, "");

for (const [file, paths] of Object.entries(COPIES)) {
	test(`${file} is the same in ${paths.join(", ")}`, () => {
		const [first, ...rest] = paths;
		const want = body(first!);
		for (const p of rest) assert.equal(body(p), want, `${p} drifted from ${first}`);
	});
}
