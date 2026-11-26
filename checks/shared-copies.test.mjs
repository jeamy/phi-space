// Files the projects built on phi-spaces keep as their own copies, because Next.js bundles nothing from outside the
// project directory (client code) or a file resolves paths from its own place (env.ts): each copy must stay the same as
// the others, apart from its leading comment. A change to one is a change to all of them, made on purpose here.
// Kept apart on purpose (they differ in what they do): client/lib/theme.ts and ThemeControls.tsx (the chat chooses the
// language, the game follows prefers-color-scheme), server/launch.ts (each project has its own roles).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_PREFIX, REPO } from "./roots.mjs";

const across = (file, projects) => projects.map((p) => `${p}/${file}`);

/** Each group lists the paths (from the repository root) that must stay the same. The dashboard keeps a copy of the
 *  palettes too (src/dashboard/palettes.ts; tsconfig leaves it out, it uses the DOM), and so does spaces-files' page
 *  (spaces-files/web/palettes.ts). */
const COPIES = {
	"client/lib/palettes.ts": [...across("client/lib/palettes.ts", ["help-site", "codemode-chat", "codemode-forum", "spaces-mmo"]), `${PACKAGE_PREFIX}src/dashboard/palettes.ts`, "spaces-files/web/palettes.ts"],
	"client/lib/markdown.ts": across("client/lib/markdown.ts", ["help-site", "codemode-chat", "codemode-forum", "spaces-mmo"]),
	"server/env.ts": across("server/env.ts", ["codemode-chat", "codemode-forum", "spaces-files", "spaces-mmo"]),
	// the relying party of the browser sign-in (docs/forum-seite-plan-2026-11-26.en.md, section 5)
	"server/oidc.ts": across("server/oidc.ts", ["spaces-files", "codemode-forum"]),
	// the "?" beside a control; each project has its own client/lib/tips.ts
	"client/HelpTip.tsx": across("client/HelpTip.tsx", ["codemode-chat", "codemode-forum"]),
	// the diagrams of the forum's help (codemode-forum/public/help/img), copies of the documentation's, in both languages
	...Object.fromEntries(["signin", "signin-de"].map((n) =>
		[`forum-${n}.svg`, [`docs/img/forum-${n}.svg`, `codemode-forum/public/help/img/forum-${n}.svg`]])),
	// the diagrams the help site shows in its articles (help-site/corpus/img), copies of the documentation's
	...Object.fromEntries(["architecture", "relationships", "workspaces", "revocation", "save", "restore"].map((n) =>
		[`zanzibar-${n}.svg`, [`docs/img/zanzibar-${n}.svg`, `help-site/corpus/img/zanzibar-${n}.svg`]])),
};

/** The file without its leading `//` comment lines (each copy says where it comes from). */
const body = (path) => readFileSync(join(REPO, path), "utf8").replace(/^(\/\/[^\n]*\n)+/, "");

for (const [file, paths] of Object.entries(COPIES)) {
	test(`${file} is the same in ${paths.join(", ")}`, () => {
		const [first, ...rest] = paths;
		const want = body(first);
		for (const p of rest) assert.equal(body(p), want, `${p} drifted from ${first}`);
	});
}
