// The space process of the help site in Rust: what help-site/server/space-host.ts is, from the same environment and with
// the same ready line. The swarm Space of one shard (help.rs: its alias, limits, completion profile, HostInfo entry and
// the purge of the oldest posts), on phi-space-host.
mod help;

use phi_service::Service;
use phi_space_host::{env, fail, host_facts, local, make_parent, HostTask, Instance, Periodic};
use std::path::PathBuf;

/// The store of one shard and the ready line the starter waits for.
fn instances() -> (Vec<Instance>, String) {
	let file = (env("SWARM_MEM").as_deref() != Some("1")).then(|| env("SWARM_DB").map_or_else(|| local().join("swarm.sqlite"), PathBuf::from));
	if let Some(f) = &file {
		make_parent(f);
	}
	let listen = env("SWARM_LISTEN").unwrap_or_else(|| "unix:/tmp/swarm-space.sock".to_owned());
	let line = format!("[space] ready on {listen} (db {})", file.as_ref().map_or_else(|| "memory".to_owned(), |f| f.display().to_string()));
	let name_var = if env("SWARM_HOST_NAME").is_some() { "SWARM_HOST_NAME" } else { "HELP_HOST_NAME" };
	let swarm = Swarm { name_var, retention: help::retention(), every_ms: help::every_ms() };
	(vec![Instance { listen, file, peer: "peer-swarm", wake_on_commit: true, max_inflight: 1024, limits: help::limits(), locks: vec![], presence: None, compact_ms: 0, task: Some(Box::new(swarm)) }], line)
}

/// The swarm Space in its store (help.rs): prepared with the HostInfo entry, and the purge of the oldest posts.
struct Swarm {
	name_var: &'static str,
	retention: Option<help::Retention>,
	every_ms: u64,
}

impl HostTask for Swarm {
	fn prepare(&mut self, service: &mut Service) {
		let facts = host_facts(self.name_var, service.now());
		help::prepare(service, facts, self.retention.map(|r| r.cap)).unwrap_or_else(|e| fail(e.message));
	}
	fn periodic(self: Box<Self>) -> Vec<Periodic> {
		let Some(cfg) = self.retention else { return vec![] };
		vec![Periodic {
			every_ms: self.every_ms,
			run: Box::new(move |s| match help::purge(s, cfg) {
				Ok(Some(line)) => println!("{line}"),
				Ok(None) => {}
				Err(e) => eprintln!("[swarm] retention purge failed: {}", e.message),
			}),
		}]
	}
}

fn main() {
	phi_space_host::abort_on_panic();
	let (instances, line) = instances();
	phi_space_host::run(instances, line)
}
