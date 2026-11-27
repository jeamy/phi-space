// The text of a PDF (docs/forum-seite-plan-2026-11-26.en.md, section 6, decision 12), taken out with pdfjs-dist. A PDF
// is hostile input until proven otherwise: this file runs only as a child of the sandbox process (sandbox-host.ts),
// isolated there (no network, no files beyond pdfjs, nothing of the Space), with bounded memory and time. It reads the
// PDF's bytes on stdin and writes one line of JSON on stdout:
//
//   { ok: true, pages, text }                          the text, a mark "--- page N ---" before each page
//   { ok: false, code, pages?, message }               encrypted | broken | pages (over the limit) | text (over the
//                                                      limit) | scanned (no text at all)
//
//   node --experimental-strip-types server/pdf-extract.ts <max pages> <max text bytes>
//
// pdfjs 6 compiles nothing from a PDF (it has no eval path left); it is asked to load no fonts and no system fonts,
// to render no XFA form, to decode no image, and to fetch nothing.
import { pathToFileURL } from "node:url";

export type PdfText = { ok: true; pages: number; text: string } | { ok: false; code: "encrypted" | "broken" | "pages" | "text" | "scanned"; pages?: number; message: string };
export const PDF_LIMITS = { pages: 300, textBytes: 2_000_000 };

/** The text of a PDF with a mark at every page, or why there is none. */
export async function extractPdf(bytes: Uint8Array, lim = PDF_LIMITS): Promise<PdfText> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	let doc: any, task: any;
	try {
		task = pdfjs.getDocument({ data: bytes, enableXfa: false, isImageDecoderSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, disableAutoFetch: true, disableStream: true, stopAtErrors: false, verbosity: 0 });
		doc = await task.promise;
	} catch (e) {
		const name = (e as { name?: string }).name ?? "";
		await task?.destroy().catch(() => {});
		if (name === "PasswordException") return { ok: false, code: "encrypted", message: "the PDF is encrypted with a password" };
		return { ok: false, code: "broken", message: `the PDF cannot be read (${String((e as Error).message ?? e).slice(0, 120)})` };
	}
	try {
		const pages = doc.numPages as number;
		if (pages > lim.pages) return { ok: false, code: "pages", pages, message: `the PDF has ${pages} pages; at most ${lim.pages} are read` };
		const out: string[] = [];
		let bytesSoFar = 0, letters = 0;
		for (let n = 1; n <= pages; n++) {
			const page = await doc.getPage(n);
			const content = await page.getTextContent();
			// items in reading order; a line ends where pdfjs says so
			const text = (content.items as Array<{ str?: string; hasEOL?: boolean }>).map((x) => (x.str ?? "") + (x.hasEOL ? "\n" : "")).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
			page.cleanup();
			letters += text.replace(/\s+/g, "").length;
			const part = `--- page ${n} ---\n${text}\n`;
			bytesSoFar += Buffer.byteLength(part);
			if (bytesSoFar > lim.textBytes) return { ok: false, code: "text", pages, message: `the PDF's text has more than ${lim.textBytes / 1000} kB` };
			out.push(part);
		}
		if (letters === 0) return { ok: false, code: "scanned", pages, message: `the PDF has ${pages} page${pages === 1 ? "" : "s"} and no text: it is scanned or holds pictures only` };
		return { ok: true, pages, text: out.join("\n").trimEnd() + "\n" };
	} catch (e) {
		return { ok: false, code: "broken", message: `the PDF cannot be read (${String((e as Error).message ?? e).slice(0, 120)})` };
	} finally { await task.destroy().catch(() => {}); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	const lim = { pages: Number(process.argv[2]) || PDF_LIMITS.pages, textBytes: Number(process.argv[3]) || PDF_LIMITS.textBytes };
	const r = await extractPdf(new Uint8Array(Buffer.concat(chunks)), lim).catch((e) => ({ ok: false, code: "broken", message: String((e as Error).message ?? e).slice(0, 200) }) as PdfText);
	process.stdout.write(JSON.stringify(r) + "\n");
	process.exit(0);
}
