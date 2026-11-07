//! A frame server for a handler of texts (`serveSpace` with a `handleText` of its own, src/socket.ts): the private
//! recovery endpoint and its like. The same frames as the space service; limits on the frame, the connections and the
//! calls in flight per connection, an idle timeout; a frame over the limit ends the connection.
use crate::{put, Bound, Listen, HEADER};
use std::cell::Cell;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::rc::Rc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::spawn_local;

/// What a handler answers a request text with.
pub type TextHandle = Rc<dyn Fn(String) -> Pin<Box<dyn Future<Output = String>>>>;

pub struct TextServe {
	pub listen: Listen,
	pub max_frame_bytes: usize,
	pub max_connections: usize,
	pub max_inflight: usize,
	pub idle_ms: u64,
}

/// A text server that runs on the current `LocalSet` until closed (or dropped); its socket file goes with it.
pub struct TextServer {
	task: tokio::task::JoinHandle<()>,
	bound: Rc<Bound>,
	address: String,
}
impl TextServer {
	pub fn address(&self) -> &str { &self.address }
}
impl Drop for TextServer {
	fn drop(&mut self) {
		self.task.abort();
		self.bound.close();
	}
}

/// Binds `o.listen` (a socket file of a dead server is replaced, the file is the owner's only) and serves `handle`.
pub async fn serve_texts(o: TextServe, handle: TextHandle) -> io::Result<TextServer> {
	let bound = Rc::new(Bound::bind(&o.listen).await?);
	let address = bound.address();
	let open = Rc::new(Cell::new(0usize));
	let limits = Rc::new((o.max_frame_bytes, o.max_inflight, o.idle_ms));
	let b = Rc::clone(&bound);
	let task = spawn_local(async move {
		loop {
			let accepted: io::Result<(Box<dyn AsyncRead + Unpin>, Box<dyn AsyncWrite + Unpin>)> = match &*b {
				Bound::Unix(l, ..) => l.accept().await.map(|(s, _)| {
					let (r, w) = s.into_split();
					(Box::new(r) as Box<dyn AsyncRead + Unpin>, Box::new(w) as Box<dyn AsyncWrite + Unpin>)
				}),
				Bound::Tcp(l, _) => l.accept().await.map(|(s, _)| {
					let _ = s.set_nodelay(true);
					let (r, w) = s.into_split();
					(Box::new(r) as Box<dyn AsyncRead + Unpin>, Box::new(w) as Box<dyn AsyncWrite + Unpin>)
				}),
			};
			let Ok((read, write)) = accepted else {
				tokio::time::sleep(Duration::from_millis(crate::ACCEPT_PAUSE_MS)).await;
				continue;
			};
			if open.get() >= o.max_connections {
				continue; // dropped: closed unanswered
			}
			open.set(open.get() + 1);
			let (open, handle, limits) = (Rc::clone(&open), Rc::clone(&handle), Rc::clone(&limits));
			spawn_local(async move {
				connection(read, write, handle, *limits).await;
				open.set(open.get() - 1);
			});
		}
	});
	Ok(TextServer { task, bound, address })
}

async fn connection(mut read: Box<dyn AsyncRead + Unpin>, mut write: Box<dyn AsyncWrite + Unpin>, handle: TextHandle, (max_frame, max_inflight, idle_ms): (usize, usize, u64)) {
	let (tx, mut rx) = mpsc::unbounded_channel::<(u32, String)>();
	let writer = spawn_local(async move {
		while let Some((id, text)) = rx.recv().await {
			let mut out = Vec::new();
			put(&mut out, id, &text);
			if write.write_all(&out).await.is_err() {
				return;
			}
		}
	});
	let inflight = Rc::new(Cell::new(0usize));
	loop {
		let mut head = [0u8; HEADER];
		let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(idle_ms), read.read_exact(&mut head)).await else { break };
		let n = u32::from_be_bytes(head[..4].try_into().expect("four bytes")) as usize;
		let id = u32::from_be_bytes(head[4..].try_into().expect("four bytes"));
		if n + HEADER > max_frame {
			break; // a frame over the limit: a protocol violation
		}
		let mut body = vec![0u8; n];
		let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(idle_ms), read.read_exact(&mut body)).await else { break };
		if inflight.get() >= max_inflight {
			let _ = tx.send((id, format!(r#"{{"ok":false,"error":{{"code":"ResourceExhausted","message":"at most {max_inflight} calls at once per connection"}}}}"#)));
			continue;
		}
		inflight.set(inflight.get() + 1);
		let (tx, handle, inflight) = (tx.clone(), Rc::clone(&handle), Rc::clone(&inflight));
		spawn_local(async move {
			let answer = handle(String::from_utf8_lossy(&body).into_owned()).await;
			let _ = tx.send((id, answer));
			inflight.set(inflight.get() - 1);
		});
	}
	writer.abort();
}
