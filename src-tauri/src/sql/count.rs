//! Builds and reads the row-count query behind `commands::count_rows`.

use crate::error::AppError;
use crate::view::{ResultDto, ValueDto};

/// `SELECT COUNT(*) FROM <entity>`.
///
/// No `LIMIT`, and deliberately so: icydb ties `LIMIT` to `ORDER BY`, and there
/// is nothing to order — the statement returns exactly one row whatever the
/// table holds. That also means this is the one place this app issues an
/// unbounded statement, which is why counting is user-initiated rather than
/// automatic; see `commands::count_rows`.
#[must_use]
pub fn count_sql(entity: &str) -> String {
    format!("SELECT COUNT(*) FROM {entity}")
}

/// Reads the count out of what icydb returns for `count_sql`.
///
/// icydb answers with an ordinary projection — one row, one column named
/// `COUNT(*)`, holding a `Nat` — not with its `Count` result variant, which is
/// reserved for other statements. Verified against a live 0.215.7 canister; a
/// `SHOW`-style shape here would be a version change worth failing loudly on
/// rather than papering over with a zero.
pub fn read_count(result: &ResultDto, entity: &str) -> Result<u64, AppError> {
    let ResultDto::Rows(rows) = result else {
        return Err(AppError::Parse(format!(
            "counting {entity} returned {result:?}, not a row projection"
        )));
    };

    match rows.rows.first().and_then(|row| row.first()) {
        Some(ValueDto { kind, display }) if kind == "nat" || kind == "int" => {
            display.parse::<u64>().map_err(|_| {
                AppError::Parse(format!("counting {entity} returned an unreadable {kind}"))
            })
        }
        Some(other) => Err(AppError::Parse(format!(
            "counting {entity} returned a {} where a number was expected",
            other.kind
        ))),
        None => Err(AppError::Parse(format!(
            "counting {entity} returned no value"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::RowsDto;

    fn projection(kind: &str, display: &str) -> ResultDto {
        ResultDto::Rows(RowsDto {
            entity: "RegistryProject".into(),
            columns: vec!["COUNT(*)".into()],
            rows: vec![vec![ValueDto {
                kind: kind.into(),
                display: display.into(),
            }]],
            row_count: 1,
            next_cursor: None,
        })
    }

    #[test]
    fn builds_an_unlimited_count_statement() {
        assert_eq!(
            count_sql("RegistryProject"),
            "SELECT COUNT(*) FROM RegistryProject"
        );
    }

    /// The exact shape a live canister returned for an empty table: one row,
    /// one `Nat` of 0. Zero is a real answer and must not be confused with a
    /// failure to read one.
    #[test]
    fn reads_a_zero_count_as_zero() {
        let count = read_count(&projection("nat", "0"), "RegistryProject").expect("should read");
        assert_eq!(count, 0);
    }

    #[test]
    fn reads_a_populated_count() {
        let count = read_count(&projection("nat", "4211"), "RegistryProject").expect("should read");
        assert_eq!(count, 4211);
    }

    /// A shape this app does not recognise must fail loudly. Returning 0 would
    /// be indistinguishable from an empty table, which is exactly the question
    /// the count exists to answer.
    #[test]
    fn an_unexpected_shape_is_an_error_not_a_zero() {
        let wrong = ResultDto::Count {
            entity: "RegistryProject".into(),
            row_count: 7,
        };
        assert!(read_count(&wrong, "RegistryProject").is_err());
    }

    #[test]
    fn a_non_numeric_value_is_an_error_not_a_zero() {
        let text = projection("text", "lots");
        assert!(read_count(&text, "RegistryProject").is_err());
    }
}
