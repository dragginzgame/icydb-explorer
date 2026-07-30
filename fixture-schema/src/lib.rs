//! Schema declarations for the fixture canister's icydb store.
//!
//! This crate exists purely so `fixture/build.rs` can link it as a
//! build-dependency: icydb's `#[entity]`/`#[canister]`/`#[store]` macros
//! register themselves into a process-global schema registry via `#[ctor]`
//! hooks, and those hooks only run in a process that actually links the
//! compiled code containing them. Splitting the declarations out of the
//! `fixture` cdylib crate (and depending on this crate from both
//! `[dependencies]` and `[build-dependencies]` there) is what makes that
//! registration visible to `fixture/build.rs`.
//!
//! `demo_row` and `demo_child` are not a model of any real domain — they
//! exist to exercise every `OutputValue` variant icydb can render.

use icydb::design::prelude::*;

///
/// Canister
///

#[canister(
    memory_namespace = "fixture",
    memory_min = 100,
    memory_max = 150,
    commit_memory_id = 150
)]
pub struct Canister {}

pub mod store {
    use super::*;

    ///
    /// FixtureStore
    ///

    #[store(
        ident = "FIXTURE_DATA",
        store_name = "fixture",
        canister = "Canister",
        storage(journaled(
            data_memory_id = 100,
            index_memory_id = 101,
            schema_memory_id = 102,
            journal_memory_id = 103,
        ))
    )]
    pub struct FixtureStore {}
}

///
/// DemoTags
///
/// Named list type backing `DemoRow::tags`, so a `List` value shows up in the
/// `OutputValue` coverage the fixture is meant to exercise.
///

#[list(item(prim = "Text", unbounded))]
pub struct DemoTags {}

///
/// DemoRow
///
/// Fields are chosen to cover the interesting `OutputValue` variants: text,
/// integer, decimal, principal, timestamp, blob, bool, optional (null), and
/// list.
///

#[entity(
    store = "store::FixtureStore",
    version = 1,
    name = "demo_row",
    pk(field = "id"),
    fields(
        field(ident = "id", value(item(prim = "Ulid")), generated(insert = "Ulid::generate")),
        field(ident = "name", value(item(prim = "Text", unbounded))),
        field(ident = "count", value(item(prim = "Nat64"))),
        field(ident = "balance", value(item(prim = "Decimal", scale = 2))),
        field(ident = "owner", value(item(prim = "Principal"))),
        field(ident = "created", value(item(prim = "Timestamp"))),
        field(ident = "payload", value(item(prim = "Blob", unbounded))),
        field(ident = "active", value(item(prim = "Bool"))),
        field(ident = "note", value(opt, item(prim = "Text", unbounded))),
        field(ident = "tags", value(item(is = "DemoTags"))),
    )
)]
pub struct DemoRow {}

// `traits(add(Default))` demands a `default = ...` for every non-implicitly-
// defaultable field, which isn't worth the ceremony here — following toko's
// own convention (see e.g. `PrincipalToUser` in
// `dragginz/toko/backend/src/design/src/entity/user/hub.rs`), `Default` is
// hand-written instead.
impl Default for DemoRow {
    fn default() -> Self {
        Self {
            id: Ulid::generate(),
            name: String::new(),
            count: 0,
            balance: Decimal::ZERO,
            owner: Principal::anonymous(),
            created: Timestamp::default(),
            payload: Blob::default(),
            active: false,
            note: None,
            tags: DemoTags::default(),
            created_at: Timestamp::default(),
            updated_at: Timestamp::default(),
        }
    }
}

///
/// DemoChild
///
/// `parent` holds a `DemoRow` id as a plain `Ulid` (not an icydb `rel`
/// relation — `rel` fields must have an ident ending in `_id`, which `parent`
/// deliberately doesn't, to keep the brief's literal field name), with a
/// named lookup index so the SQL surface has more than one table to join
/// against.
///

#[entity(
    store = "store::FixtureStore",
    version = 1,
    name = "demo_child",
    pk(field = "id"),
    index(fields = ["parent"]),
    fields(
        field(ident = "id", value(item(prim = "Ulid")), generated(insert = "Ulid::generate")),
        field(ident = "parent", value(item(prim = "Ulid"))),
    )
)]
pub struct DemoChild {}

impl Default for DemoChild {
    fn default() -> Self {
        Self {
            id: Ulid::generate(),
            parent: Ulid::generate(),
            created_at: Timestamp::default(),
            updated_at: Timestamp::default(),
        }
    }
}
