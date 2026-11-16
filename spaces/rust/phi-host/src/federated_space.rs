//! Operations over several Members (src/federated-space.ts). An operation is journalled with its routing before any Member hears of
//! it, its children are commands of the router, and a retry finds them again under the same ids.
use crate::federation_rpc::Failure;
use crate::router::{release_future_in, RouterController, RouterEnv, Tx};
use phi_core::routing::{is_merge_type, normalize_federated_entry, operation_partition, parent_journal_key, search_members, validate_journal_partitions, write_member};
use phi_core::space::{bytes, error, routing, CoreError};
use phi_json::{num_of, obj, safe_integer, text, Json, Object};
use phi_wire::Local;

type R<T> = Result<T, CoreError>;

pub const LAYOUT: &str = "phi-spaces.federation-journal-layout";
pub const OPERATIONS: &str = "phi-spaces.federation-operations";
const ROUTING: &str = "phi-spaces.federation-routing";
const PROFILES: &str = "phi-spaces.profile-transitions";
const MEMBERSHIP: &str = "phi-spaces.membership-journal";
const ERASURES: &str = "phi-spaces.root-erasures";
const SLOT: f64 = 128.0 * 1024.0;
const MAX_OPERATIONS: usize = 16;
const CHILD_BYTES: f64 = 64.0 * 1024.0;

fn unavailable(m: impl Into<String>) -> CoreError { error("FederationUnavailable", m) }
fn pending() -> CoreError { error("FederationPending", "bound child outcome is unresolved") }
fn erased() -> CoreError { error("ResultExpired", "Root operation content was erased") }
use phi_core::routing::hash;
use phi_json::set;
fn child(id: &str, label: &str) -> R<String> { Ok(format!("f-{}", hash(&Json::Array(vec![id.into(), label.into()]))?)) }
fn empty_operations() -> Json { obj! { "operations" => Object::new(), "reservedBytes" => 0.0 } }
fn empty_layout() -> Json { obj! { "partitions" => Json::Null, "routerIds" => Json::Null } }
/// An operations journal before its first operation (membership, profile transitions).
pub(crate) fn empty_operations_only() -> Json { obj! { "operations" => Object::new() } }
/// The routing document before its first Member.
pub(crate) fn empty_routing() -> Json { obj! { "policy" => Json::Null, "members" => Object::new() } }
fn operations(d: &Json) -> Vec<(&str, &Json)> { d.get("operations").and_then(Json::as_object).map_or(vec![], |o| o.iter().collect()) }
fn operations_mut(d: &mut Json) -> &mut Object { d.as_object_mut().and_then(|o| o.get_mut("operations")).and_then(Json::as_object_mut).expect("a journal has operations") }
use phi_json::names;
fn members(op: &Json) -> Vec<String> { names(op.get("members")) }
fn valid_id(id: &str) -> bool { phi_json::ID_128_KEY.accepts(id) }
fn child_of(op: &Json, m: &str) -> String { op.get("children").and_then(|c| text(c, m)).unwrap_or("").to_owned() }
fn registration<'a>(op: &'a Json, m: &str) -> Option<&'a Json> { op.get("registrations").and_then(|c| c.get(m)) }
/// `event.eventId === registrations[member]`.
fn own_event(op: &Json, m: &str, e: Option<&Json>) -> bool { e.and_then(|e| e.get("eventId")) == registration(op, m) }
fn candidates(op: &Json) -> Vec<(&str, &Json)> { op.get("candidates").and_then(Json::as_object).map_or(vec![], |o| o.iter().collect()) }
fn insert_in(op: &mut Json, map: &str, k: &str, v: Json) {
	if let Some(Json::Object(o)) = op.as_object_mut().and_then(|o| o.get_mut(map)) {
		o.insert(k, v);
	}
}

/// What a Member call failed with, as the class the journal logic asks about.
pub fn failure(f: Failure) -> CoreError {
	match f {
		Failure::Transport(m) => error("TransportFailure", m),
		Failure::Refused { code, message } => {
			let class = ["ReplicaConfigPending", "StalePolicyVersion", "RequestConflict", "RequestExpired", "ResultExpired", "IncarnationChanged", "NotCommitted", "TransactionError", "CompletionViolation"];
			error(class.into_iter().find(|c| *c == code).unwrap_or("RemoteError"), message)
		}
	}
}

/// What `FederatedSpace` asks of the Members (`FederationIO`) and of the routing.
pub trait FederationIo {
	fn state(&self) -> R<Json>;
	fn step(&self, member: &str, principal: &Json, method: &str, args: &Json, policy_version: Option<&Json>, origin: Option<&Json>) -> Local<R<Json>>;
	fn snapshot(&self, member: &str, principal: &Json, template: &Json, txn: Option<&Json>) -> Local<R<Json>>;
	fn events(&self, member: &str, principal: &Json, registration: &Json) -> Local<R<Json>>;
	fn ack(&self, member: &str, principal: &Json, epoch: &str, seq: f64) -> Local<R<()>>;
	fn txn_active(&self, member: &str, principal: &Json, txn: &str, registration: Option<&Json>) -> Local<R<bool>>;
}

/// The fixed topology, for what runs inside a router's commit.
#[derive(Clone)]
struct Layout {
	id: String,
	partitions: f64,
	router_ids: Vec<String>,
}
impl Layout {
	fn parent_key(&self, partition: f64) -> R<String> { parent_journal_key(&self.id, self.partitions, partition) }
	fn ids(&self) -> Json { phi_json::strings(&self.router_ids) }
	/// `layoutIn`.
	fn check_in(&self, tx: &mut Tx<'_>) -> R<usize> {
		let at = tx.doc(LAYOUT, &self.id, empty_layout)?;
		if tx.at(at).get("partitions").is_none_or(Json::is_null) {
			// An existing legacy journal cannot silently become invisible in another topology.
			let legacy = tx.doc(OPERATIONS, &self.id, empty_operations)?;
			if self.partitions > 1.0 && !operations(tx.at(legacy)).is_empty() {
				return Err(routing("legacy history requires explicit journal migration"));
			}
			set(tx.at(at), "partitions", self.partitions);
			set(tx.at(at), "routerIds", self.ids());
		} else {
			let same = num_of(tx.at(at), "partitions") == Some(self.partitions) && hash(tx.at(at).get("routerIds").unwrap_or(&Json::Null))? == hash(&self.ids())?;
			if !same {
				return Err(routing("persisted journal topology differs; explicit migration required"));
			}
		}
		Ok(at)
	}
	/// `storeParentIn`: a parent, in the commit of its child.
	fn store_parent_in(&self, tx: &mut Tx<'_>, op: &Json) -> R<()> {
		if bytes(op) > SLOT {
			return Err(routing("operation result/event budget exceeded"));
		}
		let at = self.check_in(tx)?;
		if tx.at(at).get("reconciliation").is_some() {
			return Err(routing("restore reconciliation blocks Parent completion"));
		}
		let id = text(op, "id").unwrap_or("");
		let partition = operation_partition(id, self.partitions)?;
		let doc = tx.doc(OPERATIONS, &self.parent_key(partition)?, empty_operations)?;
		if tx.at(doc).get("operations").and_then(|o| o.get(id)).and_then(|o| o.get("hash")) != op.get("hash") {
			return Err(routing("missing or conflicting parent history"));
		}
		operations_mut(tx.at(doc)).insert(id, op.clone());
		Ok(())
	}
	fn verify(&self, d: &Json, partition: f64) -> R<()> {
		let list = operations(d);
		let mut fine = list.len() <= MAX_OPERATIONS && num_of(d, "reservedBytes") == Some(list.len() as f64 * SLOT);
		for (id, op) in &list {
			fine = fine && text(op, "id") == Some(id) && operation_partition(id, self.partitions)? == partition && bytes(op) <= SLOT;
		}
		if fine { Ok(()) } else { Err(routing("incomplete or corrupt parent journal reconstruction")) }
	}
}

pub struct FederatedSpace<E: RouterEnv + Clone, I: FederationIo> {
	env: E,
	io: I,
	router: RouterController<E>,
	partition_routers: Vec<RouterController<E>>,
	layout: Layout,
	control_space: Option<String>,
}

impl<E: RouterEnv + Clone, I: FederationIo> FederatedSpace<E, I> {
	/// `partition_routers` is empty for one partition: the router itself is that partition.
	pub fn new(env: E, io: I, id: &str, router: RouterController<E>, partition_routers: Vec<RouterController<E>>, control_space: Option<&str>) -> R<Self> {
		let partitions = partition_routers.len().max(1) as f64;
		validate_journal_partitions(partitions).map_err(|e| error("TypeError", e.message))?;
		let router_ids: Vec<String> = if partition_routers.is_empty() { vec![router.journal_id().to_owned()] } else { partition_routers.iter().map(|r| r.journal_id().to_owned()).collect() };
		let mut seen = router_ids.clone();
		seen.sort();
		seen.dedup();
		if seen.len() != router_ids.len() || (partitions > 1.0 && router_ids.iter().any(|r| r == router.journal_id())) {
			return Err(error("TypeError", "distinct fixed partition routers required"));
		}
		Ok(FederatedSpace { env, io, router, partition_routers, layout: Layout { id: id.to_owned(), partitions, router_ids }, control_space: control_space.map(str::to_owned) })
	}
	fn router(&mut self, id: &str) -> R<&mut RouterController<E>> {
		let partition = operation_partition(id, self.layout.partitions)? as usize;
		Ok(if self.partition_routers.is_empty() { &mut self.router } else { &mut self.partition_routers[partition] })
	}
	/// Every journal this space owns, in `recoverMany`'s order.
	pub async fn recover_journals(&mut self) -> R<()> {
		let mut all: Vec<&mut RouterController<E>> = vec![&mut self.router];
		all.extend(self.partition_routers.iter_mut());
		RouterController::recover_many(&mut all).await
	}

	/// `initializeJournals`.
	pub async fn initialize_journals(&self) -> R<()> {
		self.env.assert_authority().await?;
		let mut tx = Tx::new(&self.env);
		self.layout.check_in(&mut tx)?;
		self.env.assert_authority().await?;
		tx.commit()
	}
	async fn ensure_layout(&self) -> R<()> { self.ensure_layout_with(false).await }
	async fn ensure_layout_with(&self, allow_reconciliation: bool) -> R<()> {
		let layout = self.env.read(LAYOUT, &self.layout.id)?;
		let Some(l) = layout.filter(|l| l.get("partitions").is_some_and(|p| !p.is_null())) else { return self.initialize_journals().await };
		if l.get("reconciliation").is_some() && !allow_reconciliation {
			return Err(unavailable("journal restore reconciliation is incomplete"));
		}
		if num_of(&l, "partitions") != Some(self.layout.partitions) || hash(l.get("routerIds").unwrap_or(&Json::Null))? != hash(&self.layout.ids())? {
			return Err(routing("persisted journal topology differs; explicit migration required"));
		}
		Ok(())
	}

	async fn change<T>(&self, partition: f64, f: impl FnOnce(&mut Json, &mut Tx<'_>) -> R<T>) -> R<T> { self.change_with(partition, false, f).await }
	async fn change_with<T>(&self, partition: f64, allow_reconciliation: bool, f: impl FnOnce(&mut Json, &mut Tx<'_>) -> R<T>) -> R<T> {
		self.env.assert_authority().await?;
		self.env.assert_authority().await?;
		let mut tx = Tx::new(&self.env);
		let at = self.layout.check_in(&mut tx)?;
		if tx.at(at).get("reconciliation").is_some() && !allow_reconciliation {
			return Err(unavailable("journal restore reconciliation is incomplete"));
		}
		let doc = tx.doc(OPERATIONS, &self.layout.parent_key(partition)?, empty_operations)?;
		let mut d = std::mem::replace(tx.at(doc), Json::Null);
		self.layout.verify(&d, partition)?;
		let r = f(&mut d, &mut tx)?;
		self.layout.verify(&d, partition)?;
		if bytes(&d) > num_of(&d, "reservedBytes").unwrap_or(0.0) + 4096.0 {
			return Err(routing("composite journal exceeded reserved bytes"));
		}
		*tx.at(doc) = d;
		self.env.assert_authority().await?;
		tx.commit()?;
		Ok(r)
	}
	async fn get(&self, id: &str) -> R<Option<Json>> {
		self.env.assert_authority().await?;
		self.ensure_layout().await?;
		let partition = operation_partition(id, self.layout.partitions)?;
		let d = self.env.read(OPERATIONS, &self.layout.parent_key(partition)?)?;
		if let Some(d) = &d {
			self.layout.verify(d, partition)?;
		}
		Ok(d.and_then(|d| d.get("operations").and_then(|o| o.get(id)).cloned()))
	}
	fn assert_no_erasure(&self) -> R<()> {
		let d = self.env.read(ERASURES, &self.layout.id)?;
		if d.as_ref().is_some_and(|d| operations(d).iter().any(|(_, op)| text(op, "phase") != Some("completed"))) {
			return Err(unavailable("Root principal erasure is pending"));
		}
		Ok(())
	}

	async fn prepare(&mut self, kind: &str, args: Json, q: &Json) -> R<Json> {
		self.assert_no_erasure()?;
		let id = text(q, "id").unwrap_or("").to_owned();
		if !valid_id(&id) {
			return Err(routing("invalid operation ID"));
		}
		let principal = q.get("principal").cloned().unwrap_or(Json::Null);
		let txn = q.get("txn").filter(|t| !t.is_null());
		let h = hash(&Json::Array(vec![kind.into(), args.clone(), principal.clone(), txn.cloned().unwrap_or(Json::Null)]))?;
		if let Some(op) = self.get(&id).await? {
			if text(&op, "hash") != Some(&h) {
				return Err(routing("operation ID changed arguments"));
			}
			return Ok(op);
		}
		let st = self.io.state()?;
		let null = Json::Null;
		let p = st.get("policy").filter(|p| !p.is_null()).ok_or_else(|| routing("no installed policy"))?;
		let table = st.get("members").unwrap_or(&null);
		// v3 7.2: merge types (lww/set) know no exclusive allocation; refused before any Member is called.
		let merge_type = if kind == "write" { args.get("entry").and_then(|e| text(e, "type")) } else { args.get("template").and_then(|t| text(t, "type")) };
		if is_merge_type(p, merge_type) && (kind == "take" || kind == "race" || txn.is_some()) {
			return Err(error("MergeTypeNotExclusive", format!("{} is not available for merge types (lww/set)", if txn.is_some() { "a transaction" } else { kind })));
		}
		let now = self.env.now();
		let mut ids = match kind {
			"txn" => names(Some(&Json::Array(vec![args.get("member").cloned().unwrap_or(Json::Null)]))),
			"write" => vec![write_member(p, table, args.get("entry").unwrap_or(&null), now)?],
			_ => search_members(p, args.get("template").unwrap_or(&null))?,
		};
		if let Some(t) = txn {
			let origin = match text(t, "originId").filter(|o| !o.is_empty()) {
				Some(o) => self.get(o).await?,
				None => None,
			};
			let member = text(t, "member").unwrap_or("").to_owned();
			let bound = origin.is_some_and(|o| text(&o, "kind") == Some("txn") && text(&o, "phase") == Some("done") && members(&o).first() == Some(&member) && o.get("result").and_then(|r| r.get("id")) == t.get("id") && hash(o.get("principal").unwrap_or(&null)).ok() == hash(&principal).ok());
			if !bound {
				return Err(routing("transaction has no original principal/Member binding"));
			}
			if ids.iter().any(|i| *i != member) {
				return Err(routing("transaction is bound to another Member"));
			}
			ids = vec![member];
		}
		if ids.is_empty() || ids.len() > 8 {
			return Err(routing("composite target set exceeds bounded fanout"));
		}
		let policy_version = p.get("policyVersion").cloned().unwrap_or(Json::Null);
		let mut o = Object::new();
		o.insert("id", id.as_str().into());
		o.insert("hash", h.into());
		o.insert("principal", principal);
		o.insert("policyVersion", policy_version.clone());
		o.insert("members", phi_json::strings(&ids));
		o.insert("targets", Json::Array(ids.iter().map(|i| table.get(i).and_then(|m| m.get("target")).cloned().unwrap_or(Json::Null)).collect()));
		o.insert("kind", kind.into());
		o.insert("args", args.clone());
		o.insert("phase", "admitting".into());
		if let Some(ms) = num_of(&args, "timeoutMs").filter(|m| *m > 0.0) {
			o.insert("deadline", (now + ms).into());
		}
		o.insert("children", Json::Object(Object::new()));
		o.insert("registrations", Json::Object(Object::new()));
		o.insert("cursor", 0.0.into());
		o.insert("candidates", Json::Object(Object::new()));
		if let Some(t) = txn {
			o.insert("userTxn", t.clone());
		}
		let with_parent = ids.len() == 1 && kind != "race";
		if with_parent {
			o.insert("budgetWithParent", Json::Bool(true));
		}
		let op = Json::Object(o);
		let budget = child(&id, "budget")?;
		let partition = operation_partition(&id, self.layout.partitions)?;
		let control = self.control_space.clone();
		let reserve = |tx: &mut Tx<'_>, this: &RouterController<E>| if with_parent { this.reserve_future_in(tx, &budget, 1.0, CHILD_BYTES) } else { Ok(()) };
		let router: &RouterController<E> = if self.partition_routers.is_empty() { &self.router } else { &self.partition_routers[partition as usize] };
		self.change(partition, |d, tx| {
			if let Some(control) = &control {
				let at = tx.doc(PROFILES, control, empty_operations_only)?;
				if operations(tx.at(at)).iter().any(|(_, t)| text(t, "phase") != Some("completed") && t.get("members").and_then(Json::as_array).is_some_and(|m| m.iter().any(|x| text(x, "id").is_some_and(|x| ids.iter().any(|i| i == x))))) {
					return Err(routing("profile transition blocks new Root admission"));
				}
				let at = tx.doc(ROUTING, control, empty_routing)?;
				let current = tx.at(at).clone();
				let at = tx.doc(MEMBERSHIP, control, empty_operations_only)?;
				let jobs = tx.at(at).clone();
				let member_of = |i: &String| current.get("members").and_then(|m| m.get(i));
				let same = current.get("policy").and_then(|p| p.get("policyVersion")) == Some(&policy_version) && ids.iter().all(|i| member_of(i).is_some_and(|m| matches!(text(m, "state"), Some("active" | "draining"))));
				let busy = operations(&jobs).iter().any(|(_, job)| !matches!(text(job, "phase"), Some("completed" | "failed")) && job.get("member").and_then(|m| text(m, "id")).is_some_and(|m| ids.iter().any(|i| i == m)));
				if !same || busy {
					return Err(routing("routing/membership changed before admission"));
				}
			}
			if operations(d).len() >= MAX_OPERATIONS {
				return Err(routing("composite operation history full"));
			}
			if operations(d).iter().any(|(k, _)| *k == id) {
				return Err(routing("concurrent admission"));
			}
			reserve(tx, router)?;
			operations_mut(d).insert(&id, op.clone());
			let reserved = num_of(d, "reservedBytes").unwrap_or(0.0) + SLOT;
			set(d, "reservedBytes", reserved);
			Ok(())
		}).await?;
		Ok(op)
	}

	async fn transaction_origin_step(&mut self, origin_id: &str, member: &str) -> R<Json> {
		let origin = self.get(origin_id).await?.filter(|o| text(o, "kind") == Some("txn") && text(o, "phase") == Some("done") && members(o).first().is_some_and(|m| m == member)).ok_or_else(|| routing("transaction origin changed"))?;
		let command = self.router(origin_id)?.get(&child_of(&origin, member)).await?;
		command.filter(|c| text(c, "state") == Some("completed")).and_then(|c| c.get("steps")?.as_array()?.first().cloned()).ok_or_else(|| routing("transaction origin claim unavailable"))
	}
	async fn save(&self, op: &Json) -> R<()> {
		if bytes(op) > SLOT {
			return Err(routing("operation result/event budget exceeded"));
		}
		let id = text(op, "id").unwrap_or("").to_owned();
		let partition = operation_partition(&id, self.layout.partitions)?;
		self.change(partition, |d, _| {
			if d.get("operations").and_then(|o| o.get(&id)).and_then(|o| o.get("hash")) != op.get("hash") {
				return Err(routing("missing or conflicting parent history"));
			}
			operations_mut(d).insert(&id, op.clone());
			Ok(())
		}).await
	}

	async fn admit(&mut self, mut op: Json) -> R<Json> {
		if text(&op, "phase") != Some("admitting") {
			return Ok(op);
		}
		let id = text(&op, "id").unwrap_or("").to_owned();
		let kind = text(&op, "kind").unwrap_or("").to_owned();
		let all = members(&op);
		let budget = child(&id, "budget")?;
		if op.get("budgetWithParent").is_none() {
			let slots = all.len() as f64 * if kind == "race" { 4.0 } else { 1.0 };
			self.router(&id)?.reserve_future(&budget, slots, Some(CHILD_BYTES)).await?;
		}
		let null = Json::Null;
		for member in &all {
			let label = format!("initial:{member}");
			let child_id = child(&id, &label)?;
			let method = if kind == "race" { "wait" } else { kind.as_str() };
			let mut a = op.get("args").cloned().unwrap_or(Json::Null);
			if let Some(d) = op.get("deadline") {
				set(&mut a, "deadline", d.clone());
			}
			if kind == "race" {
				let take = op.get("args").and_then(|x| x.get("take")) != Some(&Json::Bool(false));
				set(&mut a, "take", take);
				set(&mut a, "handback", obj! { "federationOperation" => id.as_str() });
			}
			let user_txn = op.get("userTxn").cloned();
			if let Some(t) = &user_txn {
				set(&mut a, "txn", t.get("id").cloned().unwrap_or(Json::Null));
			}
			if self.router(&id)?.get(&child_id).await?.is_some() {
				insert_in(&mut op, "children", member, child_id.as_str().into());
				self.save(&op).await?;
				continue;
			}
			let origin_id = if kind == "txn" { a.get("originId").filter(|o| phi_core::space::truthy(Some(o))) } else { None }.or_else(|| user_txn.as_ref().and_then(|t| t.get("originId")).filter(|o| phi_core::space::truthy(Some(o)))).and_then(Json::as_str).map(str::to_owned);
			let origin = match &origin_id {
				Some(o) => Some(self.transaction_origin_step(o, member).await?),
				None => None,
			};
			let spec = match self.io.step(member, op.get("principal").unwrap_or(&null), method, &a, op.get("policyVersion"), origin.as_ref()).await {
				Ok(s) => s,
				// No effect has been dispatched; keep the persisted routing plan and reservation.
				// The same while the Member waits for the router to adopt its replica configuration (v3 5.3.1 step 5).
				Err(e) if e.class == "TransportFailure" || e.class == "ReplicaConfigPending" => return Err(pending()),
				Err(e) => return Err(e),
			};
			let state = self.io.state()?;
			let expected = state.get("members").and_then(|m| m.get(member)).and_then(|m| m.get("target"));
			let bound = match expected {
				Some(t) => hash(spec.get("target").unwrap_or(&null))? == hash(t)? && hash(spec.get("principal").unwrap_or(&null))? == hash(op.get("principal").unwrap_or(&null))? && text(&spec, "method") == Some(method) && hash(spec.get("args").unwrap_or(&null))? == hash(&a)? && spec.get("policyVersion").is_none_or(|v| Some(v) == op.get("policyVersion")),
				None => false,
			};
			if !bound {
				return Err(routing("target/principal adapter binding mismatch"));
			}
			let command = obj! { "id" => child_id.as_str(), "area" => "federation", "steps" => vec![spec] };
			let single = all.len() == 1 && kind != "race";
			let mut attached: Option<Json> = None;
			let layout = self.layout.clone();
			let current = op.clone();
			let mut hook = |c: &Json, tx: &mut Tx<'_>, _: &mut Json, room: f64| -> R<()> {
				let mut next = current.clone();
				insert_in(&mut next, "children", member, child_id.as_str().into());
				set(&mut next, "phase", "ready");
				if bytes(&next) > room {
					return Ok(());
				}
				if text(c, "id") != Some(&child_id) || c.get("steps").and_then(Json::as_array).is_none_or(|s| s.len() != 1) {
					return Err(routing("Child admission changed binding"));
				}
				layout.store_parent_in(tx, &next)?;
				attached = Some(next);
				Ok(())
			};
			let hooks: Option<crate::router::CommitHook<'_, '_>> = if single { Some(&mut hook) } else { None };
			self.router(&id)?.submit(&command, Some(&budget), hooks).await?;
			match attached {
				Some(next) => op = next,
				None => {
					insert_in(&mut op, "children", member, child_id.as_str().into());
					self.save(&op).await?;
				}
			}
		}
		if text(&op, "phase") != Some("ready") {
			set(&mut op, "phase", "ready");
			self.save(&op).await?;
		}
		Ok(op)
	}

	async fn finish(&mut self, mut op: Json, result: Json) -> R<Json> {
		set(&mut op, "phase", "done");
		set(&mut op, "result", result.clone());
		self.save(&op).await?;
		let id = text(&op, "id").unwrap_or("").to_owned();
		self.router(&id)?.release_future(&child(&id, "budget")?).await?;
		Ok(result)
	}
	/// What is settled before work starts: a finished operation, or one that needs a person.
	async fn settled(&mut self, op: &Json) -> R<Option<Json>> {
		if op.get("erased").is_some() {
			return Err(erased());
		}
		match text(op, "phase") {
			Some("done") => {
				// A crash after the Parent commit can precede releasing unused child reservations.
				let id = text(op, "id").unwrap_or("").to_owned();
				self.router(&id)?.release_future(&child(&id, "budget")?).await?;
				Ok(Some(op.get("result").cloned().unwrap_or(Json::Null)))
			}
			Some("needsReview") => Err(unavailable("operation needs explicit review")),
			_ => Ok(None),
		}
	}
	async fn needs_review(&self, mut op: Json, why: &str) -> R<Json> {
		set(&mut op, "phase", "needsReview");
		self.save(&op).await?;
		Err(unavailable(why))
	}

	async fn decide(&mut self, op: Json) -> R<Json> {
		if let Some(done) = self.settled(&op).await? {
			return Ok(done);
		}
		let mut op = self.admit(op).await?;
		let id = text(&op, "id").unwrap_or("").to_owned();
		let kind = text(&op, "kind").unwrap_or("").to_owned();
		let all = members(&op);
		let budget = child(&id, "budget")?;
		let mut cursor = num_of(&op, "cursor").unwrap_or(0.0) as usize;
		while cursor < all.len() {
			set(&mut op, "cursor", cursor as f64);
			let m = &all[cursor];
			let child_id = child_of(&op, m);
			let (layout, current) = (self.layout.clone(), op.clone());
			let mut finalized: Option<Json> = None;
			let mut hook = |c: &Json, tx: &mut Tx<'_>, i: &mut Json, room: f64| -> R<()> {
				let first = c.get("steps").and_then(Json::as_array).filter(|s| s.len() == 1).and_then(|s| s.first());
				let Some(step) = first.filter(|s| text(c, "id") == Some(&child_id) && text(s, "state") == Some("done")) else { return Err(routing("Child completion changed binding")) };
				let mut next = current.clone();
				set(&mut next, "phase", "done");
				set(&mut next, "result", step.get("result").cloned().unwrap_or(Json::Null));
				if bytes(&next) > room {
					return Ok(());
				}
				layout.store_parent_in(tx, &next)?;
				release_future_in(i, &budget)?;
				finalized = Some(next);
				Ok(())
			};
			let hooks: Option<crate::router::CommitHook<'_, '_>> = if all.len() == 1 { Some(&mut hook) } else { None };
			let c = self.router(&id)?.advance(&child_of(&op, m), hooks).await?;
			if let Some(next) = finalized {
				return Ok(next.get("result").cloned().unwrap_or(Json::Null));
			}
			let state = text(&c, "state");
			if matches!(state, Some("needsReview" | "failed")) {
				return self.needs_review(op, "definitive child failure or review requires explicit review").await;
			}
			if state != Some("completed") {
				if kind == "read" {
					cursor += 1;
					continue;
				}
				return Err(pending());
			}
			let r = c.get("steps").and_then(Json::as_array).and_then(|s| s.first()).and_then(|s| s.get("result")).cloned().unwrap_or(Json::Null);
			if kind == "write" || kind == "txn" || !r.is_null() {
				return self.finish(op, r).await;
			}
			set(&mut op, "cursor", (cursor + 1) as f64);
			self.save(&op).await?;
			cursor += 1;
		}
		set(&mut op, "cursor", cursor as f64);
		if kind == "read" {
			let mut open = false;
			for m in &all {
				open = open || self.router(&id)?.get(&child_of(&op, m)).await?.is_none_or(|c| text(&c, "state") != Some("completed"));
			}
			if open {
				set(&mut op, "cursor", 0.0);
				self.save(&op).await?;
				return Err(unavailable("some required read outcomes unavailable"));
			}
		}
		self.finish(op, Json::Null).await
	}

	/// `write`.
	pub async fn write(&mut self, entry: &Json, q: &Json, lease_ms: Option<&Json>) -> R<Json> {
		let old = self.get(text(q, "id").unwrap_or("")).await?;
		if old.as_ref().is_some_and(|o| o.get("erased").is_some()) {
			return Err(erased());
		}
		let e = match &old {
			None => {
				let st = self.io.state()?;
				normalize_federated_entry(st.get("policy").filter(|p| !p.is_null()).ok_or_else(|| routing("no policy"))?, entry)?
			}
			Some(o) => {
				let previous = o.get("args").and_then(|a| a.get("entry")).and_then(|e| e.get("types")).cloned().unwrap_or(Json::Null);
				let (known, type_) = (names(Some(&previous)), text(entry, "type").unwrap_or(""));
				if names(entry.get("types")).iter().any(|t| t != type_ && !known.contains(t)) {
					return Err(routing("undeclared retry supertype"));
				}
				let mut e = entry.json_copy();
				set(&mut e, "types", previous);
				e
			}
		};
		let mut args = obj! { "entry" => e };
		if let Some(l) = lease_ms {
			set(&mut args, "leaseMs", l.clone());
		}
		let op = self.prepare("write", args, q).await?;
		self.decide(op).await
	}
	/// `createTransaction`.
	pub async fn create_transaction(&mut self, member: &str, lease_ms: f64, q: &Json) -> R<Json> {
		if q.get("txn").is_some_and(|t| !t.is_null()) || !safe_integer(lease_ms) || !(1.0..=60_000.0).contains(&lease_ms) {
			return Err(routing("transaction requires finite bounded lease"));
		}
		let op = self.prepare("txn", obj! { "member" => member, "action" => "begin", "leaseMs" => lease_ms }, q).await?;
		let mut result = self.decide(op).await?;
		if !matches!(result, Json::Object(_)) {
			result = Json::Object(Object::new());
		}
		set(&mut result, "member", member);
		set(&mut result, "originId", q.get("id").cloned().unwrap_or(Json::Null));
		Ok(result)
	}
	/// `finishTransaction`.
	pub async fn finish_transaction(&mut self, origin_id: &str, action: &str, q: &Json) -> R<Json> {
		let null = Json::Null;
		let origin = self.get(origin_id).await?;
		let Some(origin) = origin.filter(|o| text(o, "kind") == Some("txn") && text(o, "phase") == Some("done") && hash(o.get("principal").unwrap_or(&null)).ok() == hash(q.get("principal").unwrap_or(&null)).ok()) else {
			return Err(routing("transaction is not bound to this principal"));
		};
		let Some(lease) = origin.get("result").and_then(|r| r.get("id")).filter(|i| phi_core::space::truthy(Some(i))) else { return Err(routing("transaction result unavailable")) };
		let args = obj! { "member" => members(&origin).first().map_or("", String::as_str), "action" => action, "id" => lease.clone(), "originId" => origin_id };
		let op = self.prepare("txn", args, q).await?;
		self.decide(op).await
	}
	/// `read`.
	pub async fn read(&mut self, template: &Json, q: &Json) -> R<Json> {
		let op = self.prepare("read", obj! { "template" => template.clone(), "timeoutMs" => 0.0 }, q).await?;
		self.decide(op).await
	}
	/// `take`.
	pub async fn take(&mut self, template: &Json, q: &Json) -> R<Json> {
		let op = self.prepare("take", obj! { "template" => template.clone(), "timeoutMs" => 0.0 }, q).await?;
		self.decide(op).await
	}

	/// `readAll`.
	pub async fn read_all(&self, template: &Json, principal: &Json, allow_partial: bool, wait_ms: Option<f64>, txn: Option<&Json>) -> R<Json> {
		self.env.assert_authority().await?;
		self.assert_no_erasure()?;
		self.ensure_layout().await?;
		let st = self.io.state()?;
		let p = st.get("policy").filter(|p| !p.is_null()).ok_or_else(|| routing("no policy"))?;
		let ids = search_members(p, template)?;
		if txn.is_some_and(|t| ids.iter().any(|i| Some(i.as_str()) != text(t, "member"))) {
			return Err(routing("transaction crosses Members"));
		}
		if allow_partial && wait_ms.is_some() {
			return Err(routing("choose partial or wait-for-complete"));
		}
		let duration = wait_ms.unwrap_or(0.0);
		if !safe_integer(duration) || !(0.0..=60_000.0).contains(&duration) {
			return Err(routing("invalid complete-wait bound"));
		}
		let end = self.env.now() + duration;
		loop {
			self.env.assert_authority().await?;
			let (mut entries, mut revisions, mut missing) = (vec![], Object::new(), vec![]);
			for id in &ids {
				match self.io.snapshot(id, principal, template, txn.and_then(|t| t.get("id"))).await {
					Ok(s) => {
						entries.extend(s.get("entries").and_then(Json::as_array).cloned().unwrap_or_default());
						revisions.insert(id, s.get("revision").cloned().unwrap_or(Json::Null));
					}
					Err(_) => missing.push(id.clone()),
				}
			}
			if missing.is_empty() || allow_partial {
				return Ok(obj! { "entries" => entries, "complete" => missing.is_empty(), "missingMembers" => phi_json::strings(&missing), "revisions" => revisions, "consistentSnapshot" => false });
			}
			let now = self.env.now();
			if now >= end {
				return Err(unavailable(format!("required Member snapshots unavailable: {}", missing.join(","))));
			}
			tokio::time::sleep(std::time::Duration::from_millis((end - now).min(50.0) as u64)).await;
		}
	}
	/// `count`.
	pub async fn count(&self, template: &Json, principal: &Json, allow_partial: bool, wait_ms: Option<f64>, txn: Option<&Json>) -> R<Json> {
		let mut r = self.read_all(template, principal, allow_partial, wait_ms, txn).await?;
		let n = r.get("entries").and_then(Json::as_array).map_or(0, Vec::len) as f64;
		if let Json::Object(o) = &mut r {
			o.remove("entries");
			o.insert("count", n.into());
		}
		Ok(r)
	}

	/// `takeWaiting`.
	pub async fn take_waiting(&mut self, template: &Json, timeout_ms: f64, txn_lease_ms: f64, q: &Json) -> R<Json> {
		if q.get("txn").is_some_and(|t| !t.is_null()) {
			let op = self.prepare("take", obj! { "template" => template.clone(), "timeoutMs" => timeout_ms }, q).await?;
			return self.decide(op).await;
		}
		if !safe_integer(timeout_ms) || !(1.0..=3_600_000.0).contains(&timeout_ms) || !safe_integer(txn_lease_ms) || !(1.0..=60_000.0).contains(&txn_lease_ms) {
			return Err(routing("race requires finite bounded leases"));
		}
		let op = self.prepare("race", obj! { "template" => template.clone(), "timeoutMs" => timeout_ms, "txnLeaseMs" => txn_lease_ms }, q).await?;
		self.progress_race(op).await
	}
	/// `readWaiting`.
	pub async fn read_waiting(&mut self, template: &Json, timeout_ms: f64, q: &Json) -> R<Json> {
		if !safe_integer(timeout_ms) || !(1.0..=3_600_000.0).contains(&timeout_ms) {
			return Err(routing("read waiting requires bounded timeout"));
		}
		if q.get("txn").is_some_and(|t| !t.is_null()) {
			let op = self.prepare("read", obj! { "template" => template.clone(), "timeoutMs" => timeout_ms }, q).await?;
			return self.decide(op).await;
		}
		let op = self.prepare("race", obj! { "template" => template.clone(), "timeoutMs" => timeout_ms, "txnLeaseMs" => 1.0, "take" => false }, q).await?;
		self.progress_race(op).await
	}

	async fn step_of(&mut self, id: &str, command: &str) -> R<Json> {
		let c = self.router(id)?.get(command).await?;
		Ok(c.and_then(|c| c.get("steps")?.as_array()?.first().cloned()).unwrap_or(Json::Null))
	}

	async fn effect(&mut self, op: &Json, m: &str, label: &str, method: &str, args: Json) -> R<Option<Json>> {
		let id = text(op, "id").unwrap_or("").to_owned();
		let child_id = child(&id, label)?;
		if self.router(&id)?.get(&child_id).await?.is_none() {
			let origin = self.step_of(&id, &child_of(op, m)).await?;
			let step = self.io.step(m, op.get("principal").unwrap_or(&Json::Null), method, &args, op.get("policyVersion"), Some(&origin)).await?;
			self.router(&id)?.submit(&obj! { "id" => child_id.as_str(), "area" => "federation", "steps" => vec![step] }, Some(&child(&id, "budget")?), None).await?;
		}
		let c = self.router(&id)?.advance(&child_id, None).await?;
		let state = text(&c, "state");
		let first = c.get("steps").and_then(Json::as_array).and_then(|s| s.first());
		let evidence = first.and_then(|s| text(s, "evidence"));
		if state == Some("failed") && ((label.starts_with("cancel:") && matches!(evidence, Some("UnknownLeaseError" | "TransactionError"))) || (label.starts_with("abort:") && evidence == Some("TransactionError"))) {
			return Ok(None);
		}
		if matches!(state, Some("failed" | "needsReview")) {
			self.needs_review(op.clone(), "definitive child failure needs review").await?;
		}
		if state != Some("completed") {
			return Err(pending());
		}
		Ok(first.and_then(|s| s.get("result")).cloned())
	}

	async fn collect_race_events(&mut self, op: &mut Json) -> R<()> {
		let id = text(op, "id").unwrap_or("").to_owned();
		let principal = op.get("principal").cloned().unwrap_or(Json::Null);
		for m in members(op) {
			let step = self.step_of(&id, &child_of(op, &m)).await?;
			let page = self.io.events(&m, &principal, &step).await?;
			if phi_core::space::truthy(page.get("gap")) {
				return self.needs_review(op.clone(), "race mailbox gap needs review").await.map(|_| ());
			}
			let epoch = page.get("epoch").cloned().unwrap_or(Json::Null);
			for item in page.get("events").and_then(Json::as_array).cloned().unwrap_or_default() {
				let e = item.get("event").cloned().unwrap_or(Json::Null);
				let key = hash(&Json::Array(vec![m.as_str().into(), epoch.clone(), item.get("seq").cloned().unwrap_or(Json::Null)]))?;
				if !candidates(op).iter().any(|(k, _)| *k == key) {
					let mut candidate = obj! { "member" => m.as_str(), "event" => e.clone() };
					if let Some(t) = e.get("txn").filter(|t| phi_core::space::truthy(Some(t))) {
						set(&mut candidate, "txn", t.clone());
					}
					if let Some(x) = e.get("entry").filter(|t| phi_core::space::truthy(Some(t))) {
						set(&mut candidate, "entry", x.clone());
					}
					let owner = e.get("handback").and_then(|h| text(h, "federationOperation")).filter(|o| *o != id);
					if let Some(owner_id) = owner {
						let partition = operation_partition(owner_id, self.layout.partitions)?;
						let (member, who) = (m.clone(), principal.clone());
						self.change(partition, |d, _| {
							let held = operations_mut(d).get_mut(owner_id);
							let Some(owner) = held.filter(|o| hash(o.get("principal").unwrap_or(&Json::Null)).ok() == hash(&who).ok() && members(o).contains(&member)) else {
								return Err(routing("mailbox event has no bound operation owner"));
							};
							insert_in(owner, "candidates", &key, candidate);
							if bytes(owner) > SLOT {
								return Err(routing("mailbox owner budget exceeded"));
							}
							Ok(())
						}).await?;
					} else if own_event(op, &m, Some(&e)) {
						insert_in(op, "candidates", &key, candidate);
						self.save(op).await?;
					} else {
						return Err(unavailable("unrelated mailbox event requires its owning dispatcher"));
					}
				}
				self.io.ack(&m, &principal, epoch.as_str().unwrap_or(""), num_of(&item, "seq").unwrap_or(0.0)).await?;
			}
		}
		Ok(())
	}

	async fn progress_race(&mut self, op: Json) -> R<Json> {
		if let Some(done) = self.settled(&op).await? {
			return Ok(done);
		}
		let mut op = self.admit(op).await?;
		let id = text(&op, "id").unwrap_or("").to_owned();
		let principal = op.get("principal").cloned().unwrap_or(Json::Null);
		let all = members(&op);
		for m in &all {
			let c = self.router(&id)?.advance(&child_of(&op, m), None).await?;
			let state = text(&c, "state");
			if matches!(state, Some("failed" | "needsReview")) {
				return self.needs_review(op, "definitive child failure or review requires explicit review").await;
			}
			if state != Some("completed") {
				return Err(pending());
			}
			let r = c.get("steps").and_then(Json::as_array).and_then(|s| s.first()).and_then(|s| s.get("result")).cloned().unwrap_or(Json::Null);
			if r.is_null() {
				return Err(error("TypeError", "a registration without a result"));
			}
			if let Some(registered) = if r.as_str().is_some() { Some(&r) } else { r.get("id") } {
				insert_in(&mut op, "registrations", m, registered.clone());
			}
			self.save(&op).await?;
		}
		self.collect_race_events(&mut op).await?;
		if op.get("winner").is_none() {
			let take = op.get("args").and_then(|a| a.get("take")) != Some(&Json::Bool(false));
			let list: Vec<Json> = candidates(&op).iter().map(|(_, c)| (*c).clone()).collect();
			for candidate in list {
				let member = text(&candidate, "member").unwrap_or("").to_owned();
				let own = own_event(&op, &member, candidate.get("event"));
				if !own || candidate.get("entry").is_none() {
					continue;
				}
				let txn = text(&candidate, "txn");
				let wins = !take || match txn {
					Some(t) => {
						let step = self.step_of(&id, &child_of(&op, &member)).await?;
						self.io.txn_active(&member, &principal, t, Some(&step)).await?
					}
					None => false,
				};
				if wins {
					set(&mut op, "winner", obj! { "member" => member.as_str(), "txn" => txn.unwrap_or(""), "entry" => candidate.get("entry").cloned().unwrap_or(Json::Null) });
					self.save(&op).await?;
					break;
				}
			}
		}
		let winner_txn = op.get("winner").and_then(|w| text(w, "txn")).filter(|t| !t.is_empty()).map(str::to_owned);
		if let Some(t) = &winner_txn {
			let member = op.get("winner").and_then(|w| text(w, "member")).unwrap_or("").to_owned();
			self.effect(&op, &member, "winner-commit", "txn", obj! { "action" => "commit", "id" => t.as_str() }).await?;
		}
		let timed_out = all.iter().all(|m| candidates(&op).iter().any(|(_, c)| text(c, "member") == Some(m) && own_event(&op, m, c.get("event")) && c.get("event").is_some_and(|e| text(e, "kind") == Some("timeout"))));
		if op.get("winner").is_none() && !timed_out {
			return Err(pending());
		}
		for m in &all {
			let args = obj! { "action" => "cancel", "id" => registration(&op, m).cloned().unwrap_or(Json::Null) };
			self.effect(&op, m, &format!("cancel:{m}"), "lease", args).await?;
		}
		self.collect_race_events(&mut op).await?;
		for m in &all {
			let aborts: Vec<String> = candidates(&op).iter().filter(|(_, c)| text(c, "member") == Some(m) && own_event(&op, m, c.get("event"))).filter_map(|(_, c)| text(c, "txn")).filter(|t| Some(*t) != winner_txn.as_deref()).map(str::to_owned).collect();
			for t in aborts {
				self.effect(&op, m, &format!("abort:{m}"), "txn", obj! { "action" => "abort", "id" => t.as_str() }).await?;
			}
		}
		if let Some(entry) = op.get("winner").and_then(|w| w.get("entry")).cloned() {
			return self.finish(op, entry).await;
		}
		self.finish(op, Json::Null).await
	}

	/// `resume`.
	/// `reconcileDataRestore`: parents too, completed and not yet sent children included, go to review; nothing is
	/// replayed. The layout carries the restore while it runs, so a broken reconciliation is retried, not passed by.
	pub async fn reconcile_data_restore(&mut self, o: &Json) -> R<Vec<String>> {
		let keys = ["hostId", "spaceId", "oldIncarnation", "recoveryId"];
		let fine = o.as_object().is_some_and(|m| m.iter().all(|(k, v)| keys.contains(&k) && v.as_str().is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= 256)));
		if !fine {
			return Err(routing("invalid restore journal binding"));
		}
		let id = o.get("recoveryId").map_or_else(|| "undefined".to_owned(), phi_core::space::js_string);
		let b = id.as_bytes();
		if b.is_empty() || b.len() > 128 || !b[0].is_ascii_alphanumeric() || !b[1..].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-')) || ["constructor", "prototype", "__proto__"].contains(&id.as_str()) {
			return Err(routing("invalid recovery ID"));
		}
		self.ensure_layout_with(true).await?;
		let wanted = hash(o)?;
		self.env.assert_authority().await?;
		let mut tx = Tx::new(&self.env);
		let at = self.layout.check_in(&mut tx)?;
		if let Some(r) = tx.at(at).get("reconciliation").filter(|r| !r.is_null()) {
			if hash(r)? != wanted {
				return Err(routing("another journal restore reconciliation is incomplete"));
			}
		}
		set(tx.at(at), "reconciliation", o.clone());
		self.env.assert_authority().await?;
		tx.commit()?;
		let mut children = std::collections::HashSet::new();
		children.extend(self.router.reconcile_data_restore(o).await?);
		for r in self.partition_routers.iter_mut() {
			children.extend(r.reconcile_data_restore(o).await?);
		}
		let st = self.io.state()?;
		let bound = |t: &Json| t.get("hostId") == o.get("hostId") && t.get("spaceId") == o.get("spaceId") && t.get("dataIncarnation") == o.get("oldIncarnation");
		let affected_members: Vec<String> = st.get("members").and_then(Json::as_object).map_or(vec![], |m| m.iter().filter(|(_, m)| m.get("target").is_some_and(bound)).filter_map(|(_, m)| text(m, "id").map(str::to_owned)).collect());
		let mut affected = vec![];
		// one bounded parent document per commit; a partial reconciliation is retried
		for partition in 0..self.layout.partitions as u64 {
			let ids = self.change_with(partition as f64, true, |d, _| {
				let mut ids = vec![];
				let keys: Vec<String> = operations(d).iter().map(|(k, _)| (*k).to_owned()).collect();
				for k in keys {
					let op = operations_mut(d).get_mut(&k).expect("listed");
					let targets = op.get("targets").and_then(Json::as_array).is_some_and(|t| t.iter().any(bound));
					let named = members(op).iter().any(|m| affected_members.contains(m));
					let child = op.get("children").and_then(Json::as_object).is_some_and(|c| c.iter().any(|(_, v)| v.as_str().is_some_and(|v| children.contains(v))));
					if !targets && !named && !child {
						continue;
					}
					set(op, "phase", "needsReview");
					ids.push(text(op, "id").unwrap_or("").to_owned());
				}
				Ok(ids)
			}).await?;
			affected.extend(ids);
		}
		self.env.assert_authority().await?;
		let mut tx = Tx::new(&self.env);
		let at = self.layout.check_in(&mut tx)?;
		if hash(tx.at(at).get("reconciliation").unwrap_or(&Json::Null))? != wanted {
			return Err(routing("restore reconciliation changed"));
		}
		if let Some(l) = tx.at(at).as_object_mut() {
			l.remove("reconciliation");
		}
		self.env.assert_authority().await?;
		tx.commit()?;
		Ok(affected)
	}

	pub async fn resume(&mut self, id: &str) -> R<Json> {
		self.assert_no_erasure()?;
		let op = self.get(id).await?.ok_or_else(|| routing("unknown federation operation"))?;
		if text(&op, "kind") == Some("race") { self.progress_race(op).await } else { self.decide(op).await }
	}
}
