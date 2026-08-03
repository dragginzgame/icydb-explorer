//! DTO shapes exposed across the Tauri command boundary.
//!
//! Every type here is plain data with no icydb types in its fields — that is
//! the whole point of the `view` module. Task 11 mirrors these exact shapes
//! (field names and the `ResultDto` tag) in TypeScript, so field renames
//! here are a cross-cutting change.

use serde::Serialize;

/// One rendered cell: a `kind` for styling/type-aware rendering plus a
/// ready-to-display `display` string.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueDto {
    pub kind: String,
    pub display: String,
}

/// A page of rows, whether from a plain projection or a grouped query.
///
/// `next_cursor` is only ever populated for grouped results — a plain
/// projection has no cursor to page from. See `view::mod` for detail.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowsDto {
    pub entity: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<ValueDto>>,
    pub row_count: u32,
    pub next_cursor: Option<String>,
}

/// One column entry, shared by `SHOW COLUMNS` and `DESCRIBE`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDto {
    pub name: String,
    pub type_name: String,
    pub primary_key: bool,
    pub optional: bool,
}

/// One relation the schema itself declares.
///
/// Always within the same canister: `target_store_path` names a store in this
/// schema, and icydb has no notion of a remote store — it could not enforce a
/// key across a canister boundary. Any link that *does* cross one is the
/// explorer's own inference and is neither built nor labelled here.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationDto {
    /// The field on this entity that holds the relation.
    pub field: String,
    /// The entity it points at, by name.
    pub target_entity: String,
    /// The target's store, which is what makes "same canister" checkable rather
    /// than merely asserted.
    pub target_store_path: String,
    /// `single`, `list`, or `set` — mapped from icydb's enum by an exhaustive
    /// match, never by `Debug`.
    pub cardinality: String,
}

/// A `DESCRIBE`/`SHOW COLUMNS` result. `indexes` and `relations` are both empty
/// for `SHOW COLUMNS`, which carries neither.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDto {
    pub entity: String,
    pub columns: Vec<ColumnDto>,
    pub indexes: Vec<String>,
    pub relations: Vec<RelationDto>,
}

/// One `SHOW ENTITIES` row.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityDto {
    pub name: String,
    pub store_path: String,
    pub storage: String,
    pub columns: u32,
    pub indexes: u32,
    pub relations: u32,
    pub schema_version: u32,
}

/// One `SHOW STORES` row.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreDto {
    pub store_path: String,
    pub storage: String,
}

/// One `SHOW MEMORY` row.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDto {
    pub tag: String,
    pub memory_id: u8,
    pub store_path: String,
}

/// One constraint from `SHOW CONSTRAINTS`.
///
/// icydb's `EntityConstraintDescription` exposes sixteen accessors; this carries
/// the nine the UI displays. The remaining seven (`id`, `field_id`, `index_id`,
/// `relation_id`, `index`, `check_sql`, `validation_progress`) are deliberately
/// omitted — nothing renders them, and a DTO field with no consumer is a
/// maintenance cost.
///
/// `relation`, `target_entity`, and `action` were three of those omissions until
/// relation following existed to consume them. A relation constraint is how the
/// schema says what happens to the *other* side, which the relation list itself
/// does not carry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintDto {
    pub name: String,
    pub kind: String,
    pub origin: String,
    pub validation_state: String,
    pub fields: Vec<String>,
    pub semantics: String,
    /// The named relation this constraint governs, for a relation constraint.
    pub relation: Option<String>,
    /// The entity on the other side of it.
    pub target_entity: Option<String>,
    /// What happens to this side when the other is removed (icydb's own
    /// spelling, passed through).
    pub action: Option<String>,
}

/// The frontend-facing shape of a `SqlQueryResult`, internally tagged with
/// `type` so the frontend can discriminate on one field.
///
/// `Entities`, `Stores`, and `Memory` are struct variants wrapping a named
/// `Vec` field (`entities`, `stores`, `memory`) rather than bare newtype
/// variants around a `Vec`. Serde's internally-tagged representation can
/// only inject the `type` tag into content that serializes as a JSON
/// object; a newtype variant around a `Vec` serializes as a JSON array and
/// panics at serialize time with "cannot serialize tagged newtype variant
/// ... containing a sequence". This was verified directly against serde
/// 1.0.229 before settling on this shape — see the Task 6 report for the
/// reproduction.
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResultDto {
    Rows(RowsDto),
    Schema(SchemaDto),
    Entities {
        entities: Vec<EntityDto>,
    },
    Count {
        entity: String,
        row_count: u32,
    },
    Explain {
        entity: String,
        explain: String,
    },
    Indexes {
        entity: String,
        indexes: Vec<String>,
    },
    Stores {
        stores: Vec<StoreDto>,
    },
    Memory {
        memory: Vec<MemoryDto>,
    },
    Constraints {
        entity: String,
        constraints: Vec<ConstraintDto>,
    },
}
