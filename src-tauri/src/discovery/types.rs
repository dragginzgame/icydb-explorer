use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;

/// The discovered project, held in Tauri's managed state and returned
/// verbatim by `commands::list_environments`.
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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRef {
    pub name: String,
    pub algorithm: String,
    pub pem_path: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanisterArtifact {
    pub role: String,
    pub did_path: PathBuf,
}
