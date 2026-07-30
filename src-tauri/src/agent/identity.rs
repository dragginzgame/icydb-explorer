//! Loads an `ic_agent::Identity` for an `IdentityRef`, dispatching on kind
//! to obtain PEM bytes and then on algorithm to choose a loader.

use ic_agent::identity::{BasicIdentity, Prime256v1Identity, Secp256k1Identity};
use ic_agent::Identity;

use crate::agent::export::export_pem;
use crate::discovery::IdentityRef;
use crate::error::AppError;

/// Loads an `ic_agent::Identity` for `identity`.
///
/// Dispatches on kind to obtain PEM bytes — read from disk for a `pem`
/// identity, exported via the icp CLI for a `keyring` one — then on algorithm
/// to choose a loader. Unusable kinds are refused before any subprocess runs.
pub async fn load_identity(identity: &IdentityRef) -> Result<Box<dyn Identity>, AppError> {
    if let Some(reason) = identity.unusable_reason.as_ref() {
        return Err(AppError::Agent(format!(
            "identity \"{}\" cannot be used: {reason}",
            identity.name
        )));
    }

    let pem = match identity.kind.as_str() {
        "pem" => {
            let path = identity.pem_path.as_ref().ok_or_else(|| {
                AppError::Agent(format!(
                    "identity \"{}\" is a pem identity with no key file recorded",
                    identity.name
                ))
            })?;
            std::fs::read(path).map_err(|e| {
                AppError::Agent(format!(
                    "could not read the pem for identity \"{}\": {e}",
                    identity.name
                ))
            })?
        }
        "keyring" => export_pem(&identity.name).await?,
        other => {
            return Err(AppError::Agent(format!(
                "identity \"{}\" has kind \"{other}\", which this app cannot load",
                identity.name
            )))
        }
    };

    identity_from_pem(&pem, &identity.algorithm, &identity.name)
}

/// Chooses a loader by algorithm and parses `pem`.
///
/// `prime256v1` is included because `icp identity import --assert-key-type`
/// accepts it alongside `secp256k1` and `ed25519`.
fn identity_from_pem(
    pem: &[u8],
    algorithm: &str,
    name: &str,
) -> Result<Box<dyn Identity>, AppError> {
    match algorithm {
        "secp256k1" => Secp256k1Identity::from_pem(pem)
            .map(|id| Box::new(id) as Box<dyn Identity>)
            .map_err(|e| AppError::Agent(format!("failed to load secp256k1 pem for \"{name}\": {e}"))),
        "prime256v1" => Prime256v1Identity::from_pem(pem)
            .map(|id| Box::new(id) as Box<dyn Identity>)
            .map_err(|e| AppError::Agent(format!("failed to load prime256v1 pem for \"{name}\": {e}"))),
        "ed25519" => BasicIdentity::from_pem(pem)
            .map(|id| Box::new(id) as Box<dyn Identity>)
            .map_err(|e| AppError::Agent(format!("failed to load ed25519 pem for \"{name}\": {e}"))),
        other => Err(AppError::Agent(format!(
            "unsupported identity algorithm \"{other}\" for \"{name}\": expected \
             \"secp256k1\", \"prime256v1\", or \"ed25519\""
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn pem_identity(algorithm: &str, file: &str) -> IdentityRef {
        IdentityRef::new(
            "demo-local".into(),
            algorithm.into(),
            "pem".into(),
            Some(PathBuf::from("tests/fixtures").join(file)),
        )
    }

    #[tokio::test]
    async fn loads_a_secp256k1_pem_from_disk() {
        let identity = load_identity(&pem_identity("secp256k1", "secp256k1.pem"))
            .await
            .expect("secp256k1 pem should load");
        assert!(identity.sender().is_ok());
    }

    #[tokio::test]
    async fn unknown_algorithm_is_an_error_naming_it() {
        let error = load_identity(&pem_identity("rsa9000", "secp256k1.pem"))
            .await
            .err()
            .expect("should fail");
        assert!(error.explanation().contains("rsa9000"));
    }

    #[tokio::test]
    async fn a_pem_kind_with_no_path_is_an_error_not_a_panic() {
        let identity =
            IdentityRef::new("broken".into(), "secp256k1".into(), "pem".into(), None);
        let error = load_identity(&identity).await.err().expect("should fail");
        assert!(error.explanation().contains("broken"));
    }

    #[tokio::test]
    async fn anonymous_is_refused_before_any_subprocess_runs() {
        let identity =
            IdentityRef::new("anonymous".into(), "secp256k1".into(), "anonymous".into(), None);
        let error = load_identity(&identity).await.err().expect("should fail");
        assert!(error.explanation().contains("controller-gated"));
    }

    #[tokio::test]
    async fn an_unrecognised_kind_is_refused_naming_the_kind() {
        let identity =
            IdentityRef::new("future".into(), "secp256k1".into(), "delegation".into(), None);
        let error = load_identity(&identity).await.err().expect("should fail");
        assert!(error.explanation().contains("delegation"));
    }
}
