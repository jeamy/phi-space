//! The client side of src/socket.ts: one stream socket (unix or TCP), connected on first use and again after a loss.
//! Frame: u32 length, u32 call id (big endian), then `length` bytes of UTF-8 JSON. Calls run concurrently; the reply
//! carries the id of its call. When the connection breaks, every call waiting on it fails (RemoteSpace repeats them with
//! the same identity on a fresh connection).
use crate::{LocalFuture, Transport};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::rc::{Rc, Weak};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;

pub const HEADER: usize = 8;
/// `DEFAULT_LIMITS.maxFrameBytes` of src/core.ts.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
	Unix(PathBuf),
	Tcp { host: String, port: u16 },
}

/// One frame: header and body.
pub fn frame(id: u32, text: &str) -> Vec<u8> {
	let mut out = Vec::with_capacity(HEADER + text.len());
	out.extend_from_slice(&(text.len() as u32).to_be_bytes());
	out.extend_from_slice(&id.to_be_bytes());
	out.extend_from_slice(text.as_bytes());
	out
}

#[derive(Debug, Clone)]
pub struct SocketOptions {
	pub connect_timeout_ms: u64,
	/// A call without an answer after this long fails and its connection is dropped (the next call connects anew); a late
	/// answer is discarded. None: wait as long as the connection lives.
	pub request_timeout_ms: Option<u64>,
	pub max_frame_bytes: usize,
	/// Source address of a TCP connection (a host with several overlay or loopback addresses).
	pub local_address: Option<IpAddr>,
}

impl Default for SocketOptions {
	fn default() -> Self { SocketOptions { connect_timeout_ms: 5_000, request_timeout_ms: None, max_frame_bytes: DEFAULT_MAX_FRAME_BYTES, local_address: None } }
}

type Waiter = oneshot::Sender<Result<String, String>>;

struct Conn {
	writer: Mutex<Option<Box<dyn AsyncWrite + Unpin>>>,
	pending: RefCell<HashMap<u32, Waiter>>,
	alive: Cell<bool>,
	reader: RefCell<Option<JoinHandle<()>>>,
}

impl Conn {
	/// The connection is over: every call waiting on it fails with `why`, the socket is let go.
	fn end(&self, why: &str) {
		self.alive.set(false);
		let waiting: Vec<Waiter> = self.pending.borrow_mut().drain().map(|(_, w)| w).collect();
		for w in waiting {
			let _ = w.send(Err(why.to_owned()));
		}
		if let Some(h) = self.reader.borrow_mut().take() {
			h.abort();
		}
		if let Ok(mut w) = self.writer.try_lock() {
			*w = None;
		}
	}
}

impl Drop for Conn {
	fn drop(&mut self) {
		if let Some(h) = self.reader.get_mut().take() {
			h.abort();
		}
	}
}

async fn read_frame(r: &mut (dyn AsyncRead + Unpin), max: usize) -> Result<(u32, String), String> {
	let mut head = [0u8; HEADER];
	r.read_exact(&mut head).await.map_err(|e| if e.kind() == std::io::ErrorKind::UnexpectedEof { "connection lost".to_owned() } else { e.to_string() })?;
	let n = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
	if n > max {
		return Err(format!("frame of {n} bytes exceeds the limit of {max}"));
	}
	let id = u32::from_be_bytes([head[4], head[5], head[6], head[7]]);
	let mut body = vec![0u8; n];
	r.read_exact(&mut body).await.map_err(|e| if e.kind() == std::io::ErrorKind::UnexpectedEof { "connection lost".to_owned() } else { e.to_string() })?;
	Ok((id, String::from_utf8_lossy(&body).into_owned()))
}

async fn read_loop(mut r: Box<dyn AsyncRead + Unpin>, conn: Weak<Conn>, max: usize) {
	loop {
		let got = read_frame(&mut *r, max).await;
		let Some(c) = conn.upgrade() else { return };
		match got {
			Ok((id, text)) => {
				let waiter = c.pending.borrow_mut().remove(&id);
				if let Some(w) = waiter {
					let _ = w.send(Ok(text));
				}
			}
			Err(why) => {
				c.reader.borrow_mut().take(); // this very task: ends by returning
				c.end(&why);
				return;
			}
		}
	}
}

pub struct SocketTransport {
	target: Target,
	o: SocketOptions,
	conn: RefCell<Option<Rc<Conn>>>,
	connecting: Mutex<()>,
	closed: Cell<bool>,
	next_id: Cell<u32>,
}

type Halves = (Box<dyn AsyncRead + Unpin>, Box<dyn AsyncWrite + Unpin>);

impl SocketTransport {
	pub fn new(target: Target, o: SocketOptions) -> SocketTransport {
		SocketTransport { target, o, conn: RefCell::new(None), connecting: Mutex::new(()), closed: Cell::new(false), next_id: Cell::new(1) }
	}

	pub fn options(&self) -> &SocketOptions { &self.o }

	fn live(&self) -> Option<Rc<Conn>> { self.conn.borrow().as_ref().filter(|c| c.alive.get()).cloned() }

	async fn open(&self) -> Result<Halves, String> {
		match &self.target {
			Target::Unix(path) => {
				let s = tokio::net::UnixStream::connect(path).await.map_err(|e| e.to_string())?;
				let (r, w) = s.into_split();
				Ok((Box::new(r), Box::new(w)))
			}
			Target::Tcp { host, port } => {
				let to = tokio::net::lookup_host((host.as_str(), *port)).await.map_err(|e| e.to_string())?.next().ok_or_else(|| format!("{host}: no address"))?;
				let socket = if to.is_ipv4() { tokio::net::TcpSocket::new_v4() } else { tokio::net::TcpSocket::new_v6() }.map_err(|e| e.to_string())?;
				if let Some(from) = self.o.local_address {
					socket.bind((from, 0).into()).map_err(|e| e.to_string())?;
				}
				let s = socket.connect(to).await.map_err(|e| e.to_string())?;
				s.set_nodelay(true).map_err(|e| e.to_string())?;
				let (r, w) = s.into_split();
				Ok((Box::new(r), Box::new(w)))
			}
		}
	}

	async fn connect(&self) -> Result<Rc<Conn>, String> {
		if self.closed.get() {
			return Err("closed".to_owned());
		}
		if let Some(c) = self.live() {
			return Ok(c);
		}
		let _one = self.connecting.lock().await;
		if self.closed.get() {
			return Err("closed".to_owned());
		}
		if let Some(c) = self.live() {
			return Ok(c);
		}
		let (r, w) = match timeout(Duration::from_millis(self.o.connect_timeout_ms), self.open()).await {
			Err(_) => return Err("connect timed out".to_owned()),
			Ok(got) => got?,
		};
		let conn = Rc::new(Conn { writer: Mutex::new(Some(w)), pending: RefCell::new(HashMap::new()), alive: Cell::new(true), reader: RefCell::new(None) });
		let reader = tokio::task::spawn_local(read_loop(r, Rc::downgrade(&conn), self.o.max_frame_bytes.saturating_sub(HEADER)));
		*conn.reader.borrow_mut() = Some(reader);
		*self.conn.borrow_mut() = Some(Rc::clone(&conn));
		Ok(conn)
	}

	fn take_id(&self) -> u32 {
		let id = self.next_id.get();
		self.next_id.set(if id == u32::MAX { 1 } else { id + 1 }); // ids are 32 bits on the wire, 0 is none
		id
	}

	async fn call(&self, text: String) -> Result<String, String> {
		if text.len() + HEADER > self.o.max_frame_bytes {
			return Err("request exceeds maxFrameBytes".to_owned());
		}
		let c = self.connect().await?;
		let id = self.take_id();
		let (tx, rx) = oneshot::channel();
		c.pending.borrow_mut().insert(id, tx);
		{
			let mut w = c.writer.lock().await;
			let Some(out) = w.as_mut() else {
				c.pending.borrow_mut().remove(&id);
				return Err("connection lost".to_owned());
			};
			if let Err(e) = out.write_all(&frame(id, &text)).await {
				drop(w);
				c.pending.borrow_mut().remove(&id);
				c.end(&e.to_string());
				return Err(e.to_string());
			}
		}
		let got = match self.o.request_timeout_ms {
			None => rx.await,
			Some(ms) => match timeout(Duration::from_millis(ms), rx).await {
				Ok(got) => got,
				Err(_) => {
					let mine = c.pending.borrow_mut().remove(&id).is_some();
					if mine {
						c.end("connection lost");
					}
					return Err("request timed out".to_owned());
				}
			},
		};
		got.unwrap_or_else(|_| Err("connection lost".to_owned()))
	}

	/// Ends the connection; every waiting call fails, later ones are refused.
	pub fn close(&self) {
		self.closed.set(true);
		let c = self.conn.borrow_mut().take();
		if let Some(c) = c {
			c.end("closed");
		}
	}
}

impl Transport for SocketTransport {
	fn request(&self, text: String) -> LocalFuture<'_, Result<String, String>> { Box::pin(self.call(text)) }
}

impl<T: Transport + ?Sized> Transport for Rc<T> {
	fn request(&self, text: String) -> LocalFuture<'_, Result<String, String>> { (**self).request(text) }
}
