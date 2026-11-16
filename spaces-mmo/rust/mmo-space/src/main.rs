// The space process of spaces-mmo in Rust: what spaces-mmo/server/space-host.ts is, from the same environment and with the
// same ready line. The world store of a region (`SPACES_MMO_REGION`) and the accounts store, each on its own socket with its
// locks and the Process entry, on phi-space-host.
use phi_json::{obj, Json};
use phi_space_host::{env, fail, local, Instance, MIB};
use std::path::PathBuf;

fn positive(name: &str, fallback: f64) -> f64 { env(name).and_then(|v| v.parse().ok()).filter(|n: &f64| *n > 0.0).unwrap_or(fallback) }

/// The stores `SPACES_MMO_SPACES` names (world, accounts or both) and the ready line the starter waits for.
fn instances() -> (Vec<Instance>, String) {
	let mem = env("SPACES_MMO_MEM").as_deref() == Some("1");
	let data = (!mem).then(|| env("SPACES_MMO_DATA").map_or_else(local, PathBuf::from));
	let region = env("SPACES_MMO_REGION");
	let serves = env("SPACES_MMO_SPACES").unwrap_or_else(|| "world,accounts".to_owned());
	let list: Vec<&str> = serves.split(',').map(str::trim).filter(|x| !x.is_empty()).collect();
	if list.is_empty() || list.iter().any(|x| !matches!(*x, "world" | "accounts")) {
		fail(format!("SPACES_MMO_SPACES is world, accounts or both, not {serves}"));
	}
	if let Some(d) = &data {
		std::fs::create_dir_all(d).unwrap_or_else(|e| fail(format!("{}: {e}", d.display())));
	}
	let claim_result = positive("SPACES_MMO_CLAIM_RESULT_MS", 600_000.0);
	let limits = || {
		let mut l = obj! { "maxTxnsPerOwner" => 1000.0, "maxWaitersPerOwner" => 1000.0, "maxRegsPerOwner" => 1000.0, "claimResultMs" => claim_result, "generationAdmitMs" => claim_result, "maxLogBytes" => positive("SPACES_MMO_LOG_BYTES", 512.0 * 1024.0) };
		if let (Json::Object(o), true) = (&mut l, data.is_some()) {
			o.insert("maxClaimBytes", Json::Number(512.0 * MIB));
			o.insert("maxDocBytes", Json::Number(640.0 * MIB));
		}
		l
	};
	let compact_ms = std::env::var("SPACES_MMO_COMPACT_MS").map_or(600_000, |v| v.trim().parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0).map_or(0, |n| n as u64)); // empty or no number: off, as Number()
	let world_listen = env("SPACES_MMO_LISTEN").unwrap_or_else(|| "unix:/tmp/spaces-mmo-world.sock".to_owned());
	let accounts_listen = env("SPACES_MMO_ACCOUNTS_LISTEN").unwrap_or_else(|| "unix:/tmp/spaces-mmo-accounts.sock".to_owned());
	let (world, accounts) = (list.contains(&"world"), list.contains(&"accounts"));
	let mut all = vec![];
	if world {
		let name = region.map_or_else(|| "world.sqlite".to_owned(), |r| format!("world-{r}.sqlite"));
		all.push(Instance { listen: world_listen.clone(), file: data.as_ref().map(|d| d.join(name)), peer: "peer-mmo-world", wake_on_commit: true, max_inflight: 1024, limits: limits(), locks: vec!["world", "npc"], presence: Some("SPACES_MMO_HOST_NAME"), compact_ms, task: None });
	}
	if accounts {
		all.push(Instance { listen: accounts_listen.clone(), file: data.as_ref().map(|d| d.join("accounts.sqlite")), peer: "peer-mmo-web", wake_on_commit: true, max_inflight: 1024, limits: limits(), locks: vec!["names"], presence: (!world).then_some("SPACES_MMO_HOST_NAME"), compact_ms, task: None });
	}
	let shown = |served: bool, l: &str| if served { l.to_owned() } else { "-".to_owned() };
	let line = format!("[space] ready: world on {}, accounts on {} ({})", shown(world, &world_listen), shown(accounts, &accounts_listen), data.as_ref().map_or_else(|| "memory".to_owned(), |d| d.display().to_string()));
	(all, line)
}

fn main() {
	phi_space_host::abort_on_panic();
	let (instances, line) = instances();
	phi_space_host::run(instances, line)
}
