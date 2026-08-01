//! What a canister's icydb SQL surface actually offers.
//!
//! icydb emits each SQL endpoint only when its build option asked for it, so
//! two canisters running the same icydb can expose entirely different surfaces.
//! This app has always discovered that the hard way — issue a statement, read
//! the rejection — which is fine for a query but not for a write: an editing
//! affordance has to be absent *before* the user reaches for it, not error
//! after they have committed to an edit.
//!
//! So capability is read from the canister's own `candid:service` metadata,
//! which lists the methods it exports. That is a certified read-state call, not
//! a statement, so probing costs nothing and cannot mutate anything.

use candid::Principal;
use ic_agent::Agent;

use crate::error::AppError;

/// Which icydb SQL endpoints a canister exports.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlCapabilities {
    /// `icydb_query` — reading. Everything this app did before writes existed.
    pub query: bool,
    /// `icydb_update` — writing. Absent unless the canister was built with an
    /// update policy, which is not the default and never inferred.
    pub update: bool,
}

/// Reads `candid:service` and reports which icydb endpoints it declares.
///
/// A canister with no `candid:service` metadata reports no capabilities rather
/// than failing: an older or hand-rolled canister that cannot describe itself
/// is one this app should treat as read-only, not one it should refuse to open.
pub async fn probe(agent: &Agent, canister: Principal) -> Result<SqlCapabilities, AppError> {
    let bytes = match agent
        .read_state_canister_metadata(canister, "candid:service")
        .await
    {
        Ok(bytes) => bytes,
        Err(_) => return Ok(SqlCapabilities::default()),
    };

    Ok(parse_capabilities(&String::from_utf8_lossy(&bytes)))
}

/// Finds the icydb endpoints in a canister's Candid interface.
///
/// Matches on the declaration shape (`name :`) rather than a bare substring,
/// so a method whose *name merely contains* one of these — or a comment
/// mentioning it — cannot be mistaken for the endpoint itself. Getting this
/// wrong in the permissive direction would offer an edit control for a canister
/// that will reject the write, which is the failure this whole module exists to
/// prevent.
fn parse_capabilities(service: &str) -> SqlCapabilities {
    SqlCapabilities {
        query: declares(service, "icydb_query"),
        update: declares(service, "icydb_update"),
    }
}

fn declares(service: &str, method: &str) -> bool {
    service.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed
            .strip_prefix(method)
            .is_some_and(|rest| rest.trim_start().starts_with(':'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Taken verbatim from toko's `user_hub` on a live replica.
    const READ_ONLY_SERVICE: &str = r#"service : (CanisterInitPayload, opt blob) -> {
  authenticate : (principal) -> (Result);
  canic_health : () -> (Result_5) query;
  icydb_metrics : (opt nat64) -> (Result_15) query;
  icydb_query : (text) -> (Result_17) query;
}"#;

    #[test]
    fn a_read_only_canister_offers_query_and_not_update() {
        let caps = parse_capabilities(READ_ONLY_SERVICE);
        assert!(caps.query);
        assert!(!caps.update, "toko exposes no update endpoint");
    }

    #[test]
    fn a_writable_canister_offers_both() {
        let service = format!("{READ_ONLY_SERVICE}\n  icydb_update : (text) -> (Result_17);");
        let caps = parse_capabilities(&service);
        assert!(caps.query);
        assert!(caps.update);
    }

    /// The permissive direction is the dangerous one: claiming update support a
    /// canister does not have would put an edit control in front of the user
    /// that can only ever fail. A method whose name merely *contains*
    /// `icydb_update` is not that endpoint.
    #[test]
    fn a_similarly_named_method_is_not_mistaken_for_the_endpoint() {
        for impostor in [
            "  icydb_update_policy_status : () -> (text) query;",
            "  not_icydb_update : (text) -> (Result);",
            "  // icydb_update is deliberately not exposed here",
        ] {
            let service = format!("{READ_ONLY_SERVICE}\n{impostor}");
            assert!(
                !parse_capabilities(&service).update,
                "treated {impostor} as an update endpoint"
            );
        }
    }

    /// A canister that cannot describe itself is read-only as far as this app
    /// is concerned — never writable by default.
    #[test]
    fn an_undescribable_canister_reports_nothing() {
        let caps = parse_capabilities("");
        assert!(!caps.query);
        assert!(!caps.update);
        assert_eq!(caps, SqlCapabilities::default());
    }

    #[test]
    fn whitespace_before_the_colon_is_still_a_declaration() {
        let service = "service : {\n  icydb_update   : (text) -> (Result);\n}";
        assert!(parse_capabilities(service).update);
    }
}
