use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use thiserror::Error;

/// The single error type returned by every backend module.
///
/// This is a developer tool whose most common failure modes are
/// configuration problems, not bugs — so `explanation()` is written to
/// tell an operator what to check or change, not just to restate what
/// went wrong.
#[derive(Debug, Error)]
pub enum AppError {
    /// A local I/O failure (reading config, dfx state, etc).
    #[error("io error: {0}")]
    Io(String),

    /// A parse failure (candid, JSON, TOML, etc).
    #[error("parse error: {0}")]
    Parse(String),

    /// An ic-agent transport/call failure not covered by a more specific
    /// variant below.
    #[error("agent error: {0}")]
    Agent(String),

    /// The target canister has no `icydb_query` method: the SQL surface
    /// was never enabled.
    #[error("canister {canister} has no SQL surface")]
    NoSqlSurface { canister: String },

    /// The canister exposes SQL but was built with introspection disabled,
    /// so SHOW/DESCRIBE/EXPLAIN are unavailable.
    #[error("introspection is disabled on this canister")]
    IntrospectionDisabled,

    /// The identity used is not a controller of the canister, and icydb's
    /// SQL endpoints are controller-gated.
    #[error("identity {identity} is not a controller of this canister")]
    NotController { identity: String },

    /// The configured replica could not be reached.
    #[error("could not reach replica at {url}")]
    ReplicaUnreachable { url: String },

    /// An error returned by icydb itself, surfaced verbatim.
    #[error("icydb error {code}: {message}")]
    IcyDb { code: String, message: String },

    /// A statement was rejected by the explorer's read-only statement
    /// classifier.
    #[error("statement rejected: {0}")]
    Rejected(String),
}

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
                format!("icydb reported error {code}: {message}")
            }
            AppError::Rejected(reason) => format!(
                "This explorer is read-only and does not support this statement: {reason}"
            ),
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
        }
    }
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
        let error = AppError::NoSqlSurface { canister: "user_hub".into() };
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
        let text = AppError::NotController { identity: "demo-local".into() }.explanation();
        assert!(text.contains("demo-local"));
        assert!(text.contains("controller"));
    }

    #[test]
    fn replica_unreachable_names_the_url_tried() {
        let text = AppError::ReplicaUnreachable { url: "http://127.0.0.1:8000".into() }.explanation();
        assert!(text.contains("http://127.0.0.1:8000"));
    }

    #[test]
    fn serializes_with_kind_and_explanation() {
        let json = serde_json::to_value(AppError::IntrospectionDisabled).unwrap();
        assert_eq!(json["kind"], "introspectionDisabled");
        assert!(json["explanation"].as_str().unwrap().contains("introspection"));
    }
}
