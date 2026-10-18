import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HelpApp } from "../client/App.tsx";

export default async function Page() {
	let initialIndex: any = null;
	try {
		const raw = await readFile(join(process.cwd(), "public", "help", "index.json"), "utf8");
		initialIndex = JSON.parse(raw);
	} catch {
		try {
			const raw = await readFile(join(process.cwd(), "help-site", "public", "help", "index.json"), "utf8");
			initialIndex = JSON.parse(raw);
		} catch {
			// fallback to client fetch
		}
	}
	return <HelpApp initialIndex={initialIndex} />;
}
