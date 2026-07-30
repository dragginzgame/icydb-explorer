//! Pure SQL construction for `commands::fetch_rows`, split out so the
//! order-by derivation and statement-building logic is table-tested here
//! rather than living untested inline in the command handler.

/// Builds the `SELECT` for one page of `entity`'s rows.
///
/// icydb rejects any `LIMIT`/`OFFSET` window with no explicit `ORDER BY`
/// (`PolicyPlanError::UnorderedPagination`; confirmed live against a real
/// canister — see the Task 10 report). Ordering by *any* column satisfies
/// the planner, so this orders by `pk_columns` (in the order given) when
/// there are any.
///
/// `pk_columns` empty is the fallback for a schema this app cannot derive
/// an ordering from (a malformed entity with no declared primary key, which
/// cannot occur for a valid icydb schema — every entity must declare one).
/// It is kept rather than special-cased away so that case fails with the
/// canister's own clear `UnorderedPagination` rejection instead of a panic.
pub fn rows_sql(entity: &str, pk_columns: &[String], limit: u32, offset: u32) -> String {
    if pk_columns.is_empty() {
        format!("SELECT * FROM {entity} LIMIT {limit} OFFSET {offset}")
    } else {
        format!(
            "SELECT * FROM {entity} ORDER BY {} LIMIT {limit} OFFSET {offset}",
            pk_columns.join(", ")
        )
    }
}

/// Builds an unordered, unbounded `SELECT` for `entity` — used when
/// introspection is disabled (`AppError::IntrospectionDisabled`), so no
/// primary key can be derived via `DESCRIBE` in the first place. Unlike
/// `rows_sql`'s empty-`pk_columns` fallback, this deliberately omits
/// `LIMIT`/`OFFSET` rather than attaching a window icydb is guaranteed to
/// reject: with no ordering derivable at all, a bounded page isn't
/// achievable, so this returns everything in one unordered result instead.
pub fn unordered_rows_sql(entity: &str) -> String {
    format!("SELECT * FROM {entity}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_by_a_single_primary_key_column() {
        let sql = rows_sql("demo_row", &["id".to_string()], 100, 0);
        assert_eq!(sql, "SELECT * FROM demo_row ORDER BY id LIMIT 100 OFFSET 0");
    }

    #[test]
    fn orders_by_every_column_of_a_composite_primary_key_in_order() {
        let sql = rows_sql(
            "demo_row",
            &["tenant_id".to_string(), "id".to_string()],
            50,
            10,
        );
        assert_eq!(
            sql,
            "SELECT * FROM demo_row ORDER BY tenant_id, id LIMIT 50 OFFSET 10"
        );
    }

    #[test]
    fn empty_primary_key_falls_back_to_no_order_by() {
        let sql = rows_sql("demo_row", &[], 100, 20);
        assert_eq!(sql, "SELECT * FROM demo_row LIMIT 100 OFFSET 20");
    }

    #[test]
    fn respects_the_requested_limit_and_offset() {
        let sql = rows_sql("demo_row", &["id".to_string()], 7, 42);
        assert_eq!(sql, "SELECT * FROM demo_row ORDER BY id LIMIT 7 OFFSET 42");
    }

    #[test]
    fn unordered_rows_sql_has_no_limit_offset_or_order_by() {
        let sql = unordered_rows_sql("demo_row");
        assert_eq!(sql, "SELECT * FROM demo_row");
        assert!(!sql.to_uppercase().contains("LIMIT"));
        assert!(!sql.to_uppercase().contains("OFFSET"));
        assert!(!sql.to_uppercase().contains("ORDER BY"));
    }
}
