// What a child of the sandbox reaches (tests/pdf.test.ts starts it through spawnIsolated in place of the PDF reader):
// a file, the Space's unix socket, an address on the network. Prints one line of JSON, the outcome of each.
import { readFileSync } from "node:fs";
import net from "node:net";

const [socket, file, host, port] = process.argv.slice(2);
const out: Record<string, string> = {};
try { readFileSync(file!); out.file = "read"; } catch (e) { out.file = (e as { code?: string }).code ?? "error"; }
const attempt = (connect: () => net.Socket) => new Promise<string>((ok) => {
	let s: net.Socket;
	try { s = connect(); } catch (e) { ok((e as { code?: string }).code ?? "error"); return; }
	s.setTimeout(3000);
	s.on("connect", () => { s.destroy(); ok("connected"); });
	s.on("timeout", () => { s.destroy(); ok("timeout"); });
	s.on("error", (e) => ok((e as { code?: string }).code ?? "error"));
});
out.socket = await attempt(() => net.connect(socket!));
out.network = await attempt(() => net.connect(Number(port), host!));
process.stdout.write(JSON.stringify(out) + "\n");
