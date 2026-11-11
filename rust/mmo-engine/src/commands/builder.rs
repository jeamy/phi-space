//! Builder and admin commands (`server/engine/commands/builder.ts`): shaping the world from inside it. Each carries a
//! `cmd` lock (the command table has them), so below the level the command does not exist. Lock strings a builder writes
//! are parsed before they are stored.
use phi_json::{obj, Json};

use crate::context::{by_name, exits_here, inventory, items_here, items_named, msg, room_of, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::locks::{parse_locks, LEVELS};
use crate::prototypes::{new_item_id, resolve_prototype, spawn as spawn_item, At, DEFAULT_ITEM_LOCKS};
use crate::source::{hex, random_bytes};
use crate::space::{by_id, fields, refuse, tmpl, Error, Result, FOREVER, NO_WAIT};
use crate::typeclasses::{draft_of, type_chain};
use crate::world::walkable;

fn txt(v: &Json) -> String { key_text(v) }
fn name_ok(s: &str) -> bool { js::re(r"^[\p{L}\p{N} _'-]{1,40}$", "u").test(s) }
fn info() -> MsgOpts { MsgOpts::default() }
fn templ() -> MsgOpts { MsgOpts { templ: true, ..Default::default() } }

enum Kind { Item, Exit, Room }
/// The thing a builder means.
struct Target { kind: Kind, e: Json, id: Json, name: String }

/// `target`: "hier" (the room), something carried, lying here, or an exit here.
async fn target(c: &mut Ctx, name: &str) -> Result<Target> {
	let n = js::trim(name).to_owned();
	if ["hier", "here"].contains(&js::lower(&n).as_str()) {
		let Some(e) = c.space.peek(&tmpl("Room", obj! { "roomId" => c.room() }), None).await? else { return refuse("Dieser Ort ist verschwunden.") };
		let name = txt(j::at(fields(&e), "name"));
		return Ok(Target { kind: Kind::Room, e, id: Json::from(c.room()), name });
	}
	let mut list = inventory(c).await?;
	list.extend(items_here(c).await?);
	let at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	if let Some(item) = items_named(c.w(), &list, &n, Some(at)).into_iter().next() {
		let f = fields(&item);
		let (id, name) = (j::at(f, "itemId").clone(), txt(j::at(f, "name")));
		return Ok(Target { kind: Kind::Item, e: item, id, name });
	}
	if let Some(exit) = by_name(&exits_here(c, None).await?, &n, None).into_iter().next() {
		let f = fields(&exit);
		let (id, name) = (j::at(f, "exitId").clone(), txt(j::at(f, "name")));
		return Ok(Target { kind: Kind::Exit, e: exit, id, name });
	}
	refuse(format!("Hier ist nichts, was „{}“ heißt.", js::slice16(&n, 0, Some(30))))
}

/// `rewrite`: takes the entry and writes it with changed fields, keeping its typeclass.
async fn rewrite(c: &Ctx, e: &Json, change: &[(&str, Json)]) -> Result<()> {
	let Some(t) = c.space.take(&by_id(j::s(e, "type"), e), NO_WAIT, c.txn()).await? else { return refuse("Das ist gerade in Benutzung; bitte gleich noch einmal.") };
	let mut f = fields(&t).clone();
	for (k, v) in change { j::set(&mut f, k, v.clone()); }
	let types: Vec<Json> = j::a(&t, "types").iter().skip(1).cloned().collect();
	c.space.write(&obj! { "type" => j::at(&t, "type").clone(), "types" => Json::Array(types), "fields" => f }, c.txn(), FOREVER).await?;
	Ok(())
}

/// `assignment`: `links = rechts`, both trimmed; None without "=".
fn assignment(arg: &str) -> Option<(String, String)> { arg.find('=').map(|i| (js::trim(&arg[..i]).to_owned(), js::trim(&arg[i + 1..]).to_owned())) }

fn checked_locks(s: &str) -> Result<String> {
	match parse_locks(s) { Ok(_) => Ok(s.to_owned()), Err(e) => refuse(format!("Lock-String ungültig: {e}")) }
}

/// `arrivalNear`: a walkable cell next to `at` that holds no exit.
fn arrival_near(c: &Ctx, ground: &[String], at: (f64, f64), exits: &[(f64, f64)]) -> Result<Json> {
	for (dx, dy) in [(0.0, 1.0), (1.0, 0.0), (-1.0, 0.0), (0.0, -1.0), (1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
		let p = (at.0 + dx, at.1 + dy);
		if walkable(c.w(), ground, p.0, p.1) && !exits.contains(&p) { return Ok(obj! { "x" => p.0, "y" => p.1 }); }
	}
	refuse("Neben dieser Stelle ist kein Platz zum Ankommen.")
}

async fn write_exit(c: &Ctx, f: Json) -> Result<()> { c.space.write(&draft_of("Exit", j::at(c.w(), "typeclasses"), f)?, c.txn(), FOREVER).await?; Ok(()) }
fn xy(f: &Json) -> (f64, f64) { (j::n(f, "x"), j::n(f, "y")) }
fn rows(v: &Json) -> Vec<String> { crate::room_growth::rows(v) }
fn exit_fields(id: String, name: &str, desc: String, location: &str, destination: &str, at: (f64, f64), arrive: Json) -> Json {
	obj! { "exitId" => id, "name" => name, "aliases" => Json::Array(vec![]), "desc" => desc, "location" => location, "destination" => destination, "x" => at.0, "y" => at.1, "arrive" => arrive, "locks" => "" }
}

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"dig" => dig(c, arg).await,
		"open" => open(c, arg).await,
		"create" => create(c, arg).await,
		"spawn" => spawn(c, arg).await,
		"set" => set(c, arg).await,
		"lock" => lock(c, arg).await,
		"tag" => tag(c, arg).await,
		"examine" => examine(c, arg).await,
		"destroy" => destroy(c, arg).await,
		"perm" => perm(c, arg).await,
		k => Err(Error::Other(format!("unported: builder/{k}"))),
	}
}

async fn dig(c: &mut Ctx, arg: &str) -> Result<()> {
	let a = assignment(arg);
	let parts: Vec<String> = a.as_ref().map_or("", |a| a.1.as_str()).split(',').map(|s| js::trim(s).to_owned()).collect();
	let ways = parts.first().cloned().unwrap_or_default();
	let back = parts.get(1).cloned().unwrap_or_default();
	let Some(a) = a.filter(|a| name_ok(&a.0) && name_ok(&ways)) else { return refuse("So geht es: dig <name> = <richtung>[, <zurück>]") };
	let here = room_of(c, None).await?;
	let exits_now: Vec<(f64, f64)> = exits_here(c, None).await?.iter().map(|x| xy(fields(x))).collect();
	let me = xy(&c.actor);
	if exits_now.contains(&me) { return refuse("Hier ist schon ein Ausgang; stell dich auf eine andere Stelle."); }
	let room_id = format!("r-{}", hex(&random_bytes(5)));
	let d = j::at(c.w(), "dig").clone();
	let spawn_at = xy(j::at(&d, "spawn"));
	c.space.write(&draft_of("Room", j::at(c.w(), "typeclasses"), obj! { "roomId" => room_id.as_str(), "name" => a.0.as_str(), "desc" => j::at(&d, "desc").clone(), "ground" => j::at(&d, "ground").clone(), "spawn" => j::at(&d, "spawn").clone() })?, c.txn(), FOREVER).await?;
	let back_exit: Vec<(f64, f64)> = if back.is_empty() { vec![] } else { vec![spawn_at] };
	let id = format!("x-{}", hex(&random_bytes(5)));
	let arrive = arrival_near(c, &rows(j::at(&d, "ground")), spawn_at, &back_exit)?;
	let room_here = j::s(&here, "roomId").to_owned();
	write_exit(c, exit_fields(id, &ways, format!("Nach {}.", a.0), &room_here, &room_id, me, arrive)).await?;
	if !back.is_empty() {
		let id = format!("x-{}", hex(&random_bytes(5)));
		let mut avoid = exits_now.clone();
		avoid.push(me);
		let arrive = arrival_near(c, &rows(j::at(&here, "ground")), me, &avoid)?;
		write_exit(c, exit_fields(id, &back, format!("Zurück nach {}.", txt(j::at(&here, "name"))), &room_id, &room_here, spawn_at, arrive)).await?;
	}
	let mine = c.char_id().to_owned();
	msg(c, &mine, "info", &format!("Raum „{}“ ({room_id}) angelegt; der Ausgang „{ways}“ liegt, wo du stehst{}.", a.0, if back.is_empty() { String::new() } else { format!(", zurück führt „{back}“") }), info()).await
}

async fn open(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(a) = assignment(arg).filter(|a| name_ok(&a.0) && !a.1.is_empty()) else { return refuse("So geht es: open <richtung> = <raum>") };
	let rooms: Vec<Json> = c.space.read_all(&obj! { "type" => "Room" }, None).await?.iter().map(|e| fields(e).clone()).collect();
	let Some(dest) = rooms.iter().find(|r| j::s(r, "roomId") == a.1).or_else(|| rooms.iter().find(|r| js::lower(&txt(j::at(r, "name"))) == js::lower(&a.1))).cloned() else { return refuse(format!("Einen Raum „{}“ gibt es nicht.", js::slice16(&a.1, 0, Some(30)))) };
	let me = xy(&c.actor);
	if exits_here(c, None).await?.iter().any(|x| xy(fields(x)) == me) { return refuse("Hier ist schon ein Ausgang; stell dich auf eine andere Stelle."); }
	let ground = rows(j::at(&dest, "ground"));
	let spawn_at = match j::opt(&dest, "spawn") { Some(s) => s.clone(), None => obj! { "x" => (ground.first().map_or(1, |r| js::len16(r)) as f64 / 2.0).floor(), "y" => (ground.len() as f64 / 2.0).floor() } };
	let arrive = if walkable(c.w(), &ground, j::n(&spawn_at, "x"), j::n(&spawn_at, "y")) { spawn_at } else { arrival_near(c, &ground, xy(&spawn_at), &[])? };
	let id = format!("x-{}", hex(&random_bytes(5)));
	let room = c.room().to_owned();
	write_exit(c, exit_fields(id, &a.0, format!("Nach {}.", txt(j::at(&dest, "name"))), &room, j::s(&dest, "roomId"), me, arrive)).await?;
	let mine = c.char_id().to_owned();
	msg(c, &mine, "info", &format!("Ausgang „{}“ nach {} geöffnet.", a.0, txt(j::at(&dest, "name"))), info()).await
}

async fn create(c: &mut Ctx, arg: &str) -> Result<()> {
	let parts: Vec<String> = arg.split(':').map(|s| js::trim(s).to_owned()).collect();
	let name = parts.first().cloned().unwrap_or_default();
	let tc = parts.get(1).cloned().unwrap_or_else(|| "Item".into());
	if !name_ok(&name) { return refuse("So geht es: create <name>[:<typklasse>]"); }
	let chain = match type_chain(&tc, j::at(c.w(), "typeclasses")) { Ok(ch) => ch, Err(e) => return refuse(e.to_string()) };
	if !chain.iter().any(|t| t == "Item") { return refuse(format!("„{tc}“ ist keine Typklasse für Dinge.")); }
	let (x, y) = xy(&c.actor);
	let item = obj! { "itemId" => new_item_id(), "name" => name.as_str(), "aliases" => Json::Array(vec![]), "desc" => "", "location" => c.room(), "x" => x, "y" => y, "glyph" => obj! { "shape" => "square", "color" => "#9aa3ad" }, "locks" => DEFAULT_ITEM_LOCKS, "proto" => "" };
	c.space.write(&draft_of(&tc, j::at(c.w(), "typeclasses"), item)?, c.txn(), FOREVER).await?;
	msg(c, "*", "info", &format!("$you() $conj(erschaffst|erschafft) {name}."), templ()).await
}

async fn spawn(c: &mut Ctx, arg: &str) -> Result<()> {
	let me = c.char_id().to_owned();
	if arg.is_empty() {
		let mut keys: Vec<String> = c.space.read_all(&obj! { "type" => "Prototype" }, None).await?.iter().map(|e| txt(j::at(fields(e), "key"))).collect();
		keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
		return msg(c, &me, "info", &format!("Prototypen: {}", keys.join(", ")), info()).await;
	}
	let Some(p) = resolve_prototype(&c.space, &js::lower(js::trim(arg))).await? else { return refuse(format!("Einen Prototyp „{}“ gibt es nicht. „spawn“ listet sie.", js::slice16(arg, 0, Some(30)))) };
	let (x, y) = xy(&c.actor);
	let item = spawn_item(&c.space, c.txn(), c.w(), &p, At { location: c.room().to_owned(), x, y, ..Default::default() }, &Json::Null).await?;
	msg(c, "*", "info", &format!("$you() $conj(erschaffst|erschafft) {}.", txt(j::at(&item, "name"))), templ()).await
}

async fn set(c: &mut Ctx, arg: &str) -> Result<()> {
	let a = assignment(arg);
	let slash = a.as_ref().and_then(|a| a.0.rfind('/'));
	let (Some(a), Some(slash)) = (a, slash.filter(|s| *s > 0)) else { return refuse("So geht es: set <ding>/<feld> = <wert>") };
	let t = target(c, &a.0[..slash]).await?;
	let field = js::lower(js::trim(&a.0[slash + 1..]));
	let fields_ok: &[&str] = if matches!(t.kind, Kind::Room) { &["name", "desc"] } else { &["name", "desc", "aliases", "locks"] };
	if !fields_ok.contains(&field.as_str()) { return refuse(format!("Änderbar: {}", fields_ok.join(", "))); }
	if field == "name" && !name_ok(&a.1) { return refuse("Ein Name hat 1 bis 40 Buchstaben, Ziffern, Leerzeichen, ' oder -."); }
	if js::len16(&a.1) > 1000 { return refuse("Höchstens 1000 Zeichen."); }
	let value = match field.as_str() {
		"aliases" => Json::Array(a.1.split(',').map(|s| js::lower(js::trim(s))).filter(|s| !s.is_empty()).take(10).map(Json::from).collect()),
		"locks" => Json::from(checked_locks(&a.1)?),
		_ => Json::from(a.1.as_str()),
	};
	rewrite(c, &t.e, &[(field.as_str(), value)]).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("{}: {field} geändert.", t.name), info()).await
}

async fn lock(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(a) = assignment(arg) else { return refuse("So geht es: lock <ding> = <lock-string>") };
	let t = target(c, &a.0).await?;
	if matches!(t.kind, Kind::Room) { return refuse("Räume haben noch keine Locks."); }
	let locks = checked_locks(&a.1)?;
	rewrite(c, &t.e, &[("locks", Json::from(locks))]).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("{}: Locks gesetzt.", t.name), info()).await
}

async fn tags_of(c: &Ctx, id: &Json) -> Result<Vec<Json>> { c.space.read_all(&tmpl("Tag", obj! { "target" => id.clone() }), None).await }

async fn tag(c: &mut Ctx, arg: &str) -> Result<()> {
	let a = assignment(arg);
	let t = target(c, a.as_ref().map_or(arg, |a| a.0.as_str())).await?;
	let me = c.char_id().to_owned();
	let Some(a) = a else {
		let tags: Vec<String> = tags_of(c, &t.id).await?.iter().map(|e| { let f = fields(e); format!("{}:{}", txt(j::at(f, "key")), txt(j::at(f, "category"))) }).collect();
		return msg(c, &me, "info", &if tags.is_empty() { format!("{} hat keine Tags.", t.name) } else { format!("Tags von {}: {}", t.name, tags.join(", ")) }, info()).await;
	};
	let remove = a.1.starts_with('-');
	let rest = js::re(r"^-", "").replace(&a.1, "");
	let parts: Vec<String> = rest.split(':').map(|s| js::lower(js::trim(s))).collect();
	let key = parts.first().cloned().unwrap_or_default();
	let category = parts.get(1).cloned().unwrap_or_else(|| "allgemein".into());
	let ok = |s: &str| js::re(r"^[\p{L}\p{N}_-]{1,30}$", "u").test(s);
	if !ok(&key) || !ok(&category) { return refuse("Tags und Kategorien: 1 bis 30 Buchstaben, Ziffern, _ oder -."); }
	let f = obj! { "target" => t.id.clone(), "key" => key.as_str(), "category" => category.as_str() };
	if remove {
		if c.space.take(&tmpl("Tag", f), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{} hat das Tag {key}:{category} nicht.", t.name)); }
	} else if c.space.peek(&tmpl("Tag", f.clone()), None).await?.is_none() { c.space.write(&tmpl("Tag", f), c.txn(), FOREVER).await?; }
	msg(c, &me, "info", &format!("{}: Tag {key}:{category} {}.", t.name, if remove { "abgenommen" } else { "angeheftet" }), info()).await
}

async fn examine(c: &mut Ctx, arg: &str) -> Result<()> {
	let t = target(c, if arg.is_empty() { "hier" } else { arg }).await?;
	let tags: Vec<String> = tags_of(c, &t.id).await?.iter().map(|e| { let f = fields(e); format!("{}:{}", txt(j::at(f, "key")), txt(j::at(f, "category"))) }).collect();
	let mut lines = vec![format!("{} ({})", t.name, j::a(&t.e, "types").iter().map(txt).collect::<Vec<_>>().join(" < "))];
	for (k, v) in j::entries(fields(&t.e)) { if k != "ground" { lines.push(format!("  {k}: {}", v.to_json_text())); } }
	lines.push(format!("  tags: {}", if tags.is_empty() { "–".to_owned() } else { tags.join(", ") }));
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &lines.join("\n"), info()).await
}

async fn destroy(c: &mut Ctx, arg: &str) -> Result<()> {
	let t = target(c, arg).await?;
	if matches!(t.kind, Kind::Room) { return refuse("Räume lassen sich noch nicht vernichten."); }
	if c.space.take(&by_id(j::s(&t.e, "type"), &t.e), NO_WAIT, c.txn()).await?.is_none() { return refuse("Das ist gerade in Benutzung; bitte gleich noch einmal."); }
	let who = txt(j::at(&c.actor, "name"));
	eprintln!("[world] destroy by {who} in {}: {} {} {}", c.room(), j::s(&t.e, "type"), t.name, crate::fire::key_text(&t.id));
	if j::s(&t.e, "type") == "Building" { super::build::log_gone(fields(&t.e), &format!("destroyed by the builder {who}")); }
	for tg in tags_of(c, &t.id).await? { c.space.take(&by_id("Tag", &tg), NO_WAIT, c.txn()).await?; }
	msg(c, "*", "info", &format!("$you() $conj(vernichtest|vernichtet) {}.", t.name), templ()).await
}

async fn perm(c: &mut Ctx, arg: &str) -> Result<()> {
	let a = assignment(arg);
	let level = a.as_ref().and_then(|a| LEVELS.iter().find(|l| js::lower(l) == js::lower(&a.1)).copied());
	let (Some(a), Some(level)) = (a, level.filter(|l| *l != "Guest" && *l != "Admin")) else { return refuse("So geht es: perm <name> = Builder|Player") };
	let Some(e) = c.space.read_all(&tmpl("Account", obj! { "guest" => false }), None).await?.into_iter().find(|x| js::lower(&txt(j::at(fields(x), "name"))) == js::lower(&a.0)) else { return refuse(format!("Ein registriertes Konto „{}“ gibt es nicht.", js::slice16(&a.0, 0, Some(30)))) };
	let acc = fields(&e).clone();
	let had: Vec<Json> = j::a(&acc, "perms").to_vec();
	let perms: Vec<Json> = if level == "Builder" {
		let mut p: Vec<Json> = Vec::new();
		for x in had.into_iter().chain(std::iter::once(Json::from("Builder"))) { if !p.contains(&x) { p.push(x); } }
		p
	} else { had.into_iter().filter(|p| p.as_str() != Some("Builder")).collect() };
	rewrite(c, &e, &[("perms", Json::Array(perms))]).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("{} ist jetzt {level}.", txt(j::at(&acc, "name"))), info()).await
}
