//! Choosing an identity that the canisters will actually accept.
//!
//! icydb's SQL endpoints are controller-gated, so an identity that is not a
//! controller cannot read anything. Which identity a project *declares* as its
//! default and which principals it declares as *controllers* are separate
//! settings, and on a canic project they routinely disagree: the default is a
//! per-machine development identity while the controllers are the team's own
//! principals. Following the declared default blindly then produces an app that
//! opens onto an error for a reason the reader did not cause.
//!
//! Kept out of `discovery` deliberately. Discovery reads the filesystem and must
//! keep working with no replica running — it is what draws the project picker
//! before anything is reachable. Asking who controls a canister is a network
//! question, so it lives here and happens once the fleet is known.

use candid::Principal;
use ic_agent::Agent;

use crate::discovery::IdentityRef;
use crate::error::AppError;

/// The identity to prefer for `canister`, given what the project offers.
///
/// Returns the first offered identity whose principal is among the canister's
/// controllers, in the order given — so a caller that puts the declared default
/// first keeps it whenever it works, and only moves off it when it cannot.
///
/// `None` means none of them control this canister. That is a real answer worth
/// surfacing rather than a failure: it says the project's identities and its
/// deployment disagree, which no choice this app makes can fix.
pub async fn preferred_identity(
    agent: &Agent,
    canister: Principal,
    offered: &[IdentityRef],
) -> Result<Option<IdentityRef>, AppError> {
    let controllers = agent
        .read_state_canister_controllers(canister)
        .await
        .map_err(|e| AppError::Agent(format!("could not read controllers: {e}")))?;

    Ok(pick(&controllers, offered))
}

/// The pure half: given the controllers and what the project offers, which
/// identity to use.
///
/// Split out because the choice is the part worth testing, and testing it
/// through a live replica would test the network instead.
fn pick(
    controllers: &[Principal],
    offered: &[IdentityRef],
) -> Option<IdentityRef> {
    offered.iter().find_map(|identity| {
        // An identity this app cannot use is not a candidate however well it
        // matches — the anonymous identity is a controller of nothing, but this
        // guards the general case rather than that one.
        if identity.unusable_reason.is_some() {
            return None;
        }
        let principal = identity.recorded_principal.as_ref()?;
        let parsed = Principal::from_text(principal).ok()?;
        controllers
            .contains(&parsed)
            .then(|| identity.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(name: &str, principal: Option<&str>) -> IdentityRef {
        IdentityRef::new(
            name.to_string(),
            "secp256k1".into(),
            "pem".into(),
            Some(std::path::PathBuf::from("k.pem")),
        )
        .with_recorded_principal(principal.map(str::to_string))
    }

    fn unusable(name: &str, principal: Option<&str>) -> IdentityRef {
        IdentityRef {
            unusable_reason: Some("cannot be used".into()),
            ..identity(name, principal)
        }
    }

    const A: &str = "aaaaa-aa";
    const B: &str = "2vxsx-fae";

    fn principal(text: &str) -> Principal {
        Principal::from_text(text).expect("test principal")
    }

    /// The declared default is offered first, so a project whose default *is* a
    /// controller must keep it — this must never move an identity that works.
    #[test]
    fn a_working_default_is_left_alone() {
        let offered = vec![identity("toko-local", Some(A)), identity("default", Some(B))];

        let picked = pick(&[principal(A), principal(B)], &offered);
        assert_eq!(picked.map(|i| i.name), Some("toko-local".to_string()));
    }

    /// The case this exists for: the declared default is not a controller, and
    /// another offered identity is.
    #[test]
    fn a_default_that_cannot_query_gives_way_to_one_that_can() {
        let offered = vec![identity("toko-local", Some(A)), identity("default", Some(B))];

        let picked = pick(&[principal(B)], &offered);
        assert_eq!(picked.map(|i| i.name), Some("default".to_string()));
    }

    /// No choice fixes a project whose identities do not control its canisters.
    /// Saying so is more useful than silently picking one that cannot work.
    #[test]
    fn none_when_no_offered_identity_controls_the_canister() {
        let offered = vec![identity("toko-local", Some(A))];

        assert!(pick(&[principal(B)], &offered).is_none());
    }

    /// An identity this app cannot load is not a candidate even if its recorded
    /// principal happens to be a controller.
    #[test]
    fn an_unusable_identity_is_never_chosen() {
        let offered = vec![unusable("anonymous", Some(A))];

        assert!(pick(&[principal(A)], &offered).is_none());
    }

    /// A store that records no principal for an identity cannot be matched
    /// against a controller list. Skipping it is right; guessing is not.
    #[test]
    fn an_identity_with_no_recorded_principal_is_skipped() {
        let offered = vec![identity("keyring-only", None), identity("default", Some(A))];

        let picked = pick(&[principal(A)], &offered);
        assert_eq!(picked.map(|i| i.name), Some("default".to_string()));
    }

    /// A malformed principal in the store must not panic or match.
    #[test]
    fn a_malformed_recorded_principal_is_skipped() {
        let offered = vec![
            identity("broken", Some("not-a-principal")),
            identity("default", Some(A)),
        ];

        let picked = pick(&[principal(A)], &offered);
        assert_eq!(picked.map(|i| i.name), Some("default".to_string()));
    }
}
