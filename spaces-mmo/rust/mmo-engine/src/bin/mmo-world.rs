//! `mmo-world`: the world worker of spaces-mmo in Rust (R8.3), a stand-in for `server/world-host.ts` with its
//! environment (SPACES_MMO_SPACE, SPACES_MMO_WORLD, SPACES_MMO_REGION, SPACES_MMO_REGIONS, …). Run from spaces-mmo/
//! (the worlds and .env are read from there; SPACES_MMO_ROOT names another folder). Says `[world] ready (…)` once it
//! serves, ends on SIGTERM or SIGINT after the running commands.
use std::path::PathBuf;
use std::time::Duration;

use mmo_engine::world_host::{load_dot_env, run_world, HostOptions};
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::watch;

fn main() {
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
			// what does not end in 3 s is cut off, as the TypeScript process does
			tokio::time::sleep(Duration::from_secs(3)).await;
			std::process::exit(0);
		});
		// started together with the space: wait for its socket, or for a job of a killed process that pins the terrain
		for tries in 0.. {
			let o = HostOptions::from_env(root.clone());
			let label = format!("{}{}", o.world, if o.region.is_empty() { String::new() } else { format!(", region {}", o.region) });
			match run_world(o, || println!("[world] ready ({label})"), halt.clone()).await {
				Ok(()) => return 0,
				Err(e) => {
					let text = e.to_string();
					let locked = text.contains("world lock stayed taken");
					let unreachable = ["ENOENT", "ECONNREFUSED", "No such file", "Connection refused", "connect"].iter().any(|w| text.contains(w));
					if *halt.borrow() { return 0; }
					if tries >= 30 || !(locked || unreachable) { eprintln!("[world] {text}"); return 1; }
					if tries == 0 { println!("[world] waiting for the {} …", if locked { "world lock" } else { "space" }); }
					tokio::time::sleep(Duration::from_secs(1)).await;
				}
			}
		}
		0
	});
	std::process::exit(code);
}
