// Signed RPC over a provisioned SSH forced command. The SSH key alone never authorizes a recovery operation.
import { spawn } from "node:child_process";
import type { Transport } from "./remote.ts";
export function sshRecoveryTransport(target: string, timeoutMs = 10000): Transport & { close(): void } {
 if (!/^[A-Za-z0-9_.@:-]+$/.test(target) || target.startsWith("-")) throw new Error("invalid recovery SSH target");
 const active = new Set<ReturnType<typeof spawn>>(); let closed = false;
 return { close() { closed = true; for (const c of active) c.kill(); }, async request(text) {
  if (closed || Buffer.byteLength(text) > 256 * 1024) throw new Error("recovery transport is closed or request exceeds budget");
  return new Promise((resolve, reject) => {
   const child = spawn("ssh", ["-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", target, "phi-spaces-recovery"], { stdio: ["pipe", "pipe", "ignore"] }); active.add(child);
   let output = Buffer.alloc(0), done = false;
   const finish = (error?: Error, reply?: string) => { if (done) return; done = true; clearTimeout(timer); active.delete(child); child.kill(); error ? reject(error) : resolve(reply!); };
   const timer = setTimeout(() => finish(new Error("recovery SSH timed out; resolve the existing request identity")), timeoutMs);
   child.on("error", e => finish(e)); child.stdin!.on("error", e => finish(e)); child.stdout!.on("data", data => { output = Buffer.concat([output, data]); if (output.length > 256 * 1024) finish(new Error("recovery response exceeds budget")); });
   child.on("close", code => { if (code !== 0) return finish(new Error("recovery forced command failed")); finish(undefined, output.toString("utf8")); }); child.stdin!.end(text);
  });
 } };
}
