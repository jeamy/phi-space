//! The rule values follow the scale of the world a process runs (`rules.rs`, `shared/rules.ts` useGridScale): one scale
//! per process, so this is a test binary of its own, with its one test (the lib's tests run in threads beside each
//! other at scale 1).
use mmo_engine::rules::{bed_capacity, beside, command_path, free_cell_radius, grid_scale, is_flower_neighbour, on_ring, use_grid_scale};
use mmo_engine::world::load_world;
use std::path::Path;

#[test]
fn the_values_follow_the_scale_and_a_refused_scale_changes_nothing() {
	assert_eq!(grid_scale(), 1.0);
	assert_eq!((beside(), command_path(), free_cell_radius()), (1.0, 40.0, 8.0));
	use_grid_scale(2.0).unwrap();
	assert_eq!((beside(), command_path(), free_cell_radius()), (2.0, 80.0, 16.0));
	assert!(on_ring(2.0) && !on_ring(3.0) && is_flower_neighbour(2.0));
	assert_eq!((bed_capacity(8.0, 6.0), bed_capacity(3.0, 3.0)), (12.0, 2.0), "a bed holds the plants of the same physical bed at scale 1");
	assert!(use_grid_scale(3.0).unwrap_err().contains("gridScale 3"));
	assert_eq!(grid_scale(), 2.0, "a refused scale changes nothing");
	use_grid_scale(1.0).unwrap();
	assert_eq!((beside(), command_path(), bed_capacity(4.0, 3.0)), (1.0, 40.0, 12.0));

	// load_world reads the definition of SPACES_MMO_GRID_SCALE and sets the scale to the world's
	let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
	let room = |w: &phi_json::Json| { let r = w.get("rooms").unwrap().as_array().unwrap().iter().find(|r| r.get("roomId").and_then(|v| v.as_str()) == Some("graue-bucht")).unwrap().clone(); let g = r.get("ground").unwrap().as_array().unwrap().clone(); (g[0].as_str().unwrap().chars().count(), g.len()) };
	std::env::set_var("SPACES_MMO_GRID_SCALE", "2");
	let w2 = load_world(&root, "leuchtfeuer").unwrap();
	assert_eq!((grid_scale(), beside(), room(&w2)), (2.0, 2.0, (48, 32)));
	std::env::set_var("SPACES_MMO_GRID_SCALE", "1");
	let w1 = load_world(&root, "leuchtfeuer").unwrap();
	assert_eq!((grid_scale(), beside(), room(&w1)), (1.0, 1.0, (24, 16)));
	std::env::set_var("SPACES_MMO_GRID_SCALE", "3");
	assert!(load_world(&root, "leuchtfeuer").is_err());
	std::env::remove_var("SPACES_MMO_GRID_SCALE");
}
