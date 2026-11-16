//! The Space as the engine uses it (`SpaceLike` of phi-spaces and the helpers of `server/space.ts`): a `RemoteSpace` of
//! `phi-spaces-client`, every entry as JSON (`{id, type, types, fields}` taken, `{type, types?, fields}` written), a
//! transaction as its id. `None` for "no transaction" as `null` in TypeScript.
use std::rc::Rc;

use phi_json::{obj, Json};
use phi_spaces_client::{peek, read_existing, take_existing, Error as SpaceError, Opts, RemoteSpace};

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
	/// A refusal that means "not understood" (`NotUnderstood`, a `CommandError` too).
	NotUnderstood(String),
	/// Not understood after the command had begun to change things (`AskModel`, a `CommandError` too): the transaction
	/// is aborted, and the refusal's own transaction asks the model with these Translate fields and says this text.
	AskModel(String, Json),
	/// Anything else (a broken definition, a bug).
	Other(String),
}

impl std::fmt::Display for Error {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Error::Space(e) => write!(f, "{e}"),
			Error::StillHeld(m) | Error::Command(m) | Error::NotUnderstood(m) | Error::AskModel(m, _) | Error::Other(m) => f.write_str(m),
		}
	}
}

impl From<SpaceError> for Error {
	fn from(e: SpaceError) -> Self { if let SpaceError::StillHeld(m) = e { Error::StillHeld(m) } else { Error::Space(e) } }
}

impl Error {
	/// `e instanceof CommandError` (NotUnderstood included).
	pub fn is_command(&self) -> bool { matches!(self, Error::Command(_) | Error::NotUnderstood(_) | Error::AskModel(..)) }
}

/// `throw new CommandError(text)`.
pub fn refuse<T>(text: impl Into<String>) -> Result<T> { Err(Error::Command(text.into())) }
/// `throw new NotUnderstood(text)`.
pub fn not_understood<T>(text: impl Into<String>) -> Result<T> { Err(Error::NotUnderstood(text.into())) }

pub type Result<T> = std::result::Result<T, Error>;

/// The space of a world (or of the accounts). Ported code reaches the space only through these methods, so a buffered
/// transaction or a copy of the world (`bufferedTxn`, `Mirror` of `server/space.ts`) can come in here.
#[derive(Clone)]
pub struct Space { remote: Rc<RemoteSpace>, mirror: Option<Rc<crate::mirror::Mirror>>, buffer: Option<Rc<Buffer>> }

/// `bufferedTxn`: the plain writes of one transaction, waiting to go with its commit in one batch.
struct Buffer { txn: String, waiting: std::cell::RefCell<Vec<Json>> }

/// The most steps the service takes in one batch (service.ts).
const MAX_STEPS: usize = 64;

fn opts(txn: Option<&str>) -> Opts { Opts { txn: txn.map(str::to_owned), ..Opts::default() } }
fn some(v: Json) -> Option<Json> { if v.is_null() { None } else { Some(v) } }

impl Space {
	pub fn new(remote: Rc<RemoteSpace>) -> Self { Self { remote, mirror: None, buffer: None } }
	/// The space as a command sees it: its snapshot reads (`read_all`, `count` and `peek` without a transaction) from
	/// the copy (`bufferedTxn(…, mirror)`).
	pub fn with_mirror(&self, m: Rc<crate::mirror::Mirror>) -> Self { Self { remote: self.remote.clone(), mirror: Some(m), buffer: self.buffer.clone() } }
	/// `bufferedTxn(space, txn)`: this space with the plain writes under `txn` (no `unique`) kept until its `commit`,
	/// which sends them with the commit in one batch; any other call that names a transaction sends them first.
	pub fn buffered(&self, txn: &str) -> Self { Self { remote: self.remote.clone(), mirror: self.mirror.clone(), buffer: Some(Rc::new(Buffer { txn: txn.to_owned(), waiting: Default::default() })) } }
	/// The plain space (no copy, no buffer).
	pub fn plain(&self) -> Self { Self::new(self.remote.clone()) }
	pub fn remote(&self) -> &Rc<RemoteSpace> { &self.remote }
	fn copy(&self, txn: Option<&str>) -> Option<&crate::mirror::Mirror> { self.mirror.as_deref().filter(|_| txn.is_none_or(str::is_empty)) }

	/// What tells this space from another in a cache (the settings).
	pub fn key(&self) -> usize { Rc::as_ptr(&self.remote) as usize }

	/// The waiting writes, sent (`flush`).
	async fn flush(&self) -> Result<()> {
		let Some(b) = &self.buffer else { return Ok(()) };
		loop {
			let ops: Vec<Json> = { let mut w = b.waiting.borrow_mut(); let n = w.len().min(MAX_STEPS); w.drain(..n).collect() };
			if ops.is_empty() { return Ok(()); }
			self.remote.batch(&ops, &Opts::default()).await?;
		}
	}
	/// A write that waits for the commit, or None when this one goes at once.
	async fn keep(&self, entry: &Json, txn: Option<&str>, lease: f64, transient: bool) -> Result<Option<Json>> {
		let Some(b) = self.buffer.as_ref().filter(|b| txn == Some(b.txn.as_str())) else { self.flush().await?; return Ok(None) };
		if b.waiting.borrow().len() >= MAX_STEPS { self.flush().await?; }
		let mut op = obj! { "op" => "write", "entry" => entry.clone(), "txn" => b.txn.as_str(), "lease" => lease };
		if transient { if let Json::Object(o) = &mut op { o.insert("transient", Json::Bool(true)); } }
		b.waiting.borrow_mut().push(op);
		Ok(Some(obj! { "id" => "", "expires" => lease }))
	}

	/// `supports(space, feature)`: whether the server's hello names it (false when the hello fails).
	pub async fn supports(&self, feature: &str) -> bool {
		self.remote.info().await.ok().and_then(|h| h.get("features").and_then(Json::as_array).map(|f| f.iter().any(|x| x.as_str() == Some(feature)))).unwrap_or(false)
	}

	/// `write(entry, txn, lease, { transient })`.
	pub async fn write_with(&self, entry: &Json, txn: Option<&str>, lease: f64, transient: bool) -> Result<Json> {
		if let Some(r) = self.keep(entry, txn, lease, transient).await? { return Ok(r); }
		let o = Opts { transient, ..opts(txn) };
		Ok(self.remote.write(entry, txn, lease, &o).await?)
	}

	pub async fn write(&self, entry: &Json, txn: Option<&str>, lease: f64) -> Result<Json> { self.write_with(entry, txn, lease, false).await }

	/// `write(entry, txn, lease, { unique })`.
	pub async fn write_unique(&self, entry: &Json, txn: Option<&str>, lease: f64, unique: &[&str]) -> Result<Json> {
		self.flush().await?;
		let o = Opts { unique: Some(Json::Array(unique.iter().map(|k| Json::String((*k).to_owned())).collect())), ..opts(txn) };
		Ok(self.remote.write(entry, txn, lease, &o).await?)
	}

	pub async fn read(&self, tmpl: &Json, timeout: f64, txn: Option<&str>) -> Result<Option<Json>> { self.flush().await?; Ok(some(self.remote.read(tmpl, timeout, &opts(txn)).await?)) }
	pub async fn read_if_exists(&self, tmpl: &Json, timeout: f64, txn: Option<&str>) -> Result<Option<Json>> { self.flush().await?; Ok(some(self.remote.read_if_exists(tmpl, timeout, &opts(txn)).await?)) }
	pub async fn take(&self, tmpl: &Json, timeout: f64, txn: Option<&str>) -> Result<Option<Json>> { self.flush().await?; Ok(some(self.remote.take(tmpl, timeout, &opts(txn)).await?)) }
	pub async fn take_if_exists(&self, tmpl: &Json, timeout: f64, txn: Option<&str>) -> Result<Option<Json>> { self.flush().await?; Ok(some(self.remote.take_if_exists(tmpl, timeout, &opts(txn)).await?)) }
	pub async fn read_all(&self, tmpl: &Json, txn: Option<&str>) -> Result<Vec<Json>> {
		if let Some(m) = self.copy(txn) { return Ok(m.read_all(tmpl, None)); }
		if txn.is_some() { self.flush().await?; }
		Ok(self.remote.read_all(tmpl, None, txn).await?)
	}
	/// `readAll(tmpl, { limit, txn })`.
	pub async fn read_limit(&self, tmpl: &Json, limit: usize, txn: Option<&str>) -> Result<Vec<Json>> {
		if let Some(m) = self.copy(txn) { return Ok(m.read_all(tmpl, Some(limit))); }
		if txn.is_some() { self.flush().await?; }
		Ok(self.remote.read_all(tmpl, Some(limit as f64), txn).await?)
	}
	pub async fn count(&self, tmpl: &Json, txn: Option<&str>) -> Result<f64> {
		if let Some(m) = self.copy(txn) { return Ok(m.count(tmpl)); }
		if txn.is_some() { self.flush().await?; }
		Ok(self.remote.count(tmpl, txn).await?)
	}

	/// Several steps in one call and one commit (`{op, entry, template, txn, lease, unique, transient}`).
	pub async fn batch(&self, ops: &[Json]) -> Result<Json> { self.flush().await?; Ok(self.remote.batch(ops, &Opts::default()).await?) }

	pub async fn create_transaction(&self, lease: f64) -> Result<String> {
		self.flush().await?;
		let t = self.remote.create_transaction(lease, &Opts::default()).await?;
		t.get("id").and_then(Json::as_str).map(str::to_owned).ok_or_else(|| Error::Other("a transaction without id".into()))
	}
	/// The commit; of the buffered transaction with what waits for it, in as few batches as it takes (the commit in the
	/// last one).
	pub async fn commit(&self, txn: &str) -> Result<()> {
		if let Some(b) = self.buffer.as_ref().filter(|b| b.txn == txn) {
			let mut last: Vec<Json> = b.waiting.borrow_mut().drain(..).collect();
			last.push(obj! { "op" => "commit", "txn" => txn });
			while last.len() > MAX_STEPS { let head: Vec<Json> = last.drain(..MAX_STEPS).collect(); self.remote.batch(&head, &Opts::default()).await?; }
			self.remote.batch(&last, &Opts::default()).await?;
			return Ok(());
		}
		self.flush().await?;
		Ok(self.remote.commit(txn, &Opts::default()).await?)
	}
	pub async fn abort(&self, txn: &str) -> Result<()> {
		if let Some(b) = self.buffer.as_ref().filter(|b| b.txn == txn) { b.waiting.borrow_mut().clear(); }
		Ok(self.remote.abort(txn, &Opts::default()).await?)
	}

	/// `peek`: the first match as the space stands now, holding nothing.
	pub async fn peek(&self, tmpl: &Json, txn: Option<&str>) -> Result<Option<Json>> {
		if let Some(m) = self.copy(txn) { return Ok(m.read_all(tmpl, Some(1)).into_iter().next()); }
		if txn.is_some() { self.flush().await?; }
		Ok(some(peek(&self.remote, tmpl, txn).await?))
	}

	/// `readExisting`: null means gone; a match held for all of `wait_ms` is `Error::StillHeld`.
	pub async fn read_existing(&self, tmpl: &Json, txn: Option<&str>, wait_ms: f64) -> Result<Option<Json>> { self.flush().await?; Ok(some(read_existing(&self.remote, tmpl, wait_ms, txn).await?)) }
	/// `takeExisting`: as `read_existing`, taking it.
	pub async fn take_existing(&self, tmpl: &Json, txn: Option<&str>, wait_ms: f64) -> Result<Option<Json>> { self.flush().await?; Ok(some(take_existing(&self.remote, tmpl, wait_ms, txn).await?)) }
}

/// `{ type, fields }`.
pub fn tmpl(ty: &str, fields: Json) -> Json { obj! { "type" => ty, "fields" => fields } }
/// `{ type, id }`.
pub fn by_id(ty: &str, e: &Json) -> Json { obj! { "type" => ty, "id" => e.get("id").cloned().unwrap_or(Json::Null) } }
/// `e.fields`.
pub fn fields(e: &Json) -> &Json { e.get("fields").unwrap_or(&Json::Null) }
