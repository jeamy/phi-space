//! The page as static files (`server/pages.ts`): `/` as index.html, `/x` as x, x.html or x/index.html; GET and HEAD
//! only; nothing outside the folder, no hidden file, not BUILD_ID. `/_next/static/…` is cached for a year, all else
//! revalidated; a miss is the export's 404.html with 404.
use std::path::{Component, Path, PathBuf};

pub fn type_of(path: &Path) -> &'static str {
	match path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
		Some("html") => "text/html; charset=utf-8",
		Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
		Some("css") => "text/css; charset=utf-8",
		Some("json") | Some("map") => "application/json; charset=utf-8",
		Some("webmanifest") => "application/manifest+json; charset=utf-8",
		Some("txt") => "text/plain; charset=utf-8",
		Some("svg") => "image/svg+xml",
		Some("png") => "image/png",
		Some("jpg") | Some("jpeg") => "image/jpeg",
		Some("gif") => "image/gif",
		Some("webp") => "image/webp",
		Some("ico") => "image/x-icon",
		Some("woff") => "font/woff",
		Some("woff2") => "font/woff2",
		Some("ttf") => "font/ttf",
		Some("wasm") => "application/wasm",
		_ => "application/octet-stream",
	}
}

/// The build id the export wrote (out/BUILD_ID), or None.
pub fn exported_build(dir: &Path) -> Option<String> { std::fs::read_to_string(dir.join("BUILD_ID")).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) }

/// `decodeURIComponent`: None for a malformed escape or bytes that are no UTF-8.
pub fn decode_uri(s: &str) -> Option<String> {
	let b = s.as_bytes();
	let mut out = Vec::with_capacity(b.len());
	let mut i = 0;
	while i < b.len() {
		if b[i] == b'%' {
			let h = s.get(i + 1..i + 3)?;
			out.push(u8::from_str_radix(h, 16).ok()?);
			i += 3;
		} else { out.push(b[i]); i += 1; }
	}
	String::from_utf8(out).ok()
}

/// The file for a request path inside `dir`, or None.
pub fn page_file(dir: &Path, path: &str) -> Option<PathBuf> {
	let p = decode_uri(path)?;
	if p.contains('\0') { return None; }
	// node's path.normalize, then the leading separators off: ".." that climbs out stays as "..", which is refused
	let mut parts: Vec<String> = Vec::new();
	for c in Path::new(&p.replace('\\', "/")).components() {
		match c {
			Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
			Component::ParentDir => { if parts.last().is_some_and(|l| l != "..") { parts.pop(); } else { parts.push("..".into()); } }
			_ => {}
		}
	}
	if parts.iter().any(|s| s == ".." || (s.starts_with('.') && !s.is_empty())) { return None; }
	let rel = parts.join("/");
	if rel == "BUILD_ID" { return None; }
	// node's normalize keeps a trailing separator: "/x/" never names the file x, only x/.html or x/index.html
	let trailing = p.ends_with('/') || p.ends_with('\\');
	let base = dir.join(&rel);
	let candidates = if rel.is_empty() { vec![dir.join("index.html")] }
		else if trailing { vec![base.join(".html"), base.join("index.html")] }
		else { vec![base.clone(), PathBuf::from(format!("{}.html", base.display())), base.join("index.html")] };
	candidates.into_iter().find(|f| f.is_file())
}

#[cfg(test)]
mod tests {
	use super::page_file;
	#[test]
	fn names_as_pages_ts() {
		let dir = std::env::temp_dir().join(format!("mmo-pages-{}", std::process::id()));
		std::fs::create_dir_all(dir.join("_next/static/chunks")).unwrap();
		std::fs::create_dir_all(dir.join("_not-found")).unwrap();
		std::fs::create_dir_all(dir.join("sub")).unwrap();
		for (f, t) in [("index.html", "i"), ("404.html", "4"), ("_not-found.html", "nf"), ("manifest.webmanifest", "{}"), ("_next/static/chunks/a1.js", "1"), ("BUILD_ID", "b"), (".hidden", "no"), ("sub/index.html", "s")] { std::fs::write(dir.join(f), t).unwrap(); }
		assert_eq!(page_file(&dir, "/"), Some(dir.join("index.html")));
		assert_eq!(page_file(&dir, "/manifest.webmanifest"), Some(dir.join("manifest.webmanifest")));
		assert_eq!(page_file(&dir, "/_not-found"), Some(dir.join("_not-found.html")));
		assert_eq!(page_file(&dir, "/_next/static/chunks/a1.js"), Some(dir.join("_next/static/chunks/a1.js")));
		assert_eq!(page_file(&dir, "/sub/"), Some(dir.join("sub/index.html")));
		assert_eq!(page_file(&dir, "/manifest.webmanifest/"), None);
		for bad in ["/../package.json", "/%2e%2e/package.json", "/_next/../../x", "/.hidden", "/BUILD_ID", "/%00", "/%E0%A4%A", "/nothing"] { assert_eq!(page_file(&dir, bad), None, "{bad}"); }
		std::fs::remove_dir_all(&dir).unwrap();
	}
}
