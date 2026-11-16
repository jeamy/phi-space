//! The bounded RFC-6455 text gateway (`src/ws.ts`, `phi-spaces/ws`): client frames are masked, messages are handled in
//! order, a connection that sends more than `max_per_min` text messages in a minute is closed (1008); 1 MiB per message,
//! 64 messages or 1 MiB waiting, 2 MiB unsent.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use hyper::upgrade::Upgraded;
use hyper_util::rt::TokioIo;
use phi_json::Json;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const MAX_BYTES: usize = 1_048_576;

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn base64(b: &[u8]) -> String {
	let mut s = String::new();
	for c in b.chunks(3) {
		let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
		for i in 0..4 { if i <= c.len() { s.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char); } else { s.push('='); } }
	}
	s
}
fn unbase64_len(s: &str) -> Option<usize> {
	let body = s.trim_end_matches('=');
	if !body.bytes().all(|b| B64.contains(&b)) { return None; }
	Some(body.len() * 6 / 8)
}

/// The accept value of a valid upgrade request, or None (the socket is then destroyed).
pub fn accept_of(method: &hyper::Method, h: &hyper::HeaderMap) -> Option<String> {
	let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("");
	let key = get("sec-websocket-key");
	let key_ok = key.len() == 24 && key.ends_with("==") && key[..22].bytes().all(|b| B64.contains(&b)) && unbase64_len(key) == Some(16);
	if method != hyper::Method::GET || get("sec-websocket-version") != "13" || get("upgrade").to_lowercase() != "websocket"
		|| !get("connection").to_lowercase().split(',').any(|x| x.trim() == "upgrade") || !key_ok { return None; }
	let mut s = Sha1::new();
	s.update(key.as_bytes());
	s.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
	Some(base64(&s.finalize()))
}

fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
	let n = payload.len();
	let mut h = vec![0x80 | opcode];
	if n < 126 { h.push(n as u8); } else if n < 65536 { h.push(126); h.extend_from_slice(&(n as u16).to_be_bytes()); } else { h.push(127); h.extend_from_slice(&(n as u64).to_be_bytes()); }
	h.extend_from_slice(payload);
	h
}

enum Out { Frame(Vec<u8>), End(Vec<u8>), Destroy }

/// One game socket.
pub struct WsConn {
	pub id: String,
	out: mpsc::UnboundedSender<Out>,
	unsent: Rc<Cell<usize>>,
	closed: Cell<bool>,
	closers: RefCell<Vec<Box<dyn FnOnce()>>>,
}

impl WsConn {
	pub fn is_closed(&self) -> bool { self.closed.get() }
	fn fire_close(&self) {
		if self.closed.replace(true) { return; }
		let hs: Vec<Box<dyn FnOnce()>> = self.closers.borrow_mut().drain(..).collect();
		for h in hs { h(); }
	}
	fn stop(&self, code: u16) {
		if self.closed.get() { return; }
		let _ = self.out.send(Out::End(frame(8, &code.to_be_bytes())));
		self.fire_close();
	}
	fn send_frame(&self, opcode: u8, data: &[u8]) {
		if self.closed.get() { return; }
		if data.len() > MAX_BYTES || self.unsent.get() + data.len() > 2 * MAX_BYTES { let _ = self.out.send(Out::Destroy); self.fire_close(); return; }
		let f = frame(opcode, data);
		self.unsent.set(self.unsent.get() + f.len());
		let _ = self.out.send(Out::Frame(f));
	}
	/// Sends a pre-serialized JSON text message.
	pub fn send_text(&self, text: &str) { self.send_frame(1, text.as_bytes()); }
	/// Sends a JSON value as a text message.
	pub fn send(&self, v: &Json) { self.send_text(&v.to_json_text()); }
	pub fn close(&self) { self.stop(1000); }
	pub fn on_close(&self, h: Box<dyn FnOnce()>) { if self.closed.get() { h(); } else { self.closers.borrow_mut().push(h); } }
}

/// Starts the socket on an upgraded connection: the connection and the queue of its text messages (in order). `waiting`
/// counts what the handler has not taken yet, so the queue's bounds hold.
/// What the handler has not taken yet: messages and bytes.
pub type Waiting = Rc<Cell<(usize, usize)>>;

pub fn start(io: Upgraded, max_per_min: u32) -> (Rc<WsConn>, mpsc::UnboundedReceiver<String>, Waiting) {
	let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
	let unsent = Rc::new(Cell::new(0usize));
	let conn = Rc::new(WsConn { id: format!("ws-{}", uuid()), out: tx, unsent: unsent.clone(), closed: Cell::new(false), closers: RefCell::default() });
	let (inbox, messages) = mpsc::unbounded_channel::<String>();
	let waiting = Rc::new(Cell::new((0usize, 0usize)));
	let (mut rd, mut wr) = tokio::io::split(TokioIo::new(io));
	// the writer: frames in order, the close frame ends the socket
	{
		let conn = conn.clone();
		tokio::task::spawn_local(async move {
			while let Some(o) = rx.recv().await {
				match o {
					Out::Frame(f) => { let n = f.len(); let ok = wr.write_all(&f).await.is_ok(); unsent.set(unsent.get().saturating_sub(n)); if !ok { conn.fire_close(); break; } }
					Out::End(f) => { let _ = wr.write_all(&f).await; let _ = wr.shutdown().await; break; }
					Out::Destroy => break,
				}
			}
		});
	}
	// the reader
	{
		let conn = conn.clone();
		let waiting = waiting.clone();
		tokio::task::spawn_local(async move {
			let mut buffer: Vec<u8> = Vec::new();
			let mut parts: Vec<u8> = Vec::new();
			let (mut fragments, mut nparts) = (false, 0usize);
			let (mut window, mut count) = (mmo_engine::source::time_now(), 0u32);
			let mut chunk = vec![0u8; 64 * 1024];
			'read: loop {
				let n = match rd.read(&mut chunk).await { Ok(0) | Err(_) => { conn.fire_close(); break; } Ok(n) => n };
				if conn.closed.get() { break; }
				if buffer.len() + n > 2 * MAX_BYTES { conn.stop(1009); break; }
				buffer.extend_from_slice(&chunk[..n]);
				while !conn.closed.get() && buffer.len() >= 2 {
					let (b0, b1) = (buffer[0], buffer[1]);
					let (opcode, fin) = (b0 & 15, b0 & 128 != 0);
					let mut len = (b1 & 127) as usize;
					let mut offset = 2;
					if b0 & 112 != 0 || b1 & 128 == 0 || ![0, 1, 2, 8, 9, 10].contains(&opcode) { conn.stop(1002); break 'read; }
					if opcode >= 8 && (!fin || len > 125) { conn.stop(1002); break 'read; }
					if len == 126 {
						if buffer.len() < 4 { break; }
						len = u16::from_be_bytes([buffer[2], buffer[3]]) as usize; offset = 4;
						if len < 126 { conn.stop(1002); break 'read; }
					} else if len == 127 {
						if buffer.len() < 10 { break; }
						let big = u64::from_be_bytes(buffer[2..10].try_into().expect("8 bytes"));
						if big < 65536 || big > MAX_BYTES as u64 { conn.stop(if big > MAX_BYTES as u64 { 1009 } else { 1002 }); break 'read; }
						len = big as usize; offset = 10;
					}
					if len > MAX_BYTES || buffer.len() > 2 * MAX_BYTES { conn.stop(1009); break 'read; }
					if buffer.len() < offset + 4 + len { break; }
					let mask = [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
					offset += 4;
					let mut data: Vec<u8> = buffer[offset..offset + len].to_vec();
					buffer.drain(..offset + len);
					for (i, d) in data.iter_mut().enumerate() { *d ^= mask[i & 3]; }
					if opcode == 8 {
						if len == 1 { conn.stop(1002); break 'read; }
						if len >= 2 {
							let c = u16::from_be_bytes([data[0], data[1]]);
							if !([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].contains(&c) || (3000..=4999).contains(&c)) { conn.stop(1002); break 'read; }
							if std::str::from_utf8(&data[2..]).is_err() { conn.stop(1007); break 'read; }
						}
						conn.stop(1000); break 'read;
					}
					if opcode == 9 { conn.send_frame(10, &data); continue; }
					if opcode == 10 { continue; }
					if (opcode == 0 && !fragments) || (opcode != 0 && fragments) { conn.stop(1002); break 'read; }
					if opcode == 2 { conn.stop(1003); break 'read; }
					parts.extend_from_slice(&data); nparts += 1;
					if nparts > 1024 || parts.len() > MAX_BYTES { conn.stop(1009); break 'read; }
					fragments = !fin;
					if !fin { continue; }
					let Ok(text) = String::from_utf8(std::mem::take(&mut parts)) else { conn.stop(1007); break 'read };
					nparts = 0;
					let now = mmo_engine::source::time_now();
					if now - window >= 60_000.0 { window = now; count = 0; }
					count += 1;
					if count > max_per_min { conn.stop(1008); break 'read; }
					let (q, bytes) = waiting.get();
					waiting.set((q + 1, bytes + text.len()));
					if q + 1 > 64 || bytes + text.len() > MAX_BYTES { conn.stop(1009); break 'read; }
					let _ = inbox.send(text);
				}
			}
		});
	}
	(conn, messages, waiting)
}

fn uuid() -> String {
	let mut b = mmo_engine::source::random_bytes(16);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	let h = mmo_engine::source::hex(&b);
	format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
	#[test]
	fn accept_key() {
		// RFC 6455's example
		let mut h = hyper::HeaderMap::new();
		h.insert("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==".parse().unwrap());
		h.insert("sec-websocket-version", "13".parse().unwrap());
		h.insert("upgrade", "websocket".parse().unwrap());
		h.insert("connection", "keep-alive, Upgrade".parse().unwrap());
		assert_eq!(super::accept_of(&hyper::Method::GET, &h).as_deref(), Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
	}
}
