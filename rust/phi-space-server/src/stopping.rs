//! What all modes of the server share around their serve loop.
use std::future::Future;
use std::time::Duration;
use tokio::runtime::{Builder, Runtime};
use tokio::signal::unix::{signal, SignalKind};

pub fn runtime() -> Runtime { Builder::new_current_thread().enable_all().build().unwrap_or_else(|e| crate::fail(e)) }

/// SIGTERM or SIGINT. The handlers stand from this call on, so a signal right after the ready line is not lost.
pub fn signalled() -> impl Future<Output = ()> {
	let mut term = signal(SignalKind::terminate()).unwrap_or_else(|e| crate::fail(e));
	let mut int = signal(SignalKind::interrupt()).unwrap_or_else(|e| crate::fail(e));
	async move {
		tokio::select! {
			_ = term.recv() => {}
			_ = int.recv() => {}
		}
	}
}

/// What closing does not finish in this time is not waited for.
pub fn limit_closing() {
	std::thread::spawn(|| {
		std::thread::sleep(Duration::from_secs(3));
		std::process::exit(0);
	});
}

/// `signalled`, then the limit on closing: the `stop` of `serve`.
pub fn stop() -> impl Future<Output = ()> {
	let signal = signalled();
	async move {
		signal.await;
		limit_closing();
	}
}
