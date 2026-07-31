//! View layer: translates icydb's `SqlQueryResult` into frontend-facing
//! DTOs. This is the only place icydb types are allowed to leak into —
//! everything downstream of this module sees `ResultDto` and never touches
//! an icydb type directly.
//!
//! Pure translation only: no IO, no async. That's what keeps it testable
//! without a replica.

mod dto;
mod schema;
mod value;

pub use dto::{
    ColumnDto, ConstraintDto, EntityDto, MemoryDto, ResultDto, RowsDto, SchemaDto, StoreDto,
    ValueDto,
};
pub use value::value_to_dto;

use icydb::db::sql::SqlQueryResult;
use schema::{
    constraint_to_dto, entity_catalog_to_dto, field_to_column, memory_catalog_to_dto,
    schema_description_to_dto, store_catalog_to_dto,
};
use value::rendered_text_to_dto;

use crate::error::AppError;

/// Translate one decoded `SqlQueryResult` into the DTO the frontend renders.
///
/// Matched exhaustively with no `_ =>` arm: a future icydb release that adds
/// a `SqlQueryResult` variant must fail this build rather than silently drop
/// the new variant into the wrong shape.
///
/// Two things worth knowing about this mapping:
///
/// - `next_cursor` is `None` for every `Projection` result. `icydb`'s
///   `RowProjectionOutput` (the `Projection` payload) has no cursor field at
///   all — only `SqlGroupedRowsOutput` (the `Grouped` payload) carries one.
///   Callers that paginate (Task 10) must treat cursors as a `Grouped`-only
///   concept; a `Projection` page is always complete on its own.
/// - `Grouped` rows arrive from icydb already rendered to `String` — icydb's
///   `SqlGroupedRowsOutput.rows` is `Vec<Vec<String>>`, not
///   `Vec<Vec<OutputValue>>`, so there is no typed value left to inspect by
///   the time it reaches this module. Those cells get `ValueDto { kind:
///   "text", .. }` rather than a type-specific kind. Only `Projection` rows
///   carry a real per-cell kind.
///
/// `SqlQueryResult` is decoded from a canister response — data crossing a
/// process boundary this program does not control — so this returns
/// `Result` rather than panicking on the one variant (`Ddl`) that cannot
/// legitimately arrive. See the `Ddl` arm below.
pub fn result_to_dto(result: SqlQueryResult) -> Result<ResultDto, AppError> {
    let dto = match result {
        SqlQueryResult::Count { entity, row_count } => ResultDto::Count { entity, row_count },
        SqlQueryResult::Projection(output) => ResultDto::Rows(RowsDto {
            entity: output.entity,
            columns: output.columns,
            rows: output
                .rows
                .into_iter()
                .map(|row| row.iter().map(value_to_dto).collect())
                .collect(),
            row_count: output.row_count,
            next_cursor: None,
        }),
        SqlQueryResult::Grouped(output) => ResultDto::Rows(RowsDto {
            entity: output.entity,
            columns: output.columns,
            rows: output
                .rows
                .into_iter()
                .map(|row| row.into_iter().map(rendered_text_to_dto).collect())
                .collect(),
            row_count: output.row_count,
            next_cursor: output.next_cursor,
        }),
        SqlQueryResult::Explain { entity, explain } => ResultDto::Explain { entity, explain },
        SqlQueryResult::Describe(description) => {
            ResultDto::Schema(schema_description_to_dto(&description))
        }
        SqlQueryResult::ShowIndexes { entity, indexes } => ResultDto::Indexes { entity, indexes },
        SqlQueryResult::ShowColumns { entity, columns } => ResultDto::Schema(SchemaDto {
            entity,
            columns: columns.iter().map(field_to_column).collect(),
            indexes: Vec::new(),
        }),
        SqlQueryResult::ShowEntities { entities, .. } => ResultDto::Entities {
            entities: entities.iter().map(entity_catalog_to_dto).collect(),
        },
        SqlQueryResult::ShowStores { stores, .. } => ResultDto::Stores {
            stores: stores.iter().map(store_catalog_to_dto).collect(),
        },
        SqlQueryResult::ShowMemory { memory } => ResultDto::Memory {
            memory: memory.iter().map(memory_catalog_to_dto).collect(),
        },
        SqlQueryResult::ShowConstraints { entity, constraints } => ResultDto::Constraints {
            entity,
            constraints: constraints.iter().map(constraint_to_dto).collect(),
        },
        // This explorer never issues DDL: Task 5's statement classifier
        // rejects DDL before it reaches a canister, and the canister side
        // itself is read-only. But `SqlQueryResult` is decoded from a
        // canister response — data crossing a process boundary this
        // program does not control — so a `Ddl` result arriving here is a
        // protocol anomaly worth reporting to the caller (a misbehaving or
        // future-version canister, or a broken invariant upstream), not an
        // invariant worth asserting with a panic that would crash the
        // whole desktop app. Report it as a parse error rather than
        // inventing a `ResultDto` variant for a result this app never
        // legitimately produces.
        SqlQueryResult::Ddl { .. } => {
            return Err(AppError::Parse(
                "unexpected SqlQueryResult::Ddl reached the view layer; this explorer is \
                 read-only and never issues DDL"
                    .to_string(),
            ));
        }
    };
    Ok(dto)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_maps_to_count_dto() {
        let result = SqlQueryResult::Count {
            entity: "demo_row".into(),
            row_count: 3,
        };
        match result_to_dto(result).unwrap() {
            ResultDto::Count { entity, row_count } => {
                assert_eq!(entity, "demo_row");
                assert_eq!(row_count, 3);
            }
            other => panic!("expected Count, got {other:?}"),
        }
    }

    #[test]
    fn show_indexes_maps_to_indexes_dto() {
        let result = SqlQueryResult::ShowIndexes {
            entity: "demo_row".into(),
            indexes: vec!["by_parent".into()],
        };
        match result_to_dto(result).unwrap() {
            ResultDto::Indexes { entity, indexes } => {
                assert_eq!(entity, "demo_row");
                assert_eq!(indexes, vec!["by_parent".to_string()]);
            }
            other => panic!("expected Indexes, got {other:?}"),
        }
    }

    #[test]
    fn serializes_with_a_type_tag() {
        let dto = ResultDto::Count {
            entity: "demo_row".into(),
            row_count: 1,
        };
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["type"], "count");
    }

    /// `Count`'s `row_count` field must reach the frontend as `rowCount`.
    /// The enum-level `#[serde(rename_all = "camelCase")]` on `ResultDto`
    /// renames variant names, not the fields *inside* struct variants —
    /// that requires the separate `rename_all_fields` container attribute,
    /// which this test guards against silently regressing.
    #[test]
    fn struct_variant_fields_are_camel_case() {
        let dto = ResultDto::Count {
            entity: "demo_row".into(),
            row_count: 7,
        };
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["rowCount"], 7);
        assert!(json.get("row_count").is_none());
    }

    /// `Entities`/`Stores`/`Memory` wrap a `Vec` in a named struct-variant
    /// field rather than a bare newtype variant. A newtype variant around a
    /// `Vec` serializes as a JSON array, and serde's internally-tagged
    /// representation cannot inject the `type` tag into an array — it
    /// panics at serialize time. This test proves the chosen shape avoids
    /// that and still tags and camelCases correctly.
    #[test]
    fn vec_wrapping_variants_serialize_without_panicking() {
        let dto = ResultDto::Entities {
            entities: vec![EntityDto {
                name: "demo_row".into(),
                store_path: "main".into(),
                storage: "stable".into(),
                columns: 3,
                indexes: 1,
                relations: 0,
                schema_version: 2,
            }],
        };
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["type"], "entities");
        assert_eq!(json["entities"][0]["storePath"], "main");
        assert_eq!(json["entities"][0]["schemaVersion"], 2);
    }

    #[test]
    fn projection_yields_no_cursor_and_typed_kinds() {
        use icydb::db::response::RowProjectionOutput;
        use icydb::value::OutputValue;

        let result = SqlQueryResult::Projection(RowProjectionOutput {
            entity: "demo_row".into(),
            columns: vec!["id".into()],
            rows: vec![vec![OutputValue::Nat64(1)]],
            row_count: 1,
        });
        match result_to_dto(result).unwrap() {
            ResultDto::Rows(rows) => {
                assert_eq!(rows.next_cursor, None);
                assert_eq!(rows.rows[0][0].kind, "nat");
                assert_eq!(rows.rows[0][0].display, "1");
            }
            other => panic!("expected Rows, got {other:?}"),
        }
    }

    #[test]
    fn grouped_carries_its_cursor_and_text_kind_cells() {
        use icydb::db::sql::SqlGroupedRowsOutput;

        let result = SqlQueryResult::Grouped(SqlGroupedRowsOutput {
            entity: "demo_row".into(),
            columns: vec!["count".into()],
            rows: vec![vec!["3".into()]],
            row_count: 1,
            next_cursor: Some("cursor-1".into()),
        });
        match result_to_dto(result).unwrap() {
            ResultDto::Rows(rows) => {
                assert_eq!(rows.next_cursor, Some("cursor-1".to_string()));
                assert_eq!(rows.rows[0][0].kind, "text");
                assert_eq!(rows.rows[0][0].display, "3");
            }
            other => panic!("expected Rows, got {other:?}"),
        }
    }

    /// `Ddl` is a protocol anomaly (this app never issues DDL, so a
    /// canister should never return one) — it must surface as an `Err`
    /// the caller can log or show as a UI error, not crash the process.
    #[test]
    fn ddl_maps_to_an_error_naming_the_variant() {
        let result = SqlQueryResult::Ddl {
            entity: "demo_row".into(),
            mutation_kind: "create_index".into(),
            target_index: "by_parent".into(),
            target_store: "main".into(),
            field_path: vec![],
            status: "ok".into(),
            rows_scanned: 0,
            index_keys_written: 0,
            // 0.215.5 added this field to `Ddl` (not present in 0.202.1); this
            // explorer never issues DDL and surfaces the whole variant as an
            // error regardless, so `None` is all a test needs.
            constraint_validation: None,
        };
        let err = result_to_dto(result).unwrap_err();
        assert!(err.explanation().contains("Ddl"));
    }

    #[test]
    fn the_constraints_variant_serialises_with_a_type_tag_and_camel_case_fields() {
        let dto = ResultDto::Constraints {
            entity: "demo_row".into(),
            constraints: vec![ConstraintDto {
                name: "demo_row_pk".into(),
                kind: "primary_key".into(),
                origin: "declared".into(),
                validation_state: "valid".into(),
                fields: vec!["id".into()],
                semantics: "immediate".into(),
            }],
        };
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["type"], "constraints");
        assert_eq!(json["entity"], "demo_row");
        assert_eq!(json["constraints"][0]["name"], "demo_row_pk");
        // camelCase, not validation_state — Task 2's TypeScript depends on this
        assert_eq!(json["constraints"][0]["validationState"], "valid");
    }

    #[test]
    fn an_empty_constraint_list_still_carries_its_entity() {
        let json = serde_json::to_value(ResultDto::Constraints {
            entity: "demo_child".into(),
            constraints: Vec::new(),
        })
        .unwrap();
        assert_eq!(json["entity"], "demo_child");
        assert!(json["constraints"].as_array().unwrap().is_empty());
    }
}
