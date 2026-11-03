//! The Root on a control host (src/configured-root.ts, src/root-wire.ts): the journals in the control store, the Members over proven
//! lines, and the operations on the wire for the hosted agents of this very peer. Replicated Members, a router change, the status
//! heartbeat and epoch notices are not carried; `check_start` refuses what would rely on them.
use crate::auth::{Algorithm, KeyDirectory, PeerKey, Proof, Signer};
use crate::boot::BootGuard;
use crate::control::{has_admin_key, held_document, peer_key, AsyncCommands, CONTROL_SPACE};
use crate::control_host::ControlHost;
use crate::federated_space::{failure, FederatedSpace, FederationIo, LAYOUT, OPERATIONS};
use crate::federation_rpc::{Failure, FederationRpc, RootIo};
use crate::gate::{roles_of, GroupRoles, Netbird, Now};
use crate::grants::GrantAuthority;
use crate::member_status::{self, Probed, StatusEnv};
use crate::membership_control::{MembershipController, MembershipEnv};
use crate::profile_transition::ProfileTransitionController;
use crate::remote::ControlClient;
use crate::router::{Reprepared, RouterController, RouterEnv, COMMANDS, DEFAULT_LIMITS, JOURNAL};
use crate::run_member::Pin;
use phi_core::routing::{parent_journal_key, partition_router_id, validate_journal_partitions};
use phi_core::space::{error, CoreError};
use phi_json::{digest_json, num_of, obj, text, Json};
use phi_service::{Identity, Service};
use phi_wire::{Local, Owner};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;
use tokio::sync::Mutex;

type R<T> = Result<T, CoreError>;
const ROUTING: &str = "phi-spaces.federation-routing";
const REPLICA_MARKER: &str = "phi-spaces.control-replica-marker";
const STATUS_AGENT: &str = "root-status";
const LIVE_LEASE: &str = "previous router lease is live";
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

/// What is provisioned of a Member: the line to it, and the key its proofs stand on.
pub struct MemberEnd {
	pub host: String,
	pub port: u16,
	pub peer_id: String,
	pub key_id: String,
	pub algorithm: Algorithm,
	pub public_key: String,
	pub target: Json,
	/// The other hosts of a replicated Member, by host ID: where its target may move with an adopted notice.
	pub replicas: HashMap<String, MemberEnd>,
}
impl MemberEnd {
	/// `endpointOf`: the endpoint of this Member on a host, its provisioned one or a replica's.
	pub fn endpoint(&self, host: &str) -> Option<&MemberEnd> { if Some(host) == text(&self.target, "hostId") { Some(self) } else { self.replicas.get(host) } }
	/// `provisionedTarget`: the provisioned target, or for a replicated Member the same Space and authority on one of its hosts.
	pub fn provisioned(&self, t: &Json) -> bool {
		self.target.canonical().ok() == t.canonical().ok() || (!self.replicas.is_empty() && text(t, "hostId").is_some_and(|h| self.endpoint(h).is_some()) && t.get("spaceId") == self.target.get("spaceId") && t.get("authorityId") == self.target.get("authorityId"))
	}
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
	/// The routing, as the supervisor of this host holds it.
	pub routing: Rc<RefCell<Option<Json>>>,
	/// `adminPeer`: `peerId`, `address`; membership commands need it.
	pub admin: Option<(String, String)>,
	pub directory: Rc<Netbird>,
	pub group_roles: GroupRoles,
	pub control_signer: Rc<Signer>,
	/// `statusIntervalMs`.
	pub status_interval_ms: u64,
	/// `takeover`: may adopt the journal of an earlier router, waiting this long for its lease to end.
	pub takeover: Option<f64>,
}

struct Inner {
	c: RootConfig,
	owner: RefCell<Option<Owner>>,
	docs: RefCell<HashMap<(String, String), Json>>,
	lease: RefCell<Option<Json>>,
	lines: RefCell<HashMap<String, Rc<ControlClient>>>,
	/// Who stands behind the membership command that runs now.
	acting: RefCell<Option<String>>,
	/// The retained lease is another router's past: it does not count.
	superseded: Cell<bool>,
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
		let retained = held.or_else(|| read_lease(&c.lease_file).filter(|_| !self.0.superseded.get()));
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
	fn write_docs(&self, writes: Vec<(String, String, Json)>, version: Option<f64>) -> R<()> {
		let space = self.0.c.control_space.clone();
		let lines: Vec<_> = writes.iter().map(|(k, x, v)| (k.clone(), x.clone(), 1, v.to_json_text())).collect();
		self.with(|s| -> R<()> {
			s.commit_on(Some(&space), |d, now| {
				if let Some(v) = version {
					let counters = d.state.rest.get("authorityCounters").and_then(Json::as_object).cloned();
					let mut next = counters.unwrap_or_else(|| obj! { "routerEpoch" => 0.0 }.as_object().cloned().expect("an object"));
					next.insert("policyVersion", v.into());
					d.state.rest.insert("authorityCounters", Json::Object(next));
					d.touch(now);
				}
				d.doc_writes.extend(lines);
				Ok(())
			})?;
			s.store.drain().map_err(|e| error("Unavailable", e.to_string()))
		})??;
		let mut docs = self.0.docs.borrow_mut();
		for (kind, key, value) in writes {
			if kind == ROUTING {
				*self.0.c.routing.borrow_mut() = Some(value);
			} else {
				docs.insert((kind, key), value);
			}
		}
		Ok(())
	}
	/// The line to a Member by its binding, also one the routing does not hold yet.
	fn line_to(&self, member: &Json) -> R<Rc<ControlClient>> {
		let c = &self.0.c;
		let id = text(member, "id").unwrap_or("");
		let target = member.get("target").unwrap_or(&Json::Null);
		let host = text(target, "hostId").unwrap_or("");
		let end = c.members.get(id).filter(|e| e.provisioned(target)).and_then(|e| e.endpoint(host)).ok_or_else(|| blocked("membership target is not provisioned"))?;
		let key = format!("{id}@{host}");
		if let Some(l) = self.0.lines.borrow().get(&key) {
			return Ok(Rc::clone(l));
		}
		let line = Rc::new(ControlClient::new((end.host.clone(), end.port), &c.own_address, &c.peer_id, host, (c.line_signer)(), &c.router_key.1));
		self.0.lines.borrow_mut().insert(key, Rc::clone(&line));
		Ok(line)
	}
	fn control_entries(&self) -> R<Vec<Json>> {
		let (space, now) = (self.0.c.control_space.clone(), (self.0.c.now)());
		self.with(|s| -> R<Vec<Json>> {
			let host = s.store.reader(Some(&space))?;
			Ok(host.space.state.entries.iter().filter(|e| e.expires > now).map(|e| obj! { "type" => e.type_.as_str(), "fields" => e.fields.clone() }).collect())
		})?
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
		if kind == ROUTING {
			let c = &self.0.c;
			return self.with(|s| held_document(&c.routing, &s.store, ROUTING, Some(&c.control_space), |d| d.unwrap_or_else(empty_routing)).map(Some))?;
		}
		if let Some(d) = self.0.docs.borrow().get(&(kind.to_owned(), key.to_owned())) {
			return Ok(Some(d.clone()));
		}
		self.with(|s| s.store.stored_document(kind, Some(key)))?.map_err(|e| error("Unavailable", e.to_string()))
	}
	/// One commit of the control Space, on the disk before any Member hears of it.
	fn commit(&self, writes: Vec<(String, String, Json)>) -> R<()> { self.write_docs(writes, None) }
	fn commit_policy(&self, writes: Vec<(String, String, Json)>, version: f64) -> R<()> { self.write_docs(writes, Some(version)) }
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
	/// The line follows the current routing target: after an adopted notice calls go to the new primary.
	fn line(&self, member: &str) -> R<Self::Line> {
		let c = &self.0.c;
		let state = RootIo::state(self)?;
		let host = state.get("members").and_then(|m| m.get(member)).and_then(|m| m.get("target")).and_then(|t| text(t, "hostId")).map(str::to_owned).or_else(|| c.members.get(member).and_then(|e| text(&e.target, "hostId")).map(str::to_owned)).ok_or_else(|| blocked("Member endpoint is not provisioned"))?;
		let key = format!("{member}@{host}");
		if let Some(l) = self.0.lines.borrow().get(&key) {
			return Ok(Rc::clone(l));
		}
		let end = c.members.get(member).and_then(|e| e.endpoint(&host)).ok_or_else(|| blocked("Member endpoint is not provisioned"))?;
		let line = Rc::new(ControlClient::new((end.host.clone(), end.port), &c.own_address, &c.peer_id, &host, (c.line_signer)(), &c.router_key.1));
		self.0.lines.borrow_mut().insert(key, Rc::clone(&line));
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

impl StatusEnv for Env {
	fn authorized(&self) -> R<()> { self.authorize() }
	fn routing(&self) -> R<Json> { RootIo::state(self) }
	fn probe(&self, id: &str, target: &Json) -> Local<Result<Probed, String>> {
		let (env, id, target) = (self.clone(), id.to_owned(), target.clone());
		Box::pin(async move {
			if env.0.c.members.get(&id).is_none_or(|e| !e.provisioned(&target)) {
				return Err("status target is not provisioned".to_owned());
			}
			let principal = obj! { "peerId" => env.0.c.peer_id.as_str(), "agentId" => STATUS_AGENT };
			let info = env.rpc().hello(&id, &principal).await.map_err(|e| format!("{e:?}"))?;
			let same = [("spaceId", "spaceId"), ("hostId", "hostId"), ("incarnation", "dataIncarnation"), ("authorityId", "authorityId"), ("primaryEpoch", "primaryEpoch")];
			if same.iter().any(|(a, b)| info.get(a) != target.get(b)) {
				return Err("Member status target identity changed".to_owned());
			}
			Ok(Probed { revision: info.get("rev").cloned().unwrap_or(Json::Null), free: Json::Null, lag: Json::Null })
		})
	}
	fn record(&self, id: &str, target: &Json, status: Option<&Probed>, at: f64) -> R<()> {
		let c = &self.0.c;
		self.with(|s| -> R<()> {
			let routing = held_document(&c.routing, &s.store, ROUTING, Some(&c.control_space), |d| d.unwrap_or_else(empty_routing))?;
			if let Some(next) = member_status::record_on(s, &c.control_space, routing, id, target, status, at)? {
				s.store.drain().map_err(|e| error("Unavailable", e.to_string()))?;
				*c.routing.borrow_mut() = Some(next);
			}
			Ok(())
		})?
	}
	fn now(&self) -> f64 { (self.0.c.now)() }
}

impl MembershipEnv for Env {
	fn apply(&self, member: &Json, signed: Json) -> Local<R<Json>> {
		let line = self.line_to(member);
		Box::pin(async move {
			let line = line?;
			let unreachable = |e: String| error("TransportFailure", e);
			ControlClient::prove(&line).await.map_err(unreachable)?;
			let reply = ControlClient::reply(&line, &obj! { "method" => "membershipInstruction", "args" => obj! { "instruction" => signed } }).await.map_err(unreachable)?;
			if reply.get("ok") == Some(&Json::Bool(true)) {
				return Ok(reply.get("result").cloned().unwrap_or(Json::Null));
			}
			let e = reply.get("error");
			Err(failure(Failure::Refused { code: e.and_then(|e| text(e, "code")).unwrap_or("Error").to_owned(), message: e.and_then(|e| text(e, "message")).unwrap_or("refused").to_owned() }))
		})
	}
	fn pin(&self, member: &Json) -> Local<R<Pin>> {
		let c = &self.0.c;
		let id = text(member, "id").unwrap_or("");
		let target = member.get("target").unwrap_or(&Json::Null);
		let end = c.members.get(id).filter(|e| e.provisioned(target)).and_then(|e| e.endpoint(text(target, "hostId").unwrap_or("")));
		let done = match end {
			None => Err(blocked("membership target is not provisioned")),
			Some(e) => {
				let now = (c.now)();
				let key = self.with(|s| peer_key(&mut s.store, now, &e.peer_id, &e.key_id));
				match key.map(|k| k.and_then(|k| PeerKey::from_json(&k))) {
					Ok(Some(k)) if k.active && k.algorithm == e.algorithm && k.public_key == e.public_key && k.roles.iter().any(|r| r == "host") => Ok(Pin { issuer: e.peer_id.clone(), algorithm: e.algorithm, public_key: e.public_key.clone() }),
					Ok(_) => Err(blocked("Member key pin is not active")),
					Err(e) => Err(e),
				}
			}
		};
		Box::pin(async move { done })
	}
	/// `authorizeAdmin`: the command stands on the provisioned administrator, as the directory and the keys know it now.
	fn authorize(&self) -> Local<R<()>> {
		let env = self.clone();
		Box::pin(async move {
			let c = &env.0.c;
			let refused = || blocked("native Root requires a provisioned Supervisor administrator context");
			let Some((peer, address)) = c.admin.as_ref().filter(|(p, _)| env.0.acting.borrow().as_deref() == Some(p)) else { return Err(refused()) };
			c.directory.refresh().await.map_err(|e| error("Error", e))?;
			let found = c.directory.lookup(address).await.map_err(|e| error("Error", e))?;
			if !found.is_some_and(|p| p.id == *peer && roles_of(&p.groups, &c.group_roles).iter().any(|r| r == "admin")) {
				return Err(refused());
			}
			let (space, now) = (c.control_space.clone(), (c.now)());
			let active = env.with(|s| s.commit_on(Some(&space), |d, _| has_admin_key(d, now, peer)))??;
			if active { Ok(()) } else { Err(refused()) }
		})
	}
	/// `memberReferencesIn`: every journal in one look; what is open and names the Member holds it.
	fn has_references(&self, member_id: &str, space_id: &str) -> R<bool> {
		let c = &self.0.c;
		let layout = self.read(LAYOUT, &c.id)?;
		let partitions = layout.as_ref().and_then(|l| num_of(l, "partitions")).unwrap_or(1.0);
		if layout.as_ref().is_some_and(|l| l.get("reconciliation").is_some()) {
			return Ok(true);
		}
		let mut routers = vec![c.id.clone()];
		routers.extend(layout.as_ref().and_then(|l| l.get("routerIds")).and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(str::to_owned));
		routers.sort();
		routers.dedup();
		for r in routers {
			let index = self.read(JOURNAL, &r)?;
			for (id, row) in index.as_ref().and_then(|i| i.get("refs")).and_then(Json::as_object).map_or(vec![], |x| x.iter().collect()) {
				if matches!(text(row, "state"), Some("completed" | "failed")) || row.get("released") == Some(&Json::Bool(true)) {
					continue;
				}
				let key = digest_json(&Json::Array(vec![r.as_str().into(), id.into()])).map_err(|_| blocked("a key that cannot be hashed"))?;
				let doc = self.read(COMMANDS, &key)?;
				let command = doc.as_ref().and_then(|d| d.get("command")).filter(|c| !c.is_null()).ok_or_else(|| error("Error", "incomplete Router reference reconstruction"))?;
				if command.get("steps").and_then(Json::as_array).is_some_and(|s| s.iter().any(|x| x.get("target").and_then(|t| text(t, "spaceId")) == Some(space_id))) {
					return Ok(true);
				}
			}
		}
		let mut ops = phi_json::Object::new();
		for p in 0..partitions as u64 {
			let doc = self.read(OPERATIONS, &parent_journal_key(&c.id, partitions, p as f64)?)?;
			for (k, v) in doc.as_ref().and_then(|d| d.get("operations")).and_then(Json::as_object).map_or(vec![], |o| o.iter().collect()) {
				ops.insert(k, v.clone());
			}
		}
		for (_, op) in ops.iter() {
			if !op.get("members").and_then(Json::as_array).is_some_and(|m| m.iter().any(|x| x.as_str() == Some(member_id))) {
				continue;
			}
			if text(op, "phase") != Some("done") {
				return Ok(true);
			}
			let id = text(op, "id");
			let args = op.get("args");
			if text(op, "kind") == Some("txn") && args.and_then(|a| text(a, "action")) == Some("begin") {
				let closed = ops.iter().any(|(_, d)| text(d, "kind") == Some("txn") && text(d, "phase") == Some("done") && d.get("args").is_some_and(|a| text(a, "originId") == id && matches!(text(a, "action"), Some("commit" | "abort"))));
				if !closed {
					return Ok(true);
				}
			}
		}
		const QUIET: [&str; 7] = ["Command", "Result", "PeerKey", "Enroll", "RouterLease", "Capability", "MemberStatus"];
		Ok(self.control_entries()?.iter().any(|e| {
			let f = e.get("fields");
			let field = |k: &str| f.and_then(|f| text(f, k));
			!text(e, "type").is_some_and(|t| QUIET.contains(&t)) && !matches!(field("state"), Some("completed" | "failed" | "stopped" | "cancelled"))
				&& (field("memberId") == Some(member_id) || field("spaceId") == Some(space_id) || f.and_then(|f| f.get("members")).and_then(Json::as_array).is_some_and(|m| m.iter().any(|x| x.as_str() == Some(member_id))))
		}))
	}
}

pub struct Root {
	env: Env,
	space: Mutex<Option<FederatedSpace<Env, Env>>>,
	/// One transition at a time.
	membership: Mutex<()>,
	/// The journal waits to be taken over.
	takeover: Cell<bool>,
}

/// The membership commands of the supervisor.
pub const COMMANDS_OF_ROOT: [&str; 4] = ["addMember", "drain", "removeMember", "migrateProfiles"];
impl AsyncCommands for Rc<Root> {
	fn kinds(&self) -> &[&'static str] { if self.env.0.c.admin.is_some() { &COMMANDS_OF_ROOT } else { &[] } }
	fn run(&self, owner: Owner, kind: &str, command_id: &str, args: &Json, requested_by: &str) -> Local<Result<Json, String>> {
		let (root, kind, id, args, by) = (Rc::clone(self), kind.to_owned(), command_id.to_owned(), args.clone(), requested_by.to_owned());
		Box::pin(async move {
			let _one = root.membership.lock().await;
			*root.env.0.owner.borrow_mut() = Some(owner);
			*root.env.0.acting.borrow_mut() = Some(by);
			let c = &root.env.0.c;
			if kind == "migrateProfiles" {
				let profiles = ProfileTransitionController { env: root.env.clone(), control_space: c.control_space.clone(), authority_id: c.authority_id.clone(), federation_id: c.id.clone(), partitions: c.partitions, peer_id: c.peer_id.clone(), signer: Rc::clone(&c.control_signer) };
				let r = profiles.execute(&id, args.get("policy").unwrap_or(&Json::Null)).await;
				*root.env.0.acting.borrow_mut() = None;
				return r.map_err(|e| e.message);
			}
			let controller = MembershipController { env: root.env.clone(), control_space: c.control_space.clone(), authority_id: c.authority_id.clone(), peer_id: c.peer_id.clone(), signer: Rc::clone(&c.control_signer) };
			let short = match kind.as_str() { "addMember" => "add", "drain" => "drain", _ => "remove" };
			let member = args.get("member").cloned().unwrap_or(Json::Null);
			let r = controller.execute(&id, short, &member, text(&args, "newDefault")).await;
			*root.env.0.acting.borrow_mut() = None;
			let r = r.map_err(|e| e.message)?;
			let mut out = obj! { "phase" => r.get("phase").cloned().unwrap_or(Json::Null), "memberId" => member.get("id").cloned().unwrap_or(Json::Null) };
			if let Some(e) = r.get("error") {
				out.as_object_mut().expect("an object").insert("error", e.clone());
			}
			if let Some(v) = r.get("policy").and_then(|p| p.get("policyVersion")) {
				out.as_object_mut().expect("an object").insert("policyVersion", v.clone());
			}
			Ok(out)
		})
	}
}

/// What the start found of the lease.
#[derive(Clone, Copy, Default)]
pub struct Found {
	/// The journal stands and this router takes it over.
	pub takeover: bool,
	/// The retained lease was overtaken by another router.
	pub superseded: bool,
}

impl Root {
	pub fn new(c: RootConfig, found: Found) -> R<Rc<Root>> {
		validate_journal_partitions(c.partitions).map_err(|e| blocked(e.message))?;
		Ok(Rc::new(Root { env: Env(Rc::new(Inner { c, owner: RefCell::new(None), docs: RefCell::default(), lease: RefCell::new(None), lines: RefCell::default(), acting: RefCell::new(None), superseded: Cell::new(found.superseded) })), space: Mutex::new(None), membership: Mutex::new(()), takeover: Cell::new(found.takeover) }))
	}
	pub fn peer_id(&self) -> &str { &self.env.0.c.peer_id }

	/// `check_start`: what must stand before this host serves. A journal without its lease needs a router change.
	pub fn check_start(c: &RootConfig, store: &mut phi_store::Store) -> Result<Found, String> {
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
			if table.iter().any(|(id, m)| c.members.get(id).is_none_or(|e| !e.provisioned(m.get("target").unwrap_or(&Json::Null)))) {
				return Err("persisted Member target differs from Root provisioning".into());
			}
		}
		if store.space_info(CONTROL_SPACE).is_none() {
			return Err("the Root stands beside its control Space".into());
		}
		let journal = store.stored_document(LAYOUT, Some(&c.id)).map_err(unavailable)?.is_some() || store.stored_document(JOURNAL, Some(&c.id)).map_err(unavailable)?.is_some();
		let epoch = store.reader(Some(&c.control_space)).ok().and_then(|h| num_of(h.space.state.rest.get("authorityCounters")?, "routerEpoch")).unwrap_or(0.0);
		let retained = read_lease(&c.lease_file);
		let overtaken = retained.as_ref().and_then(|t| num_of(t.get("lease")?, "routerEpoch")).is_some_and(|e| epoch > e);
		if overtaken && journal && c.takeover.is_none() {
			return Err("Root lease no longer owns current epoch".into());
		}
		let superseded = overtaken && c.takeover.is_some();
		let takeover = (retained.is_none() || superseded) && journal;
		if takeover && c.takeover.is_none() {
			return Err("existing Root journal has lost its lease record".into());
		}
		Ok(Found { takeover, superseded })
	}

	/// A router change: waits, bounded, until the previous router's lease expired. `Err` ends the start.
	pub async fn take_over(&self, owner: Owner) -> R<()> {
		*self.env.0.owner.borrow_mut() = Some(owner);
		if !self.takeover.get() {
			return Ok(());
		}
		let c = &self.env.0.c;
		let end = (c.now)() + c.takeover.unwrap_or(0.0);
		loop {
			match self.env.retain_lease() {
				Ok(_) => break,
				Err(e) if e.message.contains(LIVE_LEASE) && (c.now)() < end => tokio::time::sleep(Duration::from_millis(1000)).await,
				Err(e) => return Err(blocked(e.message)),
			}
		}
		self.takeover.set(false);
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

	/// Recovers the journals.
	pub async fn start(&self, owner: Owner) -> R<()> { self.open(owner).await.map(drop) }

	/// v3 5.3.1 step 6: every active Member hears once per transition or router change what is current; again after a restart,
	/// the Member keeps the maximum.
	async fn epoch_notices(&self, delivered: &mut HashMap<String, String>) -> R<()> {
		let env = &self.env;
		let c = &env.0.c;
		let space = c.control_space.clone();
		let marker = env.with(|s| s.store.stored_document(REPLICA_MARKER, Some(&space)))?.map_err(|e| error("Unavailable", e.to_string()))?;
		let transition = marker.as_ref().and_then(|m| text(m, "transitionId")).unwrap_or("").to_owned();
		let state = RootIo::state(env)?;
		let (epoch, _) = env.counters()?;
		let Some(version) = state.get("policy").and_then(|p| num_of(p, "policyVersion")).filter(|_| !transition.is_empty() || epoch > 1.0) else { return Ok(()) };
		let key = format!("{transition}#{epoch}");
		let table = state.get("members").and_then(Json::as_object);
		let pending: Vec<&str> = table.map_or(vec![], |t| t.iter().filter(|(id, m)| matches!(text(m, "state"), Some("active" | "draining")) && delivered.get(*id) != Some(&key)).map(|(id, _)| id).collect());
		if pending.is_empty() {
			return Ok(());
		}
		env.authorize()?;
		let signed = env.with(|s| c.control.epoch_notice(s, version))??;
		let principal = obj! { "peerId" => c.peer_id.as_str(), "agentId" => STATUS_AGENT };
		for id in pending {
			match env.rpc().epoch_notice(id, &principal, &signed).await {
				Ok(_) => {
					delivered.insert(id.to_owned(), key.clone());
					let n = signed.get("notice").cloned().unwrap_or(Json::Null);
					println!("{}", obj! { "epochNotice" => id, "routerEpoch" => n.get("routerEpoch").cloned().unwrap_or(Json::Null), "controlPrimaryEpoch" => n.get("controlPrimaryEpoch").cloned().unwrap_or(Json::Null), "policyVersion" => version }.to_json_text());
				}
				Err(e) => eprintln!("Root epoch notice: {id} {e:?}"),
			}
		}
		Ok(())
	}

	/// v3 5.3.1 step 5: adopts every published ReplicaConfigNotice in version order, before the probes; the register
	/// decides, the signer is the key provisioned for the issuing host. Refusals are reported, not fatal.
	pub async fn adopt_notices(&self) -> R<(usize, Vec<String>)> {
		let env = &self.env;
		let c = &env.0.c;
		env.authorize()?;
		let (space, now) = (c.control_space.clone(), (c.now)());
		let mut published = env.with(|s| -> R<Vec<Json>> { Ok(crate::control::listed(&s.store.reader(Some(&space))?.space, now, &obj! { "type" => "ReplicaConfigNotice" })?.iter().filter_map(|e| e.get("fields").cloned()).collect()) })??;
		published.sort_by(|a, b| a.get("version").and_then(Json::as_f64).unwrap_or(f64::NAN).total_cmp(&b.get("version").and_then(Json::as_f64).unwrap_or(f64::NAN)));
		let (mut adopted, mut refused) = (0, vec![]);
		for f in published {
			let t = f.get("signed").cloned().unwrap_or(Json::Null);
			match self.adopt(&t).await {
				Ok(true) => adopted += 1,
				Ok(false) => {}
				Err(e) => {
					let n = t.get("notice");
					refused.push(format!("{}@{}: {}", n.and_then(|n| text(n, "spaceId")).unwrap_or("undefined"), n.and_then(|n| n.get("replicaConfigVersion")).map_or_else(|| "undefined".into(), Json::to_json_text), e.message));
				}
			}
		}
		Ok((adopted, refused))
	}
	/// `adoptReplicaConfigNotice`: whether it changed the routing.
	async fn adopt(&self, t: &Json) -> R<bool> {
		let env = &self.env;
		let c = &env.0.c;
		let issuer = text(t, "issuer").unwrap_or("");
		let key = c.members.values().find_map(|m| m.endpoint(issuer)).map(|e| (e.algorithm, e.public_key.clone()));
		let n = crate::replica_notice::verify_adoptable(t, &c.authority_id, key.as_ref().map(|(a, k)| (*a, k.as_str())))?;
		let permit = format!("boot:{}", text(&n, "primaryReplica").unwrap_or(""));
		let unreachable = |e: crate::register::RegisterError| error("Error", e.to_string());
		let version = crate::replica_notice::permit_for(&c.guard.external().get(&permit).await.map_err(unreachable)?, &n)?;
		let space = c.control_space.clone();
		let (open, routing) = env.with(|s| -> R<(bool, Json)> {
			let profiles = s.store.stored_document("phi-spaces.profile-transitions", Some(&space)).map_err(|e| error("Unavailable", e.to_string()))?;
			let open = profiles.and_then(|d| d.get("operations").and_then(Json::as_object).map(|o| o.iter().any(|(_, op)| text(op, "phase") != Some("completed")))).unwrap_or(false);
			Ok((open, held_document(&c.routing, &s.store, ROUTING, Some(&space), |d| d.unwrap_or_else(empty_routing))?))
		})??;
		let (_, next, policy_version) = crate::replica_notice::adopted_routing(&routing, open, &c.authority_id, &n)?;
		let Some(next) = next else { return Ok(false) };
		// the admitting permit must not have changed since it was read
		if c.guard.external().get(&permit).await.map_err(unreachable)?.get("version") != Some(&version) {
			return Err(error("RoutingConflict", "boot permit changed during adoption"));
		}
		env.write_docs(vec![(ROUTING.to_owned(), space, next)], Some(policy_version))?;
		Ok(true)
	}

	/// The Root's heartbeat. Runs after the start; a failed pass is reported and tried again.
	pub async fn heartbeat(&self) {
		let mut delivered = HashMap::new();
		loop {
			match self.adopt_notices().await {
				Ok((_, refused)) => refused.iter().for_each(|r| eprintln!("Root replica notice refused: {r}")),
				Err(e) => eprintln!("Root replica notices: {}", e.message),
			}
			if let Err(e) = self.epoch_notices(&mut delivered).await {
				eprintln!("Root epoch notices: {}", e.message);
			}
			if let Err(e) = member_status::refresh(&self.env).await {
				eprintln!("Root Member status: {}", e.message);
			}
			tokio::time::sleep(Duration::from_millis(self.env.0.c.status_interval_ms)).await;
		}
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
