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
    ValueDto {
        kind: kind_of(value).to_string(),
        display: display_of(value),
        // Only a list carries elements. A map has pairs rather than keys and
        // nothing follows a map, so flattening one here would invent a shape with
        // no consumer; a scalar has no elements at all.
        items: match value {
            OutputValue::List(elements) => Some(elements.iter().map(value_to_dto).collect()),
            _ => None,
        },
    }
}

/// The text for a cell, summarising blobs at *every* depth.
///
/// Containers are rendered here rather than by `render_output_value_text`, which
/// is a deliberate reversal. icydb renders a blob as complete lowercase hex — `0x`
/// plus two characters per byte — and the old code summarised only the *top-level*
/// case, delegating containers wholesale. So a 30 kB thumbnail nested inside a
/// composite arrived as a 60,000-character cell.
///
/// That was not merely ugly. A hundred-row page carried megabytes of hex across
/// the command boundary, and every per-cell pass in the frontend then walked all
/// of it — the expand re-indenter character by character, the fleet-principal scan
/// by regex. It is the reason large tables felt like the app had frozen.
///
/// Scalars still go to icydb's renderer: its formatting of a timestamp, a decimal
/// or an enum is the vocabulary the rest of the tooling uses, and reimplementing
/// that here would be this module inventing its own dialect. Only the two
/// container shapes and the two special cases are handled locally, so that a blob
/// is summarised wherever it appears.
fn display_of(value: &OutputValue) -> String {
    render(value, true)
}

fn render(value: &OutputValue, whole_cell: bool) -> String {
    match value {
        // A whole cell that is null gets an empty display, so the frontend can draw
        // its own marker and tell "no value" from the literal text "null".
        OutputValue::Null if whole_cell => String::new(),
        // Nested, "null" *is* the value and has to be readable: `{name: cover,
        // alt: }` says a field is missing far less clearly than `{alt: null}`, and
        // it is what icydb rendered before containers moved in here. An earlier
        // version of this function returned the empty string at every depth, and a
        // test of mine asserted that shape as though it were intended.
        OutputValue::Null => "null".to_string(),
        // Raw bytes are not useful in a table cell; a size is. Same summary at
        // every depth, which is the whole point of this function existing.
        OutputValue::Blob(bytes) => blob_summary(bytes.len()),
        OutputValue::List(elements) => {
            let rendered: Vec<String> = elements.iter().map(|e| render(e, false)).collect();

            format!("[{}]", rendered.join(", "))
        }
        OutputValue::Map(entries) => {
            let rendered: Vec<String> = entries
                .iter()
                .map(|(key, entry)| format!("{}: {}", render(key, false), render(entry, false)))
                .collect();

            format!("{{{}}}", rendered.join(", "))
        }
        other => render_output_value_text(other),
    }
}

/// A blob's size, in the unit a reader can judge.
///
/// A thumbnail reported as "30720 bytes" is a number to decode; "30 kB" is a
/// quantity. Powers of ten rather than two, matching how image and file sizes are
/// quoted everywhere a reader would have seen this blob before.
fn blob_summary(len: usize) -> String {
    if len < 1_000 {
        return format!("{len} bytes");
    }
    if len < 1_000_000 {
        return format!("{:.1} kB", len as f64 / 1_000.0);
    }

    format!("{:.1} MB", len as f64 / 1_000_000.0)
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
        // icydb already flattened this cell to a string, so there is no list
        // structure left to carry — not even for a cell that was one.
        items: None,
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
        assert_eq!(dto.display, "40 bytes");
    }

    /// The bug this branch exists for. icydb renders a blob as complete lowercase
    /// hex, and only the top-level case used to be summarised — so a thumbnail
    /// inside a composite arrived as tens of thousands of characters per cell.
    #[test]
    fn a_blob_nested_in_a_map_is_summarised_too() {
        let thumbnail = OutputValue::Blob(vec![7u8; 30_000]);
        let record = OutputValue::Map(vec![
            (OutputValue::Text("name".into()), OutputValue::Text("cover".into())),
            (OutputValue::Text("data".into()), thumbnail),
        ]);

        let dto = value_to_dto(&record);
        assert_eq!(dto.display, "{name: cover, data: 30.0 kB}");
        // The specific failure: no hex, and nothing remotely the size of the blob.
        assert!(!dto.display.contains("0x"));
        assert!(dto.display.len() < 60, "was {} chars", dto.display.len());
    }

    /// Nesting is arbitrary — a list of records each holding a blob is the real
    /// shape in toko's `User.workspace.pins`.
    #[test]
    fn a_blob_nested_two_deep_is_summarised() {
        let entry = OutputValue::Map(vec![(
            OutputValue::Text("thumb".into()),
            OutputValue::Blob(vec![0u8; 2_500_000]),
        )]);
        let dto = value_to_dto(&OutputValue::List(vec![entry]));

        assert_eq!(dto.display, "[{thumb: 2.5 MB}]");
    }

    /// A size a reader can judge, rather than a number to decode. Powers of ten,
    /// matching how file and image sizes are quoted everywhere else.
    #[test]
    fn blob_sizes_read_in_the_unit_that_suits_them() {
        let at = |len: usize| value_to_dto(&OutputValue::Blob(vec![0u8; len])).display;

        assert_eq!(at(0), "0 bytes");
        assert_eq!(at(999), "999 bytes");
        assert_eq!(at(1_000), "1.0 kB");
        assert_eq!(at(30_720), "30.7 kB");
        assert_eq!(at(999_999), "1000.0 kB");
        assert_eq!(at(1_000_000), "1.0 MB");
    }

    /// Containers are rendered here now, so the shapes icydb produced must be
    /// preserved exactly — a reader who has seen these values in icydb-cli should
    /// recognise them.
    #[test]
    fn containers_keep_icydbs_own_bracket_shapes() {
        let list = OutputValue::List(vec![OutputValue::Nat64(1), OutputValue::Nat64(2)]);
        assert_eq!(value_to_dto(&list).display, "[1, 2]");

        let map = OutputValue::Map(vec![
            (OutputValue::Text("a".into()), OutputValue::Nat64(1)),
            (OutputValue::Text("b".into()), OutputValue::Nat64(2)),
        ]);
        assert_eq!(value_to_dto(&map).display, "{a: 1, b: 2}");

        assert_eq!(value_to_dto(&OutputValue::List(vec![])).display, "[]");
        assert_eq!(value_to_dto(&OutputValue::Map(vec![])).display, "{}");
    }

    /// A null *inside* a container still renders as icydb spells it. The empty
    /// display is for a whole cell being null, where the frontend draws its own
    /// marker — nested, "null" is the value and has to be readable.
    ///
    /// The first version of this test asserted `{x: }`, documenting a regression
    /// this rewrite had just introduced as though it were the intent. Rendering
    /// containers locally moved every nested null onto the whole-cell rule.
    #[test]
    fn a_null_inside_a_container_still_reads_as_null() {
        let map = OutputValue::Map(vec![(OutputValue::Text("x".into()), OutputValue::Null)]);
        assert_eq!(value_to_dto(&map).display, "{x: null}");

        // And the whole-cell rule is untouched.
        assert_eq!(value_to_dto(&OutputValue::Null).display, "");
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

    /// A list relation holds the target's keys, and following it means building
    /// `WHERE key IN (…)` from them. They arrive structured so the frontend never
    /// has to parse `[a, b]` back apart — that would decode an icydb-internal
    /// format outside this module, and a mis-parse would query the wrong row.
    #[test]
    fn a_list_carries_its_elements_as_well_as_its_text() {
        let dto = value_to_dto(&OutputValue::List(vec![
            OutputValue::Text("first".into()),
            OutputValue::Text("second".into()),
        ]));

        let items = dto.items.expect("a list carries its elements");
        assert_eq!(items.len(), 2);
        // Each element is a full `ValueDto`, so a caller reads `display` the same
        // way it does for a scalar cell rather than special-casing elements.
        assert_eq!(items[0].display, "first");
        assert_eq!(items[1].display, "second");
        assert_eq!(items[0].kind, "text");
    }

    /// An empty list is a real state — a relation field with nothing in it — and
    /// must be `Some(vec![])`, not `None`. "No elements" and "not a list" are
    /// different answers, and only the first one means there is nothing to follow.
    #[test]
    fn an_empty_list_carries_an_empty_element_list_not_none() {
        let dto = value_to_dto(&OutputValue::List(vec![]));

        let items = dto.items.expect("an empty list is still a list");
        assert_eq!(items.len(), 0);
    }

    /// Nothing follows a scalar or a map, so neither invents an element list. A
    /// map's pairs are not keys, and flattening them would produce a shape with
    /// no consumer that a caller could mistake for one.
    #[test]
    fn scalars_and_maps_carry_no_elements() {
        assert!(value_to_dto(&OutputValue::Nat64(1)).items.is_none());
        assert!(value_to_dto(&OutputValue::Text("x".into())).items.is_none());
        assert!(value_to_dto(&OutputValue::Null).items.is_none());
        assert!(
            value_to_dto(&OutputValue::Map(vec![(
                OutputValue::Text("k".into()),
                OutputValue::Nat64(9)
            )]))
            .items
            .is_none()
        );
    }

    /// A nested list nests, rather than being flattened into one level: the
    /// element of a list of lists is itself a list with its own elements.
    #[test]
    fn nested_lists_nest() {
        let dto = value_to_dto(&OutputValue::List(vec![OutputValue::List(vec![
            OutputValue::Nat64(1),
        ])]));

        let outer = dto.items.expect("outer elements");
        assert_eq!(outer.len(), 1);
        assert_eq!(outer[0].kind, "list");
        assert_eq!(outer[0].items.as_ref().expect("inner elements").len(), 1);
    }

    /// `items` is skipped rather than serialised as null. `ValueDto` is the most
    /// numerous shape on the wire, and a null on every scalar cell of every row
    /// would be pure overhead.
    #[test]
    fn a_scalar_omits_items_from_the_wire_entirely() {
        let scalar = serde_json::to_value(value_to_dto(&OutputValue::Nat64(7))).unwrap();
        assert!(scalar.get("items").is_none());

        let list = serde_json::to_value(value_to_dto(&OutputValue::List(vec![
            OutputValue::Nat64(7),
        ])))
        .unwrap();
        assert!(list["items"].is_array());
    }

    /// The spec's testing table mandates every `OutputValue` variant be
    /// covered, not just a convenient subset — before this test, 9 of 24
    /// were exercised here, and the four variants the spec calls out as
    /// motivating type-aware rendering at all (`ulid`, `principal`,
    /// `decimal`, `timestamp`) were asserted only in the replica-gated
    /// integration test, i.e. never in a suite that runs without a live
    /// canister. Table-driven over all 24 so a future icydb release adding
    /// a 25th variant (which `kind_of`'s exhaustive match already forces to
    /// be handled) also gets a test case added here, not just a match arm.
    #[test]
    fn every_output_value_variant_maps_to_its_own_kind() {
        use icydb::types::{
            Account, Date, Decimal, Duration, Float32, Float64, IntBig, NatBig, Principal,
            Subaccount, Timestamp, Ulid,
        };
        use icydb::value::OutputValueEnum;

        let principal = Principal::anonymous();

        // `OutputValueEnum`'s fields are private with no public constructor
        // outside icydb itself (only a `pub(crate) from_catalog_parts`) —
        // but it derives `serde::Deserialize`, so this builds one the same
        // way any other cross-boundary payload is decoded, without needing
        // icydb to expose a test-only constructor.
        let enum_value: OutputValueEnum = serde_json::from_value(serde_json::json!({
            "variant": "active",
            "path": null,
            "payload": null,
        }))
        .expect("OutputValueEnum should deserialize for testing");

        let cases: Vec<(OutputValue, &str)> = vec![
            (
                OutputValue::Account(Account::new(principal, None::<Subaccount>)),
                "account",
            ),
            (OutputValue::Blob(vec![1, 2, 3]), "blob"),
            (OutputValue::Bool(true), "bool"),
            (
                OutputValue::Date(Date::try_new(2024, 1, 1).expect("valid calendar date")),
                "date",
            ),
            (OutputValue::Decimal(Decimal::new(1050, 2)), "decimal"),
            (OutputValue::Duration(Duration::from(60u64)), "duration"),
            (OutputValue::Enum(enum_value), "enum"),
            (OutputValue::Float32(Float32::from(1i32)), "float32"),
            (OutputValue::Float64(Float64::from(1i32)), "float64"),
            (OutputValue::Int64(-7), "int"),
            (OutputValue::Int128(-7i128), "int128"),
            (OutputValue::IntBig(IntBig::from(-7i64)), "intbig"),
            (OutputValue::List(vec![OutputValue::Nat64(1)]), "list"),
            (
                OutputValue::Map(vec![(OutputValue::Text("k".into()), OutputValue::Nat64(1))]),
                "map",
            ),
            (OutputValue::Null, "null"),
            (OutputValue::Principal(principal), "principal"),
            (
                OutputValue::Subaccount(Subaccount::from(principal)),
                "subaccount",
            ),
            (OutputValue::Text("hi".into()), "text"),
            (OutputValue::Timestamp(Timestamp::from(0u64)), "timestamp"),
            (OutputValue::Nat64(7), "nat"),
            (OutputValue::Nat128(7u128), "nat128"),
            (OutputValue::NatBig(NatBig::from(7u64)), "natbig"),
            // `Ulid::generate()` now returns `Result<Self, InternalError>` and
            // needs live entropy; this test only needs *a* valid `Ulid`
            // value, not a freshly generated one, so `from_bytes` avoids
            // pulling entropy concerns into a pure-mapping test.
            (OutputValue::Ulid(Ulid::from_bytes([0u8; 16])), "ulid"),
            (OutputValue::Unit, "unit"),
        ];

        assert_eq!(
            cases.len(),
            24,
            "this list itself must cover all 24 OutputValue variants"
        );

        for (value, expected_kind) in cases {
            assert_eq!(value_to_dto(&value).kind, expected_kind, "value: {value:?}");
        }
    }
}
