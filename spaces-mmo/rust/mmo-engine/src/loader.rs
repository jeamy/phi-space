//! Loading a world definition into the space (`server/engine/loader.ts`): under the world lock and in transactions of a
//! dozen rooms each, rooms, exits, prototypes and help topics are written when missing or replaced when the space holds an
//! older version; placed things only while none with their itemId exists anywhere; the NPCs with what they carry; beacons,
//! scenery, fog, the clock and the world's dates.
use phi_json::{obj, Json, Object};

use crate::j;
use crate::model::{actor_token, world_lock};
use crate::prototypes::{resolve_from, spawn, At};
use crate::room_growth::{grown_decor, grown_ground, grown_point, growth_at, rows, rows_json};
use crate::schedule::ensure_schedule;
use crate::source::time_now;
use crate::space::{by_id, fields, tmpl, Error, Result, Space, FOREVER, HELD_WAIT_MS, NO_WAIT};
use crate::typeclasses::draft_of;
use crate::worldevents::world_schedules;
use crate::worldtime::{initial_clock, time_scale, world_at, DEFAULT_START_HOUR};

const ROOMS_PER_TXN: usize = 12;

/// What a load did.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadResult { pub loaded: bool, pub version: f64, pub spawned: Vec<String> }

impl LoadResult {
	pub fn to_json(&self) -> Json { obj! { "loaded" => self.loaded, "version" => self.version, "spawned" => phi_json::strings(&self.spawned) } }
}

async fn take_lock(space: &Space, txn: &str) -> Result<()> {
	if space.take(&world_lock(), 20_000.0, Some(txn)).await?.is_none() { return Err(Error::Other("the world lock stayed taken".into())); }
	Ok(())
}

async fn give_lock(space: &Space, txn: &str) -> Result<()> { space.write(&world_lock(), Some(txn), FOREVER).await.map(|_| ()) }

/// `ensureTokens`: the missing actor tokens, one per character, under the world lock.
pub async fn ensure_tokens(space: &Space) -> Result<f64> {
	let txn = space.create_transaction(30_000.0).await?;
	let run = async {
		take_lock(space, &txn).await?;
		let wanted: Vec<Json> = space.read_all(&obj! { "type" => "Character" }, None).await?.iter().map(|e| actor_token(j::s(fields(e), "charId"))).collect();
		let mut written = 0.0;
		for token in wanted {
			match space.read_existing(&token, Some(&txn), HELD_WAIT_MS).await {
				Ok(Some(_)) | Err(Error::StillHeld(_)) => continue,
				Ok(None) => {}
				Err(e) => return Err(e),
			}
			space.write(&token, Some(&txn), FOREVER).await?;
			written += 1.0;
		}
		give_lock(space, &txn).await?;
		space.commit(&txn).await?;
		Ok(written)
	};
	match run.await { Ok(v) => Ok(v), Err(e) => { let _ = space.abort(&txn).await; Err(e) } }
}

/// `underLock`: a transaction of its own that holds the world lock. The body gets the transaction's id.
macro_rules! under_lock {
	($space:expr, $ms:expr, |$txn:ident| $body:block) => {{
		let __t = $space.create_transaction($ms).await?;
		let __r: Result<_> = async {
			take_lock($space, &__t).await?;
			let $txn: &str = &__t;
			let v = $body;
			give_lock($space, &__t).await?;
			$space.commit(&__t).await?;
			Ok(v)
		}.await;
		match __r { Ok(v) => v, Err(e) => { let _ = $space.abort(&__t).await; return Err(e); } }
	}};
}

/// Writes `draft` keyed by `key` in `txn`: when missing, or (replacing) instead of what is there.
async fn upsert(space: &Space, txn: &str, replace: bool, ty: &str, key: Json, draft: Json) -> Result<()> {
	let old = space.peek(&tmpl(ty, key), Some(txn)).await?;
	if old.is_some() && !replace { return Ok(()); }
	if let Some(old) = old { space.take(&by_id(ty, &old), NO_WAIT, Some(txn)).await?; }
	space.write(&draft, Some(txn), FOREVER).await?;
	Ok(())
}

/// `readExisting` that counts a held match as there (`continue` in the TypeScript loops).
async fn exists_or_held(space: &Space, tmpl: &Json, txn: &str) -> Result<Option<bool>> {
	match space.read_existing(tmpl, Some(txn), HELD_WAIT_MS).await {
		Ok(v) => Ok(Some(v.is_some())),
		Err(Error::StillHeld(_)) => Ok(None),
		Err(e) => Err(e),
	}
}

async fn at_point(space: &Space, txn: &str, room: &str, p: &Json) -> Result<Json> { Ok(grown_point(p, &growth_at(space, Some(txn), room).await?, 0)) }

/// Options of a load.
#[derive(Default)]
pub struct LoadOptions { pub replace: bool, pub txn_ms: Option<f64>, pub elsewhere: Option<Vec<Space>> }

/// The world host's `elsewhere` for a region: whether a thing exists in another region's space, or on a ferry (in a
/// Handover, in neither region's things) of any region.
async fn elsewhere(space: &Space, others: &[Space], item_id: &str) -> Result<bool> {
	for s in std::iter::once(space).chain(others) {
		if s.key() != space.key() && !s.read_limit(&tmpl("Item", obj! { "itemId" => item_id }), 1, None).await?.is_empty() { return Ok(true); }
		if s.read_all(&obj! { "type" => "Handover" }, None).await?.iter().any(|h| j::a(fields(h), "items").iter().any(|i| j::at(j::at(i, "fields"), "itemId").as_str() == Some(item_id))) { return Ok(true); }
	}
	Ok(false)
}

/// `loadIntoSpace`; `elsewhere` the other regions' spaces (None: nothing exists outside this space).
pub async fn load_into_space(space: &Space, w: &Json, o: LoadOptions) -> Result<LoadResult> {
	let txn_ms = o.txn_ms.unwrap_or(30_000.0);
	let wid = j::s(w, "id");
	let version = j::n(w, "version");
	let tcs = j::at(w, "typeclasses");
	let tile = j::so(j::at(w, "growth"), "tile").unwrap_or(",").to_owned();
	let replace: bool = under_lock!(space, txn_ms, |txn| {
		let marker = space.peek(&tmpl("WorldLoaded", obj! { "worldId" => wid }), Some(txn)).await?;
		o.replace || marker.map_or(0.0, |m| j::n(fields(&m), "version")) < version
	});
	let rooms = j::a(w, "rooms");
	for chunk in rooms.chunks(ROOMS_PER_TXN) {
		under_lock!(space, txn_ms, |txn| {
			for r in chunk {
				let rid = j::s(r, "roomId");
				let grown = space.peek(&tmpl("RoomGrowth", obj! { "roomId" => rid }), Some(txn)).await?;
				let g = grown.map_or_else(|| obj! { "east" => 0.0, "south" => 0.0 }, |e| fields(&e).clone());
				let decor = grown_decor(j::opt(r, "decor").map(rows).as_deref(), &g)?;
				let mut f = Object::new();
				f.insert("roomId", Json::from(rid));
				f.insert("name", j::at(r, "name").clone());
				f.insert("desc", j::at(r, "desc").clone());
				f.insert("ground", rows_json(&grown_ground(&rows(j::at(r, "ground")), &g, &tile, false)?));
				if let Some(d) = &decor { f.insert("decor", rows_json(d)); }
				f.insert("spawn", grown_point(j::at(r, "spawn"), &g, 0));
				if j::b(r, "map") { f.insert("map", j::at(r, "map").clone()); }
				if j::b(r, "island") { f.insert("island", j::at(r, "island").clone()); }
				upsert(space, txn, replace, "Room", obj! { "roomId" => rid }, draft_of("Room", tcs, Json::Object(f))?).await?;
			}
		});
	}
	for chunk in j::a(w, "exits").chunks(ROOMS_PER_TXN * 4) {
		under_lock!(space, txn_ms, |txn| {
			for e in chunk {
				let moved = at_point(space, txn, j::s(e, "room"), e).await?;
				let room = j::at(&moved, "room").clone();
				let rest = j::without(&moved, "room");
				let dest = growth_at(space, Some(txn), j::s(e, "destination")).await?;
				let mut f = j::object(&rest);
				f.insert("arrive", grown_point(j::at(e, "arrive"), &dest, 0));
				f.insert("arriveGrowthRevision", Json::from(j::a(&dest, "steps").len() as f64));
				f.insert("location", room);
				f.insert("locks", j::opt(e, "locks").cloned().unwrap_or(Json::from("")));
				upsert(space, txn, replace, "Exit", obj! { "exitId" => j::at(e, "exitId").clone() }, draft_of("Exit", tcs, Json::Object(f))?).await?;
			}
		});
	}
	under_lock!(space, txn_ms, |txn| {
		for p in j::a(w, "prototypes") { upsert(space, txn, replace, "Prototype", obj! { "key" => j::at(p, "key").clone() }, obj! { "type" => "Prototype", "fields" => p.clone() }).await?; }
	});
	under_lock!(space, txn_ms, |txn| {
		for h in j::a(w, "help") { upsert(space, txn, replace, "HelpEntry", obj! { "key" => j::at(h, "key").clone() }, obj! { "type" => "HelpEntry", "fields" => h.clone() }).await?; }
	});
	let region = j::b(w, "region");
	let here: Vec<&str> = rooms.iter().map(|r| j::s(r, "roomId")).collect();
	let prototypes = j::a(w, "prototypes");
	for chunk in j::a(w, "npcs").chunks(ROOMS_PER_TXN) {
		under_lock!(space, txn_ms, |txn| {
			for n in chunk {
				let nroom = j::s(n, "room");
				if region && !here.contains(&nroom) { continue; }
				let char_id = format!("npc-{}", j::s(n, "npcId"));
				let Some(exists) = exists_or_held(space, &tmpl("Character", obj! { "charId" => char_id.as_str() }), txn).await? else { continue };
				if !exists && region && space.peek(&tmpl("NpcBorn", obj! { "charId" => char_id.as_str() }), Some(txn)).await?.is_some() { continue; }
				if !exists && region { space.write(&tmpl("NpcBorn", obj! { "charId" => char_id.as_str() }), Some(txn), FOREVER).await?; }
				if !exists {
					let now = time_now();
					let mut acc = Object::new();
					for (k, v) in [("accountId", Json::from(char_id.as_str())), ("name", j::at(n, "name").clone()), ("guest", Json::Bool(false)), ("admin", Json::Bool(false)), ("npc", Json::Bool(true))] { acc.insert(k, v); }
					if j::b(n, "settler") { acc.insert("settler", Json::Bool(true)); }
					acc.insert("createdAt", Json::from(now));
					acc.insert("touchedAt", Json::from(now));
					space.write(&obj! { "type" => "Account", "fields" => Json::Object(acc) }, Some(txn), FOREVER).await?;
					let p = at_point(space, txn, nroom, &obj! { "x" => j::at(n, "x").clone(), "y" => j::at(n, "y").clone() }).await?;
					let ch = obj! { "charId" => char_id.as_str(), "accountId" => char_id.as_str(), "name" => j::at(n, "name").clone(), "room" => nroom, "x" => j::at(&p, "x").clone(), "y" => j::at(&p, "y").clone(), "skin" => j::at(n, "skin").clone(), "guest" => false };
					space.write(&obj! { "type" => "Character", "fields" => ch }, Some(txn), FOREVER).await?;
					space.write(&actor_token(&char_id), Some(txn), FOREVER).await?;
				}
				if !exists || replace {
					for c in j::a(n, "carry") {
						for i in 0..j::n(c, "count") as usize {
							let item_id = format!("{char_id}-{}-{}", j::s(c, "proto"), i + 1);
							match exists_or_held(space, &tmpl("Item", obj! { "itemId" => item_id.as_str() }), txn).await? { Some(false) => {} _ => continue }
							if let Some(others) = &o.elsewhere { if elsewhere(space, others, &item_id).await? { continue; } }
							let p = resolve_from(prototypes, j::s(c, "proto")).ok_or_else(|| Error::Other(format!("unknown prototype {}", j::s(c, "proto"))))?;
							spawn(space, Some(txn), w, &p, At { item_id: Some(item_id), location: char_id.clone(), x: -1.0, y: -1.0, ..At::default() }, &Json::Null).await?;
						}
					}
				}
			}
		});
	}
	let txn = space.create_transaction(txn_ms).await?;
	let last: Result<LoadResult> = async {
		let txn = txn.as_str();
		take_lock(space, txn).await?;
		let marker = space.peek(&tmpl("WorldLoaded", obj! { "worldId" => wid }), Some(txn)).await?;
		let mut spawned = Vec::new();
		if replace {
			for obj in j::a(w, "objects") {
				let item_id = j::s(obj, "itemId");
				match exists_or_held(space, &tmpl("Item", obj! { "itemId" => item_id }), txn).await? { Some(false) => {} _ => continue }
				if let Some(others) = &o.elsewhere { if elsewhere(space, others, item_id).await? { continue; } }
				let p = resolve_from(prototypes, j::s(obj, "proto")).ok_or_else(|| Error::Other(format!("unknown prototype {}", j::s(obj, "proto"))))?;
				let room = j::s(obj, "room");
				let pt = at_point(space, txn, room, &obj! { "x" => j::at(obj, "x").clone(), "y" => j::at(obj, "y").clone() }).await?;
				spawn(space, Some(txn), w, &p, At { item_id: Some(item_id.to_owned()), location: room.to_owned(), x: j::n(&pt, "x"), y: j::n(&pt, "y"), ..At::default() }, &Json::Null).await?;
				spawned.push(item_id.to_owned());
			}
		}
		for b in j::a(w, "beacons") {
			let old = space.read_if_exists(&tmpl("Beacon", obj! { "beaconId" => j::at(b, "beaconId").clone() }), 2_000.0, Some(txn)).await?;
			if old.is_some() && !replace { continue; }
			if let Some(old) = &old { space.take(&by_id("Beacon", old), NO_WAIT, Some(txn)).await?; }
			let mut f = j::object(&at_point(space, txn, j::s(b, "room"), b).await?);
			f.insert("lit", Json::Bool(old.as_ref().is_some_and(|o| j::b(fields(o), "lit"))));
			space.write(&obj! { "type" => "Beacon", "fields" => Json::Object(f) }, Some(txn), FOREVER).await?;
		}
		for base in j::a(w, "scenery") {
			let sc = at_point(space, txn, j::s(base, "room"), base).await?;
			let sid = j::at(&sc, "sceneryId").clone();
			if space.read_if_exists(&tmpl("Scenery", obj! { "sceneryId" => sid.clone() }), 2_000.0, Some(txn)).await?.is_some()
				|| space.read_if_exists(&tmpl("SceneryGone", obj! { "sceneryId" => sid.clone() }), 2_000.0, Some(txn)).await?.is_some() { continue; }
			let (x, y, sw, sh) = (j::n(&sc, "x"), j::n(&sc, "y"), j::n(&sc, "w"), j::n(&sc, "h"));
			let cells: Vec<(f64, f64)> = (0..(sw * sh) as usize).map(|i| (x + (i as f64 % sw), y + (i as f64 / sw).floor())).collect();
			let through = j::b(&sc, "through");
			let plots = if through { vec![] } else { space.read_all(&tmpl("Plot", obj! { "room" => j::at(&sc, "room").clone() }), Some(txn)).await? };
			if plots.iter().any(|p| cells.iter().any(|(cx, cy)| j::at(fields(p), "x").as_f64() == Some(*cx) && j::at(fields(p), "y").as_f64() == Some(*cy))) { continue; }
			let mut f = j::object(&sc);
			f.insert("left", j::at(&sc, "work").clone());
			space.write(&obj! { "type" => "Scenery", "fields" => Json::Object(f) }, Some(txn), FOREVER).await?;
			if !through {
				for (cx, cy) in &cells {
					space.write_unique(&obj! { "type" => "Plot", "fields" => obj! { "room" => j::at(&sc, "room").clone(), "x" => *cx, "y" => *cy, "of" => sid.clone() } }, Some(txn), FOREVER, &["room", "x", "y"]).await?;
				}
			}
		}
		let mut fog_rooms: Vec<&str> = Vec::new();
		for b in j::a(w, "beacons") { for c in j::a(b, "covers") { if let Some(c) = c.as_str() { if !fog_rooms.contains(&c) { fog_rooms.push(c); } } } }
		for room in fog_rooms {
			if space.read_if_exists(&tmpl("Fog", obj! { "room" => room }), 2_000.0, Some(txn)).await?.is_none() {
				space.write(&obj! { "type" => "Fog", "fields" => obj! { "room" => room, "level" => j::at(j::at(w, "fog"), "start").clone() } }, Some(txn), FOREVER).await?;
			}
		}
		if replace {
			for e in space.read_all(&obj! { "type" => "Character" }, None).await? {
				let ch = fields(&e);
				let cid = j::s(ch, "charId");
				if !cid.starts_with("npc-") || j::a(w, "npcs").iter().any(|n| format!("npc-{}", j::s(n, "npcId")) == cid) { continue; }
				if space.take_if_exists(&actor_token(cid), NO_WAIT, Some(txn)).await?.is_none() { continue; }
				for it in space.read_all(&tmpl("Item", obj! { "location" => cid }), Some(txn)).await? {
					if let Some(item) = space.take(&by_id("Item", &it), NO_WAIT, Some(txn)).await? {
						let types = j::a(&item, "types").get(1..).map(<[Json]>::to_vec).unwrap_or_default();
						let mut f = j::object(fields(&item));
						f.insert("location", j::at(ch, "room").clone());
						f.insert("x", j::at(ch, "x").clone());
						f.insert("y", j::at(ch, "y").clone());
						space.write(&obj! { "type" => j::at(&item, "type").clone(), "types" => Json::Array(types), "fields" => Json::Object(f) }, Some(txn), FOREVER).await?;
					}
				}
				space.take(&by_id("Character", &e), NO_WAIT, Some(txn)).await?;
				space.take_if_exists(&tmpl("Account", obj! { "accountId" => cid }), NO_WAIT, Some(txn)).await?;
			}
		}
		if replace {
			if let Some(m) = &marker { space.take(&by_id("WorldLoaded", m), NO_WAIT, Some(txn)).await?; }
			space.write(&obj! { "type" => "WorldLoaded", "fields" => obj! { "worldId" => wid, "version" => version, "at" => time_now() } }, Some(txn), FOREVER).await?;
		}
		let clock = match space.peek(&tmpl("WorldClock", obj! { "worldId" => wid }), Some(txn)).await? {
			Some(e) => fields(&e).clone(),
			None => {
				let c = initial_clock(wid, j::no(w, "startHour").unwrap_or(DEFAULT_START_HOUR), time_now(), time_scale());
				space.write(&obj! { "type" => "WorldClock", "fields" => c.clone() }, Some(txn), FOREVER).await?;
				c
			}
		};
		let max_ms = j::n(j::at(w, "fire"), "maxMs");
		for f in space.read_all(&obj! { "type" => "Flame" }, Some(txn)).await? {
			if j::number(j::at(fields(&f), "until")) > world_at(&clock, time_now()) + 2.0 * max_ms { space.take_if_exists(&by_id("Flame", &f), NO_WAIT, Some(txn)).await?; }
		}
		for (f, refresh) in world_schedules(w, j::n(&clock, "epoch"), world_at(&clock, time_now())) { ensure_schedule(space, Some(txn), &f, refresh).await?; }
		give_lock(space, txn).await?;
		space.commit(txn).await?;
		Ok(LoadResult { loaded: replace, version, spawned })
	}.await;
	match last { Ok(v) => Ok(v), Err(e) => { let _ = space.abort(&txn).await; Err(e) } }
}
