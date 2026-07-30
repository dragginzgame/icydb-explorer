//! Guarding and normalizing SQL before it reaches a canister.
//!
//! These are pure functions: a UX affordance so a user who types a write
//! or DDL statement gets an immediate, clear message instead of a
//! confusing round-trip failure. The actual read-only boundary is the
//! target canister's own `readonly = true` configuration.

mod classify;
mod limit;

pub use classify::{classify, Statement};
pub use limit::{apply_default_limit, LimitedSql};
