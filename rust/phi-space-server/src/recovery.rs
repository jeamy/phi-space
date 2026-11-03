// `recovery` of a host's config (src/configured-recovery.ts): the private recovery endpoint beside the normal runtime, with
// the control host's receipt (`controlAck`) on a control host and, where an operator register endpoint is provisioned,
// the data recovery controller. And `--recovery-only` (src/recovery-only.ts): the recovery service of a host whose normal
// runtime is stopped and restart-locked, on its store alone, for a control restore or a Member's installation of it.
use crate::fail;
use crate::member::{field, register_client};
use phi_host::auth::Signer;
use phi_host::control_ack::ControlAck;
use phi_host::control_recovery::{control_recovery_call, member_recovery_call, ControlRecovery, MemberInstaller, Quiesced};
use phi_host::recovery::verify_ssh_fence;
use phi_host::recovery_controller::{data_recovery_call, DataRecovery};
use phi_host::recovery_rpc::{blocked, now_ms, run_ssh, serve_recovery, Fut, KeyPin, LoadSnapshot, RecoveryClient, RecoveryLine, RecoveryServe, Role, RR};
use phi_host::recovery_store::StoreLine;
use phi_host::register::{Register, SqliteRegister, SshRegister};
use phi_host::tls::private_file;
use phi_json::{obj, parse, text, Json, Object};
use phi_wire::Owner;
use std::path::{Path, PathBuf};
use std::rc::Rc;

fn private_json(path: &Path) -> Json { parse(&String::from_utf8_lossy(&private_file(path).unwrap_or_else(|e| fail(e)))).unwrap_or_else(|e| fail(format!("{}: {e}", path.display()))) }
fn signer_of(path: &str) -> Rc<Signer> { Rc::new(Signer::from_key_file(&private_json(Path::new(path))).unwrap_or_else(|e| fail(e)).0) }

/// A provisioned snapshot reference names a private JSON file of the snapshot directory, nothing else.
fn snapshots(dir: PathBuf, refused: &'static str) -> LoadSnapshot {
	Rc::new(move |reference: &str| {
		let fine = reference.len() > 5 && reference.len() <= 256 && reference.ends_with(".json") && reference.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b));
		if !fine {
			return Err(blocked(refused));
		}
		let bytes = private_file(&dir.join(reference)).map_err(blocked)?;
		parse(&String::from_utf8_lossy(&bytes)).map_err(|e| blocked(e.to_string()))
	})
}
fn fences(register: Rc<dyn Register>, targets: Object) -> Rc<dyn Fn(String) -> Fut<RR<Json>>> {
	Rc::new(move |id: String| {
		let (register, targets) = (Rc::clone(&register), targets.clone());
		Box::pin(async move { verify_ssh_fence(&*register, &id, &targets).await }) as Fut<RR<Json>>
	})
}
fn pin_of(v: &Json) -> KeyPin { KeyPin::from_json(v).unwrap_or_else(|| fail("invalid pinned recovery operator key")) }

/// The private endpoint of a host's `recovery` section, as a task beside its normal runtime.
pub struct PrivateRecovery {
	pub config: Json,
	pub mode: &'static str,
	pub host_id: String,
	pub authority_id: String,
	pub control_host_id: String,
	pub control_space_id: String,
	pub key_file: String,
	pub control_key: KeyPin,
	/// The host's own register (reads), for the control host's receipt.
	pub external: Rc<dyn Register>,
	pub installed_file: String,
}

impl PrivateRecovery {
	/// Checks the section at the start, as `startConfiguredRecovery` throws before anything serves.
	pub fn task(self) -> Box<dyn FnOnce(Owner) -> phi_wire::Local<()>> {
		let c = &self.config;
		let given: Vec<&str> = ["writerSocket", "writerSshTarget", "writerTls"].into_iter().filter(|k| c.get(k).is_some_and(|v| !v.is_null())).collect();
		if given.len() > 1 {
			fail("configure one operator register endpoint");
		}
		let writer: Option<Rc<dyn Register>> = match given.first() {
			Some(&"writerTls") => Some(Rc::new(register_client(c.get("writerTls").expect("given")))),
			Some(&"writerSocket") => Some(Rc::new(phi_host::register::SocketRegister { path: field(c, "writerSocket").to_owned(), writable: true, timeout_ms: 4000 })),
			Some(_) => Some(Rc::new(SshRegister::new(field(c, "writerSshTarget"), 10_000, true).unwrap_or_else(|e| fail(e)))),
			None => None,
		};
		if writer.is_some() {
			let endpoint = c.get("controlEndpoint");
			let one = endpoint.is_some_and(|e| e.get("path").and_then(Json::as_str).is_some() != e.get("sshTarget").and_then(Json::as_str).is_some());
			if text(c, "snapshotDirectory").is_none() || c.get("fenceTargets").and_then(Json::as_object).is_none() || !one {
				fail("data recovery needs snapshot directory, pinned fencing endpoints and one control endpoint");
			}
		}
		let operator = pin_of(c.get("operator").unwrap_or(&Json::Null));
		let path = PathBuf::from(field(c, "path"));
		Box::new(move |owner: Owner| Box::pin(async move { self.serve(owner, writer, operator, path).await }))
	}

	async fn serve(self, owner: Owner, writer: Option<Rc<dyn Register>>, operator: KeyPin, path: PathBuf) {
		let c = self.config.clone();
		let store = StoreLine::Wire(owner);
		let acks = (self.mode == "control").then(|| Rc::new(ControlAck { store: store.clone(), register: Rc::clone(&self.external), host_id: self.host_id.clone(), authority_id: self.authority_id.clone(), control_space_id: self.control_space_id.clone() }));
		let controller = writer.map(|w| {
			let endpoint = c.get("controlEndpoint").cloned().unwrap_or(Json::Null);
			let line = match text(&endpoint, "sshTarget") { Some(t) => RecoveryLine::Ssh(t.to_owned()), None => RecoveryLine::Socket(PathBuf::from(text(&endpoint, "path").unwrap_or(""))) };
			let (signer, control_host, authority) = (signer_of(&self.key_file), self.control_host_id.clone(), self.authority_id.clone());
			let host_id = self.host_id.clone();
			Rc::new(DataRecovery {
				store: store.clone(),
				host_id: self.host_id.clone(),
				authority_id: self.authority_id.clone(),
				external: Rc::clone(&w),
				installed: Rc::new(SqliteRegister::open(Path::new(&self.installed_file)).unwrap_or_else(|e| fail(e))),
				load_snapshot: snapshots(PathBuf::from(field(&c, "snapshotDirectory")), "snapshot reference must name a provisioned private JSON file"),
				verify_fence: fences(w, c.get("fenceTargets").and_then(Json::as_object).cloned().unwrap_or_default()),
				acknowledge_control: Rc::new(move |job: Json| {
					let client = RecoveryClient::new(line.clone(), &control_host, Rc::clone(&signer));
					let (authority, host_id) = (authority.clone(), host_id.clone());
					Box::pin(async move {
						let r = job.get("request").cloned().unwrap_or(Json::Null);
						let id = text(&r, "recoveryId").unwrap_or("").to_owned();
						let args = obj! { "recoveryId" => id.as_str(), "space" => r.get("space").cloned().unwrap_or(Json::Null), "incarnation" => job.get("incarnation").cloned().unwrap_or(Json::Null), "primaryEpoch" => job.get("primaryEpoch").cloned().unwrap_or(Json::Null), "authorityId" => authority.as_str(), "targetHostId" => host_id.as_str(), "argsHash" => job.get("argsHash").cloned().unwrap_or(Json::Null) };
						client.call("controlAck", args, Some(&format!("ack:{id}"))).await
					}) as Fut<RR<Json>>
				}),
			})
		});
		let control_key = self.control_key.clone();
		let host_key = acks.clone().map(|a| {
			Rc::new(move |args: Json| {
				let a = Rc::clone(&a);
				Box::pin(async move { Ok(a.host_key(&args).await?.as_ref().and_then(KeyPin::from_json)) }) as Fut<RR<Option<KeyPin>>>
			}) as phi_host::recovery_rpc::HostKeyOf
		});
		let handle = Rc::new(move |call: Json, role: Role| {
			let (acks, controller) = (acks.clone(), controller.clone());
			Box::pin(async move {
				if text(&call, "method") == Some("controlAck") {
					if let Some(a) = &acks {
						return a.acknowledge(call.get("args").unwrap_or(&Json::Null), role == Role::Host).await;
					}
				}
				match &controller {
					Some(c) if role != Role::Host => data_recovery_call(c, &call).await,
					_ => Err(blocked("private recovery method is not provisioned on this host")),
				}
			}) as Fut<RR<Json>>
		});
		let server = serve_recovery(RecoveryServe {
			path,
			host_id: self.host_id.clone(),
			operator,
			supervisor: Some(Rc::new(move || {
				let k = control_key.clone();
				Box::pin(async move { Ok(k) }) as Fut<RR<KeyPin>>
			})),
			host_key,
			handle,
			now: Rc::new(now_ms),
		})
		.await
		.unwrap_or_else(|e| fail(format!("recovery endpoint: {e}")));
		std::future::pending::<()>().await;
		drop(server);
	}
}

/// What the independent fence status says of this host (`assertQuiesced` of the test bed: the same answer a restore asks for).
fn quiesced_over_ssh(target: String) -> Quiesced {
	Rc::new(move || {
		let target = target.clone();
		Box::pin(async move {
			let out = run_ssh(&target, "phi-spaces-fence-status", vec![], 10_000, 8192).await.map_err(blocked)?;
			let s = parse(&String::from_utf8_lossy(&out)).map_err(|_| blocked("invalid fencing status"))?;
			Ok(obj! { "hostId" => s.get("hostId").cloned().unwrap_or(Json::Null), "normalStopped" => s.get("stopped") == Some(&Json::Bool(true)), "restartLocked" => s.get("restartLocked") == Some(&Json::Bool(true)) })
		}) as Fut<RR<Json>>
	})
}

/// `--recovery-only CONFIG.json RECOVERY.json`: the recovery service of a stopped, restart-locked host (`startRecoveryOnly`
/// for a control host, `startMemberRecoveryOnly` for a Member), until it is stopped. Whether the normal runtime is stopped
/// is what the independent fence status says (`fenceStatus`, an ssh target).
pub fn recovery_only(config: &str, recovery: &str, store: &str) {
	let cfg = private_json(Path::new(config));
	let rc = private_json(Path::new(recovery));
	let quiesced = quiesced_over_ssh(text(&rc, "fenceStatus").unwrap_or_else(|| fail("recovery-only needs the fence status endpoint (fenceStatus)")).to_owned());
	let control = text(&cfg, "mode") == Some("control");
	let runtime = crate::stopping::runtime();
	let service = phi_service::Service::new(crate::member::open_store(store), phi_service::Options::single_peer("recovery"));
	let line = Rc::new(std::cell::RefCell::new(service));
	let served = tokio::task::LocalSet::new().block_on(&runtime, async {
		let host_id = text(&rc, "hostId").unwrap_or("").to_owned();
		let check = |status: Json, message: &str| -> Result<(), String> {
			if text(&status, "hostId") == Some(host_id.as_str()) && status.get("normalStopped") == Some(&Json::Bool(true)) && status.get("restartLocked") == Some(&Json::Bool(true)) { Ok(()) } else { Err(message.to_owned()) }
		};
		let store = StoreLine::Local(Rc::clone(&line));
		let installed: Rc<dyn Register> = Rc::new(SqliteRegister::open(Path::new(text(&rc, "installedRegisterFile").unwrap_or(""))).map_err(|e| e.to_string())?);
		let (operator, handle): (KeyPin, phi_host::recovery_rpc::RecoveryHandler) = if control {
			let one = rc.get("registerTls").is_some() != rc.get("registerSshTarget").is_some();
			if host_id.is_empty() || text(&rc, "path").is_none() || text(&rc, "snapshotDirectory").is_none() || rc.get("fenceTargets").and_then(Json::as_object).is_none() || !one {
				return Err("incomplete recovery-only provisioning".to_owned());
			}
			check(quiesced().await.map_err(|e| e.to_string())?, "exclusive stopped and restart-locked normal runtime is required")?;
			let operator = signer_of(field(&rc, "operatorKeyFile"));
			let supervisor = signer_of(field(&rc, "supervisorKeyFile"));
			let external: Rc<dyn Register> = match rc.get("registerTls") { Some(r) => Rc::new(register_client(r)), None => Rc::new(SshRegister::new(field(&rc, "registerSshTarget"), 10_000, true).map_err(|e| e.to_string())?) };
			let operator_key = operator.public_key();
			let pin = KeyPin::of(&operator, &operator_key);
			let controller = Rc::new(ControlRecovery {
				store,
				host_id: host_id.clone(),
				external: Rc::clone(&external),
				installed,
				operator,
				operator_key,
				supervisor_key: supervisor.public_key(),
				load_snapshot: snapshots(PathBuf::from(field(&rc, "snapshotDirectory")), "invalid provisioned snapshot reference"),
				verify_fence: fences(external, rc.get("fenceTargets").and_then(Json::as_object).cloned().unwrap_or_default()),
				quiesced: Rc::clone(&quiesced),
				new_id: Rc::new(|| phi_store::store::random_uuid(&mut phi_store::system_random())),
			});
			let member = Rc::new(controller.installer());
			(pin, Rc::new(move |call: Json, role: Role| {
				let (c, m) = (Rc::clone(&controller), Rc::clone(&member));
				Box::pin(async move { control_recovery_call(&c, &m, &call, role).await }) as Fut<RR<Json>>
			}))
		} else {
			let pin = rc.get("operator").and_then(KeyPin::from_json);
			if host_id.is_empty() || text(&rc, "path").is_none() || text(&rc, "installedRegisterFile").is_none() || pin.is_none() || rc.get("registerTls").is_none() {
				return Err("incomplete member recovery provisioning".to_owned());
			}
			check(quiesced().await.map_err(|e| e.to_string())?, "exclusive stopped and restart-locked member runtime is required")?;
			let pin = pin.expect("checked");
			let member = Rc::new(MemberInstaller { store, host_id: host_id.clone(), external: Rc::new(register_client(rc.get("registerTls").expect("checked"))), installed, pinned: pin.clone(), quiesced });
			(pin, Rc::new(move |call: Json, role: Role| {
				let m = Rc::clone(&member);
				Box::pin(async move { member_recovery_call(&m, &call, role).await }) as Fut<RR<Json>>
			}))
		};
		let server = serve_recovery(RecoveryServe { path: PathBuf::from(field(&rc, "path")), host_id, operator, supervisor: None, host_key: None, handle, now: Rc::new(now_ms) }).await.map_err(|e| e.to_string())?;
		println!(r#"{{"recoveryReady":true}}"#);
		crate::stopping::stop().await;
		drop(server);
		Ok(())
	});
	if let Err(e) = served {
		fail(e);
	}
	if let Ok(s) = Rc::try_unwrap(line) {
		s.into_inner().store.close();
	}
}
