//! The command modules (`server/engine/commands/`) and command sets (`server/engine/cmdsets.ts`). Every command of the
//! default and builder sets is in `commands.json`, written from the frozen engine by `spaces-mmo/tests/r8/commands.ts` (key,
//! aliases, lock, help, module, in the order commandsOf merges them); a command whose function is not ported yet fails
//! with `unported: <module>/<key>`.
use std::rc::Rc;

use phi_json::Json;

use crate::context::{exits_here, lock_ctx, Ctx};
use crate::j;
use crate::space::{fields, Error, Result};

pub mod build;
pub mod builder;
pub mod chapel;
pub mod clock;
pub mod default;
pub mod epoch;
pub mod festival;
pub mod field;
pub mod food;
pub mod garden;
pub mod growth;
pub mod mill;
pub mod passage;
pub mod quarry;
pub mod scenery;
pub mod settlement;
pub mod shop;
pub mod signal;
pub mod siteorder;
pub mod townhall;
pub mod trade;
pub mod wind;

/// A command (`Command`): an exit's command carries the exit.
#[derive(Debug, Clone)]
pub struct Command { pub key: String, pub aliases: Option<Vec<String>>, pub locks: Option<String>, pub hidden: bool, pub help: String, pub module: String, pub exit: Option<Json> }

impl Command {
	fn of(r: &Json) -> Self {
		Self {
			key: j::s(r, "key").to_owned(),
			aliases: j::ao(r, "aliases").map(|a| j::strs(a).into_iter().map(str::to_owned).collect()),
			locks: j::so(r, "locks").map(str::to_owned),
			hidden: j::b(r, "hidden"),
			help: j::s(r, "help").to_owned(),
			module: j::s(r, "module").to_owned(),
			exit: None,
		}
	}
	/// Every name it answers to (`[key, ...aliases]`).
	pub fn names(&self) -> impl Iterator<Item = &String> { std::iter::once(&self.key).chain(self.aliases.iter().flatten()) }
}

/// The table: (the default set without help, help, the builder set).
pub fn table() -> &'static (Vec<Rc<Command>>, Rc<Command>, Vec<Rc<Command>>) {
	thread_local! { static T: &'static (Vec<Rc<Command>>, Rc<Command>, Vec<Rc<Command>>) = {
		let v = phi_json::parse(include_str!("../commands.json")).expect("commands.json");
		let mut d: Vec<Rc<Command>> = j::a(&v, "default").iter().map(|r| Rc::new(Command::of(r))).collect();
		let help = d.pop().expect("help, last");
		Box::leak(Box::new((d, help, j::a(&v, "builder").iter().map(|r| Rc::new(Command::of(r))).collect())))
	}; }
	T.with(|t| *t)
}

/// A command set.
pub struct CmdSet { pub priority: i32, pub merge: Merge, pub commands: Vec<Rc<Command>> }
#[derive(PartialEq, Eq, Clone, Copy)]
pub enum Merge { Union, Replace, Remove }

/// The merged commands by every name (lower case), in the order a Map keeps them.
pub type Merged = Vec<(String, Rc<Command>)>;

/// `merge`: by priority; a Union adds, a Replace drops what is below, a Remove takes names out.
pub fn merge(mut sets: Vec<CmdSet>) -> Merged {
	sets.sort_by_key(|s| s.priority);
	let mut out: Merged = Vec::new();
	for s in &sets {
		if s.merge == Merge::Replace { out.clear(); }
		for cmd in &s.commands {
			for name in cmd.names().map(|n| n.to_lowercase()) {
				if s.merge == Merge::Remove { out.retain(|(k, _)| *k != name); continue; }
				match out.iter_mut().find(|(k, _)| *k == name) { Some(slot) => slot.1 = cmd.clone(), None => out.push((name, cmd.clone())) }
			}
		}
	}
	out
}

/// `distinct`: the distinct commands of a merged map, in key order.
pub fn distinct(m: &Merged) -> Vec<Rc<Command>> {
	let mut out: Vec<Rc<Command>> = Vec::new();
	for (_, c) in m { if !out.iter().any(|x| Rc::ptr_eq(x, c)) { out.push(c.clone()); } }
	out.sort_by(|a, b| crate::js::locale_compare(&a.key, &b.key));
	out
}

/// `exitCmdSet`: one command per exit of the room, above the defaults.
pub async fn exit_cmd_set(c: &Ctx) -> Result<CmdSet> {
	let commands = exits_here(c, None).await?.iter().map(|x| {
		let f = fields(x);
		Rc::new(Command { key: j::s(f, "name").to_owned(), aliases: j::ao(f, "aliases").map(|a| j::strs(a).into_iter().map(str::to_owned).collect()), locks: None, hidden: false, help: format!("{} – {}", j::s(f, "name"), if j::s(f, "desc").is_empty() { "ein Ausgang" } else { j::s(f, "desc") }), module: "exit".into(), exit: Some(f.clone()) })
	}).collect();
	Ok(CmdSet { priority: 10, merge: Merge::Union, commands })
}

/// `commandsOf`: the commands the actor has, by every name; and the exits' commands (help leaves them out).
pub async fn commands_of(c: &mut Ctx) -> Result<(Merged, Vec<Rc<Command>>)> {
	let who = lock_ctx(c).await?;
	let offered = |cmds: &[Rc<Command>]| -> Vec<Rc<Command>> { cmds.iter().filter(|cmd| cmd.locks.as_deref().is_none_or(|l| l.is_empty() || who.allowed(l, "cmd"))).cloned().collect() };
	let exits = exit_cmd_set(c).await?;
	let exit_cmds = exits.commands.clone();
	let (defaults, help, builder) = table();
	let mut first = defaults.clone();
	first.push(help.clone());
	let all = merge(vec![CmdSet { priority: 0, merge: Merge::Union, commands: offered(&first) }, CmdSet { priority: 1, merge: Merge::Union, commands: offered(builder) }, exits]);
	Ok((all, exit_cmds))
}

/// Runs a command's function.
pub async fn run(c: &mut Ctx, cmd: &Command, arg: &str, merged: &Merged, exits: &[Rc<Command>]) -> Result<()> {
	if let Some(exit) = &cmd.exit { return default::traverse(c, exit).await; }
	match (cmd.module.as_str(), cmd.key.as_str()) {
		("default", "help") => default::help(c, arg, &distinct(merged).into_iter().filter(|x| !exits.iter().any(|e| Rc::ptr_eq(e, x))).collect::<Vec<_>>()).await,
		("default", key) => default::run(c, key, arg).await,
		("build", key) => build::run(c, key, arg).await,
		("siteorder", "aushang") => siteorder::aushang(c, arg).await,
		("trade", key) => trade::run(c, key, arg).await,
		("food", "iss") => food::iss(c, arg).await,
		("mill", key) => mill::run(c, key, arg).await,
		("festival", key) => festival::run(c, key, arg).await,
		("field", key) => field::run(c, key, arg).await,
		("garden", key) => garden::run(c, key, arg).await,
		("shop", key) => shop::run(c, key, arg).await,
		("builder", key) => builder::run(c, key, arg).await,
		("settlement", "siedlung") => settlement::siedlung(c, arg).await,
		("epoch", "epoche") => epoch::epoche(c, arg).await,
		("townhall", "antrag") => townhall::antrag(c, arg).await,
		("townhall", "stimme") => townhall::stimme(c, arg).await,
		("chapel", "opfere") => chapel::opfere(c, arg).await,
		("signal", "signalfeuer") => signal::signalfeuer(c, arg).await,
		("scenery", "räume") => scenery::raeume(c, arg).await,
		("quarry", key) => quarry::run(c, key, arg).await,
		("wind", "wetter") => wind::wetter(c, arg).await,
		("clock", "time") => clock::time(c, arg).await,
		("clock", "clock") => clock::clock(c, arg).await,
		(m, k) => Err(Error::Other(format!("unported: {m}/{k}"))),
	}
}
