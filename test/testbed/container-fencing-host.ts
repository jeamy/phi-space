// Container fencing service on the docker host (big): the ContainerFencing adapter behind the mutual-TLS serveFencing.
//   node container-fencing-host.mjs <config.json>
// config: { host, port, caFile, certFile, keyFile, peers: {<sha256 fp>: {operator: true}}, pins: {<hostId>: {container, unit}}, unitDir, stateFile }
import { readFileSync } from "node:fs";
import { ContainerFencing } from "../../src/container-fencing.ts";
import { serveFencing } from "../../src/netcup-fencing.ts";
const c = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const server = await serveFencing(new ContainerFencing({ pins: c.pins, unitDir: c.unitDir, stateFile: c.stateFile }), { host: c.host, port: c.port, caFile: c.caFile, certFile: c.certFile, keyFile: c.keyFile, peers: c.peers });
console.log(JSON.stringify({ containerFencing: true, address: server.address(), pins: Object.keys(c.pins) }));
await new Promise<void>(resolve => { process.once("SIGTERM", () => resolve()); process.once("SIGINT", () => resolve()); });
await server.close();
