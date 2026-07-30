//! Pure SQL construction for `commands::fetch_rows`, split out so the
//! order-by derivation and statement-building logic is table-tested here
//! rather than living untested inline in the command handler.

use crate::error::AppError;

/// Builds the `SELECT` for one page of `entity`'s rows.
///
/// icydb rejects any `LIMIT`/`OFFSET` window with no explicit `ORDER BY`
/// (`PolicyPlanError::UnorderedPagination`; confirmed live against a real
/// canister — see the Task 10 report). Ordering by *any* column satisfies
/// the planner, so this orders by `pk_columns` (in the order given) when
/// there are any.
///
/// `pk_columns` empty is refused with `AppError::NoOrderableColumns` rather
/// than falling back to an unordered `SELECT`: a bare `LIMIT`/`OFFSET` with
/// no `ORDER BY` is something icydb is guaranteed to reject anyway
/// (`UnorderedPagination`), so silently emitting one would just trade a
/// clear, local error for a confusing round-trip to the canister. This case
/// should not occur against a well-formed schema — every icydb entity must
/// declare a primary key — but a malformed one must fail honestly here
/// rather than build SQL that can't work.
pub fn rows_sql(
    entity: &str,
    pk_columns: &[String],
    limit: u32,
    offset: u32,
) -> Result<String, AppError> {
    if pk_columns.is_empty() {
        Err(AppError::NoOrderableColumns {
            entity: entity.to_string(),
        })
    } else {
        Ok(format!(
            "SELECT * FROM {entity} ORDER BY {} LIMIT {limit} OFFSET {offset}",
            pk_columns.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_by_a_single_primary_key_column() {
        let sql = rows_sql("demo_row", &["id".to_string()], 100, 0).expect("should build SQL");
        assert_eq!(sql, "SELECT * FROM demo_row ORDER BY id LIMIT 100 OFFSET 0");
    }

    #[test]
    fn orders_by_every_column_of_a_composite_primary_key_in_order() {
        let sql = rows_sql(
            "demo_row",
            &["tenant_id".to_string(), "id".to_string()],
            50,
            10,
        )
        .expect("should build SQL");
        assert_eq!(
            sql,
            "SELECT * FROM demo_row ORDER BY tenant_id, id LIMIT 50 OFFSET 10"
        );
    }

    #[test]
    fn empty_primary_key_is_refused_rather_than_left_unordered() {
        let error = rows_sql("demo_row", &[], 100, 20).expect_err("should refuse");
        match error {
            AppError::NoOrderableColumns { entity } => assert_eq!(entity, "demo_row"),
            other => panic!("expected NoOrderableColumns, got {other:?}"),
        }
    }

    #[test]
    fn respects_the_requested_limit_and_offset() {
        let sql = rows_sql("demo_row", &["id".to_string()], 7, 42).expect("should build SQL");
        assert_eq!(sql, "SELECT * FROM demo_row ORDER BY id LIMIT 7 OFFSET 42");
    }

    /// No code path through `rows_sql` can produce a `SELECT` lacking either
    /// `ORDER BY` or `LIMIT`: the only success path always emits both, and
    /// the only other path is a hard error. This is the regression test for
    /// the removed `unordered_rows_sql` fallback (see git history) — an
    /// unbounded, unordered `SELECT` must no longer be constructible here at
    /// all, not merely unused.
    #[test]
    fn every_successful_build_has_both_order_by_and_limit() {
        let cases: Vec<Result<String, AppError>> = vec![
            rows_sql("demo_row", &["id".to_string()], 100, 0),
            rows_sql(
                "demo_row",
                &["tenant_id".to_string(), "id".to_string()],
                1,
                0,
            ),
        ];
        for result in cases {
            let sql = result.expect("should build SQL");
            let upper = sql.to_uppercase();
            assert!(upper.contains("ORDER BY"), "missing ORDER BY: {sql}");
            assert!(upper.contains("LIMIT"), "missing LIMIT: {sql}");
        }
    }
}
