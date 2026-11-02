// `--replica-tool CONFIG.json REQUEST`: the operator's tool for the primary/sync Space of a host whose daemon is stopped, what
// `replica-host.ts tool` does (test/testbed/federation-host.ts, mode sync): `status`, `wipe` (the Space's directory set aside),
// `promote` and `degrade` behind the fencing service, `set-standby` with a quarantined target. Prints one JSON line.
use crate::member::{config_of, field};
use crate::fail;
use phi_host::auth::Signer;
use phi_host::register::{RegisterClient, SqliteRegister};
use phi_host::replica_transitions::{degrade_to_single, promote, set_standby, BlockingRegister, Common, Excluded, Fencing, TlsFencing};
use phi_host::replica_transport::{SignedReplicaPeer, SocketTransport};
use phi_host::sync_space::SyncSpaceConfig;
use phi_host::tls::{private_file, TlsIdentity};
use phi_json::{obj, parse, text, Json};
use phi_store::sync::{JournalOptions, SyncJournal};
use phi_store::sync_store::SyncStoreFile;
use std::path::Path;

fn now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after 1970").as_millis() as f64 }

/// A TLS line of the request (`{caFile, certFile, keyFile, host, port}`).
fn line(v: &Json, timeout_ms: u64) -> RegisterClient {
	let identity = TlsIdentity { ca_file: field(v, "caFile").into(), cert_file: field(v, "certFile").into(), key_file: field(v, "keyFile").into() };
	RegisterClient::new(RegisterClient { identity, host: field(v, "host").into(), port: v.get("port").and_then(Json::as_f64).unwrap_or(0.0) as u16, server_name: text(v, "serverName").map(str::to_owned), timeout_ms: v.get("timeoutMs").and_then(Json::as_f64).map_or(timeout_ms, |t| t as u64), batch_reads: false, unix_path: None }).unwrap_or_else(|e| fail(e))
}

pub fn run(config: &str, request: &str) {
	let c = config_of(config, "member", "the replica tool works on a member's config", &[]);
	let q = parse(request).unwrap_or_else(|e| fail(format!("the request: {e}")));
	let host_id = field(&c, "hostId");
	let s = c.get("syncSpaces").and_then(Json::as_array).and_then(|a| a.first()).unwrap_or_else(|| fail("the config has no primary/sync Space"));
	let sc = SyncSpaceConfig::from_json(s).unwrap_or_else(|e| fail(e));
	let journal_path = sc.dir.join("journal.sqlite");
	let o = JournalOptions { max_intent_bytes: sc.max_intent_bytes, max_history_bytes: sc.max_history_bytes, self_id: Some(host_id.into()), format: None };
	let op = text(&q, "op").unwrap_or("");
	if op == "wipe" {
		let aside = format!("{}.aside", sc.dir.display());
		std::fs::rename(&sc.dir, &aside).unwrap_or_else(|e| fail(e));
		return println!("{}", obj! { "aside" => aside }.to_json_text());
	}
	let mut journal = SyncJournal::open(&journal_path, &sc.genesis, o).unwrap_or_else(|e| fail(e));
	let result = match op {
		"status" => {
			if q.get("materialize").is_some_and(|m| m != &Json::Bool(false)) {
				fail("materialize is read by the TypeScript tool");
			}
			let head = journal.head().unwrap_or_else(|e| fail(e));
			let applied = journal.applied_revision().unwrap_or_else(|e| fail(e)) as f64;
			let mut r = obj! { "head" => head.clone(), "applied" => applied, "config" => journal.config(), "recoveredCommitted" => journal.recovered_committed().unwrap_or_else(|e| fail(e)) };
			let o = r.as_object_mut().expect("an object");
			let revision = head.get("revision").and_then(Json::as_f64).unwrap_or(0.0);
			if revision > applied {
				o.insert("candidate", journal.intent(revision).unwrap_or_else(|e| fail(e)).map_or(Json::Null, |i| Json::String(i.to_json_text())));
			}
			if let Some(at) = q.get("revision").and_then(Json::as_f64) {
				o.insert("atRevision", journal.intent(at).unwrap_or_else(|e| fail(e)).and_then(|i| i.get("hash").cloned()).unwrap_or(Json::Null));
			}
			let hash = if applied > 0.0 { journal.intent(applied).unwrap_or_else(|e| fail(e)).and_then(|i| i.get("hash").cloned()).unwrap_or(Json::Null) } else { Json::Null };
			o.insert("appliedHash", hash);
			r
		}
		"promote" | "degrade" | "set-standby" => {
			let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap_or_else(|e| fail(e));
			let register = line(q.get("register").unwrap_or_else(|| fail("the request has no register")), 6_000);
			let boots = BlockingRegister(&rt, &register);
			let installed = SqliteRegister::open(Path::new(field(&c, "installedRegisterFile"))).unwrap_or_else(|e| fail(e));
			let mut storage = SyncStoreFile::open(&sc.dir.join("harness.sqlite")).unwrap_or_else(|e| fail(e));
			let tid = text(&q, "tid").unwrap_or_else(|| fail("the request has no tid")).to_owned();
			let mut o = Common { storage: &mut storage, journal: &mut journal, register: &boots, installed: Some(&installed), host_id, data_incarnation: &sc.incarnation, now: now() };
			if op == "set-standby" {
				let target = text(&q, "target").unwrap_or_else(|| fail("the request has no target"));
				let (pin, ip) = sc.peers.iter().find(|(p, _)| p.host_id == target).cloned().unwrap_or_else(|| fail(format!("{target} is not a peer of this Space")));
				let local = c.get("listen").and_then(|l| text(l, "host")).and_then(|h| h.parse().ok());
				let key = parse(&String::from_utf8_lossy(&private_file(Path::new(field(&c, "keyFile"))).unwrap_or_else(|e| fail(e)))).unwrap_or_else(|e| fail(e));
				let (signer, _) = Signer::from_key_file(&key).unwrap_or_else(|e| fail(e));
				let mut peer = SignedReplicaPeer { transport: Box::new(SocketTransport::new((ip.to_string(), sc.port), local)), signer, self_id: host_id.into(), remote: pin, now: Box::new(now) };
				set_standby(&mut o, &tid, &mut peer, &sc.incarnation).unwrap_or_else(|e| fail(e))
			} else {
				let f = q.get("fencing").unwrap_or_else(|| fail("the request has no fencing"));
				let adapter = TlsFencing { rt: &rt, line: line(f, 240_000), kind: "container".into() };
				let config = o.journal.config();
				let other = text(&config, if op == "promote" { "primaryReplica" } else { "standbyReplica" }).unwrap_or("").to_owned();
				let proof = adapter.fence(&other, &format!("{op} {tid}")).unwrap_or_else(|e| fail(e));
				let (epoch, version) = (q.get("epoch").and_then(Json::as_f64).unwrap_or(f64::NAN), q.get("version").and_then(Json::as_f64).unwrap_or(f64::NAN));
				let done = if op == "promote" { promote(&mut o, &tid, epoch, version, &adapter, &proof) } else { degrade_to_single(&mut o, &tid, epoch, version, Excluded::Fenced(&adapter, &proof)) };
				let mut r = done.unwrap_or_else(|e| fail(e));
				let verified = adapter.verify(&proof).unwrap_or_else(|e| fail(e));
				let o = r.as_object_mut().expect("an object");
				o.insert("proof", obj! { "kind" => proof.get("kind").cloned().unwrap_or(Json::Null), "evidence" => proof.get("evidence").cloned().unwrap_or(Json::Null) });
				o.insert("verified", Json::Bool(verified));
				r
			}
		}
		_ => fail(format!("unknown op {op}")),
	};
	println!("{}", result.to_json_text());
}
