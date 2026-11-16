// R6b step 6: the policy step of a control replica transition (`alignControlReplicaIn` of src/federation-policy.ts) on a
// control store, through TypeScript and through phi_host::control::align_control_replica on a copy of the same file: no
// routing document, routing without a policy, with a policy, with an open profile transition, with a policy of another
// authority; each aligned to a transition, to the same one again, and to the next. Every answer agrees, then every row.
use phi_core::driver::seeded;
use phi_host::control::align_control_replica;
use phi_json::{obj, parse, Json};
use phi_store::{SpaceHost, SqliteLedger, Store, Synchronous};
use std::path::{Path, PathBuf};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const SPACE: &str = "sp-00000000-0000-4000-8000-000000000001";

fn profile() -> Json { obj! { "taskType" => "T", "resultTypes" => vec![Json::from("Done")], "equalFields" => vec![Json::from("n")], "maxResultCount" => 1.0, "maxResultBytes" => 1024.0, "maxLeaseMs" => 60_000.0 } }
fn policy(authority: &str, version: f64) -> Json { obj! { "authorityId" => authority, "policyVersion" => version, "rules" => vec![obj! { "type" => "R", "mode" => "local", "member" => "m1" }], "completionProfiles" => vec![profile()], "default" => obj! { "mode" => "local", "member" => "m1" } } }
fn members() -> Json { obj! { "m1" => obj! { "id" => "m1", "state" => "active", "target" => obj! { "authorityId" => "a", "hostId" => "h1", "spaceId" => "s1", "dataIncarnation" => "0a0b0c0d", "primaryEpoch" => 1.0 } } } }
fn steps() -> Vec<(Json, Json)> {
	let t = |id: &str, epoch: f64, primary: &str| obj! { "transitionId" => id, "primaryEpoch" => epoch, "replicaConfigVersion" => epoch, "primaryReplica" => primary };
	let before = obj! { "primaryEpoch" => 1.0, "primaryReplica" => "h1" };
	vec![(t("t1", 2.0, "h2"), before.clone()), (t("t1", 2.0, "h2"), before.clone()), (t("t2", 3.0, "h2"), before)]
}

fn node(code: &str) -> Vec<Json> {
	let out = std::process::Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code]).current_dir(ROOT).output().unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	String::from_utf8_lossy(&out.stdout).lines().map(|l| parse(l).unwrap()).collect()
}
const IMPORTS: &str = "import { openSqliteHost } from './src/store/sqlite.ts'; import { BACKGROUND_CONTEXT as ctx } from './src/context.ts'; import { createSpace } from './src/spaces.ts'; import { FederationRouting, alignControlReplicaIn } from './src/federation-policy.ts'; import { ProfileTransitions } from './src/profile-transition-doc.ts';";

fn rows(file: &Path) -> Vec<(String, String)> {
	let l = SqliteLedger::open(file, Synchronous::Full).unwrap();
	let mut out = vec![];
	for (kind, key) in l.documents().unwrap() {
		let d = l.document(&kind, key.as_deref()).unwrap().unwrap();
		// the Space's own document: what the policy step changes of it
		let value = if kind.starts_with("phi-spaces.space") { d.value.get("authorityCounters").cloned().unwrap_or(Json::Null) } else { d.value };
		out.push((format!("{kind} {}", key.unwrap_or_default()), value.canonical().unwrap()));
	}
	l.close();
	out
}

#[test]
fn the_policy_step_of_a_control_transition_agrees_with_typescript() {
	let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("control-align");
	let _ = std::fs::remove_dir_all(&base);
	std::fs::create_dir_all(&base).unwrap();
	let cases = [
		("none", Json::Null, Json::Null),
		("bare", obj! { "policy" => Json::Null, "members" => members() }, Json::Null),
		("policy", obj! { "policy" => policy("a", 3.0), "members" => members() }, Json::Null),
		("frozen", obj! { "policy" => policy("a", 3.0), "members" => members() }, obj! { "operations" => obj! { "p1" => obj! { "phase" => "freezing" } } }),
		("other", obj! { "policy" => policy("b", 3.0), "members" => members() }, Json::Null),
	];
	let steps = steps();
	for (name, routing, ledger) in cases {
		let (ts, rs) = (base.join(format!("{name}-ts.sqlite")), base.join(format!("{name}-rust.sqlite")));
		node(&format!(
			"{IMPORTS} const host = await openSqliteHost({}); await host.commit((tx) => createSpace(tx, 'control', 1000, {{ spaceId: '{SPACE}', incarnation: '0a0b0c0d' }}), ctx);\
			 const routing = {}, ledger = {}; if (routing) await host.commit(async (tx) => {{ Object.assign(await tx.doc(FederationRouting, '{SPACE}', null), routing); if (ledger) Object.assign(await tx.doc(ProfileTransitions, '{SPACE}', null), ledger); }}, ctx); await host.close(ctx);",
			Json::from(ts.to_str().unwrap()).to_json_text(),
			routing.to_json_text(),
			ledger.to_json_text()
		));
		std::fs::copy(&ts, &rs).unwrap();
		let calls = Json::Array(steps.iter().map(|(t, b)| obj! { "t" => t.clone(), "before" => b.clone() }).collect()).to_json_text();
		let want = node(&format!(
			"{IMPORTS} const host = await openSqliteHost({}); for (const s of {calls}) {{ try {{ console.log(JSON.stringify({{ ok: await host.commit((tx) => alignControlReplicaIn(tx, '{SPACE}', 'a', s.t, s.before), ctx) }})); }} catch (e) {{ console.log(JSON.stringify({{ refused: e.constructor.name, message: e.message }})); }} }} await host.close(ctx);",
			Json::from(ts.to_str().unwrap()).to_json_text()
		));
		let mut store = Store::open(SpaceHost::sqlite(SqliteLedger::open(&rs, Synchronous::Full).unwrap()), || seeded("align")).unwrap();
		for ((t, before), w) in steps.iter().zip(&want) {
			let got = match align_control_replica(&mut store, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64, SPACE, "a", t, before) {
				Ok(v) => obj! { "ok" => v },
				Err(e) => obj! { "refused" => e.class, "message" => e.message },
			};
			store.drain().unwrap();
			assert_eq!(got.canonical().unwrap(), w.canonical().unwrap(), "{name}: {}", t.to_json_text());
		}
		store.close();
		assert_eq!(rows(&ts), rows(&rs), "{name}: the rows");
	}
}
