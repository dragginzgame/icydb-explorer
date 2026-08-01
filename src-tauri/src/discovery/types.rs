use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;

/// The discovered project, held inside `project::ProjectState` and returned
/// as `Option<Project>` by `commands::list_environments`.
///
/// `error` carries a `discover()` failure (e.g. no `.icp/` directory at
/// all) rather than swallowing it: `lib.rs`'s `discover_project()` used to
/// fall back to an empty `Project` on any failure with no way for the
/// frontend to learn *why* there were no environments, which made a broken
/// discovery layer look identical to "not deployed yet". `error` is `None`
/// on a successful `discover()`, `Some` (with `environments` empty) on a
/// failed one, and always `None` on a `Project` built from a merely
/// undeployed-but-otherwise-valid `.icp/` layout (that's zero environments
/// with no error — genuinely nothing to browse yet, not a failure).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub root: PathBuf,
    pub environments: Vec<Environment>,
    pub error: Option<AppError>,
}

/// One environment (network) this project's `.icp/` layout declares.
///
/// `canisters` is a **forest**, not a single root: `.icp/cache/mappings/
/// <network>.ids.json` is a name→id map with no guaranteed `root` entry (a
/// canic fleet like toko has only `root`; a plain project like this repo's
/// fixture has its canisters directly, with no root at all). Every entry is
/// a tree root in its own right — see `topology::build_tree`, which walks
/// each one for canic children if it has them.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub name: String,
    pub replica_url: String,
    pub canisters: Vec<NamedCanister>,
    pub identity: Option<IdentityRef>,
    /// Every identity the resolved store declares, usable or not. The UI lists
    /// all of them so an unsupported identity reads as unsupported rather than
    /// missing.
    pub identities: Vec<IdentityRef>,
    pub artifacts: Vec<CanisterArtifact>,
}

/// One entry from `.icp/cache/mappings/<network>.ids.json`: a name the
/// project (or canic) gave a canister, and the id it resolved to.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedCanister {
    pub name: String,
    pub id: String,
}

/// One identity from an icp identity store.
///
/// `pem_path` is `None` for kinds whose key is not a file — a `keyring`
/// identity's key lives in the OS keychain, which is why the previous
/// non-optional `PathBuf` made keyring identities unrepresentable.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRef {
    pub name: String,
    pub algorithm: String,
    pub kind: String,
    pub pem_path: Option<PathBuf>,
    /// Why this app cannot use this identity, or `None` if it can.
    ///
    /// A serialised field rather than a method, computed once in
    /// [`IdentityRef::new`], so the frontend renders this text instead of
    /// re-implementing the rule in TypeScript. The rule lives in exactly one
    /// place in the codebase.
    pub unusable_reason: Option<String>,
    /// The principal the identity store records for this identity, when it
    /// records one.
    ///
    /// Read rather than derived: deriving it would mean loading the key, which
    /// for a keyring identity prompts the OS. The store already knows, and this
    /// is only used to compare against a canister's controller list — a
    /// comparison, never a credential.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_principal: Option<String>,
}

impl IdentityRef {
    /// Records the principal the identity store lists for this identity.
    #[must_use]
    pub fn with_recorded_principal(mut self, principal: Option<String>) -> Self {
        self.recorded_principal = principal;
        self
    }

    /// Builds an `IdentityRef`, deriving `unusable_reason` from the kind.
    ///
    /// icp's storage kinds are `plaintext`, `keyring`, and `password`
    /// (`icp identity new --storage`). `plaintext` surfaces here as kind
    /// `pem`. `password` has not been observed in a real store, so any
    /// unrecognised kind is reported as unusable by name rather than
    /// assumed loadable — a wrong guess would fail confusingly at query
    /// time instead of clearly at selection time.
    #[must_use]
    pub fn new(name: String, algorithm: String, kind: String, pem_path: Option<PathBuf>) -> Self {
        let unusable_reason = match kind.as_str() {
            "pem" if pem_path.is_none() => {
                Some("pem identity with no key file recorded".to_string())
            }
            "pem" | "keyring" => None,
            "anonymous" => Some(
                "the anonymous identity cannot be used: icydb's SQL endpoints are \
                 controller-gated"
                    .to_string(),
            ),
            other => Some(format!(
                "identity kind \"{other}\" is not supported by this app: it cannot be \
                 exported as a PEM"
            )),
        };

        Self {
            name,
            algorithm,
            kind,
            pem_path,
            unusable_reason,
            recorded_principal: None,
        }
    }

    /// Whether this app can obtain a signing key for this identity.
    #[must_use]
    pub fn is_usable(&self) -> bool {
        self.unusable_reason.is_none()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanisterArtifact {
    pub role: String,
    pub did_path: PathBuf,
}
