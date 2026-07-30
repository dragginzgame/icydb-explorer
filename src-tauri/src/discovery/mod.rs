//! Discovery of `.icp/` project layout: environments, canister ids, and
//! identities, read directly off the filesystem.

mod icp_dir;
mod types;

pub use icp_dir::discover;
pub use types::{CanisterArtifact, Environment, IdentityRef, Project};
