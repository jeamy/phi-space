//! `mmo-npc`: the npc process of spaces-mmo in Rust (R8.4), a stand-in for `server/npc-host.ts` with its environment
//! (SPACES_MMO_SPACE, SPACES_MMO_WORLD, SPACES_MMO_NPCS, SPACES_MMO_REGION, SPACES_MMO_NPC_ROLE_LEASE_MS, …). Run from
//! spaces-mmo/ (the worlds and .env are read from there; SPACES_MMO_ROOT names another folder). Says `[npc] ready` once
//! every role has its session or found another process playing it; ends on SIGTERM or SIGINT.
use std::path::PathBuf;
use std::time::Duration;

use mmo_engine::npc::host::run_npcs;
use mmo_engine::world_host::load_dot_env;
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
			tokio::time::sleep(Duration::from_secs(3)).await;
			std::process::exit(0);
		});
		match run_npcs(root, || println!("[npc] ready"), halt).await {
			Ok(()) => 0,
			Err(e) => { eprintln!("[npc] {e}"); 1 }
		}
	});
	std::process::exit(code);
}
