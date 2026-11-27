// The FORUM page (docs/forum-seite-plan-2026-11-26.en.md, sections 4, 10 and 11), held where it can fail mechanically:
// every input, choice, text area and button of the page goes through client/forum/controls.tsx, which takes a name and
// a tip (the types require both); its style sheet sets no width above 360 px; its places have their routes.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const at = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(at(p), "utf8");
// the page's files: its own, and the panes it shares with the expert view
const PAGE = [...readdirSync(at("client/forum")).filter((f) => f.endsWith(".tsx") && f !== "controls.tsx").map((f) => `client/forum/${f}`), "client/panes.tsx"];

test("the page's controls all have a name and a tip: no raw input, select, textarea or button outside the wrappers", () => {
	assert.ok(PAGE.length >= 3, PAGE.join(", "));
	for (const f of PAGE) {
		const raw = [...read(f).matchAll(/<(input|select|textarea|button)\b/g)].map((m) => m[1]);
		assert.deepEqual(raw, [], `${f} has raw controls`);
	}
	// each wrapper's use names its tip (the types require it; this keeps a cast from slipping one through)
	for (const f of PAGE) for (const m of read(f).matchAll(/<(Field|Area|Choice|Tick|Act)\b([^>]*?)\/?>/gs)) {
		assert.match(m[2]!, /\blabel=/, `${f}: a ${m[1]} without a label`);
		assert.match(m[2]!, /\btip="[a-z]+"/, `${f}: a ${m[1]} without a tip`);
	}
});

test("the page's style sheet sets no width or min-width above 360 px", () => {
	const css = read("client/styles/page.css").replace(/\/\*[\s\S]*?\*\//g, "");
	const wide = [...css.matchAll(/(?<![-\w])(min-width|width)\s*:\s*([^;}]+)/g)].filter((m) => [...m[2]!.matchAll(/(\d+(?:\.\d+)?)px/g)].some((n) => Number(n[1]) > 360));
	assert.deepEqual(wide.map((m) => m[0]), []);
});

test("the four places have their routes, the present page stays as the expert view, and the page has a manifest", () => {
	for (const f of ["app/page.tsx", "app/r/[room]/page.tsx", "app/settings/page.tsx", "app/help/page.tsx", "app/expert/page.tsx", "app/manifest.ts", "public/icon.svg"]) assert.ok(existsSync(at(f)), f);
	assert.match(read("app/expert/page.tsx"), /CodemodeForum/);
	assert.match(read("app/layout.tsx"), /export const viewport[^\n]*viewportFit: "cover"/);
});
