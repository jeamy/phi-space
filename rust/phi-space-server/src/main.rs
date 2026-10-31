// The space process in Rust (docs/rust-portierung.en.md, R3): what src/standalone.ts is, on the same store file and the same
// protocol. Every connection is one peer; whoever can reach the socket uses the space.
//
//   phi-space-server --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT [--peer ID]
//   phi-space-server --profile mmo|codemode     what the project's server/space-host.ts is, from the same environment
//   phi-space-server --tls-register CONFIG.json the independent register over pinned mutual TLS (src/tls-register.ts)
//
// Prints "[phi-spaces] ready on <listen> (store <file|memory>)" once it serves; SIGINT/SIGTERM close it. A panic ends the
// process: what was acknowledged is on the disk, and a half-done commit is not left running.
mod hooks;
mod profiles;
mod register;
use register::register;

use phi_service::{Options, Service};
use phi_store::{system_random, Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, Synchronous};
use phi_wire::{serve, Listen, ServeOptions};
use std::path::Path;
use std::time::Duration;
use tokio::signal::unix::{signal, SignalKind};

const USAGE: &str = "usage: phi-space-server --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT [--peer ID] [--test-hooks CONFIG.json]\n       phi-space-server --profile mmo|codemode\n       phi-space-server --tls-register CONFIG.json";

pub(crate) fn fail(message: impl std::fmt::Display) -> ! {
	eprintln!("{message}");
	std::process::exit(1)
}

fn main() {
	std::panic::set_hook({
		let default = std::panic::take_hook();
		Box::new(move |info| {
			default(info);
			std::process::abort();
		})
	});
	let args: Vec<String> = std::env::args().collect();
	let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
	if let Some(profile) = arg("--profile") {
		return profiles::run(&profile);
	}
	if let Some(config) = arg("--tls-register") {
		return register(&config);
	}
	let (Some(store), Some(listen)) = (arg("--store"), arg("--listen")) else {
		eprintln!("{USAGE}");
		std::process::exit(2);
	};
	let peer = arg("--peer").unwrap_or_else(|| "local".to_owned());
	let listen = Listen::parse(&listen).unwrap_or_else(|e| fail(e));
	let ledger = if store == "memory" { Ledger::Memory(MemoryLedger::default()) } else { SpaceHost::sqlite(SqliteLedger::open(Path::new(&store), Synchronous::Full).unwrap_or_else(|e| fail(e))) };
	let opened = Store::open(ledger, system_random).unwrap_or_else(|e| fail(e));
	let mut options = Options::single_peer(&peer);
	let mut serving = ServeOptions::new(listen, &peer);
	let limits = arg("--test-hooks").map(|config| hooks::apply(&config, &mut options, &mut serving).unwrap_or_else(|e| fail(e)));
	let mut service = Service::new(opened, options);
	service.start_background().unwrap_or_else(|e| fail(e.message));
	if let Some(Some(limits)) = limits {
		service.set_limits(&limits).unwrap_or_else(|e| fail(e.message));
	}
	service.store.drain().unwrap_or_else(|e| fail(e));

	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap_or_else(|e| fail(e));
	let served = runtime.block_on(async {
		let mut term = signal(SignalKind::terminate()).unwrap_or_else(|e| fail(e));
		let mut int = signal(SignalKind::interrupt()).unwrap_or_else(|e| fail(e));
		let stop = async move {
			tokio::select! {
				_ = term.recv() => {}
				_ = int.recv() => {}
			}
			// what closing does not finish in this time is not waited for
			std::thread::spawn(|| {
				std::thread::sleep(Duration::from_secs(3));
				std::process::exit(0);
			});
		};
		let ready = |address: Vec<String>| println!("[phi-spaces] ready on {} (store {store})", address[0]);
		serve(service, serving, ready, stop).await
	});
	match served {
		Ok(service) => service.store.close(),
		Err(e) => fail(e),
	}
}
