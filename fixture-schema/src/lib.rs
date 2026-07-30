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

use icydb_model::prelude::*;

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

#[list(item(prim = "Text", unbounded), typed_adapters = true)]
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
    pk(field = "id"),
    typed_adapters = true,
    timestamps(created_at(name = "created_at"), updated_at(name = "updated_at")),
    fields(
        field(name = "id", value(item(prim = "Ulid")), generated(insert = "Ulid::generate")),
        field(name = "name", value(item(prim = "Text", unbounded))),
        field(name = "count", value(item(prim = "Nat64"))),
        field(name = "balance", value(item(prim = "Decimal", scale = 2))),
        field(name = "owner", value(item(prim = "Principal"))),
        field(name = "created", value(item(prim = "Timestamp"))),
        field(name = "payload", value(item(prim = "Blob", unbounded))),
        field(name = "active", value(item(prim = "Bool"))),
        field(name = "note", value(opt, item(prim = "Text", unbounded))),
        field(name = "tags", value(item(is = "DemoTags"))),
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
            // `Ulid::generate()` now returns `Result<Self, InternalError>` and
            // needs live entropy; a `Default` impl only needs *a* valid
            // `Ulid`, not a freshly generated one (matches the same fix in
            // `src-tauri/src/view/value.rs`).
            id: Ulid::from_bytes([0u8; 16]),
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
    pk(field = "id"),
    index(fields = ["parent"]),
    typed_adapters = true,
    timestamps(created_at(name = "created_at"), updated_at(name = "updated_at")),
    fields(
        field(name = "id", value(item(prim = "Ulid")), generated(insert = "Ulid::generate")),
        field(name = "parent", value(item(prim = "Ulid"))),
    )
)]
pub struct DemoChild {}

impl Default for DemoChild {
    fn default() -> Self {
        Self {
            // See `DemoRow`'s `Default` impl above for why `from_bytes`
            // rather than `generate()`. Distinct fixed values so `id` and
            // `parent` are never coincidentally equal.
            id: Ulid::from_bytes([0u8; 16]),
            parent: Ulid::from_bytes([1u8; 16]),
            created_at: Timestamp::default(),
            updated_at: Timestamp::default(),
        }
    }
}
