//! What a Member does at its start and in its heartbeat, where the mixed test cannot wait or reach.
use phi_core::space::Template;
use phi_host::boot::{BootGuard, External};
use phi_host::capability::publish;
use phi_host::register::SqliteRegister;
use phi_json::{obj, Json};
use phi_service::{Options, Service};
use phi_store::{system_random, MemoryLedger, Store};
use std::rc::Rc;

fn service() -> Service {
	let store = Store::open(phi_store::Ledger::Memory(MemoryLedger::default()), system_random).unwrap();
	Service::new(store, Options::single_peer("p"))
}

fn capabilities(s: &mut Service, space: &str) -> Vec<Json> {
	let t = Template::from_json(Some(&obj! { "type" => "Capability" })).unwrap();
	s.commit_on(Some(space), |x, now| x.list(now, &t, None, None, None)).unwrap().as_array().unwrap().clone()
}

#[test]
fn a_heartbeat_replaces_its_record_and_duplicates_stop_it() {
	let mut s = service();
	let info = s.create_space_with("jobs", system_random(), |_, _| Ok(())).unwrap();
	let id = info.get("spaceId").and_then(Json::as_str).unwrap().to_owned();
	let report = obj! { "hostId" => "h", "tools" => Vec::<Json>::new() };
	publish(&mut s, &id, &report, &|_, _| Ok(())).unwrap();
	publish(&mut s, &id, &report, &|_, _| Ok(())).unwrap();
	assert_eq!(capabilities(&mut s, &id).len(), 1, "one record, not one per heartbeat");
	for _ in 0..4 {
		s.commit_on(Some(&id), |x, now| x.write(now, &obj! { "type" => "Capability", "fields" => obj! { "hostId" => "h" } }, None, Some(&Json::Number(100_000.0)), None)).unwrap();
	}
	assert_eq!(publish(&mut s, &id, &report, &|_, _| Ok(())).unwrap_err().message, "duplicate directory records");
}

#[test]
fn a_deleted_space_leaves_the_rounds_of_the_background() {
	let mut s = service();
	let info = s.create_space_with("gone", system_random(), |_, _| Ok(())).unwrap();
	let id = info.get("spaceId").and_then(Json::as_str).unwrap().to_owned();
	assert_eq!(s.store.named_ids(), vec![id.clone()]);
	s.delete_space(&id, |_, _| Ok(())).unwrap();
	assert!(s.store.named_ids().is_empty());
}

#[tokio::test]
async fn a_permit_of_other_data_is_not_installed() {
	let dir = std::env::temp_dir().join(format!("phi-start-{}", std::process::id()));
	std::fs::create_dir_all(&dir).unwrap();
	let (external, installed) = (dir.join("external.sqlite"), dir.join("installed.sqlite"));
	let _ = (std::fs::remove_file(&external), std::fs::remove_file(&installed));
	let permit = |i: &str| obj! { "state" => "active", "dataIncarnation" => i };
	SqliteRegister::open(&external).unwrap().compare_and_set("boot:h", None, &obj! { "hostId" => "h", "state" => "active", "spaces" => obj! { "a" => permit("one"), "b" => permit("other") } }).unwrap();
	let guard = BootGuard::new("h", "authority", External::File(SqliteRegister::open(&external).unwrap()), SqliteRegister::open(&installed).unwrap(), Rc::new(|| 0.0), 60_000.0);
	guard.admit_at_start(&[obj! { "spaceId" => "a", "incarnation" => "one" }, obj! { "spaceId" => "b", "incarnation" => "mine" }]).await.unwrap();
	let local = SqliteRegister::open(&installed).unwrap();
	assert!(!local.get("installed:h:a").unwrap().is_null());
	assert!(local.get("installed:h:b").unwrap().is_null());
	let _ = std::fs::remove_dir_all(dir);
}
