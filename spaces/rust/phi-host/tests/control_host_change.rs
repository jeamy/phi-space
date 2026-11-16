// R6b step 6: a control host change (src/control-host-change.ts) recorded by the recovery admin and followed by a host,
// through TypeScript and through phi_host::control_host_change on copies of the same register files: a register not
// provisioned, an unpinned signature, a malformed change, a target that is not yet the primary, an old host that still
// holds a permit, the change recorded and recorded again, a recovery ID used for another change, a host that follows it
// once and then has nothing to follow, and one whose installed authority disagrees. Every answer agrees, then every
// record of both registers.
use phi_host::auth::{to_base64, Algorithm, Signer};
use phi_host::control_host_change::{change_bytes, follow_control_host_change, record_control_host_change, verify_control_host_change, ChangeError};
use phi_host::register::SqliteRegister;
use phi_json::{obj, parse, Json};
use std::path::{Path, PathBuf};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const KEYS: [&str; 5] = ["authority:control-space", "boot:control-host", "boot:control-host-b", "installed-authority:control-space", "unused"];

fn key(seed: u8) -> Signer { Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[seed; 32])) }
fn signed(change: &Json, by: &Signer) -> Json { obj! { "change" => change.clone(), "algorithm" => "ed25519", "signature" => to_base64(&by.sign(&change_bytes(change))) } }

/// Every step through TypeScript, on the register files of `dir`: each answer, or the class and message of its refusal.
fn typescript(dir: &Path, admin: &str, steps: &[Json]) -> Vec<Json> {
	let code = format!(
		"import {{ SqliteRecoveryRegister, recordControlHostChange, followControlHostChange, verifyControlHostChange }} from '{ROOT}/src/index.ts';\
		 const dir = {}, pinned = {{ algorithm: 'ed25519', publicKey: {} }}, steps = {};\
		 const open = (n) => new SqliteRecoveryRegister(dir + '/' + n + '.sqlite');\
		 for (const s of steps) {{ const ext = open('external'), inst = open(s.installed ?? 'installed');\
		  try {{ let v;\
		   if (s.op === 'set') {{ const cur = await ext.get(s.key); v = await ext.compareAndSet(s.key, cur?.version ?? null, s.value); }}\
		   else if (s.op === 'record') v = await recordControlHostChange(ext, s.signed, s.pinned ?? pinned);\
		   else if (s.op === 'follow') v = await followControlHostChange(ext, inst, {{ controlSpaceId: 'control-space', configured: s.configured, recoveryAdmin: s.pinned ?? pinned }});\
		   else v = verifyControlHostChange(s.signed, s.pinned ?? pinned);\
		   console.log(JSON.stringify({{ ok: v ?? null }})); }}\
		  catch (e) {{ console.log(JSON.stringify({{ refused: e.constructor.name, message: e.message }})); }}\
		  finally {{ ext.close(); inst.close(); }} }}",
		Json::from(dir.to_str().unwrap()).to_json_text(),
		Json::from(admin).to_json_text(),
		Json::Array(steps.to_vec()).to_json_text()
	);
	let out = std::process::Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", &code]).current_dir(ROOT).output().unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	String::from_utf8_lossy(&out.stdout).lines().map(|l| parse(l).unwrap()).collect()
}

fn rust(rt: &tokio::runtime::Runtime, dir: &Path, admin: &str, s: &Json) -> Json {
	let open = |n: &str| SqliteRegister::open(&dir.join(format!("{n}.sqlite"))).unwrap();
	let (ext, inst) = (open("external"), open(s.get("installed").and_then(Json::as_str).unwrap_or("installed")));
	let pinned_key = s.get("pinned").and_then(|p| p.get("publicKey")).and_then(Json::as_str).unwrap_or(admin).to_owned();
	let pinned = (Algorithm::parse(s.get("pinned").and_then(|p| p.get("algorithm")).and_then(Json::as_str).unwrap_or("ed25519")).unwrap(), pinned_key.as_str());
	let none = Json::Null;
	let r: Result<Json, ChangeError> = rt.block_on(async {
		match s.get("op").and_then(Json::as_str).unwrap() {
			"set" => {
				let k = s.get("key").and_then(Json::as_str).unwrap();
				let cur = ext.get(k).map_err(ChangeError::from)?;
				ext.compare_and_set(k, cur.get("version").and_then(Json::as_f64), s.get("value").unwrap()).map_err(ChangeError::from)
			}
			"record" => record_control_host_change(&ext, s.get("signed").unwrap_or(&none), pinned).await,
			"follow" => {
				let c = s.get("configured").unwrap();
				follow_control_host_change(&ext, &inst, "control-space", (c.get("hostId").and_then(Json::as_str).unwrap(), c.get("authorityId").and_then(Json::as_str).unwrap()), pinned).await.map(|v| v.unwrap_or(Json::Null))
			}
			_ => verify_control_host_change(s.get("signed").unwrap_or(&none), pinned),
		}
	});
	match r {
		Ok(v) => obj! { "ok" => v },
		Err(e) => obj! { "refused" => e.class(), "message" => e.message() },
	}
}

fn rows(dir: &Path) -> Vec<Json> {
	let mut out = vec![];
	for n in ["external", "installed", "installed-2"] {
		let r = SqliteRegister::open(&dir.join(format!("{n}.sqlite"))).unwrap();
		for k in KEYS {
			out.push(r.get(k).unwrap());
		}
	}
	out
}

#[test]
fn recording_and_following_a_change_agree_with_typescript() {
	let base = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("control-host-change");
	let _ = std::fs::remove_dir_all(&base);
	let (ts_dir, rs_dir) = (base.join("ts"), base.join("rust"));
	std::fs::create_dir_all(&ts_dir).unwrap();
	std::fs::create_dir_all(&rs_dir).unwrap();
	let (admin, stranger, old, new) = (key(1), key(2), key(3), key(4));
	let change = |recovery: &str, epoch: f64| obj! { "recoveryId" => recovery, "authorityId" => "authority", "controlSpaceId" => "control-space", "fromHostId" => "control-host", "targetHostId" => "control-host-b", "primaryEpoch" => epoch, "supervisorKey" => new.public_key(), "algorithm" => "ed25519", "address" => obj! { "host" => "172.30.7.12", "port" => 7431.0 } };
	let good = signed(&change("promote-1", 3.0), &admin);
	let authority = obj! { "authorityId" => "authority", "hostId" => "control-host", "supervisorKey" => old.public_key(), "state" => "active", "lineage" => Json::Array(vec![]) };
	let permit = |state: &str, role: &str, epoch: f64| obj! { "state" => state, "authorityId" => "authority", "dataIncarnation" => "i1", "role" => role, "primaryEpoch" => epoch, "transitionId" => "t" };
	let configured = obj! { "hostId" => "control-host", "authorityId" => "authority" };
	let steps = vec![
		obj! { "op" => "follow", "configured" => configured.clone() },
		obj! { "op" => "record", "signed" => good.clone() },
		obj! { "op" => "set", "key" => "authority:control-space", "value" => authority },
		obj! { "op" => "record", "signed" => signed(&change("promote-1", 3.0), &stranger) },
		obj! { "op" => "record", "signed" => signed(&change("promote-1", 1.0), &admin) },
		obj! { "op" => "verify", "signed" => good.clone(), "pinned" => obj! { "algorithm" => "ecdsa-p256", "publicKey" => admin.public_key() } },
		obj! { "op" => "set", "key" => "boot:control-host-b", "value" => obj! { "hostId" => "control-host-b", "state" => "active", "spaces" => obj! {} } },
		obj! { "op" => "record", "signed" => good.clone() },
		obj! { "op" => "set", "key" => "boot:control-host-b", "value" => obj! { "hostId" => "control-host-b", "state" => "active", "spaces" => obj! { "control-space" => permit("active", "primary", 2.0) } } },
		obj! { "op" => "record", "signed" => good.clone() },
		obj! { "op" => "set", "key" => "boot:control-host-b", "value" => obj! { "hostId" => "control-host-b", "state" => "active", "spaces" => obj! { "control-space" => permit("active", "primary", 3.0) } } },
		obj! { "op" => "set", "key" => "boot:control-host", "value" => obj! { "hostId" => "control-host", "state" => "active", "spaces" => obj! { "control-space" => permit("active", "primary", 1.0) } } },
		obj! { "op" => "record", "signed" => good.clone() },
		obj! { "op" => "set", "key" => "boot:control-host", "value" => obj! { "hostId" => "control-host", "state" => "fenced", "spaces" => obj! { "control-space" => permit("revoked", "primary", 1.0) } } },
		obj! { "op" => "follow", "configured" => configured.clone() },
		obj! { "op" => "record", "signed" => good.clone() },
		obj! { "op" => "record", "signed" => good.clone() },
		obj! { "op" => "record", "signed" => signed(&change("promote-1", 4.0), &admin) },
		obj! { "op" => "follow", "configured" => configured.clone(), "pinned" => obj! { "algorithm" => "ed25519", "publicKey" => stranger.public_key() } },
		obj! { "op" => "follow", "configured" => configured.clone() },
		obj! { "op" => "follow", "configured" => configured.clone() },
		obj! { "op" => "follow", "configured" => obj! { "hostId" => "control-host", "authorityId" => "another" }, "installed" => "installed-2" },
		obj! { "op" => "follow", "configured" => obj! { "hostId" => "control-host-b", "authorityId" => "authority" }, "installed" => "installed-2" },
	];
	let want = typescript(&ts_dir, &admin.public_key(), &steps);
	assert_eq!(want.len(), steps.len());
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	for (i, (s, w)) in steps.iter().zip(&want).enumerate() {
		let got = rust(&rt, &rs_dir, &admin.public_key(), s);
		assert_eq!(got.canonical().unwrap(), w.canonical().unwrap(), "step {i}: {}\n  Rust:       {}\n  TypeScript: {}", s.to_json_text(), got.to_json_text(), w.to_json_text());
	}
	// the steps reach what they are meant to
	let refusals: Vec<&str> = want.iter().filter_map(|w| w.get("message").and_then(Json::as_str)).collect();
	for m in ["authority register has not been provisioned", "invalid recovery admin signature", "invalid control host change", "the target is not the active primary of the control Space at this epoch", "the old control host still holds an active permit", "the authority is not active on the old control host", "recorded control host change disagrees with the authority record"] {
		assert!(refusals.contains(&m), "no step was refused with {m:?}");
	}
	assert_eq!(want[19].get("ok").and_then(|c| c.get("targetHostId")).and_then(Json::as_str), Some("control-host-b"), "the host follows the change");
	assert_eq!(want[20], obj! { "ok" => Json::Null }, "and then has nothing to follow");
	let (a, b) = (rows(&ts_dir), rows(&rs_dir));
	for (x, y) in a.iter().zip(&b) {
		assert_eq!(x.canonical().unwrap(), y.canonical().unwrap(), "the registers agree");
	}
}
