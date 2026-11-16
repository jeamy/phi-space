// The space process of codemode-chat in Rust: what codemode-chat/server/space-host.ts is, from the same environment and
// with the same ready line. One store with the capacities of `persistentSpaceLimits` and the Process entry, on
// phi-space-host.
use phi_json::{obj, Json, FOREVER};
use phi_space_host::{env, fail, local, make_parent, Instance, MIB};
use std::path::PathBuf;

/// `persistentSpaceLimits`.
fn codemode_capacity() -> Result<(f64, f64), String> {
	let bytes = |name: &str, fallback: f64| -> Result<f64, String> {
		let value = match std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
			Some(raw) => raw.parse::<f64>().unwrap_or(f64::NAN),
			None => fallback,
		};
		if !(value >= 1.0 && value.trunc() == value && value * MIB <= FOREVER) {
			return Err(format!("{name} must be a positive safe integer in MiB"));
		}
		Ok(value * MIB)
	};
	let (claim, doc) = (bytes("CODEMODE_MAX_CLAIM_MIB", 1024.0)?, bytes("CODEMODE_MAX_DOC_MIB", 1280.0)?);
	if doc <= claim {
		return Err("CODEMODE_MAX_DOC_MIB must exceed CODEMODE_MAX_CLAIM_MIB".to_owned());
	}
	Ok((claim, doc))
}

/// The one store and the ready line the starter waits for.
fn instances() -> (Vec<Instance>, String) {
	let mem = env("CODEMODE_MEM").as_deref() == Some("1");
	let file = (!mem).then(|| env("CODEMODE_SQLITE").map_or_else(|| local().join("codemode-space.sqlite"), PathBuf::from));
	let mut limits = obj! { "maxTxnsPerOwner" => 1000.0, "maxWaitersPerOwner" => 1000.0, "maxRegsPerOwner" => 1000.0 };
	if let Some(f) = &file {
		let (claim, doc) = codemode_capacity().unwrap_or_else(|e| fail(e));
		if let Json::Object(o) = &mut limits {
			o.insert("maxClaimBytes", Json::Number(claim));
			o.insert("maxDocBytes", Json::Number(doc));
		}
		make_parent(f);
	}
	let listen = env("CODEMODE_LISTEN").unwrap_or_else(|| "unix:/tmp/codemode-space.sock".to_owned());
	let line = format!("[space] ready on {listen} (db {})", file.as_ref().map_or_else(|| "memory".to_owned(), |f| f.display().to_string()));
	(vec![Instance { listen, file, peer: "peer-codemode", wake_on_commit: false, max_inflight: 32, limits, locks: vec![], presence: Some("CODEMODE_HOST_NAME"), compact_ms: 0, task: None }], line)
}

fn main() {
	phi_space_host::abort_on_panic();
	let (instances, line) = instances();
	phi_space_host::run(instances, line)
}
