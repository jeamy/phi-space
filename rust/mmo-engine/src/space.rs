//! The Space as the engine uses it (`SpaceLike` of phi-spaces and the helpers of `server/space.ts`): a `RemoteSpace` of
//! `phi-spaces-client`, every entry as JSON (`{id, type, types, fields}` taken, `{type, types?, fields}` written), a
//! transaction as its id. `None` for "no transaction" as `null` in TypeScript.
use std::rc::Rc;

use phi_json::{obj, Json};
use phi_spaces_client::{peek, read_existing, Error as SpaceError, Opts, RemoteSpace};

pub use phi_json::FOREVER;
pub const NO_WAIT: f64 = 0.0;
/// How long a check waits on an entry another transaction holds right now (`HELD_WAIT_MS`).
pub const HELD_WAIT_MS: f64 = 2_000.0;

/// What a command or a tick ends with besides its result.
#[derive(Debug)]
pub enum Error {
	/// The space said no, or the link failed.
	Space(SpaceError),
	/// `readExisting`: a match stayed held.
	StillHeld(String),
	/// A command's refusal to the player (`CommandError`): its text, and no change.
	Command(String),
	/// Anything else (a broken definition, a bug).
	Other(String),
}

impl std::fmt::Display for Error {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Error::Space(e) => write!(f, "{e}"),
			Error::StillHeld(m) | Error::Command(m) | Error::Other(m) => f.write_str(m),
		}
	}
}

impl From<SpaceError> for Error {
	fn from(e: SpaceError) -> Self { if let SpaceError::StillHeld(m) = e { Error::StillHeld(m) } else { Error::Space(e) } }
}

pub type Result<T> = std::result::Result<T, Error>;

/// The space of a world (or of the accounts).
#[derive(Clone)]
pub struct Space(pub Rc<RemoteSpace>);

fn opts(txn: Option<&str>) -> Opts { Opts { txn: txn.map(str::to_owned), ..Opts::default() } }
fn some(v: Json) -> Option<Json> { if v.is_null() { None } else { Some(v) } }

impl Space {
	pub fn new(remote: Rc<RemoteSpace>) -> Self { Self(remote) }

	pub async fn write(&self, entry: &Json, txn: Option<&str>, lease: f64) -> Result<Json> { Ok(self.0.write(entry, txn, lease, &opts(txn)).await?) }

	/// `write(entry, txn, lease, { unique })`.
	pub async fn write_unique(&self, entry: &Json, txn: Option<&str>, lease: f64, unique: &[&str]) -> Result<Json> {
		let o = Opts { unique: Some(Json::Array(unique.iter().map(|k| Json::String((*k).to_owned())).collect())), ..opts(txn) };
		Ok(self.0.write(entry, txn, lease, &o).await?)
	}

	pub async fn read(&self, tmpl: &Json, timeout: f64, txn: Option<&str>) -> Result<Option<Json>> { Ok(some(self.0.read(tmpl, timeout, &opts(txn)).await?)) }
	pub async fn read_if_exists(&self, tmpl: &Json, timeout: f64, txn: Option<&str>) -> Result<Option<Json>> { Ok(some(self.0.read_if_exists(tmpl, timeout, &opts(txn)).await?)) }
	pub async fn take(&self, tmpl: &Json, timeout: f64, txn: Option<&str>) -> Result<Option<Json>> { Ok(some(self.0.take(tmpl, timeout, &opts(txn)).await?)) }
	pub async fn take_if_exists(&self, tmpl: &Json, timeout: f64, txn: Option<&str>) -> Result<Option<Json>> { Ok(some(self.0.take_if_exists(tmpl, timeout, &opts(txn)).await?)) }
	pub async fn read_all(&self, tmpl: &Json, txn: Option<&str>) -> Result<Vec<Json>> { Ok(self.0.read_all(tmpl, None, txn).await?) }
	pub async fn count(&self, tmpl: &Json, txn: Option<&str>) -> Result<f64> { Ok(self.0.count(tmpl, txn).await?) }

	pub async fn create_transaction(&self, lease: f64) -> Result<String> {
		let t = self.0.create_transaction(lease, &Opts::default()).await?;
		t.get("id").and_then(Json::as_str).map(str::to_owned).ok_or_else(|| Error::Other("a transaction without id".into()))
	}
	pub async fn commit(&self, txn: &str) -> Result<()> { Ok(self.0.commit(txn, &Opts::default()).await?) }
	pub async fn abort(&self, txn: &str) -> Result<()> { Ok(self.0.abort(txn, &Opts::default()).await?) }

	/// `peek`: the first match as the space stands now, holding nothing.
	pub async fn peek(&self, tmpl: &Json, txn: Option<&str>) -> Result<Option<Json>> { Ok(some(peek(&self.0, tmpl, txn).await?)) }

	/// `readExisting`: null means gone; a match held for all of `wait_ms` is `Error::StillHeld`.
	pub async fn read_existing(&self, tmpl: &Json, txn: Option<&str>, wait_ms: f64) -> Result<Option<Json>> { Ok(some(read_existing(&self.0, tmpl, wait_ms, txn).await?)) }
}

/// `{ type, fields }`.
pub fn tmpl(ty: &str, fields: Json) -> Json { obj! { "type" => ty, "fields" => fields } }
/// `{ type, id }`.
pub fn by_id(ty: &str, e: &Json) -> Json { obj! { "type" => ty, "id" => e.get("id").cloned().unwrap_or(Json::Null) } }
/// `e.fields`.
pub fn fields(e: &Json) -> &Json { e.get("fields").unwrap_or(&Json::Null) }
