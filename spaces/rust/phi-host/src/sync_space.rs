//! A primary/sync Space on a federation host (src/sync-spaces.ts): its journal and store of their own, the signed replica
//! listener, and on the primary a store over the journal (`SqliteLedger::open_primary`) whose sealed candidate is resolved
//! with the standby before it is served. A standby serves no business calls. The host routes the Space's names to the
//! served store (`phi_wire::Owner::route`); `resolver` follows it while the host runs: once the store fails after a sealed,
//! unconfirmed commit, the Space answers `CommitSealed`, its store is closed, and the candidate is resolved with backoff
//! until the standby confirms or refuses it, or this host is no longer its primary.
use crate::auth::Signer;
use crate::register::SqliteRegister;
use crate::replica_control::{assert_permit, assert_quarantine, assert_sync_standby, install_admitted_permit, RegisterLine};
use crate::replica_transport::{journal_answer, serve_replica, Handle, ReplicaError, ReplicaPin, ReplicaSyncHandler, SignedReplicaPeer, SocketTransport};
use phi_json::{text, Json};
use phi_service::{sealed_reply, Conn, Options, Service};
use phi_store::primary::{lock_journal, PrimaryGate, PrimaryOptions, SharedJournal};
use phi_store::sync::{durability_of, promotion_evidence, JournalOptions, SyncError, SyncJournal};
use phi_store::sync_store::{recover_primary_sync, SyncStoreFile};
use phi_store::{system_random, SpaceHost, SqliteLedger, Store, WriterOptions};
use phi_wire::{Owner, Route};
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::net::IpAddr;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, MutexGuard};
use std::time::Duration;

/// `SyncSpaceConfig`.
#[derive(Clone, Debug)]
pub struct SyncSpaceConfig {
	pub alias: String,
	pub space_id: String,
	pub incarnation: String,
	pub dir: PathBuf,
	pub genesis: Json,
	/// The replica listener's port on the overlay address of every replica.
	pub port: u16,
	pub peers: Vec<(ReplicaPin, IpAddr)>,
	pub max_intent_bytes: Option<f64>,
	pub max_history_bytes: Option<f64>,
	/// `mainSync`: the host's own store is the one under the journal (every Space in it follows the control Space's
	/// configuration), in place of a Harness of the Space's own; its primary has no replica listener.
	pub store: Option<PathBuf>,
}
impl SyncSpaceConfig {
	pub fn from_json(c: &Json) -> Result<SyncSpaceConfig, String> {
		let s = |k: &str| text(c, k).map(str::to_owned).ok_or_else(|| format!("a primary/sync Space has no {k}"));
		let alias = s("alias")?;
		let peers = c.get("peers").and_then(Json::as_array).map_or(Ok(vec![]), |a| {
			a.iter().map(|p| Ok((ReplicaPin::from_json(p).ok_or("invalid replica pin")?, text(p, "ip").and_then(|ip| ip.parse().ok()).ok_or("invalid replica address")?))).collect::<Result<Vec<_>, String>>()
		})?;
		let port = c.get("port").and_then(Json::as_f64).unwrap_or(0.0);
		if port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) || peers.is_empty() {
			return Err(format!("replica listener of {alias} is not provisioned"));
		}
		let journal = c.get("journal");
		let bound = |k: &str| journal.and_then(|j| j.get(k)).and_then(Json::as_f64);
		Ok(SyncSpaceConfig { space_id: s("spaceId")?, incarnation: s("incarnation")?, dir: s("dir")?.into(), genesis: c.get("genesis").cloned().ok_or("a primary/sync Space has no genesis")?, port: port as u16, peers, max_intent_bytes: bound("maxIntentBytes"), max_history_bytes: bound("maxHistoryBytes"), store: None, alias })
	}
}

/// What every primary/sync Space of a host is given by it.
pub struct SyncContext {
	pub host_id: String,
	pub authority_id: String,
	pub bind_ip: IpAddr,
	/// The host's key file: the signers of the listener and of the line to the standby are made from it.
	pub key: Json,
	pub register: RegisterLine,
	pub installed: Rc<SqliteRegister>,
	pub now: Rc<dyn Fn() -> f64>,
}
impl SyncContext {
	fn signer(&self) -> Signer { Signer::from_key_file(&self.key).expect("the key file was read at the start").0 }
}

/// Why a Space was not served.
#[derive(Debug, Clone)]
pub struct NotServed {
	pub message: String,
	/// `StandbyRefused`: the standby answered with a refusal (its register unreachable, say); resolved like a candidate.
	pub refused: bool,
	/// `PrimarySyncBlocked` or `ReplicaTransitionBlocked`: no permit, another configuration.
	pub blocked: bool,
}
fn not_served(message: impl Into<String>, blocked: bool) -> NotServed { NotServed { message: message.into(), refused: false, blocked } }

/// What one attempt to resolve gives.
pub enum Resolved {
	Served(Box<Store>),
	/// Try again later: the standby or the register is unreachable.
	Pending(String),
	/// This host lost its active primary permit: stop trying; the candidate is never applied here.
	Excluded(String),
}

pub struct SyncSpace {
	pub config: SyncSpaceConfig,
	cx: Rc<SyncContext>,
	pub journal: SharedJournal,
	/// The journal's configuration as last read on the owner thread (the boot guard asks it on every call).
	config_now: RefCell<Json>,
	gate: RefCell<Option<PrimaryGate>>,
	standby_waits: Cell<bool>,
	listen_only: bool,
	listener: RefCell<Option<tokio::task::JoinHandle<()>>>,
}

/// The journal from the owner thread: the writer's thread holds it only for moments, a recovery for longer; this thread
/// does not block meanwhile.
async fn journal_of(j: &SharedJournal) -> MutexGuard<'_, SyncJournal> {
	loop {
		match j.try_lock() {
			Ok(g) => return g,
			Err(std::sync::TryLockError::Poisoned(p)) => return p.into_inner(),
			Err(std::sync::TryLockError::WouldBlock) => tokio::time::sleep(Duration::from_millis(2)).await,
		}
	}
}

impl SyncSpace {
	/// The journal and the replica listener (`openSyncSpace` up to its serving). `listen_only`: quarantine, the listener
	/// for setStandby's catch-up and never a served store.
	pub async fn open(config: SyncSpaceConfig, cx: Rc<SyncContext>, listen_only: bool) -> Result<Rc<SyncSpace>, String> {
		let c = &config;
		if text(&c.genesis, "spaceId") != Some(c.space_id.as_str()) || text(&c.genesis, "authorityId") != Some(cx.authority_id.as_str()) {
			return Err(format!("replica configuration of {} names another Space or authority", c.alias));
		}
		std::fs::create_dir_all(&c.dir).map_err(|e| e.to_string())?;
		let _ = std::fs::set_permissions(&c.dir, std::os::unix::fs::PermissionsExt::from_mode(0o700));
		let o = JournalOptions { max_intent_bytes: c.max_intent_bytes, max_history_bytes: c.max_history_bytes, self_id: Some(cx.host_id.clone()), format: None };
		let journal = SyncJournal::open(&c.dir.join("journal.sqlite"), &c.genesis, o).map_err(|e| e.to_string())?;
		let config_now = RefCell::new(journal.config());
		let listener = match listen_only || c.store.is_none() {
			true => Some(tokio::net::TcpListener::bind((cx.bind_ip, c.port)).await.map_err(|e| format!("replica listener of {}: {e}", c.alias))?),
			false => None,
		};
		let sp = Rc::new(SyncSpace { config, cx, journal: journal.into(), config_now, gate: RefCell::new(None), standby_waits: Cell::new(false), listen_only, listener: RefCell::new(None) });
		if let Some(listener) = listener {
			let peers: HashSet<IpAddr> = sp.config.peers.iter().map(|(_, ip)| *ip).collect();
			let task = tokio::task::spawn_local(serve_replica(listener, peers, sp.handle()));
			*sp.listener.borrow_mut() = Some(task);
		}
		Ok(sp)
	}

	/// The listener's handler (`replicaSyncHandler` over this journal, with the register's word on the permits).
	fn handle(self: &Rc<Self>) -> Handle {
		let handler = Rc::new(RefCell::new(ReplicaSyncHandler::new(self.cx.signer(), &self.cx.host_id, self.config.peers.iter().map(|(p, _)| p.clone()).collect())));
		let sp = Rc::downgrade(self);
		Rc::new(move |text: String| {
			let (handler, sp) = (Rc::clone(&handler), sp.clone());
			Box::pin(async move {
				let sp = sp.upgrade().ok_or("the Space is closed")?;
				let now = (sp.cx.now)();
				let a = handler.borrow_mut().admit(&text, now)?;
				// the register is read before the journal decides; the journal's own checks come first all the same
				let record = match a.method.as_deref() {
					Some("accept" | "catchUp") => Some(sp.cx.register.get(&format!("boot:{}", sp.cx.host_id)).await),
					_ => None,
				};
				let (host, space) = (sp.cx.host_id.clone(), sp.config.space_id.clone());
				let seen = |r: &Option<Result<Json, String>>| r.clone().unwrap_or(Ok(Json::Null)).map_err(SyncError::Blocked);
				let out = {
					let mut j = journal_of(&sp.journal).await;
					let out = journal_answer(&mut j, &a, |c, v| assert_sync_standby(&seen(&record)?, &host, c, v), || assert_quarantine(&seen(&record)?, &host, Some(&space)));
					*sp.config_now.borrow_mut() = j.config();
					out
				};
				Ok(handler.borrow().answer(&a, out))
			})
		})
	}

	/// The names calls reach the Space by: its alias and its ID.
	pub fn names(&self) -> Vec<String> { vec![self.config.alias.clone(), self.config.space_id.clone()] }
	/// The journal's configuration (`journal.config`), as last read.
	pub fn config_now(&self) -> Json { self.config_now.borrow().clone() }
	pub fn role(&self) -> &'static str {
		let c = self.config_now.borrow();
		if text(&c, "primaryReplica") == Some(self.cx.host_id.as_str()) { "primary" } else if text(&c, "standbyReplica") == Some(self.cx.host_id.as_str()) { "standby" } else { "excluded" }
	}
	pub fn primary_epoch(&self) -> f64 { self.config_now.borrow().get("primaryEpoch").and_then(Json::as_f64).unwrap_or(1.0) }
	/// `promotionEvidence` of this Space's journal as this host (v3 6.2): what makes an unknown request of an earlier
	/// epoch NotCommitted.
	pub fn promotion_proof(&self, request_epoch: f64) -> Option<Json> { promotion_evidence(&lock_journal(&self.journal), request_epoch, &self.cx.host_id).ok().flatten() }
	/// The service options of a served Space (`syncSpaces` of src/runtime.ts): its epoch, read at each call, and its
	/// evidence for NotCommitted.
	pub fn serve_options(self: &Rc<Self>, o: &mut Options) {
		let (epoch, proof) = (Rc::clone(self), Rc::clone(self));
		o.primary_epoch = self.primary_epoch();
		o.epoch_for_space = Some(Rc::new(move |_, _| epoch.primary_epoch()));
		o.promotion_proof = Some(Rc::new(move |_, request_epoch| proof.promotion_proof(request_epoch)));
	}

	/// The unresolved sealed candidate: the served store was poisoned by an unconfirmed commit, or (none served) the journal
	/// holds a candidate beyond the applied revision, or the standby refused at the start.
	pub fn sealed(&self) -> Option<(f64, String)> {
		if let Some(gate) = self.gate.borrow().as_ref() {
			return gate.sealed();
		}
		if self.role() != "primary" {
			return None;
		}
		let j = self.journal.try_lock().ok()?;
		let head = j.head().ok()?;
		let revision = head.get("revision").and_then(Json::as_f64)?;
		(revision as u64 != j.applied_revision().ok()? || self.standby_waits.get()).then(|| (revision, text(&head, "hash").unwrap_or("").to_owned()))
	}

	fn peer(&self) -> Result<Option<SignedReplicaPeer>, NotServed> {
		let c = self.config_now();
		if durability_of(&c) != "sync" {
			return Ok(None);
		}
		let standby = text(&c, "standbyReplica").unwrap_or("");
		let (pin, ip) = self.config.peers.iter().find(|(p, _)| p.host_id == standby).ok_or_else(|| not_served(format!("standby {standby} of {} is not provisioned", self.config.alias), false))?;
		let transport = SocketTransport::new((ip.to_string(), self.config.port), Some(self.cx.bind_ip));
		let now = Rc::clone(&self.cx.now);
		let at = now();
		let started = std::time::Instant::now();
		// the writer's thread asks the clock: the wall clock, from the owner's reading on
		Ok(Some(SignedReplicaPeer { transport: Box::new(transport), signer: self.cx.signer(), self_id: self.cx.host_id.clone(), remote: pin.clone(), now: Box::new(move || at + started.elapsed().as_millis() as f64) }))
	}

	/// `assertSyncPrimary` for a thread that may block; a register it cannot read marks `kind` with `LINE`. `held`: the
	/// configuration, when the caller holds the journal (a recovery), so that it is not locked twice.
	fn assert_primary_blocking(&self, kind: Arc<AtomicU8>, held: Option<Json>) -> impl Fn() -> phi_store::sync::Result<()> + Send + Sync + 'static {
		let (register, host, journal) = (self.cx.register.clone(), self.cx.host_id.clone(), Arc::clone(&self.journal));
		move || {
			let record = register.get_blocking(&format!("boot:{host}")).map_err(|e| {
				kind.store(LINE, Ordering::SeqCst);
				SyncError::Blocked(e)
			})?;
			let config = held.clone().unwrap_or_else(|| lock_journal(&journal).config());
			assert_permit(&record, &host, &config, "primary")
		}
	}

	/// Open, resolve the at most one sealed candidate with the standby, then the store to serve (`serve` of
	/// `openSyncSpace`); the same path at the start and after a sealed commit at runtime.
	pub async fn serve(&self) -> Result<Store, NotServed> {
		let c = &self.config;
		let record = self.cx.register.get(&format!("boot:{}", self.cx.host_id)).await.map_err(|e| not_served(e, false))?;
		install_admitted_permit(&record, &self.cx.installed, &self.cx.host_id, &c.space_id, &c.incarnation).map_err(|e| not_served(e, true))?;
		let harness = c.store.clone().unwrap_or_else(|| c.dir.join("harness.sqlite"));
		let mut recovering = self.peer()?;
		// what kind of failure a recovery ends in: the journal's decision, the standby's refusal, or the line
		let kind = Arc::new(AtomicU8::new(DECIDED));
		let (journal, assert, path, flag) = (Arc::clone(&self.journal), self.assert_primary_blocking(Arc::clone(&kind), Some(journal_of(&self.journal).await.config())), harness.clone(), Arc::clone(&kind));
		let recovered = tokio::task::spawn_blocking(move || -> Result<(), SyncError> {
			let mut raw = SyncStoreFile::open(&path).map_err(SyncError::Blocked)?;
			let mut j = lock_journal(&journal);
			let has_peer = recovering.is_some();
			let mut ask = |i: &Json| recovering.as_mut().expect("asked only under sync").accept(i).map_err(|e| {
				flag.store(if matches!(e, ReplicaError::Refused(_)) { REFUSED } else { LINE }, Ordering::SeqCst);
				SyncError::Blocked(e.to_string())
			});
			recover_primary_sync(&mut raw, &mut j, if has_peer { Some(&mut ask) } else { None }, &assert)
		})
		.await
		.map_err(|e| not_served(e.to_string(), false))?;
		*self.config_now.borrow_mut() = journal_of(&self.journal).await.config();
		if let Err(e) = recovered {
			let kind = kind.load(Ordering::SeqCst);
			return Err(NotServed { message: e.to_string(), refused: kind == REFUSED, blocked: kind == DECIDED && matches!(e, SyncError::Blocked(_)) });
		}
		let peer = self.peer()?.map(|p| Box::new(p) as Box<dyn phi_store::primary::SyncPeer>);
		let assert = self.assert_primary_blocking(Arc::new(AtomicU8::new(DECIDED)), None);
		let at = (self.cx.now)();
		let started = std::time::Instant::now();
		let p = PrimaryOptions { peer, assert_primary: Box::new(assert), now: Box::new(move || at + started.elapsed().as_millis() as f64) };
		let ledger = SqliteLedger::open_primary(&harness, WriterOptions::default(), Arc::clone(&self.journal), p).map_err(|e| not_served(e.to_string(), false))?;
		let gate = ledger.gate().cloned().expect("a primary's ledger has its gate");
		let mut store = Store::open(SpaceHost::sqlite(ledger), system_random).map_err(|e| not_served(e.to_string(), false))?;
		if c.store.is_none() && !store.spaces().iter().any(|i| text(i, "spaceId") == Some(c.space_id.as_str())) {
			let made = store.create_space_as(&c.alias, Some((&c.space_id, &c.incarnation)), (self.cx.now)(), system_random(), |_| Ok(()));
			let failed = match made {
				Ok(Ok(_)) => store.drain().err().map(|e| e.to_string()),
				Ok(Err(e)) => Some(e.message),
				Err(e) => Some(e.to_string()),
			};
			if let Some(e) = failed {
				store.close();
				return Err(not_served(e, false));
			}
		}
		*self.gate.borrow_mut() = Some(gate);
		self.standby_waits.set(false);
		Ok(store)
	}

	/// `notice`: the signed ReplicaConfigNotice of the last completed transition, on the primary only.
	pub async fn notice(&self) -> Option<Json> {
		if self.role() != "primary" {
			return None;
		}
		let n = crate::replica_notice::latest_notice(&*journal_of(&self.journal).await, &self.config.incarnation).ok()??;
		Some(crate::replica_notice::sign_notice(&n, &self.cx.signer()))
	}

	/// `lastConfigTransition`: the journal's last configuration entry, its reason as the transition ID, and the
	/// configuration before it.
	pub async fn last_transition(&self) -> Option<Json> {
		let j = journal_of(&self.journal).await;
		let head = j.head_revision().ok()?;
		for r in (1..=head).rev() {
			let i = j.intent(r as f64).ok()??;
			if i.get("version").and_then(Json::as_f64) == Some(2.0) {
				let previous = j.config_at(r as usize - 1).ok()?;
				return Some(phi_json::obj! { "transitionId" => i.get("reason").cloned().unwrap_or(Json::Null), "config" => i.get("config").cloned().unwrap_or(Json::Null), "previous" => previous });
			}
		}
		None
	}
	/// The journal's head (`journal.head()`).
	pub async fn head(&self) -> Json { journal_of(&self.journal).await.head().unwrap_or(Json::Null) }

	/// The Space's store is no longer served (its sealed candidate is resolved anew, or the host closes).
	pub fn unserved(&self) { *self.gate.borrow_mut() = None; }

	/// One attempt to resolve the sealed candidate with the standby and serve again.
	pub async fn resolve(&self) -> Resolved {
		if self.listen_only || self.role() != "primary" {
			return Resolved::Excluded("this host is not the primary of the journal configuration".into());
		}
		let record = match self.cx.register.get(&format!("boot:{}", self.cx.host_id)).await {
			Ok(r) => r,
			Err(e) => return Resolved::Pending(e),
		};
		if let Err(e) = assert_permit(&record, &self.cx.host_id, &self.config_now(), "primary") {
			return Resolved::Excluded(e.to_string());
		}
		match self.serve().await {
			Ok(store) => Resolved::Served(Box::new(store)),
			Err(e) => Resolved::Pending(e.message),
		}
	}

	/// What a call to the Space is answered while its candidate is unresolved (`sealedService`).
	pub fn sealed_answer(revision: f64) -> Route {
		Route::Answer(Rc::new(move |conn: &Conn| {
			if conn.peer_id.is_none() && conn.identity.is_none() {
				return r#"{"ok":false,"error":{"code":"Unauthenticated","message":"the connection has no known identity"}}"#.to_owned();
			}
			sealed_reply(revision)
		}))
	}

	pub fn close(&self) {
		self.unserved();
		if let Some(t) = self.listener.borrow_mut().take() { t.abort(); }
	}
}
impl Drop for SyncSpace {
	fn drop(&mut self) {
		if let Some(t) = self.listener.borrow_mut().take() { t.abort(); }
	}
}

const DECIDED: u8 = 0;
const REFUSED: u8 = 1;
const LINE: u8 = 2;

/// How the Space starts on a host that is its primary (`openSyncSpace`): served, waiting for its standby or with an
/// unresolved candidate (both resolved by `resolver`), an empty replica waiting for setStandby, or not at all.
pub enum Started {
	Served(Box<Store>),
	Unresolved,
	/// Kept unserved with its listener: an empty replica, or a standby, or quarantine.
	Listening,
}
pub async fn start(sp: &Rc<SyncSpace>) -> Result<Started, String> {
	if sp.listen_only || sp.role() != "primary" {
		return Ok(Started::Listening);
	}
	match sp.serve().await {
		Ok(store) => Ok(Started::Served(Box::new(store))),
		Err(e) => {
			let (head, applied) = {
				let j = journal_of(&sp.journal).await;
				(j.head_revision().unwrap_or(0), j.applied_revision().unwrap_or(0))
			};
			if head == 0 {
				eprintln!("primary/sync Space {} is an empty replica and waits for setStandby: {}", sp.config.alias, e.message);
				Ok(Started::Listening)
			} else if e.refused {
				sp.standby_waits.set(true);
				eprintln!("primary/sync Space {} waits for its standby: {}", sp.config.alias, e.message);
				Ok(Started::Unresolved)
			} else if head == applied || e.blocked {
				Err(e.message)
			} else {
				eprintln!("primary/sync Space {} has an unresolved sealed candidate: {}", sp.config.alias, e.message);
				Ok(Started::Unresolved)
			}
		}
	}
}

/// What serves a primary/sync Space's store: its service, made with [`SyncSpace::serve_options`].
pub type MakeService = Rc<dyn Fn(Store, &Rc<SyncSpace>) -> Service>;

/// `sealedResolver` for one Space, for as long as the host runs: whenever its served store fails after a sealed commit,
/// the Space answers `CommitSealed`, its store is closed, and `resolve` is tried with backoff (1 s doubling to 30 s) until
/// it is served again or this host is no longer its primary. `unresolved`: it starts that way.
pub async fn resolver(owner: Owner, sp: Rc<SyncSpace>, make: MakeService, mut unresolved: bool) {
	let names = sp.names();
	loop {
		if !unresolved {
			owner.failed(&sp.config.alias).await;
		}
		let sealed = sp.sealed().or_else(|| sp.journal.try_lock().ok().and_then(|j| j.head().ok()).map(|h| (h.get("revision").and_then(Json::as_f64).unwrap_or(0.0), String::new())));
		let revision = sealed.map_or(0.0, |(r, _)| r);
		for service in owner.route(&names, Some(SyncSpace::sealed_answer(revision))) {
			service.store.close();
		}
		sp.unserved();
		let mut wait = 1_000;
		loop {
			match sp.resolve().await {
				Resolved::Served(store) => {
					let service = make(*store, &sp);
					owner.route(&names, Some(Route::Served(Box::new(service))));
					eprintln!("primary/sync Space {}: sealed candidate resolved, served again", sp.config.alias);
					break;
				}
				Resolved::Excluded(e) => {
					eprintln!("primary/sync Space {} stays unresolved; this host is no longer its primary: {e}", sp.config.alias);
					return;
				}
				Resolved::Pending(e) => {
					eprintln!("primary/sync Space {}: sealed candidate still unresolved: {e}", sp.config.alias);
					tokio::time::sleep(Duration::from_millis(wait)).await;
					wait = (wait * 2).min(30_000);
				}
			}
		}
		unresolved = false;
	}
}
