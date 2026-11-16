use phi_json::{parse, Json, Object};

#[test]
fn large_objects_keep_order_and_lookups_after_removal_restore_and_update() {
	let mut object = Object::new();
	for i in 0..500 { object.insert(format!("key{i}"), Json::Number(i as f64)); }
	for key in ["__proto__", "constructor", "toString", "100", "3", "0"] { object.insert(key, key.into()); }
	let before = object.clone();
	for i in (1..500).step_by(3) {
		let key = format!("key{i}");
		let value = object.remove(&key).unwrap();
		assert!(object.get(&key).is_none());
		object.insert(key, value);
	}
	assert_eq!(object.len(), before.len());
	for i in 0..500 { assert_eq!(object.get(&format!("key{i}")).and_then(Json::as_f64), Some(i as f64)); }
	let text = Json::Object(object.clone()).to_json_text();
	assert_eq!(parse(&text).unwrap(), Json::Object(object.clone()));
	assert!(text.starts_with(r#"{"0":"0","3":"3","100":"100","key0":0"#));
	for i in 0..490 { object.remove(&format!("key{i}")); }
	object.insert("key499", 123.0.into());
	assert_eq!(object.get("key499"), Some(&123.0.into()));
	assert_eq!(object.keys().last(), Some("key499"), "the last one put back");
	assert_eq!(Json::Object(object.clone()).json_copy(), Json::Object(object));
}

#[test]
fn json_copy_normalizes_nested_overflow_without_weakening_canonical_json() {
	let input = parse(r#"{"x":[1e309,{"y":-1e309}],"finite":42}"#).unwrap();
	assert!(input.canonical().is_err());
	assert_eq!(input.json_copy().to_json_text(), r#"{"x":[null,{"y":null}],"finite":42}"#);
}
