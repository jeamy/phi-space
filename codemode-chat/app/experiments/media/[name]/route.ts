import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXPERIMENT_DOCS, EXPERIMENT_MEDIA } from "../../../../server/experiments-content.ts";

export const dynamic = "force-static";
export function generateStaticParams() { return EXPERIMENT_MEDIA.map((name) => ({ name })); }
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
	const { name } = await params;
	if (!EXPERIMENT_MEDIA.includes(name)) return new Response("Not found", { status: 404 });
	const bytes = await readFile(join(EXPERIMENT_DOCS, "img/codemode-planung", name));
	return new Response(new Uint8Array(bytes), { headers: { "content-type": name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".jpg") ? "image/jpeg" : "image/png", "x-content-type-options": "nosniff" } });
}
