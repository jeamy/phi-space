// R6b step 4 (docs/rust-portierung.en.md): the recovery building blocks of the host held against TypeScript. The
// TypeScript driver (test/support/recovery-driver.ts) builds a directory: a data source and its backup, a target holding
// the Space under the same identity, a control host and its backup, a control target, a Member host with work, the
// register and each host's installed register. Both sides run the same steps on copies of it: a data restore through
// RecoveryController with the control host's receipt (ControlAckService), a control restore under a new authority
// (ControlRecoveryController), a Member's installation of it (MemberTransitionInstaller), with refusals on the way. The
// fence checks are the real ones over `ssh`, answered by a stand-in on PATH; randomness is the drivers' seeded stream.
// After every step the answers agree and every row of every file is the same.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::driver::seeded;
use phi_host::auth::Signer;
use phi_host::control_ack::ControlAck;
use phi_host::control_recovery::{ControlRecovery, MemberInstaller, Quiesced};
use phi_host::recovery::verify_ssh_fence;
use phi_host::recovery_controller::DataRecovery;
use phi_host::recovery_rpc::{blocked, Fut, KeyPin, RecoveryError, RR};
use phi_host::recovery_store::StoreLine;
use phi_host::register::{Register, SqliteRegister};
use phi_json::{obj, parse, text, Json, Object};
use phi_service::{Options, Service};
use phi_store::{SpaceHost, SqliteLedger, Store, Synchronous};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn copy_dir(from: &Path, to: &Path) {
	std::fs::create_dir_all(to).unwrap();
	for e in std::fs::read_dir(from).unwrap() {
		let e = e.unwrap();
		let target = to.join(e.file_name());
		if e.file_type().unwrap().is_dir() { copy_dir(&e.path(), &target) } else { std::fs::copy(e.path(), target).unwrap(); }
	}
}
fn read(path: &Path) -> Json { parse(&std::fs::read_to_string(path).unwrap()).unwrap() }
fn write(path: &Path, v: &Json) { std::fs::write(path, v.to_json_text()).unwrap(); }

/// Every row of every SQLite file in `d`, by file, table and the row's columns in order.
fn rows(d: &Path) -> Vec<String> {
	let mut files: Vec<PathBuf> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|x| x == "sqlite")).collect();
	files.sort();
	let mut out = vec![];
	for f in files {
		let c = rusqlite::Connection::open_with_flags(&f, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
		let tables: Vec<String> = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").unwrap().query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
		for t in tables {
			let mut stmt = c.prepare(&format!("SELECT * FROM \"{t}\"")).unwrap();
			let n = stmt.column_count();
			// a document's JSON is compared as a value: the order of its keys is how each language built the object (a
			// head a TypeScript store created has its stream before its identity, a Rust store writes the fields in order)
			let json: Vec<bool> = stmt.column_names().iter().map(|c| *c == "value" && (t == "documents" || t == "parts")).collect();
			let cell = |r: &rusqlite::Row, i: usize| match (json[i], r.get_ref(i).unwrap()) {
				(true, rusqlite::types::ValueRef::Text(b)) => parse(&String::from_utf8_lossy(b)).map(|v| v.canonical().unwrap()).unwrap_or_else(|_| String::from_utf8_lossy(b).into_owned()),
				(_, v) => format!("{v:?}"),
			};
			let mut table: Vec<String> = stmt
				.query_map([], |r| Ok((0..n).map(|i| cell(r, i)).collect::<Vec<_>>().join(" | ")))
				.unwrap()
				.map(Result::unwrap)
				.collect();
			table.sort();
			// a part's index is filled once, when its document is first read: a Rust store opens every Space at once,
			// a TypeScript store when it is first asked for one
			table.retain(|r| !(t == "store_meta" && r.starts_with("Text([105, 110, 100, 101, 120, 101, 100, 0")));
			out.extend(table.into_iter().map(|r| format!("{} {t}: {r}", f.file_name().unwrap().to_string_lossy())));
		}
	}
	out
}

fn answer(r: RR<Json>) -> Json {
	match r {
		Ok(v) => obj! { "ok" => true, "result" => v },
		Err(e) => obj! { "ok" => false, "code" => if matches!(e, RecoveryError::Conflict(_)) { "RequestConflict" } else { "PermissionDenied" }, "message" => e.message() },
	}
}

/// One store of the directory behind a service at the line's clock, seeded as the TypeScript driver is.
fn open(d: &Path, name: &str, now: f64, seed: &str) -> Rc<RefCell<Service>> {
	let seed = seed.to_owned();
	let store = Store::open(SpaceHost::sqlite(SqliteLedger::open(&d.join(format!("{name}.sqlite")), Synchronous::Full).unwrap()), move || seeded(&seed)).unwrap();
	let mut o = Options::single_peer("recovery");
	o.now = Box::new(move || now);
	Rc::new(RefCell::new(Service::new(store, o)))
}
fn close(s: Rc<RefCell<Service>>) { Rc::try_unwrap(s).ok().expect("nothing holds the store any more").into_inner().store.close(); }

fn fences() -> Object { obj! { "source-host" => "source-host@fence", "control-host" => "control-host@fence" }.as_object().cloned().unwrap() }
fn snapshots(d: &Path) -> phi_host::recovery_rpc::LoadSnapshot {
	let d = d.to_owned();
	Rc::new(move |r: &str| std::fs::read_to_string(d.join("snapshots").join(r)).map_err(|e| blocked(e.to_string())).and_then(|t| parse(&t).map_err(|e| blocked(e.to_string()))))
}
fn quiesced(d: &Path, host: &str) -> Quiesced {
	let (file, host) = (d.join(format!("quiesced-{host}.json")), host.to_owned());
	Rc::new(move || {
		let v = if file.exists() { read(&file) } else { obj! { "hostId" => host.as_str(), "normalStopped" => false, "restartLocked" => false } };
		Box::pin(async move { Ok(v) }) as Fut<RR<Json>>
	})
}
fn fence_check(external: Rc<dyn Register>) -> Rc<dyn Fn(String) -> Fut<RR<Json>>> {
	Rc::new(move |id: String| {
		let external = Rc::clone(&external);
		Box::pin(async move { verify_ssh_fence(&*external, &id, &fences()).await }) as Fut<RR<Json>>
	})
}
fn key_file(d: &Path, name: &str) -> (Signer, String) {
	let k = read(&d.join(format!("{name}.json")));
	let (signer, _) = Signer::from_key_file(&k).unwrap();
	let public = signer.public_key();
	(signer, public)
}

/// One step through the Rust ports.
async fn rust_step(d: &Path, l: &Json) -> Json {
	let (now, seed, op) = (l.get("now").and_then(Json::as_f64).unwrap_or(0.0), text(l, "seed").unwrap_or("").to_owned(), text(l, "op").unwrap().to_owned());
	let state = read(&d.join("state.json"));
	let external: Rc<dyn Register> = Rc::new(SqliteRegister::open(&d.join("external.sqlite")).unwrap());
	let installed = |n: &str| -> Rc<dyn Register> { Rc::new(SqliteRegister::open(&d.join(format!("installed-{n}.sqlite"))).unwrap()) };
	let (operator, operator_key) = key_file(d, "operator-key");
	let pin = KeyPin::of(&operator, &operator_key);
	match op.as_str() {
		"submit" | "advance" | "status" | "release" | "hostKey" => {
			let (target, main) = (open(d, "target", now, &seed), open(d, "control", now, &seed));
			let r = {
				let ack = Rc::new(ControlAck { store: StoreLine::Local(Rc::clone(&main)), register: Rc::clone(&external), host_id: "control-host".into(), authority_id: "authority".into(), control_space_id: text(&state, "control").unwrap().into() });
				let a = Rc::clone(&ack);
				let c = DataRecovery {
					store: StoreLine::Local(Rc::clone(&target)),
					host_id: "target-host".into(),
					authority_id: "authority".into(),
					external: Rc::clone(&external),
					installed: installed("target"),
					load_snapshot: snapshots(d),
					verify_fence: fence_check(Rc::clone(&external)),
					acknowledge_control: Rc::new(move |job: Json| {
						let a = Rc::clone(&a);
						Box::pin(async move {
							let r = job.get("request").cloned().unwrap_or(Json::Null);
							let args = obj! { "recoveryId" => r.get("recoveryId").cloned().unwrap(), "space" => r.get("space").cloned().unwrap(), "incarnation" => job.get("incarnation").cloned().unwrap_or(Json::Null), "primaryEpoch" => job.get("primaryEpoch").cloned().unwrap_or(Json::Null), "authorityId" => "authority", "targetHostId" => "target-host", "argsHash" => job.get("argsHash").cloned().unwrap() };
							a.acknowledge(&args, true).await
						}) as Fut<RR<Json>>
					}),
				};
				match op.as_str() {
					"submit" => c.submit(l.get("request").unwrap()).await,
					"advance" => c.advance(text(l, "recoveryId").unwrap()).await,
					"status" => c.status(text(l, "recoveryId").unwrap()),
					"release" => c.release(l.get("request").unwrap()).await,
					_ => ack.host_key(l.get("args").unwrap()).await.map(|k| k.unwrap_or(Json::Null)),
				}
			};
			close(target);
			close(main);
			answer(r)
		}
		"install" => {
			let member = open(d, "member", now, &seed);
			let r = MemberInstaller { store: StoreLine::Local(Rc::clone(&member)), host_id: "member-host".into(), external, installed: installed("member"), pinned: pin, quiesced: quiesced(d, "member-host") }.advance(l.get("proof").unwrap()).await;
			close(member);
			answer(r)
		}
		_ => {
			let b = open(d, "control-b", now, &seed);
			let r = {
				let (supervisor, supervisor_key) = key_file(d, "control-key-2");
				let _ = supervisor;
				let id_seed = seed.clone();
				let c = ControlRecovery {
					store: StoreLine::Local(Rc::clone(&b)),
					host_id: "control-host-b".into(),
					external: Rc::clone(&external),
					installed: installed("control-b"),
					operator: Rc::new(operator),
					operator_key,
					supervisor_key,
					load_snapshot: snapshots(d),
					verify_fence: fence_check(Rc::clone(&external)),
					quiesced: quiesced(d, "control-host-b"),
					new_id: Rc::new(move || phi_store::store::random_uuid(&mut seeded(&id_seed))),
				};
				match op.as_str() {
					"controlSubmit" => c.submit(l.get("request").unwrap()).await,
					"controlAdvance" => c.advance(text(l, "recoveryId").unwrap()).await,
					"authorizeKey" => c.authorize_key(text(l, "recoveryId").unwrap(), l.get("key").unwrap()).await,
					_ => c.status(text(l, "recoveryId").unwrap()),
				}
			};
			close(b);
			answer(r)
		}
	}
}

struct Sides {
	ts: TsDriver,
	ts_dir: PathBuf,
	rust_dir: PathBuf,
	rt: tokio::runtime::Runtime,
	n: usize,
}
impl Sides {
	fn line(&mut self, mut l: Json, now: f64) -> Json {
		self.n += 1;
		if let Json::Object(o) = &mut l {
			o.insert("now", Json::Number(now));
			o.insert("seed", format!("s{}", self.n).into());
		}
		let mut ts_line = l.clone();
		if let Json::Object(o) = &mut ts_line { o.insert("dir", self.ts_dir.to_str().unwrap().into()); }
		let want = self.ts.step(&ts_line);
		std::env::set_var("FENCE_DIR", &self.rust_dir);
		let local = tokio::task::LocalSet::new();
		let got = self.rt.block_on(local.run_until(rust_step(&self.rust_dir.clone(), &l)));
		let line = l.to_json_text();
		assert_eq!(got.canonical().unwrap(), want.canonical().unwrap(), "step {}: {line}\n  Rust:       {}\n  TypeScript: {}", self.n, got.to_json_text(), want.to_json_text());
		let (r, t) = (rows(&self.rust_dir), rows(&self.ts_dir));
		if let Some((a, b)) = r.iter().zip(&t).find(|(a, b)| a != b) {
			panic!("step {}: {line}\n  the files differ\n  Rust:       {a}\n  TypeScript: {b}", self.n);
		}
		assert_eq!(r.len(), t.len(), "step {}: {line}: row counts", self.n);
		want
	}
	/// Both directories get the same file (a fence status, a quiesced runtime).
	fn put(&self, name: &str, v: &Json) {
		for d in [&self.ts_dir, &self.rust_dir] {
			write(&d.join(name), v);
		}
	}
	/// Repeats `l` until `done` holds of its answer (at most `n` times).
	fn until(&mut self, l: Json, now: f64, n: usize, done: impl Fn(&Json) -> bool) -> Json {
		for _ in 0..n {
			let a = self.line(l.clone(), now);
			if done(&a) {
				return a;
			}
		}
		panic!("{} did not get there in {n} steps", l.to_json_text());
	}
}

fn state_of(a: &Json) -> &str { a.get("result").and_then(|r| r.get("state")).and_then(Json::as_str).unwrap_or("") }
fn message(a: &Json) -> &str { text(a, "message").unwrap_or("") }

#[test]
fn recovery_steps_agree_with_typescript() {
	let base = dir("recovery-cross");
	let (ts_dir, rust_dir, bin) = (base.join("ts"), base.join("rust"), base.join("bin"));
	std::fs::create_dir_all(&bin).unwrap();
	// a stand-in for ssh: the forced command's answer is the target's fence status in the side's directory
	std::fs::write(bin.join("ssh"), "#!/bin/sh\nfor a; do target=$prev; prev=$a; done\n[ -f \"$FENCE_DIR/fence/$target.json\" ] || exit 255\ncat \"$FENCE_DIR/fence/$target.json\"\n").unwrap();
	std::fs::set_permissions(bin.join("ssh"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
	let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
	std::env::set_var("PATH", &path);
	std::fs::create_dir_all(&ts_dir).unwrap();
	let mut ts = TsDriver::script_with("test/support/recovery-driver.ts", &[("PATH", path.clone()), ("FENCE_DIR", ts_dir.to_str().unwrap().into())]);
	assert_eq!(ts.step(&obj! { "op" => "setup", "dir" => ts_dir.to_str().unwrap(), "now" => 1000.0, "seed" => "setup" }), obj! { "ok" => true, "result" => Json::Null });
	copy_dir(&ts_dir, &rust_dir);
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut s = Sides { ts, ts_dir: ts_dir.clone(), rust_dir, rt, n: 0 };
	let st = read(&ts_dir.join("state.json"));
	let t0 = 10_000.0;

	// ---- a data restore onto the target, the source killed but not fenced first
	let request = obj! { "recoveryId" => "restore-1", "space" => st.get("notes").cloned().unwrap(), "snapshotRef" => "notes.json", "targetHostId" => "target-host", "expectedDataIncarnation" => st.get("notesIncarnation").cloned().unwrap(), "expectedPrimaryEpoch" => 1.0 };
	assert_eq!(message(&s.line(obj! { "op" => "submit", "request" => request.clone() }, t0)), "fencing SSH command failed");
	s.put("fence/source-host@fence.json", &obj! { "hostId" => "source-host", "stopped" => false, "restartLocked" => true });
	assert_eq!(message(&s.line(obj! { "op" => "submit", "request" => request.clone() }, t0)), "normal service is not independently stopped and restart-locked");
	s.put("fence/source-host@fence.json", &obj! { "hostId" => "source-host", "stopped" => true, "restartLocked" => true });
	assert_eq!(state_of(&s.line(obj! { "op" => "submit", "request" => request.clone() }, t0)), "blocked");
	s.line(obj! { "op" => "submit", "request" => request.clone() }, t0 + 10.0);
	let mut other = request.clone();
	if let Json::Object(o) = &mut other { o.insert("snapshotRef", "other.json".into()); }
	assert_eq!(text(&s.line(obj! { "op" => "submit", "request" => other }, t0), "code"), Some("RequestConflict"));
	s.line(obj! { "op" => "release", "request" => obj! { "commandId" => "c1", "recoveryId" => "restore-1", "scope" => obj! { "type" => "Note" } } }, t0);
	s.until(obj! { "op" => "advance", "recoveryId" => "restore-1" }, t0 + 100.0, 30, |a| state_of(a) == "waiting");
	assert_eq!(state_of(&s.line(obj! { "op" => "advance", "recoveryId" => "restore-1" }, t0 + 200.0)), "waiting", "the receipt, then the wait for the old grants");
	s.line(obj! { "op" => "hostKey", "args" => obj! { "targetHostId" => "target-host" } }, t0 + 300.0);
	assert_eq!(state_of(&s.line(obj! { "op" => "advance", "recoveryId" => "restore-1" }, t0 + 70_000.0)), "completed");
	s.line(obj! { "op" => "advance", "recoveryId" => "restore-1" }, t0 + 70_100.0);
	let release = obj! { "commandId" => "c1", "recoveryId" => "restore-1", "scope" => obj! { "type" => "Note" } };
	s.line(obj! { "op" => "release", "request" => release.clone() }, t0 + 71_000.0);
	s.line(obj! { "op" => "release", "request" => release }, t0 + 71_100.0);
	assert_eq!(text(&s.line(obj! { "op" => "release", "request" => obj! { "commandId" => "c1", "recoveryId" => "restore-1", "scope" => obj! { "type" => "Other" } } }, t0 + 71_200.0), "code"), Some("RequestConflict"));
	s.line(obj! { "op" => "status", "recoveryId" => "restore-1" }, t0 + 71_300.0);

	// ---- a control restore onto the control target under a new authority, with the Member's installation
	let t1 = 200_000.0;
	let control = obj! { "recoveryId" => "control-restore-1", "controlSpaceId" => st.get("control").cloned().unwrap(), "snapshotRef" => "control.json", "expectedAuthorityId" => "authority", "expectedDataIncarnation" => st.get("controlIncarnation").cloned().unwrap(), "expectedPrimaryEpoch" => 1.0, "targetHostId" => "control-host-b", "confirmedMembers" => vec![Json::from("control-host-b"), Json::from("member-host")] };
	assert!(message(&s.line(obj! { "op" => "controlSubmit", "request" => control.clone() }, t1)).contains("must be stopped"));
	let stopped = |h: &str| obj! { "hostId" => h, "normalStopped" => true, "restartLocked" => true };
	s.put("quiesced-control-host-b.json", &stopped("control-host-b"));
	assert_eq!(message(&s.line(obj! { "op" => "controlSubmit", "request" => control.clone() }, t1)), "fencing SSH command failed");
	s.put("fence/control-host@fence.json", &obj! { "hostId" => "control-host", "stopped" => true, "restartLocked" => true });
	let job = s.line(obj! { "op" => "controlSubmit", "request" => control.clone() }, t1);
	assert_eq!(state_of(&job), "importing");
	s.line(obj! { "op" => "controlSubmit", "request" => control }, t1 + 10.0);
	let proof = job.get("result").and_then(|r| r.get("proof")).cloned().unwrap();
	s.until(obj! { "op" => "controlAdvance", "recoveryId" => "control-restore-1" }, t1 + 100.0, 30, |a| state_of(a) == "members");
	s.until(obj! { "op" => "controlAdvance", "recoveryId" => "control-restore-1" }, t1 + 200.0, 40, |a| state_of(a) == "waiting");
	assert!(message(&s.line(obj! { "op" => "install", "proof" => proof.clone() }, t1 + 300.0)).contains("must be stopped"));
	s.put("quiesced-member-host.json", &stopped("member-host"));
	s.until(obj! { "op" => "install", "proof" => proof.clone() }, t1 + 400.0, 40, |a| a.get("result").and_then(|r| r.get("completed")) == Some(&Json::Bool(true)));
	s.line(obj! { "op" => "install", "proof" => proof }, t1 + 450.0);
	let key = obj! { "peerId" => "admin-peer", "publicKey" => key_file(&ts_dir, "admin-key").1, "algorithm" => "ed25519", "roles" => vec![Json::from("admin")], "scope" => vec![Json::from("*")] };
	assert_eq!(message(&s.line(obj! { "op" => "controlAdvance", "recoveryId" => "control-restore-1" }, t1 + 500.0)), "old grant and lease validity has not expired");
	s.line(obj! { "op" => "authorizeKey", "recoveryId" => "control-restore-1", "key" => key.clone() }, t1 + 600.0);
	s.line(obj! { "op" => "authorizeKey", "recoveryId" => "control-restore-1", "key" => key }, t1 + 700.0);
	let old = obj! { "peerId" => "target-peer", "publicKey" => key_file(&ts_dir, "target-key").1, "algorithm" => "ed25519", "roles" => vec![Json::from("host")], "scope" => vec![Json::from("*")] };
	assert_eq!(text(&s.line(obj! { "op" => "authorizeKey", "recoveryId" => "control-restore-1", "key" => old }, t1 + 800.0), "code"), Some("RequestConflict"), "an old key is not revived");
	s.until(obj! { "op" => "controlAdvance", "recoveryId" => "control-restore-1" }, t1 + 70_000.0, 20, |a| state_of(a) == "completed");
	s.line(obj! { "op" => "controlStatus", "recoveryId" => "control-restore-1" }, t1 + 70_100.0);
	eprintln!("{} steps agree", s.n);
}
