import { experimentSourceUrl } from "../../../../client/experiments/publication-links.ts";

// Preserve old source URLs while sending readers to the canonical GitHub document.
export async function GET(request: Request, { params }: { params: Promise<{ document: string }> }) {
 const url = experimentSourceUrl((await params).document, new URL(request.url).searchParams.get("lang") ?? "en");
 return url ? Response.redirect(url, 302) : new Response("Not found", { status: 404 });
}
