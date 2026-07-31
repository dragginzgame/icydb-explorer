//! Catalog and describe metadata → `SchemaDto`/`EntityDto`/`StoreDto`/`MemoryDto`.
//!
//! Every icydb type consumed here (`EntityFieldDescription`,
//! `EntitySchemaDescription`, `EntityCatalogDescription`,
//! `StoreCatalogDescription`, `MemoryCatalogDescription`) keeps all of its
//! fields private and exposes only `const fn` accessors, so every mapping
//! below goes through those accessors rather than field access.

use icydb::db::{
    EntityCatalogDescription, EntityFieldDescription, EntitySchemaDescription,
    MemoryCatalogDescription, StoreCatalogDescription,
};

use super::dto::{ColumnDto, EntityDto, MemoryDto, SchemaDto, StoreDto};

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
