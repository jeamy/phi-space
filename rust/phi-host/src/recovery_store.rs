//! The store a recovery step works on (`Pick<StoreHost, "commit" | "snapshot">`, the raw host without the boot guard): the
//! host's own store behind the running transport, or a store a recovery-only service holds alone. Every commit is
//! awaited until it is durable before the step goes on, as TypeScript awaits `host.commit`: what the register is told
//! next must never be ahead of the disk.
use crate::recovery_rpc::{blocked, RecoveryError, RR};
use phi_core::{CoreError, Space};
use phi_json::Json;
use phi_service::Service;
use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone)]
pub enum StoreLine {
	Wire(phi_wire::Owner),
	Local(Rc<RefCell<Service>>),
}

impl StoreLine {
	pub fn with<T>(&self, f: impl FnOnce(&mut Service) -> T) -> T {
		match self {
			StoreLine::Wire(o) => o.with(f),
			StoreLine::Local(s) => f(&mut s.borrow_mut()),
		}
	}
	pub fn now(&self) -> f64 { self.with(|s| s.now()) }
	async fn durable(&self) -> RR<()> {
		match self {
			StoreLine::Wire(o) => o.durable().await.map_err(blocked),
			StoreLine::Local(s) => s.borrow_mut().store.drain().map_err(|e| blocked(e.to_string())),
		}
	}
	/// One commit on a Space (`spaceDoc`) at `now`, outside the boot guard, made durable before it answers.
	pub async fn commit<T>(&self, space: Option<&str>, now: f64, op: impl FnOnce(&mut Space) -> Result<T, RecoveryError>) -> RR<T> {
		let failed = RefCell::new(None);
		let r = self.with(|s| {
			s.store.commit(space, now, |sp| op(sp).map_err(|e| {
				let core = phi_core::space::error(if matches!(e, RecoveryError::Conflict(_)) { "RegisterConflict" } else { "RecoveryBlocked" }, e.message());
				*failed.borrow_mut() = Some(e);
				core
			}))
		});
		let value = match r {
			Err(e) => return Err(blocked(e.to_string())),
			Ok(Err(e)) => return Err(failed.into_inner().unwrap_or_else(|| RecoveryError::from(e))),
			Ok(Ok(c)) => c.value,
		};
		self.durable().await?;
		Ok(value)
	}
	/// A document beside the Spaces as last made durable (`host.snapshot(Doc, key)`).
	pub fn document(&self, kind: &str, key: Option<&str>) -> RR<Option<Json>> { self.with(|s| s.store.stored_document(kind, key)).map_err(|e| blocked(e.to_string())) }
	/// `snapshotSpace`: the Space's state as JSON, or none.
	pub fn space(&self, name: &str) -> Option<Json> { self.with(|s| s.store.reader(Some(name)).ok().map(|h| h.space.state.to_json_without_claims())) }
	/// The limits of a Space.
	pub fn limits(&self, name: &str) -> Option<phi_core::Limits> { self.with(|s| s.store.reader(Some(name)).ok().map(|h| h.space.limits())) }
	/// `listSpaces`: the registry's Spaces.
	pub fn spaces(&self) -> Vec<Json> { self.with(|s| s.store.spaces()) }
}

/// A core error raised inside a commit, as a recovery step answers it.
pub fn core(e: CoreError) -> RecoveryError { RecoveryError::from(e) }
