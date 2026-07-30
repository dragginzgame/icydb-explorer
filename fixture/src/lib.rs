//! Minimal fixture canister exposing icydb's read-only SQL surface.
//!
//! Schema declarations (`Canister`, stores, entities) live in the
//! `fixture-schema` crate — see its module docs for why the split exists.
//! This crate stays thin: it re-exports the schema, wires the seed module,
//! and starts the icydb runtime.

pub use fixture_schema::*;

mod seed;

pub use seed::icydb_fixtures_load;

icydb::start!();

// `candid-extractor` (Step 6) needs a `get_candid_pointer` export to read the
// interface back out of the compiled wasm. `icydb::start!()` wires up the
// canister's endpoints but doesn't export candid itself — toko's canisters
// get that for free from `canic::finish!()`, which this minimal fixture
// deliberately doesn't use.
ic_cdk::export_candid!();
