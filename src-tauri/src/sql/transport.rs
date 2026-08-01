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
/// Always a query call, never an update: this function calls `agent.query`,
/// never an update call, on `icydb_query` — a query method whose own
/// dispatcher rejects any mutation statement regardless of how the target
/// canister is configured. That's the property that actually makes this
/// read-only. The target canister's own `readonly`/`ddl`/`update`/`fixtures`
/// configuration (`icydb.toml`) is defence in depth for *other* callers of
/// the same canister, not the boundary this app relies on — see README.md's
/// "Read-only, and where that guarantee actually lives" for the full
/// correction; an earlier version of this comment conflated the two.
///
/// `identity` is the human-readable identity name from `IdentityRef.name`
/// (e.g. `"demo-local"`) — the string the user configured and would edit.
/// It exists solely so a `NotController` rejection can name it: ic-agent
/// exposes only `sender() -> Principal`, not the configured name, so
/// `agent` alone cannot supply it. Callers resolve an `IdentityRef` from the
/// frontend-supplied name and pass `identity_ref.name.as_str()` (see
/// `commands.rs::query_dto`).
pub async fn run_query(
    agent: &Agent,
    canister: Principal,
    sql: &str,
    identity: &str,
) -> Result<SqlQueryResult, AppError> {
    let bytes = agent
        .query(&canister, "icydb_query")
        .with_arg(Encode!(&sql.to_string()).map_err(|e| AppError::Parse(e.to_string()))?)
        .call()
        .await
        .map_err(|e| {
            map_agent_error(
                &e,
                &canister.to_text(),
                &identity_descriptor(agent, identity),
            )
        })?;

    Decode!(bytes.as_slice(), Result<SqlQueryEnvelope, icydb::Error>)
        .map_err(|e| AppError::Parse(e.to_string()))?
        .map(|envelope| envelope.result)
        .map_err(|e| map_icydb_error(e, &identity_descriptor(agent, identity)))
}

/// Classifies a decoded `icydb::Error` (the `Err` arm of the
/// `Result<SqlQueryEnvelope, icydb::Error>` this canister's `icydb_query`
/// returns) into an `AppError`.
///
/// **Verified live against a real introspection-disabled canister** (a
/// second fixture instance built with `ICYDB_BUILD_TARGET=ic`, so
/// `introspection.ic = false` applies — see
/// `tests/integration.rs::explicit_order_by_and_limit_still_works_when_introspection_is_disabled`):
/// this is genuinely how `SqlIntrospectionDisabled` reaches this app, and
/// `map_reject_message`'s `"SqlIntrospectionDisabled"` string match (below)
/// does **not** fire for it. `icydb_query` returns a well-formed, successful
/// reply whose Candid-decoded body is `Err(icydb::Error { code: 179, .. })`
/// — a query-level rejection carried in the *value*, not an agent-level
/// reject/trap — so it never reaches `map_agent_error`/`map_reject_message`
/// at all; it decodes cleanly and lands here. `icydb::Error`'s `Display` is
/// exactly `"E{code}"` (the same fact `error.rs`'s `is_unordered_pagination`
/// relies on for code 5), and 179 is
/// `RUNTIME_BOUNDARY_SQL_INTROSPECTION_DISABLED`'s one and only code
/// (`icydb-diagnostic-code-0.215.7/src/registry.rs`), so matching the full
/// string `"E179"` is exact, not a substring guess.
fn map_icydb_error(error: icydb::Error, identity: &str) -> AppError {
    if error.to_string() == "E179" {
        return AppError::IntrospectionDisabled;
    }
    // Same shape as E179, and for the same reason: the generated glue's
    // controller check returns `Err(icydb::Error)` as a *value*, so a rejected
    // caller produces a well-formed reply that decodes here rather than an
    // agent-level reject. `map_reject_message`'s `"Unauthorized"`/`"not a
    // controller"` match below therefore never fires for it, and before this
    // arm existed `AppError::NotController` — and the explanation naming the
    // identity — was unreachable for this icydb version; the user saw a bare
    // `icydb reported error ...: E25` instead.
    //
    // 25 is `RUNTIME_BOUNDARY_SQL_SURFACE_CONTROLLER_REQUIRED`'s one and only
    // code (`icydb-diagnostic-code-0.215.7/src/registry.rs:189`), so matching
    // the full string is exact rather than a substring guess.
    if error.to_string() == "E25" {
        return AppError::NotController {
            identity: identity.to_string(),
        };
    }
    AppError::IcyDb {
        code: format!("{error:?}"),
        message: error.to_string(),
    }
}

/// Builds the string shown as `AppError::NotController`'s identity: the
/// configured name plus, when available, the principal it resolves to.
///
/// The name is what the user recognizes and would edit in their `.icp/`
/// config; the principal is what `dfx canister info <canister>` actually
/// lists as a controller. A user acting on a `NotController` error needs
/// both — the name to know which of possibly several configured
/// identities is at fault, the principal to check it directly against the
/// canister's controller list without a separate `dfx identity
/// get-principal` lookup. `agent.get_principal()` just reads the identity
/// already loaded into `agent` (the same one used for the call that
/// failed) — no network round trip, so this is safe to call on every
/// error path. If it errors, the name alone is still useful and is
/// returned unchanged.
fn identity_descriptor(agent: &Agent, identity: &str) -> String {
    match agent.get_principal() {
        Ok(principal) => format!("{identity} (principal {principal})"),
        Err(_) => identity.to_string(),
    }
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
///
/// The `"SqlIntrospectionDisabled"` branch below is defensive, not the
/// live path: verified against a real introspection-disabled canister (see
/// `map_icydb_error`'s doc comment), `SqlIntrospectionDisabled` actually
/// arrives as a decoded `icydb::Error` value inside a *successful* reply,
/// never as an agent-level reject/trap message, so this branch does not
/// fire in current icydb behavior. It's kept in case a future icydb
/// release ever does surface it as a genuine reject (or some other
/// canister-side trap happens to embed this string), since it costs
/// nothing and only makes the classification more forgiving, never less
/// correct.
pub fn map_reject_message(message: &str, canister: &str, identity: &str) -> AppError {
    if message.contains("has no query method 'icydb_query'") {
        return AppError::NoSqlSurface {
            canister: canister.to_string(),
        };
    }
    if message.contains("SqlIntrospectionDisabled") {
        return AppError::IntrospectionDisabled;
    }
    if message.contains("Unauthorized") || message.contains("not a controller") {
        return AppError::NotController {
            identity: identity.to_string(),
        };
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
        let error = map_reject_message(
            "Unauthorized: caller is not a controller",
            "user_hub",
            "demo-local",
        );
        assert!(matches!(error, AppError::NotController { .. }));
        assert!(error.explanation().contains("demo-local"));
    }

    #[test]
    fn introspection_disabled_is_recognised() {
        let error = map_reject_message("SqlIntrospectionDisabled", "user_hub", "demo-local");
        assert!(matches!(error, AppError::IntrospectionDisabled));
    }

    /// `icydb::Error`'s fields are private with no public constructor for
    /// an arbitrary code, but it derives `serde::Deserialize`, so this
    /// builds one the same way any other cross-boundary payload is
    /// decoded — code 179 is `RUNTIME_BOUNDARY_SQL_INTROSPECTION_DISABLED`
    /// (`icydb-diagnostic-code-0.215.7/src/registry.rs`), and its `Display`
    /// is exactly `"E{code}"` (`icydb-0.215.5/src/error.rs`).
    fn icydb_error(code: u16) -> icydb::Error {
        serde_json::from_value(serde_json::json!({ "code": code, "class": 7, "origin": 5 }))
            .expect("icydb::Error should deserialize for testing")
    }

    /// This is the actual live path `SqlIntrospectionDisabled` reaches this
    /// app through — verified against a real introspection-disabled
    /// canister (see `map_icydb_error`'s doc comment and
    /// `tests/integration.rs::explicit_order_by_and_limit_still_works_when_introspection_is_disabled`).
    /// `map_reject_message`'s string-based classification above does not
    /// fire for it in practice; this is the one that matters.
    #[test]
    fn code_179_from_a_decoded_icydb_error_maps_to_introspection_disabled() {
        let error = map_icydb_error(icydb_error(179), "test-identity");
        assert!(matches!(error, AppError::IntrospectionDisabled));
    }

    /// A rejected caller comes back as an `Err` *value* (code 25), not an
    /// agent-level reject, so `map_reject_message` never sees it. Before this
    /// was handled here, `AppError::NotController` was unreachable against
    /// icydb 0.215.x and the user got the bare-code fallback instead of the
    /// explanation naming their identity.
    #[test]
    fn controller_required_value_maps_to_not_controller() {
        let error = map_icydb_error(icydb_error(25), "toko-local");
        match error {
            AppError::NotController { identity } => assert_eq!(identity, "toko-local"),
            other => panic!("expected NotController, got {other:?}"),
        }
    }

    #[test]
    fn other_icydb_error_codes_keep_the_generic_icydb_variant() {
        let error = map_icydb_error(icydb_error(5), "test-identity");
        assert!(matches!(error, AppError::IcyDb { .. }));
    }

    #[test]
    fn unrecognised_rejections_pass_through_verbatim() {
        let error = map_reject_message("some novel failure", "user_hub", "demo-local");
        assert!(error.explanation().contains("some novel failure"));
    }

    /// `identity_descriptor` needs no live replica: `Agent::builder().build()`
    /// is local and synchronous (only `fetch_root_key` hits the network), so
    /// this test builds a real `Agent` from the same offline test pem Task
    /// 7's identity tests use and checks the descriptor carries both the
    /// configured name and the principal that pem actually resolves to.
    #[test]
    fn identity_descriptor_includes_the_resolved_principal() {
        use ic_agent::identity::Secp256k1Identity;
        use ic_agent::Identity;

        // Generated, not committed — see `crate::test_support`.
        let pem_path = crate::test_support::generated_secp256k1_pem("transport-descriptor");
        let identity = Secp256k1Identity::from_pem_file(&pem_path).expect("test pem should load");
        let principal = identity
            .sender()
            .expect("identity should resolve a principal");

        let agent = Agent::builder()
            .with_url("http://127.0.0.1:4943")
            .with_identity(identity)
            .build()
            .expect("agent should build offline, without a network call");

        let descriptor = identity_descriptor(&agent, "demo-local");
        assert!(descriptor.contains("demo-local"));
        assert!(descriptor.contains(&principal.to_string()));
    }
}
