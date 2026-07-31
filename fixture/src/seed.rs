//! Seed data for the fixture canister's SQL surface.
//!
//! `icydb_fixtures_load` is not called directly by this crate: with
//! `fixtures = true` in `icydb.toml`, icydb's generated actor glue exposes an
//! `icydb_fixtures_load` update endpoint whose body calls this function by
//! name (`crate::icydb_fixtures_load`). See icydb-build's
//! `sql_surface_endpoint_exports` for the generated wrapper.

use icydb::prelude::*;

use crate::{DemoChild, DemoRow, DemoTags};

/// Populate the fixture store with a handful of rows covering every
/// `OutputValue` variant: text, integer, decimal, principal, timestamp,
/// blob, bool, null (via the optional `note`), and list (`tags`).
pub fn icydb_fixtures_load() -> Result<(), icydb::Error> {
    let alpha = db!().insert(DemoRow {
        name: "alpha".to_string(),
        count: 1,
        balance: Decimal::new(1099, 2),
        owner: Principal::anonymous(),
        created: Timestamp::now(),
        payload: Blob::from(b"alpha-payload".to_vec()),
        active: true,
        note: Some("first row".to_string()),
        tags: DemoTags(vec!["red".to_string(), "primary".to_string()]),
        ..Default::default()
    })?;

    let beta = db!().insert(DemoRow {
        name: "beta".to_string(),
        count: 2,
        balance: Decimal::new(0, 2),
        owner: Principal::anonymous(),
        created: Timestamp::now(),
        payload: Blob::from(Vec::new()),
        active: false,
        note: None,
        tags: DemoTags(Vec::new()),
        ..Default::default()
    })?;

    db!().insert(DemoChild {
        parent: alpha.id,
        ..Default::default()
    })?;

    db!().insert(DemoChild {
        parent: beta.id,
        ..Default::default()
    })?;

    Ok(())
}
