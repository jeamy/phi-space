//! The own store of phi-spaces, ported from src/store/ (docs/rust-portierung.md, R2): documents in one SQLite file in the
//! format the TypeScript store writes (a document's head in `documents`, the records of its parts in `parts`), written
//! in batches by a writer thread and acknowledged once durable; or kept in memory.
pub mod disk;
pub mod files;
pub mod host;
pub mod ledger;
pub mod ops;
pub mod parts;
pub mod writer;

pub use files::{open_files, StoreError, FORMAT_VERSION};
pub use host::{Ledger, SpaceHost, SPACE_VERSION};
pub use ledger::{whole_ops, MemoryLedger, SqliteLedger, StoredDoc};
pub use ops::WriteOp;
pub use parts::{PartDef, PartKind, SPACE_PARTS};
pub use writer::{Fault, Synchronous, WriterOptions};
