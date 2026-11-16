import { experimentSource } from "../../../../server/experiments-content.ts";

export async function GET(request: Request, { params }: { params: Promise<{ document: string }> }) {
	const source = experimentSource((await params).document, new URL(request.url).searchParams.get("lang") ?? "en");
	if (!source) return new Response("Not found", { status: 404 });
	return new Response(source.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${source.name}"`, "x-content-type-options": "nosniff" } });
}
