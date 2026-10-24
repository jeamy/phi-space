// Bounded RFC-6455 text gateway (a copy of codemode-chat/server/ws.ts: spaces-mmo keeps its own, docs/architektur.md).
// Client frames are masked; handlers receive queued messages in order. MESSAGES_PER_MIN is higher than in the chat:
// a player holding an arrow key sends a command per step.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export interface WsConnection {
 readonly id: string;
 send(data: unknown): void;
 close(): void;
 onMessage(handler: (text: string) => void | Promise<void>): void;
 onClose(handler: () => void): void;
}
const MAX_BYTES = 1_048_576;
const MESSAGES_PER_MIN = 600;
function frame(opcode: number, payload: Buffer): Buffer {
 const n = payload.length;
 const h = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10);
 h[0] = 0x80 | opcode;
 if (n < 126) h[1] = n;
 else if (n < 65536) { h[1] = 126; h.writeUInt16BE(n, 2); }
 else { h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
 return Buffer.concat([h, payload]);
}
export function upgradeWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | null {
 const key = req.headers["sec-websocket-key"];
 if (req.method !== "GET" || req.headers["sec-websocket-version"] !== "13" ||
  String(req.headers.upgrade).toLowerCase() !== "websocket" ||
  !String(req.headers.connection).toLowerCase().split(",").some(x => x.trim() === "upgrade") ||
  typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").length !== 16) {
  socket.destroy(); return null;
 }
 const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
 socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Accept: " + accept, "\r\n"].join("\r\n"));
 let buffer: Buffer = Buffer.from(head);
 let closed = false, fragments = false, fragBytes = 0;
 const parts: Buffer[] = [];
 const handlers: Array<(text: string) => void | Promise<void>> = [];
 const closers: Array<() => void> = [];
 const queued: string[] = [];
 let queuedBytes = 0, delivering = false, messageWindow = Date.now(), messageCount = 0;
 const decoder = new TextDecoder("utf-8", { fatal: true });
 const fireClose = () => {
  if (closed) return;
  closed = true; queued.length = 0; parts.length = 0; buffer = Buffer.alloc(0);
  for (const h of closers) { try { h(); } catch {} }
 };
 const stop = (code = 1000) => {
  if (closed) return;
  const data = Buffer.alloc(2); data.writeUInt16BE(code);
  try { socket.end(frame(8, data)); } catch { socket.destroy(); }
  fireClose();
 };
 const send = (opcode: number, data: Buffer) => {
  if (closed || !socket.writable) return;
  if (data.length > MAX_BYTES || socket.writableLength + data.length > 2 * MAX_BYTES) { socket.destroy(); fireClose(); return; }
  try { socket.write(frame(opcode, data)); } catch { socket.destroy(); fireClose(); }
 };
 const deliver = async () => {
  if (delivering || !handlers.length || closed) return;
  delivering = true;
  try {
   while (queued.length && !closed) {
    const text = queued.shift()!; queuedBytes -= Buffer.byteLength(text);
    for (const h of handlers) await h(text);
   }
  } catch { stop(1011); }
  finally { delivering = false; }
 };
 const parse = () => {
  while (!closed && buffer.length >= 2) {
   const b0 = buffer[0]!, b1 = buffer[1]!, opcode = b0 & 15, fin = !!(b0 & 128);
   let n = b1 & 127, offset = 2;
   if ((b0 & 112) || !(b1 & 128) || ![0, 1, 2, 8, 9, 10].includes(opcode)) { stop(1002); return; }
   if (opcode >= 8 && (!fin || n > 125)) { stop(1002); return; }
   if (n === 126) {
    if (buffer.length < 4) return;
    n = buffer.readUInt16BE(2); offset = 4;
    if (n < 126) { stop(1002); return; }
   } else if (n === 127) {
    if (buffer.length < 10) return;
    const big = buffer.readBigUInt64BE(2);
    if (big < 65536n || big > BigInt(MAX_BYTES)) { stop(big > BigInt(MAX_BYTES) ? 1009 : 1002); return; }
    n = Number(big); offset = 10;
   }
   if (n > MAX_BYTES || buffer.length > 2 * MAX_BYTES) { stop(1009); return; }
   if (buffer.length < offset + 4 + n) return;
   const mask = buffer.subarray(offset, offset + 4); offset += 4;
   const data = Buffer.from(buffer.subarray(offset, offset + n));
   buffer = buffer.subarray(offset + n);
   for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i & 3]!;
   if (opcode === 8) {
    if (n === 1) { stop(1002); return; }
    if (n >= 2) {
     const c = data.readUInt16BE(0);
     if (!([1000,1001,1002,1003,1007,1008,1009,1010,1011,1012,1013,1014].includes(c) || (c >= 3000 && c <= 4999))) { stop(1002); return; }
     try { decoder.decode(data.subarray(2)); } catch { stop(1007); return; }
    }
    stop(); return;
   }
   if (opcode === 9) { send(10, data); continue; }
   if (opcode === 10) continue;
   if ((opcode === 0 && !fragments) || (opcode !== 0 && fragments)) { stop(1002); return; }
   if (opcode === 2) { stop(1003); return; }
   parts.push(data); fragBytes += data.length;
   if (parts.length > 1024 || fragBytes > MAX_BYTES) { stop(1009); return; }
   fragments = !fin;
   if (!fin) continue;
   let text: string;
   try { text = decoder.decode(Buffer.concat(parts, fragBytes)); } catch { stop(1007); return; }
   if (Date.now() - messageWindow >= 60_000) { messageWindow = Date.now(); messageCount = 0; }
   if (++messageCount > MESSAGES_PER_MIN) { stop(1008); return; }
   parts.length = 0; queuedBytes += fragBytes; fragBytes = 0;
   queued.push(text);
   if (queued.length > 64 || queuedBytes > MAX_BYTES) { stop(1009); return; }
   void deliver();
  }
 };
 socket.on("data", (chunk: Buffer) => {
  if (closed) return;
  if (buffer.length + chunk.length > 2 * MAX_BYTES) { stop(1009); return; }
  buffer = Buffer.concat([buffer, chunk]); parse();
 });
 socket.on("close", fireClose);
 socket.on("end", fireClose);
 socket.on("error", () => { socket.destroy(); fireClose(); });
 if (buffer.length) queueMicrotask(parse);
 return {
  id: "ws-" + crypto.randomUUID(),
  send(data) { send(1, Buffer.from(typeof data === "string" ? data : JSON.stringify(data))); },
  close() { stop(); },
  onMessage(h) { handlers.push(h); void deliver(); },
  onClose(h) { if (closed) h(); else closers.push(h); },
 };
}
