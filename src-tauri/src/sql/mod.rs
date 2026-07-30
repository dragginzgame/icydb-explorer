//! Guarding and normalizing SQL before it reaches a canister.
//!
//! `classify` is a UX affordance: it lets a user who types a write or DDL
//! statement get an immediate, clear message instead of a confusing
//! round-trip failure. It is not the read-only guarantee itself — that
//! guarantee is `transport::run_query` calling only `icydb_query`, a query
//! method whose dispatcher rejects mutation statements and which cannot
//! persist canister state; see README.md's "Read-only, and where that
//! guarantee actually lives" section for the full explanation.

mod classify;
mod limit;
mod rows;
mod transport;

pub use classify::{classify, Statement};
pub use limit::{apply_default_limit, LimitedSql};
pub use rows::rows_sql;
pub use transport::{map_reject_message, run_query};
