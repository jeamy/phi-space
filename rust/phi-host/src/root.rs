//! The Root on a control host (src/configured-root.ts, src/root-wire.ts): the journals in the control store, the Members over proven
//! lines, and the operations on the wire for the hosted agents of this very peer. Replicated Members, a router change, the status
//! heartbeat and epoch notices are not carried; `check_start` refuses what would rely on them.
use crate::auth::{KeyDirectory, PeerKey, Proof, Signer};
use crate::boot::BootGuard;
use crate::control::{peer_key, CONTROL_SPACE};
use crate::control_host::ControlHost;
use crate::federated_space::{failure, FederatedSpace, FederationIo, LAYOUT};
use crate::federation_rpc::{FederationRpc, RootIo};
use crate::gate::Now;
use crate::grants::GrantAuthority;
use crate::remote::ControlClient;
use crate::router::{Reprepared, RouterController, RouterEnv, DEFAULT_LIMITS, JOURNAL};
use phi_core::routing::{partition_router_id, validate_journal_partitions};
use phi_core::space::{error, CoreError};
use phi_json::{num_of, obj, text, Json};
use phi_service::{Identity, Service};
use phi_wire::{Local, Owner};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use tokio::sync::Mutex;

type R<T> = Result<T, CoreError>;
const ROUTING: &str = "phi-spaces.federation-routing";
const RENEW_BEFORE_MS: f64 = 45_000.0;
pub const METHODS: [&str; 10] = ["rootWrite", "rootRead", "rootTake", "rootBegin", "rootFinish", "rootTakeWaiting", "rootReadWaiting", "rootResume", "rootReadAll", "rootCount"];
/// What a refusal of the journal keeps as its code, so that a client knows to `rootResume`.
const KEPT: [&str; 8] = ["FederationPending", "FederationUnavailable", "RoutingConflict", "MemberDrained", "CapacityUnavailable", "NoCapableMember", "MergeTypeNotExclusive", "ResultExpired"];

fn blocked(m: impl Into<String>) -> CoreError { error("BootBlocked", m) }
fn empty_routing() -> Json { obj! { "policy" => Json::Null, "members" => phi_json::Object::new() } }

struct StoreKeys<'a> {
	store: RefCell<&'a mut phi_store::Store>,
	now: f64,
}
impl KeyDirectory for StoreKeys<'_> {
	fn find(&self, peer_id: &str, key_id: &str) -> Option<PeerKey> { PeerKey::from_json(&peer_key(&mut self.store.borrow_mut(), self.now, peer_id, key_id)?) }
}

/// What is provisioned of a Member: the line to it.
pub struct MemberEnd {
	pub host: String,
	pub port: u16,
}

pub struct RootConfig {
	pub id: String,
	pub peer_id: String,
	pub authority_id: String,
	pub host_id: String,
	pub control_space: String,
	pub own_address: String,
	pub lease_file: PathBuf,
	pub partitions: f64,
	pub router_key: (Rc<Signer>, String),
	pub host_key_id: String,
	pub members: HashMap<String, MemberEnd>,
	/// A fresh signer of the router key per line.
	pub line_signer: Box<dyn Fn() -> Signer>,
	pub grant_signer: Rc<Signer>,
	pub control: ControlHost,
	pub guard: Rc<BootGuard>,
	pub now: Now,
}

struct Inner {
	c: RootConfig,
	owner: RefCell<Option<Owner>>,
	docs: RefCell<HashMap<(String, String), Json>>,
	lease: RefCell<Option<Json>>,
	lines: RefCell<HashMap<String, Rc<ControlClient>>>,
}
#[derive(Clone)]
struct Env(Rc<Inner>);

impl Env {
	fn with<T>(&self, f: impl FnOnce(&mut Service) -> T) -> R<T> {
		let owner = self.0.owner.borrow().clone().ok_or_else(|| error("Error", "the Root is not serving"))?;
		Ok(owner.with(f))
	}
	fn rpc(&self) -> FederationRpc<Env> { FederationRpc { io: self.clone(), signer: Rc::clone(&self.0.c.router_key.0), key_id: self.0.c.router_key.1.clone() } }
	fn counters(&self) -> R<(f64, f64)> {
		let space = self.0.c.control_space.clone();
		let read = self.with(|s| -> R<(f64, f64)> {
			let host = s.store.reader(Some(&space))?;
			let rest = &host.space.state.rest;
			Ok((rest.get("authorityCounters").and_then(|c| num_of(c, "routerEpoch")).unwrap_or(0.0), rest.get("primaryEpoch").and_then(Json::as_f64).unwrap_or(1.0)))
		});
		read?
	}
	/// `retainLease`: renews in time, and keeps the token beside the store for the next start.
	fn retain_lease(&self) -> R<Json> {
		let c = &self.0.c;
		let now = (c.now)();
		let held = self.0.lease.borrow().clone();
		if let Some(t) = held.as_ref().filter(|t| t.get("lease").and_then(|l| num_of(l, "expiresAt")).is_some_and(|e| now + RENEW_BEFORE_MS < e)) {
			return Ok(t.clone());
		}
		let retained = held.or_else(|| read_lease(&c.lease_file));
		let renew = retained.as_ref().map(|t| {
			let l = t.get("lease").cloned().unwrap_or(Json::Null);
			obj! { "id" => l.get("id").cloned().unwrap_or(Json::Null), "routerEpoch" => l.get("routerEpoch").cloned().unwrap_or(Json::Null), "token" => t.clone() }
		});
		let token = self.with(|s| c.control.issue_lease(s, &c.peer_id, &c.router_key.1, renew.as_ref()))??;
		let text = format!("{}\n", token.to_json_text());
		let tmp = c.lease_file.with_extension("tmp");
		crate::tls::write_private(&tmp, text.as_bytes()).and_then(|()| std::fs::rename(&tmp, &c.lease_file).map_err(|e| e.to_string())).map_err(|e| error("Error", e))?;
		*self.0.lease.borrow_mut() = Some(token.clone());
		Ok(token)
	}
	/// The guard of `createFederationController`: the host stands, and the lease is the one Control knows.
	fn authorize(&self) -> R<()> {
		let c = &self.0.c;
		c.guard.assert_active()?;
		let t = self.retain_lease()?;
		let l = t.get("lease").cloned().unwrap_or(Json::Null);
		if (c.now)() >= num_of(&l, "expiresAt").unwrap_or(0.0) - 2000.0 {
			return Err(error("Error", "RouterLease does not authorize journal owner"));
		}
		let (epoch, primary) = self.counters()?;
		if Some(epoch) != num_of(&l, "routerEpoch") || Some(primary) != num_of(&l, "controlPrimaryEpoch") {
			return Err(error("Error", "RouterLease was superseded by Control"));
		}
		Ok(())
	}
}

fn read_lease(file: &Path) -> Option<Json> { phi_json::parse(&std::fs::read_to_string(file).ok()?).ok() }

impl RouterEnv for Env {
	fn read(&self, kind: &str, key: &str) -> R<Option<Json>> {
		if let Some(d) = self.0.docs.borrow().get(&(kind.to_owned(), key.to_owned())) {
			return Ok(Some(d.clone()));
		}
		self.with(|s| s.store.stored_document(kind, Some(key)))?.map_err(|e| error("Unavailable", e.to_string()))
	}
	/// One commit of the control Space, on the disk before any Member hears of it.
	fn commit(&self, writes: Vec<(String, String, Json)>) -> R<()> {
		let space = self.0.c.control_space.clone();
		let lines: Vec<_> = writes.iter().map(|(k, x, v)| (k.clone(), x.clone(), 1, v.to_json_text())).collect();
		self.with(|s| -> R<()> {
			s.commit_on(Some(&space), |d, _| {
				d.doc_writes.extend(lines);
				Ok(())
			})?;
			s.store.drain().map_err(|e| error("Unavailable", e.to_string()))
		})??;
		let mut docs = self.0.docs.borrow_mut();
		for (kind, key, value) in writes {
			docs.insert((kind, key), value);
		}
		Ok(())
	}
	fn assert_authority(&self) -> Local<R<()>> {
		let done = self.authorize();
		Box::pin(async move { done })
	}
	fn invoke(&self, step: Json) -> Local<Result<Json, ()>> {
		let env = self.clone();
		Box::pin(async move { env.rpc().invoke(step).await })
	}
	fn resolve(&self, step: Json) -> Local<Result<Json, ()>> {
		let env = self.clone();
		Box::pin(async move { env.rpc().resolve(step).await })
	}
	fn reprepare(&self, step: Json) -> Local<Result<Reprepared, ()>> {
		let env = self.clone();
		Box::pin(async move { env.rpc().reprepare(step).await })
	}
	fn now(&self) -> f64 { (self.0.c.now)() }
}

impl RootIo for Env {
	type Line = Rc<ControlClient>;
	fn state(&self) -> R<Json> { Ok(self.read(ROUTING, &self.0.c.control_space)?.unwrap_or_else(empty_routing)) }
	fn line(&self, member: &str) -> R<Self::Line> {
		if let Some(l) = self.0.lines.borrow().get(member) {
			return Ok(Rc::clone(l));
		}
		let c = &self.0.c;
		let end = c.members.get(member).ok_or_else(|| blocked("Member endpoint is not provisioned"))?;
		let state = RootIo::state(self)?;
		let host = state.get("members").and_then(|m| m.get(member)).and_then(|m| m.get("target")).and_then(|t| text(t, "hostId")).ok_or_else(|| blocked("Member endpoint is not provisioned"))?;
		let line = Rc::new(ControlClient::new((end.host.clone(), end.port), &c.own_address, &c.peer_id, host, (c.line_signer)(), &c.router_key.1));
		self.0.lines.borrow_mut().insert(member.to_owned(), Rc::clone(&line));
		Ok(line)
	}
	fn lease(&self) -> Local<R<Json>> {
		let done = self.retain_lease();
		Box::pin(async move { done })
	}
	/// `grant`: the Root grants its own hosted-agent namespace only.
	fn grant(&self, principal: &Json) -> Local<R<Json>> {
		let c = &self.0.c;
		let (now, key) = ((c.now)(), c.host_key_id.clone());
		let (peer, agent) = (text(principal, "peerId").unwrap_or("").to_owned(), text(principal, "agentId").map(str::to_owned));
		let done = if peer != c.peer_id {
			Err(blocked("native Root only grants its own hosted-agent namespace"))
		} else {
			let mut id16 = [0u8; 16];
			getrandom::getrandom(&mut id16).expect("the system gives random bytes");
			self.with(|s| {
				let keys = StoreKeys { store: RefCell::new(&mut s.store), now };
				let found = keys.find(&peer, &key).filter(|k| k.active).ok_or_else(|| blocked("Root needs its separate active enrolled host key"))?;
				let roles = found.roles.clone();
				let identity = Identity { principal: obj! { "peerId" => peer.as_str() }, roles: roles.clone() };
				let proof = Proof { key_id: key.clone(), principal: peer.clone(), roles };
				GrantAuthority { authority_id: c.authority_id.clone(), host_id: c.host_id.clone(), signer: Rc::clone(&c.grant_signer), keys: &keys, ttl_ms: 60_000.0, allow_a_only: None }.issue(Some(&identity), Some(&proof), "effect", agent.as_deref(), now, id16).map_err(blocked)
			}).and_then(|r| r)
		};
		Box::pin(async move { done })
	}
	fn now(&self) -> f64 { (self.0.c.now)() }
	fn request_id(&self) -> String { phi_store::random_uuid(&mut phi_store::system_random()) }
}

impl FederationIo for Env {
	fn state(&self) -> R<Json> { RootIo::state(self) }
	fn step(&self, member: &str, principal: &Json, method: &str, args: &Json, policy_version: Option<&Json>, origin: Option<&Json>) -> Local<R<Json>> {
		let (env, member, principal, method, args, version, origin) = (self.clone(), member.to_owned(), principal.clone(), method.to_owned(), args.clone(), policy_version.cloned(), origin.cloned());
		Box::pin(async move { env.rpc().step(&member, &principal, &method, &args, version.as_ref(), origin.as_ref()).await.map_err(failure) })
	}
	fn snapshot(&self, member: &str, principal: &Json, template: &Json, txn: Option<&Json>) -> Local<R<Json>> {
		let (env, member, principal, template, txn) = (self.clone(), member.to_owned(), principal.clone(), template.clone(), txn.cloned());
		Box::pin(async move { env.rpc().snapshot(&member, &principal, &template, txn.as_ref()).await.map_err(failure) })
	}
	fn events(&self, member: &str, principal: &Json, registration: &Json) -> Local<R<Json>> {
		let (env, member, principal, registration) = (self.clone(), member.to_owned(), principal.clone(), registration.clone());
		Box::pin(async move { env.rpc().events(&member, &principal, &registration).await.map_err(failure) })
	}
	fn ack(&self, member: &str, principal: &Json, epoch: &str, seq: f64) -> Local<R<()>> {
		let (env, member, principal, epoch) = (self.clone(), member.to_owned(), principal.clone(), epoch.to_owned());
		Box::pin(async move { env.rpc().ack(&member, &principal, &epoch, seq).await.map_err(failure) })
	}
	fn txn_active(&self, member: &str, principal: &Json, txn: &str, registration: Option<&Json>) -> Local<R<bool>> {
		let (env, member, principal, txn, registration) = (self.clone(), member.to_owned(), principal.clone(), txn.to_owned(), registration.cloned());
		Box::pin(async move { env.rpc().txn_active(&member, &principal, &txn, registration.as_ref()).await.map_err(failure) })
	}
}

pub struct Root {
	env: Env,
	space: Mutex<Option<FederatedSpace<Env, Env>>>,
}

impl Root {
	pub fn new(c: RootConfig) -> R<Rc<Root>> {
		validate_journal_partitions(c.partitions).map_err(|e| blocked(e.message))?;
		Ok(Rc::new(Root { env: Env(Rc::new(Inner { c, owner: RefCell::new(None), docs: RefCell::default(), lease: RefCell::new(None), lines: RefCell::default() })), space: Mutex::new(None) }))
	}
	pub fn peer_id(&self) -> &str { &self.env.0.c.peer_id }

	/// `check_start`: what must stand before this host serves. A journal without its lease needs a router change, which is R6b.
	pub fn check_start(c: &RootConfig, store: &mut phi_store::Store) -> Result<(), String> {
		let now = (c.now)();
		let key = |store: &mut phi_store::Store, id: &str, role: &str| peer_key(store, now, &c.peer_id, id).and_then(|k| PeerKey::from_json(&k)).is_some_and(|k| k.active && k.roles.iter().any(|r| r == role));
		if !key(store, &c.router_key.1, "router") {
			return Err("Root needs its active enrolled router key".into());
		}
		if !key(store, &c.host_key_id, "host") {
			return Err("Root needs its separate active enrolled host key".into());
		}
		let unavailable = |e: phi_store::StoreError| e.to_string();
		let state = store.stored_document(ROUTING, Some(&c.control_space)).map_err(unavailable)?.unwrap_or_else(empty_routing);
		if let Some(table) = state.get("members").and_then(Json::as_object) {
			if table.iter().any(|(id, m)| !c.members.contains_key(id) || m.get("replication").is_some_and(|r| !r.is_null())) {
				return Err("persisted Member target differs from Root provisioning".into());
			}
		}
		if store.space_info(CONTROL_SPACE).is_none() {
			return Err("the Root stands beside its control Space".into());
		}
		let journal = store.stored_document(LAYOUT, Some(&c.id)).map_err(unavailable)?.is_some() || store.stored_document(JOURNAL, Some(&c.id)).map_err(unavailable)?.is_some();
		if journal && !c.lease_file.exists() {
			return Err("existing Root journal has lost its lease record".into());
		}
		Ok(())
	}

	/// The space, its journals recovered: on the first call, with the owner that call brought.
	async fn open(&self, owner: Owner) -> R<tokio::sync::MutexGuard<'_, Option<FederatedSpace<Env, Env>>>> {
		*self.env.0.owner.borrow_mut() = Some(owner);
		let mut held = self.space.lock().await;
		if held.is_none() {
			let c = &self.env.0.c;
			let router = |id: &str| RouterController::new(self.env.clone(), id, &c.authority_id, DEFAULT_LIMITS);
			let parts = if c.partitions == 1.0 { vec![] } else { (0..c.partitions as u64).map(|n| router(&partition_router_id(&c.id, n as f64)?)).collect::<R<Vec<_>>>()? };
			let mut space = FederatedSpace::new(self.env.clone(), self.env.clone(), &c.id, router(&c.id)?, parts, Some(&c.control_space))?;
			space.initialize_journals().await?;
			space.recover_journals().await?;
			*held = Some(space);
		}
		Ok(held)
	}

	/// One call of a proven local peer (`rootCall`).
	pub async fn call(&self, owner: Owner, call: &Json) -> Json {
		let done = self.run(owner, call).await;
		match done {
			Ok(v) => obj! { "ok" => true, "result" => v },
			Err(e) => {
				let code = if e.class == "TypeError" { "BadRequest" } else if KEPT.contains(&e.class) { e.class } else { "Unavailable" };
				obj! { "ok" => false, "error" => obj! { "code" => code, "message" => e.message } }
			}
		}
	}
	async fn run(&self, owner: Owner, call: &Json) -> R<Json> {
		let null = Json::Null;
		let a = call.get("args").unwrap_or(&null);
		let mut principal = obj! { "peerId" => self.peer_id() };
		if let Some(agent) = a.get("agentId").filter(|x| x.as_str().is_some()) {
			principal.as_object_mut().expect("an object").insert("agentId", agent.clone());
		}
		let mut q = obj! { "id" => a.get("id").cloned().unwrap_or(Json::Null), "principal" => principal.clone() };
		if let Some(t) = a.get("txn").filter(|t| phi_core::space::truthy(Some(t))) {
			q.as_object_mut().expect("an object").insert("txn", t.clone());
		}
		let template = a.get("template").unwrap_or(&null);
		let number = |k: &str| num_of(a, k).unwrap_or(f64::NAN);
		let partial = a.get("allowPartial") == Some(&Json::Bool(true));
		let mut held = self.open(owner).await?;
		let s = held.as_mut().expect("opened");
		match text(call, "method").unwrap_or("") {
			"rootWrite" => s.write(a.get("entry").unwrap_or(&null), &q, a.get("leaseMs").filter(|l| !l.is_null())).await,
			"rootRead" => s.read(template, &q).await,
			"rootTake" => s.take(template, &q).await,
			"rootBegin" => s.create_transaction(text(a, "member").unwrap_or(""), number("leaseMs"), &q).await,
			"rootFinish" => s.finish_transaction(text(a, "origin").unwrap_or(""), text(a, "action").unwrap_or(""), &q).await,
			"rootTakeWaiting" => s.take_waiting(template, number("timeoutMs"), number("txnLeaseMs"), &q).await,
			"rootReadWaiting" => s.read_waiting(template, number("timeoutMs"), &q).await,
			"rootResume" => s.resume(text(a, "id").unwrap_or("")).await,
			"rootReadAll" => s.read_all(template, &principal, partial, None, None).await,
			_ => s.count(template, &principal, partial, None, None).await,
		}
	}
}
