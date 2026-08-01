use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

/// The single error type returned by every backend module.
///
/// This is a developer tool whose most common failure modes are
/// configuration problems, not bugs — so `explanation()` is written to
/// tell an operator what to check or change, not just to restate what
/// went wrong.
///
/// `Display` (below) delegates to `explanation()` rather than a second,
/// separately-maintained set of per-variant strings: the two describing
/// the same error used to be able to drift apart (e.g. `Rejected`'s old
/// `Display` read "statement rejected: {0}", blunter than `explanation()`'s
/// read-only framing), and whichever text a future call site reaches for —
/// `.to_string()`/`{}` or `.explanation()` — should say the same thing.
#[derive(Debug, Clone)]
pub enum AppError {
    /// A local I/O failure (reading config, dfx state, etc).
    Io(String),

    /// A parse failure (candid, JSON, TOML, etc).
    Parse(String),

    /// An ic-agent transport/call failure not covered by a more specific
    /// variant below.
    Agent(String),

    /// The target canister has no `icydb_query` method: the SQL surface
    /// was never enabled.
    NoSqlSurface { canister: String },

    /// The canister exposes SQL but was built with introspection disabled,
    /// so SHOW/DESCRIBE/EXPLAIN are unavailable.
    IntrospectionDisabled,

    /// The identity used is not a controller of the canister, and icydb's
    /// SQL endpoints are controller-gated.
    NotController { identity: String },

    /// The configured replica could not be reached.
    ReplicaUnreachable { url: String },

    /// An error returned by icydb itself, surfaced verbatim.
    IcyDb { code: String, message: String },

    /// A statement was rejected by the explorer's read-only statement
    /// classifier.
    Rejected(String),

    /// `fetch_rows`'s `DESCRIBE` (used to find a primary key to page by)
    /// failed with `IntrospectionDisabled`. Introspection off means no
    /// primary key is discoverable, and icydb rejects any `LIMIT`/`OFFSET`
    /// window with no explicit `ORDER BY` regardless (see `IcyDb`'s `E5`
    /// case) — so there is no bounded, ordered page `fetch_rows` can
    /// construct. Row browsing is *unavailable* here, not merely
    /// schema-blind; the SQL console remains available for a hand-written,
    /// explicitly ordered `SELECT`. Replaces an earlier fallback that issued
    /// an unbounded `SELECT * FROM {entity}` against the trusted/admin SQL
    /// lane — wrong, since that lane intentionally bypasses the public-read
    /// admission an unbounded read would need to be safe.
    RowPagingRequiresIntrospection { entity: String },

    /// `rows_sql` was asked to page an entity with no primary-key columns to
    /// order by. Every valid icydb entity declares one, so this should be
    /// unreachable in practice; it exists so a malformed schema fails with a
    /// clear message rather than emitting a `LIMIT`/`OFFSET` window icydb is
    /// guaranteed to reject as `UnorderedPagination` anyway.
    NoOrderableColumns { entity: String },

    /// No project is open: the app launched with nothing remembered, or the
    /// remembered root has since been moved or deleted. Every command that
    /// needs a project reports this rather than pretending an empty project
    /// exists.
    NoProjectSelected,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.explanation())
    }
}

impl std::error::Error for AppError {}

impl AppError {
    /// Operator-facing explanation: what happened, and — where the cause
    /// is a configuration choice rather than a bug — what to do about it.
    pub fn explanation(&self) -> String {
        match self {
            AppError::Io(msg) => format!("A local I/O error occurred: {msg}"),
            AppError::Parse(msg) => format!("Failed to parse data: {msg}"),
            AppError::Agent(msg) => format!("The IC agent reported an error: {msg}"),
            AppError::NoSqlSurface { canister } => format!(
                "The canister \"{canister}\" has no `icydb_query` method, so its SQL surface is not enabled. \
                 To enable it, add `features = [\"sql\"]` to the canister's icydb dependency and provide an \
                 icydb.toml, then rebuild and redeploy the canister. Note that Cargo does not forward a \
                 dependency's features to the crate that uses it, so the canister crate itself also needs \
                 `[features] default = [\"sql\"]` (or to otherwise enable that feature on itself) for the \
                 generated `#[cfg(feature = \"sql\")]` glue to be compiled in."
            ),
            AppError::IntrospectionDisabled => {
                "SHOW, DESCRIBE, and EXPLAIN are unavailable because this canister was built with \
                 `introspection` `ic = false`. This is a build-time configuration choice owned by the \
                 canister, not a failure of this explorer; the canister owner would need to rebuild with \
                 introspection enabled to expose this information."
                    .to_string()
            }
            AppError::NotController { identity } => format!(
                "The identity \"{identity}\" is not a controller of this canister. icydb's SQL endpoints \
                 are controller-gated, so only a controller identity can query them."
            ),
            AppError::ReplicaUnreachable { url } => format!(
                "Could not reach the replica at {url}. Check that the replica is running and that the URL \
                 is correct."
            ),
            AppError::IcyDb { code, message } => {
                if is_order_by_not_orderable(message) {
                    "Automatic row paging ordered this table by its primary key, and icydb \
                     rejected that: the key's type has no ordering defined, so it cannot appear \
                     in an ORDER BY. Since icydb also requires an ORDER BY whenever a statement \
                     uses LIMIT, this table cannot be paged automatically at all. Use the SQL \
                     console with an explicit `ORDER BY <column> LIMIT 100` naming a column that \
                     is orderable — a timestamp such as `created_at` is usually a good choice."
                        .to_string()
                } else if is_unordered_pagination(message) {
                    "This statement uses LIMIT/OFFSET but has no ORDER BY. icydb requires an \
                     explicit ordering whenever a statement paginates — without one, which rows \
                     land on which page isn't well-defined, so icydb rejects the statement \
                     rather than guess. Add an ORDER BY naming any column before the LIMIT (it \
                     doesn't need to be unique or the primary key), e.g. `ORDER BY id LIMIT 100`, \
                     and it will run."
                        .to_string()
                } else {
                    format!("icydb reported error {code}: {message}")
                }
            }
            AppError::Rejected(reason) => format!(
                "This explorer is read-only and does not support this statement: {reason}"
            ),
            AppError::RowPagingRequiresIntrospection { entity } => format!(
                "Automatic row paging for \"{entity}\" needs introspection to derive an ORDER \
                 BY, but this canister was built with introspection disabled. Use the SQL \
                 console with an explicit `ORDER BY ... LIMIT ...` clause to browse this table \
                 instead."
            ),
            AppError::NoOrderableColumns { entity } => format!(
                "\"{entity}\" declares no primary-key column to order by, so automatic row \
                 paging cannot construct a valid ORDER BY. Use the SQL console with an explicit \
                 `ORDER BY ... LIMIT ...` clause to browse this table instead."
            ),
            AppError::NoProjectSelected => {
                "No project is open. Choose a project directory — one containing an `.icp/` \
                 layout — to explore."
                    .to_string()
            }
        }
    }

    /// The lowerCamelCase variant name used as the `kind` field when
    /// serializing.
    fn kind(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Parse(_) => "parse",
            AppError::Agent(_) => "agent",
            AppError::NoSqlSurface { .. } => "noSqlSurface",
            AppError::IntrospectionDisabled => "introspectionDisabled",
            AppError::NotController { .. } => "notController",
            AppError::ReplicaUnreachable { .. } => "replicaUnreachable",
            AppError::IcyDb { .. } => "icyDb",
            AppError::Rejected(_) => "rejected",
            AppError::RowPagingRequiresIntrospection { .. } => "rowPagingRequiresIntrospection",
            AppError::NoOrderableColumns { .. } => "noOrderableColumns",
            AppError::NoProjectSelected => "noProjectSelected",
        }
    }
}

/// Whether an `icydb::Error` (surfaced here only as `AppError::IcyDb`'s
/// `message` string) is diagnostic code 5 — `QUERY_UNORDERED_PAGINATION`
/// (`icydb-diagnostic-code-0.215.5/src/registry.rs`): a statement used
/// `LIMIT`/`OFFSET` without an explicit `ORDER BY`. This is the single
/// most useful `IcyDb` case to give a purpose-written explanation for — a
/// user typing SQL into the console will hit it the moment they add a
/// `LIMIT` (or Task 5's `apply_default_limit` would have added one) without
/// also adding an `ORDER BY`.
///
/// `icydb::Error`'s `Display` impl renders as exactly `"E{code}"` (a plain
/// struct field interpolation, `icydb-0.215.5/src/error.rs`), and 5 is this
/// registry's one and only code for unordered pagination, so matching the
/// full string `"E5"` is exact, not a substring guess.
fn is_unordered_pagination(message: &str) -> bool {
    message == "E5"
}

/// `SQL_FEATURE_ORDER_BY_FIELD_NOT_ORDERABLE`
/// (`icydb-diagnostic-code-0.215.7/src/registry.rs`), raised when a statement
/// orders by a field whose type declares no ordering.
///
/// This is a *different* failure from [`AppError::NoOrderableColumns`], which
/// fires when an entity declares no primary key for paging to order by at all.
/// Here the entity does declare one, this explorer builds what looks like a
/// perfectly good `ORDER BY <pk> LIMIT 100`, and icydb rejects it at query
/// time. Found against toko's `PlatformClaimConfigState`, whose primary key is
/// not an orderable type; before this, that surfaced as a bare `icydb reported
/// error ...: E96` with no indication of what to do about it.
fn is_order_by_not_orderable(message: &str) -> bool {
    message == "E96"
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("kind", self.kind())?;
        map.serialize_entry("explanation", &self.explanation())?;
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_sql_surface_explains_the_required_config() {
        let error = AppError::NoSqlSurface {
            canister: "user_hub".into(),
        };
        let text = error.explanation();
        assert!(text.contains("user_hub"));
        assert!(text.contains(r#"features = ["sql"]"#));
        assert!(text.contains("icydb.toml"));
    }

    #[test]
    fn introspection_disabled_explains_the_ic_flag() {
        let text = AppError::IntrospectionDisabled.explanation();
        assert!(text.contains("introspection"));
        assert!(text.contains("ic = false"));
    }

    #[test]
    fn not_controller_names_the_identity_used() {
        let text = AppError::NotController {
            identity: "demo-local".into(),
        }
        .explanation();
        assert!(text.contains("demo-local"));
        assert!(text.contains("controller"));
    }

    #[test]
    fn replica_unreachable_names_the_url_tried() {
        let text = AppError::ReplicaUnreachable {
            url: "http://127.0.0.1:8000".into(),
        }
        .explanation();
        assert!(text.contains("http://127.0.0.1:8000"));
    }

    /// icydb's diagnostic code 5 (`QueryUnorderedPagination`) surfaces here
    /// as `AppError::IcyDb { message: "E5", .. }` — `icydb::Error`'s
    /// `Display` is exactly `"E{code}"`. Confirmed live against a real
    /// canister (Task 10's report): `SELECT * FROM demo_row LIMIT 10`
    /// rejects with precisely this code/message pair.
    /// icydb's diagnostic 96 (`SQL_FEATURE_ORDER_BY_FIELD_NOT_ORDERABLE`)
    /// surfaces as `AppError::IcyDb { message: "E96", .. }`. Confirmed live
    /// against toko's `PlatformClaimConfigState` on a local replica: the
    /// entity declares primary key `id`, this explorer therefore builds
    /// `SELECT * FROM PlatformClaimConfigState ORDER BY id LIMIT 100`, and the
    /// canister rejects it with `code = 96, class = 7, origin = 7`.
    ///
    /// Before this case existed, that fell through to the generic arm and the
    /// user saw only `icydb reported error ...: E96` — a bare code, for a
    /// situation they did not cause and could not act on without knowing that
    /// icydb ties LIMIT to ORDER BY.
    #[test]
    fn order_by_not_orderable_explains_why_paging_cannot_work() {
        let text = AppError::IcyDb {
            code: "Error { code: 96, class: 7, origin: 7 }".into(),
            message: "E96".into(),
        }
        .explanation();

        assert!(text.contains("ORDER BY"), "expected the clause named, got: {text}");
        assert!(
            text.contains("SQL console"),
            "expected the remedy, got: {text}"
        );
        // Must not be the generic fallback, which is what shipped before.
        assert!(
            !text.contains("icydb reported error"),
            "fell through to the generic arm: {text}"
        );
    }

    /// The two ORDER BY failures are distinct and must not share an
    /// explanation: E5 means the statement omitted ORDER BY and the user can
    /// add one, while E96 means the column paging chose cannot be ordered at
    /// all and no automatic ORDER BY will ever work for this table.
    #[test]
    fn the_two_order_by_failures_explain_different_things() {
        let missing = AppError::IcyDb {
            code: "Error { code: 5, class: 1, origin: 7 }".into(),
            message: "E5".into(),
        }
        .explanation();
        let not_orderable = AppError::IcyDb {
            code: "Error { code: 96, class: 7, origin: 7 }".into(),
            message: "E96".into(),
        }
        .explanation();

        assert_ne!(missing, not_orderable);
    }

    #[test]
    fn unordered_pagination_explains_the_missing_order_by() {
        let text = AppError::IcyDb {
            code: "Error { code: 5, class: 1, origin: 7 }".into(),
            message: "E5".into(),
        }
        .explanation();
        assert!(
            text.contains("ORDER BY"),
            "expected an ORDER BY explanation, got: {text}"
        );
        assert!(
            text.contains("LIMIT"),
            "expected the explanation to mention LIMIT, got: {text}"
        );
    }

    /// Any other icydb error code keeps the generic, verbatim fallback —
    /// the purpose-written explanation above is specific to code 5 and
    /// must not swallow unrelated `IcyDb` errors.
    #[test]
    fn other_icydb_errors_use_the_generic_fallback() {
        let text = AppError::IcyDb {
            code: "Error { code: 179, class: 7, origin: 5 }".into(),
            message: "E179".into(),
        }
        .explanation();
        assert!(text.contains("E179"));
        assert!(text.contains("Error { code: 179, class: 7, origin: 5 }"));
    }

    #[test]
    fn row_paging_requires_introspection_names_the_entity_and_the_sql_console() {
        let text = AppError::RowPagingRequiresIntrospection {
            entity: "demo_row".into(),
        }
        .explanation();
        assert!(text.contains("demo_row"));
        assert!(text.contains("introspection"));
        assert!(text.contains("ORDER BY"));
        assert!(text.contains("SQL console"));
    }

    #[test]
    fn no_orderable_columns_names_the_entity_and_the_sql_console() {
        let text = AppError::NoOrderableColumns {
            entity: "demo_row".into(),
        }
        .explanation();
        assert!(text.contains("demo_row"));
        assert!(text.contains("ORDER BY"));
        assert!(text.contains("SQL console"));
    }

    #[test]
    fn serializes_with_kind_and_explanation() {
        let json = serde_json::to_value(AppError::IntrospectionDisabled).unwrap();
        assert_eq!(json["kind"], "introspectionDisabled");
        assert!(json["explanation"]
            .as_str()
            .unwrap()
            .contains("introspection"));
    }

    /// `Display` must delegate to `explanation()` so the two cannot drift
    /// apart — checked across every variant, not just one, since the whole
    /// point is that this holds everywhere.
    #[test]
    fn display_matches_explanation_for_every_variant() {
        let errors = vec![
            AppError::Io("disk full".to_string()),
            AppError::Parse("bad json".to_string()),
            AppError::Agent("transport failed".to_string()),
            AppError::NoSqlSurface {
                canister: "user_hub".into(),
            },
            AppError::IntrospectionDisabled,
            AppError::NotController {
                identity: "demo-local".into(),
            },
            AppError::ReplicaUnreachable {
                url: "http://127.0.0.1:4943".into(),
            },
            AppError::IcyDb {
                code: "Error { code: 5 }".into(),
                message: "E5".into(),
            },
            AppError::Rejected("INSERT is not available".into()),
            AppError::RowPagingRequiresIntrospection {
                entity: "demo_row".into(),
            },
            AppError::NoOrderableColumns {
                entity: "demo_row".into(),
            },
            AppError::NoProjectSelected,
        ];
        for error in errors {
            assert_eq!(error.to_string(), error.explanation());
        }
    }
}
