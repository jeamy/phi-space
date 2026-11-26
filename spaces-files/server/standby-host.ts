// The standby's process on another machine (docs/zanzibar-agent-filesystem-plan.en.md, section 6.7): it keeps the
// standby's state and blob directories and takes the primary's units and blobs over mutual TLS (server/standby-net.ts).
//
//   node server/standby-host.ts --state DIR --blobs DIR --listen host:port --cert FILE --key FILE --ca FILE
//
// `--ca` is the CA (or the self-signed certificate) of the primary's client certificate: no other client is served.
// The ready line is `[files-standby] ready on host:port`. Promoting this standby (after its Space store was promoted):
// stop this process, run `operator promote-standby` offline on the two directories, start the service on them.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseListen } from "./agent-net.ts";
import { serveStandby } from "./standby-net.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const arg = (n: string) => { const i = args.indexOf(n); const v = i >= 0 ? args[i + 1] : undefined; if (!v) { console.error(`usage: standby-host.ts --state DIR --blobs DIR --listen host:port --cert FILE --key FILE --ca FILE (missing ${n})`); process.exit(2); } return v; };
	const listen = parseListen(arg("--listen"));
	const server = await serveStandby({
		stateDir: arg("--state"), blobDir: arg("--blobs"), ...listen,
		tls: { cert: readFileSync(arg("--cert")), key: readFileSync(arg("--key")), ca: readFileSync(arg("--ca")) },
	});
	const a = server.address();
	console.log(`[files-standby] ready on ${a.address}:${a.port}`);
	const stop = async () => { await server.close(); process.exit(0); };
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
