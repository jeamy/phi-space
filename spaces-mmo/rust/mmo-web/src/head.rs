//! The first request's head, read before hyper sees the connection. hyper upgrades only an HTTP/1.1 request
//! (`proto/h1/role.rs`: `wants_upgrade = is_http_11`), node's http server any `Upgrade` request; nginx proxies with
//! HTTP/1.0 unless told `proxy_http_version 1.1`, so the game socket behind it closed right after its 101. An upgrade
//! request of HTTP/1.0 is handed to hyper as HTTP/1.1 (it is the connection's only request: an upgrade takes it over).
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};

/// The longest head looked at; a longer one goes to hyper as it came (hyper refuses it).
const MAX_HEAD: usize = 16 * 1024;

/// A stream with the bytes already read from it in front.
pub struct Prefixed<S> {
	pre: Vec<u8>,
	pos: usize,
	inner: S,
}

impl<S: AsyncRead + Unpin> Prefixed<S> {
	/// Reads up to the end of the first head (or EOF, or `MAX_HEAD`) and mends an HTTP/1.0 upgrade.
	pub async fn read_head(mut inner: S) -> io::Result<Self> {
		let mut pre = Vec::with_capacity(1024);
		let mut buf = [0u8; 2048];
		while pre.len() < MAX_HEAD && !pre.windows(4).any(|w| w == b"\r\n\r\n") {
			let n = inner.read(&mut buf).await?;
			if n == 0 { break; }
			pre.extend_from_slice(&buf[..n]);
		}
		mend(&mut pre);
		Ok(Self { pre, pos: 0, inner })
	}
}

/// Rewrites `HTTP/1.0` to `HTTP/1.1` on the request line of a head that carries an `Upgrade` header.
pub fn mend(pre: &mut [u8]) {
	let Some(end) = pre.windows(4).position(|w| w == b"\r\n\r\n") else { return };
	let Some(line) = pre[..end].windows(2).position(|w| w == b"\r\n") else { return };
	if !pre[..line].ends_with(b" HTTP/1.0") { return; }
	let head = String::from_utf8_lossy(&pre[line..end]).to_ascii_lowercase();
	if !head.split("\r\n").any(|h| h.starts_with("upgrade:")) { return; }
	pre[line - 1] = b'1';
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
	fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
		if self.pos < self.pre.len() {
			let n = (self.pre.len() - self.pos).min(buf.remaining());
			let from = self.pos;
			buf.put_slice(&self.pre[from..from + n]);
			self.pos += n;
			if self.pos == self.pre.len() { self.pre = Vec::new(); self.pos = 0; }
			return Poll::Ready(Ok(()));
		}
		Pin::new(&mut self.inner).poll_read(cx, buf)
	}
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
	fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> { Pin::new(&mut self.inner).poll_write(cx, buf) }
	fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> { Pin::new(&mut self.inner).poll_flush(cx) }
	fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> { Pin::new(&mut self.inner).poll_shutdown(cx) }
	fn poll_write_vectored(mut self: Pin<&mut Self>, cx: &mut Context<'_>, bufs: &[io::IoSlice<'_>]) -> Poll<io::Result<usize>> { Pin::new(&mut self.inner).poll_write_vectored(cx, bufs) }
	fn is_write_vectored(&self) -> bool { self.inner.is_write_vectored() }
}

#[cfg(test)]
mod tests {
	use super::mend;

	fn m(s: &str) -> String { let mut b = s.as_bytes().to_vec(); mend(&mut b); String::from_utf8(b).unwrap() }

	#[test]
	fn an_http_10_upgrade_becomes_11() {
		assert_eq!(m("GET /ws HTTP/1.0\r\nHost: x\r\nUpgrade: websocket\r\nConnection: upgrade\r\n\r\n"), "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: upgrade\r\n\r\n");
	}

	#[test]
	fn everything_else_stays() {
		for s in ["GET / HTTP/1.0\r\nHost: x\r\nConnection: upgrade\r\n\r\n", "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\n\r\n", "GET /ws HTTP/1.0\r\nUpgrade: websocket\r\n", "GET /x-upgrade: HTTP/1.0\r\nHost: x\r\n\r\n"] { assert_eq!(m(s), s); }
	}
}
