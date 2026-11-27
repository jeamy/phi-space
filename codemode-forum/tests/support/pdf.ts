// PDFs for the tests, written by hand (no package makes them): pages with lines of text in a standard font, a page
// that holds only a picture (a scan), and the dictionary of a password-encrypted file.
const enc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** A PDF of `pages`: each a list of lines, or "scan" for a page with a picture and no text. `encrypted`: a standard
 *  security handler whose password is not empty. */
export function makePdf(pages: Array<string[] | "scan">, o: { encrypted?: boolean } = {}): Buffer {
	const objs: string[] = [];
	const add = (body: string) => { objs.push(body); return objs.length; };
	const catalog = add(""), tree = add(""), font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids: number[] = [];
	for (const p of pages) {
		let stream: string, res: string;
		if (p === "scan") {
			const img = add(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\x00\xff\xff\x00\nendstream`);
			stream = "q 200 0 0 200 100 400 cm /Im1 Do Q";
			res = `<< /XObject << /Im1 ${img} 0 R >> >>`;
		} else {
			stream = `BT /F1 12 Tf 72 720 Td 14 TL ${p.map((l) => `(${enc(l)}) Tj T*`).join(" ")} ET`;
			res = `<< /Font << /F1 ${font} 0 R >> >>`;
		}
		const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
		kids.push(add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${content} 0 R >>`));
	}
	objs[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
	objs[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	const encrypt = o.encrypted ? add(`<< /Filter /Standard /V 1 /R 2 /O <${"7a".repeat(32)}> /U <${"3c".repeat(32)}> /P -4 >>`) : 0;
	let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
	const offsets: number[] = [];
	objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
	const xref = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}
