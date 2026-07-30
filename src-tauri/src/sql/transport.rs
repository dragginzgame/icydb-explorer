//! Calls a canister's `icydb_query` endpoint and decodes the response.
//!
//! This is the one place the app actually talks to a canister over the
//! network. Everything here is a query call — the app is read-only and
//! must never issue an update call.

use candid::{CandidType, Decode, Encode, Principal};
use ic_agent::agent::AgentError;
use ic_agent::Agent;
use icydb::db::sql::SqlQueryResult;
use serde::Deserialize;

use crate::error::AppError;

/// Local mirror of the per-canister `IcydbSqlQueryPerfResult` the actor macro
/// emits for read-only SQL surfaces. Candid skips unmatched record fields on
/// decode, so the eight instruction counters are deliberately omitted — the
/// explorer does not surface them. `icydb-cli` declares all nine in its own
/// mirror; if decoding ever fails here, adding them back is the fallback.
#[derive(CandidType, Deserialize)]
struct SqlQueryEnvelope {
    result: SqlQueryResult,
}

/// Runs `sql` against `canister`'s `icydb_query` endpoint and returns the
/// decoded result.
///
/// Always a query call, never an update: the app is read-only, and
/// `icydb_query` is itself declared as a query method on a canister built
/// with `readonly = true`.
pub async fn run_query(
    agent: &Agent,
    canister: Principal,
    sql: &str,
) -> Result<SqlQueryResult, AppError> {
    // `run_query`'s signature (fixed by callers in Tasks 9/10) carries no
    // identity name — only `&Agent`, which has no notion of the config-level
    // identity name (e.g. "demo-local") that `AppError::NotController` names.
    // That name is passed as "" here; it does not affect `NoSqlSurface`
    // detection, the diagnostic this classifier exists primarily to produce.
    let bytes = agent
        .query(&canister, "icydb_query")
        .with_arg(Encode!(&sql.to_string()).map_err(|e| AppError::Parse(e.to_string()))?)
        .call()
        .await
        .map_err(|e| map_agent_error(&e, &canister.to_text(), ""))?;

    Decode!(bytes.as_slice(), Result<SqlQueryEnvelope, icydb::Error>)
        .map_err(|e| AppError::Parse(e.to_string()))?
        .map(|envelope| envelope.result)
        .map_err(|e| AppError::IcyDb { code: format!("{e:?}"), message: e.to_string() })
}

/// Extracts the reject message from a failed call and classifies it via
/// `map_reject_message`.
///
/// Query calls are not certified by default, so a rejected `icydb_query`
/// normally arrives as `AgentError::UncertifiedReject`, not
/// `CertifiedReject`. Both arms must be matched — missing either means the
/// most valuable diagnostic in this app (`NoSqlSurface`) silently never
/// fires for the call shape most users actually hit.
fn map_agent_error(error: &AgentError, canister: &str, identity: &str) -> AppError {
    match error {
        AgentError::CertifiedReject { reject, .. }
        | AgentError::UncertifiedReject { reject, .. } => {
            map_reject_message(&reject.reject_message, canister, identity)
        }
        other => AppError::Agent(other.to_string()),
    }
}

/// Classifies a reject message string into the `AppError` variant that
/// gives the operator the clearest next step.
///
/// The `has no query method 'icydb_query'` marker is the same string
/// `icydb-cli` matches on for this condition, so the two tools agree about
/// what a stale-wasm canister (SQL feature never enabled) looks like.
pub fn map_reject_message(message: &str, canister: &str, identity: &str) -> AppError {
    if message.contains("has no query method 'icydb_query'") {
        return AppError::NoSqlSurface { canister: canister.to_string() };
    }
    if message.contains("SqlIntrospectionDisabled") {
        return AppError::IntrospectionDisabled;
    }
    if message.contains("Unauthorized") || message.contains("not a controller") {
        return AppError::NotController { identity: identity.to_string() };
    }
    AppError::Agent(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_method_maps_to_no_sql_surface() {
        let error = map_reject_message(
            "IC0302: Canister has no query method 'icydb_query'",
            "user_hub",
            "demo-local",
        );
        assert!(matches!(error, AppError::NoSqlSurface { .. }));
        assert!(error.explanation().contains("user_hub"));
    }

    #[test]
    fn unauthorized_maps_to_not_controller_naming_the_identity() {
        let error = map_reject_message("Unauthorized: caller is not a controller", "user_hub", "demo-local");
        assert!(matches!(error, AppError::NotController { .. }));
        assert!(error.explanation().contains("demo-local"));
    }

    #[test]
    fn introspection_disabled_is_recognised() {
        let error = map_reject_message("SqlIntrospectionDisabled", "user_hub", "demo-local");
        assert!(matches!(error, AppError::IntrospectionDisabled));
    }

    #[test]
    fn unrecognised_rejections_pass_through_verbatim() {
        let error = map_reject_message("some novel failure", "user_hub", "demo-local");
        assert!(error.explanation().contains("some novel failure"));
    }
}
