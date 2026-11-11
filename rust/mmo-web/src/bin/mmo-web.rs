//! `mmo-web`: the web process of spaces-mmo in Rust (R8.5), a stand-in for `server/index.ts` with its environment
//! (PORT, SPACES_MMO_BIND, SPACES_MMO_SPACE, SPACES_MMO_ACCOUNTS, SPACES_MMO_REGIONS, SPACES_MMO_NO_NEXT,
//! SPACES_MMO_PAGES, SPACES_MMO_BUILD_ID, …). Run from spaces-mmo/ (the worlds, out/ and .env are read from there;
//! SPACES_MMO_ROOT names another folder). Says `[web] spaces-mmo listening on …` once it listens; ends on SIGTERM or
//! SIGINT.
use std::path::PathBuf;
use std::time::Duration;

use mmo_engine::world_host::load_dot_env;
use mmo_web::run_web;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::watch;

fn main() {
	if std::env::args().any(|a| a == "--dev") { eprintln!("[web] --dev (Next's dev server) is the TypeScript web process's; mmo-web serves the export"); std::process::exit(2); }
	let root = std::env::var("SPACES_MMO_ROOT").map(PathBuf::from).unwrap_or_else(|_| std::env::current_dir().expect("the working folder"));
	load_dot_env(&root);
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("the runtime");
	let local = tokio::task::LocalSet::new();
	let code = local.block_on(&rt, async move {
		let (stop, halt) = watch::channel(false);
		let mut term = signal(SignalKind::terminate()).expect("SIGTERM");
		let mut int = signal(SignalKind::interrupt()).expect("SIGINT");
		tokio::task::spawn_local(async move {
			tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
			let _ = stop.send(true);
			tokio::time::sleep(Duration::from_secs(3)).await;
			std::process::exit(0);
		});
		let public = std::env::var("SPACES_MMO_PUBLIC_URL").ok().filter(|s| !s.is_empty());
		let ready = move |url: &str| {
			match public.filter(|p| p != url) { Some(p) => println!("[web] spaces-mmo listening on {url} (in the container; open {p})"), None => println!("[web] spaces-mmo listening on {url}") }
		};
		match run_web(root, ready, halt).await {
			Ok(()) => 0,
			Err(e) => { eprintln!("[web] {e}"); 1 }
		}
	});
	std::process::exit(code);
}
