// The space process in Rust (docs/rust-portierung.md, R3): what src/standalone.ts is, on the same store file and the same
// protocol. Every connection is one peer; whoever can reach the socket uses the space.
//
//   phi-space-server --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT [--peer ID]
//
// Prints "[phi-spaces] ready on <listen> (store <file|memory>)" once it serves; SIGINT/SIGTERM close it. A panic ends the
// process: what was acknowledged is on the disk, and a half-done commit is not left running.
use phi_service::{Options, Service};
use phi_store::{system_random, Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, Synchronous};
use phi_wire::{serve, Listen, ServeOptions};
use std::path::Path;
use std::time::Duration;
use tokio::signal::unix::{signal, SignalKind};

const USAGE: &str = "usage: phi-space-server --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT [--peer ID]";

fn fail(message: impl std::fmt::Display) -> ! {
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
	let (Some(store), Some(listen)) = (arg("--store"), arg("--listen")) else {
		eprintln!("{USAGE}");
		std::process::exit(2);
	};
	let peer = arg("--peer").unwrap_or_else(|| "local".to_owned());
	let listen = Listen::parse(&listen).unwrap_or_else(|e| fail(e));
	let ledger = if store == "memory" { Ledger::Memory(MemoryLedger::default()) } else { SpaceHost::sqlite(SqliteLedger::open(Path::new(&store), Synchronous::Full).unwrap_or_else(|e| fail(e))) };
	let opened = Store::open(ledger, system_random).unwrap_or_else(|e| fail(e));
	let mut service = Service::new(opened, Options::single_peer(&peer));
	service.start_background().unwrap_or_else(|e| fail(e.message));

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
		let ready = |address: String| println!("[phi-spaces] ready on {address} (store {store})");
		serve(service, ServeOptions::new(listen, &peer), ready, stop).await
	});
	match served {
		Ok(service) => service.store.close(),
		Err(e) => fail(e),
	}
}
