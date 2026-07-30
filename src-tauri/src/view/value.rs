//! `OutputValue` → `ValueDto`.
//!
//! Exhaustively matched with no `_ =>` arm: a future icydb release that adds
//! an `OutputValue` variant must fail this build rather than silently fall
//! through to a wrong kind.

use icydb::db::response::render_output_value_text;
use icydb::value::OutputValue;

use super::dto::ValueDto;

/// Map one icydb output value to its frontend-facing `kind`/`display` pair.
pub fn value_to_dto(value: &OutputValue) -> ValueDto {
    let kind = kind_of(value).to_string();
    let display = match value {
        // The frontend renders the empty null cell itself; an empty
        // `display` lets it tell "no value" apart from the literal text
        // "null" that `render_output_value_text` would otherwise produce.
        OutputValue::Null => String::new(),
        // Raw bytes are not useful in a table cell; a length is.
        OutputValue::Blob(bytes) => format!("{} bytes", bytes.len()),
        other => render_output_value_text(other),
    };
    ValueDto { kind, display }
}

/// The stable `kind` string for each `OutputValue` variant. Matches
/// icydb-cli's own vocabulary (`int`/`nat` rather than `int64`/`nat64`,
/// mirroring icydb's own `#[serde(rename)]` on those two variants).
fn kind_of(value: &OutputValue) -> &'static str {
    match value {
        OutputValue::Account(_) => "account",
        OutputValue::Blob(_) => "blob",
        OutputValue::Bool(_) => "bool",
        OutputValue::Date(_) => "date",
        OutputValue::Decimal(_) => "decimal",
        OutputValue::Duration(_) => "duration",
        OutputValue::Enum(_) => "enum",
        OutputValue::Float32(_) => "float32",
        OutputValue::Float64(_) => "float64",
        OutputValue::Int64(_) => "int",
        OutputValue::Int128(_) => "int128",
        OutputValue::IntBig(_) => "intbig",
        OutputValue::List(_) => "list",
        OutputValue::Map(_) => "map",
        OutputValue::Null => "null",
        OutputValue::Principal(_) => "principal",
        OutputValue::Subaccount(_) => "subaccount",
        OutputValue::Text(_) => "text",
        OutputValue::Timestamp(_) => "timestamp",
        OutputValue::Nat64(_) => "nat",
        OutputValue::Nat128(_) => "nat128",
        OutputValue::NatBig(_) => "natbig",
        OutputValue::Ulid(_) => "ulid",
        OutputValue::Unit => "unit",
    }
}

/// Render an already-rendered grouped-row cell (icydb pre-renders
/// `SqlGroupedRowsOutput` rows to `String`, discarding the source
/// `OutputValue` — see `view::mod` for why).
pub(super) fn rendered_text_to_dto(text: String) -> ValueDto {
    ValueDto {
        kind: "text".to_string(),
        display: text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use icydb::value::OutputValue;

    #[test]
    fn maps_scalar_variants_to_kind_and_display() {
        assert_eq!(value_to_dto(&OutputValue::Bool(true)).kind, "bool");
        assert_eq!(value_to_dto(&OutputValue::Bool(true)).display, "true");
        assert_eq!(value_to_dto(&OutputValue::Text("hi".into())).kind, "text");
        assert_eq!(value_to_dto(&OutputValue::Text("hi".into())).display, "hi");
        assert_eq!(value_to_dto(&OutputValue::Int64(-7)).kind, "int");
        assert_eq!(value_to_dto(&OutputValue::Int64(-7)).display, "-7");
        assert_eq!(value_to_dto(&OutputValue::Nat64(7)).kind, "nat");
        assert_eq!(value_to_dto(&OutputValue::Nat64(7)).display, "7");
    }

    #[test]
    fn null_and_unit_get_distinct_kinds_and_empty_display() {
        let null = value_to_dto(&OutputValue::Null);
        assert_eq!(null.kind, "null");
        assert_eq!(null.display, "");
        assert_eq!(value_to_dto(&OutputValue::Unit).kind, "unit");
    }

    #[test]
    fn blob_reports_byte_length_rather_than_raw_bytes() {
        let dto = value_to_dto(&OutputValue::Blob(vec![0u8; 40]));
        assert_eq!(dto.kind, "blob");
        assert!(dto.display.contains("40"));
    }

    #[test]
    fn list_and_map_render_their_children() {
        let list = OutputValue::List(vec![OutputValue::Nat64(1), OutputValue::Nat64(2)]);
        let dto = value_to_dto(&list);
        assert_eq!(dto.kind, "list");
        assert!(dto.display.contains('1') && dto.display.contains('2'));

        let map = OutputValue::Map(vec![(OutputValue::Text("k".into()), OutputValue::Nat64(9))]);
        let dto = value_to_dto(&map);
        assert_eq!(dto.kind, "map");
        assert!(dto.display.contains('k') && dto.display.contains('9'));
    }
}
