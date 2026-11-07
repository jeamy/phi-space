//! The client of the space service (docs/rust-portierung.en.md, R8.1): `RemoteSpace` of src/remote.ts over a
//! [`Transport`], the socket transport of src/socket.ts and the helpers of src/space-client.ts. It keeps the request
//! identity and the arguments of a call until the call is decided, repeats lost transport attempts with the same identity
//! and polls the same operation for blocking calls; a transport failure is never an outcome.
//!
//! Everything here lives on one thread (`Rc`, tokio `current_thread`); the socket transport spawns its reader with
//! `spawn_local`, so it runs inside a `tokio::task::LocalSet`, as the servers of this workspace do.
mod error;
mod helpers;
mod remote;
mod socket;

pub use error::{Error, RequestRef};
pub use helpers::{await_work, connect_space, cut_text, keep_alive, parse_target, peek, read_existing, take_all, take_existing, ConnectOptions, KeepAlive};
pub use remote::{lease_arg, Counters, Opts, Options, RemoteSpace, ANY, FOREVER, NO_WAIT, PROTOCOL_VERSION};
pub use socket::{frame, SocketOptions, SocketTransport, Target, DEFAULT_MAX_FRAME_BYTES, HEADER};

use std::future::Future;
use std::pin::Pin;

/// A future of this thread.
pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// One round trip: the encoded call out, the encoded reply back. It may fail or hang; the caller decides what that means.
pub trait Transport {
	fn request(&self, text: String) -> LocalFuture<'_, Result<String, String>>;
}
