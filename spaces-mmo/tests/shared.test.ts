// The browser's side of the contract (docs/rust-portierung.en.md, R8.0 item 3): the page (client/, app/) reaches the
// server's types and its few shared functions only through shared/, and shared/ needs nothing of the server: no node:
// module, no space, no engine. So the Rust web process can take the server's place behind the same page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const files = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
	.filter((e) => e.isFile() && /\.tsx?$/.test(e.name)).map((e) => relative(ROOT, join(e.parentPath, e.name)));
/** Every module a file imports (static, `export … from` and `import("…")`), with whether only its types are taken. */
const imports = (file: string) => {
	const text = readFileSync(join(ROOT, file), "utf8"), out: Array<{ from: string; typeOnly: boolean }> = [];
	for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+"([^"]+)"/gm)) out.push({ from: m[3]!, typeOnly: !!m[2] });
	for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push({ from: m[1]!, typeOnly: false });
	for (const m of text.matchAll(/import\("([^"]+)"\)/g)) out.push({ from: m[1]!, typeOnly: false });
	return out;
};

test("the page imports nothing of server/: its types and shared functions come from shared/", () => {
	const bad = [...files("client"), ...files("app")].flatMap((f) => imports(f).filter((i) => /(^|\/)server\//.test(i.from)).map((i) => `${f}: ${i.from}`));
	assert.deepEqual(bad, []);
});

test("shared/ needs nothing of the server: no node: module, no server/ or engine file, phi-spaces only for types", () => {
	const list = files("shared");
	assert.ok(list.length >= 8, "shared/ holds the modules");
	const bad = list.flatMap((f) => imports(f).filter((i) => !(i.from.startsWith("./") && !i.from.includes("/", 2)) && !(i.from === "phi-spaces" && i.typeOnly)).map((i) => `${f}: ${i.from}`));
	assert.deepEqual(bad, []);
});
