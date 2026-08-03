//! Catalog and describe metadata → `SchemaDto`/`EntityDto`/`StoreDto`/`MemoryDto`.
//!
//! Every icydb type consumed here (`EntityFieldDescription`,
//! `EntitySchemaDescription`, `EntityCatalogDescription`,
//! `StoreCatalogDescription`, `MemoryCatalogDescription`) keeps all of its
//! fields private and exposes only `const fn` accessors, so every mapping
//! below goes through those accessors rather than field access.

use icydb::db::{
    EntityCatalogDescription, EntityConstraintDescription, EntityFieldDescription,
    EntityRelationCardinality, EntityRelationDescription, EntitySchemaDescription,
    MemoryCatalogDescription, StoreCatalogDescription,
};

use super::dto::{
    ColumnDto, ConstraintDto, EntityDto, MemoryDto, RelationDto, SchemaDto, StoreDto,
};

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

/// `DESCRIBE` result: full column list, index names, and declared relations.
pub(super) fn schema_description_to_dto(description: &EntitySchemaDescription) -> SchemaDto {
    SchemaDto {
        entity: description.entity_name().to_string(),
        columns: description.fields().iter().map(field_to_column).collect(),
        indexes: description
            .indexes()
            .iter()
            .map(|index| index.name().to_string())
            .collect(),
        relations: description.relations().iter().map(relation_to_dto).collect(),
    }
}

/// One declared relation.
///
/// `target_path` is deliberately dropped: it is the fully-qualified Rust path of
/// the target type, and `target_entity_name` is the same thing in the vocabulary
/// every other part of this app uses to name an entity. Carrying both would
/// invite the UI to show whichever one happened to be at hand.
pub(super) fn relation_to_dto(relation: &EntityRelationDescription) -> RelationDto {
    RelationDto {
        field: relation.field().to_string(),
        target_entity: relation.target_entity_name().to_string(),
        target_store_path: relation.target_store_path().to_string(),
        cardinality: cardinality_name(relation.cardinality()).to_string(),
    }
}

/// icydb's cardinality enum → a stable string.
///
/// Exhaustive with no `_ =>` arm, like every other icydb match in this module:
/// a new variant must break the build here rather than silently arriving in the
/// UI as something the frontend has never seen. `Debug` is not used because the
/// wire format would then be whatever icydb's derive happens to print.
const fn cardinality_name(cardinality: EntityRelationCardinality) -> &'static str {
    match cardinality {
        EntityRelationCardinality::Single => "single",
        EntityRelationCardinality::List => "list",
        EntityRelationCardinality::Set => "set",
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
pub(super) fn constraint_to_dto(constraint: &EntityConstraintDescription) -> ConstraintDto {
    ConstraintDto {
        name: constraint.name().to_string(),
        kind: constraint.kind().to_string(),
        origin: constraint.origin().to_string(),
        validation_state: constraint.validation_state().to_string(),
        fields: constraint.fields().to_vec(),
        semantics: constraint.semantics().to_string(),
        relation: constraint.relation().map(str::to_string),
        target_entity: constraint.target_entity().map(str::to_string),
        action: constraint.action().map(str::to_string),
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

    /// A primary-key constraint names no relation, so all three relation fields
    /// must be absent rather than empty strings — `Some("")` would render as a
    /// link to an entity called nothing.
    #[test]
    fn a_constraint_with_no_relation_carries_none_for_all_three() {
        let dto = constraint_to_dto(&sample_constraint());
        assert_eq!(dto.relation, None);
        assert_eq!(dto.target_entity, None);
        assert_eq!(dto.action, None);
    }

    /// The case the three new fields exist for.
    #[test]
    fn a_relation_constraint_carries_its_relation_target_and_action() {
        let wire = ConstraintWire {
            id: 4,
            name: "asset_project_fk".into(),
            kind: "relation".into(),
            origin: "declared".into(),
            validation_state: "valid".into(),
            validation_progress: None,
            field_id: Some(1),
            index_id: None,
            relation_id: Some(2),
            fields: vec!["project".into()],
            index: None,
            relation: Some("project_assets".into()),
            target_entity: Some("ProjectInstance".into()),
            action: Some("restrict".into()),
            semantics: "immediate".into(),
            check_sql: None,
        };
        let bytes = Encode!(&wire).expect("wire encode");
        let constraint =
            Decode!(&bytes, EntityConstraintDescription).expect("decode as icydb's type");

        let dto = constraint_to_dto(&constraint);
        assert_eq!(dto.relation.as_deref(), Some("project_assets"));
        assert_eq!(dto.target_entity.as_deref(), Some("ProjectInstance"));
        assert_eq!(dto.action.as_deref(), Some("restrict"));
    }

    fn relation(field: &str, cardinality: EntityRelationCardinality) -> EntityRelationDescription {
        EntityRelationDescription::new(
            field.to_string(),
            "toko::project::entity::ProjectAsset".to_string(),
            "ProjectAsset".to_string(),
            "toko::project::store::AssetStore".to_string(),
            cardinality,
        )
    }

    /// Each field comes from its own accessor. `target_path` is deliberately not
    /// carried, so the DTO names the target the way the rest of the app does.
    #[test]
    fn a_relation_maps_each_field_from_its_own_accessor() {
        let dto = relation_to_dto(&relation("assets", EntityRelationCardinality::List));

        assert_eq!(dto.field, "assets");
        assert_eq!(dto.target_entity, "ProjectAsset");
        assert_eq!(dto.target_store_path, "toko::project::store::AssetStore");
        assert_eq!(dto.cardinality, "list");
    }

    /// All three variants get a distinct stable name. `Debug` would also produce
    /// three distinct strings, which is exactly why this asserts the *chosen*
    /// spellings: they are the wire format, not a rendering of icydb's derive.
    #[test]
    fn every_cardinality_has_its_own_lowercase_name() {
        assert_eq!(
            relation_to_dto(&relation("a", EntityRelationCardinality::Single)).cardinality,
            "single"
        );
        assert_eq!(
            relation_to_dto(&relation("b", EntityRelationCardinality::List)).cardinality,
            "list"
        );
        assert_eq!(
            relation_to_dto(&relation("c", EntityRelationCardinality::Set)).cardinality,
            "set"
        );
    }
}
