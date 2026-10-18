// Only files explicitly listed by the previous generated index may be retired.
import { readFile, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

function articlePath(path: unknown): string {
	if (typeof path !== "string" || !/^\/help\/articles\/(de|en)\/(api|topics|workflows)\/[a-z0-9_-]+\.md$/.test(path)) {
		throw new Error("Unsafe generated article path");
	}
	return path;
}

export async function previousArticlePaths(publicRoot: string): Promise<string[]> {
	let raw: string;
	try { raw = await readFile(join(publicRoot, "help", "index.json"), "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const data = JSON.parse(raw);
	if (typeof data.schema !== "string" || !data.schema.endsWith("-help-site-index-v1") || !Array.isArray(data.articles)) {
		throw new Error("Cannot establish ownership of previous generated articles");
	}
	return [...new Set<string>(data.articles.map((article: { path?: unknown }) => articlePath(article.path)))];
}

export async function retireGeneratedArticles(publicRoot: string, previous: readonly string[], current: ReadonlySet<string>): Promise<void> {
	// Validate the complete manifest before deleting anything, not midway through cleanup.
	const retired = previous.map(articlePath).filter(path => !current.has(path));
	for (const path of retired) {
		const file = join(publicRoot, path.slice(1));
		try {
			const stat = await lstat(file);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Generated article is not a regular file");
			await unlink(file);
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
}
