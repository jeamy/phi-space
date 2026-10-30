// R3, slice 1: a store with its registry, the default Space and a named one, written by either implementation and
// carried on by the other. The registry's host key signs generations, so one TypeScript issued has to hold in Rust.
mod support;
use phi_core::driver::seeded;
use phi_core::space::Template;
use phi_json::{obj, parse, Json};
use phi_store::{Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, Synchronous};
use std::path::Path;
use std::process::Command;
use support::{dir, root};

fn open(file: &Path, seed: &str) -> Store {
	let mut n = 0;
	let seed = seed.to_owned();
	Store::open(SpaceHost::sqlite(SqliteLedger::open(file, Synchronous::Full).unwrap()), || {
		n += 1;
		seeded(&format!("{seed}{n}"))
	})
	.unwrap()
}

/// Runs an async body with `host`, `PhiSpaces`, `ctx`, `createSpace`, `listSpaces` and `Registry` at hand; it prints JSON.
fn ts(file: &Path, body: &str) -> Json {
	let m = |f: &str| root().join(f).to_str().unwrap().to_owned();
	let script = format!(
		"const {{ openSqliteHost }} = await import({:?}); const {{ PhiSpaces }} = await import({:?}); const {{ BACKGROUND_CONTEXT: ctx }} = await import({:?}); const {{ createSpace, listSpaces, Registry }} = await import({:?}); const host = await openSqliteHost({:?}); {body}; await host.close(ctx);",
		m("src/store/sqlite.ts"), m("src/client.ts"), m("src/context.ts"), m("src/spaces.ts"), file.to_str().unwrap()
	);
	let out = Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", &script]).current_dir(root()).output().unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	parse(std::str::from_utf8(&out.stdout).unwrap().trim()).unwrap()
}

fn write(n: f64) -> Json { obj! { "type" => "Note", "fields" => obj! { "n" => n } } }
fn count(s: &mut Store, space: Option<&str>) -> Json { s.reader(space).unwrap().space.count(1e12, &Template::Any, None, None).unwrap() }

#[test]
fn a_typescript_store_goes_on_in_rust() {
	let d = dir("registry-ts");
	let file = d.join("s.sqlite");
	let made = ts(&file, r#"
		const c = new PhiSpaces(host, ctx), p = { peerId: "a" };
		await c.write({ type: "Note", fields: { n: 1 } });
		const info = await host.commit((tx) => createSpace(tx, "other", Date.now()), ctx);
		const o = new PhiSpaces(host, ctx, Date.now, undefined, undefined, { space: "other" });
		await o.write({ type: "Note", fields: { n: 2 } }); await o.write({ type: "Note", fields: { n: 3 } });
		const g = await c.issueGeneration(p), r = await host.snapshot(Registry, ctx);
		console.log(JSON.stringify({ generation: g.generation, id: info.spaceId, hostId: r.hostId, hostKey: r.hostKey }))"#);
	let text = |k: &str| made.get(k).and_then(Json::as_str).unwrap().to_owned();
	let mut s = open(&file, "a");
	assert_eq!(s.host_id().unwrap(), text("hostId"));
	assert_eq!(s.host_key().unwrap(), text("hostKey"));
	assert_eq!(count(&mut s, None), Json::Number(1.0));
	assert_eq!(count(&mut s, Some("other")), Json::Number(2.0));
	assert_eq!(count(&mut s, Some(&text("id"))), Json::Number(2.0));
	// a generation the TypeScript host issued is admitted: same key, same space, same incarnation
	let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;
	let request = obj! { "principal" => obj! { "peerId" => "a" }, "generation" => text("generation"), "requestId" => "r1" };
	let admitted = s.commit(None, now, |sp| sp.admit(now, Some(&request), &"write".into(), &obj! {}, &Json::Number(1e15), 1024.0)).unwrap().unwrap();
	assert_eq!(admitted.value.get("kind").and_then(Json::as_str), Some("fresh"));
	s.commit(Some("other"), now, |sp| sp.write(now, &write(4.0), None, Some(&Json::Number(9e15)), None)).unwrap().unwrap();
	s.drain().unwrap();
	s.close();
	let seen = ts(&file, r#"
		const o = new PhiSpaces(host, ctx, Date.now, undefined, undefined, { space: "other" }), c = new PhiSpaces(host, ctx);
		const r = await host.snapshot(Registry, ctx);
		console.log(JSON.stringify({ other: await o.count(), first: await c.count(), hostId: r.hostId, spaces: (await listSpaces(host, ctx)).map((i) => i.alias) }))"#);
	assert_eq!(seen.get("other"), Some(&Json::Number(3.0)));
	assert_eq!(seen.get("first"), Some(&Json::Number(1.0)));
	assert_eq!(seen.get("hostId").and_then(Json::as_str), Some(text("hostId").as_str()));
	assert_eq!(seen.get("spaces"), Some(&Json::Array(vec!["default".into(), "other".into()])));
}

#[test]
fn a_rust_store_goes_on_in_typescript() {
	let d = dir("registry-rust");
	let file = d.join("s.sqlite");
	let mut s = open(&file, "b");
	assert!(s.registry().is_none());
	s.commit(None, 5000.0, |sp| sp.write(5000.0, &write(1.0), None, Some(&Json::Number(9e15)), None)).unwrap().unwrap();
	s.drain().unwrap();
	let (host_id, key) = (s.host_id().unwrap().to_owned(), s.host_key().unwrap().to_owned());
	assert!(host_id.starts_with("host-") && host_id.len() == 41, "{host_id}");
	assert_eq!(key.len(), 64);
	let space = s.registry().unwrap().get("defaultSpaceId").unwrap().clone();
	s.close();
	let seen = ts(&file, r#"
		const c = new PhiSpaces(host, ctx), r = await host.snapshot(Registry, ctx);
		await c.write({ type: "Note", fields: { n: 2 } }, null, 1e15);
		const info = (await listSpaces(host, ctx))[0];
		console.log(JSON.stringify({ r, count: await c.count(), info, conf: (await c.configuration()).spaceId }))"#);
	let r = seen.get("r").unwrap();
	assert_eq!(r.get("hostId").and_then(Json::as_str), Some(host_id.as_str()));
	assert_eq!(r.get("hostKey").and_then(Json::as_str), Some(key.as_str()));
	assert_eq!(r.get("defaultSpaceId"), Some(&space));
	assert_eq!(seen.get("conf"), Some(&space));
	assert_eq!(seen.get("count"), Some(&Json::Number(2.0)));
	assert_eq!(seen.get("info").unwrap().get("alias").and_then(Json::as_str), Some("default"));
	assert_eq!(seen.get("info").unwrap().get("createdAt"), Some(&Json::Number(5000.0)));
	// and the same identity once more in Rust
	let mut s = open(&file, "c");
	assert_eq!(s.host_id().unwrap(), host_id);
	assert_eq!(count(&mut s, None), Json::Number(2.0));
	s.close();
}

#[test]
fn a_first_commit_that_fails_leaves_nothing() {
	let mut s = Store::open(Ledger::Memory(MemoryLedger::default()), || seeded("m")).unwrap();
	let failed = s.commit(None, 1.0, |sp| sp.write(1.0, &obj! { "fields" => obj! {} }, None, None, None)).unwrap();
	assert_eq!(failed.err().unwrap().class, "IllegalArgumentError");
	assert!(s.registry().is_none());
	assert!(s.reader(None).unwrap().space.state.space_id.is_none());
	assert_eq!(s.reader(Some("x")).err().unwrap().class, "UnknownSpaceError");
	assert_eq!(s.commit(Some("default"), 1.0, |_| Ok(())).unwrap().err().unwrap().message, "unknown space: default");
	s.commit(None, 2.0, |sp| sp.write(2.0, &write(1.0), None, Some(&Json::Number(9e15)), None)).unwrap().unwrap();
	assert!(s.registry().is_some());
	assert!(s.reader(Some("default")).is_ok());
	assert!(s.commit(Some("default"), 3.0, |_| Ok(())).unwrap().is_ok());
}

#[test]
fn a_failed_first_commit_on_the_file_writes_no_registry() {
	let d = dir("registry-fail");
	let file = d.join("s.sqlite");
	let mut s = open(&file, "d");
	assert!(s.commit(None, 1.0, |sp| sp.write(1.0, &obj! { "fields" => obj! {} }, None, None, None)).unwrap().is_err());
	s.close();
	let seen = ts(&file, r#"console.log(JSON.stringify({ r: (await host.snapshot(Registry, ctx)) ?? null }))"#);
	assert_eq!(seen.get("r"), Some(&Json::Null));
}
