# Deletion-register regression evidence

The SQLite recovery register validates deletion floors and archive catalogs in the
same write transaction as CAS. The regression exercises two independent database
connections, delayed old-backup registration, rejected floor rollback, immutable
archive bindings, irreversible quarantine/destruction, retained tombstones and
restart. Existing mTLS coverage also checks that an operator certificate cannot
bypass deletion constraints; reader/scoped-writer permissions remain enforced.

Typecheck, all 463 pi-spaces tests, all 24 mobile tests and 29 built artifacts pass.
The build manifest records the preceding commit and a dirty tree; checks.json
binds the tested source and library by SHA-256. No dependency was added.

These are implementation and local/offline runtime checks. The shared live
register was not restarted or updated. Backup/restore integration and active
backend-history retirement remain open. Phase 2 blocks 4-8 remain unaccepted.
