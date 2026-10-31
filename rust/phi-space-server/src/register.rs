// `--tls-register CONFIG.json`: {"host", "port", "caFile", "certFile", "keyFile", "file", "peersFile"}. The peers are read at each
// connection, {"<sha256 of the certificate>": {"operator"?: true, "writeKeys"?: [...]}}, so a removed one is out at once.
use crate::fail;
use phi_host::register::{serve_register, PeerPolicy, SqliteRegister};
use phi_host::tls::TlsIdentity;
use phi_json::{parse, Json};
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;
use tokio::net::TcpListener;
use tokio::signal::unix::{signal, SignalKind};

fn peers(file: &str) -> HashMap<String, PeerPolicy> {
	let Some(list) = std::fs::read_to_string(file).ok().and_then(|t| parse(&t).ok()) else { return HashMap::new() };
	let Some(list) = list.as_object() else { return HashMap::new() };
	list.iter().map(|(print, p)| (print.to_owned(), PeerPolicy { operator: p.get("operator") == Some(&Json::Bool(true)), write_keys: p.get("writeKeys").and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect()) })).collect()
}

pub fn register(config: &str) {
	let c = std::fs::read_to_string(config).map_err(|e| e.to_string()).and_then(|t| parse(&t).map_err(|e| e.to_string())).unwrap_or_else(|e| fail(format!("{config}: {e}")));
	let text = |k: &str| c.get(k).and_then(Json::as_str).map(str::to_owned).unwrap_or_else(|| fail(format!("{config}: no {k}")));
	let identity = TlsIdentity { ca_file: text("caFile"), cert_file: text("certFile"), key_file: text("keyFile") };
	let (host, peers_file) = (text("host"), text("peersFile"));
	let port = c.get("port").and_then(Json::as_f64).unwrap_or(0.0) as u16;
	let db = SqliteRegister::open(Path::new(&text("file"))).unwrap_or_else(|e| fail(e));
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap_or_else(|e| fail(e));
	let local = tokio::task::LocalSet::new();
	local.block_on(&runtime, async {
		let listener = TcpListener::bind((host.as_str(), port)).await.unwrap_or_else(|e| fail(e));
		println!("[phi-spaces] register ready on tcp:{host}:{}", listener.local_addr().map_or(port, |a| a.port()));
		let mut term = signal(SignalKind::terminate()).unwrap_or_else(|e| fail(e));
		let mut int = signal(SignalKind::interrupt()).unwrap_or_else(|e| fail(e));
		tokio::select! {
			done = serve_register(db, &identity, listener, Rc::new(move || peers(&peers_file))) => { if let Err(e) = done { fail(e) } }
			_ = term.recv() => {}
			_ = int.recv() => {}
		}
	});
}
