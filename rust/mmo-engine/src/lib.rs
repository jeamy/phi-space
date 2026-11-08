//! The engine of spaces-mmo in Rust (docs/rust-portierung.en.md, R8.2), ported from the frozen TypeScript engine
//! (`spaces-mmo/server/engine` at 2698bad) and held against it step by step (`tests/engine_walk.rs`).
pub mod j;
pub mod js;
pub mod loader;
pub mod model;
pub mod prototypes;
pub mod room_growth;
pub mod schedule;
pub mod source;
pub mod space;
pub mod typeclasses;
pub mod world;
pub mod worldevents;
pub mod worldtime;
