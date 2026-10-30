//! The semantics of a phi-space, ported from src/core.ts and its helpers (docs/rust-portierung.md, R1). The TypeScript
//! code is the reference: test/support/core-driver.ts runs it operation by operation, and the tests of this crate hold
//! every state and answer against it.
pub mod driver;
pub mod space;
pub mod state;
pub mod stream;

pub use space::{CoreError, Limits, Space, Template};
pub use state::{Batch, EntryRec, ShapeError, SpaceState, StreamState, TxnRec};
