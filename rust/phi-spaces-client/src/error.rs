use phi_json::{obj, Json};
use std::fmt;

/// The identity of a request: what a caller keeps to poll, retry or cancel exactly this request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestRef {
	pub generation: String,
	pub request_id: String,
}

impl RequestRef {
	pub fn to_json(&self) -> Json { obj! { "generation" => self.generation.as_str(), "requestId" => self.request_id.as_str() } }
	/// `{generation, requestId}`; other fields (a principal) are ignored, as in TypeScript.
	pub fn of(v: &Json) -> Option<RequestRef> {
		Some(RequestRef { generation: v.get("generation")?.as_str()?.to_owned(), request_id: v.get("requestId")?.as_str()?.to_owned() })
	}
}

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
	/// A reply that says no (`ok:false`), or the same refusal decided in the client (`BadRequest` for an illegal
	/// argument, `ResourceExhausted` for a call over the frame, `SnapshotExpired`, `ResultExpired`, `OperationCancelled`).
	Remote { code: String, message: String, required_bytes: Option<f64> },
	/// The waiting ended without an outcome; the call may still have happened or still happen. `sealed`: the host sealed a
	/// primary/sync commit but has not confirmed it (`CommitSealed`), keep polling or retrying exactly this request.
	OutcomeUnknown { request: RequestRef, why: String, sealed: bool },
	/// One round trip failed (what a caller sees only from a raw transport; RemoteSpace turns it into OutcomeUnknown).
	Transport(String),
	/// The server does not have the feature.
	Unsupported(String),
	/// A check ran out while a match stayed held by another transaction: the entry is not gone, it may come back.
	StillHeld(String),
}

impl Error {
	pub fn remote(code: &str, message: impl Into<String>) -> Error { Error::Remote { code: code.to_owned(), message: message.into(), required_bytes: None } }
	/// The protocol code of a refusal.
	pub fn code(&self) -> Option<&str> { if let Error::Remote { code, .. } = self { Some(code) } else { None } }
	/// The request whose outcome nobody knows.
	pub fn unknown_request(&self) -> Option<&RequestRef> { if let Error::OutcomeUnknown { request, .. } = self { Some(request) } else { None } }
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Error::Remote { message, .. } => f.write_str(message),
			Error::OutcomeUnknown { request, why, .. } => write!(f, "outcome unknown for request {}: {why}", request.request_id),
			Error::Transport(m) | Error::Unsupported(m) | Error::StillHeld(m) => f.write_str(m),
		}
	}
}

impl std::error::Error for Error {}
