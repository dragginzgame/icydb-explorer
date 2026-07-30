use super::Statement;

/// The result of applying a default `LIMIT` to a `SELECT` statement.
pub struct LimitedSql {
    pub sql: String,
    pub limit_appended: bool,
}

/// Append a default `LIMIT` clause to a `SELECT` statement that doesn't
/// already have one.
///
/// Non-`SELECT` statements are returned untouched. Detection of an
/// existing `LIMIT` clause is case-insensitive and matches only whole
/// words, so a column named `limit_reached` is not mistaken for a
/// `LIMIT` clause.
pub fn apply_default_limit(sql: &str, statement: Statement, default: u32) -> LimitedSql {
    if statement != Statement::Select {
        return LimitedSql {
            sql: sql.to_string(),
            limit_appended: false,
        };
    }

    let trimmed = sql.trim().trim_end_matches(';').trim_end();

    if contains_limit_keyword(trimmed) {
        LimitedSql {
            sql: trimmed.to_string(),
            limit_appended: false,
        }
    } else {
        LimitedSql {
            sql: format!("{trimmed} LIMIT {default}"),
            limit_appended: true,
        }
    }
}

/// Whether `sql` contains the word `LIMIT` (case-insensitive, whole word
/// only — not as a substring of a longer identifier).
fn contains_limit_keyword(sql: &str) -> bool {
    sql.split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|word| word.eq_ignore_ascii_case("limit"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_limit_when_select_has_none() {
        let result = apply_default_limit("SELECT * FROM demo_row", Statement::Select, 100);
        assert_eq!(result.sql, "SELECT * FROM demo_row LIMIT 100");
        assert!(result.limit_appended);
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

    #[test]
    fn never_touches_non_select_statements() {
        for statement in [Statement::Show, Statement::Describe, Statement::Explain] {
            let result = apply_default_limit("SHOW ENTITIES", statement, 100);
            assert_eq!(result.sql, "SHOW ENTITIES");
            assert!(!result.limit_appended);
        }
    }

    #[test]
    fn trailing_semicolon_still_gets_a_limit() {
        let result = apply_default_limit("SELECT * FROM demo_row;", Statement::Select, 100);
        assert_eq!(result.sql, "SELECT * FROM demo_row LIMIT 100");
        assert!(result.limit_appended);
    }
}
