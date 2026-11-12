//! The control side of Space lifecycle (`spaceCommands` of src/space-lifecycle.ts): the admin commands createSpace, archiveSpace,
//! reactivateSpace and deleteSpace for a target host, each a signed instruction whose signed result the host's pin verifies. The
//! Member side is `crate::space_lifecycle`.
use crate::auth::Signer;
use crate::run_member::Pin;
use crate::workers::{cut, js_string};
use phi_core::space::{illegal, permission as denied, truthy, CoreError};
use phi_json::{obj, text, Json};
use phi_wire::Local;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
pub const SPACE_COMMANDS: [&str; 4] = ["createSpace", "archiveSpace", "reactivateSpace", "deleteSpace"];
/// The refusals a host answers with: results, not transport failures.
const REFUSALS: [&str; 11] = ["cannot archive", "cannot delete", "IllegalArgument", "invalid", "no Space", "exists with other", "names an archived", "have no lifecycle", "another authority", "was used for another", "boot permission"];

/// The wire to the hosts: `send` carries a signed instruction, `hostPin` names the key a host signs its results with.
pub trait SpaceCommandPorts {
	fn send(&self, host_id: &str, signed: Json) -> Local<R<Json>>;
	fn host_pin(&self, host_id: &str) -> Local<R<Pin>>;
}

use crate::space_lifecycle::{sign_lifecycle, verify_lifecycle};

pub struct SpaceCommands<P: SpaceCommandPorts> {
	pub ports: P,
	pub authority_id: String,
	pub peer_id: String,
	pub signer: Rc<Signer>,
}

impl<P: SpaceCommandPorts> SpaceCommands<P> {
	pub fn new(ports: P, authority_id: &str, peer_id: &str, signer: Rc<Signer>) -> Self {
		SpaceCommands { ports, authority_id: authority_id.to_owned(), peer_id: peer_id.to_owned(), signer }
	}
	/// One command by its kind (`createSpace` ...), as the supervisor calls it.
	pub async fn command(&self, kind: &str, command_id: &str, args: &Json) -> R<Json> {
		let action = match kind {
			"createSpace" => "create",
			"archiveSpace" => "archive",
			"reactivateSpace" => "reactivate",
			"deleteSpace" => "delete",
			_ => return Err(illegal(format!("unknown Space command {kind}"))),
		};
		self.run(action, command_id, args).await
	}
	/// `run(action)`: the instruction, the host's answer; a refusal of the host is a failed result, an unreachable host an error
	/// (the job stays applying and the supervisor retries).
	pub async fn run(&self, action: &str, command_id: &str, a: &Json) -> R<Json> {
		let host_id = js_string(a.get("hostId"));
		let mut q = obj! { "commandId" => command_id, "action" => action, "authorityId" => self.authority_id.as_str(), "hostId" => host_id.as_str() };
		let o = q.as_object_mut().expect("an object");
		if action == "create" {
			o.insert("alias", js_string(a.get("alias")).into());
		} else {
			o.insert("spaceId", js_string(a.get("spaceId")).into());
		}
		for k in ["limits", "profiles"] {
			if let Some(v) = a.get(k).filter(|v| truthy(Some(v))) {
				o.insert(k, v.clone());
			}
		}
		let signed = sign_lifecycle("instruction", q, &self.peer_id, &self.signer)?;
		let reply = match self.ports.send(&host_id, signed).await {
			Ok(r) => r,
			Err(e) => {
				if REFUSALS.iter().any(|r| e.message.contains(r)) {
					return Ok(obj! { "phase" => "failed", "error" => cut(&e.message, 512) });
				}
				return Err(e);
			}
		};
		let pin = self.ports.host_pin(&host_id).await?;
		let result = verify_lifecycle("result", &reply, &pin)?;
		if text(&result, "commandId") != Some(command_id) || text(&result, "action") != Some(action) {
			return Err(denied("Space lifecycle result does not match the command"));
		}
		Ok(result)
	}
}
