//! Seed data for the fixture canister's SQL surface.
//!
//! `icydb_fixtures_load` is not called directly by this crate: with
//! `fixtures = true` in `icydb.toml`, icydb's generated actor glue exposes an
//! `icydb_fixtures_load` update endpoint whose body calls this function by
//! name (`crate::icydb_fixtures_load`). See icydb-build's
//! `sql_surface_endpoint_exports` for the generated wrapper.
//!
//! Row insertion goes through icydb 0.215.5's generated typed-write path
//! rather than a direct `session.insert(entity)` call: 0.202.1 exposed that
//! ergonomic whole-entity insert directly on `DbSession`
//! (`icydb-0.202.1/src/db/session/write.rs:184`), but no such method exists
//! anywhere in 0.215.5's `icydb`/`icydb-core` surface. The replacement,
//! opted into via `typed_adapters = true`, is a generated bind → encode →
//! execute → decode pipeline
//! (`icydb-model-macros-0.215.5/src/node/entity.rs:1122-1244`):
//! `<Entity>::typed_binding`, the generated `<Entity>Insert` struct's
//! `TypedWriteAdapter::encode_write`, `DbSession::execute_trusted_typed_write`,
//! and `DbSession::typed_mutation_row` + `TypedRowAdapter::decode_row` to read
//! the inserted row (including its macro-generated `id`) back out.
//!
//! `typed_adapters = true` is set on three declarations in
//! `fixture-schema/src/lib.rs`, not two: both `#[entity]`s (`DemoRow`,
//! `DemoChild`) *and* the `#[list] DemoTags` declaration. `DemoTags` needs
//! it too — `list_adapter_tokens`
//! (`icydb-model-macros-0.215.5/src/node/typed_adapter.rs:223`) only emits a
//! `List` node's `TypedAdapter` impl when the list itself opts in, and
//! `DemoRowInsert.tags` needs that impl to encode.

use icydb::db::{
    DbSession, DynamicMutationResult, TypedBindingError, TypedEntityAdapter, TypedEntityBinding,
    TypedRowAdapter, TypedWriteAdapter, TypedWriteError, WriteCell,
};
use icydb::prelude::*;
use icydb::traits::CanisterKind;

use crate::{DemoChild, DemoChildInsert, DemoRow, DemoRowInsert, DemoTags};

/// Bind one opted-in generated entity to current accepted schema authority.
///
/// The `Adapter` branch (a stale or shape-incompatible binding) cannot occur
/// for a binding issued and used immediately within one seed call, so it
/// panics rather than inventing an `icydb::Error` this crate has no public
/// constructor for; the `Database` branch (a real accepted-schema inspection
/// failure) propagates as-is.
fn bind<C, E>(session: &DbSession<C>) -> Result<TypedEntityBinding, icydb::Error>
where
    C: CanisterKind,
    E: TypedEntityAdapter,
{
    E::typed_binding(session).map_err(|error| match error {
        TypedBindingError::Database(error) => error,
        TypedBindingError::Adapter(error) => {
            panic!("fixture seed: binding failed: {error}")
        }
    })
}

/// Encode, execute, and decode one generated typed insert, returning the
/// inserted row (with its macro-generated primary key populated).
///
/// As with `bind` above, adapter-shape failures panic rather than being
/// reported as an `icydb::Error` this crate cannot construct; only a genuine
/// database rejection propagates to the caller.
fn insert_row<C, E>(
    session: &DbSession<C>,
    binding: &TypedEntityBinding,
    input: impl TypedWriteAdapter,
) -> Result<E, icydb::Error>
where
    C: CanisterKind,
    E: TypedRowAdapter<Row = E>,
{
    let write = input
        .encode_write(binding)
        .unwrap_or_else(|error| panic!("fixture seed: encoding insert failed: {error}"));
    let result: DynamicMutationResult =
        session
            .execute_trusted_typed_write(write)
            .map_err(|error| match error {
                TypedWriteError::Database(error) => error,
                TypedWriteError::Adapter(error) => {
                    panic!("fixture seed: insert rejected: {error}")
                }
            })?;
    let row = session
        .typed_mutation_row(binding, &result, 0)
        .unwrap_or_else(|error| panic!("fixture seed: decoding inserted row failed: {error}"));
    Ok(E::decode_row(binding, row)
        .unwrap_or_else(|error| panic!("fixture seed: decoding inserted row failed: {error}")))
}

/// Populate the fixture store with a handful of rows covering every
/// `OutputValue` variant: text, integer, decimal, principal, timestamp,
/// blob, bool, null (via the optional `note`), and list (`tags`).
pub fn icydb_fixtures_load() -> Result<(), icydb::Error> {
    let session = db!()?;

    let demo_row_binding = bind::<_, DemoRow>(&session)?;
    let alpha: DemoRow = insert_row(
        &session,
        &demo_row_binding,
        DemoRowInsert {
            name: WriteCell::Value("alpha".to_string()),
            count: WriteCell::Value(1),
            balance: WriteCell::Value(Decimal::new(1099, 2)),
            owner: WriteCell::Value(Principal::anonymous()),
            created: WriteCell::Value(Timestamp::now()),
            payload: WriteCell::Value(Blob::from(b"alpha-payload".to_vec())),
            active: WriteCell::Value(true),
            note: WriteCell::Value("first row".to_string()),
            tags: WriteCell::Value(DemoTags(vec!["red".to_string(), "primary".to_string()])),
        },
    )?;

    let beta: DemoRow = insert_row(
        &session,
        &demo_row_binding,
        DemoRowInsert {
            name: WriteCell::Value("beta".to_string()),
            count: WriteCell::Value(2),
            balance: WriteCell::Value(Decimal::new(0, 2)),
            owner: WriteCell::Value(Principal::anonymous()),
            created: WriteCell::Value(Timestamp::now()),
            payload: WriteCell::Value(Blob::from(Vec::new())),
            active: WriteCell::Value(false),
            note: WriteCell::Null,
            tags: WriteCell::Value(DemoTags(Vec::new())),
        },
    )?;

    let demo_child_binding = bind::<_, DemoChild>(&session)?;
    let _: DemoChild = insert_row(
        &session,
        &demo_child_binding,
        DemoChildInsert {
            parent: WriteCell::Value(alpha.id),
        },
    )?;

    let _: DemoChild = insert_row(
        &session,
        &demo_child_binding,
        DemoChildInsert {
            parent: WriteCell::Value(beta.id),
        },
    )?;

    Ok(())
}
