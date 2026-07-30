use super::Statement;

/// The result of applying a default `LIMIT` to a `SELECT` statement.
pub struct LimitedSql {
    pub sql: String,
    pub limit_appended: bool,
    /// Set when this is a `SELECT` with neither its own `LIMIT` nor an
    /// `ORDER BY`, so no default `LIMIT` was appended even though the
    /// statement is otherwise unbounded — appending one would only
    /// manufacture icydb's `UnorderedPagination` rejection (see the module
    /// doc comment below). Lets a caller (the SQL console) hint at the fix
    /// instead of the user finding out only after a round trip.
    pub order_by_missing: bool,
}

/// Append a default `LIMIT` clause to a `SELECT` statement that doesn't
/// already have one — but only when the statement already carries an
/// explicit `ORDER BY`.
///
/// icydb rejects any `LIMIT`/`OFFSET` window that lacks an explicit
/// `ORDER BY` (`PolicyPlanError::UnorderedPagination` — "pagination
/// requires an explicit ordering"; confirmed live against a real canister,
/// see Task 10's report). Appending a bare `LIMIT` to an `ORDER BY`-less
/// `SELECT` would therefore manufacture a guaranteed rejection for the
/// single most common console query (`SELECT * FROM demo_row`) — worse
/// than doing nothing at all. So a `SELECT` with no `ORDER BY` is now left
/// completely untouched (`limit_appended` stays `false`) instead of
/// gaining a `LIMIT` that could only ever fail; the user can add an
/// `ORDER BY` themselves, and `AppError`'s `IcyDb` explanation (see
/// `error.rs`) tells them so when they hit the rejection directly.
///
/// This module deliberately does not inject an `ORDER BY` on the user's
/// behalf: doing that correctly would need the entity's primary key (an
/// extra round trip this module — a pure, synchronous function — has no
/// way to make) and correct placement relative to arbitrary
/// `WHERE`/`GROUP BY` clauses in user-typed SQL, i.e. actually parsing the
/// statement. Not worth the machinery when the user can type four more
/// words themselves.
///
/// Non-`SELECT` statements are returned untouched, as before. Detection of
/// an existing `LIMIT` or `ORDER BY` clause is case-insensitive and matches
/// only whole words, so a column named `limit_reached` or an identifier
/// like `orderby_hint` is not mistaken for either clause.
pub fn apply_default_limit(sql: &str, statement: Statement, default: u32) -> LimitedSql {
    if statement != Statement::Select {
        return LimitedSql {
            sql: sql.to_string(),
            limit_appended: false,
            order_by_missing: false,
        };
    }

    let trimmed = sql.trim().trim_end_matches(';').trim_end();
    let has_limit = contains_limit_keyword(trimmed);
    let has_order_by = contains_order_by_keywords(trimmed);

    if has_limit {
        return LimitedSql {
            sql: trimmed.to_string(),
            limit_appended: false,
            order_by_missing: false,
        };
    }

    if has_order_by {
        return LimitedSql {
            sql: format!("{trimmed} LIMIT {default}"),
            limit_appended: true,
            order_by_missing: false,
        };
    }

    LimitedSql {
        sql: trimmed.to_string(),
        limit_appended: false,
        order_by_missing: true,
    }
}

/// Whether `sql` contains the word `LIMIT` (case-insensitive, whole word
/// only — not as a substring of a longer identifier).
fn contains_limit_keyword(sql: &str) -> bool {
    sql.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|word| word.eq_ignore_ascii_case("limit"))
}

/// Whether `sql` contains the two consecutive whole words `ORDER` `BY`
/// (case-insensitive) — the same whole-word matching `contains_limit_keyword`
/// uses, extended to a two-word phrase, so e.g. an identifier like
/// `reorder_by_hand` is not mistaken for the clause.
fn contains_order_by_keywords(sql: &str) -> bool {
    let words: Vec<&str> = sql
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty())
        .collect();
    words
        .windows(2)
        .any(|pair| pair[0].eq_ignore_ascii_case("order") && pair[1].eq_ignore_ascii_case("by"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Was `appends_limit_when_select_has_none` (`"SELECT * FROM demo_row"`,
    /// no `ORDER BY`). That fixture now exercises the *other* new rule (no
    /// `ORDER BY` -> untouched, see `does_not_append_limit_when_select_lacks_order_by`
    /// below), so it's updated here to add the `ORDER BY` this test is
    /// actually meant to check appending against, rather than silently
    /// asserting behavior this fix deliberately removes.
    #[test]
    fn appends_limit_when_select_has_order_by_but_no_limit() {
        let result =
            apply_default_limit("SELECT * FROM demo_row ORDER BY id", Statement::Select, 100);
        assert_eq!(result.sql, "SELECT * FROM demo_row ORDER BY id LIMIT 100");
        assert!(result.limit_appended);
    }

    /// New case explicitly requested: a `SELECT` with no `ORDER BY` must be
    /// left completely untouched (no `LIMIT` appended, `limit_appended`
    /// stays `false`) rather than gaining a `LIMIT` icydb can only reject.
    #[test]
    fn does_not_append_limit_when_select_lacks_order_by() {
        let result = apply_default_limit("SELECT * FROM demo_row", Statement::Select, 100);
        assert_eq!(result.sql, "SELECT * FROM demo_row");
        assert!(!result.limit_appended);
        assert!(
            result.order_by_missing,
            "should flag that no LIMIT was added because of the missing ORDER BY"
        );
    }

    /// The `order_by_missing` hint is specific to "we chose not to append a
    /// LIMIT because there's no ORDER BY" — it must not fire for any of the
    /// other untouched-statement cases (already has its own LIMIT, or isn't
    /// a SELECT at all).
    #[test]
    fn order_by_missing_is_false_when_a_limit_was_appended() {
        let result =
            apply_default_limit("SELECT * FROM demo_row ORDER BY id", Statement::Select, 100);
        assert!(!result.order_by_missing);
    }

    #[test]
    fn order_by_missing_is_false_when_the_statement_already_has_its_own_limit() {
        let result = apply_default_limit("SELECT * FROM demo_row LIMIT 5", Statement::Select, 100);
        assert!(!result.order_by_missing);
    }

    #[test]
    fn order_by_missing_is_false_for_non_select_statements() {
        let result = apply_default_limit("SHOW ENTITIES", Statement::Show, 100);
        assert!(!result.order_by_missing);
    }

    /// `ORDER BY` detection is case-insensitive, matching how `LIMIT`
    /// detection already behaves.
    #[test]
    fn detects_order_by_case_insensitively() {
        let result =
            apply_default_limit("select * from demo_row order by id", Statement::Select, 100);
        assert!(result.limit_appended);
        assert_eq!(result.sql, "select * from demo_row order by id LIMIT 100");
    }

    #[test]
    fn leaves_existing_limit_untouched() {
        let result = apply_default_limit("SELECT * FROM demo_row LIMIT 5", Statement::Select, 100);
        assert_eq!(result.sql, "SELECT * FROM demo_row LIMIT 5");
        assert!(!result.limit_appended);
    }

    #[test]
    fn detects_limit_case_insensitively() {
        let result = apply_default_limit("select * from demo_row limit 5", Statement::Select, 100);
        assert!(!result.limit_appended);
    }

    /// Regression test for a bug the whole-word matchers must not
    /// reintroduce: a column literally named `limit_reached` contains the
    /// substring `"limit"`, so a `.contains("limit")` shortcut would
    /// wrongly conclude the statement already has a `LIMIT` clause and
    /// silently skip appending the default one. Both `contains_limit_keyword`
    /// and `contains_order_by_keywords` are whole-word matchers precisely to
    /// avoid this — this test would fail if either were ever refactored back
    /// to a substring check.
    #[test]
    fn column_named_limit_reached_is_not_mistaken_for_a_limit_clause() {
        let result = apply_default_limit(
            "SELECT limit_reached FROM demo_row ORDER BY id",
            Statement::Select,
            100,
        );
        assert_eq!(
            result.sql,
            "SELECT limit_reached FROM demo_row ORDER BY id LIMIT 100"
        );
        assert!(result.limit_appended);
    }

    #[test]
    fn never_touches_non_select_statements() {
        for statement in [Statement::Show, Statement::Describe, Statement::Explain] {
            let result = apply_default_limit("SHOW ENTITIES", statement, 100);
            assert_eq!(result.sql, "SHOW ENTITIES");
            assert!(!result.limit_appended);
        }
    }

    /// Was `trailing_semicolon_still_gets_a_limit` (`"SELECT * FROM
    /// demo_row;"`, no `ORDER BY`). Updated for the same reason as
    /// `appends_limit_when_select_has_order_by_but_no_limit` above — this
    /// test's actual point is the trailing-semicolon trim, which still
    /// needs an `ORDER BY` present to reach the appending branch at all.
    #[test]
    fn trailing_semicolon_still_gets_a_limit() {
        let result = apply_default_limit(
            "SELECT * FROM demo_row ORDER BY id;",
            Statement::Select,
            100,
        );
        assert_eq!(result.sql, "SELECT * FROM demo_row ORDER BY id LIMIT 100");
        assert!(result.limit_appended);
    }
}
