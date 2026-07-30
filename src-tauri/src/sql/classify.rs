use crate::error::AppError;

/// The read-only statement kinds this explorer accepts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Statement {
    Select,
    Show,
    Describe,
    Explain,
}

/// Classify a SQL statement by its leading verb.
///
/// This is a UX affordance, not a security control: the actual read-only
/// boundary is the target canister's own `readonly = true` configuration,
/// which means write and DDL endpoints are never even generated. This
/// function exists so a user who types an unsupported statement gets an
/// immediate, clear message instead of a confusing round-trip failure.
pub fn classify(sql: &str) -> Result<Statement, AppError> {
    let verb = sql
        .split_whitespace()
        .next()
        .ok_or_else(|| AppError::Rejected("empty statement".to_string()))?;

    match verb.to_uppercase().as_str() {
        "SELECT" => Ok(Statement::Select),
        "SHOW" => Ok(Statement::Show),
        "DESCRIBE" => Ok(Statement::Describe),
        "EXPLAIN" => Ok(Statement::Explain),
        _ => Err(AppError::Rejected(format!(
            "{verb} is not available — this explorer only supports SELECT, SHOW, DESCRIBE, and EXPLAIN"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_read_statements() {
        for (sql, expected) in [
            ("SELECT * FROM demo_row", Statement::Select),
            ("  select id from demo_row  ", Statement::Select),
            ("SHOW ENTITIES", Statement::Show),
            ("DESCRIBE demo_row", Statement::Describe),
            ("EXPLAIN SELECT * FROM demo_row", Statement::Explain),
        ] {
            assert_eq!(classify(sql).unwrap(), expected, "sql: {sql}");
        }
    }

    #[test]
    fn rejects_writes_and_ddl_by_naming_the_verb() {
        for sql in ["INSERT INTO demo_row VALUES (1)", "UPDATE demo_row SET a = 1",
                    "DELETE FROM demo_row", "CREATE INDEX i ON demo_row (a)",
                    "DROP INDEX i", "ALTER TABLE demo_row ADD COLUMN a text"] {
            let error = classify(sql).expect_err("should reject");
            let text = error.explanation();
            let verb = sql.split_whitespace().next().unwrap();
            assert!(text.contains(verb), "explanation should name {verb}: {text}");
            assert!(text.contains("read-only"), "explanation should say read-only: {text}");
        }
    }

    #[test]
    fn rejects_empty_input() {
        assert!(classify("   ").is_err());
    }
}
