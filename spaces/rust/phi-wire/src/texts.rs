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
	// The answers that wait to be written, counted and weighed as the space service's are (lib.rs): a client that sends
	// and never reads would else pile them up without end. Over the limit the connection ends.
	let held = Rc::new(Cell::new((0usize, 0usize)));
	let over = Rc::new(tokio::sync::Notify::new());
	let answer: Rc<dyn Fn(u32, String)> = {
		let (held, over) = (Rc::clone(&held), Rc::clone(&over));
		Rc::new(move |id, text: String| {
			let (replies, bytes) = held.get();
			let more = text.len().saturating_add(HEADER);
			if replies >= crate::MAX_HELD_REPLIES || more > crate::MAX_HELD_REPLY_BYTES.saturating_sub(bytes) {
				over.notify_one();
				return;
			}
			held.set((replies + 1, bytes + more));
			let _ = tx.send((id, text));
		})
	};
	let writer = {
		let held = Rc::clone(&held);
		spawn_local(async move {
			while let Some((id, text)) = rx.recv().await {
				let mut out = Vec::new();
				put(&mut out, id, &text);
				if write.write_all(&out).await.is_err() {
					return;
				}
				let (replies, bytes) = held.get();
				held.set((replies.saturating_sub(1), bytes.saturating_sub(out.len())));
			}
		})
	};
	let inflight = Rc::new(Cell::new(0usize));
	let frames = async {
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
				answer(id, format!(r#"{{"ok":false,"error":{{"code":"ResourceExhausted","message":"at most {max_inflight} calls at once per connection"}}}}"#));
				continue;
			}
			inflight.set(inflight.get() + 1);
			let (answer, handle, inflight) = (Rc::clone(&answer), Rc::clone(&handle), Rc::clone(&inflight));
			spawn_local(async move {
				let text = handle(String::from_utf8_lossy(&body).into_owned()).await;
				answer(id, text);
				inflight.set(inflight.get() - 1);
			});
		}
	};
	tokio::select! { () = frames => {}, () = over.notified() => {} }
	writer.abort();
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A client that sends and never reads: the answers that wait are bounded, and the connection ends at the bound.
	#[tokio::test(flavor = "current_thread")]
	async fn a_client_that_never_reads_is_cut_off() {
		tokio::task::LocalSet::new()
			.run_until(async {
				let (mut to_server, server_read) = tokio::io::duplex(1 << 20);
				// the server's side of the answers holds 64 bytes: the writer stands after the first answer
				let (server_write, _never_read) = tokio::io::duplex(64);
				let handle: TextHandle = Rc::new(|_| Box::pin(async { String::new() }));
				// no call may run: every frame is answered at once as ResourceExhausted
				let served = spawn_local(connection(Box::new(server_read), Box::new(server_write), handle, (1024, 0, 60_000)));
				let mut frame = Vec::new();
				put(&mut frame, 1, "{}");
				for _ in 0..crate::MAX_HELD_REPLIES + 8 {
					to_server.write_all(&frame).await.expect("the frames fit the pipe");
				}
				tokio::time::timeout(Duration::from_secs(5), served).await.expect("the connection ends at the bound").expect("served");
			})
			.await;
	}
}
