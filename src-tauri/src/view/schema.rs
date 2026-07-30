//! Catalog and describe metadata → `SchemaDto`/`EntityDto`/`StoreDto`/`MemoryDto`.
//!
//! Every icydb type consumed here (`EntityFieldDescription`,
//! `EntitySchemaDescription`, `EntityCatalogDescription`,
//! `StoreCatalogDescription`, `MemoryCatalogDescription`) keeps all of its
//! fields private and exposes only `const fn` accessors, so every mapping
//! below goes through those accessors rather than field access.

use icydb::db::{
    EntityCatalogDescription, EntityConstraintDescription, EntityFieldDescription,
    EntitySchemaDescription, MemoryCatalogDescription, StoreCatalogDescription,
};

use super::dto::{ColumnDto, ConstraintDto, EntityDto, MemoryDto, SchemaDto, StoreDto};

/// Shared by `ShowColumns` and `Describe` — both produce column data, from
/// different icydb types, but the field→`ColumnDto` shape is identical.
pub(super) fn field_to_column(field: &EntityFieldDescription) -> ColumnDto {
    ColumnDto {
        name: field.name().to_string(),
        type_name: field.kind().to_string(),
        primary_key: field.primary_key(),
        optional: field.nullable(),
    }
}

/// `DESCRIBE` result: full column list plus index names.
pub(super) fn schema_description_to_dto(description: &EntitySchemaDescription) -> SchemaDto {
    SchemaDto {
        entity: description.entity_name().to_string(),
        columns: description.fields().iter().map(field_to_column).collect(),
        indexes: description
            .indexes()
            .iter()
            .map(|index| index.name().to_string())
            .collect(),
    }
}

/// One `SHOW ENTITIES` row.
pub(super) fn entity_catalog_to_dto(entity: &EntityCatalogDescription) -> EntityDto {
    EntityDto {
        name: entity.entity_name().to_string(),
        store_path: entity.store_path().to_string(),
        storage: entity.storage().to_string(),
        columns: entity.columns(),
        indexes: entity.indexes(),
        relations: entity.relations(),
        schema_version: entity.schema_version(),
    }
}

/// One `SHOW STORES` row.
pub(super) fn store_catalog_to_dto(store: &StoreCatalogDescription) -> StoreDto {
    StoreDto {
        store_path: store.store_path().to_string(),
        storage: store.storage().to_string(),
    }
}

/// One `SHOW MEMORY` row.
pub(super) fn memory_catalog_to_dto(memory: &MemoryCatalogDescription) -> MemoryDto {
    MemoryDto {
        tag: memory.tag().to_string(),
        memory_id: memory.memory_id(),
        store_path: memory.store_path().to_string(),
    }
}

/// Reads an `EntityConstraintDescription` through its accessors — its fields
/// are private, like every other icydb description type.
#[must_use]
pub fn constraint_to_dto(constraint: &EntityConstraintDescription) -> ConstraintDto {
    ConstraintDto {
        name: constraint.name().to_string(),
        kind: constraint.kind().to_string(),
        origin: constraint.origin().to_string(),
        validation_state: constraint.validation_state().to_string(),
        fields: constraint.fields().to_vec(),
        semantics: constraint.semantics().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candid::{CandidType, Decode, Encode};
    use serde::Deserialize;

    /// Mirrors `EntityConstraintDescription`'s candid shape so a real one can
    /// be constructed for tests — its fields are `pub(crate)` and it has no
    /// public constructor, but it derives `CandidType`/`Deserialize`, and
    /// candid is structural. Field names and types must match icydb's
    /// exactly or the decode fails loudly, which is the desired behaviour if
    /// icydb changes the shape. Verified against
    /// `icydb-core-0.215.5/src/db/schema/describe.rs:269-285`.
    #[derive(CandidType, Deserialize)]
    struct ConstraintWire {
        id: u32,
        name: String,
        kind: String,
        origin: String,
        validation_state: String,
        validation_progress: Option<candid::Reserved>,
        field_id: Option<u32>,
        index_id: Option<u32>,
        relation_id: Option<u32>,
        fields: Vec<String>,
        index: Option<String>,
        relation: Option<String>,
        target_entity: Option<String>,
        action: Option<String>,
        semantics: String,
        check_sql: Option<String>,
    }

    fn sample_constraint() -> EntityConstraintDescription {
        let wire = ConstraintWire {
            id: 1,
            name: "demo_row_pk".into(),
            kind: "primary_key".into(),
            origin: "declared".into(),
            validation_state: "valid".into(),
            validation_progress: None,
            field_id: Some(0),
            index_id: None,
            relation_id: None,
            fields: vec!["id".into()],
            index: None,
            relation: None,
            target_entity: None,
            action: None,
            semantics: "immediate".into(),
            check_sql: None,
        };
        let bytes = Encode!(&wire).expect("wire encode");
        Decode!(&bytes, EntityConstraintDescription).expect("decode as icydb's type")
    }

    #[test]
    fn a_constraint_maps_each_field_from_its_own_accessor() {
        let dto = constraint_to_dto(&sample_constraint());
        assert_eq!(dto.name, "demo_row_pk");
        assert_eq!(dto.kind, "primary_key");
        assert_eq!(dto.origin, "declared");
        assert_eq!(dto.validation_state, "valid");
        assert_eq!(dto.fields, vec!["id".to_string()]);
        assert_eq!(dto.semantics, "immediate");
    }
}
