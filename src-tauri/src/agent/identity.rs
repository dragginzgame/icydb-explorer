//! Loads an `ic_agent::Identity` from a pem file, dispatching on the
//! algorithm name recorded in an `IdentityRef`.

use ic_agent::identity::{BasicIdentity, Secp256k1Identity};
use ic_agent::Identity;

use crate::discovery::IdentityRef;
use crate::error::AppError;

/// Loads the identity named by `identity`, dispatching on its algorithm.
///
/// Supported algorithms are `"secp256k1"` (dfx's default) and `"ed25519"`.
/// Any other algorithm name, or a pem file that can't be read or parsed,
/// is reported as `AppError::Agent` naming the problem.
pub fn load_identity(identity: &IdentityRef) -> Result<Box<dyn Identity>, AppError> {
    match identity.algorithm.as_str() {
        "secp256k1" => Secp256k1Identity::from_pem_file(&identity.pem_path)
            .map(|id| Box::new(id) as Box<dyn Identity>)
            .map_err(|e| AppError::Agent(format!("failed to load secp256k1 pem: {e}"))),
        "ed25519" => BasicIdentity::from_pem_file(&identity.pem_path)
            .map(|id| Box::new(id) as Box<dyn Identity>)
            .map_err(|e| AppError::Agent(format!("failed to load ed25519 pem: {e}"))),
        other => Err(AppError::Agent(format!(
            "unsupported identity algorithm \"{other}\": expected \"secp256k1\" or \"ed25519\""
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn reference(algorithm: &str, file: &str) -> IdentityRef {
        IdentityRef {
            name: "demo-local".into(),
            algorithm: algorithm.into(),
            pem_path: PathBuf::from("tests/fixtures").join(file),
        }
    }

    #[test]
    fn loads_a_secp256k1_pem() {
        let identity = load_identity(&reference("secp256k1", "secp256k1.pem"))
            .expect("secp256k1 pem should load");
        assert!(identity.sender().is_ok());
    }

    #[test]
    fn unknown_algorithm_is_an_error() {
        // `Result::expect_err` requires the `Ok` type to implement `Debug`,
        // but `Box<dyn ic_agent::Identity>` does not (ic-agent has no
        // `Debug` impl for `dyn Identity`), so `.err().expect(..)` is used
        // in place of the brief's `.expect_err(..)` — same assertion, no
        // `Debug` bound required.
        let error = load_identity(&reference("rsa9000", "secp256k1.pem"))
            .err()
            .expect("should fail");
        assert!(error.explanation().contains("rsa9000"));
    }

    #[test]
    fn missing_pem_file_is_an_error() {
        assert!(load_identity(&reference("secp256k1", "absent.pem")).is_err());
    }
}
