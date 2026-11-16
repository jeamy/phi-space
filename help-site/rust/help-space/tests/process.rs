// The binary as a process: the swarm Space by its alias with its HostInfo entry, and the purge above the cap.
use phi_json::obj;
use phi_space_host::testing::{dir as tmp, items_in, start, stored_limits, Running};
use phi_store::{system_random, SpaceHost, SqliteLedger, Store, Synchronous};
use std::path::{Path, PathBuf};

const BIN: &str = env!("CARGO_BIN_EXE_help-space");
const ALIAS: &str = "social-swarm";

fn dir(name: &str) -> PathBuf { tmp(env!("CARGO_TARGET_TMPDIR"), name) }
fn serve(env: &[(&str, &str)]) -> (Running, String) { start(BIN, &[], env) }
fn now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64 }

/// Entries written into the swarm Space of a store file whose server has ended, as host commits.
fn write_into(file: &Path, entries: &[phi_json::Json]) {
	let mut store = Store::open(SpaceHost::sqlite(SqliteLedger::open(file, Synchronous::Full).unwrap()), system_random).unwrap();
	let at = now();
	store.commit(Some(ALIAS), at, |s| {
		for e in entries {
			s.write(at, e, None, Some(&phi_json::FOREVER.into()), None)?;
		}
		Ok(())
	}).unwrap().unwrap();
	store.close();
}

#[test]
fn it_serves_the_swarm_space_with_its_host_info() {
	let d = dir("help");
	let (path, file) = (d.join("s.sock"), d.join("data/swarm.sqlite"));
	let listen = format!("unix:{}", path.display());
	let env = [("SWARM_LISTEN", listen.as_str()), ("SWARM_DB", file.to_str().unwrap()), ("SWARM_MEM", ""), ("SWARM_HOST_NAME", "shard-test"), ("SWARM_MAX_ENTRIES", "")];
	let (server, line) = serve(&env);
	assert_eq!(line.trim(), format!("[space] ready on {listen} (db {})", file.display()));
	let info = items_in(&path, ALIAS, "HostInfo");
	for field in [r#""name":"shard-test""#, r#""cap":20000"#, r#""cores""#, r#""platform":"Linux"#, r#""startedAt""#] {
		assert!(info.contains(field), "{field}: {info}");
	}
	drop(server);
	let (_server, _) = serve(&env);
	assert_eq!(items_in(&path, ALIAS, "HostInfo").matches(r#""type":"HostInfo""#).count(), 1, "replaced, not added, on a restart");
	drop(_server);
	let mut store = Store::open(SpaceHost::sqlite(SqliteLedger::open(&file, Synchronous::Full).unwrap()), system_random).unwrap();
	let limits = store.reader(Some(ALIAS)).unwrap().space.state.to_json_without_claims().get("limits").unwrap().to_json_text();
	store.close();
	assert!(limits.contains(r#""claimResultMs":900000"#) && limits.contains(r#""maxRegsPerOwner":1000"#), "{limits}");
	assert!(stored_limits(&file).contains(r#""claimResultMs":900000"#), "and the default space's");
}

#[test]
fn above_the_cap_it_purges_and_leaves_a_notice() {
	let d = dir("help-purge");
	let (path, file) = (d.join("s.sock"), d.join("swarm.sqlite"));
	let listen = format!("unix:{}", path.display());
	let mut env = vec![("SWARM_LISTEN", listen.as_str()), ("SWARM_DB", file.to_str().unwrap()), ("SWARM_MEM", ""), ("SWARM_MAX_ENTRIES", "")];
	drop(serve(&env)); // the Space by its alias
	// a history without posts and likes whose posts lie on the other shard: strays, which go first
	let mut entries = vec![obj! { "type" => "PostHistoryHead", "fields" => obj! { "next" => "" } }];
	entries.extend((0..12).map(|i| obj! { "type" => "Like", "fields" => obj! { "postId" => format!("elsewhere-{i}"), "at" => i as f64 } }));
	write_into(&file, &entries);
	env.extend([("SWARM_MAX_ENTRIES", "10"), ("SWARM_RETENTION_MS", "10")]);
	let (mut server, _) = serve(&env[..]);
	let purged = server.line();
	assert!(purged.starts_with("[swarm] retention: purged "), "{purged}");
	let notice = items_in(&path, ALIAS, "PurgeNotice");
	assert!(notice.contains(r#""cap":10"#) && notice.contains(r#""posts":0"#), "{notice}");
	let likes = items_in(&path, ALIAS, "Like");
	assert!(!likes.contains("elsewhere-0\""), "the oldest stray is gone: {likes}");
	assert!(likes.contains("elsewhere-11\""), "the newest stays: {likes}");
}
