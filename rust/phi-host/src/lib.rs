//! The secure host around the space service (docs/rust-portierung.en.md, R5): `auth` is layer B of the identity (src/auth.ts), `grants` the short-lived control grants (src/grants.ts).
pub mod auth;
pub mod control;
pub mod gate;
pub mod grants;
