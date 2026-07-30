//! Discovery of `.icp/` project layout: environments, canister ids, and
//! identities, read directly off the filesystem.

mod icp_dir;
mod types;

pub use icp_dir::{
    discover, read_all_identities, read_default_identity_name, recorded_principal,
    user_level_identity_store,
};
pub use types::{CanisterArtifact, Environment, IdentityRef, NamedCanister, Project};
