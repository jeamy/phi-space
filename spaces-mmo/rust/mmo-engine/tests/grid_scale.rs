//! The rule values follow the scale of the world a process runs (`rules.rs`, `shared/rules.ts` useGridScale): one scale
//! per process, so this is a test binary of its own, with its one test (the lib's tests run in threads beside each
//! other at scale 1).
use mmo_engine::rules::{beside, command_path, free_cell_radius, grid_scale, is_flower_neighbour, on_ring, use_grid_scale};

#[test]
fn the_values_follow_the_scale_and_a_refused_scale_changes_nothing() {
	assert_eq!(grid_scale(), 1.0);
	assert_eq!((beside(), command_path(), free_cell_radius()), (1.0, 40.0, 8.0));
	use_grid_scale(2.0).unwrap();
	assert_eq!((beside(), command_path(), free_cell_radius()), (2.0, 80.0, 16.0));
	assert!(on_ring(2.0) && !on_ring(3.0) && is_flower_neighbour(2.0));
	assert!(use_grid_scale(3.0).unwrap_err().contains("gridScale 3"));
	assert_eq!(grid_scale(), 2.0, "a refused scale changes nothing");
	use_grid_scale(1.0).unwrap();
	assert_eq!((beside(), command_path()), (1.0, 40.0));
}
