// validateErasureRegisterUpdate on seeded updates: the same verdict and the same reason as test/support/erasure-policy-driver.ts.
use phi_host::register::{validate_erasure_update, RegisterError};
use phi_json::{parse, Json};
use std::path::Path;
use std::process::Command;

#[test]
fn every_update_gets_the_verdict_of_typescript() {
	let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
	let seed = std::env::var("PHI_ERASURE_SEED").unwrap_or_else(|_| "7".into());
	let out = Command::new("node").args(["--experimental-strip-types", "--no-warnings", "test/support/erasure-policy-driver.ts", &seed, "20000"]).current_dir(root).output().unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	let (mut accepted, mut reasons) = (0, std::collections::BTreeMap::<String, usize>::new());
	for line in String::from_utf8(out.stdout).unwrap().lines() {
		let c = parse(line).unwrap();
		let key = c.get("key").and_then(Json::as_str).unwrap();
		let prior = c.get("prior").filter(|p| !p.is_null());
		let related = c.get("related").filter(|p| !p.is_null()).cloned();
		let got = validate_erasure_update(key, c.get("next").unwrap(), prior, &|_| Ok(related.clone()));
		let want = c.get("reject").and_then(Json::as_str);
		match (&got, want) {
			(Ok(()), None) => accepted += 1,
			(Err(RegisterError::Conflict(m)), Some(w)) if m == w => *reasons.entry(w.to_owned()).or_default() += 1,
			_ => panic!("{got:?} where TypeScript says {want:?}: {line}"),
		}
	}
	println!("accepted {accepted}, refused {reasons:#?}");
	assert!(accepted > 50, "accepted only {accepted}");
	assert!(reasons.len() >= 13, "only these reasons were reached: {reasons:#?}");
	assert!(reasons["archive binding or retirement cannot regress"] > 50, "{reasons:#?}");
}
