//! The department store and the counting house (`server/engine/commands/shop.ts`): `laden` trades with a store at
//! prices a simple rule leads (empty dear, full cheap) from its own till, which its owner fills and empties; delivery
//! orders fill the shelf, their coins spoken for in the till. In a counting house `kredit` lends against a pledge,
//! `tilge` pays back, `loan_tick` gives the pledge to the house when the time ran out; `wechsel` writes and cashes bills
//! of exchange that carry their coins.
use phi_json::{obj, Json};

use super::build::{dist_to, no_article, plan_of, put_back, take_near, Rect};
use super::settlement::settlement_in;
use super::trade::{consume, move_item};
use crate::clock::decay_now_of;
use crate::context::{inventory, items_named, msg, to_player, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn coins_word(n: f64) -> String { format!("{} Münze{}", nt(n), if n == 1.0 { "" } else { "n" }) }
fn proto_name(w: &Json, proto: &str) -> String { j::by(j::a(w, "prototypes"), "key", proto).map_or_else(|| proto.to_owned(), |p| txt(j::at(p, "name"))) }
async fn inside(space: &Space, at: &Json, txn: Option<&str>) -> Result<Vec<Json>> {
	Ok(space.read_all(&tmpl("Item", obj! { "location" => at.clone() }), txn).await?.iter().map(|e| fields(e).clone()).collect())
}
/// `shopPrice`: what the shop asks for a thing with `stock` on its shelf: twice the price empty, half of it at `full`.
pub fn shop_price(base: f64, stock: f64, full: f64) -> f64 { 1f64.max(js::round(base * 0.5f64.max(2.0 - (1.5 * stock) / full))) }
fn shop_of(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "shop") { Some(d) => Ok(d.clone()), None => refuse("In dieser Welt gibt es keine Kaufhäuser.") } }
fn dative(c: &Ctx, plan: &str, or: &str) -> String { plan_of(c.w(), plan).and_then(|p| j::opt(p, "dative")).map_or_else(|| or.to_owned(), txt) }
/// `salesTax`: the tax on a thing bought at a store and the warehouse it goes to.
async fn sales_tax(c: &Ctx) -> Result<Option<(f64, Json)>> {
	let tax = settlement_in(&c.space, c.room(), c.txn()).await?.and_then(|s| j::no(&s, "tax")).unwrap_or(0.0);
	if tax == 0.0 || tax.is_nan() { return Ok(None); }
	let store = c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), c.txn()).await?.iter().map(|e| fields(e).clone()).find(|b| plan_of(c.w(), j::s(b, "plan")).is_some_and(|p| j::b(p, "store")));
	Ok(store.map(|b| (tax, j::at(&b, "buildId").clone())))
}
async fn take(c: &Ctx, plan: &str) -> Result<Option<Json>> { Ok(take_near(c, "Building", "buildId", 1.0, &|b: &Json| j::s(b, "plan") == plan).await?.ok()) }
fn owner(c: &Ctx, b: &Json) -> bool { c.account.as_ref().is_some_and(|a| j::at(a, "accountId") == j::at(b, "accountId")) }
fn with_turnover(b: &Json, more: f64) -> Json { let mut nb = b.clone(); j::set(&mut nb, "turnover", j::no(b, "turnover").unwrap_or(0.0) + more); nb }
fn coin_of(c: &Ctx) -> String { txt(j::at(c.w(), "currency")) }
fn purse_of(c: &Ctx, inv: Vec<Json>) -> Vec<Json> { let coin = coin_of(c); inv.into_iter().map(|i| fields(&i).clone()).filter(|f| j::s(f, "proto") == coin).collect() }
fn info() -> MsgOpts { MsgOpts::default() }
fn templ() -> MsgOpts { MsgOpts { templ: true, ..Default::default() } }

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"laden" => laden(c, arg).await,
		"kredit" => kredit(c, arg).await,
		"tilge" => tilge(c).await,
		"wechsel" => wechsel(c, arg).await,
		k => Err(Error::Other(format!("unported: shop/{k}"))),
	}
}

async fn laden(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = shop_of(c)?;
	let parts: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let word = parts.first().cloned().unwrap_or_default();
	let tail = no_article(&parts.get(1..).unwrap_or(&[]).join(" "));
	let plan = j::s(&d, "plan").to_owned();
	let Some(b) = take(c, &plan).await? else { return refuse(format!("Das geht nur direkt neben {}.", dative(c, &plan, "einem Kaufhaus"))) };
	let build_id = j::at(&b, "buildId").clone();
	let held = inside(&c.space, &build_id, c.txn()).await?;
	let coin = coin_of(c);
	let till: Vec<Json> = held.iter().filter(|i| j::s(i, "proto") == coin).cloned().collect();
	let shelf: Vec<Json> = held.iter().filter(|i| j::s(i, "proto") != coin).cloned().collect();
	let count = |proto: &str| shelf.iter().filter(|i| j::s(i, "proto") == proto).count() as f64;
	let orders: Vec<Json> = c.space.read_all(&tmpl("ShopOrder", obj! { "buildId" => build_id.clone() }), c.txn()).await?;
	let of = |o: &Json| fields(o).clone();
	let promised: f64 = orders.iter().map(|o| j::n(fields(o), "count") * j::n(fields(o), "reward")).sum();
	let free = till.len() as f64 - promised;
	let prices = j::at(&d, "prices").clone();
	let priced = |proto: &str| j::opt(&prices, proto).is_some_and(j::truthy);
	let (full, share) = (j::n(&d, "full"), j::n(&d, "buyShare"));
	let ask_for = |proto: &str| shop_price(j::n(&prices, proto), count(proto), full);
	let bid = |proto: &str| 1f64.max((shop_price(j::n(&prices, proto), count(proto) + 1.0, full) * share).floor());
	let me = c.char_id().to_owned();
	let w = c.world.clone();
	let bname = txt(j::at(&b, "name"));
	let re = |p: &'static str| js::re(p, "i");
	if word.is_empty() {
		put_back(c, &b).await?;
		let mut protos: Vec<String> = Vec::new();
		for i in &shelf { let p = txt(j::at(i, "proto")); if !protos.contains(&p) { protos.push(p); } }
		let lines: Vec<String> = protos.iter().filter(|p| priced(p)).map(|p| format!("{} ({}): {}", proto_name(&w, p), nt(count(p)), coins_word(ask_for(p)))).collect();
		let wanted: Vec<String> = orders.iter().map(|o| { let f = fields(o); format!("{}× {} zu {}", txt(j::at(f, "count")), txt(j::at(f, "protoName")), coins_word(j::n(f, "reward"))) }).collect();
		let buys = j::entries(&prices).map(|(p, _)| proto_name(&w, p)).collect::<Vec<_>>().join(", ");
		return msg(c, &me, "info", &format!("{bname} von {}, in der Kasse {}. {} Es kauft: {buys}.{}", txt(j::at(&b, "ownerName")), coins_word(till.len() as f64), if lines.is_empty() { "Das Regal ist leer.".to_owned() } else { format!("Im Regal: {}.", lines.join("; ")) }, if wanted.is_empty() { String::new() } else { format!(" Bestellt („laden liefere <ding>“): {}.", wanted.join("; ")) }), info()).await;
	}
	if re(r"^(?:kaufe|buy)$").test(&word) {
		let entries: Vec<Json> = shelf.iter().map(|f| obj! { "fields" => f.clone() }).collect();
		let it = items_named(&w, &entries, &tail, None).into_iter().next().map(|e| fields(&e).clone());
		let Some(it) = it.filter(|f| priced(j::s(f, "proto"))) else { return refuse(format!("Im Regal liegt kein {}.", js::slice16(&tail, 0, Some(30)))) };
		let price = ask_for(j::s(&it, "proto"));
		let taxed = sales_tax(c).await?;
		let tax = taxed.as_ref().map_or(0.0, |t| t.0);
		let inv = inventory(c).await?; let purse = purse_of(c, inv);
		if (purse.len() as f64) < price + tax { return refuse(format!("Dafür brauchst du {}.", coins_word(price + tax))); }
		let bid_s = txt(&build_id);
		for m in purse.iter().take(price as usize) { move_item(c, m, &me, &bid_s, &[]).await?; }
		if let Some((_, store)) = &taxed { for m in purse.iter().skip(price as usize).take(tax as usize) { move_item(c, m, &me, &txt(store), &[]).await?; } }
		move_item(c, &it, &bid_s, &me, &[]).await?;
		put_back(c, &with_turnover(&b, price)).await?;
		msg(c, "*", "info", &format!("$you() $conj(kaufst|kauft) {} für {} im {bname}.", txt(j::at(&it, "name")), coins_word(price)), templ()).await?;
		if tax != 0.0 { msg(c, &me, "info", &format!("{} Steuer gehen ins Lager der Siedlung.", coins_word(tax)), info()).await?; }
		return Ok(());
	}
	if re(r"^(?:verkaufe|sell)$").test(&word) {
		let inv = inventory(c).await?;
		let Some(it) = items_named(&w, &inv, &tail, None).into_iter().next().map(|e| fields(&e).clone()) else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&tail, 0, Some(30)))) };
		if !priced(j::s(&it, "proto")) { return refuse(format!("{} führt das Kaufhaus nicht.", txt(j::at(&it, "name")))); }
		let price = bid(j::s(&it, "proto"));
		if free < price { return refuse("Die Kasse des Kaufhauses ist zu leer dafür."); }
		let bid_s = txt(&build_id);
		move_item(c, &it, &me, &bid_s, &[]).await?;
		for m in till.iter().take(price as usize) { move_item(c, m, &bid_s, &me, &[]).await?; }
		put_back(c, &with_turnover(&b, price)).await?;
		return msg(c, "*", "info", &format!("$you() $conj(verkaufst|verkauft) {} für {} ans {bname}.", txt(j::at(&it, "name")), coins_word(price)), templ()).await;
	}
	if re(r"^(?:bestelle|bestellen|order)$").test(&word) {
		// laden bestelle <n> <ding> für <m>: the owner's delivery order, m coins each from the till
		if !owner(c, &b) { return refuse("Bestellen darf nur der Besitzer."); }
		let Some(m) = js::caps(&re(r"^(\d+)\s+(.+?)\s+(?:für|fuer|for)\s+(\d+)$"), &tail) else { return not_understood("So geht es: laden bestelle 5 fisch für 2 (Münzen je Stück).") };
		let (n, reward) = (js::to_number(m[1].as_deref().unwrap_or("")), js::to_number(m[3].as_deref().unwrap_or("")));
		let what = m[2].clone().unwrap_or_default();
		let lw = js::lower(&what);
		let Some(p) = j::a(&w, "prototypes").iter().find(|x| priced(j::s(x, "key")) && (j::s(x, "key") == lw || js::lower(&txt(j::at(x, "name"))) == lw || j::a(x, "aliases").iter().any(|a| a.as_str().is_some_and(|a| js::lower(a) == lw)))).cloned() else { return refuse(format!("{} führt das Kaufhaus nicht.", js::slice16(&what, 0, Some(30)))) };
		let max = j::n(&d, "orderMax");
		if n < 1.0 || n > max || reward < 1.0 { return refuse(format!("Bestellt werden 1 bis {} Stück für mindestens 1 Münze.", nt(max))); }
		if orders.len() as f64 >= j::n(&d, "orders") { return refuse(format!("Ein Kaufhaus hat höchstens {} Bestellungen offen; „laden storniere <ding>“ nimmt eine zurück.", txt(j::at(&d, "orders")))); }
		if orders.iter().any(|o| j::at(fields(o), "proto") == j::at(&p, "key")) { return refuse(format!("{} ist schon bestellt.", txt(j::at(&p, "name")))); }
		if free < n * reward { return refuse(format!("Dafür müssen {} frei in der Kasse liegen; frei sind {}.", coins_word(n * reward), coins_word(0f64.max(free)))); }
		let o = obj! { "orderId" => format!("so-{}", hex(&random_bytes(6))), "buildId" => build_id.clone(), "room" => j::at(&b, "room").clone(), "storeName" => j::at(&b, "name").clone(), "ownerName" => j::at(&b, "ownerName").clone(), "proto" => j::at(&p, "key").clone(), "protoName" => j::at(&p, "name").clone(), "count" => n, "reward" => reward };
		c.space.write(&tmpl("ShopOrder", o), c.txn(), FOREVER).await?;
		put_back(c, &b).await?;
		return msg(c, &me, "info", &format!("{bname} bestellt {}× {} zu {}; die Auftragstafeln zeigen es.", nt(n), txt(j::at(&p, "name")), coins_word(reward)), info()).await;
	}
	if re(r"^(?:storniere|stornieren|cancel)$").test(&word) {
		if !owner(c, &b) { return refuse("Stornieren darf nur der Besitzer."); }
		let lt = js::lower(&tail);
		let Some(o) = orders.iter().find(|x| { let f = fields(x); j::s(f, "proto") == lt || js::lower(&txt(j::at(f, "protoName"))) == lt }) else { let t = js::slice16(&tail, 0, Some(30)); return refuse(format!("{} ist nicht bestellt.", if t.is_empty() { "Das" } else { t })) };
		if c.space.take_if_exists(&obj! { "id" => j::at(o, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Die Bestellung ist gerade nicht greifbar; bitte noch einmal."); }
		put_back(c, &b).await?;
		return msg(c, &me, "info", &format!("Die Bestellung von {} ist zurückgenommen.", txt(j::at(fields(o), "protoName"))), info()).await;
	}
	if re(r"^(?:liefere|liefern|deliver)$").test(&word) {
		// anyone but the owner brings what is ordered, up to what is still wanted, paid piece by piece from the till
		if owner(c, &b) { return refuse("Die eigene Bestellung beliefert man nicht; leg es mit „laden“ ins Regal oder storniere sie."); }
		let am = js::caps(&re(r"^(\d+|alle?|all)\s+(.+)$"), &tail);
		let name = am.as_ref().map_or_else(|| tail.clone(), |m| m[2].clone().unwrap_or_default());
		let k0 = am.as_ref().and_then(|m| m[1].clone()).filter(|d| js::re(r"^\d+$", "").test(d)).map(|d| js::to_number(&d));
		let inv = inventory(c).await?;
		let Some(it) = items_named(&w, &inv, &name, None).into_iter().next().map(|e| fields(&e).clone()) else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&name, 0, Some(30)))) };
		let Some(o) = orders.iter().find(|x| j::at(fields(x), "proto") == j::at(&it, "proto")) else { return refuse(format!("{} hat {bname} nicht bestellt.", txt(j::at(&it, "name")))) };
		let of_o = of(o);
		let mine: Vec<Json> = inventory(c).await?.into_iter().map(|i| fields(&i).clone()).filter(|f| j::at(f, "proto") == j::at(&it, "proto")).collect();
		let k = k0.unwrap_or(mine.len() as f64).min(mine.len() as f64).min(j::n(&of_o, "count"));
		let reward = j::n(&of_o, "reward");
		if (till.len() as f64) < k * reward { return refuse("Die Kasse des Kaufhauses ist zu leer dafür."); }
		let bid_s = txt(&build_id);
		for i in mine.iter().take(k as usize) { move_item(c, i, &me, &bid_s, &[]).await?; }
		for m in till.iter().take((k * reward) as usize) { move_item(c, m, &bid_s, &me, &[]).await?; }
		if c.space.take_if_exists(&obj! { "id" => j::at(o, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Die Bestellung ist gerade nicht greifbar; bitte noch einmal."); }
		if j::n(&of_o, "count") > k { let mut f = of_o.clone(); j::set(&mut f, "count", j::n(&of_o, "count") - k); c.space.write(&tmpl("ShopOrder", f), c.txn(), FOREVER).await?; }
		put_back(c, &with_turnover(&b, k * reward)).await?;
		return msg(c, "*", "info", &format!("$you() $conj(lieferst|liefert) {}× {} ans {bname} und $conj(bekommst|bekommt) {}.", nt(k), txt(j::at(&it, "name")), coins_word(k * reward)), templ()).await;
	}
	let n = js::to_number(&tail);
	if re(r"^(?:einlegen|deposit|entnehme|entnehmen|withdraw)$").test(&word) && n.is_finite() && n.fract() == 0.0 && n > 0.0 {
		if !owner(c, &b) { return refuse("Die Kasse gehört dem Besitzer."); }
		let put = re(r"^(?:einlegen|deposit)$").test(&word);
		let inv = inventory(c).await?; let purse = purse_of(c, inv);
		if (if put { purse.len() as f64 } else { free }) < n { return refuse(if put || (till.len() as f64) < n { format!("Dort sind keine {}.", coins_word(n)) } else { format!("Davon sind {} für Bestellungen versprochen; frei sind {}.", coins_word(promised), coins_word(0f64.max(free))) }); }
		let bid_s = txt(&build_id);
		if put { for m in purse.iter().take(n as usize) { move_item(c, m, &me, &bid_s, &[]).await?; } }
		else { for m in till.iter().take(n as usize) { move_item(c, m, &bid_s, &me, &[]).await?; } }
		put_back(c, &b).await?;
		return msg(c, &me, "info", &format!("In der Kasse sind jetzt {}.", coins_word(till.len() as f64 + if put { n } else { -n })), info()).await;
	}
	not_understood("So geht es: laden, laden kaufe <ding>, laden verkaufe <ding>, laden liefere <ding>, laden einlegen <n>, laden entnehme <n>, laden bestelle <n> <ding> für <m>, laden storniere <ding>.")
}

fn bank_of(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "bank") { Some(d) => Ok(d.clone()), None => refuse("In dieser Welt gibt es keine Kontore.") } }

async fn kredit(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = bank_of(c)?;
	let Some(account) = c.account.clone().filter(|a| !j::b(a, "guest")) else { return refuse("Gäste bekommen keinen Kredit; registriere dich dafür.") };
	let mine = c.space.peek(&tmpl("Loan", obj! { "accountId" => j::at(&account, "accountId").clone() }), c.txn()).await?;
	let now = decay_now_of(&c.space, c.txn()).await?;
	let me = c.char_id().to_owned();
	let a = js::trim(arg).to_owned();
	if a.is_empty() {
		let text = match &mine { Some(l) => { let l = fields(l); format!("Du schuldest {}, noch etwa {} Tage.", coins_word(j::n(l, "owed")), nt(1f64.max(((j::n(l, "untilWorldMs") - now) / 86_400_000.0).ceil()))) } None => "Du hast keinen Kredit. „kredit <n> gegen <ding>“ leiht am Kontor Münzen gegen ein Pfand.".to_owned() };
		return msg(c, &me, "info", &text, info()).await;
	}
	let Some(m) = js::caps(&js::re(r"^(\d+)\s+gegen\s+(.+)$", "i"), &a) else { return not_understood("So geht es: kredit 5 gegen perle") };
	if mine.is_some() { return refuse("Du hast schon einen Kredit; tilge ihn erst."); }
	let plan = j::s(&d, "plan").to_owned();
	let Some(b) = take(c, &plan).await? else { return refuse(format!("Das geht nur direkt neben {}.", dative(c, &plan, "einem Kontor"))) };
	let what = m[2].clone().unwrap_or_default();
	let inv = inventory(c).await?;
	let Some(it) = items_named(c.w(), &inv, &no_article(&what), None).into_iter().next().map(|e| fields(&e).clone()) else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&what, 0, Some(30)))) };
	let n = js::to_number(m[1].as_deref().unwrap_or(""));
	let worth = j::no(j::at(j::at(c.w(), "shop"), "prices"), j::s(&it, "proto")).unwrap_or(0.0);
	let coin = coin_of(c);
	let till: Vec<Json> = inside(&c.space, j::at(&b, "buildId"), c.txn()).await?.into_iter().filter(|i| j::s(i, "proto") == coin).collect();
	let pledge = j::n(&d, "pledgeShare");
	if n < 1.0 || n > worth * pledge { return refuse(if worth != 0.0 { format!("Auf {} gibt es höchstens {}.", txt(j::at(&it, "name")), coins_word((worth * pledge).floor())) } else { format!("{} nimmt das Kontor nicht als Pfand.", txt(j::at(&it, "name"))) }); }
	if (till.len() as f64) < n { return refuse("Die Kasse des Kontors ist zu leer dafür."); }
	let loan_id = format!("loan-{}", hex(&random_bytes(6)));
	let owed = (n * (1.0 + j::n(&d, "interest"))).ceil();
	let loan = obj! { "loanId" => loan_id.as_str(), "buildId" => j::at(&b, "buildId").clone(), "room" => j::at(&b, "room").clone(), "accountId" => j::at(&account, "accountId").clone(), "charId" => me.as_str(), "charName" => j::at(&c.actor, "name").clone(), "owed" => owed, "untilWorldMs" => now + j::n(&d, "termWorldMs") };
	move_item(c, &it, &me, &loan_id, &[]).await?;
	let bid_s = txt(j::at(&b, "buildId"));
	for coin in till.iter().take(n as usize) { move_item(c, coin, &bid_s, &me, &[]).await?; }
	c.space.write(&tmpl("Loan", loan), c.txn(), FOREVER).await?;
	put_back(c, &b).await?;
	msg(c, &me, "info", &format!("Du leihst {} gegen {}. Zurück gehen {} („tilge“), binnen {} Tagen.", coins_word(n), txt(j::at(&it, "name")), coins_word(owed), nt(js::round(j::n(&d, "termWorldMs") / 86_400_000.0))), info()).await
}

async fn tilge(c: &mut Ctx) -> Result<()> {
	bank_of(c)?;
	let account_id = c.account.as_ref().map_or(Json::from(""), |a| j::opt(a, "accountId").cloned().unwrap_or(Json::from("")));
	let Some(e) = c.space.take_if_exists(&tmpl("Loan", obj! { "accountId" => account_id }), NO_WAIT, c.txn()).await? else { return refuse("Du hast keinen Kredit.") };
	let l = fields(&e).clone();
	let inv = inventory(c).await?; let purse = purse_of(c, inv);
	let house = c.space.peek(&tmpl("Building", obj! { "buildId" => j::at(&l, "buildId").clone() }), c.txn()).await?;
	let at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	if let Some(h) = &house { let h = fields(h); if j::s(h, "room") != c.room() || dist_to(at, Rect::of(h)) > 1.0 { return refuse("Getilgt wird am Kontor, bei dem du geliehen hast."); } }
	let me = c.char_id().to_owned();
	let loan_id = txt(j::at(&l, "loanId"));
	// the house is gone: nobody is owed the coins, so they stay with the debtor
	if house.is_none() {
		for p in inside(&c.space, j::at(&l, "loanId"), c.txn()).await? { move_item(c, &p, &loan_id, &me, &[]).await?; }
		return msg(c, &me, "info", "Das Kontor steht nicht mehr: niemand nimmt deine Münzen, und du bekommst dein Pfand wieder.", info()).await;
	}
	let owed = j::n(&l, "owed");
	if (purse.len() as f64) < owed { return refuse(format!("Dafür brauchst du {}.", coins_word(owed))); }
	let bid_s = txt(j::at(&l, "buildId"));
	for m in purse.iter().take(owed as usize) { move_item(c, m, &me, &bid_s, &[]).await?; }
	for p in inside(&c.space, j::at(&l, "loanId"), c.txn()).await? { move_item(c, &p, &loan_id, &me, &[]).await?; }
	msg(c, &me, "info", &format!("Du zahlst {} zurück und bekommst dein Pfand wieder.", coins_word(owed)), info()).await
}

/// `loanTick`: loans whose time ran out end: the pledge goes to the house, or back to the debtor when the house is gone
/// (job "epoch"). How many ended.
pub async fn loan_tick(space: &Space, w: &Json, _lease_ms: f64) -> Result<f64> {
	if j::opt(w, "bank").is_none() { return Ok(0.0); }
	let now = decay_now_of(space, None).await?;
	let mut ended = 0.0;
	for e in space.read_all(&obj! { "type" => "Loan" }, None).await? {
		if j::n(fields(&e), "untilWorldMs") > now { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(t) = space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(&txn)).await? else { return Ok(false) };
			let l = fields(&t).clone();
			let standing = space.count(&tmpl("Building", obj! { "buildId" => j::at(&l, "buildId").clone() }), None).await? > 0.0;
			let to = if standing { j::at(&l, "buildId").clone() } else { j::at(&l, "charId").clone() };
			for i in space.read_all(&tmpl("Item", obj! { "location" => j::at(&l, "loanId").clone() }), None).await? {
				let Some(it) = space.take_if_exists(&obj! { "id" => j::at(&i, "id").clone() }, NO_WAIT, Some(&txn)).await? else { continue };
				let mut f = fields(&it).clone();
				j::set(&mut f, "location", to.clone());
				let types: Vec<Json> = j::a(&it, "types").iter().skip(1).cloned().collect();
				space.write(&obj! { "type" => j::at(&it, "type").clone(), "types" => Json::Array(types), "fields" => f }, Some(&txn), FOREVER).await?;
			}
			let text = if standing { "Dein Kredit ist abgelaufen; das Pfand gehört jetzt dem Kontor." } else { "Dein Kontor steht nicht mehr; das Pfand ist wieder deins." };
			to_player(space, &obj! { "room" => j::at(&l, "room").clone(), "to" => j::at(&l, "charId").clone(), "kind" => "info", "text" => text, "from" => "", "at" => time_now() }, Some(&txn)).await?;
			Ok(true)
		}.await;
		match r {
			Ok(true) => { space.commit(&txn).await?; ended += 1.0; }
			Ok(false) => space.abort(&txn).await?,
			Err(e) => { let _ = space.abort(&txn).await; return Err(e); }
		}
	}
	Ok(ended)
}

async fn wechsel(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some((d, n)) = j::opt(c.w(), "bank").and_then(|d| j::opt(d, "note").map(|n| (d.clone(), n.clone()))) else { return refuse("In dieser Welt gibt es keine Wechsel.") };
	let word = js::lower(js::trim(arg));
	let note = j::s(&n, "proto").to_owned();
	let bills: Vec<Json> = inventory(c).await?.into_iter().map(|i| fields(&i).clone()).filter(|f| j::s(f, "proto") == note).collect();
	let me = c.char_id().to_owned();
	let coin = coin_of(c);
	let fee = j::n(&n, "fee");
	if word.is_empty() {
		let mut worth = 0.0;
		for b in &bills { worth += inside(&c.space, j::at(b, "itemId"), c.txn()).await?.iter().filter(|i| j::s(i, "proto") == coin).count() as f64; }
		return msg(c, &me, "info", &if bills.is_empty() { format!("Du trägst keinen Wechsel. „wechsel <n>“ legt am Kontor n Münzen in einen, für {} Gebühr.", coins_word(fee)) } else { format!("Du trägst {} Wechsel über zusammen {}; jedes Kontor löst sie ein („wechsel einlösen“).", bills.len(), coins_word(worth)) }, info()).await;
	}
	let plan = j::s(&d, "plan").to_owned();
	let Some(b) = take(c, &plan).await? else { return refuse(format!("Das geht nur direkt neben {}.", dative(c, &plan, "einem Kontor"))) };
	if js::re(r"^(?:einlösen|einloesen|einlöse|löse|loese|redeem|cash)$", "").test(&word) {
		if bills.is_empty() { return refuse("Du trägst keinen Wechsel."); }
		let mut got = 0.0;
		for bill in &bills {
			let id = txt(j::at(bill, "itemId"));
			for m in inside(&c.space, j::at(bill, "itemId"), c.txn()).await?.into_iter().filter(|i| j::s(i, "proto") == coin) { move_item(c, &m, &id, &me, &[]).await?; got += 1.0; }
			consume(c, bill, &me).await?;
		}
		put_back(c, &b).await?;
		return msg(c, &me, "info", &format!("Das Kontor zahlt dir {} aus: {}.", if bills.len() == 1 { "den Wechsel".to_owned() } else { format!("{} Wechsel", bills.len()) }, coins_word(got)), info()).await;
	}
	if c.account.as_ref().is_none_or(|a| j::b(a, "guest")) { return refuse("Gäste schreiben keine Wechsel; registriere dich dafür."); }
	let Some(m) = js::caps(&js::re(r"^(\d+)(?:\s+münzen?|\s+muenzen?)?$", ""), &word) else { return not_understood("So geht es: wechsel 20, wechsel einlösen") };
	let k = js::to_number(m[1].as_deref().unwrap_or(""));
	let max = j::n(&n, "max");
	if k < 1.0 || k > max { return refuse(format!("Ein Wechsel hält 1 bis {}.", coins_word(max))); }
	let inv = inventory(c).await?; let purse = purse_of(c, inv);
	if (purse.len() as f64) < k + fee { return refuse(format!("Dafür brauchst du {} ({} nimmt das Kontor).", coins_word(k + fee), coins_word(fee))); }
	let Some(p) = resolve_prototype(&c.space, &note).await? else { return refuse("Das Kontor hat gerade kein Papier.") };
	let bill = spawn(&c.space, c.txn(), c.w(), &p, At { location: me.clone(), x: -1.0, y: -1.0, ..Default::default() }, &obj! { "name" => format!("Wechsel über {}", coins_word(k)) }).await?;
	let bill_id = txt(j::at(&bill, "itemId"));
	for m in purse.iter().take(k as usize) { move_item(c, m, &me, &bill_id, &[]).await?; }
	let bid_s = txt(j::at(&b, "buildId"));
	for m in purse.iter().skip(k as usize).take(fee as usize) { move_item(c, m, &me, &bid_s, &[]).await?; }
	put_back(c, &b).await?;
	msg(c, &me, "info", &format!("Das Kontor schreibt dir einen Wechsel über {}; {} behält es. Jedes Kontor zahlt ihn aus, auch an jemand anderen.", coins_word(k), coins_word(fee)), info()).await
}
