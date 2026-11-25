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
		"versetze" => versetze(c, arg).await,
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
	crate::room_lock::write_room_lock(&c.space, c.txn(), &room_id).await?;
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

/// `MOVABLE`: what `versetze` moves, the things that stand on cells of their own (Plot entries), with the field that
/// names them; green: what may lie in a green zone and under people (refusal), as when it was laid out; people: under people.
const MOVABLE: [(&str, &str, &str, bool, bool); 6] = [
	("Building", "buildId", "Bau", false, false), ("Site", "buildId", "Baustelle", false, false), ("Ruin", "buildId", "Ruine", false, false),
	("Bed", "bedId", "Beet", true, false), ("Field", "fieldId", "Acker", false, true), ("Tree", "treeId", "Baum", true, false),
];

/// `versetze <id> <x> <y>` (admin): a building, site, ruin, bed, field or tree here with all its cells to another spot of
/// the same place; a bed's plants go with it, a building's inside knows where it stands and its door leads out in front.
async fn versetze(c: &mut Ctx, arg: &str) -> Result<()> {
	let a = js::trim(arg).to_owned();
	let Some(m) = js::re(r"^(\S+)\s+(-?\d+)\s+(-?\d+)$", "").exec(&a) else { return refuse("So geht es: versetze <id> <x> <y>") };
	let id = m.group(&a, 1).unwrap_or("").to_owned();
	let (x, y) = (js::to_number(m.group(&a, 2).unwrap_or("")), js::to_number(m.group(&a, 3).unwrap_or("")));
	if crate::commands::interior::is_interior(c.room()) { return refuse("Drinnen wird nichts versetzt."); }
	let mut found = None;
	for kind in MOVABLE {
		if let Some(e) = c.space.peek(&tmpl(kind.0, obj! { kind.1 => id.as_str(), "room" => c.room() }), None).await? { found = Some((kind, e)); break; }
	}
	let Some((kind, e)) = found else { return refuse(format!("Hier steht nichts mit der Kennung „{}“.", js::slice16(&id, 0, Some(30)))) };
	let f = fields(&e).clone();
	let name = j::so(&f, "name").map_or_else(|| kind.2.to_owned(), str::to_owned);
	let (dx, dy) = (x - j::n(&f, "x"), y - j::n(&f, "y"));
	let me = c.char_id().to_owned();
	if dx == 0.0 && dy == 0.0 { return msg(c, &me, "info", &format!("{name} steht schon dort."), info()).await; }
	if j::truthy(j::at(&f, "of")) { return refuse(format!("{name} gehört zu einem Gebäude und bleibt, wo es liegt.")); }
	let plan = j::so(&f, "plan").and_then(|p| super::build::plan_of(c.w(), p)).cloned();
	if plan.as_ref().is_some_and(|p| j::b(p, "water")) { return refuse(format!("{name} liegt im Wasser; versetzen lässt es sich nicht.")); }
	let room = room_of(c, None).await?;
	let rect = super::build::Rect { x, y, w: j::n(&f, "w"), h: j::n(&f, "h") };
	let green = kind.3 || plan.as_ref().is_some_and(|p| j::b(p, "green"));
	let people = green || kind.4;
	// one place, no search: the room's lock first, then the check as the space holds it now, then the object (room_lock.rs)
	crate::room_lock::hold_room_or_refuse(&c.space, &c.txn, j::s(&room, "roomId")).await?;
	let mut no = super::build::refusal_locked(c, &room, rect, green, people, Some(&Json::from(id.as_str())), true).await?;
	if no.is_none() && plan.as_ref().is_some_and(|p| j::b(p, "shore")) && !super::build::touches_water(c.w(), &rows(j::at(&room, "ground")), rect) { no = Some("Das muss ans Wasser grenzen.".into()); }
	if let Some(no) = no { return refuse(format!("Dorthin lässt sich {name} nicht versetzen: {no}")); }
	let Some(t) = c.space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, c.txn()).await? else { return refuse("Das ist gerade in Benutzung; bitte gleich noch einmal.") };
	let room_id = j::s(&room, "roomId").to_owned();
	let txn = c.txn().unwrap_or("").to_owned();
	// the cells it leaves go, the ones it comes onto are written; those it keeps stay
	let to: std::collections::HashSet<String> = super::build::cells(rect).iter().map(|p| format!("{},{}", nt(p.0), nt(p.1))).collect();
	let mut had = std::collections::HashSet::new();
	for p in c.space.read_all(&tmpl("Plot", obj! { "room" => room_id.as_str(), "of" => id.as_str() }), None).await? {
		let k = format!("{},{}", nt(j::n(fields(&p), "x")), nt(j::n(fields(&p), "y")));
		if to.contains(&k) { had.insert(k); } else { c.space.take_if_exists(&obj! { "id" => j::at(&p, "id").clone() }, NO_WAIT, Some(&txn)).await?; }
	}
	for p in super::build::cells(rect) {
		if had.contains(&format!("{},{}", nt(p.0), nt(p.1))) { continue; }
		let r = c.space.write_unique(&tmpl("Plot", obj! { "room" => room_id.as_str(), "x" => p.0, "y" => p.1, "of" => id.as_str() }), c.txn(), FOREVER, &["room", "x", "y"]).await;
		match r { Err(e) if e.to_string().contains("unique entry already exists") => return refuse("Dort hat gerade jemand anderes abgesteckt."), Err(e) => return Err(e), Ok(_) => {} }
	}
	let mut moved = fields(&t).clone();
	j::set(&mut moved, "x", x);
	j::set(&mut moved, "y", y);
	if let Some(plants) = j::ao(&f, "plants") {
		let shifted: Vec<Json> = plants.iter().map(|p| { let mut q = p.clone(); j::set(&mut q, "x", j::n(p, "x") + dx); j::set(&mut q, "y", j::n(p, "y") + dy); q }).collect();
		j::set(&mut moved, "plants", Json::Array(shifted));
	}
	let types: Vec<Json> = j::a(&t, "types").iter().skip(1).cloned().collect();
	c.space.write(&obj! { "type" => j::at(&t, "type").clone(), "types" => Json::Array(types), "fields" => moved }, c.txn(), FOREVER).await?;
	if kind.0 == "Building" {
		let inside_id = crate::commands::interior::interior_of(&id);
		if let Some(inside) = c.space.take_if_exists(&tmpl("Room", obj! { "roomId" => inside_id.as_str() }), NO_WAIT, c.txn()).await? {
			let mut r = fields(&inside).clone();
			if j::truthy(j::at(&r, "building")) { let mut b = j::at(&r, "building").clone(); j::set(&mut b, "x", x); j::set(&mut b, "y", y); j::set(&mut r, "building", b); }
			let types: Vec<Json> = j::a(&inside, "types").iter().skip(1).cloned().collect();
			c.space.write(&obj! { "type" => j::at(&inside, "type").clone(), "types" => Json::Array(types), "fields" => r }, c.txn(), FOREVER).await?;
		}
		let exit_id = crate::commands::interior::exit_id_of(&id);
		if let Some(door) = c.space.take_if_exists(&tmpl("Exit", obj! { "exitId" => exit_id.as_str() }), NO_WAIT, c.txn()).await? {
			let mut d = fields(&door).clone();
			if j::truthy(j::at(&d, "arrive")) { let a = j::at(&d, "arrive").clone(); j::set(&mut d, "arrive", obj! { "x" => j::n(&a, "x") + dx, "y" => j::n(&a, "y") + dy }); }
			let types: Vec<Json> = j::a(&door, "types").iter().skip(1).cloned().collect();
			c.space.write(&obj! { "type" => j::at(&door, "type").clone(), "types" => Json::Array(types), "fields" => d }, c.txn(), FOREVER).await?;
		}
	}
	eprintln!("[world] versetze by {} in {}: {} {id} {},{} -> {},{}", txt(j::at(&c.actor, "name")), c.room(), kind.0, nt(j::n(&f, "x")), nt(j::n(&f, "y")), nt(x), nt(y));
	msg(c, &me, "info", &format!("{name} steht jetzt bei {} {}.", nt(x), nt(y)), info()).await
}
fn nt(n: f64) -> String { phi_json::number_text(n) }
